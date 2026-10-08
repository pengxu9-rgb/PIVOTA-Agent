// MERCHANT-DOOR PRICING for the UCP storefront escalation — the seller's own UCP door prices the cart.
//
// WHY. Pivota transacts a UCP-ready storefront through THAT storefront's door; it does not need the merchant to
// connect. The storefront escalation (ucpCheckoutEscalation.js) answers a checkout for such a seller with
// `requires_escalation` + a continue_url, but on its own it can only state the catalog's LAST OBSERVED price and
// link the product page. This module asks the seller instead: it builds a cart for exactly these items on the
// seller's own UCP MCP endpoint and hands back the seller's line prices, totals, currency and cart continue_url,
// so the agent shows the buyer what the seller will actually charge and sends them to a pre-filled cart.
//
// WHAT IT CALLS, AND WHAT IT NEVER DOES. `create_cart` (and `get_cart` on a re-read) through the existing
// buyer-agent client (src/services/ucpBuyerAgentClient.js) — the same client and the same endpoint discovery the
// warm-handoff lane uses. That client has no complete_checkout method and hard-refuses the tool. Nothing here
// creates a checkout, attaches a payment instrument, or opens the continue_url. NO BUYER DATA is sent: the cart
// carries the line items and, when the request named one, the buyer's market as a localisation hint
// (`context.address_country`) — never an email, name or address.
//
// FAILS BACK, NEVER FAILS THE CHECKOUT. Every outcome that is not a clean, fully-matched seller price — no door,
// a redirect, a timeout, a tool error, a variant the seller does not recognise, a line or quantity the seller
// changed, money that is not integer minor units, a continue_url off the seller's host — returns `null`, and the
// escalation answers exactly as it did before this module existed (catalog price, product page). The ONE outcome
// that does not fall back is the seller saying the item is out of stock: answering with a catalog price for an
// item the seller has just refused would be the lie this module exists to stop, so it is a terminal refusal.
//
// WHICH VARIANT. UCP has no variant selector on Pivota's door (an item id is a product id), so only a row whose
// variant is unambiguous is priced: a sole variant carrying the seller's own variant id, or a seller-host URL that
// names exactly one `variant=`. Anything else falls back. Guessing a variant would put the wrong shade in a cart.
//
// SELLER MESSAGES ARE DATA. The seller's `messages` are reduced to their codes (a fixed character set, capped);
// their free text is never forwarded to the agent.
//
// KILL-SWITCH. AGENT_CHECKOUT_UCP_MERCHANT_PRICING_ENABLED, default OFF, read per call. It only matters while the
// storefront escalation itself is on. Off, nothing here runs and no seller is contacted.

import { intakeRefusal } from "../../safety-kernel/src/protocol/buyerIntake.js";
import buyerAgentClientModule from "../../src/services/ucpBuyerAgentClient.js";
import warmHandoffModule from "../../src/services/ucpWarmHandoff.js";
import shopifyVariantResolver from "../../src/services/shopifyVariantResolver.js";

export const MERCHANT_PRICING_FLAG = "AGENT_CHECKOUT_UCP_MERCHANT_PRICING_ENABLED";
export const MERCHANT_PRICING_BUDGET_MS = 5000; // discovery (usually cached) + one cart call
const MERCHANT_CALL_TIMEOUT_MS = 3500;
const MAX_SELLER_MESSAGE_CODES = 5;
const MAX_CART_ID_LENGTH = 512;
const SELLER_OUT_OF_STOCK_RE = /out[\s_-]?of[\s_-]?stock|sold[\s_-]?out|insufficient inventory|not available for sale/i;

const { toVariantGid } = shopifyVariantResolver;
const { classifyUcpFailure, FAILURE_REASON } = buyerAgentClientModule;

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
function own(src, key) {
  if (!isPlainObject(src)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}

export function merchantPricingEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[MERCHANT_PRICING_FLAG]) || "").trim());
}

/** A merchant cart id this door will carry in its checkout id and hand back to that seller's `get_cart`. */
export function isCarriableCartId(v) {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_CART_ID_LENGTH && /^[\x21-\x7e]+$/.test(v);
}

// ---- which variant ---------------------------------------------------------------------------------------------

function bareHost(h) {
  return String(h || "").toLowerCase().replace(/^www\./, "");
}

function onSellerHost(url, sellerHost) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  const host = bareHost(parsed.hostname);
  const seller = bareHost(sellerHost);
  return host === seller || host.endsWith(`.${seller}`) ? parsed : null;
}

/**
 * The seller's own Shopify variant GID for a catalog row, or null when it is not unambiguous. Offline: reads only
 * what the product read already carries. `sellerHost` is the storefront host the escalation resolved (a Pivota
 * attribution hop already decoded to its destination).
 */
export function sellerVariantGidOf(row, sellerHost) {
  if (!isPlainObject(row)) return null;
  const variants = Array.isArray(own(row, "variants")) ? own(row, "variants").filter(isPlainObject) : [];
  if (variants.length > 1) return null; // the buyer's choice is not carried on this door: never guess
  const fromIds = [own(row, "source_variant_id"), own(row, "variant_gid")];
  if (variants.length === 1) fromIds.push(own(variants[0], "source_variant_id"), own(variants[0], "variant_gid"));
  for (const raw of fromIds) {
    const gid = typeof raw === "string" ? toVariantGid(raw) : (Number.isSafeInteger(raw) && raw > 0 ? toVariantGid(String(raw)) : null);
    if (gid) return gid;
  }
  if (!sellerHost) return null;
  const found = new Set();
  for (const key of ["destination_url", "canonical_url", "url"]) {
    const url = str(own(row, key));
    const parsed = url ? onSellerHost(url, sellerHost) : null;
    if (!parsed) continue;
    const values = parsed.searchParams.getAll("variant");
    if (values.length === 1 && /^\d{1,20}$/.test(values[0])) found.add(values[0]);
  }
  return found.size === 1 ? toVariantGid([...found][0]) : null;
}

// ---- the seller's answer ---------------------------------------------------------------------------------------

function unwrapPayload(toolResult) {
  if (!isPlainObject(toolResult)) return null;
  const response = toolResult.response != null ? toolResult.response : toolResult;
  const r = isPlainObject(response) && response.result != null ? response.result : response;
  const inner = isPlainObject(r) && r.result != null ? r.result : r;
  if (isPlainObject(inner) && Array.isArray(inner.content)) {
    for (const c of inner.content) {
      if (isPlainObject(c) && c.type === "json" && isPlainObject(c.json)) return c.json;
      if (isPlainObject(c) && c.type === "text" && typeof c.text === "string") {
        try { const j = JSON.parse(c.text); if (isPlainObject(j)) return j; } catch { /* not json */ }
      }
    }
  }
  return isPlainObject(inner) ? inner : null;
}

const minor = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/** One total of `type`, or null when absent, repeated (itemised: no single answer), or not integer minor units. */
function singleTotal(totals, type) {
  if (!Array.isArray(totals)) return null;
  const hits = totals.filter((t) => isPlainObject(t) && String(t.type || "").trim().toLowerCase() === type);
  return hits.length === 1 ? minor(hits[0].amount) : null;
}

function sellerMessageCodes(payload) {
  const messages = Array.isArray(own(payload, "messages")) ? own(payload, "messages") : [];
  const codes = [];
  for (const m of messages) {
    const code = isPlainObject(m) && typeof m.code === "string" ? m.code.trim().toLowerCase() : "";
    if (/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(code) && !codes.includes(code)) codes.push(code);
    if (codes.length >= MAX_SELLER_MESSAGE_CODES) break;
  }
  return codes;
}

/**
 * Read a seller cart into the escalation's line items and totals — or null when it does not match what was asked
 * EXACTLY (every requested variant on exactly one line, at the requested quantity, nothing else in the cart) or is
 * not money this door can state. Pure.
 * @param {object} payload the unwrapped cart
 * @param {{product_id:string, quantity:number, gid:string}[]} wanted
 * @param {string} sellerHost
 */
export function readSellerCart(payload, wanted, sellerHost) {
  if (!isPlainObject(payload)) return null;
  const currency = str(own(payload, "currency"));
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const continueUrl = str(own(payload, "continue_url")) || str(own(payload, "checkout_url"));
  if (!continueUrl || !onSellerHost(continueUrl, sellerHost)) return null;
  const lines = Array.isArray(own(payload, "line_items")) ? own(payload, "line_items") : null;
  if (!lines || lines.length !== wanted.length) return null;

  const byGid = new Map();
  for (const line of lines) {
    if (!isPlainObject(line)) return null;
    const item = isPlainObject(line.item) ? line.item : {};
    const gid = toVariantGid(typeof item.id === "string" ? item.id : String(item.id ?? ""));
    if (!gid || byGid.has(gid)) return null;
    byGid.set(gid, line);
  }
  const lineItems = [];
  let sum = 0;
  for (const [idx, w] of wanted.entries()) {
    const line = byGid.get(w.gid);
    if (!line || line.quantity !== w.quantity) return null;
    const item = isPlainObject(line.item) ? line.item : {};
    const unit = minor(item.price);
    if (unit === null) return null;
    const lineSubtotal = singleTotal(line.totals, "subtotal") ?? unit * w.quantity;
    const lineTotal = singleTotal(line.totals, "total") ?? lineSubtotal;
    if (!Number.isSafeInteger(lineSubtotal) || !Number.isSafeInteger(lineTotal)) return null;
    sum += lineSubtotal;
    lineItems.push({
      id: `li_${idx + 1}`,
      item: { id: w.product_id, title: str(item.title) || w.product_id, price: unit, ...(str(item.image_url) ? { image_url: str(item.image_url) } : {}) },
      quantity: w.quantity,
      totals: [{ type: "subtotal", amount: lineSubtotal }, { type: "total", amount: lineTotal }],
    });
  }
  const totalsRaw = own(payload, "totals");
  const subtotal = singleTotal(totalsRaw, "subtotal");
  const total = singleTotal(totalsRaw, "total");
  if (subtotal === null || total === null || !Number.isSafeInteger(sum)) return null;
  const totals = [{ type: "subtotal", amount: subtotal, display_text: "Subtotal (priced by the seller's storefront)" }];
  let detailed = false;
  for (const [type, label] of [["discount", "Discount"], ["items_discount", "Item discount"], ["fulfillment", "Shipping"], ["tax", "Tax"], ["fee", "Fee"]]) {
    const amount = singleTotal(totalsRaw, type);
    if (amount !== null) { totals.push({ type, amount, display_text: `${label} (priced by the seller's storefront)` }); detailed = true; }
  }
  totals.push({
    type: "total",
    amount: total,
    display_text: detailed ? "Total (priced by the seller's storefront)" : "Total before the shipping and tax the storefront adds at checkout",
  });
  const cartId = str(own(payload, "id")) || str(own(payload, "cart_id"));
  return {
    currency,
    continueUrl,
    lineItems,
    totals,
    cartId: isCarriableCartId(cartId) ? cartId : null,
    sellerMessageCodes: sellerMessageCodes(payload),
  };
}

// ---- the door ----------------------------------------------------------------------------------------------------

function outOfStockRefusal(productIds, sellerHost) {
  return intakeRefusal("OUT_OF_STOCK", "ucp_seller_out_of_stock", [
    `The seller's storefront (${sellerHost}) reports these items are not available for sale right now: ${productIds.join(", ")}.`,
    "Offer the buyer alternatives, or check the storefront later.",
  ].join(" "), { storefront_items: productIds, seller_hosts: [sellerHost] });
}

function withBudget(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The seller door, built once per process: ONE buyer-agent client and ONE bounded, TTL'd endpoint-discovery cache
 * (the warm-handoff service's), so every checkout for a seller reuses one discovery. Tests inject their own.
 */
export function createMerchantDoor({ client, discover, logger } = {}) {
  const realClient = client || buyerAgentClientModule.createUcpBuyerAgentClient({ timeoutMs: MERCHANT_CALL_TIMEOUT_MS, retryAttempts: 1 });
  const service = discover ? null : warmHandoffModule.createWarmHandoffService({ client: realClient, logger: logger || null });
  return {
    async endpointFor(sellerHost) {
      if (discover) return discover(sellerHost);
      const detailed = await service.discoverBrandEndpointDetailed(`https://${sellerHost}`);
      return detailed && detailed.mcpEndpoint ? detailed.mcpEndpoint : null;
    },
    createCart: (endpoint, args) => realClient.createCart(endpoint, args),
    getCart: (endpoint, cartId) => realClient.callTool(endpoint, "get_cart", { id: cartId }, { retry: true }),
  };
}

let defaultDoor = null;
function door(deps) {
  if (deps) return deps;
  if (!defaultDoor) defaultDoor = createMerchantDoor();
  return defaultDoor;
}

function emit(log, level, detail) {
  if (log && typeof log[level] === "function") {
    try { log[level]({ event: "ucp_merchant_door_pricing", ...detail }); } catch { /* never throw the door */ }
  }
}

/**
 * Price an escalation cart on the seller's own UCP door. Returns the seller-priced pieces, or null to fall back to
 * the catalog answer. Throws only the seller's out-of-stock refusal.
 *
 * @param {{ items:{product_id:string, quantity:number}[], rows:Map, sellerHost:string|null, market?:string|null,
 *           cartId?:string, env?:object, merchantDoor?:object, budgetMs?:number, log?:object }} a
 *   `cartId` set = a RE-READ of a cart this door built (get_checkout): `get_cart`, never a new cart.
 */
export async function priceOnMerchantDoor({ items, rows, sellerHost, market, cartId, env = process.env, merchantDoor, budgetMs = MERCHANT_PRICING_BUDGET_MS, log }) {
  if (!merchantPricingEnabled(env)) return null;
  if (!sellerHost) return null;
  const wanted = [];
  for (const it of items) {
    const gid = sellerVariantGidOf(rows.get(it.product_id), sellerHost);
    if (!gid) { emit(log, "info", { outcome: "fallback", reason: "variant_unresolved", seller_host: sellerHost }); return null; }
    if (wanted.some((w) => w.gid === gid)) { emit(log, "info", { outcome: "fallback", reason: "duplicate_variant", seller_host: sellerHost }); return null; }
    wanted.push({ product_id: it.product_id, quantity: it.quantity, gid });
  }
  const d = door(merchantDoor);
  const startedAt = Date.now();
  const left = () => budgetMs - (Date.now() - startedAt);

  let endpoint;
  try {
    const found = await withBudget(d.endpointFor(sellerHost), left());
    endpoint = found && !found.timedOut ? found : null;
  } catch { endpoint = null; }
  if (!endpoint) { emit(log, "info", { outcome: "fallback", reason: "no_seller_door", seller_host: sellerHost }); return null; }
  if (left() <= 0) { emit(log, "info", { outcome: "fallback", reason: FAILURE_REASON.TIMEOUT, seller_host: sellerHost }); return null; }

  let result;
  try {
    const call = cartId !== undefined
      ? d.getCart(endpoint, cartId)
      : d.createCart(endpoint, {
        lineItems: wanted.map((w) => ({ item: { id: w.gid }, quantity: w.quantity })),
        ...(market ? { context: { address_country: market } } : {}),
      });
    result = await withBudget(call, left());
  } catch (err) {
    emit(log, "warn", { outcome: "fallback", reason: classifyUcpFailure({ thrown: err, phase: "create_cart" }), seller_host: sellerHost });
    return null;
  }
  if (!result || result.timedOut) { emit(log, "info", { outcome: "fallback", reason: FAILURE_REASON.TIMEOUT, seller_host: sellerHost }); return null; }
  if (!result.ok || result.error) {
    const errorText = result.error && (result.error.message || result.error.code);
    const reason = classifyUcpFailure({ status: result.status, errorMessage: errorText, phase: "create_cart" });
    // STRICTER than the shared classifier on purpose: it counts any "unavailable" as out of stock, and a
    // "Service Unavailable" outage must fall back, not tell the buyer the item is sold out. Only an explicit
    // stock statement in a non-5xx answer refuses.
    const soldOut = reason === FAILURE_REASON.OUT_OF_STOCK && !(Number(result.status) >= 500)
      && SELLER_OUT_OF_STOCK_RE.test(String(errorText ?? ""));
    emit(log, "info", { outcome: soldOut ? "refused" : "fallback", reason, seller_host: sellerHost });
    if (soldOut) throw outOfStockRefusal(wanted.map((w) => w.product_id), sellerHost);
    return null;
  }
  const read = readSellerCart(unwrapPayload(result), wanted, sellerHost);
  if (!read) { emit(log, "info", { outcome: "fallback", reason: "cart_mismatch", seller_host: sellerHost }); return null; }
  if (cartId !== undefined && read.cartId !== cartId) { emit(log, "info", { outcome: "fallback", reason: "cart_id_mismatch", seller_host: sellerHost }); return null; }
  emit(log, "info", { outcome: "priced", seller_host: sellerHost, lines: wanted.length });
  return read;
}


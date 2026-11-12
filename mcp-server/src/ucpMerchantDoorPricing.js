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
//
// THE BUYER'S DISCOUNT CODE (AGENT_CHECKOUT_UCP_SELLER_DISCOUNT_CODES_ENABLED, default OFF, read per call). With it on,
// ONE code the buyer's agent sent (`checkout.discounts.codes`) rides on the cart this door builds, as UCP's discount
// extension spells it (`discounts.codes`), and the seller's answer about it comes back with the price:
//   - it is sent ONLY to a seller whose own profile advertises `dev.ucp.shopping.discount`. A seller that does not
//     might refuse the unknown member and fail the whole cart, so the code is held back and reported not evaluated;
//   - it is sent on CREATE only. A re-read (`get_cart`) reads whatever codes the seller's cart already holds;
//   - the seller's totals stay the only price: a discount shows up as the seller's own negative `discount` /
//     `items_discount` total, which readSellerCart already checks adds up. The code's outcome is reported beside
//     the price, never used to change it;
//   - a code counts as APPLIED only when exactly one readable applied entry names it, no rejection could concern it,
//     and the seller's totals carry a discount. Everything else is rejected (the seller said so) or not confirmed;
//   - the seller's discount TEXT (titles, message content) is data and is never forwarded, only its codes;
//   - the code itself is never logged.

import { intakeRefusal } from "../../safety-kernel/src/protocol/buyerIntake.js";
import buyerAgentClientModule from "../../src/services/ucpBuyerAgentClient.js";
import warmHandoffModule from "../../src/services/ucpWarmHandoff.js";
import shopifyVariantResolver from "../../src/services/shopifyVariantResolver.js";
import { judgeSellerUrl, pivotaHopDestination, SELF_HOST_RE } from "./ucpExpectedSeller.js";
import { encodeUcpVariantItemId, findRealVariant, realVariantsOf } from "./ucpVariantIds.js";

export const MERCHANT_PRICING_FLAG = "AGENT_CHECKOUT_UCP_MERCHANT_PRICING_ENABLED";
export const MERCHANT_PRICING_BUDGET_MS = 5000; // discovery (usually cached) + one cart call
const MERCHANT_CALL_TIMEOUT_MS = 3500;
const MAX_SELLER_MESSAGE_CODES = 5;
const MAX_CART_ID_LENGTH = 512;
// "not available for sale (in this market)" is a market restriction, not stock: it falls back, never OUT_OF_STOCK.
const SELLER_OUT_OF_STOCK_RE = /out[\s_-]?of[\s_-]?stock|sold[\s_-]?out|insufficient inventory/i;

const { toVariantGid } = shopifyVariantResolver;
const { classifyUcpFailure, FAILURE_REASON, normalizeDiscountCodes, normalizeDiscounts, forbiddenHostName } = buyerAgentClientModule;

export const SELLER_DISCOUNT_CODES_FLAG = "AGENT_CHECKOUT_UCP_SELLER_DISCOUNT_CODES_ENABLED";
// The rejection family UCP's discount extension defines (`discount_code_expired`, `discount_code_invalid`, …); a
// merchant may add its own member. Messages in it are about a CODE, not about the cart's price.
const DISCOUNT_MESSAGE_RE = /^discount_code_[a-z0-9_]{1,48}$/;
// The UCP applied-entry `method` vocabulary (discount.json): how an amount is spread over the lines.
const DISCOUNT_METHODS = new Set(["each", "across"]);
const MAX_REPORTED_CODES = 5;
// THE ONE CONTENT RULE for a code this door sends, echoes or reports: non-blank, at most 128 UTF-16 code units (the
// unit the client's own 255 bound counts, so a code the door accepts is never one the client refuses), and no
// character that is invisible or can disguise text: every control, format (bidi marks, zero-width, soft hyphen, TAG
// characters U+E0000-E007F, interlinear annotation), surrogate, private-use, unassigned, line or paragraph separator,
// plus the invisible letters and marks that are not in those categories (combining grapheme joiner, Mongolian free
// variation selectors, Hangul fillers, braille blank, variation selectors). Applied to the buyer's code before any
// seller sees it AND to every code the seller's cart answers with, so neither side can put one in the answer.
export const DISCOUNT_CODE_MAX_LENGTH = 128;
const DISCOUNT_CODE_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u034f\u115f\u1160\u180b-\u180d\u180f\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;
export function isAcceptableDiscountCode(code) {
  return typeof code === "string" && code.trim() !== "" && code.length <= DISCOUNT_CODE_MAX_LENGTH
    && !DISCOUNT_CODE_FORBIDDEN_RE.test(code);
}

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

/** This lane's own discount-code switch ALONE. The door accepts codes only with the escalation and pricing on too. */
export function sellerDiscountCodesFlagOn(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[SELLER_DISCOUNT_CODES_FLAG]) || "").trim());
}

/** A merchant cart id this door will carry in its checkout id and hand back to that seller's `get_cart`. */
export function isCarriableCartId(v) {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_CART_ID_LENGTH && /^[\x21-\x7e]+$/.test(v);
}

// ---- which variant ---------------------------------------------------------------------------------------------

function bareHost(h) {
  return String(h || "").toLowerCase().replace(/^www\./, "");
}

// A URL that carries ANOTHER URL in a query value (`?return_to=https://…`) is a hop whose final destination is
// not its host; the same rule ucpExpectedSeller applies. Tracking members (`ref`, `utm_*`) are context, not hops.
function carriesAnotherUrl(parsed) {
  for (const [key, value] of parsed.searchParams.entries()) {
    if (/^(ref|utm_[a-z0-9_]*)$/i.test(key)) continue;
    if (/^\s*(https?:)?\/\//i.test(value) || /^\s*https?%3a/i.test(value)) return true;
  }
  return false;
}

// ONLY A SINGLE-TENANT DOOR HOST IS "THE SELLER". A Shopify store's UCP door lives on its OWN `<store>.myshopify.com`
// (measured: judydoll), so a cart URL there is that store's. Other platforms serve every merchant from ONE shared host
// — Wix sellers advertise `https://www.wixapis.com/ecom/ucp/<siteId>/mcp` (Pivota's own probe data) — where a URL on
// the door host may be any site's, so the door host proves nothing and such carts stay on the seller-host rule.
// Pivota's own hosts never qualify (the /r hop is judgeSellerUrl's to decode or refuse).
const SINGLE_TENANT_DOOR_HOST_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** An https URL exactly on the answering UCP door's host (no subdomain widening), with the same refusals. */
function onDoorHost(url, doorHost) {
  if (!doorHost) return null;
  const door = String(doorHost).toLowerCase();
  if (!SINGLE_TENANT_DOOR_HOST_RE.test(door) || SELF_HOST_RE.test(door)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || carriesAnotherUrl(parsed)) return null;
  return parsed.hostname.toLowerCase() === door ? parsed : null;
}

function onSellerHost(url, sellerHost) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password || carriesAnotherUrl(parsed)) return null;
  const host = bareHost(parsed.hostname);
  const seller = bareHost(sellerHost);
  return host === seller || host.endsWith(`.${seller}`) ? parsed : null;
}

/**
 * The seller's own Shopify variant GID for a catalog row, or null when it is not unambiguous. Offline: reads only
 * what the product read already carries. `sellerHost` is the storefront host the escalation resolved (a Pivota
 * attribution hop already decoded to its destination).
 */
// A variant's OWN id as the product read carries it — `variant_id` (else `id`) — as a Shopify variant gid, or null.
// THE READ'S SHAPE, not a fixture's: pdpBuilder.buildVariants emits `variant_id` / `sku_id` and never
// `source_variant_id` / `variant_gid` (measured 2026-10-09, variant census). An id that restates the PRODUCT is
// refused (a row with no variant list gets one made up from the product's own id). NOT distinguishable on the read: a
// seed variant with no id falls back to its `sku`, and the builder copies the id into `sku_id` either way, so a numeric
// barcode can arrive here looking like a Shopify id. That is accepted knowingly: the seller answers "variant not
// found" (fall back), and readSellerCart only prices a cart whose line is EXACTLY the gid asked for — a wrong item
// would need a barcode equal to another variant id in the same store, and the buyer still sees the cart before paying.
function ownVariantIdGid(v, row) {
  for (const key of ["variant_id", "id"]) {
    const raw = own(v, key);
    const id = typeof raw === "string" ? raw.trim() : (Number.isSafeInteger(raw) && raw > 0 ? String(raw) : "");
    if (!id) continue;
    for (const k of ["product_id", "pivota_signature_id", "external_product_id", "source_product_id", "shopify_product_id"]) {
      const pid = own(row, k);
      if (pid !== undefined && pid !== null && String(pid).trim() === id) return null;
    }
    // THE WHOLE STRING is the id: bare digits, or exactly a Shopify variant gid. `toVariantGid` alone matches a gid
    // ANYWHERE in a string (`https://x/?gid://shopify/ProductVariant/1…`), and an id read off the product is not a
    // place to fish one out of.
    if (!/^\d{6,}$/.test(id) && !/^gid:\/\/shopify\/ProductVariant\/\d+$/i.test(id)) return null;
    return toVariantGid(id);
  }
  return null;
}

export function sellerVariantGidOf(row, sellerHost, chosenVariantId) {
  return sellerVariantChoiceOf(row, sellerHost, chosenVariantId).gid;
}

/**
 * The seller variant gid AND where it came from: `chosen` (the buyer picked it; `stored` true when the gid is the
 * variant's stored seller id `source_variant_id` / `variant_gid`, false when it is the variant's own id), `row_id` (a row-level or sole-variant
 * seller id field), `url` (a seller-host link's `variant=`, possibly agreeing with the read), or `sole_variant_id` (the
 * read's single variant's own id with no link naming it — a DERIVED id, see refuseDerivedSoleVariant). `{gid: null}`
 * when there is none.
 */
export function sellerVariantChoiceOf(row, sellerHost, chosenVariantId) {
  const none = { gid: null, source: null };
  if (!isPlainObject(row)) return none;
  // A variant the BUYER CHOSE (already proven one of this product's real variants at the door): its own seller id —
  // `source_variant_id` / `variant_gid`, else its id when that is itself a Shopify variant id. Nothing else: the
  // row-level id or a URL's `variant=` may name a different variant.
  if (chosenVariantId !== undefined && chosenVariantId !== null) {
    const v = findRealVariant(row, chosenVariantId);
    if (!v) return none;
    for (const raw of [own(v, "source_variant_id"), own(v, "variant_gid")]) {
      const gid = typeof raw === "string" ? toVariantGid(raw) : (Number.isSafeInteger(raw) && raw > 0 ? toVariantGid(String(raw)) : null);
      if (gid) return { gid, source: "chosen", stored: true };
    }
    // `stored: false`: the variant's own id merely LOOKS like a Shopify id (6+ digits). A barcode copied into
    // variant_id passes that test, so this gid is not evidence of what the seller sells (see ucpCheckoutEscalation's
    // variant policy, which never refuses on it).
    const own_ = ownVariantIdGid(v, row);
    return own_ ? { gid: own_, source: "chosen", stored: false } : none;
  }
  const variants = Array.isArray(own(row, "variants")) ? own(row, "variants").filter(isPlainObject) : [];
  if (variants.length > 1) return none; // the buyer's choice is not carried on this door: never guess
  const fromIds = [own(row, "source_variant_id"), own(row, "variant_gid")];
  if (variants.length === 1) fromIds.push(own(variants[0], "source_variant_id"), own(variants[0], "variant_gid"));
  for (const raw of fromIds) {
    const gid = typeof raw === "string" ? toVariantGid(raw) : (Number.isSafeInteger(raw) && raw > 0 ? toVariantGid(String(raw)) : null);
    if (gid) return { gid, source: "row_id" };
  }
  // THE SOLE VARIANT'S OWN ID, as the live read carries it (see ownVariantIdGid) — only when it is a REAL variant by
  // checkout's own count (a restated product id never is). A seller-host URL's `variant=` naming a DIFFERENT variant
  // makes the row ambiguous: neither is guessed.
  let soleGid = null;
  if (variants.length === 1) {
    const real = realVariantsOf(row);
    if (real.length === 1 && real[0].variant === variants[0]) soleGid = ownVariantIdGid(variants[0], row);
  }
  if (!sellerHost) return soleGid ? { gid: soleGid, source: "sole_variant_id" } : none;
  const found = new Set();
  for (const key of ["destination_url", "canonical_url", "url"]) {
    const url = str(own(row, key));
    const parsed = url ? onSellerHost(url, sellerHost) : null;
    if (!parsed) continue;
    const values = parsed.searchParams.getAll("variant");
    if (values.length === 1 && /^\d{1,20}$/.test(values[0])) found.add(values[0]);
  }
  const urlGid = found.size === 1 ? toVariantGid([...found][0]) : null;
  if (found.size > 1) return none;
  if (soleGid && urlGid && soleGid !== urlGid) return none; // the read and the link name different variants
  if (urlGid) return { gid: urlGid, source: "url" };
  return soleGid ? { gid: soleGid, source: "sole_variant_id" } : none;
}

// ---- a derived sole-variant id is refused when the catalog knows several Shopify variants ------------------------
//
// OWNER DECISION 2026-10-09 (via the PR controller): the read can show ONE variant for a product whose catalog_skus
// hold SEVERAL distinct Shopify variant ids (the variant census found 43 serving rows). Pricing the read's single
// variant there would cart one shade of several on no buyer choice, so such a product must not be merchant-priced
// and must not get a derived sole-variant id. Applies ONLY to `sole_variant_id` (no seller link names the variant);
// a buyer's choice, a seller id field, or a link's own `variant=` is explicit, not derived.
//
// The count is the census's own definition: distinct `source_variant_id` that is Shopify-shaped (6+ digits, a variant
// gid, or SHOPIFY-<n>), over the product's UNSUPPRESSED catalog_skus rows, keyed by the read's `product_key` (stamped by
// the catalog identity layer, src/server.js applyCatalogIdentityToPdpProduct). One indexed count
// (idx_catalog_skus_product_key), bounded by a budget. FAILS CLOSED: no product_key, a timeout or an error means the
// product is not merchant-priced (the decision is "must not"), never that the check is skipped.
export const CATALOG_SHOPIFY_VARIANT_COUNT_SQL = `
SELECT count(DISTINCT s.source_variant_id) FILTER (
         WHERE s.source_variant_id ~ '^[0-9]{6,}$'
            OR s.source_variant_id ~* 'gid://shopify/ProductVariant/[0-9]+'
            OR s.source_variant_id ~* '^SHOPIFY-[0-9]{6,}$')::int AS shop_ids
  FROM catalog_skus s
 WHERE s.product_key = $1
   AND s.suppressed_at IS NULL
   AND s.suppression_reason IS NULL`;
const CATALOG_COUNT_BUDGET_MS = 800;

function productKeyOfRow(row) {
  const key = str(own(row, "product_key")) || str(own(row, "catalog_product_key"));
  return key && key.length <= 512 && !/[\u0000-\u001f\u007f]/.test(key) ? key : null;
}

/** null when a derived sole-variant id may be used; otherwise the fallback reason. */
async function refuseDerivedSoleVariant(row, door) {
  if (typeof door.catalogShopifyVariantCount !== "function") return "catalog_variant_count_unavailable";
  const productKey = productKeyOfRow(row);
  if (!productKey) return "catalog_variant_count_no_product_key";
  let count;
  try { count = await door.catalogShopifyVariantCount(productKey); } catch { return "catalog_variant_count_unavailable"; }
  if (!Number.isSafeInteger(count) || count < 0) return "catalog_variant_count_unavailable";
  return count > 1 ? "catalog_several_shopify_variants" : null;
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

/** Codes of the seller messages whose `type` is "error" (any code, normalised), in order. */
function sellerErrorCodes(payload) {
  const messages = Array.isArray(own(payload, "messages")) ? own(payload, "messages") : [];
  return messages
    .filter((m) => isPlainObject(m) && String(m.type || "").trim().toLowerCase() === "error")
    .map((m) => (typeof m.code === "string" ? m.code.trim().toLowerCase() : ""));
}

const SELLER_OUT_OF_STOCK_CODE_RE = /^(out_of_stock|sold_out|insufficient_inventory)$/;

function sellerMessageCodes(payload, { discountCodesOn = false } = {}) {
  const messages = Array.isArray(own(payload, "messages")) ? own(payload, "messages") : [];
  const codes = [];
  for (const m of messages) {
    const code = isPlainObject(m) && typeof m.code === "string" ? m.code.trim().toLowerCase() : "";
    // With codes on, a `discount_code_*` message is reported in the code's own outcome, not as a cart message.
    if (discountCodesOn && DISCOUNT_MESSAGE_RE.test(code)) continue;
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
export function readSellerCart(payload, wanted, sellerHost, { expectedCurrency, doorHost, discountCodesOn = false } = {}) {
  if (!isPlainObject(payload)) return null;
  // A cart the seller itself flags with an ERROR message is not a price to show (out of stock is handled by the
  // caller, from the same messages, before this is reached). With codes on, a `discount_code_*` error is about the
  // CODE (the spec sends rejections as warnings, a merchant may send them as errors): the code is reported not
  // applied, and the cart's own totals still have to add up below before any price is shown.
  const errors = sellerErrorCodes(payload).filter((code) => !(discountCodesOn && DISCOUNT_MESSAGE_RE.test(code)));
  if (errors.length) return null;
  const currency = str(own(payload, "currency"));
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  // The market's currency, as the catalog states it for these rows: a seller answering in another currency (a
  // geo-defaulted storefront, a market the request did not name) is not the price this buyer was shown.
  if (expectedCurrency && currency !== expectedCurrency) return null;
  const continueUrl = str(own(payload, "continue_url")) || str(own(payload, "checkout_url"));
  // On the seller's host (or a subdomain), OR exactly on the host of the UCP door that answered. Measured on
  // judydoll.com 2026-10-09: its /.well-known/ucp names `judydoll-joygroup.myshopify.com/api/ucp/mcp`, and the cart's
  // continue_url is on that myshopify host — Shopify stores answer from their myshopify domain, so a seller-host-only
  // rule discarded every such cart. The door host is vouched for by the seller's OWN profile (discovery refuses
  // redirects), so it is the seller too; the same userinfo / embedded-URL refusals apply.
  if (!continueUrl || !(onSellerHost(continueUrl, sellerHost) || onDoorHost(continueUrl, doorHost))) return null;
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
    const lineId = w.variant_id ? encodeUcpVariantItemId(w.product_id, w.variant_id) : w.product_id;
    const lineSubtotal = singleTotal(line.totals, "subtotal") ?? unit * w.quantity;
    const lineTotal = singleTotal(line.totals, "total") ?? lineSubtotal;
    if (!Number.isSafeInteger(lineSubtotal) || !Number.isSafeInteger(lineTotal)) return null;
    sum += lineSubtotal;
    lineItems.push({
      id: `li_${idx + 1}`,
      item: { id: lineId, title: str(item.title) || w.product_id, price: unit, ...(str(item.image_url) ? { image_url: str(item.image_url) } : {}) },
      quantity: w.quantity,
      totals: [{ type: "subtotal", amount: lineSubtotal }, { type: "total", amount: lineTotal }],
    });
  }
  const totalsRaw = own(payload, "totals");
  const subtotal = singleTotal(totalsRaw, "subtotal");
  const total = singleTotal(totalsRaw, "total");
  // The seller's own subtotal must be the sum of its own lines: a cart that disagrees with itself has no price.
  if (subtotal === null || total === null || !Number.isSafeInteger(sum) || subtotal !== sum) return null;
  const totals = [{ type: "subtotal", amount: subtotal, display_text: "Subtotal (priced by the seller's storefront)" }];
  let detailed = false;
  let components = 0;
  // UCP total.json: `discount` / `items_discount` amounts are NEGATIVE; the other components are not. A component of
  // the wrong sign, or one this door cannot read as a single integer, is not a price to restate: fall back. And the
  // seller's total must be its subtotal plus the components it listed — a total nothing explains is not shown.
  for (const [type, label, negative] of [["discount", "Discount", true], ["items_discount", "Item discount", true], ["fulfillment", "Shipping", false], ["tax", "Tax", false], ["fee", "Fee", false]]) {
    const hits = Array.isArray(totalsRaw) ? totalsRaw.filter((t) => isPlainObject(t) && String(t.type || "").trim().toLowerCase() === type) : [];
    if (hits.length === 0) continue;
    const amount = hits.length === 1 ? hits[0].amount : undefined;
    if (!Number.isSafeInteger(amount) || (negative ? amount >= 0 : amount < 0)) return null;
    components += amount;
    totals.push({ type, amount, display_text: `${label} (priced by the seller's storefront)` });
    detailed = true;
  }
  if (total !== subtotal + components) return null;
  totals.push({
    type: "total",
    amount: total,
    display_text: detailed ? "Total (priced by the seller's storefront)" : "Total before the shipping and tax the storefront adds at checkout",
  });
  // No cart id = no way to re-read THIS cart, so every later poll would answer with the catalog price: fall back
  // now rather than answer one way on create and another on get.
  const cartId = str(own(payload, "id")) || str(own(payload, "cart_id"));
  if (!isCarriableCartId(cartId)) return null;
  return {
    currency,
    continueUrl,
    lineItems,
    totals,
    cartId,
    sellerMessageCodes: sellerMessageCodes(payload, { discountCodesOn }),
  };
}

// ---- the buyer's discount code ---------------------------------------------------------------------------------

/**
 * What the seller's cart says about discount codes, in THIS door's terms. Pure. Called only on a cart readSellerCart
 * already accepted (`read`), so every seller line maps to exactly one wanted line.
 *
 * @param {object} payload the unwrapped seller cart
 * @param {{gid:string}[]} wanted the lines this door asked for, in this door's line order
 * @param {object} read readSellerCart's answer for the same payload
 * @param {{ requested?: string, notSentReason?: string|null }} opts
 *   `requested` = the code the buyer sent on this create (undefined on a re-read, which reports the seller's echo);
 *   `notSentReason` = why it never reached the seller (then nothing the seller said can be about it).
 * @returns {{ codes: string[], applied: object[], outcomes: {code:string, status:string, reason:string|null}[] } | null}
 *   null when there is nothing to say (no code asked for, none on the seller's cart, nothing applied).
 *   `status` is `applied`, `rejected` (the seller refused it; `reason` is its `discount_code_*` code), or
 *   `not_confirmed` (`reason`: not_sent_* / seller_did_not_apply / unmapped_rejection / unreadable / ambiguous /
 *   totals_show_no_discount / amounts_disagree).
 */
export function readSellerDiscounts(payload, wanted, read, { requested, notSentReason = null } = {}) {
  const d = normalizeDiscounts(payload);
  // The buyer's code is echoed as sent (UCP echoes the submitted codes; the door already refused one that breaks the
  // content rule); matching below ignores case and padding. A re-read reports the seller's echo, bounded by the
  // same rule: a code the seller sends back that breaks it is not repeated to the agent.
  const reported = requested !== undefined
    ? [String(requested)]
    : [...new Set(d.submitted_codes.map((c) => c.trim()).filter(isAcceptableDiscountCode))].slice(0, MAX_REPORTED_CODES);
  // Seller line k -> this door's line index, by variant gid (readSellerCart matched them one to one).
  const sellerLines = Array.isArray(own(payload, "line_items")) ? own(payload, "line_items") : [];
  const ourIndex = sellerLines.map((line) => {
    const item = isPlainObject(line) && isPlainObject(line.item) ? line.item : {};
    const gid = toVariantGid(typeof item.id === "string" ? item.id : String(item.id ?? ""));
    return wanted.findIndex((w) => w.gid === gid);
  });
  const remap = (entry) => {
    if (!entry.automatic && !isAcceptableDiscountCode(entry.code)) return null;
    const allocations = [];
    for (const a of entry.allocations) {
      if (a.target === "unallocated") continue; // the spec's order-level form: an entry with no allocations
      if (a.target === "line") {
        const k = Number(/^\$\.line_items\[(\d+)\]$/.exec(a.path)[1]);
        if (!(ourIndex[k] >= 0)) return null;
        allocations.push({ path: `$.line_items[${ourIndex[k]}]`, amount: a.amount_minor });
      } else {
        allocations.push({ path: a.path, amount: a.amount_minor });
      }
    }
    return {
      ...(entry.automatic ? { automatic: true } : { code: entry.code }),
      amount: entry.amount_minor,
      ...(DISCOUNT_METHODS.has(entry.method) ? { method: entry.method } : {}),
      ...(allocations.length ? { allocations } : {}),
    };
  };
  const discountRows = read.totals.filter((t) => t.type === "discount" || t.type === "items_discount");
  const hasDiscountTotal = discountRows.length > 0;
  // THE AMOUNTS MUST BE THE SELLER'S OWN DISCOUNT ROWS. The applied entries this door would show (every readable one:
  // codes and automatic) must add up to exactly what the seller's totals take off (its `discount` + `items_discount`
  // rows, negative). Anything unreadable, or any disagreement, and no amount is shown and no code counts as applied:
  // the total stays the seller's, and nothing beside it claims a saving the total does not carry.
  const rowsOff = -discountRows.reduce((sum, t) => sum + t.amount, 0);
  const entriesOff = d.applied.reduce((sum, a) => sum + a.amount_minor, 0);
  const amountsAgree = d.unreadable.length === 0 && Number.isSafeInteger(entriesOff) && entriesOff === rowsOff;
  const key = (c) => String(c || "").trim().toUpperCase();
  const outcomes = [];
  const applied = [];
  for (const code of reported) {
    let status = "not_confirmed";
    let reason = null;
    const mine = d.applied.filter((a) => a.code && isAcceptableDiscountCode(a.code) && key(a.code) === key(code));
    const rejection = d.rejected.find((r) => key(r.code) === key(code));
    if (notSentReason) reason = notSentReason;
    else if (rejection) { status = "rejected"; reason = DISCOUNT_MESSAGE_RE.test(rejection.reason) ? rejection.reason : "discount_code_invalid"; }
    else if (d.unmapped_rejections.length) reason = "unmapped_rejection";
    else if (d.unreadable.some((u) => u.code && key(u.code) === key(code))) reason = "unreadable";
    else if (mine.length === 0) reason = "seller_did_not_apply";
    else if (mine.length > 1) reason = "ambiguous";
    else if (!hasDiscountTotal) reason = "totals_show_no_discount";
    else if (!amountsAgree) reason = "amounts_disagree";
    else {
      const entry = remap(mine[0]);
      if (entry) { status = "applied"; applied.push(entry); } else reason = "unreadable";
    }
    outcomes.push({ code, status, reason });
  }
  // Automatic discounts are part of the seller's price; shown beside the codes so the totals' discount is explained,
  // and only when the amounts agree with the seller's discount rows (above).
  if (amountsAgree) {
    for (const a of d.applied.filter((x) => x.automatic)) {
      const entry = remap(a);
      if (entry) applied.push(entry);
    }
  }
  if (!reported.length && !applied.length) return null;
  return { codes: reported, applied, outcomes };
}

// ---- attribution ---------------------------------------------------------------------------------------------------
//
// THE CATALOG LINK CARRIES PIVOTA'S REFERRAL. A stamped storefront row's link is Pivota's attribution hop
// (`https://api.pivota.cc/r?token=…`), whose destination carries `utm_source=pivota&pvt_click_id=…` — the referral
// the seller joins an order back on (`join_mode: referral_only`). The seller's cart URL carries none of it, so a
// priced answer would silently drop the referral. The tracking members of the catalog link's destination (the hop's
// `dest`, or the link itself) are therefore carried onto the cart URL, never overwriting a member the seller set.
// The hop's own click record (the /r redirect) is NOT reproduced: minting a hop needs the backend's key.
const TRACKING_KEY_RE = /^(utm_[a-z0-9_]{1,40}|pvt_[a-z0-9_]{1,40})$/i;
// Unreserved characters only: a carried value can then never be a URL (no `:` or `/`), needs no encoding, and is
// appended to the RAW query — the seller's own query string is left byte for byte as the seller wrote it.
const TRACKING_VALUE_RE = /^[A-Za-z0-9._~-]{1,200}$/;

/** The tracking members (`utm_*`, `pvt_*`) of the catalog link's destination, first value per key. Pure. */
function trackingPairsOf(catalogLink) {
  let source;
  try {
    const parsed = new URL(catalogLink);
    const hop = pivotaHopDestination(parsed);
    source = hop ? (hop.dest ? new URL(hop.dest) : null) : parsed;
  } catch { source = null; }
  if (!source) return null;
  const pairs = [];
  const seen = new Set();
  for (const [key, value] of source.searchParams.entries()) {
    if (!TRACKING_KEY_RE.test(key) || !TRACKING_VALUE_RE.test(value) || seen.has(key)) continue;
    seen.add(key);
    pairs.push([key, value]);
  }
  return pairs;
}

export function carryAttribution(cartUrl, catalogLink) {
  const tracking = trackingPairsOf(catalogLink);
  if (!tracking) return cartUrl;
  let parsed;
  try { parsed = new URL(cartUrl); } catch { return cartUrl; }
  const pairs = tracking.filter(([key]) => !parsed.searchParams.has(key)).map(([key, value]) => `${key}=${value}`);
  if (!pairs.length) return cartUrl;
  const hashAt = cartUrl.indexOf("#");
  const head = hashAt === -1 ? cartUrl : cartUrl.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : cartUrl.slice(hashAt);
  const sep = !head.includes("?") ? "?" : (head.endsWith("?") || head.endsWith("&") ? "" : "&");
  return `${head}${sep}${pairs.join("&")}${hash}`;
}

// THE UCP `attribution` MEMBER ON THE SELLER'S CART (FIX_PLAN O-02; AGENT_CHECKOUT_UCP_CART_ATTRIBUTION_ENABLED, default
// OFF, read per call). UCP 2026-04-08 — the version this door speaks (safety-kernel/src/protocol/ucpSpecVersion.cjs) —
// defines `attribution` on the cart object (shopping/cart.json: create "optional", $ref types/attribution.json: an
// open map of string values, "platform-emitted referral and conversion-event context ... the same parameters
// platforms pass in URL query strings"). So the referral the cart URL already carries (above) is ALSO sent the way
// the protocol defines, on create_cart, as `cart.attribution`: the SAME tracking members, never anything new, never
// buyer data. A re-read (`get_cart`) sends nothing. Off, the cart is byte-identical to before.
export const CART_ATTRIBUTION_FLAG = "AGENT_CHECKOUT_UCP_CART_ATTRIBUTION_ENABLED";
export function cartAttributionEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[CART_ATTRIBUTION_FLAG]) || "").trim());
}

/** The `cart.attribution` object for a catalog link, or null when it carries no tracking member. Pure. */
export function cartAttributionOf(catalogLink) {
  const pairs = catalogLink ? trackingPairsOf(catalogLink) : null;
  if (!pairs || !pairs.length) return null;
  return Object.fromEntries(pairs);
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
export function createMerchantDoor({ client, discover, logger, catalogQuery, clientOptions } = {}) {
  const realClient = client || buyerAgentClientModule.createUcpBuyerAgentClient({ timeoutMs: MERCHANT_CALL_TIMEOUT_MS, retryAttempts: 1, ...(clientOptions || {}) });
  const service = discover ? null : warmHandoffModule.createWarmHandoffService({ client: realClient, logger: logger || null });
  return {
    // The endpoint string, or `{ mcpEndpoint, acceptsDiscountCodes }` when the seller's profile was read (the real
    // door); priceOnMerchantDoor reads both. An injected `discover` may return either.
    async endpointFor(discoveryHost) {
      if (discover) return discover(discoveryHost);
      const detailed = await service.discoverBrandEndpointDetailed(`https://${discoveryHost}`);
      return detailed && detailed.mcpEndpoint
        ? { mcpEndpoint: detailed.mcpEndpoint, acceptsDiscountCodes: detailed.acceptsDiscountCodes === true }
        : null;
    },
    createCart: (endpoint, args) => realClient.createCart(endpoint, args),
    getCart: (endpoint, cartId) => realClient.callTool(endpoint, "get_cart", { id: cartId }, { retry: true }),
    async catalogShopifyVariantCount(productKey) {
      const run = catalogQuery || (async (text, params, opts) => {
        const db = (await import("../../src/db/index.js")).default;
        return db.queryWithBudget(text, params, opts);
      });
      const res = await run(CATALOG_SHOPIFY_VARIANT_COUNT_SQL, [productKey], { timeoutMs: CATALOG_COUNT_BUDGET_MS });
      const value = res && Array.isArray(res.rows) && res.rows[0] ? res.rows[0].shop_ids : undefined;
      return Number.isSafeInteger(value) ? value : (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null);
    },
  };
}

let defaultDoor = null;
function door(deps, factory = createMerchantDoor) {
  if (deps) return deps;
  if (!defaultDoor) defaultDoor = factory();
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
 *   `signals` (optional out-param array): what the seller SAID while this door fell back, for the caller to act on.
 *   Today one signal: `{ reason: "variant_invalid", lines }` — the seller's own door answered a create_cart with a
 *   STRUCTURED tool error naming the variant as unknown (see ucpCheckoutEscalation.js, the variant_invalid policy).
 *   `discountCode` (create only, with SELLER_DISCOUNT_CODES_FLAG on): the buyer's ONE code, sent to a seller whose
 *   profile advertises the discount capability. With the flag on, the answer carries `discounts`
 *   (readSellerDiscounts) whenever there is something to say about codes.
 */
export async function priceOnMerchantDoor({ items, rows, sellerHost, discoveryHost, catalogLink, expectedSeller, market, cartId, discountCode, env = process.env, merchantDoor, doorFactory, budgetMs = MERCHANT_PRICING_BUDGET_MS, log, signals }) {
  if (!merchantPricingEnabled(env)) return null;
  if (!sellerHost) return null;
  const discountCodesOn = sellerDiscountCodesFlagOn(env);
  // The code to send, or why it is not sent. A re-read never sends one: the seller's cart already holds its codes.
  const codeRequested = discountCodesOn && cartId === undefined && typeof discountCode === "string";
  let codeToSend = null;
  let notSentReason = null;
  if (codeRequested) {
    try { [codeToSend] = normalizeDiscountCodes([discountCode]); } catch { notSentReason = "not_sent_malformed"; }
    // Defensive: the escalation refuses such a code first, but this door never sends one whatever its caller did.
    if (codeToSend !== null && !isAcceptableDiscountCode(codeToSend)) { codeToSend = null; notSentReason = "not_sent_malformed"; }
  }
  // The catalog's currency for these rows (the escalation refuses a mixed-currency cart before this is reached).
  const currencies = new Set(items.map((it) => str(own(rows.get(it.product_id), "currency"))?.toUpperCase()).filter(Boolean));
  const expectedCurrency = currencies.size === 1 ? [...currencies][0] : null;
  if (!expectedCurrency) { emit(log, "info", { outcome: "fallback", reason: "catalog_currency_unknown", seller_host: sellerHost }); return null; }
  const wanted = [];
  const derived = [];
  for (const it of items) {
    const choice = sellerVariantChoiceOf(rows.get(it.product_id), sellerHost, it.variant_id);
    const gid = choice.gid;
    if (!gid) { emit(log, "info", { outcome: "fallback", reason: "variant_unresolved", seller_host: sellerHost }); return null; }
    // A "choice" of the ONLY real variant is not a choice: get_product publishes no variant list for such a product,
    // but its sole variant id is visible elsewhere (variants[0].variant_id on the native door / PDP), so
    // `<pid>::v::<sole id>` passes the door's membership check. It is checked exactly as a derived id is.
    const row = rows.get(it.product_id);
    if (choice.source === "sole_variant_id" || (choice.source === "chosen" && realVariantsOf(row).length === 1)) derived.push(row);
    if (wanted.some((w) => w.gid === gid)) { emit(log, "info", { outcome: "fallback", reason: "duplicate_variant", seller_host: sellerHost }); return null; }
    wanted.push({ product_id: it.product_id, quantity: it.quantity, gid, ...(it.variant_id ? { variant_id: it.variant_id } : {}) });
  }
  // A door that cannot even be built (e.g. a malformed signing key in env) is a fallback, not a failed checkout.
  let d;
  try { d = door(merchantDoor, doorFactory); } catch (err) {
    emit(log, "warn", { outcome: "fallback", reason: "door_unavailable", seller_host: sellerHost, message: err && err.message });
    return null;
  }
  // The budget covers the catalog check too (it is part of this door's work), so the clock starts before it.
  const startedAt = Date.now();
  const left = () => budgetMs - (Date.now() - startedAt);
  // A DERIVED sole-variant id is checked against the catalog BEFORE any seller is contacted (refuseDerivedSoleVariant),
  // inside the budget: a lookup that does not answer in time is a refusal (fail closed), like any other.
  for (const row of derived) {
    const settled = await withBudget(refuseDerivedSoleVariant(row, d), left());
    const refusal = settled && settled.timedOut ? "catalog_variant_count_timeout" : settled;
    if (refusal) { emit(log, "info", { outcome: "fallback", reason: refusal, seller_host: sellerHost }); return null; }
  }

  let endpoint;
  let acceptsDiscountCodes = false;
  try {
    // Discovered on the storefront's OWN hostname (`www.` kept): discovery refuses redirects, so a store whose bare
    // domain 301s to www would otherwise never be found.
    const found = await withBudget(d.endpointFor(discoveryHost || sellerHost), left());
    if (typeof found === "string") endpoint = found;
    else if (isPlainObject(found) && !found.timedOut && typeof found.mcpEndpoint === "string") {
      endpoint = found.mcpEndpoint;
      acceptsDiscountCodes = found.acceptsDiscountCodes === true;
    } else endpoint = null;
  } catch { endpoint = null; }
  if (!endpoint) { emit(log, "info", { outcome: "fallback", reason: "no_seller_door", seller_host: sellerHost }); return null; }
  if (left() <= 0) { emit(log, "info", { outcome: "fallback", reason: FAILURE_REASON.TIMEOUT, seller_host: sellerHost }); return null; }
  if (codeToSend !== null && !acceptsDiscountCodes) { codeToSend = null; notSentReason = "not_sent_seller_does_not_advertise"; }

  const cartAttribution = cartId === undefined && cartAttributionEnabled(env) ? cartAttributionOf(catalogLink) : null;
  let result;
  try {
    const call = cartId !== undefined
      ? d.getCart(endpoint, cartId)
      : d.createCart(endpoint, {
        lineItems: wanted.map((w) => ({ item: { id: w.gid }, quantity: w.quantity })),
        ...(market ? { context: { address_country: market } } : {}),
        ...(codeToSend !== null ? { discountCodes: [codeToSend] } : {}),
        ...(cartAttribution ? { cartAttribution } : {}),
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
    // STRICTER than the shared classifier on purpose: it counts any "unavailable" as out of stock, and for a non-2xx
    // answer the "message" is the raw response body (an HTML 404 page with a "Sold out" badge, a 429 saying "may be
    // out of stock"). Only a STRUCTURED tool answer (HTTP 2xx carrying a JSON-RPC or MCP tool error) with an explicit
    // stock statement refuses; everything else falls back.
    const structured = result.ok === true && Number(result.status) >= 200 && Number(result.status) < 300;
    const soldOut = structured && reason === FAILURE_REASON.OUT_OF_STOCK && SELLER_OUT_OF_STOCK_RE.test(String(errorText ?? ""));
    emit(log, "info", { outcome: soldOut ? "refused" : "fallback", reason, seller_host: sellerHost });
    if (soldOut) throw outOfStockRefusal(wanted.map((w) => w.product_id), sellerHost);
    // THE SELLER SAYS IT DOES NOT KNOW THIS VARIANT. Same strictness as out-of-stock: only a structured 2xx tool
    // error (the shared classifier reads free text, and an HTML "Page not found" once classified as variant_invalid).
    // Not proof the PRODUCT is gone, so it is reported, never acted on here; a cart-level error names no line, so
    // every line goes back. A re-read (`get_cart`) is not a claim about a variant.
    if (structured && reason === FAILURE_REASON.VARIANT_INVALID && cartId === undefined && Array.isArray(signals)) {
      signals.push({
        reason: "variant_invalid",
        lines: wanted.map((w) => ({ product_id: w.product_id, gid: w.gid, chosen: Boolean(w.variant_id) })),
      });
    }
    return null;
  }
  const payload = unwrapPayload(result);
  // The seller flagging the cart with a structured out-of-stock ERROR message refuses exactly as a tool error does.
  if (sellerErrorCodes(payload).some((code) => SELLER_OUT_OF_STOCK_CODE_RE.test(code))) {
    emit(log, "info", { outcome: "refused", reason: FAILURE_REASON.OUT_OF_STOCK, seller_host: sellerHost });
    throw outOfStockRefusal(wanted.map((w) => w.product_id), sellerHost);
  }
  let doorHost = null;
  try { const ep = new URL(endpoint); if (ep.protocol === "https:") doorHost = ep.hostname.toLowerCase(); } catch { doorHost = null; }
  const read = readSellerCart(payload, wanted, sellerHost, { expectedCurrency, doorHost, discountCodesOn });
  if (!read) { emit(log, "info", { outcome: "fallback", reason: "cart_mismatch", seller_host: sellerHost }); return null; }
  if (discountCodesOn) {
    const discounts = readSellerDiscounts(payload, wanted, read, { requested: codeRequested ? discountCode : undefined, notSentReason });
    if (discounts) {
      read.discounts = discounts;
      // Counts and statuses only: the code is the buyer's and is never logged.
      emit(log, "info", {
        outcome: "discount_codes", seller_host: sellerHost, sent: codeToSend !== null,
        statuses: discounts.outcomes.map((o) => (o.reason ? `${o.status}:${o.reason}` : o.status)),
        applied_entries: discounts.applied.length,
      });
    }
  }
  // THE ONE VALUE HANDED TO THE BUYER, judged as the lane judges its own link: when the platform named the seller it
  // showed (`checkout.reap.expected_merchant_domain`), a cart URL that is not provably that seller falls back.
  // A cart URL on the answering door's own host was vouched for by the seller's profile, discovered from the seller
  // host the lane already judged against the expected seller; only a URL on any OTHER host is judged here.
  const onDoor = Boolean(onDoorHost(read.continueUrl, doorHost));
  if (expectedSeller !== undefined && !onDoor && !judgeSellerUrl(expectedSeller, read.continueUrl).ok) {
    emit(log, "info", { outcome: "fallback", reason: "continue_url_not_expected_seller", seller_host: sellerHost });
    return null;
  }
  if (catalogLink) read.continueUrl = carryAttribution(read.continueUrl, catalogLink);
  if (cartId !== undefined && read.cartId !== cartId) { emit(log, "info", { outcome: "fallback", reason: "cart_id_mismatch", seller_host: sellerHost }); return null; }
  emit(log, "info", { outcome: "priced", seller_host: sellerHost, lines: wanted.length });
  return read;
}


// ---- verify ONE code on a seller's door (the coupon verifier's route) -------------------------------------------
//
// The same pieces the checkout door uses — endpoint discovery (with the seller's advertised discount capability),
// `create_cart` with the code, readSellerCart, readSellerDiscounts — for ONE store variant at quantity 1, with no
// catalog row: the verifier names the seller host and the store's own variant. So a verification and a buyer's
// checkout read a seller's answer the same way and cannot disagree. Never a checkout, never a payment; the cart is
// the same anonymous cart one buyer's checkout makes. The code is never logged.
//
// Result `result`:
//   applied        the seller applied it: `discount` carries the amount (minor) and allocations; `totals` are the seller's
//   rejected       the seller refused it: `reason` is its `discount_code_*` code
//   not_confirmed  the seller priced the cart but its answer does not confirm the code (`reason` says why)
//   not_evaluated  the code was not sent (`reason`: seller_does_not_advertise)
//   not_priced     no seller-priced cart (`reason`: no_seller_door, timeout, out_of_stock, variant_invalid, cart_mismatch, …)
const SELLER_HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;
export const VERIFY_BUDGET_MS = 6000;

// THE VERIFIER'S OWN DOOR, never the checkout door's: (1) its client is capped below the TOKEN tier, so a bearer
// credential configured for buyer checkouts can never ride a request to an endpoint a seller's profile names (the
// verifier fans out to stores we have no relationship with); (2) no retry, so a timed-out create_cart is never
// sent twice; (3) its own discovery cache, so verifying many stores never evicts the checkout door's entries.
export const VERIFY_DOOR_CLIENT_OPTIONS = Object.freeze({ allowTokenTier: false, retryAttempts: 0, timeoutMs: MERCHANT_CALL_TIMEOUT_MS });
let defaultVerifyDoor = null;
function verifyDoor(deps, factory) {
  if (deps) return deps;
  if (factory) return factory();
  if (!defaultVerifyDoor) {
    defaultVerifyDoor = createMerchantDoor({ clientOptions: VERIFY_DOOR_CLIENT_OPTIONS });
  }
  return defaultVerifyDoor;
}

/** A host this verifier never contacts: our own, or a name that is never a merchant (see forbiddenHostName). */
function refusedHost(host) {
  const h = String(host || "").toLowerCase();
  return SELF_HOST_RE.test(h) || forbiddenHostName(h);
}

/** Input problems, or null. Pure; the route answers 400 with the first one. */
export function verifyInputProblem({ sellerHost, discoveryHost, variantGid, market, code, expectedCurrency } = {}) {
  if (typeof sellerHost !== "string" || !SELLER_HOST_RE.test(sellerHost)) return "seller_host_invalid";
  if (refusedHost(sellerHost)) return "seller_host_refused";
  if (discoveryHost !== undefined) {
    // The seller's own storefront name, or its www. form: never a third host that merely answers for it.
    if (typeof discoveryHost !== "string" || !SELLER_HOST_RE.test(discoveryHost)) return "discovery_host_invalid";
    const bare = (h) => h.replace(/^www\./, "");
    if (bare(discoveryHost) !== bare(sellerHost)) return "discovery_host_mismatch";
  }
  // A string only: an array or a number would pass a looser check (and a large number loses precision).
  if (typeof variantGid !== "string" || !/^(\d{6,20}|gid:\/\/shopify\/ProductVariant\/\d{6,20})$/.test(variantGid.trim())) return "variant_invalid";
  if (typeof market !== "string" || !/^[A-Z]{2}$/.test(market)) return "market_invalid";
  if (!isAcceptableDiscountCode(code)) return "code_invalid";
  // REQUIRED: the market's currency. A seller answering in another currency is not a price for this buyer.
  if (!(typeof expectedCurrency === "string" && /^[A-Z]{3}$/.test(expectedCurrency))) return "currency_invalid";
  return null;
}

export async function verifyCodeOnMerchantDoor({ sellerHost, discoveryHost, variantGid, market, code, expectedCurrency, merchantDoor, doorFactory, budgetMs = VERIFY_BUDGET_MS, log } = {}) {
  const problem = verifyInputProblem({ sellerHost, discoveryHost, variantGid, market, code, expectedCurrency });
  if (problem) return { result: "invalid", reason: problem };
  const gid = toVariantGid(String(variantGid).trim());
  const wanted = [{ product_id: gid, quantity: 1, gid }];
  const host = sellerHost.toLowerCase();
  const say = (detail) => emit(log, "info", { outcome: "verify", seller_host: host, ...detail });
  let d;
  try { d = verifyDoor(merchantDoor, doorFactory); } catch { say({ result: "not_priced", reason: "door_unavailable" }); return { result: "not_priced", reason: "door_unavailable" }; }
  const startedAt = Date.now();
  const left = () => budgetMs - (Date.now() - startedAt);

  let endpoint = null;
  let accepts = false;
  try {
    const found = await withBudget(d.endpointFor(discoveryHost || host), left());
    if (typeof found === "string") endpoint = found;
    else if (isPlainObject(found) && !found.timedOut && typeof found.mcpEndpoint === "string") {
      endpoint = found.mcpEndpoint;
      accepts = found.acceptsDiscountCodes === true;
    }
  } catch { endpoint = null; }
  const done = (out) => { say({ result: out.result, reason: out.reason || null }); return out; };
  if (!endpoint) return done({ result: "not_priced", reason: "no_seller_door" });
  // The endpoint the seller's PROFILE names is checked before any cart: https only, never our own host or a name
  // that is never a merchant (the transport refuses those too; this keeps the reason explicit and the call unmade).
  let endpointHost = null;
  try { const ep = new URL(endpoint); endpointHost = ep.protocol === "https:" ? ep.hostname.toLowerCase() : null; } catch { endpointHost = null; }
  if (!endpointHost || refusedHost(endpointHost)) return done({ result: "not_priced", reason: "endpoint_refused" });
  if (!accepts) return done({ result: "not_evaluated", reason: "seller_does_not_advertise" });
  if (left() <= 0) return done({ result: "not_priced", reason: FAILURE_REASON.TIMEOUT });

  let res;
  try {
    res = await withBudget(d.createCart(endpoint, {
      lineItems: [{ item: { id: gid }, quantity: 1 }],
      context: { address_country: market },
      discountCodes: [code],
    }), left());
  } catch (err) {
    return done({ result: "not_priced", reason: classifyUcpFailure({ thrown: err, phase: "create_cart" }) });
  }
  if (!res || res.timedOut) return done({ result: "not_priced", reason: FAILURE_REASON.TIMEOUT });
  if (!res.ok || res.error) {
    const errorText = res.error && (res.error.message || res.error.code);
    return done({ result: "not_priced", reason: classifyUcpFailure({ status: res.status, errorMessage: errorText, phase: "create_cart" }) });
  }
  const payload = unwrapPayload(res);
  if (sellerErrorCodes(payload).some((c) => SELLER_OUT_OF_STOCK_CODE_RE.test(c))) return done({ result: "not_priced", reason: FAILURE_REASON.OUT_OF_STOCK });
  let doorHost = null;
  try { const ep = new URL(endpoint); if (ep.protocol === "https:") doorHost = ep.hostname.toLowerCase(); } catch { doorHost = null; }
  const read = readSellerCart(payload, wanted, host, { expectedCurrency, doorHost, discountCodesOn: true });
  if (!read) return done({ result: "not_priced", reason: "cart_mismatch" });
  const discounts = readSellerDiscounts(payload, wanted, read, { requested: code });
  const outcome = discounts ? discounts.outcomes[0] : { status: "not_confirmed", reason: "seller_did_not_apply" };
  const mine = outcome.status === "applied" ? discounts.applied.find((a) => a.code) : null;
  const totalOf = (type) => (read.totals.find((t) => t.type === type) || {}).amount;
  const discountRows = read.totals.filter((t) => t.type === "discount" || t.type === "items_discount");
  return done({
    result: outcome.status,
    reason: outcome.reason || null,
    currency: read.currency,
    totals: {
      subtotal: totalOf("subtotal"),
      discount: discountRows.length ? -discountRows.reduce((s, t) => s + t.amount, 0) : 0,
      total: totalOf("total"),
    },
    unit_price: read.lineItems[0].item.price,
    discount: mine ? { amount: mine.amount, ...(mine.method ? { method: mine.method } : {}), ...(mine.allocations ? { allocations: mine.allocations } : {}) } : null,
    automatic: (discounts ? discounts.applied : []).filter((a) => a.automatic).map((a) => ({ amount: a.amount })),
  });
}

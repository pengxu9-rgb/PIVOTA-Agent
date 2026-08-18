// UCP checkout ESCALATION for rows Pivota does not transact — path 2 of the two-path model.
//
// THE TWO PATHS (founder, 2026-08-18; verified against the protocols the same day):
//   1. CONTRACTED seller — contract + PSP + fulfillment relationship. The buyer pays IN the agent chat; the
//      seller's acquirer (Antom, for that cohort) sits behind Pivota's door. That is the kernel path this
//      module deliberately does NOT touch: quote-first, charge-once, ownership — all unchanged.
//   2. UNCONTRACTED seller — an OBSERVED seller (`merch_obs_*`): a brand or retailer we crawled, no
//      contract, no PSP, no fulfillment. Pivota can neither price with authority nor charge nor ship for it,
//      so a Pivota "quote" for such a row is a promise nobody can keep. What the buyer's agent does instead is
//      complete the purchase ON THE SELLER'S OWN STOREFRONT — with a human at the wheel, or with the agent's
//      own tokenized credential (Visa Intelligent Commerce: "the agent delivers the payment credentials to
//      the merchant through the merchant's guest checkout, key entered, web form or through an available
//      merchant API"; issuers such as Reap sit at the card layer). EITHER WAY the payment leg is entirely
//      outside Pivota; from the seller's side it is a normal card transaction.
//
// WHAT UCP HAS FOR PATH 2, AND WHAT IT DOES NOT. UCP has no notion of an agent-held credential — VIC is
// orthogonal to it. What UCP HAS is the checkout status `requires_escalation`: "Checkout session requires
// information that cannot be provided via API, or buyer input is required", for which the business "MUST
// provide continue_url" and the platform "MUST use continue_url" (specification/checkout, fetched
// 2026-08-18). So the honest, spec-conformant thing this door can say for a path-2 row is a checkout in that
// state whose `continue_url` is the seller's storefront — plus the structured line items, price expectation
// and buyer echo the agent needs to pre-fill and to detect drift. Whether the platform then hands a human to
// that URL (the spec's guidance) or lets its agent complete there with its own credential is the platform's
// decision and the platform's compliance question, not this door's.
//
// WHY THIS IS NOT "just build offer-grain pricing in the backend". Review of #2024 traced the backend: its one
// pricing engine is Shopify Storefront Cart, and a UCP quote reaches it without a merchant_id. Building a
// second engine to price rows Pivota cannot then charge or ship would manufacture quotes that cannot be
// completed. Escalation says the truth instead: this purchase completes over there.
//
// ---- HOW A ROW IS CLASSIFIED (typed, never inferred) ------------------------------------------------------
//
// The unscoped product read (the SAME `get_product` the checkout resolver already performs) publishes
// `external_redirect_url` ONLY when src/pdpBuilder.js judged the row's purchase route to be a redirect —
// from an explicit redirect field on the row, or an external-seed-like row with a destination. Contracted
// merchant rows carry none. Measured live 2026-08-18: every sampled seed row carried it (the seller's product
// page); `purchase_route` / `commerce_mode` / `checkout_handoff` were null on the read. So:
//   escalate  ⇔ the read carries an https `external_redirect_url` AND does not declare `purchase_route:
//               'internal_checkout'` (a row that says both is a contradiction; the kernel path wins, which
//               is today's behaviour — fail closed towards NOT escalating).
//   otherwise ⇒ fall through to the kernel path untouched.
// Nothing here reads a merchant-id prefix, a URL host pattern, or a platform name to decide the lane.
//
// ---- WHAT IS RETURNED, AND WHERE IT COMES FROM ------------------------------------------------------------
//
// FETCHED 2026-08-18: https://ucp.dev/2026-04-08/schemas/shopping/checkout.json and the types it $refs.
//   checkout   : required ["ucp","id","line_items","status","currency","totals","links"]; continue_url MUST
//                be present when status = requires_escalation; expires_at RFC 3339 (default TTL 6h)
//   ucp        : response_checkout_schema = base (["version"]) + required ["payment_handlers"]
//   line_item  : ["id","item","quantity","totals"]; item ["id","title","price"] (price = ISO minor units)
//   totals     : "MUST contain exactly one subtotal and one total entry"; total ["type","amount"]
//   links      : ["type","url"], "Mandatory for legal" — well-known types privacy_policy, terms_of_service
//   status     : incomplete | requires_escalation | ready_for_complete | complete_in_progress | completed | canceled
// mcp-server/test/ucpCheckoutEscalation.test.js pins these arrays with the same provenance.
//
// The `totals` are the catalog's LAST OBSERVED price for those items — an expectation the agent can check
// against the storefront, stated as such in `messages`, never presented as a Pivota quote. `payment_handlers`
// is `{}`: Pivota collects no instrument here. `links` carries the one legal URL that resolves today
// (https://pivota.cc/terms, measured 200 2026-08-18); a privacy-policy URL is added the moment one exists
// (PIVOTA_PRIVACY_POLICY_URL) — publishing a guessed one would be the dead-URL defect this repo has already
// shipped once.
//
// STATELESS BY DESIGN. The checkout `id` is `esc_` + base64url({v, i:[[product_id, qty]…]}) — product ids and
// quantities ONLY, never buyer data. `get_checkout` on such an id re-reads the rows and re-answers; there is
// no session store because there is nothing to hold: no quote, no lock, no inventory, no charge. `update_` and
// `complete_checkout` on such an id are refused with a curated message — an escalated checkout changes and
// completes on the seller's storefront, and pretending otherwise here would advertise an operation this door
// cannot honour.
//
// KILL-SWITCH. Everything here is behind AGENT_CHECKOUT_UCP_ESCALATION_ENABLED (default OFF, read per call).
// Off, this module returns null for every call and the door behaves exactly as before.

import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import {
  assertProductIdentity,
  intakeRefusal,
  itemVariantRefusal,
  normalizeEmail,
  mapWithConcurrency,
  withDeadline,
  MAX_CART_DISTINCT_PRODUCTS,
  VARIANT_RESOLUTION_CONCURRENCY,
  DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS,
  VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE,
} from "../../safety-kernel/src/protocol/buyerIntake.js";
import { majorToIsoMinor } from "../../safety-kernel/src/money.js";

export const UCP_ESCALATION_FLAG = "AGENT_CHECKOUT_UCP_ESCALATION_ENABLED";
export const UCP_RESPONSE_VERSION = "2026-04-08";
export const ESCALATION_ID_PREFIX = "esc_";
const ESCALATION_TTL_MS = 6 * 60 * 60 * 1000; // the spec's default TTL
const MAX_ESCALATION_ITEMS = 50;
const TERMS_URL = "https://pivota.cc/terms"; // measured 200, "Terms of Service | Pivota", 2026-08-18

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
function own(src, key) {
  if (!isPlainObject(src)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function ucpEscalationEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[UCP_ESCALATION_FLAG]) || "").trim());
}

/** The typed lane decision. Returns the storefront URL to escalate to, or null for the kernel path. */
export function escalationTargetOf(product) {
  if (!isPlainObject(product)) return null;
  const route = str(product.purchase_route || product.purchaseRoute);
  if (route && route.toLowerCase() === "internal_checkout") return null;
  const url = str(product.external_redirect_url || product.externalRedirectUrl);
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  return parsed.toString();
}

// ---- id ----------------------------------------------------------------------------------------------------

export function encodeEscalationId(items) {
  const i = items.map((it) => [it.product_id, it.quantity]);
  return ESCALATION_ID_PREFIX + Buffer.from(JSON.stringify({ v: 1, i }), "utf8").toString("base64url");
}

export function decodeEscalationId(id) {
  if (typeof id !== "string" || !id.startsWith(ESCALATION_ID_PREFIX) || id.length > 4096) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(id.slice(ESCALATION_ID_PREFIX.length), "base64url").toString("utf8"));
  } catch { return null; }
  if (!isPlainObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.i) || parsed.i.length === 0 || parsed.i.length > MAX_ESCALATION_ITEMS) return null;
  const items = [];
  for (const entry of parsed.i) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [product_id, quantity] = entry;
    if (!str(product_id) || !Number.isSafeInteger(quantity) || quantity < 1) return null;
    items.push({ product_id: product_id.trim(), quantity });
  }
  return items;
}

export function isEscalationId(id) {
  return decodeEscalationId(id) !== null;
}

// ---- reads -------------------------------------------------------------------------------------------------
//
// THE SAME BOUNDS AS THE CHECKOUT RESOLVER, by the SAME helpers: at most MAX_CART_DISTINCT_PRODUCTS distinct
// products (an oversized cart is refused here as cheaply as intake would refuse it), VARIANT_RESOLUTION_
// CONCURRENCY reads in flight, ONE deadline for the batch, expiry = refusal. Review of #2025 found the first
// cut reading serially with no cap and no deadline — a 50-distinct cart (or a forged 50-item esc_ id on
// get_checkout) was 50 serial upstream reads before anything refused it.
//
// NO DOUBLE READ ON THE KERNEL PATH: callTool hands this module a per-call MEMOIZING executor view
// (commerceToolSurface `memoizedProductReads`) and hands the SAME view to the checkout resolver, so a
// contracted cart that classifies as "kernel path" has its products read ONCE and the resolver reuses them.

async function readRows(items, executor, ctx, { timeoutMs = DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS } = {}) {
  const ids = [...new Set(items.map((it) => it.product_id))];
  if (ids.length > MAX_CART_DISTINCT_PRODUCTS) {
    throw intakeRefusal("QUOTE_REQUIRED", "acp_cart_too_many_products",
      `A checkout may reference at most ${MAX_CART_DISTINCT_PRODUCTS} distinct products.`, { max_distinct_products: MAX_CART_DISTINCT_PRODUCTS });
  }
  const controller = new AbortController();
  let results;
  try {
    results = await withDeadline(
      mapWithConcurrency(ids, VARIANT_RESOLUTION_CONCURRENCY, async (product_id) => {
        const result = await executor.execute("get_product", { payload: { product: { product_id } } }, { ...ctx, signal: controller.signal });
        assertProductIdentity(result, product_id, undefined);
        return isPlainObject(own(result, "product")) ? own(result, "product") : result;
      }, controller),
      timeoutMs,
      controller,
    );
  } catch (err) {
    // A named intake refusal (identity mismatch) is already curated: surface it. Anything else is an
    // errored/expired read: internal cause never surfaced, caller told what is actionable.
    if (err instanceof PivotaCommerceError && isPlainObject(err.detail?.acp_detail)) throw err;
    throw itemVariantRefusal("resolution_unavailable", VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE);
  }
  return new Map(ids.map((id, i) => [id, results[i]]));
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

// ---- response ----------------------------------------------------------------------------------------------

function priceOf(row) {
  const currency = str(row.currency);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const amount = majorToIsoMinor(row.price, currency);
  if (amount === undefined) return null;
  return { amount, currency };
}

/**
 * Build the spec checkout for an already-classified, same-seller cart. Pure.
 * @param {{ id:string, items:{product_id,quantity}[], rows:Map, continueUrl:string, buyerEmail?:string, now:number, env?:object }} a
 */
export function buildEscalationCheckout({ id, items, rows, continueUrl, buyerEmail, now, env = process.env }) {
  const lineItems = [];
  let subtotal = 0;
  let currency = null;
  items.forEach((it, idx) => {
    const row = rows.get(it.product_id);
    const price = priceOf(row);
    if (!price) {
      throw new PivotaCommerceError("NO_MERCHANT_OFFER", { reason: "ucp_escalation_item_unpriced", dialect: "ucp", product_id: it.product_id });
    }
    if (currency && price.currency !== currency) {
      throw intakeRefusal("QUOTE_REQUIRED", "ucp_escalation_mixed_currency",
        "Items in one checkout must share a currency; these rows are observed in different currencies. Send one checkout per currency.",
        { currencies: [currency, price.currency] });
    }
    currency = price.currency;
    const lineTotal = price.amount * it.quantity;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) {
      throw intakeRefusal("QUOTE_REQUIRED", "ucp_escalation_total_overflow", "The requested quantities exceed what this checkout can total.", { product_id: it.product_id });
    }
    subtotal += lineTotal;
    const image = str(row.image_url) || (Array.isArray(row.images) ? str(row.images[0]) : null);
    lineItems.push({
      id: `li_${idx + 1}`,
      item: compact({ id: it.product_id, title: str(row.title) || str(row.brand) || it.product_id, price: price.amount, image_url: image }),
      quantity: it.quantity,
      totals: [
        { type: "subtotal", amount: lineTotal },
        { type: "total", amount: lineTotal },
      ],
    });
  });

  const host = hostOf(continueUrl);
  const links = [{ type: "terms_of_service", url: TERMS_URL, title: "Pivota Terms of Service" }];
  const privacy = str(env && env.PIVOTA_PRIVACY_POLICY_URL);
  if (privacy && /^https:\/\//.test(privacy)) links.unshift({ type: "privacy_policy", url: privacy, title: "Pivota Privacy Policy" });

  return compact({
    ucp: { version: UCP_RESPONSE_VERSION, status: "success", payment_handlers: {} },
    id,
    status: "requires_escalation",
    continue_url: continueUrl,
    currency,
    line_items: lineItems,
    totals: [
      { type: "subtotal", amount: subtotal, display_text: "Expected subtotal (catalog's last observed price)" },
      { type: "total", amount: subtotal, display_text: "Expected total before the seller's shipping and tax" },
    ],
    buyer: buyerEmail ? { email: buyerEmail } : undefined,
    links,
    expires_at: new Date(now + ESCALATION_TTL_MS).toISOString(),
    messages: [
      {
        type: "info",
        code: "checkout.completes_on_seller_storefront",
        path: "$.continue_url",
        content: [
          `This purchase completes on the seller's own storefront (${host}) — Pivota has no contract, payment or fulfillment relationship with this seller and does not price, charge or ship this checkout.`,
          "Totals are the catalog's last observed prices for these items and may differ on the storefront; verify there before paying.",
          "This checkout cannot be updated or completed here; change items or pay on the storefront.",
        ].join(" "),
        content_type: "plain",
      },
    ],
  });
}

function attestedEmailOrBody(attested, bodyValue) {
  const att = isPlainObject(attested) ? str(attested.attested_email) : null;
  if (att) return att;
  return normalizeEmail(bodyValue) || undefined;
}

// ---- entry point ---------------------------------------------------------------------------------------------

/**
 * Called by commerceToolSurface.callTool on the UCP dialect for the checkout operations, AFTER the argument
 * translation + allowlist and BEFORE buyer intake. Returns a spec checkout to answer with, or `null` to fall
 * through to the kernel path untouched.
 *
 * @param {{ op:{id:string}, params:object, ctx:object, executor:{execute:Function}, ucpArgs:object, now?:number, env?:object }} a
 */
export async function tryEscalateUcpCheckout({ op, params, ctx, executor, ucpArgs, attested = {}, now = Date.now(), env = process.env, timeoutMs }) {
  if (!ucpEscalationEnabled(env)) return null;
  const opId = op && op.id;

  if (opId === "create_checkout_session") {
    const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
    const items = Array.isArray(quote.items) ? quote.items.filter((it) => isPlainObject(it) && str(it.product_id)) : [];
    if (items.length === 0 || items.length > MAX_ESCALATION_ITEMS) return null; // intake will refuse an empty/oversized cart itself
    // A quantity that is not a positive safe integer is NOT coerced to 1 (review of #2025: that would state a
    // one-unit total for a cart the caller believes is 2.5 or "3" — on the one number the agent compares
    // against the storefront). Fall through: intake refuses it with its own curated `item_bad_quantity`.
    if (items.some((it) => !Number.isSafeInteger(it.quantity) || it.quantity < 1)) return null;
    const rows = await readRows(items, executor, ctx, { timeoutMs });
    const targets = new Map();
    for (const [pid, row] of rows) targets.set(pid, escalationTargetOf(row));
    const escalating = [...targets.values()].filter(Boolean).length;
    if (escalating === 0) return null; // kernel path (contracted rows)
    if (escalating !== targets.size) {
      const over = [...targets.entries()].filter(([, t]) => t).map(([pid]) => pid);
      throw intakeRefusal("QUOTE_REQUIRED", "ucp_mixed_checkout_lanes", [
        "This cart mixes items Pivota transacts with items that complete on their seller's own storefront.",
        `Send one checkout per lane: these items complete on a seller storefront and cannot share a checkout with the others: ${over.join(", ")}.`,
      ].join(" "), { storefront_items: over });
    }
    const hosts = new Set([...targets.values()].map(hostOf));
    if (hosts.size > 1) {
      throw intakeRefusal("QUOTE_REQUIRED", "ucp_multi_seller_escalation", [
        "These items complete on different sellers' storefronts and cannot share one checkout.",
        `Send one checkout per seller: ${[...hosts].join(", ")}.`,
      ].join(" "), { seller_hosts: [...hosts] });
    }
    const normalized = items.map((it) => ({ product_id: it.product_id.trim(), quantity: it.quantity }));
    const continueUrl = targets.get(normalized[0].product_id);
    return buildEscalationCheckout({
      id: encodeEscalationId(normalized),
      items: normalized,
      rows,
      continueUrl,
      // ATTESTED WINS, exactly as intake rule 1: the verified session's email displaces any body value, and a
      // body value is only ever echoed after normalizeEmail. `buyer.email` is what a platform pre-fills on
      // the storefront, so a body-supplied address displacing a signed-in buyer's is the misdirection rule 1
      // exists to stop (review of #2025). UNLIKE a Pivota quote, an email is OPTIONAL here — `buyer` is an
      // optional member of the checkout and the storefront collects its own — so nothing is refused for its
      // absence (resolveBuyerEmail would; this is the same precedence without the throw).
      buyerEmail: attestedEmailOrBody(attested, quote.customer_email),
      now,
      env,
    });
  }

  const sessionId = str(own(params, "session_id"));
  const decoded = sessionId ? decodeEscalationId(sessionId) : null;
  if (!decoded) return null; // not one of ours: kernel path

  if (opId === "get_checkout_session") {
    const rows = await readRows(decoded, executor, ctx, { timeoutMs });
    const targets = decoded.map((it) => escalationTargetOf(rows.get(it.product_id)));
    if (targets.some((t) => !t)) {
      // The row stopped being an escalation row since the id was minted (it became a contracted merchant, or
      // lost its destination). There is no session to recover: say so rather than fabricate one.
      throw new PivotaCommerceError("QUOTE_NOT_FOUND", { reason: "ucp_escalation_row_changed", dialect: "ucp" });
    }
    return buildEscalationCheckout({ id: sessionId, items: decoded, rows, continueUrl: targets[0], now, env });
  }

  if (opId === "update_checkout_session" || opId === "complete_checkout_session") {
    throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", {
      reason: opId === "update_checkout_session" ? "ucp_escalation_update_refused" : "ucp_escalation_complete_refused",
      dialect: "ucp",
      acp_message: opId === "update_checkout_session"
        ? "This checkout completes on the seller's own storefront and cannot be updated here. Create a new checkout with the items you want, or change them on the storefront via continue_url."
        : "This checkout completes on the seller's own storefront and cannot be completed here — Pivota does not charge for this seller. Pay on the storefront via continue_url.",
      acp_detail: { reason: "escalated_checkout", continue_url_required: true },
    });
  }

  return null;
}

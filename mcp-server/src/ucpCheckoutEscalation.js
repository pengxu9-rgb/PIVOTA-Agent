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
// WHAT THE PURCHASABILITY GATE ADMITS HERE (client rule 7, 2026-10-09). This door asks the HUMAN question
// (`RAIL.human` -> the backend's `human_handoff_tier`): a storefront a person can pay on, with whatever it
// takes -- including a PayPal-only or wallet-only checkout (NO_CARD_PAYMENT), which the card rail refuses.
// So a platform that lets its agent complete here with its OWN tokenized card (VIC) may be handed a
// `continue_url` that card cannot pay; that is the platform's decision above, and Pivota's money is never on
// the line. The one answer this door never hands out is a storefront NO human can complete.
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
// against the storefront, stated as such in `messages`, never presented as a Pivota quote. With
// AGENT_CHECKOUT_UCP_MERCHANT_PRICING_ENABLED on, the SELLER's own UCP door prices the cart instead when it can
// (ucpMerchantDoorPricing.js, `buildSellerPricedCheckout`): the seller's lines, totals and cart continue_url, and
// an `esc_` id (v2) that also carries the seller's cart id so a re-read asks the seller for the same cart. `payment_handlers`
// is `{}`: Pivota collects no instrument here. `links` carries the one legal URL that resolves today
// (https://pivota.cc/terms, measured 200 2026-08-18); a privacy-policy URL is added the moment one exists
// (PIVOTA_PRIVACY_POLICY_URL) — publishing a guessed one would be the dead-URL defect this repo has already
// shipped once.
//
// STATELESS BY DESIGN. The checkout `id` is `esc_` + base64url({v, i:[[product_id, qty]…]}) — product ids and
// quantities ONLY, never buyer data (a seller-priced id adds `c`, the seller's own cart id). `get_checkout` on such an id re-reads the rows and re-answers; there is
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
// The merchant-purchasability gate — PATH 2 OF 3. CommonJS on purpose: this is the SAME module the
// warm-handoff seam uses, so the process has ONE client, ONE bounded cache and ONE switch. A second
// copy here would be a second cache with its own TTL, i.e. two different answers for one merchant.
// (Node resolves `src/services/*` against the repo-root package.json, which declares no `type`, so the
// default interop import is the module's `module.exports` object.)
import merchantPurchasability from "../../src/services/merchantPurchasabilityClient.js";
// The storefront product-page check — CommonJS, shared with the search price overlay so a page either surface
// found gone is gone for both for the same TTL (src/services/storefrontProductPage.js).
import storefrontProductPageModule from "../../src/services/storefrontProductPage.js";
import { carriesAnotherUrl, judgeSellerUrl, pivotaHopDestination, reapExpectedMerchantDomain, sellerMismatchRefusal, SELF_HOST_RE } from "./ucpExpectedSeller.js";
import { priceOnMerchantDoor, isCarriableCartId, sellerVariantGidOf } from "./ucpMerchantDoorPricing.js";
import { encodeUcpVariantItemId, findRealVariant, parseUcpItemId, variantLabelOf, variantPriceOf } from "./ucpVariantIds.js";

export const UCP_ESCALATION_FLAG = "AGENT_CHECKOUT_UCP_ESCALATION_ENABLED";
export const UCP_RESPONSE_VERSION = "2026-04-08";
export const ESCALATION_ID_PREFIX = "esc_";
export const ESCALATION_TTL_MS = 6 * 60 * 60 * 1000; // the spec's default TTL
const MAX_ESCALATION_ITEMS = 50;
// THE DEAD-PAGE CHECK (default OFF, read per call): before a catalog-priced checkout hands out a continue_url, read
// the product page behind each line. A page SHOPIFY says is gone (404/410 stamped `powered-by: Shopify`) refuses the
// checkout by name instead of sending the buyer to "page not found". Anything else, including a read that fails or
// runs out of budget, hands out the link exactly as before. A seller-priced checkout is not checked: the seller just
// built a cart for these variants, so the products exist.
export const DEAD_PAGE_CHECK_FLAG = "AGENT_CHECKOUT_UCP_DEAD_PAGE_CHECK_ENABLED";
export const DEAD_PAGE_CHECK_BUDGET_MS = 1500;
// THE VARIANT POLICY (default OFF, read per call): on the same page read, a line whose seller variant the store's own
// page no longer lists is not handed out as if it were sold. A variant the BUYER chose is refused by name when the
// seller's door also said `variant_invalid`; otherwise the stale `variant=` is dropped from a direct continue_url and
// the checkout warns that the catalog's option and price may not apply. A gone page refuses as the dead-page check does. Triggered by the PAGE, not only by
// the seller door's `variant_invalid`: a re-read never asks the door, and create and re-read must hand out the same
// link. The door's structured `variant_invalid` is always logged as a refresh hint, switch or no switch.
export const VARIANT_POLICY_FLAG = "AGENT_CHECKOUT_UCP_VARIANT_GONE_POLICY_ENABLED";
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

// A checkout the SELLER priced (ucpMerchantDoorPricing.js) also carries the seller's cart id (`v: 2`, `c`), so a
// re-read asks the seller for THAT cart (`get_cart`) instead of building a new one on every poll. The cart id is
// the seller's opaque handle, handed back only to the seller the re-read rows resolve to — never used to pick one.
//
// BOUND TO THE SELLER THAT ISSUED IT (`h`). A cart id is the issuing seller's bearer handle; a re-read whose rows now
// resolve to a DIFFERENT seller (the row was re-pointed, or the id was forged) must not hand seller A's cart id to
// seller B. On a host mismatch the re-read does not call the seller at all and falls back to the catalog answer.
export function encodeEscalationId(items, cartId, sellerHost) {
  // A chosen variant rides as a third member of its line: [product_id, quantity, variant_id].
  const i = items.map((it) => (it.variant_id ? [it.product_id, it.quantity, it.variant_id] : [it.product_id, it.quantity]));
  const body = cartId !== undefined && cartId !== null ? { v: 2, i, c: cartId, h: sellerHost } : { v: 1, i };
  return ESCALATION_ID_PREFIX + Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function parseEscalationId(id) {
  if (typeof id !== "string" || !id.startsWith(ESCALATION_ID_PREFIX) || id.length > 4096) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(id.slice(ESCALATION_ID_PREFIX.length), "base64url").toString("utf8"));
  } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  if (parsed.v === 2
    ? (!isCarriableCartId(parsed.c) || typeof parsed.h !== "string" || !/^[a-z0-9.-]{1,253}$/.test(parsed.h))
    : (parsed.v !== 1 || own(parsed, "c") !== undefined || own(parsed, "h") !== undefined)) return null;
  return parsed;
}

/** The seller cart id a seller-priced escalation id carries, or undefined. */
export function escalationCartIdOf(id) {
  const parsed = parseEscalationId(id);
  return parsed && parsed.v === 2 && decodeEscalationId(id) ? parsed.c : undefined;
}

/** The seller host a seller-priced escalation id is bound to, or undefined. */
export function escalationSellerHostOf(id) {
  const parsed = parseEscalationId(id);
  return parsed && parsed.v === 2 && decodeEscalationId(id) ? parsed.h : undefined;
}

export function decodeEscalationId(id) {
  const parsed = parseEscalationId(id);
  if (!parsed || !Array.isArray(parsed.i) || parsed.i.length === 0 || parsed.i.length > MAX_ESCALATION_ITEMS) return null;
  const items = [];
  for (const entry of parsed.i) {
    if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3)) return null;
    const [product_id, quantity, variant_id] = entry;
    if (!str(product_id) || !Number.isSafeInteger(quantity) || quantity < 1) return null;
    if (entry.length === 3) {
      // The same rule as a line's item.id: the variant must survive a round trip through the composite id.
      const reparsed = typeof variant_id === "string" ? parseUcpItemId(encodeUcpVariantItemId(product_id.trim(), variant_id)) : null;
      if (!reparsed || reparsed.variant_id !== variant_id || reparsed.product_id !== product_id.trim()) return null;
      items.push({ product_id: product_id.trim(), quantity, variant_id });
    } else {
      items.push({ product_id: product_id.trim(), quantity });
    }
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

// EXPORTED (as `readCheckoutRows`) for the Reap agentic lane (ucpReapAgenticLane.js), which classifies the SAME
// rows through the SAME per-call memoizing executor view — so a cart the Reap lane declines and this module then
// escalates is still read ONCE, and both lanes judge the one read.
export async function readCheckoutRows(items, executor, ctx, opts) {
  return readRows(items, executor, ctx, opts);
}

async function readRows(items, executor, ctx, { timeoutMs = DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS, merchantId } = {}) {
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
        // SCOPED to a merchant when the caller named one (the native door's quote always does) — the same read the
        // checkout resolver performs. For a seed-supply merchant the gateway dispatcher answers it from the canonical
        // unscoped detail; assertProductIdentity (product id, and merchant id when the row names one) is the guard.
        const product = merchantId ? { product_id, merchant_id: merchantId } : { product_id };
        const result = await executor.execute("get_product", { payload: { product } }, { ...ctx, signal: controller.signal });
        assertProductIdentity(result, product_id, merchantId);
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

// ---- THE MERCHANT-PURCHASABILITY GATE (path 2 of 3) --------------------------------------------------------
//
// WHAT THIS PATH OFFERS. `buildEscalationCheckout` answers `status: "requires_escalation"` with the observed
// merchant's storefront as `continue_url`, and the UCP spec obliges the platform to USE that URL.
// `payment_handlers: {}` says Pivota collects no instrument, which is true and is not the point: the shopper
// is still being sent to a checkout that may take no card at all. flowerbeauty.com, 2026-09-22: readable by
// machines, PayPal-only at the till, and USD 8.00 against our indexed USD 14.95. A handoff URL is still a
// recommendation (docs/merchant-purchasability-gate.md §8).
//
// WHAT THE GATE DOES HERE. When the switch is on AND the backend is enforcing AND it says `browse_only` for
// this merchant × market, this module does NOT answer with the storefront checkout. It returns `null` — which
// is EXACTLY what it already returns for a row that is not eligible for a continue_url (`escalating === 0`,
// the contracted/kernel-path case) — and records the decline in the caller's `declines`, so callTool can refuse
// the cart by name (`merchant_not_purchasable`, see refuseUnservedStorefrontCheckout) instead of handing an
// observed seller's row to a kernel that cannot price it. The URL is never built into a response that is then
// edited; the decision is taken before `buildEscalationCheckout` is called at all.
//
// ⚠️ THE DOC SAID NO MARKET REACHES THIS MODULE. That is true of `params` and FALSE of `ucpArgs`.
// `commerceToolSurface.callTool` hands this function BOTH: `params` (post-allowlist — `QUOTE_KEYS` really has
// no market, and `mapQuote` really does drop `checkout.context`) and `ucpArgs`, the RAW UCP wire body, which
// carries `checkout.context.address_country` — the field this repo's own UCP tool descriptions call "buyer
// market, ISO 3166-1 alpha-2" (ucpArgumentAdapter.js). So the request's own market IS reachable, without any
// new plumbing and without a default.
//
// ⚠️ AND IT IS THE ONLY MARKET TAKEN. `quote.shipping_address.country` is also in scope and is deliberately
// NOT read: it is a field of a BUYER'S POSTAL ADDRESS, and no buyer data may reach the ops query or the logs.
// `checkout.context` is a destination HINT that is forwarded into nothing (ucpArgumentAdapter §"context IS NOT
// FORWARDED"), which is why it is safe to key on. A cart with no `address_country` has no fact to read: the
// client logs `merchant_purchasability_unkeyable` and, when the backend is ENFORCING, answers `offer: false`
// (`source: 'unkeyable_enforced'`, backend #2352) — taken below exactly as a `gate` decline; unenforced, the
// previous behaviour. The same rule the warm-handoff seam follows. `servedMarkets.primaryMarket()` — the deployment's market — is NOT
// an acceptable substitute and is in the mutant sweep.

/** The buyer market this UCP checkout request carries, or null. Never a default, never buyer address data. */
export function escalationBuyerMarket(ucpArgs) {
  const context = own(own(ucpArgs, "checkout"), "context");
  const raw = str(own(context, "address_country"));
  if (!raw || !/^[A-Za-z]{2}$/.test(raw)) return null;
  return raw.toUpperCase();
}

export const ESCALATION_GATE_MAX_MS = 800;

/**
 * `true` when this door may still answer with `continueUrl`. FAILS OPEN by construction: the client never
 * throws and never refuses on a failure, `offer: false` is reachable only from a 200 + enforcing answer (a
 * browse_only fact, or no market to key one on), and the `=== false` compare is strict so a malformed future
 * answer cannot refuse by accident.
 */
async function mayOfferStorefrontCheckout(continueUrl, market, gate, gateEnabled, budgetMs) {
  // THE SWITCH, READ HERE TOO. The client checks it as well, but a door on the checkout critical path
  // should not pay for a call whose answer is "disabled" — and this makes "the switch is ignored on THIS
  // path" a mutant that a test can kill without touching the client every other lane shares.
  if (!gateEnabled) return true;
  // The SELLER's domain — a Pivota attribution hop decoded to its destination — never api.pivota.cc: asking the gate
  // about Pivota's own host is asking about nobody. A link whose seller cannot be read keeps the previous key.
  // A link whose seller cannot be read is asked about NO domain (the gate's own unkeyable path: a decline only once
  // the backend is KNOWN to enforce, the previous behaviour otherwise) — never about api.pivota.cc or a redirector.
  // The continue_url is followed by a PERSON who pays on the storefront: the human question (client rule 7).
  return mayOfferPurchaseForDomain(sellerHostOf(continueUrl), market, gate, gateEnabled, budgetMs, merchantPurchasability.RAIL.human);
}

/**
 * The same seam, keyed on a merchant DOMAIN the caller already holds rather than on a storefront URL. It is
 * what `mayOfferStorefrontCheckout` above delegates to, and it is EXPORTED so the Reap agentic lane
 * (ucpReapAgenticLane.js) consults the gate exactly as this lane does — same switch, same singleton client,
 * same fail-open rule, same budget clamp — rather than growing a second copy of the rule.
 */
export async function mayOfferPurchaseForDomain(domain, market, gate, gateEnabled, budgetMs, rail) {
  if (!gateEnabled) return true;
  // The DOMAIN is the storefront host, never the full continue_url: the ops query carries a merchant domain
  // and a two-letter market and nothing else. A path or query string from the storefront URL would be a
  // third value on the wire, and it is in the mutant sweep.
  // AND IT FAILS OPEN ON A THROW TOO. The client does not throw — but this door sits on the checkout
  // critical path, and a gate that turns its own bug into a refused checkout is the second fail-closed
  // layer rule 4 exists to forbid. A throwing gate is in the mutant sweep.
  let decision = null;
  try {
    decision = await gate({
      domain,
      market: market || undefined,
      // ⚠️ BOUNDED BY WHAT IS LEFT OF THE DOOR'S OWN WINDOW. The first cut passed nothing, so this
      // BLOCKING read on the checkout critical path ran on the client's 1500 ms default while the
      // door it sits in had already spent part of its `timeoutMs` reading rows — an unbudgeted
      // addition to a synchronous checkout call. Same clamp as the warm-handoff seam: what is left,
      // capped again by this door's own ceiling, and below the client's floor the gate is SKIPPED
      // (`source: 'skipped_budget'`, previous behaviour) rather than attempted and timed out.
      budgetMs: Math.min(Math.max(0, budgetMs), ESCALATION_GATE_MAX_MS),
      // WHICH QUESTION (client rule 7): the escalation lane hands a human a storefront (`RAIL.human`); the
      // Reap lane charges a card headlessly (`RAIL.card`). Unnamed is the card rail, the stricter answer.
      rail: merchantPurchasability.normalizeRail(rail),
    });
  } catch {
    return true;
  }
  return !(decision && decision.offer === false);
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
export function buildEscalationCheckout({ id, items, rows, continueUrl, buyerEmail, now, env = process.env, extraMessages = [] }) {
  const lineItems = [];
  let subtotal = 0;
  let currency = null;
  items.forEach((it, idx) => {
    const row = rows.get(it.product_id);
    // A CHOSEN variant shows its own catalog price when it states one, else the product's (the catalog's last
    // observed price for the product, as before); its label joins the title and its composite id is the line's.
    const variant = it.variant_id ? findRealVariant(row, it.variant_id) : null;
    // A variant the row no longer has (removed since the id was minted, or an id nobody minted — esc_ ids are not
    // signed) is not rendered at the product's price under the variant's id: there is no such checkout.
    if (it.variant_id && !variant) {
      throw new PivotaCommerceError("QUOTE_NOT_FOUND", { reason: "ucp_escalation_row_changed", dialect: "ucp" });
    }
    const variantPrice = variant ? variantPriceOf(variant, row) : undefined;
    const price = variantPrice || priceOf(row);
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
    const baseTitle = str(row.title) || str(row.brand) || it.product_id;
    const label = variant ? variantLabelOf(variant) : null;
    lineItems.push({
      id: `li_${idx + 1}`,
      item: compact({
        id: it.variant_id ? encodeUcpVariantItemId(it.product_id, it.variant_id) : it.product_id,
        title: label ? `${baseTitle} — ${label}` : baseTitle,
        price: price.amount,
        image_url: image,
      }),
      quantity: it.quantity,
      totals: [
        { type: "subtotal", amount: lineTotal },
        { type: "total", amount: lineTotal },
      ],
    });
  });

  const host = sellerHostOf(continueUrl);
  const where = host ? `the seller's own storefront (${host})` : "the seller's own storefront (continue_url)";
  return buildUcpCheckoutEnvelope({
    id,
    status: "requires_escalation",
    continueUrl,
    currency,
    lineItems,
    totals: [
      { type: "subtotal", amount: subtotal, display_text: "Expected subtotal (catalog's last observed price)" },
      { type: "total", amount: subtotal, display_text: "Expected total before the seller's shipping and tax" },
    ],
    buyerEmail,
    expiresAt: new Date(now + ESCALATION_TTL_MS).toISOString(),
    env,
    messages: [
      {
        type: "info",
        code: "checkout.completes_on_seller_storefront",
        path: "$.continue_url",
        content: [
          `This purchase completes on ${where} — Pivota has no contract, payment or fulfillment relationship with this seller and does not price, charge or ship this checkout.`,
          "Totals are the catalog's last observed prices for these items and may differ on the storefront; verify there before paying.",
          "This checkout cannot be updated or completed here; change items or pay on the storefront.",
        ].join(" "),
        content_type: "plain",
      },
      ...extraMessages,
    ],
  });
}

/**
 * THE CHECKOUT OBJECT, shared. Every UCP checkout this door answers WITHOUT the kernel — the storefront
 * escalation above and the Reap agentic lane (ucpReapAgenticLane.js) — is built here, so the pinned required
 * members (`ucp`, `id`, `line_items`, `status`, `currency`, `totals`, `links`), the `payment_handlers: {}`
 * statement (Pivota collects no instrument on either lane) and the legal links are ONE definition. Member order
 * is the order `buildEscalationCheckout` always emitted, so that lane's bytes do not move. Pure; optional
 * members that are null/undefined are omitted, never published as null.
 */
export function buildUcpCheckoutEnvelope({ id, status, continueUrl, currency, lineItems, totals, buyerEmail, expiresAt, messages, env = process.env }) {
  const links = [{ type: "terms_of_service", url: TERMS_URL, title: "Pivota Terms of Service" }];
  const privacy = str(env && env.PIVOTA_PRIVACY_POLICY_URL);
  if (privacy && /^https:\/\//.test(privacy)) links.unshift({ type: "privacy_policy", url: privacy, title: "Pivota Privacy Policy" });

  return compact({
    ucp: { version: UCP_RESPONSE_VERSION, status: "success", payment_handlers: {} },
    id,
    status,
    continue_url: continueUrl,
    currency,
    line_items: lineItems,
    totals,
    buyer: buyerEmail ? { email: buyerEmail } : undefined,
    links,
    expires_at: expiresAt,
    messages,
  });
}

/**
 * The escalation checkout when the SELLER priced it (ucpMerchantDoorPricing.js): the seller's lines, totals,
 * currency and cart continue_url, in the same shared envelope. Still `requires_escalation` — Pivota neither charges
 * nor ships it; the buyer pays on the storefront. Seller message CODES ride as info messages; their text never does.
 */
export function buildSellerPricedCheckout({ id, priced, sellerHost, buyerEmail, now, env = process.env }) {
  const host = sellerHost || hostOf(priced.continueUrl);
  const messages = [
    {
      type: "info",
      code: "checkout.priced_by_seller_storefront",
      path: "$.continue_url",
      content: [
        `Priced by the seller's own storefront (${host}) in a cart built for this checkout; continue_url opens that cart.`,
        "Pivota has no contract, payment or fulfillment relationship with this seller and does not charge or ship this checkout.",
        "Shipping and tax not shown here are added on the storefront. This checkout cannot be updated or completed here; change items or pay on the storefront.",
      ].join(" "),
      content_type: "plain",
    },
    ...priced.sellerMessageCodes.map((code) => ({
      type: "info",
      code: "seller.storefront_message",
      path: "$",
      content: `The seller's storefront reported: ${code}`,
      content_type: "plain",
    })),
  ];
  return buildUcpCheckoutEnvelope({
    id,
    status: "requires_escalation",
    continueUrl: priced.continueUrl,
    currency: priced.currency,
    lineItems: priced.lineItems,
    totals: priced.totals,
    buyerEmail,
    expiresAt: new Date(now + ESCALATION_TTL_MS).toISOString(),
    env,
    messages,
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
export async function tryEscalateUcpCheckout({ op, params, ctx, executor, ucpArgs, attested = {}, now = Date.now(), env = process.env, timeoutMs, shouldOfferPurchase, clock, declines, merchantDoor, storefrontPage, log }) {
  if (!ucpEscalationEnabled(env)) return null;
  const opId = op && op.id;
  // ONE client, ONE cache, ONE switch — the process singleton the warm-handoff seam already uses. A test
  // injects its own `shouldOfferPurchase` so nothing here ever reaches a network or the shared cache.
  const gate = typeof shouldOfferPurchase === "function"
    ? shouldOfferPurchase
    : (args) => merchantPurchasability.getMerchantPurchasabilityClient().shouldOfferPurchase(args);
  const gateEnabled = merchantPurchasability.isGateEnabled(env);
  // HOW MUCH WINDOW THERE IS, AND WHOSE IT ACTUALLY IS — stated precisely, because the first cut's
  // comment claimed more than the code has. `commerceToolSurface.callTool` (line 322) passes NO
  // `timeoutMs`, so in production `doorBudgetMs` is `DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS` (3000) —
  // which is `readRows`' PER-CALL ceiling for the product reads, NOT a deadline on this door. There
  // is no door-wide deadline to clamp to today. So what actually bounds the gate here is
  // `ESCALATION_GATE_MAX_MS` below; the "what is left" arm only bites when a caller passes a real
  // `timeoutMs`, and it is written so that it will when one does. `clock` is injected only by tests.
  const gateClock = typeof clock === "function" ? clock : Date.now;
  const doorStartedAt = gateClock();
  const doorBudgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS;
  const gateBudgetMs = () => doorBudgetMs - (gateClock() - doorStartedAt);
  // The REQUEST's market, from the raw UCP body. Null means no fact can be read: under enforcement, a decline.
  const buyerMarket = escalationBuyerMarket(ucpArgs);
  // A gate decline still returns null (the contract above), but the caller must be able to tell it from "not an
  // escalation cart": both used to fall through to the kernel, and only the second belongs there. `declines` is an
  // optional out-param (like the Reap lane's `hints`); see refuseUnservedStorefrontCheckout below.
  const declined = () => { if (Array.isArray(declines)) declines.push("merchant_not_purchasable"); return null; };

  if (opId === "create_checkout_session") {
    const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
    // Trimmed at the door: memo key, target lookup and the minted id all agree on the same spelling.
    const items = Array.isArray(quote.items)
      ? quote.items.filter((it) => isPlainObject(it) && str(it.product_id)).map((it) => ({ ...it, product_id: str(it.product_id) }))
      : [];
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
    // ONE SELLER PER CHECKOUT, judged on the SELLER, not on the link's host. A stamped row's link is Pivota's
    // attribution hop (`https://api.pivota.cc/r?token=…`), so every hop row used to read as the one "seller"
    // api.pivota.cc and two different sellers could share a checkout whose continue_url sends the buyer to only the
    // first. The seller is the hop's destination (sellerHostOf). In a cart of more than one product, a row whose
    // seller cannot be read cannot be proven to share a seller with the rest: refused, never assumed.
    const { hosts, unconfirmed, oneSeller } = sellerGroupingOf(targets);
    if (!oneSeller) {
      throw intakeRefusal("QUOTE_REQUIRED", "ucp_multi_seller_escalation", [
        "These items complete on different sellers' storefronts (or on a storefront that cannot be confirmed) and cannot share one checkout.",
        `Send one checkout per seller${hosts.size ? `: ${[...hosts].join(", ")}` : ""}.`,
      ].join(" "), compact({ seller_hosts: [...hosts], unconfirmed_seller_items: unconfirmed.length ? unconfirmed : undefined }));
    }
    const normalized = items.map((it) => (str(it.variant_id)
      ? { product_id: it.product_id, quantity: it.quantity, variant_id: str(it.variant_id) }
      : { product_id: it.product_id, quantity: it.quantity }));
    // THE LINK HANDED OUT for a one-seller cart: a row's Pivota attribution hop when any row carries one (the hop
    // records the click and its destination carries the referral `carryAttribution` copies), else the first row's.
    // Taking the first row's link regardless dropped Pivota's attribution whenever a direct link happened to come
    // first in a cart that also held a hop to the same seller.
    const continueUrl = handedOutLinkOf(normalized.map((it) => targets.get(it.product_id)));
    // THE EXPECTED SELLER, AGAIN, ON THE LINK ITSELF (docs/reap-agentic-lane.md §5.4). The door has already
    // refused a create whose rows are not that seller (ucpReapAgenticLane.js `assertExpectedSeller`); this is
    // belt and braces on the one value this lane hands the buyer: a continue_url whose host is not the expected
    // seller — or a hop that cannot be confirmed — is REFUSED, never handed out.
    const expectedSeller = reapExpectedMerchantDomain(ucpArgs);
    if (expectedSeller !== undefined) {
      const verdict = judgeSellerUrl(expectedSeller, continueUrl);
      if (!verdict.ok) {
        throw sellerMismatchRefusal({ cause: verdict.cause, merchantDomain: verdict.cause === "different_seller" ? verdict.host : null });
      }
    }
    // THE SEAM, BEFORE THE CHECKOUT IS BUILT. `null` = "not an escalation cart", which is the answer this
    // function already gives for every row that is not eligible for a continue_url. See the note above
    // `mayOfferStorefrontCheckout`. Single-seller by the check above, so this is ONE read per checkout.
    if (!(await mayOfferStorefrontCheckout(continueUrl, buyerMarket, gate, gateEnabled, gateBudgetMs()))) return declined();
    const buyerEmail = attestedEmailOrBody(attested, quote.customer_email);
    // THE SELLER PRICES IT, when its door can (ucpMerchantDoorPricing.js; own switch, default OFF). Null = fall back
    // to the catalog answer below, unchanged. Asked only AFTER the gate and the expected-seller check, so a seller
    // this door will not offer is never contacted.
    const sellerHost = sellerHostOf(continueUrl);
    const doorSignals = [];
    const priced = await priceOnMerchantDoor({
      items: normalized, rows, sellerHost, discoveryHost: sellerHostnameOf(continueUrl), catalogLink: continueUrl,
      expectedSeller, market: buyerMarket, env, merchantDoor, log, signals: doorSignals,
    });
    if (priced) {
      // An id this door could not read back (a host outside the id's host alphabet) would make every poll an unknown
      // id: such a cart is not offered at all, and the catalog answer below is given instead.
      const id = encodeEscalationId(normalized, priced.cartId, sellerHost);
      if (escalationCartIdOf(id) === priced.cartId) {
        return buildSellerPricedCheckout({ id, priced, sellerHost, buyerEmail, now, env });
      }
    }
    const checked = await checkStorefrontPages({
      items: normalized, links: normalized.map((it) => targets.get(it.product_id)), rows, continueUrl,
      env, storefrontPage, log, doorSignals,
    });
    return buildEscalationCheckout({
      id: encodeEscalationId(normalized),
      items: normalized,
      rows,
      continueUrl: checked.continueUrl,
      extraMessages: checked.messages,
      // ATTESTED WINS, exactly as intake rule 1: the verified session's email displaces any body value, and a
      // body value is only ever echoed after normalizeEmail. `buyer.email` is what a platform pre-fills on
      // the storefront, so a body-supplied address displacing a signed-in buyer's is the misdirection rule 1
      // exists to stop (review of #2025). UNLIKE a Pivota quote, an email is OPTIONAL here — `buyer` is an
      // optional member of the checkout and the storefront collects its own — so nothing is refused for its
      // absence (resolveBuyerEmail would; this is the same precedence without the throw).
      buyerEmail,
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
    // ONE SELLER, AGAIN, on the re-read: a row re-pointed to another seller since create (or an id nobody minted —
    // esc_ ids are unsigned) must not come back as one checkout whose continue_url reaches only the first seller.
    if (!sellerGroupingOf(new Map(decoded.map((it, i) => [it.product_id, targets[i]]))).oneSeller) {
      throw new PivotaCommerceError("QUOTE_NOT_FOUND", { reason: "ucp_escalation_row_changed", dialect: "ucp" });
    }
    // The same seam on the re-read, deliberately symmetrical: the UCP `get_checkout` wire body carries no
    // `checkout.context`, so this lane is always `unkeyable`. Unenforced that keeps the previous behaviour;
    // under ENFORCEMENT it is a decline (`unkeyable_enforced`) and the re-read falls through like the create
    // does — so arming the gate with escalation on needs a market carrier on this lane first (see
    // docs/merchant-purchasability-gate.md §8). An asymmetry here would be a purchase offered on no fact.
    // The SAME link create handed out (handedOutLinkOf): a re-read must not swap Pivota's hop for a direct link.
    const link = handedOutLinkOf(targets);
    if (!(await mayOfferStorefrontCheckout(link, buyerMarket, gate, gateEnabled, gateBudgetMs()))) return declined();
    // A seller-priced checkout is re-read from the SELLER's cart (`get_cart` on the id's cart), never re-created.
    // The seller is the one the re-read rows resolve to; a cart the seller no longer answers for falls back to the
    // catalog answer, which says so.
    const cartId = escalationCartIdOf(sessionId);
    const sellerHost = sellerHostOf(link);
    if (cartId !== undefined && sellerHost && escalationSellerHostOf(sessionId) === sellerHost) {
      const priced = await priceOnMerchantDoor({
        items: decoded, rows, sellerHost, discoveryHost: sellerHostnameOf(link), catalogLink: link,
        market: buyerMarket, cartId, env, merchantDoor, log,
      });
      if (priced) return buildSellerPricedCheckout({ id: sessionId, priced, sellerHost, now, env });
    }
    const checked = await checkStorefrontPages({ items: decoded, links: targets, rows, continueUrl: link, env, storefrontPage, log });
    return buildEscalationCheckout({
      id: sessionId, items: decoded, rows, continueUrl: checked.continueUrl, now, env, extraMessages: checked.messages,
    });
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

// ---- the storefront rows nothing above served ------------------------------------------------------------------
//
// THE KERNEL CANNOT SELL A STOREFRONT ROW. Its one pricing engine needs a merchant connected to Pivota, and a row
// with an escalation target is, by the classification above, a seller Pivota has no such relationship with. Before
// this, a storefront row that escalation did not answer (the switch off, or the purchasability gate declining) fell
// through to the kernel, where it was refused for want of variant identity or, past intake, came back from the
// backend as a 422 the gateway maps to MERCHANT_UNAVAILABLE — `retriable: true`, "try again shortly", for a
// checkout that can never succeed. Agents retried it.
//
// So callTool calls this AFTER every lane that can answer a storefront row (Reap, then escalation) and BEFORE intake
// and the kernel. A cart with no storefront row returns undefined and takes the kernel path exactly as before; a cart
// with one is refused here, terminally, by name:
//   - `ucp_storefront_checkout_unavailable` (OPERATION_NOT_ALLOWED): this door does not check these items out. The
//     detail names the items and their seller hosts, and — only while the purchasability gate is not armed — their
//     storefront pages (the row's `external_redirect_url`, which the native product read publishes), so the agent
//     can send the buyer there. Raised for a create, and for an update of a kernel session that names such a row.
//   - `merchant_not_purchasable` (NO_MERCHANT_OFFER): the purchasability gate declined this seller for this market.
//     No storefront page is handed out: the gate exists to stop recommending that checkout.
// An escalation id this door did not answer is refused rather than sent to the kernel as an unknown session id:
// `ucp_storefront_checkout_unavailable` with the switch off, `ucp_escalation_reread_unconfirmed` on a gate decline
// (a re-read carries no market, so the decline says nothing about the seller).
//
// It reads through the SAME per-call memoizing executor view as the lanes before it, so a cart they already read is
// not read again. No flag: it only replaces a refusal with a truthful one, and never opens anything.

/**
 * Refuse a UCP checkout op that carries storefront rows no lane served. Returns undefined when the kernel path should
 * run. @param {{ op:{id:string}, params:object, ctx:object, executor:{execute:Function}, declined?:boolean, timeoutMs?:number }} a
 */
export async function refuseUnservedStorefrontCheckout({ op, params, ctx, executor, declined = false, timeoutMs, env = process.env, merchantId, failOpen = false }) {
  const opId = op && op.id;
  const sessionId = str(own(params, "session_id"));
  if (opId !== "create_checkout_session" && sessionId && decodeEscalationId(sessionId)) {
    if (declined) {
      // A decline on a RE-READ is not a fact about the seller: UCP `get_checkout` carries no market, so under
      // enforcement every re-read is unkeyable and declines — including a checkout that passed the gate at create.
      // Say what is true (no market to confirm against), not "this seller is not purchasable".
      throw intakeRefusal("OPERATION_NOT_ALLOWED", "ucp_escalation_reread_unconfirmed",
        "This storefront checkout cannot be re-confirmed here: get_checkout carries no buyer market to check the seller against. Retrying will not change this; use the continue_url from the create, or create a new checkout with checkout.context.address_country.",
        {});
    }
    throw intakeRefusal("OPERATION_NOT_ALLOWED", "ucp_storefront_checkout_unavailable",
      "This checkout completes on the seller's own storefront, and this door no longer answers it. Retrying will not change this; send the buyer to the product's storefront page.",
      {});
  }
  // create, and update of a session that is not an escalation id: both carry the cart (`quote.items`), and the
  // kernel would re-price whatever rows it names. No lane serves an update of a kernel session, so a storefront row
  // in one is refused here whatever the escalation switch says.
  if (opId !== "create_checkout_session" && opId !== "update_checkout_session") return undefined;
  const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
  const items = Array.isArray(quote.items)
    ? quote.items.filter((it) => isPlainObject(it) && str(it.product_id)).map((it) => ({ ...it, product_id: str(it.product_id) }))
    : [];
  // The carts intake refuses on shape alone (empty, oversized, too many distinct products, a bad quantity) are left
  // to intake, so they keep intake's own message and detail; a storefront row inside one is refused there too.
  if (items.length === 0 || items.length > MAX_ESCALATION_ITEMS) return undefined;
  if (new Set(items.map((it) => it.product_id)).size > MAX_CART_DISTINCT_PRODUCTS) return undefined;
  if (items.some((it) => !Number.isSafeInteger(it.quantity) || it.quantity < 1)) return undefined;
  // `failOpen` (the native door): a read that fails is NOT this check's refusal to give — that door's checkout ran
  // without this read before, so only a POSITIVE storefront classification refuses; anything else proceeds as it did.
  let rows;
  try {
    rows = await readRows(items, executor, ctx, { timeoutMs, merchantId });
  } catch (err) {
    if (failOpen) return undefined;
    throw err;
  }
  const targets = new Map();
  for (const [pid, row] of rows) {
    const target = escalationTargetOf(row);
    if (target) targets.set(pid, target);
  }
  if (targets.size === 0) return undefined; // kernel path (contracted rows)
  // LINKS ONLY WHERE NO GATE COULD HAVE SAID NO. With the purchasability gate armed but escalation off, nothing
  // asked the gate about this seller, so handing out its storefront link would recommend a checkout the gate may
  // exist to stop (a PayPal-only till). Fail closed: hosts yes, links no.
  const linksAllowed = !declined && !merchantPurchasability.isGateEnabled(env);
  throw storefrontRefusal(declined, [...targets.keys()], targets, linksAllowed);
}

// ---- the dead-page check ---------------------------------------------------------------------------------------

export function deadPageCheckEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[DEAD_PAGE_CHECK_FLAG]) || "").trim());
}

/** Where a row's link lands: a Pivota hop's destination (one hop), else the link itself. Null when unreadable. */
function landingUrlOf(link) {
  let parsed;
  try { parsed = new URL(link); } catch { return null; }
  const hop = pivotaHopDestination(parsed);
  if (!hop) return parsed.toString();
  return hop.dest && /^https:\/\//i.test(hop.dest) ? hop.dest : null;
}

function emitPageCheck(log, level, detail) {
  if (log && typeof log[level] === "function") {
    try { log[level]({ event: "ucp_storefront_page_check", ...detail }); } catch { /* never throw the door */ }
  }
}

export function variantPolicyEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[VARIANT_POLICY_FLAG]) || "").trim());
}

/** The numeric seller variant id a line will land on: the row's own seller variant, else the link's one `variant=`. */
function landingVariantOf(row, link, landing, chosenVariantId) {
  const gid = sellerVariantGidOf(row, sellerHostOf(link), chosenVariantId);
  const fromGid = gid ? (String(gid).match(/(\d+)$/) || [])[1] : null;
  if (fromGid || chosenVariantId) return fromGid || null;
  try {
    const values = new URL(landing).searchParams.getAll("variant");
    return values.length === 1 && /^\d{1,20}$/.test(values[0]) ? values[0] : null;
  } catch { return null; }
}

/** The link with its `variant=` removed, when it is a DIRECT link to one of these product pages; else unchanged. */
function withoutStaleVariant(link, landings) {
  if (isReadablePivotaHop(link)) return link; // a signed hop's destination cannot be edited here
  const page = storefrontProductPageModule.productPageOf(link);
  if (!page || !landings.some((l) => { const p = storefrontProductPageModule.productPageOf(l); return p && p.jsonUrl === page.jsonUrl; })) return link;
  const url = new URL(link);
  if (!url.searchParams.has("variant")) return link;
  url.searchParams.delete("variant");
  return url.toString();
}

/**
 * The storefront page check on a catalog-priced checkout (create and re-read alike). `links[i]` is the row link for
 * `items[i]`. Returns the continue_url to hand out and any messages to add; throws a named refusal. With both
 * switches OFF it reads nothing and returns `continueUrl` unchanged (a door `variant_invalid` is still logged).
 */
async function checkStorefrontPages({ items, links, rows, continueUrl, env, storefrontPage, log, doorSignals = [] }) {
  const unchanged = { continueUrl, messages: [] };
  const doorSaid = doorSignals.some((sig) => sig && sig.reason === "variant_invalid");
  const checkPages = deadPageCheckEnabled(env);
  const checkVariants = variantPolicyEnabled(env);
  if (!checkPages && !checkVariants) {
    if (doorSaid) emitPageCheck(log, "info", { outcome: "not_checked", reason: "door_variant_invalid", product_ids: items.map((it) => it.product_id) });
    return unchanged;
  }
  const read = typeof storefrontPage === "function"
    ? storefrontPage
    : (url) => storefrontProductPageModule.readStorefrontProductPage(url, { timeoutMs: DEAD_PAGE_CHECK_BUDGET_MS });
  const lines = await Promise.all(items.map(async (it, idx) => {
    const landing = landingUrlOf(links[idx]);
    if (!landing) return null;
    try { return { it, link: links[idx], landing, page: await read(landing) }; } catch { return null; }
  }));

  const gone = lines.filter((l) => l && l.page && l.page.state === "gone");
  if (gone.length) {
    const productIds = [...new Set(gone.map((l) => l.it.product_id))];
    const hosts = [...new Set(gone.map((l) => l.page.host).filter(Boolean))];
    emitPageCheck(log, "info", {
      outcome: "refused", reason: "storefront_product_gone", door_variant_invalid: doorSaid,
      seller_hosts: hosts, product_ids: productIds,
      // The refresh hint: which store handles to re-verify. No buyer data.
      handles: gone.map((l) => l.page.handle).filter(Boolean),
    });
    throw goneRefusal(productIds, hosts);
  }
  if (!checkVariants) {
    if (doorSaid) emitPageCheck(log, "info", { outcome: "not_checked", reason: "door_variant_invalid", product_ids: items.map((it) => it.product_id) });
    return unchanged;
  }

  const chosenGone = [];
  const impliedGone = [];
  for (const l of lines) {
    if (!l || !l.page || l.page.state !== "live" || !(l.page.variantIds instanceof Set)) continue;
    const variant = landingVariantOf(rows.get(l.it.product_id), l.link, l.landing, l.it.variant_id);
    if (!variant || l.page.variantIds.has(variant)) continue;
    // A CHOSEN variant is refused only on TWO witnesses: the store's page does not list it AND the seller's own door
    // said `variant_invalid`. The page alone cannot tell a discontinued option from a catalog that stored a barcode
    // where the variant id belongs (see ucpMerchantDoorPricing ownVariantIdGid), and a refusal there would stop the sale
    // of a product the store does sell; such a line gets the warning instead.
    (l.it.variant_id && doorSaid ? chosenGone : impliedGone).push({ ...l, variant });
  }
  const stale = [...chosenGone, ...impliedGone];
  if (stale.length || doorSaid) {
    emitPageCheck(log, "info", {
      outcome: chosenGone.length ? "refused" : (stale.length ? "variant_dropped" : "variant_listed"),
      reason: stale.length ? "storefront_variant_gone" : "door_variant_invalid",
      door_variant_invalid: doorSaid,
      seller_hosts: [...new Set(lines.filter(Boolean).map((l) => l.page && l.page.host).filter(Boolean))],
      product_ids: (stale.length ? stale.map((l) => l.it.product_id) : items.map((it) => it.product_id)),
      // The refresh hint: the store handle and the variant id the catalog still names.
      stale_variants: stale.map((l) => ({ handle: l.page.handle, variant: l.variant })),
    });
  }
  if (chosenGone.length) {
    const ids = chosenGone.map((l) => encodeUcpVariantItemId(l.it.product_id, l.it.variant_id));
    const hosts = [...new Set(chosenGone.map((l) => l.page.host).filter(Boolean))];
    throw intakeRefusal("NO_MERCHANT_OFFER", "ucp_storefront_variant_gone", [
      `The seller's storefront${hosts.length ? ` (${hosts.join(", ")})` : ""} no longer sells the chosen option of these items: ${ids.join(", ")}.`,
      "This will not change on retry; offer the buyer the product's other options or alternatives.",
    ].join(" "), compact({ storefront_items: ids, seller_hosts: hosts.length ? hosts : undefined }));
  }
  if (!impliedGone.length) return unchanged;
  const productIds = [...new Set(impliedGone.map((l) => l.it.product_id))];
  return {
    continueUrl: withoutStaleVariant(continueUrl, impliedGone.map((l) => l.landing)),
    messages: [{
      type: "warning",
      code: "checkout.storefront_variant_not_listed",
      path: "$.continue_url",
      content: [
        `The seller's storefront no longer lists the option the catalog names for: ${productIds.join(", ")}.`,
        "continue_url opens the product page, where the buyer picks from the options the seller sells now; the catalog price above may not apply to them.",
      ].join(" "),
      content_type: "plain",
    }],
  };
}

function goneRefusal(productIds, hosts) {
  const where = hosts.length ? ` (${hosts.join(", ")})` : "";
  return intakeRefusal("NO_MERCHANT_OFFER", "ucp_storefront_product_gone", [
    `The seller's storefront${where} no longer has a product page for these items: ${productIds.join(", ")}.`,
    "This will not change on retry; offer the buyer alternatives.",
  ].join(" "), compact({ storefront_items: productIds, seller_hosts: hosts.length ? hosts : undefined }));
}

// THE SELLER'S HOST, NOT THE LINK'S. A row's storefront link may be Pivota's own attribution hop
// (`https://api.pivota.cc/r?token=…`, see pivotaHopDestination), whose host names Pivota, not the seller. The hop's
// `dest` is where the buyer lands, so that host is named; a hop that cannot be read, or any other Pivota host, names
// nobody rather than naming Pivota as the seller. The link handed out stays the row's own (attribution intact).
function sellerHostOf(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const hop = pivotaHopDestination(parsed);
  // One hop only, as judgeSellerUrl: a `dest` that is itself a Pivota host (another hop) names nobody.
  let dest = parsed;
  if (hop) {
    if (!hop.dest || !/^https:\/\//i.test(hop.dest)) return null;
    try { dest = new URL(hop.dest); } catch { return null; }
  }
  // A destination that carries ANOTHER URL (an affiliate redirector: `…/deeplink?murl=https://seller…`) does not
  // end at its own host, so its host is not the seller — the same rule judgeSellerUrl and the merchant-door
  // pricing apply. It names nobody; two such links are never "the same seller".
  if (carriesAnotherUrl(dest)) return null;
  const host = hostOf(dest.toString());
  return host && !SELF_HOST_RE.test(host) ? host : null;
}

/**
 * THE LINK HANDED OUT for a one-seller cart, given its rows' links in line order — ONE rule for create and re-read:
 * a row's Pivota attribution hop when any row carries a readable one (the hop records the click and its destination
 * carries the referral `carryAttribution` copies), else the first row's link.
 */
function handedOutLinkOf(links) {
  return links.find(isReadablePivotaHop) || links[0];
}

/** A Pivota attribution hop whose destination this door can read. */
function isReadablePivotaHop(url) {
  try { const hop = pivotaHopDestination(new URL(url)); return Boolean(hop && hop.dest); } catch { return false; }
}

/**
 * One seller per checkout, judged on the SELLER (sellerHostOf), for a map of product id -> storefront link.
 * `oneSeller` is false when two sellers are named, or when a cart of MORE than one product holds a row whose seller
 * cannot be read (it cannot be proven to share a seller with the rest). Hosts are compared after `www.` is dropped;
 * a subdomain is a DIFFERENT seller here (fail closed, as canonicalReapMerchantDomain treats it), although a seller
 * cart URL on a subdomain is accepted by the merchant-door pricing, which already knows the seller.
 */
function sellerGroupingOf(targets) {
  const sellerOf = new Map([...targets.entries()].map(([pid, t]) => [pid, sellerHostOf(t)]));
  const hosts = new Set([...sellerOf.values()].filter(Boolean));
  const unconfirmed = [...sellerOf.entries()].filter(([, h]) => !h).map(([pid]) => pid);
  return { hosts, unconfirmed, oneSeller: !(hosts.size > 1 || (sellerOf.size > 1 && unconfirmed.length > 0)) };
}

/** The storefront's own hostname (`www.` KEPT, lower-cased) behind a catalog link, hop decoded; null otherwise. */
function sellerHostnameOf(url) {
  if (!sellerHostOf(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const hop = pivotaHopDestination(parsed);
  try { return (hop ? new URL(hop.dest) : parsed).hostname.toLowerCase(); } catch { return null; }
}

function storefrontRefusal(declined, productIds, targets, linksAllowed) {
  const hosts = [...new Set([...targets.values()].map(sellerHostOf).filter(Boolean))];
  const named = productIds.length ? ` (${productIds.join(", ")})` : "";
  const where = hosts.length ? ` on ${hosts.join(", ")}` : "";
  if (declined) {
    return intakeRefusal("NO_MERCHANT_OFFER", "merchant_not_purchasable", [
      `Purchase is not offered for these items${named}: their seller cannot currently be checked out by an agent in this market.`,
      "This will not change on retry; offer the buyer alternatives.",
    ].join(" "), compact({ storefront_items: productIds.length ? productIds : undefined, seller_hosts: hosts.length ? hosts : undefined }));
  }
  return intakeRefusal("OPERATION_NOT_ALLOWED", "ucp_storefront_checkout_unavailable", [
    `These items${named} are sold on their seller's own storefront${where}, and this door does not check them out.`,
    linksAllowed
      ? "Retrying will not change this. Send the buyer to the storefront page in storefront_urls to buy there; items Pivota checks out go in their own checkout."
      : "Retrying will not change this. The buyer can buy on the seller's own site; items Pivota checks out go in their own checkout.",
  ].join(" "), compact({
    storefront_items: productIds.length ? productIds : undefined,
    seller_hosts: hosts.length ? hosts : undefined,
    storefront_urls: linksAllowed && targets.size ? Object.fromEntries(targets) : undefined,
  }));
}

// ---- a chosen variant must be one of the product's --------------------------------------------------------------
//
// A UCP line may name a variant (`<product_id>::v::<variant_id>`, ucpVariantIds.js). The adapter only splits the id;
// HERE, before any lane runs, each named variant is proven to be one of that product's REAL variants on the same
// (memoized) product read every lane uses. Without it a caller could put any string in `variant_id` and have it
// carted at a seller, priced by the kernel, or stamped into an escalation id. Refused by name, terminally.

/** Refuse a UCP create/update whose line names a variant the product does not have. */
export async function assertChosenVariantsBelong({ params, ctx, executor, timeoutMs }) {
  const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
  const chosen = Array.isArray(quote.items)
    ? quote.items.filter((it) => isPlainObject(it) && str(it.product_id) && str(it.variant_id))
    : [];
  if (chosen.length === 0) return;
  const rows = await readRows(chosen.map((it) => ({ product_id: str(it.product_id), quantity: 1 })), executor, ctx, { timeoutMs });
  const unknown = chosen
    .filter((it) => !findRealVariant(rows.get(str(it.product_id)), str(it.variant_id)))
    .map((it) => encodeUcpVariantItemId(str(it.product_id), str(it.variant_id)));
  if (unknown.length) {
    throw intakeRefusal("QUOTE_REQUIRED", "ucp_variant_not_in_product", [
      `These line items name a variant the product does not have: ${unknown.join(", ")}.`,
      "Send a variant id exactly as get_product publishes it in product.variants[].id, or the product id.",
    ].join(" "), { rejected_item_ids: unknown });
  }
}

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
// quantities ONLY, never buyer data (a seller-priced id adds `c`, the seller's own cart id; a create for a market other
// than US adds `m`, and one that named no market adds `a`: see encodeEscalationId). `get_checkout` on such an id re-reads the rows and re-answers; there is
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
// The hand-off record (FIX_PLAN O-02) — CommonJS, shared with the gateway's backend client and get_order read.
import storefrontHandoffRecordModule from "../../src/services/storefrontHandoffRecord.js";
import { carriesAnotherUrl, judgeSellerUrl, pivotaHopDestination, reapExpectedMerchantDomain, sellerMismatchRefusal, SELF_HOST_RE } from "./ucpExpectedSeller.js";
import { priceOnMerchantDoor, isCarriableCartId, sellerVariantChoiceOf, merchantPricingEnabled, sellerDiscountCodesFlagOn, isAcceptableDiscountCode, DISCOUNT_CODE_MAX_LENGTH, trackingPairsFrom } from "./ucpMerchantDoorPricing.js";
import { encodeUcpVariantItemId, findRealVariant, parseUcpItemId, variantLabelOf, variantPriceOf } from "./ucpVariantIds.js";
import { canonicalRequest, requestFingerprint, runIdempotentCart, storeCartIdempotencyEnabled } from "./storefrontCartIdempotency.js";
import { createHmac, timingSafeEqual } from "node:crypto";
// THE NO-MARKET RULE (decision D-10): the same helper the read tools resolve their market through.
import requestMarket from "../../src/services/requestMarket.js";

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

// ---- the buyer's discount code on a storefront checkout ---------------------------------------------------------
//
// THE ONE RULE for "does this door take a discount code for a storefront checkout": the escalation, the seller's own
// pricing AND the code switch (ucpMerchantDoorPricing.js SELLER_DISCOUNT_CODES_FLAG). The argument adapter reads it to
// advertise and accept `checkout.discounts`, the tool list to declare it, and this lane to send the code. Any one
// off, and a code is refused as an unknown field exactly as before (unless the Reap lane's own offer codes are armed).
export function storefrontDiscountCodesEnabled(env = process.env) {
  return ucpEscalationEnabled(env) && merchantPricingEnabled(env) && sellerDiscountCodesFlagOn(env);
}

/** The ONE code the request carries (`checkout.discounts.codes[0]`; the adapter allows at most one), or undefined. */
function buyerDiscountCode(ucpArgs) {
  const codes = own(own(own(ucpArgs, "checkout"), "discounts"), "codes");
  return Array.isArray(codes) && codes.length === 1 && typeof codes[0] === "string" ? codes[0] : undefined;
}

// UCP's own path for the first submitted code; the adapter allows one, so every message about it points here.
export const STOREFRONT_DISCOUNT_CODE_PATH = "$.discounts.codes[0]";

// FIXED TEXT per outcome: the seller's own message text is data and never forwarded, and the code is never echoed
// in prose (it is in `discounts.codes`). `discount_code_*` is UCP's rejection family; the two codes that are not the
// seller's own refusal say that the seller never judged it (`not_evaluated`) or that its answer could not be read as
// applied (`not_confirmed`). Either way the total shown has no discount this door can attribute to the code.
const DISCOUNT_OUTCOME_TEXT = Object.freeze({
  rejected: "The seller's storefront did not apply this code. The total shown is the storefront's own, without it.",
  not_sent_seller_does_not_advertise: "This code was not sent: the seller's storefront does not advertise discount codes over UCP. The total shown has no discount from it; the buyer can try it on the storefront.",
  not_sent_malformed: "This code was not sent: it is not a code the storefront could accept. The total shown has no discount from it.",
  not_priced_by_seller: "This code was not applied: the seller's storefront did not price this checkout, so the totals are the catalog's last observed prices with no discount. The buyer can try it on the storefront.",
  not_confirmed: "The seller's storefront did not confirm this code as applied. Treat the total shown, which is the storefront's own, as the price; the buyer can check the code on the storefront.",
});

function discountOutcomeMessage(outcome) {
  let code = "discount_code_not_confirmed";
  let text = DISCOUNT_OUTCOME_TEXT.not_confirmed;
  if (outcome.status === "rejected") { code = outcome.reason; text = DISCOUNT_OUTCOME_TEXT.rejected; }
  else if (outcome.reason && outcome.reason.startsWith("not_sent_")) { code = "discount_code_not_evaluated"; text = DISCOUNT_OUTCOME_TEXT[outcome.reason] || DISCOUNT_OUTCOME_TEXT.not_confirmed; }
  else if (outcome.reason === "not_priced_by_seller") { code = "discount_code_not_evaluated"; text = DISCOUNT_OUTCOME_TEXT.not_priced_by_seller; }
  return { type: "warning", code, path: STOREFRONT_DISCOUNT_CODE_PATH, content: text, content_type: "plain" };
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
//
// RECORDED (`r`, FIX_PLAN O-02; UCP_STOREFRONT_HANDOFF_RECORD_ENABLED). An id whose hand-off the backend recorded for
// the partner that asked carries that record's id. Nothing here trusts it: get_order sends it to the backend with the
// sha256 of the WHOLE id, and the backend answers only a record stored under that binding, only to its owner
// (src/services/storefrontHandoffRecord.js). Absent unless the record was confirmed, so every other id keeps its bytes.
//
// THE MARKET THE CHECKOUT WAS CREATED FOR (decision D-10). `get_checkout` carries no market on the wire, so the id
// carries it: `m` (ISO-2, US included) whenever the create had a market to key on, plus `a: 1` when the create named
// none and was answered as US, assumed. An id with NO `m` is a LEGACY id -- minted before this change, when every
// market minted the same bytes, or by a create whose market was malformed -- and says nothing about the market: its
// re-read is unkeyable exactly as every re-read was before (under enforcement, a decline). It is never read as US.
// The members are additive: a build without them ignores them (its re-read is unkeyable again, as before).
//
// THE REFERRAL MINTED FOR THE CART (`t`, AGENT_CHECKOUT_UCP_CART_REFERRAL_ENABLED). A cart whose catalog link carried
// no tracking member, and for which the backend minted a referral, carries that referral's tracking members
// (`utm_*`, `pvt_*`: ours, never the seller's and never the buyer's), so a re-read hands out the same attributed
// cart link the create did without minting again. Only on a seller-priced id, only when a referral was minted, so
// every other id keeps its bytes. A build without the member ignores it (its re-read hands out the seller's link).
//
// BOUND TO THE BUYER THAT CREATED IT (`v: 3`, `b`; AGENT_CHECKOUT_STORE_CART_ID_BINDING, see escalationIdReadable
// below). A v1/v2 id is a bearer handle: any verified buyer holding it reads the cart's totals and link. A v3 id is
// the same members plus `b`, an HMAC-SHA256 over those members and the creating buyer's verified reference, under a
// key derived from the kernel's confirmation secret. It is a NEW version on purpose, not a member added to v2: a
// build that does not know v3 reads such an id as no id of ours (the answer for an unknown id), never as an
// unbound one. `bind` is `{ userRef, env }`; without it, or with the switch off, the id is the v1/v2 id it always was.
export function encodeEscalationId(items, cartId, sellerHost, market, recordId, tracking, bind) {
  // A chosen variant rides as a third member of its line: [product_id, quantity, variant_id].
  const i = items.map((it) => (it.variant_id ? [it.product_id, it.quantity, it.variant_id] : [it.product_id, it.quantity]));
  const body = cartId !== undefined && cartId !== null ? { v: 2, i, c: cartId, h: sellerHost } : { v: 1, i };
  const code = isPlainObject(market) && typeof market.code === "string" ? market.code : null;
  if (code && /^[A-Z]{2}$/.test(code)) {
    body.m = code;
    if (market.assumed === true && code === requestMarket.ASSUMED_MARKET) body.a = 1;
  }
  if (recordId !== undefined && recordId !== null) body.r = recordId;
  if (body.v === 2 && trackingPairsFrom(tracking)) body.t = Object.fromEntries(trackingPairsFrom(tracking));
  const binding = isPlainObject(bind) ? idBindingFor(bind.userRef, bind.env) : null;
  if (binding && binding.mode !== ID_BINDING_MODES.off && binding.key && binding.userRef) {
    body.v = 3;
    body.b = bindingMac(body, binding.userRef, binding.key);
  }
  return ESCALATION_ID_PREFIX + Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

function parseEscalationId(id) {
  if (typeof id !== "string" || !id.startsWith(ESCALATION_ID_PREFIX) || id.length > 4096) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(id.slice(ESCALATION_ID_PREFIX.length), "base64url").toString("utf8"));
  } catch { return null; }
  if (!isPlainObject(parsed)) return null;
  // The market members, when present, are exactly what encodeEscalationId writes (a forged one is no id of ours):
  // `m` an upper-case ISO-2 code, `a` only ever 1 and only beside `m: "US"`.
  const m = own(parsed, "m");
  if (m !== undefined && (typeof m !== "string" || !/^[A-Z]{2}$/.test(m))) return null;
  const a = own(parsed, "a");
  if (a !== undefined && (a !== 1 || m !== requestMarket.ASSUMED_MARKET)) return null;
  // v3 = a buyer-bound id: a seller-priced one (`c` and `h`, as v2) or a catalogue one (neither, as v1), plus `b`.
  const priced = parsed.v === 2 || (parsed.v === 3 && (own(parsed, "c") !== undefined || own(parsed, "h") !== undefined));
  if (priced
    ? (!isCarriableCartId(parsed.c) || typeof parsed.h !== "string" || !/^[a-z0-9.-]{1,253}$/.test(parsed.h))
    : ((parsed.v !== 1 && parsed.v !== 3) || own(parsed, "c") !== undefined || own(parsed, "h") !== undefined)) return null;
  if (parsed.v === 3 ? !BINDING_RE.test(String(own(parsed, "b") ?? "")) : own(parsed, "b") !== undefined) return null;
  return parsed;
}

/** Does this parsed id carry a seller's cart (v2, or a bound id with `c`)? */
function isSellerPriced(parsed) {
  return parsed.v === 2 || (parsed.v === 3 && own(parsed, "c") !== undefined);
}

// ---- the buyer binding ---------------------------------------------------------------------------------------------
//
// AGENT_CHECKOUT_STORE_CART_ID_BINDING (read per call): `off` (default, and any other value) | `mint` | `enforce`.
//   off      ids are minted unbound (v1/v2), as before. A v3 id is still verified and read, so turning the switch
//            back off does not strand the checkouts minted while it was on.
//   mint     every new id is bound (v3). Unbound ids are still read: an id carries no mint time, so "until they
//            expire" cannot be checked per id; the six hours an id says it lives are waited out by the operator
//            before `enforce`.
//   enforce  as mint, and an unbound id is no id of ours.
// A bound id presented by ANOTHER verified buyer, with a `b` that does not verify, or when no key can be derived,
// is no id of ours: get, update, complete, cancel, payment link and get_order answer exactly what they answer for
// an id that never existed, so the answer does not say whether it does.
//
// THE KEY. Derived (HMAC, a label of its own) from CONFIRMATION_SECRET, the kernel's secret for the confirmation
// tokens these same doors mint; strict checkout does not boot without a strong one. No new secret name. FAIL CLOSED:
// with `mint` or `enforce` on and no usable secret (or no verified buyer), a create hands out NO storefront checkout
// rather than an unbound id, and says so in the log.
export const ID_BINDING_FLAG = "AGENT_CHECKOUT_STORE_CART_ID_BINDING";
export const ID_BINDING_MODES = Object.freeze({ off: "off", mint: "mint", enforce: "enforce" });
export const ID_BINDING_SECRET_ENV = "CONFIRMATION_SECRET";
const ID_BINDING_KEY_LABEL = "storefront-cart-id-binding/v1";
const ID_BINDING_MIN_SECRET_LENGTH = 16; // the floor the kernel itself demands of this secret in strict mode
const BINDING_RE = /^[A-Za-z0-9_-]{43}$/;

export function idBindingMode(env = process.env) {
  const raw = String((env && env[ID_BINDING_FLAG]) || "").trim().toLowerCase();
  return raw === ID_BINDING_MODES.mint || raw === ID_BINDING_MODES.enforce ? raw : ID_BINDING_MODES.off;
}

function idBindingKey(env = process.env) {
  const secret = env ? env[ID_BINDING_SECRET_ENV] : undefined;
  if (typeof secret !== "string" || secret.length < ID_BINDING_MIN_SECRET_LENGTH) return null;
  return createHmac("sha256", secret).update(ID_BINDING_KEY_LABEL, "utf8").digest();
}

function idBindingFor(userRef, env = process.env) {
  return { mode: idBindingMode(env), key: idBindingKey(env), userRef: str(userRef) };
}

/** The binding of an id's members (everything but `b`, in the order they are written) to one buyer. */
function bindingMac(body, userRef, key) {
  const { b: _b, ...members } = body;
  return createHmac("sha256", key).update(JSON.stringify([members, userRef]), "utf8").digest("base64url");
}

/**
 * MAY THIS BUYER READ THIS ID? False for an id that is not ours at all, so a caller can treat "not readable" and
 * "unknown" as one case, which is the point. `userRef` is the VERIFIED buyer of the call (never a body value).
 */
export function escalationIdReadable(id, userRef, env = process.env) {
  const parsed = parseEscalationId(id);
  if (!parsed || !decodeEscalationId(id)) return false;
  if (parsed.v !== 3) return idBindingMode(env) !== ID_BINDING_MODES.enforce;
  const key = idBindingKey(env);
  const buyer = str(userRef);
  if (!key || !buyer) return false;
  const expected = Buffer.from(bindingMac(parsed, buyer, key), "utf8");
  const given = Buffer.from(String(parsed.b), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Is this id bound to a buyer (v3)? Says nothing about whose. */
export function escalationIdIsBound(id) {
  const parsed = parseEscalationId(id);
  return Boolean(parsed && parsed.v === 3 && decodeEscalationId(id));
}

/**
 * The tracking members of the referral minted for a seller-priced id's cart (`t`), or undefined. A `t` that is not
 * exactly tracking members is IGNORED, never a reason to refuse the id: an id is read as it was before the member
 * existed, and nothing unreadable is ever carried onto a link.
 */
export function escalationTrackingOf(id) {
  const parsed = parseEscalationId(id);
  if (!parsed || !isSellerPriced(parsed) || !decodeEscalationId(id)) return undefined;
  const t = own(parsed, "t");
  return isPlainObject(t) ? (trackingPairsFrom(t) || undefined) : undefined;
}

/** The seller cart id a seller-priced escalation id carries, or undefined. */
export function escalationCartIdOf(id) {
  const parsed = parseEscalationId(id);
  return parsed && isSellerPriced(parsed) && decodeEscalationId(id) ? parsed.c : undefined;
}

/**
 * The market an escalation id's checkout was created for: `{ market, assumed, legacy }`, or null for no id of ours.
 * A LEGACY id (no `m`, see encodeEscalationId) has `market: null`: nothing is known about its market, so its re-read
 * stays unkeyable. `assumed` is true only when the create named no market and was answered as US.
 */
export function escalationMarketOf(id) {
  const parsed = parseEscalationId(id);
  if (!parsed || !decodeEscalationId(id)) return null;
  const market = typeof parsed.m === "string" ? parsed.m : null;
  return { market, assumed: parsed.a === 1, legacy: market === null };
}

/** The seller host a seller-priced escalation id is bound to, or undefined. */
export function escalationSellerHostOf(id) {
  const parsed = parseEscalationId(id);
  return parsed && isSellerPriced(parsed) && decodeEscalationId(id) ? parsed.h : undefined;
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

/** The hand-off record id a recorded escalation id carries (`r`), or undefined. Never proof of anything by itself. */
export function escalationRecordIdOf(id) {
  const parsed = parseEscalationId(id);
  if (!parsed || !decodeEscalationId(id)) return undefined;
  const r = own(parsed, "r");
  return typeof r === "string" && storefrontHandoffRecordModule.HANDOFF_RECORD_ID_RE.test(r) ? r : undefined;
}

// ---- the hand-off record and the quote-source label (FIX_PLAN O-02) ------------------------------------------------
//
// THE LABEL (UCP_STOREFRONT_HANDOFF_RECORD_ENABLED alone, read per call). Every storefront checkout says where its
// totals came from: `quote_source: "seller_cart"` (the seller's own door priced a cart built for it, `price_as_of` =
// when) or `quote_source: "catalogue_fallback"` (the catalog's last observed price, `price_as_of` = the OLDEST read
// behind the lines, null when any line has none) plus a warning naming it, so an agent never takes a catalogue total
// for the seller's live cart. Off, neither member nor the warning exists.
//
// THE RECORD (the same flag AND PARTNER_IDENTITY_FORWARDING_ENABLED; an injected `handoffRecorder`). Each create writes
// one hand-off record for the partner that asked, and only a CONFIRMED write puts its id into the esc id.

export const QUOTE_SOURCE_FALLBACK_MESSAGE_CODE = "checkout.quote_source.catalogue_fallback";

export function quoteSourceLabelEnabled(env = process.env) {
  return storefrontHandoffRecordModule.storefrontHandoffFlagOn(env);
}

function isoOrNull(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The catalogue price stamp of a cart: the oldest line's `price_as_of`, null when any line has none. Pure. */
export function cataloguePriceAsOf(items, rows) {
  let oldest = null;
  for (const it of items) {
    const row = rows.get(it.product_id);
    const at = isoOrNull(isPlainObject(row) ? (row.price_as_of ?? row.price_checked_at) : null);
    if (!at) return null;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

function withQuoteSource(checkout, quoteSource, priceAsOf) {
  return { ...checkout, quote_source: quoteSource, price_as_of: priceAsOf };
}

const REFERRAL_CLICK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The referral click id (`pvt_click_id`) the catalog link carries: on a Pivota hop, its destination's. Pure. */
export function referralClickIdOf(link) {
  let parsed;
  try { parsed = new URL(link); } catch { return null; }
  const hop = pivotaHopDestination(parsed);
  let source = parsed;
  if (hop) {
    if (!hop.dest) return null;
    try { source = new URL(hop.dest); } catch { return null; }
  }
  const values = source.searchParams.getAll("pvt_click_id");
  return values.length === 1 && REFERRAL_CLICK_ID_RE.test(values[0]) ? values[0] : null;
}

const MERCHANT_ID_RE = /^[A-Za-z0-9_.:-]{1,50}$/;

function cartMerchantId(items, rows) {
  const ids = new Set(items.map((it) => str(own(rows.get(it.product_id), "merchant_id"))));
  if (ids.size !== 1) return null;
  const [only] = [...ids];
  return only && MERCHANT_ID_RE.test(only) ? only : null;
}

/**
 * The id to hand out for a storefront checkout. `encode(recordId?)` builds it. Without the record switches or a
 * recorder, or on any write that is not confirmed, the id WITHOUT a record (what the door always handed out).
 */
async function recordedEscalationId({ encode, quoteSource, totals, currency, sellerHost, catalogLink, buyerMarket, items, rows, priceAsOf, env, handoffRecorder, log, mintedClickId }) {
  const plain = encode(undefined);
  if (!storefrontHandoffRecordModule.storefrontHandoffRecordEnabled(env)) return plain;
  if (!handoffRecorder || typeof handoffRecorder.record !== "function") return plain;
  const total = Array.isArray(totals) ? totals.find((t) => isPlainObject(t) && t.type === "total") : null;
  const amount = total ? total.amount : undefined;
  if (!sellerHost || !Number.isSafeInteger(amount) || amount < 0 || !/^[A-Z]{3}$/.test(String(currency || ""))) {
    if (log && typeof log.info === "function") {
      try { log.info({ event: "ucp_storefront_handoff_record", outcome: "not_recordable" }); } catch { /* never throw the door */ }
    }
    return plain;
  }
  const recordId = storefrontHandoffRecordModule.mintHandoffRecordId();
  const id = encode(recordId);
  if (escalationRecordIdOf(id) !== recordId) return plain;
  const fields = compact({
    record_id: recordId,
    binding: storefrontHandoffRecordModule.escalationIdBinding(id),
    seller_host: sellerHost,
    currency,
    quoted_total_minor: amount,
    quote_source: quoteSource,
    buyer_market: buyerMarket && /^[A-Z]{2}$/.test(buyerMarket) ? buyerMarket : undefined,
    // The catalog link's own referral, else the one minted for this cart (the link then carried none).
    referral_click_id: (catalogLink ? referralClickIdOf(catalogLink) : null)
      || (typeof mintedClickId === "string" && REFERRAL_CLICK_ID_RE.test(mintedClickId) ? mintedClickId : null),
    price_as_of: priceAsOf,
    merchant_id: cartMerchantId(items, rows),
  });
  let answered;
  try { answered = await handoffRecorder.record(fields); } catch { answered = null; }
  return answered && answered.kind === "recorded" ? id : plain;
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

/**
 * The market a storefront checkout CREATE is answered for (decision D-10): `{ market, assumed }`. A create that names
 * no market (`checkout.context.address_country` absent, null or blank) is answered as US, and the gate and the
 * seller's door are asked about US; one that names a market keeps exactly the market escalationBuyerMarket reads
 * (null for a malformed one, which stays unkeyable as before). Still never buyer address data.
 */
export function escalationRequestMarket(ucpArgs) {
  const context = own(own(ucpArgs, "checkout"), "context");
  if (requestMarket.marketIsUnnamed(own(context, "address_country"))) {
    return { market: requestMarket.ASSUMED_MARKET, assumed: true };
  }
  return { market: escalationBuyerMarket(ucpArgs), assumed: false };
}

/** A checkout answered for an assumed market says so: `market_assumed`, and the same notice in `messages`. */
function withAssumedMarket(checkout, assumed) {
  if (!assumed || !isPlainObject(checkout)) return checkout;
  return {
    ...checkout,
    market_assumed: requestMarket.marketAssumedLabel(),
    messages: [...(Array.isArray(checkout.messages) ? checkout.messages : []), {
      type: "info", code: "market_assumed", path: "$", content: requestMarket.MARKET_ASSUMED_MESSAGE, content_type: "plain",
    }],
  };
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
export function buildEscalationCheckout({ id, items, rows, continueUrl, buyerEmail, now, env = process.env, extraMessages = [], discountCode, expiresFrom }) {
  const labelled = quoteSourceLabelEnabled(env);
  const priceAsOf = labelled ? cataloguePriceAsOf(items, rows) : null;
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
  const checkout = buildUcpCheckoutEnvelope({
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
    // `expiresFrom`: a replayed create states the expiry the first create stated (storefrontCartIdempotency.js).
    expiresAt: new Date((Number.isFinite(expiresFrom) ? expiresFrom : now) + ESCALATION_TTL_MS).toISOString(),
    env,
    // A code the buyer sent, on an answer the seller did not price: echoed, nothing applied, and said so below.
    discounts: discountCode !== undefined ? { codes: [discountCode], applied: [] } : undefined,
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
      ...(discountCode !== undefined ? [discountOutcomeMessage({ status: "not_confirmed", reason: "not_priced_by_seller" })] : []),
      ...(labelled ? [{
        type: "warning",
        code: QUOTE_SOURCE_FALLBACK_MESSAGE_CODE,
        path: "$.totals",
        content: [
          "quote_source is catalogue_fallback: these totals are the catalog's stored price",
          priceAsOf ? `as of ${priceAsOf},` : "(no read time on record),",
          "not the seller's live cart. Do not present them to the buyer as the price they will pay.",
        ].join(" "),
        content_type: "plain",
      }] : []),
    ],
  });
  return labelled ? withQuoteSource(checkout, storefrontHandoffRecordModule.QUOTE_SOURCE.catalogueFallback, priceAsOf) : checkout;
}

/**
 * THE CHECKOUT OBJECT, shared. Every UCP checkout this door answers WITHOUT the kernel — the storefront
 * escalation above and the Reap agentic lane (ucpReapAgenticLane.js) — is built here, so the pinned required
 * members (`ucp`, `id`, `line_items`, `status`, `currency`, `totals`, `links`), the `payment_handlers: {}`
 * statement (Pivota collects no instrument on either lane) and the legal links are ONE definition. Member order
 * is the order `buildEscalationCheckout` always emitted, so that lane's bytes do not move. Pure; optional
 * members that are null/undefined are omitted, never published as null.
 */
export function buildUcpCheckoutEnvelope({ id, status, continueUrl, currency, lineItems, totals, discounts, buyerEmail, expiresAt, messages, env = process.env }) {
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
    // UCP discount extension member (`codes` echoed, `applied` entries). Absent unless a code was sent or the seller's
    // cart carries discounts, so every answer without one keeps its bytes.
    discounts,
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
export function buildSellerPricedCheckout({ id, priced, sellerHost, buyerEmail, now, env = process.env, expiresFrom }) {
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
    // One warning per code the seller did not confirm as applied; an applied code is in `discounts.applied`.
    ...(priced.discounts ? priced.discounts.outcomes : [])
      .map((o, i) => (o.status === "applied" ? null : { ...discountOutcomeMessage(o), path: `$.discounts.codes[${i}]` }))
      .filter(Boolean),
  ];
  const checkout = buildUcpCheckoutEnvelope({
    id,
    status: "requires_escalation",
    continueUrl: priced.continueUrl,
    currency: priced.currency,
    lineItems: priced.lineItems,
    totals: priced.totals,
    discounts: priced.discounts ? { codes: priced.discounts.codes, applied: priced.discounts.applied } : undefined,
    buyerEmail,
    // `expiresFrom`: a replayed create states the expiry the first create stated (storefrontCartIdempotency.js).
    expiresAt: new Date((Number.isFinite(expiresFrom) ? expiresFrom : now) + ESCALATION_TTL_MS).toISOString(),
    env,
    messages,
  });
  return quoteSourceLabelEnabled(env)
    ? withQuoteSource(checkout, storefrontHandoffRecordModule.QUOTE_SOURCE.sellerCart, new Date(now).toISOString())
    : checkout;
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
export async function tryEscalateUcpCheckout({ op, params, ctx, executor, ucpArgs, attested = {}, now = Date.now(), env = process.env, timeoutMs, shouldOfferPurchase, clock, declines, merchantDoor, storefrontPage, log, handoffRecorder, referralMinter, idempotencyStore, idempotencyDoor = "ucp", replayed }) {
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
  // The REQUEST's market, from the raw UCP body: a create that names none is answered as US (decision D-10), so the
  // gate and the seller's door are asked about US. Null (a malformed one) means no fact can be read: under
  // enforcement, a decline. A re-read takes the market its id carries instead (below).
  const requested = escalationRequestMarket(ucpArgs);
  const buyerMarket = requested.market;
  // A gate decline still returns null (the contract above), but the caller must be able to tell it from "not an
  // escalation cart": both used to fall through to the kernel, and only the second belongs there. `declines` is an
  // optional out-param (like the Reap lane's `hints`); see refuseUnservedStorefrontCheckout below.
  // Tagged so the refusal callTool raises can say what the decline was decided on: `market_assumed` (no market named,
  // so it was decided for US) or `market_unrecorded` (a legacy id's re-read: no market to decide it for).
  const declined = (tags = []) => { if (Array.isArray(declines)) declines.push("merchant_not_purchasable", ...tags); return null; };

  // The verified buyer of this call, for the id binding (escalationIdReadable).
  const callerRef = isPlainObject(ctx) ? str(ctx.user_ref) : null;
  const bind = { userRef: callerRef, env };

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
    // THE ID MUST BE BINDABLE, or no storefront checkout is handed out (FAIL CLOSED): with the binding switch on and
    // no key or no verified buyer to bind to, an unbound id would be the very thing the switch exists to stop.
    // Before the gate and before any seller is contacted. `null`: the door refuses the storefront rows by name.
    if (idBindingMode(env) !== ID_BINDING_MODES.off && (!idBindingKey(env) || !callerRef)) {
      if (log && typeof log.error === "function") {
        try { log.error({ event: "storefront_cart_id_binding", outcome: "unbindable", reason: callerRef ? "no_key" : "no_buyer" }); } catch { /* never throw the door */ }
      }
      return null;
    }
    // EVERYTHING FROM HERE ON asks the gate, may build a cart at the seller's store and may write records: the part
    // of a create a retry must not repeat (storefrontCartIdempotency.js). Every refusal above is decided on the
    // request and the catalog alone, and is the same on every attempt.
    const buildCart = async () => {
      // THE SEAM, BEFORE THE CHECKOUT IS BUILT. `null` = "not an escalation cart", which is the answer this
      // function already gives for every row that is not eligible for a continue_url. See the note above
      // `mayOfferStorefrontCheckout`. Single-seller by the check above, so this is ONE read per checkout.
      if (!(await mayOfferStorefrontCheckout(continueUrl, buyerMarket, gate, gateEnabled, gateBudgetMs()))) return declined(requested.assumed ? ["market_assumed"] : []);
      const buyerEmail = attestedEmailOrBody(attested, quote.customer_email);
      // THE SELLER PRICES IT, when its door can (ucpMerchantDoorPricing.js; own switch, default OFF). Null = fall back
      // to the catalog answer below, unchanged. Asked only AFTER the gate and the expected-seller check, so a seller
      // this door will not offer is never contacted.
      const sellerHost = sellerHostOf(continueUrl);
      const doorSignals = [];
      // The buyer's code: read only while this door accepts codes for storefront checkouts. Otherwise a code that
      // reached here came in under the Reap lane's rule and is that lane's (and the UCP view's) to answer for.
      const discountCode = storefrontDiscountCodesEnabled(env) ? buyerDiscountCode(ucpArgs) : undefined;
      // A code no storefront could take (blank, control or invisible/bidirectional characters) is REFUSED here, before
      // any seller is contacted: it is never sent, and never echoed back raw.
      if (discountCode !== undefined && !isAcceptableDiscountCode(discountCode)) {
        throw intakeRefusal("QUOTE_REQUIRED", "ucp_discount_code_invalid", [
          "`checkout.discounts.codes[0]` is not a usable discount code: it must be 1 to",
          `${DISCOUNT_CODE_MAX_LENGTH} UTF-16 code units of visible characters, with no control, formatting or invisible characters. Send the code exactly as`,
          "the buyer entered it, or send the checkout without `checkout.discounts`.",
        ].join(" "), { rejected_field: "checkout.discounts.codes" });
      }
      // The hand-off record names the buyer's market only when the buyer NAMED it (decision D-10): an assumed US is no
      // claim about the buyer, so the record carries none, as the seed-link mint is sent none.
      const recordedMarket = requested.assumed ? undefined : buyerMarket;
      const priced = await priceOnMerchantDoor({
        items: normalized, rows, sellerHost, discoveryHost: sellerHostnameOf(continueUrl), catalogLink: continueUrl,
        expectedSeller, market: buyerMarket, discountCode, env, merchantDoor, log, signals: doorSignals,
        // THE REFERRAL for a cart whose catalog link carries none (ucpMerchantDoorPricing.js, CART_REFERRAL_FLAG): the
        // door asks only when it is about to send the cart. The seller host, the market THE CART IS BUILT FOR (the one
        // sent to the seller: the buyer's, or the assumed one) and the observed seller's id; nothing of the buyer.
        mintReferral: referralMinter && typeof referralMinter.mint === "function"
          ? () => referralMinter.mint(compact({ seller_host: sellerHost, market: buyerMarket, merchant_id: cartMerchantId(normalized, rows) }))
          : undefined,
      });
      if (priced) {
        // An id this door could not read back (a host outside the id's host alphabet) would make every poll an unknown
        // id: such a cart is not offered at all, and the catalog answer below is given instead.
        const idMarket = { code: buyerMarket, assumed: requested.assumed };
        const minted = priced.referral || null;
        const tracking = minted ? minted.pairs : undefined;
        const unrecorded = encodeEscalationId(normalized, priced.cartId, sellerHost, idMarket, undefined, tracking, bind);
        if (escalationCartIdOf(unrecorded) === priced.cartId) {
          const id = await recordedEscalationId({
            encode: (recordId) => encodeEscalationId(normalized, priced.cartId, sellerHost, idMarket, recordId, tracking, bind),
            quoteSource: storefrontHandoffRecordModule.QUOTE_SOURCE.sellerCart,
            totals: priced.totals, currency: priced.currency, sellerHost, catalogLink: continueUrl, buyerMarket: recordedMarket,
            items: normalized, rows, priceAsOf: new Date(now).toISOString(), env, handoffRecorder, log,
            mintedClickId: minted ? minted.clickId : undefined,
          });
          return withAssumedMarket(buildSellerPricedCheckout({ id, priced, sellerHost, buyerEmail, now, env }), requested.assumed);
        }
      }
      const checked = await checkStorefrontPages({
        items: normalized, links: normalized.map((it) => targets.get(it.product_id)), rows, continueUrl,
        env, storefrontPage, log, doorSignals,
      });
      // The catalogue answer is built first (it can still refuse: an unpriced line, mixed currencies), so a hand-off is
      // recorded only for a checkout that is actually handed out, with the totals it shows.
      const fallbackMarket = { code: buyerMarket, assumed: requested.assumed };
      const fallbackArgs = {
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
        discountCode,
      };
      const draft = buildEscalationCheckout({ id: encodeEscalationId(normalized, undefined, undefined, fallbackMarket, undefined, undefined, bind), ...fallbackArgs });
      const id = await recordedEscalationId({
        encode: (recordId) => encodeEscalationId(normalized, undefined, undefined, fallbackMarket, recordId, undefined, bind),
        quoteSource: storefrontHandoffRecordModule.QUOTE_SOURCE.catalogueFallback,
        totals: draft.totals, currency: draft.currency, sellerHost, catalogLink: continueUrl, buyerMarket: recordedMarket,
        items: normalized, rows, priceAsOf: cataloguePriceAsOf(normalized, rows), env, handoffRecorder, log,
      });
      return withAssumedMarket(id === draft.id ? draft : buildEscalationCheckout({ id, ...fallbackArgs }), requested.assumed);
    };
    // A RETRY RETURNS THE SAME CHECKOUT (AGENT_CHECKOUT_STORE_CART_IDEMPOTENCY_ENABLED, default OFF, read per call).
    // Same verified buyer, same door, same key, same request: the checkout the first create handed out, read back
    // (the get path below), with no second cart, referral or record. Another request under the key: refused.
    const idempotencyKey = str(own(params, "idempotency_key"));
    const buyerRef = isPlainObject(ctx) ? str(ctx.user_ref) : null;
    if (!storeCartIdempotencyEnabled(env) || !idempotencyKey || !buyerRef) return buildCart();
    const fingerprint = requestFingerprint(canonicalRequest({
      items: normalized,
      market: buyerMarket,
      marketAssumed: requested.assumed,
      discountCodes: [own(own(own(ucpArgs, "checkout"), "discounts"), "codes") ?? null, own(quote, "discount_codes") ?? null],
      sellerNamed: own(quote, "merchant_id"),
      expectedSeller,
    }));
    return runIdempotentCart({
      store: idempotencyStore,
      scope: { door: idempotencyDoor, userRef: buyerRef, rawKey: idempotencyKey },
      fingerprint,
      ttlMs: ESCALATION_TTL_MS,
      now: () => now,
      log,
      build: async () => {
        const answer = await buildCart();
        return { answer, id: isPlainObject(answer) && typeof answer.id === "string" ? answer.id : null };
      },
      // The recorded checkout, read back as a re-read reads it, with what only a create knows put back: the buyer's
      // email as THIS request carries it, the code this request sent, and the expiry the first create stated.
      replay: (id, createdAt) => tryEscalateUcpCheckout({
        op: { id: "get_checkout_session" }, params: { session_id: id }, ctx, executor, ucpArgs: {}, attested, now, env, timeoutMs,
        shouldOfferPurchase, clock, declines, merchantDoor, storefrontPage, log, handoffRecorder, referralMinter,
        replayed: {
          buyerEmail: attestedEmailOrBody(attested, quote.customer_email),
          discountCode: storefrontDiscountCodesEnabled(env) ? buyerDiscountCode(ucpArgs) : undefined,
          expiresFrom: createdAt,
        },
      }),
    });
  }

  const sessionId = str(own(params, "session_id"));
  // An id this buyer may not read (bound to another buyer, or unbound under `enforce`) is no id of ours: the SAME
  // path as an id that never existed, on every operation below.
  const decoded = sessionId && escalationIdReadable(sessionId, callerRef, env) ? decodeEscalationId(sessionId) : null;
  if (!decoded) return null; // not one of ours: kernel path

  if (opId === "get_checkout_session") {
    // A REPLAYED CREATE (storefrontCartIdempotency.js) reads its checkout back here and adds what only a create
    // knows. Never set by a door: an ordinary re-read carries none of it, and its bytes do not move.
    const again = isPlainObject(replayed)
      ? compact({ buyerEmail: replayed.buyerEmail, expiresFrom: Number.isFinite(replayed.expiresFrom) ? replayed.expiresFrom : undefined })
      : {};
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
    // The same seam on the re-read, deliberately symmetrical. The UCP `get_checkout` wire body carries no
    // `checkout.context`, so the market is the one the id carries: the market the checkout was CREATED for
    // (escalationMarketOf, decision D-10). Before the id carried it this lane was always `unkeyable`, and under
    // ENFORCEMENT every re-read declined (`unkeyable_enforced`), including a checkout that passed the gate at create.
    // A LEGACY id (no `m`) carries no market and stays exactly that: unkeyable, never read as US.
    // The SAME link create handed out (handedOutLinkOf): a re-read must not swap Pivota's hop for a direct link.
    const link = handedOutLinkOf(targets);
    const created = escalationMarketOf(sessionId);
    const rereadMarket = created.market;
    if (!(await mayOfferStorefrontCheckout(link, rereadMarket, gate, gateEnabled, gateBudgetMs()))) {
      return declined([...(created.assumed ? ["market_assumed"] : []), ...(created.legacy ? ["market_unrecorded"] : [])]);
    }
    // A seller-priced checkout is re-read from the SELLER's cart (`get_cart` on the id's cart), never re-created.
    // The seller is the one the re-read rows resolve to; a cart the seller no longer answers for falls back to the
    // catalog answer, which says so.
    const cartId = escalationCartIdOf(sessionId);
    const sellerHost = sellerHostOf(link);
    if (cartId !== undefined && sellerHost && escalationSellerHostOf(sessionId) === sellerHost) {
      const priced = await priceOnMerchantDoor({
        items: decoded, rows, sellerHost, discoveryHost: sellerHostnameOf(link), catalogLink: link,
        market: rereadMarket, cartId, env, merchantDoor, log, referralPairs: escalationTrackingOf(sessionId),
      });
      if (priced) return withAssumedMarket(buildSellerPricedCheckout({ id: sessionId, priced, sellerHost, now, env, ...again }), created.assumed);
    }
    const checked = await checkStorefrontPages({ items: decoded, links: targets, rows, continueUrl: link, env, storefrontPage, log });
    return withAssumedMarket(buildEscalationCheckout({
      id: sessionId, items: decoded, rows, continueUrl: checked.continueUrl, now, env, extraMessages: checked.messages,
      ...again, ...(isPlainObject(replayed) && replayed.discountCode !== undefined ? { discountCode: replayed.discountCode } : {}),
    }), created.assumed);
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
// (for the market the id carries: the one the checkout was created for).
//
// It reads through the SAME per-call memoizing executor view as the lanes before it, so a cart they already read is
// not read again. No flag: it only replaces a refusal with a truthful one, and never opens anything.

/**
 * Refuse a UCP checkout op that carries storefront rows no lane served. Returns undefined when the kernel path should
 * run. @param {{ op:{id:string}, params:object, ctx:object, executor:{execute:Function}, declined?:boolean, timeoutMs?:number }} a
 */
export async function refuseUnservedStorefrontCheckout({ op, params, ctx, executor, declined = false, declineReasons = [], timeoutMs, env = process.env, merchantId, failOpen = false }) {
  const tags = Array.isArray(declineReasons) ? declineReasons : [];
  const assumed = tags.includes("market_assumed");
  const opId = op && op.id;
  const sessionId = str(own(params, "session_id"));
  if (opId !== "create_checkout_session" && sessionId && escalationIdReadable(sessionId, isPlainObject(ctx) ? ctx.user_ref : null, env) && decodeEscalationId(sessionId)) {
    if (declined) {
      // A decline on a RE-READ. Same reason code as before, and a message that says what the decline was decided on:
      // the market the checkout was created for (the one its id carries, decision D-10), or -- for a legacy id that
      // carries none -- nothing, exactly as every re-read was before.
      if (tags.includes("market_unrecorded")) {
        throw intakeRefusal("OPERATION_NOT_ALLOWED", "ucp_escalation_reread_unconfirmed",
          "This storefront checkout cannot be re-confirmed here: it was created before checkouts recorded their market, so there is no buyer market to check the seller against. Retrying will not change this; use the continue_url from the create, or create a new checkout with checkout.context.address_country.",
          {});
      }
      throw withAssumedMarketRefusal(intakeRefusal("OPERATION_NOT_ALLOWED", "ucp_escalation_reread_unconfirmed",
        "This storefront checkout cannot be re-confirmed here: its seller is not currently offered for agent checkout in the market this checkout was created for." +
          (assumed ? ` ${ASSUMED_REFUSAL_SENTENCE}` : "") +
          " Retrying will not change this; create a new checkout, or send the buyer to the product's storefront page.",
        {}), assumed);
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
  throw withAssumedMarketRefusal(storefrontRefusal(declined, [...targets.keys()], targets, linksAllowed, declined && assumed), declined && assumed);
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

/**
 * The numeric seller variant id a line will land on: the row's own seller variant, else the link's one `variant=`.
 * `stored`: the id of a BUYER-CHOSEN variant came from its stored seller id (source_variant_id / variant_gid), not
 * from its own id that merely looks like one (a barcode in variant_id does). Only a stored id may refuse.
 */
function landingVariantOf(row, link, landing, chosenVariantId) {
  const choice = sellerVariantChoiceOf(row, sellerHostOf(link), chosenVariantId);
  const fromGid = choice.gid ? (String(choice.gid).match(/(\d+)$/) || [])[1] : null;
  if (fromGid || chosenVariantId) return fromGid ? { variant: fromGid, stored: choice.stored === true } : null;
  try {
    const values = new URL(landing).searchParams.getAll("variant");
    return values.length === 1 && /^\d{1,20}$/.test(values[0]) ? { variant: values[0], stored: false } : null;
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
  // One read per product page: up to MAX_ESCALATION_ITEMS lines (shades of one product) share a page.
  const reads = new Map();
  const readOnce = (landing) => {
    const key = (storefrontProductPageModule.productPageOf(landing) || {}).jsonUrl || landing;
    if (!reads.has(key)) reads.set(key, Promise.resolve().then(() => read(landing)).catch(() => null));
    return reads.get(key);
  };
  const lines = await Promise.all(items.map(async (it, idx) => {
    const landing = landingUrlOf(links[idx]);
    if (!landing) return null;
    const page = await readOnce(landing);
    return page ? { it, link: links[idx], landing, page } : null;
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
  const catalogIdErrors = [];
  for (const l of lines) {
    if (!l || !l.page || l.page.state !== "live" || !(l.page.variantIds instanceof Set)) continue;
    const landed = landingVariantOf(rows.get(l.it.product_id), l.link, l.landing, l.it.variant_id);
    if (!landed || l.page.variantIds.has(landed.variant)) continue;
    const variant = landed.variant;
    // The page lists this "variant id" as one of its variants' barcode or SKU: the CATALOG stored the wrong id. The
    // store sells the product; that is a warning, never a refusal.
    if (l.page.variantCodes instanceof Set && l.page.variantCodes.has(variant)) { catalogIdErrors.push({ ...l, variant }); continue; }
    // A CHOSEN variant is refused only on TWO witnesses: the store's page does not list it AND the seller's own door
    // said `variant_invalid`, and only when its id is the variant's STORED seller id. The door was asked with that same
    // id, so an id that merely looks like a Shopify id (a barcode in variant_id, see ucpMerchantDoorPricing
    // ownVariantIdGid) gets "Variant not found" at the door and is absent from the page: one bad catalog id, not two
    // witnesses. A refusal there would stop the sale of a product the store does sell; such a line gets the warning.
    (l.it.variant_id && doorSaid && landed.stored ? chosenGone : impliedGone).push({ ...l, variant });
  }
  const stale = [...chosenGone, ...impliedGone, ...catalogIdErrors];
  if (stale.length || doorSaid) {
    emitPageCheck(log, "info", {
      outcome: chosenGone.length ? "refused"
        : impliedGone.length ? "variant_dropped" : catalogIdErrors.length ? "catalog_id_error" : "variant_listed",
      reason: chosenGone.length || impliedGone.length ? "storefront_variant_gone"
        : catalogIdErrors.length ? "catalog_variant_id_is_a_page_code" : "door_variant_invalid",
      door_variant_invalid: doorSaid,
      seller_hosts: [...new Set(lines.filter(Boolean).map((l) => l.page && l.page.host).filter(Boolean))],
      product_ids: (stale.length ? stale.map((l) => l.it.product_id) : items.map((it) => it.product_id)),
      // The refresh hint: the store handle and the variant id the catalog still names.
      stale_variants: stale.map((l) => ({ handle: l.page.handle, variant: l.variant })),
      catalog_id_errors: catalogIdErrors.length ? catalogIdErrors.map((l) => ({ handle: l.page.handle, variant: l.variant })) : undefined,
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
  if (!impliedGone.length && !catalogIdErrors.length) return unchanged;
  const messages = [];
  if (impliedGone.length) {
    const productIds = [...new Set(impliedGone.map((l) => l.it.product_id))];
    messages.push({
      type: "warning",
      code: "checkout.storefront_variant_not_listed",
      path: "$.continue_url",
      content: [
        `The seller's storefront no longer lists the option the catalog names for: ${productIds.join(", ")}.`,
        "continue_url opens the product page, where the buyer picks from the options the seller sells now; the catalog price above may not apply to them.",
      ].join(" "),
      content_type: "plain",
    });
  }
  if (catalogIdErrors.length) {
    const productIds = [...new Set(catalogIdErrors.map((l) => l.it.product_id))];
    messages.push({
      type: "warning",
      code: "checkout.catalog_variant_id_unverified",
      path: "$.continue_url",
      content: [
        `The catalog's option id for ${productIds.join(", ")} is not one the seller's storefront uses for it.`,
        "continue_url opens the product page, where the buyer confirms the option; the catalog price above may not apply to it.",
      ].join(" "),
      content_type: "plain",
    });
  }
  return {
    continueUrl: withoutStaleVariant(continueUrl, [...impliedGone, ...catalogIdErrors].map((l) => l.landing)),
    messages,
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

// A refusal the gate decided on an ASSUMED US (decision D-10) says so: the same sentence in the message, and
// `market_assumed` on the error, which toToolError publishes as the answer's top-level member.
const ASSUMED_REFUSAL_SENTENCE = "No market was named, so this was decided for a US buyer; send checkout.context.address_country to decide it for the buyer's own market.";
function withAssumedMarketRefusal(err, assumed) {
  if (assumed && err && typeof err === "object") Object.defineProperty(err, "marketAssumed", { value: true, enumerable: false, configurable: true });
  return err;
}

function storefrontRefusal(declined, productIds, targets, linksAllowed, assumed = false) {
  const hosts = [...new Set([...targets.values()].map(sellerHostOf).filter(Boolean))];
  const named = productIds.length ? ` (${productIds.join(", ")})` : "";
  const where = hosts.length ? ` on ${hosts.join(", ")}` : "";
  if (declined) {
    return intakeRefusal("NO_MERCHANT_OFFER", "merchant_not_purchasable", [
      `Purchase is not offered for these items${named}: their seller cannot currently be checked out by an agent in this market.`,
      ...(assumed ? [ASSUMED_REFUSAL_SENTENCE] : []),
      assumed ? "Retrying the same request will not change this; offer the buyer alternatives." : "This will not change on retry; offer the buyer alternatives.",
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

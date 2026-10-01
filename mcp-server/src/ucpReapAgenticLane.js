// The REAP AGENTIC lane of the UCP checkout door — the third lane, beside the kernel path and the storefront
// escalation (ucpCheckoutEscalation.js). Plan: pivota-backend WP5 (Reap agentic payments), owner decision
// 2026-09-23 after Reap showed a COMPLETED sandbox checkout.
//
// WHAT IT IS FOR. A row Pivota does not transact (no contract, no PSP — the same rows the escalation lane
// answers with a storefront `continue_url`) can still be BOUGHT FOR the buyer when the merchant is on Reap's
// agentic rail: the backend opens a purchase, its poller resolves the product at Reap and quotes it, and the
// buyer enters a card and approves on REAP'S OWN hosted pages. Pivota holds and moves no money on this lane —
// the backend never sees a card, and neither does this gateway.
//
// THE BUYER AGENT USES THE TOOLS IT ALREADY HAS. No new ucpTool name (mcp-server/test/ucpToolVocabulary.test.js
// pins the vocabulary), no new canonical operation (safety-kernel/test/protocol.test.js pins those), and the
// answer is the SAME checkout object the escalation lane builds (`buildUcpCheckoutEnvelope`), so the pinned
// required members and the UCP status enum hold by construction:
//
//   create_checkout  on an ELIGIBLE row -> ONE backend POST (<= 2 s) -> `incomplete`, id `reap_…`, AT ONCE.
//                    The slow part (resolve + quote: 30-45 s, one quoting step up to ~170 s) is the backend
//                    poller's, off the request path — the edge resets a response whose first byte is later
//                    than ~13 s.
//   get_checkout     on a `reap_` id -> ONE backend GET (<= 2 s) -> the status map below.
//   update_checkout / complete_checkout on a `reap_` id -> REFUSED by name. Completion happens on Reap's
//                    hosted page; the issuer registry and the mandate flags are never touched.
//
// ---- THE LANE ORDER (create_checkout), and where each decision is taken --------------------------------
//
//   1. NATIVE — the kernel path. A row with no escalation target (`escalationTargetOf(row) === null`: a
//      contracted merchant, or a row that declares `purchase_route: 'internal_checkout'`) is one Pivota
//      transacts itself. This lane returns null for it BEFORE anything else is considered, so a merchant the
//      kernel can complete never reaches Reap. That typed decision is the door's own — the same function the
//      escalation lane classifies with — not a second rule.
//   2. REAP — this module, for a caller the rail can serve (agent API key + buyer user token) and a non-native
//      row that is eligible (see `createReapCheckout`).
//   3. STOREFRONT ESCALATION — ucpCheckoutEscalation.js, unchanged, when this lane returns null: not eligible,
//      skipped by the purchasability gate, or REFUSED by the backend for ANY reason. The lane never refuses a
//      create: a 400 is not proof of eligibility (the backend checks consent and address before the merchant),
//      so a short buyer block only adds one informational message (`reap.available_with_consent`) to the
//      storefront answer.
//   4. The kernel path's existing answer, when escalation is off or declines — for an observed row that is the
//      intake refusal it gives today. (There is no separate "referral" lane in this door; the buyer's other
//      route is the offer link discovery already served.)
//   Why Reap before storefront escalation: both answer a row Pivota cannot charge, but Reap completes the
//   purchase FOR the buyer at our catalog price with a card-only rail and an order reference, where the
//   storefront link is a recommendation the buyer must finish alone (docs/merchant-purchasability-gate.md §8).
//   Why native before Reap: a contracted merchant is paid in chat through Pivota's own kernel; routing it to a
//   partner's hosted card page would replace a completable purchase with a detour.
//
// ---- THE CHECKOUT ID ---------------------------------------------------------------------------------------
//
// `reap_<purchase_id>.<snapshot>` — STATEFUL (the state lives in the backend's purchase ledger) and
// distinguishable from both the kernel's session ids and the escalation lane's stateless `esc_` ids.
//   purchase_id  the backend's id, EXACTLY `rp_` + 24 lowercase hex (db/reap_agentic_ledger.py). It is the
//                only thing ever sent back to the backend, and it is validated before it is.
//   snapshot     base64url JSON {v:1, i:<the caller's item id>, k:<catalog product_key>, q:<quantity>,
//                c:<currency>, u:<unit price, minor>} — the line as it stood at creation, so a `get_checkout` whose backend read FAILS can
//                still answer a spec-conformant `incomplete` checkout (line items, currency, totals are required
//                members) instead of a terminal state — and SAYS it is doing so (`reap.view_unavailable`). NO buyer
//                data. The id travels through the caller, so the snapshot is NOT TRUSTED for anything displayed
//                except the caller's own item id, which `line_items[0].item.id` echoes: on a successful read
//                every other displayed field comes from the backend's view, and `k` is the hidden check that
//                the view is of this purchase's product. It is never sent anywhere.
// Anything that does not decode EXACTLY (prefix, id shape, snapshot shape, <= 512 chars) is not one of ours
// and falls through to the kernel path — which answers it as any unknown checkout id, BYTE-FOR-BYTE, because
// it is that path's own answer. A well-formed id belonging to ANOTHER buyer gets 404 from the backend (the
// ownership conjunct is in SQL there) and takes the same fall-through.
//
// ---- THE STATUS MAP (get_checkout) -------------------------------------------------------------------------
//
//   backend state          UCP status             continue_url
//   resolving              incomplete             —
//   needs_enrollment       requires_escalation    Reap's card-entry page (hosted_url)
//   quoting                incomplete             —
//   awaiting_approval      requires_escalation    Reap's approval page (hosted_url)
//   processing             complete_in_progress   —
//   completed              completed              —   (order reference in messages)
//   refused/failed/expired canceled               —   (named reason in messages)
//   a state this door does not know yet   incomplete (`reap.state_unrecognised`, logged once)
//   GET 404 `purchase_not_found` (unknown, or another buyer's) -> null -> the kernel's unknown-id answer
//   GET anything else that is not a 2xx view — transport, timeout, 5xx, 401/403/429/400, 404
//   `not_available_on_this_rail` (the dial turned off mid-purchase), a malformed body -> `incomplete` + retry
//   hint, NEVER terminal and NEVER "unknown" (either would invite a second purchase)
// A pending state whose hosted URL is absent, has no future expiry, or fails the host check answers `incomplete`
// (the spec obliges `continue_url` on `requires_escalation`, so a pending state with nowhere to send the buyer
// is not published as one). A hosted URL is NEVER forwarded for any other state, whatever the body carries.
//
// ---- SWITCH ------------------------------------------------------------------------------------------------
//
// `REAP_AGENTIC_LANE_ENABLED` (default OFF, read per call). Off — or no client injected — every entry point
// returns null before reading anything, and every TOOL RESPONSE is byte-identical to the door without this
// module EXCEPT that the argument adapter refuses a malformed `consent_version` (`ucp_consent_version_invalid`)
// whatever the switch says. (`tools/list` is not byte-identical: the UCP `buyer` schema carries the optional
// `consent_version` member and the create_checkout description mentions the Reap route.) The seller contract
// below (vendor capability `cc.pivota.reap_seller`: `checkout.reap.expected_merchant_domain` in, the refusal
// `ucp_seller_mismatch`, and `reap.merchant_domain` / `reap.merchant_id` out) is advertised, accepted and
// answered ONLY while this switch is on: off, the member is refused as an unknown field exactly as before it
// existed.
//
// ---- THE SELLER (docs/reap-agentic-lane.md §5.4) -------------------------------------------------------------
//
// A multi-seller `sig_` id resolves to ONE served row, and every route of the door (kernel, Reap, storefront)
// sells from THAT row's merchant — which can differ from the seller a platform showed the buyer. So:
//   IN   `checkout.reap.expected_merchant_domain` on create_checkout: the seller the buyer was shown. The DOOR
//        (`assertExpectedSeller`, called by commerceToolSurface BEFORE any lane or the kernel) compares it, on
//        the backend's canonical form (`canonicalReapMerchantDomain`), with EVERY destination of EVERY line's
//        resolved row — the explicit merchant fields, the storefront link, and for a native row its registered
//        store (ucpExpectedSeller.js `judgeRowSeller`) — and REFUSES the create (`QUOTE_REQUIRED` /
//        `ucp_seller_mismatch`) on any difference, any row it cannot read, and any destination it cannot confirm
//        (a Pivota hop, a redirector, none at all: fail closed). Nothing is opened and no other route is offered.
//        The storefront lane re-checks the link it hands out.
//   OUT  a Reap checkout answer read from a server-side source (create; get on a good backend read) names the
//        seller the purchase is with, as two `info` messages at `$.line_items[0]` whose `content` is the bare
//        value (like `reap.order_reference`): `reap.merchant_domain` — the host as the lane POSTed it
//        (lowercased, `www.` kept as observed; on get, the backend view's own `merchant_domain`) — and
//        `reap.merchant_id`, the `<merchant>` segment of the catalog key the purchase was opened for. The
//        DEGRADED get (`reap.view_unavailable`) names no seller: its only source is the caller-carried id.
//        UCP 2026-04-08 has no checkout / line-item / item seller member (its only `seller` is the catalog
//        variant's display name + links); `messages[]` with freeform codes is the spec's own carrier for
//        business-specific state, the channel this lane already publishes its cadence, deadline and order
//        reference on.

import { createHash } from "node:crypto";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import {
  intakeRefusal,
  isRestatedProductId,
  normalizeEmail,
  variantIdsFromProductRead,
  DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS,
} from "../../safety-kernel/src/protocol/buyerIntake.js";
import { majorToIsoMinor } from "../../safety-kernel/src/money.js";
import { sanitizeResult } from "../../safety-kernel/src/protocol/resultSanitizer.js";
// The purchasability gate's ONE process client and ONE switch — the same default-interop import the
// escalation lane uses, so there is one cache and one `enforced` rule for the whole gateway.
import merchantPurchasability from "../../src/services/merchantPurchasabilityClient.js";
// The external-seed sentinel seller id, from its one owner (ADR-009).
import pdpRenderability from "../../src/services/pdpRenderability.js";
// The expected-seller rule: ONE module, shared with the storefront lane (no import cycle).
import {
  HOSTNAME_RE,
  PRINTABLE_ASCII_RE,
  SELF_HOST_RE,
  canonicalReapMerchantDomain,
  judgeRowSeller,
  pivotaHopDestination,
  reapExpectedMerchantDomain,
  reapMerchantIdOfProductKey,
  sellerMismatchRefusal,
} from "./ucpExpectedSeller.js";
// Re-exported: the lane's public surface for the seller contract.
export {
  SELLER_MISMATCH_REASON,
  canonicalReapMerchantDomain,
  isSameReapMerchant,
  judgeRowSeller,
  judgeSellerUrl,
  reapExpectedMerchantDomain,
  reapMerchantIdOfProductKey,
} from "./ucpExpectedSeller.js";
import {
  ESCALATION_GATE_MAX_MS,
  ESCALATION_TTL_MS,
  buildUcpCheckoutEnvelope,
  escalationBuyerMarket,
  escalationTargetOf,
  mayOfferPurchaseForDomain,
  readCheckoutRows,
} from "./ucpCheckoutEscalation.js";

export const REAP_AGENTIC_LANE_FLAG = "REAP_AGENTIC_LANE_ENABLED";
/**
 * The Tier B (cart-link) half of this lane. Default OFF, read per call, and only consulted when the lane itself
 * is on. When on, a row the backend refuses on its VARIANT lane with `409 merchant_not_eligible` — the merchant
 * is not on the operator allowlist — is offered ONCE more as `item_source: "cart_link"`, which the backend
 * checks against its own daily Tier B verdict. The backend's `REAP_AGENTIC_CART_LINK_ENABLED` still has to be
 * on too; until it is, the second POST is a `404 not_available_on_this_rail` and the storefront answers as
 * before.
 */
export const REAP_AGENTIC_CART_LINK_LANE_FLAG = "REAP_AGENTIC_CART_LINK_LANE_ENABLED";
/**
 * ENRICHMENT rows on the cart-link lane (option 2, PR D). Default OFF, read per call, and only consulted when the
 * lane AND the cart-link dial are both on. When on, an enrichment-agent row (`ext:<slug>::<8 hex>` /
 * `ext:retailer:<32 hex>`, source system `catalog_enrichment_agent_v1` or none on the read) is POSTed as
 * `item_source: "cart_link"` like a seed mirror row. Off, such a row is skipped `row_key_unsupported` exactly as
 * before. Arm it only after pivota-backend's `_load_cart_link_item` enrichment branch (option 2, PR C) is live:
 * until then the backend refuses these rows and the storefront answers as before.
 */
export const REAP_AGENTIC_CART_LINK_ENRICHMENT_FLAG = "REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED";
export const REAP_CHECKOUT_ID_PREFIX = "reap_";
/** The backend's MAX_QUANTITY (services/reap_agentic_purchase.py). A larger cart is not this lane's. */
export const REAP_MAX_QUANTITY = 10;
/**
 * Hosts a hosted page may be on — the backend's `ALLOWED_HOSTED_URL_SUFFIXES`
 * (services/reap_agentic_client.py), mirrored as a SECOND check, not a substitute: the backend refuses any
 * other host before it stores the URL, and this door refuses to hand one to a buyer even if the backend's
 * check were ever bypassed. Exact-or-dot-suffix, https only, no userinfo, default port only.
 */
export const REAP_HOSTED_URL_SUFFIXES = Object.freeze(["prava.space", "reap.global"]);
/** The consent tag's schema bound (a string of at most 32 characters), enforced by the argument adapter. */
export const REAP_CONSENT_MAX_CHARS = 32;

const PURCHASE_ID_RE = /^rp_[0-9a-f]{24}$/;
const SNAPSHOT_RE = /^[A-Za-z0-9_-]{1,1000}$/;
const MAX_ID_CHARS = 1100;
const MAX_PRODUCT_KEY_CHARS = 256;
const CURRENCY_RE = /^[A-Z]{3}$/;
const REASON_RE = /^[a-z0-9_:.-]{1,64}$/;
const ORDER_REFERENCE_RE = /^[A-Za-z0-9_#:.\-/]{1,128}$/;
const DEFAULT_POLL_SECONDS = 30;
const MAX_POLL_SECONDS = 3600;

const PENDING_BUYER_STATES = new Set(["needs_enrollment", "awaiting_approval"]);
const STATE_TO_STATUS = Object.freeze({
  resolving: "incomplete",
  needs_enrollment: "requires_escalation",
  quoting: "incomplete",
  awaiting_approval: "requires_escalation",
  processing: "complete_in_progress",
  completed: "completed",
  refused: "canceled",
  failed: "canceled",
  expired: "canceled",
});
export const REAP_STATE_TO_UCP_STATUS = STATE_TO_STATUS;
const TERMINAL_STATES = new Set(["completed", "refused", "failed", "expired"]);

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
function own(src, key) {
  if (!isPlainObject(src)) return undefined;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : undefined;
}
// A bound, not a policy: keeps unit x quantity inside Number.MAX_SAFE_INTEGER for every accepted quantity.
const MAX_UNIT_MINOR = 1e12;
const safeMinor = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= MAX_UNIT_MINOR ? v : null);

export function reapAgenticLaneEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[REAP_AGENTIC_LANE_FLAG]) || "").trim());
}

// A create-only pause. Unset preserves an already-armed lane; an explicit
// unrecognized/off value fails closed. GET and reconciliation retain the master lane.
export function reapAgenticCreateEnabled(env = process.env) {
  if (!reapAgenticLaneEnabled(env)) return false;
  const raw = env && env.REAP_AGENTIC_CREATE_ENABLED;
  return raw === undefined || /^(1|true|yes|on|enabled)$/i.test(String(raw).trim());
}

export function reapCartLinkLaneEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[REAP_AGENTIC_CART_LINK_LANE_FLAG]) || "").trim());
}

/** The enrichment dial ALONE (the caller also requires the lane and the cart-link dial). */
export function reapCartLinkEnrichmentEnabled(env = process.env) {
  return /^(1|true|yes|on|enabled)$/i.test(String((env && env[REAP_AGENTIC_CART_LINK_ENRICHMENT_FLAG]) || "").trim());
}

/**
 * Are buyer offer codes ARMED on this door? The Reap lane AND its cart-link dial. The ONE rule the argument
 * adapter (advertise + accept `checkout.discounts`), the tool list and this lane (forward `offer_code`) read.
 *
 * WHY THE CART-LINK DIAL (review of #2323, G8). An older backend's request model ignores unknown fields, so a
 * gateway forwarding `offer_code` to a backend without pivota-backend#2425 would have the code dropped SILENTLY
 * -- the buyer believes a discount was asked for. The cart-link dial is only armed after #2425 is deployed
 * (docs/reap-agentic-lane.md §7), so tying codes to it makes "codes on" imply "a backend that reads them".
 */
export function reapOfferCodesEnabled(env = process.env) {
  return reapAgenticCreateEnabled(env) && reapCartLinkLaneEnabled(env);
}

// ---- id ----------------------------------------------------------------------------------------------------

export function encodeReapCheckoutId({ purchaseId, productId, productKey, quantity, currency, unitMinor }) {
  if (!PURCHASE_ID_RE.test(String(purchaseId || ""))) throw new Error("encodeReapCheckoutId: not a backend purchase id");
  const snapshot = Buffer.from(JSON.stringify({ v: 1, i: productId, k: productKey, q: quantity, c: currency, u: unitMinor }), "utf8")
    .toString("base64url");
  return `${REAP_CHECKOUT_ID_PREFIX}${purchaseId}.${snapshot}`;
}

/** `{ purchaseId, productId, productKey, quantity, currency, unitMinor }` for one of ours, else null. Never throws. */
export function decodeReapCheckoutId(id) {
  if (typeof id !== "string" || id.length > MAX_ID_CHARS || !id.startsWith(REAP_CHECKOUT_ID_PREFIX)) return null;
  const body = id.slice(REAP_CHECKOUT_ID_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot < 0) return null;
  const purchaseId = body.slice(0, dot);
  const encoded = body.slice(dot + 1);
  if (!PURCHASE_ID_RE.test(purchaseId) || !SNAPSHOT_RE.test(encoded)) return null;
  let snap;
  try {
    snap = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(snap) || snap.v !== 1) return null;
  const productId = typeof snap.i === "string" ? snap.i : "";
  const productKey = typeof snap.k === "string" ? snap.k : "";
  for (const v of [productId, productKey]) {
    if (!v || v !== v.trim() || v.length > MAX_PRODUCT_KEY_CHARS || /[\u0000-\u001f\u007f]/.test(v)) return null;
  }
  if (!Number.isSafeInteger(snap.q) || snap.q < 1 || snap.q > REAP_MAX_QUANTITY) return null;
  if (typeof snap.c !== "string" || !CURRENCY_RE.test(snap.c)) return null;
  if (safeMinor(snap.u) === null) return null;
  // Canonical form only: a re-encoding of the same values with extra members or another key order is not an
  // id this door minted.
  if (encodeReapCheckoutId({ purchaseId, productId, productKey, quantity: snap.q, currency: snap.c, unitMinor: snap.u }) !== id) return null;
  return { purchaseId, productId, productKey, quantity: snap.q, currency: snap.c, unitMinor: snap.u };
}

export function isReapCheckoutId(id) {
  return decodeReapCheckoutId(id) !== null;
}

// ---- idempotency -------------------------------------------------------------------------------------------

/**
 * The backend's `idempotency_key`, DERIVED from the tool call's own `meta["idempotency-key"]` — never minted.
 * A random key per call would make every retry of one create a second purchase (and a second card page for the
 * buyer); the whole point of the caller's key is that a retry is the same request. Hashed rather than passed
 * through because the backend column is VARCHAR(128) and the UCP key has no upper bound, and namespaced so the
 * same caller key can never collide with a key some other door sends this route. The backend scopes it to
 * (agent, buyer) on its side.
 */
export function reapIdempotencyKey(toolIdempotencyKey) {
  const key = str(toolIdempotencyKey);
  if (!key) return null;
  return `ucp-reap-v1-${createHash("sha256").update(`pivota-ucp-reap-lane:v1:${key}`, "utf8").digest("hex").slice(0, 48)}`;
}

/**
 * The backend key for the ONE Tier B (cart-link) retry of a create, derived from the SAME tool key under its own
 * namespace. NOT `reapIdempotencyKey(\`${key}:cart_link\`)`: that collides with the variant key of a caller whose
 * key is literally `K:cart_link` (review of #2323, G3). Deterministic, so a client retry of the create replays
 * the cart-link purchase the first attempt opened (the backend also remembers the variant refusal against the
 * variant key -- pivota-backend "remember a merchant_not_eligible refusal against the idempotency key").
 */
export function reapCartLinkIdempotencyKey(toolIdempotencyKey) {
  const key = str(toolIdempotencyKey);
  if (!key) return null;
  return `ucp-reap-v1-${createHash("sha256").update(`pivota-ucp-reap-lane:cart_link:v1:${key}`, "utf8").digest("hex").slice(0, 48)}`;
}

// ---- reads off the raw UCP wire body ----------------------------------------------------------------------

/**
 * `checkout.buyer.consent_version` — the version tag of the terms the buyer accepted, which the backend
 * REQUIRES on every purchase and stores against it for ever. Read from the RAW UCP body, like the escalation
 * lane's market: the UCP `buyer` object is additionalProperties:true, so a platform can send it without a new
 * tool or argument, and the canonical quote has nowhere truthful to put it (it is not a pricing input).
 *
 * FORWARDED VERBATIM — never trimmed, case-folded or filtered here. The argument adapter enforces the schema
 * (a string of at most 32 characters) and the BACKEND owns the one consent validator
 * (`db.reap_agentic_ledger.require_consent_version`); a second, different rule in the door is exactly the
 * three-validators drift that validator was created to end. `undefined` when absent or not a string.
 */
export function reapConsentVersion(ucpArgs) {
  const raw = own(own(own(ucpArgs, "checkout"), "buyer"), "consent_version");
  return typeof raw === "string" ? raw : undefined;
}

/**
 * `checkout.discounts.codes[0]` — the buyer's ONE offer code, read from the RAW UCP body like the consent tag,
 * and FORWARDED VERBATIM as the backend's `offer_code`: never trimmed or case-folded here (the merchant matched
 * `peachie20` and `PEACHIE20` alike; a code we altered is not the one the buyer typed). The argument adapter
 * enforces the published shape (at most one string of 1..128 characters); the backend owns the one content rule
 * (`services.reap_agentic_client.validate_offer_code`). `undefined` when absent.
 */
export function reapOfferCode(ucpArgs) {
  const codes = own(own(own(ucpArgs, "checkout"), "discounts"), "codes");
  if (!Array.isArray(codes) || codes.length !== 1) return undefined;
  return typeof codes[0] === "string" ? codes[0] : undefined;
}

function singleDestination(ucpArgs) {
  const methods = own(own(own(ucpArgs, "checkout"), "fulfillment"), "methods");
  if (!Array.isArray(methods) || methods.length !== 1) return null;
  const destinations = own(methods[0], "destinations");
  if (!Array.isArray(destinations) || destinations.length !== 1) return null;
  return isPlainObject(destinations[0]) ? destinations[0] : null;
}

const DEST_PATH = "checkout.fulfillment.methods[0].destinations[0]";
/** The destination fields the rail requires, as UCP spells them (the phone may also come from the buyer). */
const REAP_REQUIRED_DESTINATION_FIELDS = Object.freeze(["first_name", "last_name", "phone_number", "street_address", "address_locality", "address_country"]);

/**
 * The shipping address in the REAP CLIENT'S field names (`firstName`, `lastName`, `phone`, `addressLine1`,
 * `city`, `country` required; `addressLine2`, `region`, `postalCode` optional), from the one UCP destination —
 * WHATEVER OF IT ARRIVED. Completeness is the backend's decision (`invalid_address` / `invalid_request`); the
 * lane never refuses on it (see `REAP_AVAILABLE_WITH_CONSENT_MESSAGE`), and nothing is invented to fill a gap. The phone falls back to
 * `checkout.buyer.phone_number`. `undefined` when there is no destination at all.
 */
export function reapShippingAddress(ucpArgs) {
  const dest = singleDestination(ucpArgs);
  if (!dest) return undefined;
  const buyer = own(own(ucpArgs, "checkout"), "buyer");
  const address = {
    firstName: str(own(dest, "first_name")),
    lastName: str(own(dest, "last_name")),
    phone: str(own(dest, "phone_number")) || str(own(buyer, "phone_number")),
    addressLine1: str(own(dest, "street_address")),
    addressLine2: str(own(dest, "extended_address")),
    city: str(own(dest, "address_locality")),
    region: str(own(dest, "address_region")),
    postalCode: str(own(dest, "postal_code")),
    country: str(own(dest, "address_country")),
  };
  for (const k of Object.keys(address)) if (address[k] === null) delete address[k];
  return address;
}

/** The UCP field paths the rail needs that this call did not carry — FIELD NAMES ONLY, never a value. */
export function reapMissingBuyerFields(ucpArgs, email) {
  const missing = [];
  if (!email) missing.push("checkout.buyer.email");
  const dest = singleDestination(ucpArgs);
  if (!dest) return [...missing, DEST_PATH];
  const buyer = own(own(ucpArgs, "checkout"), "buyer");
  for (const f of REAP_REQUIRED_DESTINATION_FIELDS) {
    if (str(own(dest, f))) continue;
    if (f === "phone_number" && str(own(buyer, "phone_number"))) continue;
    missing.push(`${DEST_PATH}.${f}`);
  }
  return missing;
}

// ---- the row -----------------------------------------------------------------------------------------------

/** The URL's host AS OBSERVED — lowercased, nothing else. */
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * The backend's merchant key (`catalog_products.source_domain`): an explicit field when the read carries one,
 * else the host of the builder's storefront target, else the row's canonical/url — never one of Pivota's own
 * hosts, and never `destination_url` (a raw row URL that can be a tracking hop).
 *
 * AS OBSERVED, LOWERCASED ONLY. No `www.` is stripped from what is SENT or PUBLISHED: production Shopify
 * `source_domain` values carry it (`www.Brand.com`), and a door that canonicalises on its own while the backend
 * compares a different spelling refuses every eligible row `row_not_found` and falls through SILENTLY.
 * Canonicalising both sides (lowercase + one leading `www.`) is the BACKEND's job, at lookup, where both
 * spellings are in view — and this lane's only for the expected-seller check (`isSameReapMerchant`), where
 * both spellings are likewise in view and the folded value is compared, never sent.
 */
export function reapMerchantDomain(row, escalationTarget) {
  const explicit = str(own(row, "merchant_domain")) || str(own(row, "source_domain"));
  const hosts = explicit
    // Non-ASCII is refused BEFORE the fold (a URL's hostname below is already ASCII/punycode).
    ? [PRINTABLE_ASCII_RE.test(explicit) ? explicit.toLowerCase() : null]
    : [hostOf(escalationTarget), hostOf(str(own(row, "canonical_url"))), hostOf(str(own(row, "url")))];
  const candidate = hosts.find((h) => h && HOSTNAME_RE.test(h) && !SELF_HOST_RE.test(h));
  return candidate || null;
}

/** Our catalog key for the row (`catalog_products.product_key`), or null. Bounded so it fits the checkout id. */
function productKeyOf(row) {
  const key = str(own(row, "product_key")) || str(own(row, "catalog_product_key"));
  return key && key.length <= MAX_PRODUCT_KEY_CHARS && !/[\u0000-\u001f\u007f]/.test(key) ? key : null;
}

/**
 * Is this a SHOPIFY row? An explicit platform field when the read carries one; otherwise the platform segment
 * of the backend's own product-key convention (`prod::<merchant>::<platform>::<source id>`). This is a CHEAP
 * pre-filter only — the backend decides authoritatively (`row_not_shopify`) and a refusal falls through.
 */
function isShopifyRow(row, productKey) {
  const platform = str(own(row, "platform")) || str(own(row, "source_platform"));
  if (platform) return platform.toLowerCase() === "shopify";
  const parts = productKey.split("::");
  return parts.length >= 4 && parts[0] === "prod" && parts[2].toLowerCase() === "shopify";
}

// ---- Tier B cart-link, DIRECT (external-seed / mirror rows) -------------------------------------------------
//
// An EXTERNAL-SEED row (a mirror of a merchant's storefront that Pivota does not transact: judydoll.com,
// jsmbeauty.sg) is not a Shopify catalog row, so the VARIANT lane can never buy it — the backend's variant rail
// reads Shopify rows only. The backend's CART-LINK lane can (`_load_cart_link_item` accepts platform
// `external_seed` from `external_product_seeds_mirror_v1`, and proves the sole Shopify variant from the seed's
// storefront evidence). So while BOTH dials are on (the lane AND `REAP_AGENTIC_CART_LINK_LANE_ENABLED`), such a
// row is POSTed with `item_source: "cart_link"` directly — not first as a variant purchase that can only be
// refused. The backend decides whether the merchant IS a Tier B cart-link merchant (its daily verdict, in the
// buyer's market); a refusal falls through like any other. The gateway sends catalog keys only (merchant host,
// product key): no URL, no price, no variant — the backend accepts none of them from a caller.

const EXTERNAL_SEED_PLATFORMS = new Set(["external", "external_seed"]);
/**
 * THE ONE KEY SHAPE THE BACKEND'S CART-LINK LANE RESOLVES for a non-Shopify row: the seed MIRROR's
 * `prod::external_seed::external_seed::<external_product_id>` (pivota-backend
 * scripts/mirror_external_seeds_to_catalog_products.py, source_system `external_product_seeds_mirror_v1`).
 * `_load_cart_link_item` refuses every other external_seed row: an enrichment-agent `ext:<canonical>::<hash>` key
 * (services/catalog_enrichment_agent/ingestion.py `derive_product_key`) IS a catalog_products key, but its
 * source_system is the agent's, which that function answers `row_variant_unverified` until pivota-backend option 2
 * (PR C) — those rows have their own gate below (`isEnrichmentCartLinkRow`, behind
 * `REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED`). The merchant segment is the shared sentinel seller, read from its
 * one owner (ADR-009); the platform segment is the mirror's platform.
 */
const MIRROR_KEY_PREFIX = `prod::${pdpRenderability.EXTERNAL_SEED_MERCHANT_ID}::external_seed::`;
const MIRROR_SOURCE_SYSTEM = "external_product_seeds_mirror_v1";

/** Is this an external-seed row (platform `external` / `external_seed`, else an external-seed key shape)? */
function isExternalSeedRow(row, productKey) {
  const platform = str(own(row, "platform")) || str(own(row, "source_platform"));
  if (platform) return EXTERNAL_SEED_PLATFORMS.has(platform.toLowerCase());
  return productKey.startsWith("ext:") || productKey.startsWith(MIRROR_KEY_PREFIX);
}

/**
 * Is it a seed MIRROR row, i.e. one whose key the backend's cart-link lane resolves? The mirror key shape, and — when
 * the read carries a source system — the mirror's. An affiliate-feed or enrichment row (`platform: external`, an
 * `ext:` key, another source system) is NOT; an enrichment row is POSTed only through `isEnrichmentCartLinkRow`.
 */
function isSeedMirrorRow(row, productKey) {
  if (!productKey.startsWith(MIRROR_KEY_PREFIX) || productKey.length === MIRROR_KEY_PREFIX.length) return false;
  const system = str(own(row, "source_system"));
  return system === null || system === MIRROR_SOURCE_SYSTEM;
}

// ---- Tier B cart-link, DIRECT, ENRICHMENT rows (option 2, PR D; behind REAP_AGENTIC_CART_LINK_ENRICHMENT_ENABLED) --
//
// The enrichment agent (source_system `catalog_enrichment_agent_v1`) writes brand-store and retailer rows whose keys
// are NOT mirror keys, so `isSeedMirrorRow` refuses them. pivota-backend option 2 (PR C) teaches
// `_load_cart_link_item` to resolve them against its own variant proof table; this gateway half only lets them
// reach that POST. The key shapes are EXACTLY what the backend mints
// (services/catalog_enrichment_agent/ingestion.py):
//   - `derive_product_key`, legacy (every name whose ASCII slug stands for the product): `ext:` +
//     canonical_product_name(brand, name)[:200] + `::` + sha1(canonical)[:8]. The canonical is `[^a-z0-9]+` -> `-`
//     over the lowercased name, stripped, so it is lowercase alnum and `-`, starts with an alnum, and is at most 200
//     chars (a cut at 200 can end on `-`). The hash is LOWERCASE hex.
//   - `derive_product_key`, script identity (pivota-backend #2461: a name the slug cannot stand for — a non-Latin
//     letter, a Vietnamese letter, a non-ASCII digit or numeral): `ext:` + prefix[:192] + `::` +
//     sha1(product_identity_text)[:16]. The prefix is the same `[^a-z0-9]+` -> `-` slug of the identity text, or
//     "unknown" when that is empty (every all-CJK / all-Hangul name), so `ext:unknown::<16 hex>` is a DISTINCT key.
//     Both forms are at most 214 chars; the 16-hex digest is LOWERCASE hex.
//   - a retailer listing: `ext:retailer:` + sha256(listing identity)[:32], lowercase hex.
// Anything else under `ext:` (`ext:foo`, 7 / 9..15 / 17 hex, 31 / 33 hex, uppercase hex, an empty slug) is not one of
// those keys. And the LEGACY `ext:unknown::<8 hex>` is REFUSED although rows written before #2461 carry it: the old
// generator answered "unknown" for EVERY brand + name with no ASCII letter or digit, so all of them shared ONE key and
// the row is whichever product was written last — not an identity a purchase can be opened against. (#2461 no longer
// ingests the only names that still derive it: symbol-only ones.) Its 16-hex successor is one product, and accepted.
//
// THE READ. What this lane sees is the gateway's get_product read, not the catalog row. Live reads of enrichment rows
// (2026-09-29: tarte sig_1d54c9e3…, bluemercury sig_016e4c11…, stila sig_07176ee6…, MAC sig_f5da0819…) carry NO
// `source_domain`, `source_system` or `platform`; their `canonical_url` / `url` is Pivota's own PDP
// (`https://agent.pivota.cc/products/sig_…`). The merchant's page is `external_redirect_url` (the storefront target),
// with `destination_url` and `source_url` alongside — `source_url` sometimes with `www.` where the others have none.
const ENRICHMENT_SOURCE_SYSTEM = "catalog_enrichment_agent_v1";
const ENRICHMENT_BRAND_KEY_RE = /^ext:(?:[a-z0-9][a-z0-9-]{0,199}::[0-9a-f]{8}|[a-z0-9][a-z0-9-]{0,191}::[0-9a-f]{16})$/;
const ENRICHMENT_RETAILER_KEY_RE = /^ext:retailer:[0-9a-f]{32}$/;
const ENRICHMENT_COLLAPSED_KEY_RE = /^ext:unknown::[0-9a-f]{8}$/;

/**
 * Is it an ENRICHMENT row the backend's cart-link lane can resolve (once PR C is live)? One of the two minted key
 * shapes (never the legacy collapsed `ext:unknown::<8 hex>` one), and — when the read carries a source system — the
 * agent's own.
 * A mirror-system or any other system's row under an `ext:` key is NOT.
 */
export function isEnrichmentCartLinkRow(row, productKey) {
  if (typeof productKey !== "string") return false;
  if (!ENRICHMENT_BRAND_KEY_RE.test(productKey) && !ENRICHMENT_RETAILER_KEY_RE.test(productKey)) return false;
  if (ENRICHMENT_COLLAPSED_KEY_RE.test(productKey)) return false;
  const system = str(own(row, "source_system"));
  return system === null || system === ENRICHMENT_SOURCE_SYSTEM;
}

/**
 * The merchant host of an `https://<host>/products/<handle>` storefront page, lowercased as observed, or null — the
 * shape pivota-backend `storefront_page` (services/reap_enrichment_cart_proof.py) accepts, under the door's seller
 * rules (`judgeSellerUrl`):
 *   - https, and an authority with NO `@` (userinfo, even empty) and NO `:` (a port, even `:443`, which the URL
 *     parser would silently drop);
 *   - the path AS WRITTEN equal to the parsed path, which refuses a query or fragment (so no `?url=` / `?murl=`
 *     redirector), whitespace or control characters, a backslash, a dot segment, and any character the parser
 *     re-encodes — the backend's urlsplit normalises none of them;
 *   - exactly `/products/<handle>` (so no `/r/https://…` path hop, no trailing slash), the handle not `.js`/`.json`;
 *   - a hostname, never one of Pivota's own (so never a `/r?token=` hop or a Pivota PDP).
 */
export function storefrontPageHost(raw) {
  if (typeof raw !== "string") return null;
  const authority = /^https:\/\/([^/?#]*)/i.exec(raw);
  if (!authority || authority[1].includes("@") || authority[1].includes(":")) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (raw.slice(authority[0].length) !== u.pathname) return null;
  const m = /^\/products\/([^/]+)$/.exec(u.pathname);
  if (!m || /\.(js|json)$/i.test(m[1])) return null;
  const host = u.hostname.toLowerCase();
  return HOSTNAME_RE.test(host) && !SELF_HOST_RE.test(host) ? host : null;
}

/** The fields that, when present, must name the SAME merchant as the storefront page (www. folded, as the door). */
const ENRICHMENT_AGREEING_URL_FIELDS = Object.freeze(["source_url", "destination_url"]);
const ENRICHMENT_AGREEING_HOST_FIELDS = Object.freeze(["source_domain", "merchant_domain"]);

/**
 * The host an ENRICHMENT cart-link POST names: `{ host }`, or `{ host: null, code }` when there is none to send.
 *
 * THE STOREFRONT TARGET: the row's `external_redirect_url` — the ONE merchant URL every live enrichment read
 * carries, and the field the door's expected-seller check judges (`judgeSellerUrl`, on `escalationTargetOf`'s
 * parsed form of it), so the host POSTed is a host the door has seen. The shape checks run on the field EXACTLY AS
 * THE ROW CARRIES IT, never on that parsed form: `new URL(...).toString()` drops a `:443` and resolves a `/a/../`
 * that pivota-backend `storefront_page` refuses. Validated as `storefrontPageHost`; anything else is
 * `no_merchant_domain`. As observed, lowercased: `www.` is not stripped from what is sent.
 *
 * EVERY OTHER MERCHANT FIELD MUST AGREE: `source_url`, `destination_url` (hosts of) and `source_domain`,
 * `merchant_domain`, whenever present, must be the same merchant after the door's own fold
 * (`canonicalReapMerchantDomain`: lowercase, one leading `www.`). One that is not — an affiliate `destination_url`,
 * a retailer's page beside a brand's, an unreadable value — is `merchant_domain_conflict`: which seller the row is
 * cannot be told, so nothing is opened. `canonical_url` / `url` are never read (Pivota's own PDP on these reads).
 */
export function enrichmentCartLinkMerchantDomain(row) {
  // The same field, picked the same way, as escalationTargetOf — but unparsed.
  const host = storefrontPageHost(own(row, "external_redirect_url") || own(row, "externalRedirectUrl"));
  if (!host) return { host: null, code: "no_merchant_domain" };
  const want = canonicalReapMerchantDomain(host);
  if (want === null) return { host: null, code: "no_merchant_domain" };
  const others = [];
  for (const key of ENRICHMENT_AGREEING_URL_FIELDS) {
    const raw = own(row, key);
    if (raw === undefined || raw === null || raw === "") continue;
    const u = parseUrl(raw);
    others.push(u ? u.hostname : null);
  }
  for (const key of ENRICHMENT_AGREEING_HOST_FIELDS) {
    const raw = own(row, key);
    if (raw === undefined || raw === null || raw === "") continue;
    others.push(typeof raw === "string" ? raw.trim() : null);
  }
  for (const other of others) {
    if (canonicalReapMerchantDomain(other) !== want) return { host: null, code: "merchant_domain_conflict" };
  }
  return { host };
}

/**
 * Is this read variant the product-level PLACEHOLDER, not a variant the store sells? The producer writes one canonical
 * sku per product: sku key `<product_key>::canonical`, `source_variant_id` the product key (or, for a key too long
 * for the column, the bounded `source_product_id`) — ingestion.py `canonical_sku_variant_id`; and pdpBuilder
 * `buildVariants` restates a variant-less product as ONE entry whose `variant_id` is the product id.
 *
 * EXACT MATCHES ONLY. An entry is the placeholder when it carries at least one id and EVERY id it carries
 * (`variant_id` / `id`, `sku_id`, `source_variant_id`) is exactly one of: the product key, the product key +
 * `::canonical`, the source product id, the product id. Never a prefix match (`isRestatedProductId`): a real
 * variant's sku is `<product_key>::v:<id>`, and pdpBuilder names id-less variants `<product_id>-1`, `<product_id>-2`
 * — each is a DIFFERENT variant, and dropping them would send a multi-variant row as canonical-only. A numeric id
 * (a number, or a digit-only string) always makes the entry real. An entry with no id at all is real (fail closed).
 */
function isPlaceholderVariant(v, row) {
  const ids = [own(v, "variant_id") ?? own(v, "id"), own(v, "sku_id"), own(v, "source_variant_id")]
    .filter((x) => x !== undefined && x !== null);
  if (ids.length === 0) return false;
  const productKey = str(own(row, "product_key"));
  const exact = new Set([productKey, productKey && `${productKey}::canonical`, str(own(row, "source_product_id")), str(own(row, "product_id"))].filter(Boolean));
  // A number is never in `exact` (strings only); a digit-only STRING is refused explicitly, even if a source id is one.
  return ids.every((id) => !/^\d+$/.test(id) && exact.has(id));
}

/**
 * At most ONE variant the store sells on the read: none (canonical-only — the product-level placeholder alone, or
 * nothing), or one. Every other entry counts, with or without an id, so two id-less shade entries are two; a
 * duplicated id is two. Replaces `realVariantCount` for enrichment rows, which would count a placeholder named by
 * the product KEY as a second real variant.
 */
function enrichmentAtMostOneVariant(row) {
  const raw = own(row, "variants");
  if (raw === undefined || raw === null) return true;
  if (!Array.isArray(raw)) return false;
  return raw.filter((v) => !isPlaceholderVariant(v, row)).length <= 1;
}

/** A parsed URL, or null. */
function parseUrl(raw) {
  const s = str(raw);
  if (!s) return null;
  try { return new URL(s); } catch { return null; }
}

/**
 * The merchant's own URLs on the row: the storefront target (or, when it is a Pivota `/r` hop, the `dest` its
 * token names — see ucpExpectedSeller.js `pivotaHopDestination`), then `destination_url`. Pivota hosts never.
 */
function merchantUrlsOf(row, target) {
  const out = [];
  const t = parseUrl(target);
  if (t) {
    const hop = pivotaHopDestination(t);
    if (hop && hop.dest) { const d = parseUrl(hop.dest); if (d) out.push(d); }
    else if (!hop) out.push(t);
  }
  const dest = parseUrl(own(row, "destination_url"));
  if (dest) out.push(dest);
  return out.filter((u) => u.protocol === "https:" && !SELF_HOST_RE.test(u.hostname.toLowerCase()));
}

/**
 * The host the CART-LINK POST names: an explicit merchant field when the read carries one, else the host of the
 * merchant's own URL (a hop's `dest`, then `destination_url`) — AS OBSERVED, lowercased, because the backend's
 * cart-link catalog read compares `lower(source_domain)` byte for byte.
 */
function cartLinkMerchantDomain(row, target) {
  const explicit = str(own(row, "merchant_domain")) || str(own(row, "source_domain"));
  const hosts = explicit
    ? [PRINTABLE_ASCII_RE.test(explicit) ? explicit.toLowerCase() : null]
    : merchantUrlsOf(row, target).map((u) => u.hostname.toLowerCase());
  return hosts.find((h) => h && HOSTNAME_RE.test(h) && !SELF_HOST_RE.test(h)) || null;
}

const SHOPIFY_VARIANT_ID_RE = /^(?:gid:\/\/shopify\/ProductVariant\/)?\d{1,20}$/;

/** A Shopify variant id (`41596313010251`, or its `gid://shopify/ProductVariant/N` form) as bare digits, else null. */
function shopifyVariantDigits(v) {
  if (Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v !== "string" || !SHOPIFY_VARIANT_ID_RE.test(v.trim())) return null;
  return v.trim().replace(/^gid:\/\/shopify\/ProductVariant\//, "");
}

/**
 * The row's ONE variant, named by the read's own variant fields: `variants[0].variant_id` when the row has exactly
 * one variant, and/or `default_variant_id` when it has at most one. Every one of those that is present must be a
 * Shopify variant id and they must AGREE; a `default_variant_id` beside two or more variants names nothing. Live
 * shape (KraveBeauty 24 Carrot Retinal, 2026-09-29): `default_variant_id: "41596313010251"` and
 * `variants: [{ variant_id: "41596313010251", sku_id: "K108-01-0000-EU", … }]`, no `variant=` on any URL.
 */
export function soleReadVariantId(row) {
  const raw = own(row, "variants");
  const variants = Array.isArray(raw) ? raw : [];
  const defaultId = own(row, "default_variant_id");
  const hasDefault = defaultId !== undefined && defaultId !== null && defaultId !== "";
  if (hasDefault && variants.length >= 2) return null;
  const named = [];
  if (variants.length === 1) {
    const only = own(variants[0], "variant_id");
    if (only !== undefined && only !== null && only !== "") named.push(only);
  }
  if (hasDefault) named.push(defaultId);
  if (named.length === 0) return null;
  const digits = named.map(shopifyVariantDigits);
  if (digits.some((d) => d === null) || new Set(digits).size !== 1) return null;
  return digits[0];
}

/**
 * Can ONE variant be named for this row? A `source_variant_id` (on the row, or on its single variant), else the
 * read's sole variant id (`soleReadVariantId`), else the `variant=` of the merchant's own URL on the merchant's
 * host. A PRE-FILTER only: the variant is NEVER sent (the backend accepts no caller variant on this lane and
 * proves the sole one from the seed's storefront evidence — it is the authority), but a row with none is not
 * POSTed to be refused.
 */
function cartLinkVariantResolvable(row, target, merchantDomain) {
  const ids = [own(row, "source_variant_id")];
  const variants = own(row, "variants");
  if (Array.isArray(variants) && variants.length === 1) ids.push(own(variants[0], "source_variant_id"));
  if (ids.some((v) => typeof v === "string" ? SHOPIFY_VARIANT_ID_RE.test(v.trim()) : Number.isSafeInteger(v) && v > 0)) return true;
  if (soleReadVariantId(row) !== null) return true;
  const want = canonicalReapMerchantDomain(merchantDomain);
  return merchantUrlsOf(row, target).some((u) => {
    if (want === null || canonicalReapMerchantDomain(u.hostname) !== want) return false;
    const values = u.searchParams.getAll("variant");
    return values.length === 1 && /^\d{1,20}$/.test(values[0]);
  });
}

/** Real variants by buyerIntake's own readers — the same count the response shaper and checkout resolver use. */
function realVariantCount(row) {
  const pid = str(own(row, "product_id")) || str(own(row, "id"));
  return variantIdsFromProductRead({ product: row }).filter((id) => !isRestatedProductId(id, pid)).length;
}

function rowPrice(row) {
  const currency = str(own(row, "currency"))?.toUpperCase();
  if (!currency || !CURRENCY_RE.test(currency)) return null;
  const amount = safeMinor(majorToIsoMinor(own(row, "price"), currency));
  if (amount === null) return null;
  return { amount, currency };
}

// ---- the hosted URL ----------------------------------------------------------------------------------------

/**
 * The hosted page, if it is one this door may hand a buyer, else null. Requires a PRESENT, FUTURE expiry: the
 * backend publishes one with every hosted URL, and a page whose lifetime nobody stated is not handed to a
 * buyer as a place to type a card.
 */
export function vetHostedUrl(raw, expiresAt, now) {
  const url = str(raw);
  if (!url || url.length > 2048 || /[\u0000- \u007f]/.test(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  const host = parsed.hostname.toLowerCase();
  if (!REAP_HOSTED_URL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return null;
  if (typeof expiresAt !== "string" || expiresAt.trim() === "") return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t) || t <= now) return null;
  // The money filter runs over every answer this door gives (commerceToolSurface step 5). `continue_url` is not
  // one of its verbatim handoff keys, so a hosted URL carrying a secret-shaped query member would reach the
  // buyer with that member redacted — a broken card page. Refused HERE instead, where the answer can still be
  // an honest `incomplete`, rather than discovered by a buyer.
  if (sanitizeResult({ continue_url: url }, { handoffAllowed: true }).continue_url !== url) return null;
  return url;
}

/** The normalised ISO instant when `raw` is a readable timestamp at or before `now`; null otherwise. */
function passedInstant(raw, now) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > now) return null;
  return new Date(t).toISOString();
}

// ---- the response ------------------------------------------------------------------------------------------

function pollSeconds(view) {
  const n = own(view, "poll_after_seconds");
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_POLL_SECONDS ? n : DEFAULT_POLL_SECONDS;
}

function info(code, content, path = "$.status") {
  return { type: "info", code, path, content, content_type: "plain" };
}
function warning(code, content, path = "$.status") {
  return { type: "warning", code, path, content, content_type: "plain" };
}
/** Where the seller messages point: the one line the purchase is for. */
export const REAP_SELLER_PATH = "$.line_items[0]";
/**
 * The seller of the purchase, as two bare-content `info` messages (a platform reads `content`, not prose):
 * `reap.merchant_domain` (the host, lowercased, as observed) and `reap.merchant_id` (the catalog merchant id),
 * each only when known. See THE SELLER in the header.
 */
function sellerMessages({ merchantDomain, productKey }) {
  const out = [];
  if (isObservedMerchantHost(merchantDomain)) out.push(info("reap.merchant_domain", merchantDomain, REAP_SELLER_PATH));
  const merchantId = reapMerchantIdOfProductKey(productKey);
  if (merchantId) out.push(info("reap.merchant_id", merchantId, REAP_SELLER_PATH));
  return out;
}
/** An observed merchant host as the lane sends it: lowercase ASCII, a hostname, never one of Pivota's own. */
function isObservedMerchantHost(v) {
  return typeof v === "string" && PRINTABLE_ASCII_RE.test(v) && v === v.toLowerCase() && HOSTNAME_RE.test(v) && !SELF_HOST_RE.test(v);
}
/** The view's `merchant_domain`, lowercased (ASCII checked first), if it is a host this door would publish. */
function viewMerchantDomain(view) {
  const raw = str(own(view, "merchant_domain"));
  const lower = raw && PRINTABLE_ASCII_RE.test(raw) ? raw.toLowerCase() : null;
  return isObservedMerchantHost(lower) ? lower : null;
}
function pollMessage(seconds) {
  // `content` is the bare integer so a platform can read the cadence without parsing prose.
  return info("reap.poll_after_seconds", String(seconds));
}

const STATE_MESSAGES = Object.freeze({
  resolving: "Pivota has opened this purchase with the payment partner (Reap) and is confirming the item with the merchant. Nothing is charged. Poll get_checkout for the next step.",
  needs_enrollment: "The buyer must add a card on the payment partner's secure page at continue_url. Pivota never sees the card. Poll get_checkout afterwards.",
  quoting: "The merchant is pricing this order (item, shipping and tax). Nothing is charged. Poll get_checkout for the approval step.",
  awaiting_approval: "The order is priced. The buyer must review the total and approve it on the payment partner's page at continue_url before expires_at. That window is usually the merchant quote's own TTL (about five minutes from pricing), after which the purchase fails and a new checkout is needed. Nothing is charged until they approve.",
  processing: "The buyer approved; the payment partner is placing the order with the merchant. Poll get_checkout for the outcome.",
  completed: "The order was placed with the merchant through the payment partner.",
  refused: "This purchase was not placed: it could not be matched or priced exactly for this merchant. Nothing was charged.",
  failed: "This purchase could not be completed. Nothing further will happen on it.",
  expired: "This purchase expired before the buyer finished it. Nothing was charged. Create a new checkout to try again.",
});
// One sentence more for the terminal reasons a buyer agent can act on. CONSTANT text keyed by a code that already
// passed REASON_RE; no backend text reaches it.
const REASON_HINTS = Object.freeze({
  approval_window_lapsed: " The buyer did not approve before the quote expired (about five minutes); nothing was charged. Create a new checkout to try again.",
  // DEFENSIVE FALLBACK: backend #2425's review round (B4) no longer ends a purchase as `offer_code_rejected` --
  // a refused code with no budget left is released and re-quoted without it. Kept so a backend that ever
  // writes the reason again still gets an actionable answer here.
  offer_code_rejected: " The merchant refused the buyer's offer code and there was no time left to price the order without it; nothing was charged. Create a NEW checkout WITHOUT the code, with a NEW idempotency key (the old key replays this canceled purchase).",
});
// Terminal states each reason's hint may appear on.
const REASON_HINT_STATES = Object.freeze({ approval_window_lapsed: "failed", offer_code_rejected: "refused" });
// A deadline the backend published that has ALREADY PASSED, on a row its poller has not yet closed. Saying "the
// page is not available yet, poll again" here would be false in both halves: the page was available, and polling
// will only ever find the purchase failed. Content is a CONSTANT sentence plus the normalised instant.
const DEADLINE_PASSED_MESSAGE =
  "The approval window closed before the buyer approved; the link is no longer valid and nothing was charged. Poll get_checkout once more for the final state, then create a new checkout to try again.";
// What the buyer's offer code came to (backend `offer_code_outcome`, migration 247). CONSTANT text keyed by a
// value that must be one of these four; no backend text and no code value reaches a message. The two refusals
// use the UCP discount extension's own rejection codes, at the path of the code (`dev.ucp.shopping.discount`:
// "Rejected codes communicated via messages[]", type warning).
export const DISCOUNT_CODE_PATH = "$.discounts.codes[0]";
const OFFER_CODE_MESSAGES = Object.freeze({
  applied: ["info", "reap.offer_code_applied", "$.discounts", "The merchant accepted the buyer's offer code; the discount is in discounts.applied and in totals as a discount row, and is already in the total."],
  no_discount: ["info", "reap.offer_code_no_discount", "$.discounts", "The merchant accepted the buyer's offer code but it took nothing off this order."],
  dropped_invalid: ["warning", "discount_code_invalid", DISCOUNT_CODE_PATH, "The merchant did not accept the buyer's offer code. The purchase continued WITHOUT it: the total has no discount. Tell the buyer before they approve."],
  dropped_expired: ["warning", "discount_code_expired", DISCOUNT_CODE_PATH, "The buyer's offer code has expired. The purchase continued WITHOUT it: the total has no discount. Tell the buyer before they approve."],
});
const APPLIED_WITHOUT_ROW_MESSAGE =
  "The merchant accepted the buyer's offer code; the discount is in discounts.applied and is already in the total.";
// The backend refused the code by ITS rule (400 invalid_offer_code): the backend owns the rule, this door only
// relays that it failed. Rides on the storefront answer like the consent hint.
export const REAP_OFFER_CODE_REFUSED_MESSAGE = Object.freeze({
  type: "warning",
  code: "discount_code_invalid",
  path: "$.discounts.codes[0]",
  content: "The offer code was not accepted for the Reap payment-partner route (it is empty, too long or contains characters a code cannot carry), so that route was not opened. Resend create_checkout without the code, or with a corrected one, if the buyer wants the Reap route.",
  content_type: "plain",
});
const PENDING_WITHOUT_URL_MESSAGE =
  "The buyer's next step is on the payment partner's page, but that page is not available yet. Poll get_checkout again.";
const UNRECOGNISED_STATE_MESSAGE =
  "The purchase is in progress at a step this door does not describe yet. Nothing is charged by this step alone. Poll get_checkout again.";
const VIEW_UNAVAILABLE_MESSAGE = [
  "The purchase's current state could not be read just now; nothing has been lost. The line item, price and",
  "currency shown are the ones recorded in this checkout id when it was created, NOT the payment partner's",
  "current view. Poll get_checkout again.",
].join(" ");
const LANE_MESSAGE = [
  "This checkout is fulfilled through Reap, a payment partner: the buyer enters a card and approves the total on",
  "Reap's own pages, and Reap places the order with the merchant. Pivota never receives card details and does not",
  "hold or move money. This checkout cannot be updated or completed through update_checkout / complete_checkout.",
].join(" ");

/**
 * The priced breakdown rows between `subtotal` and `total`, in UCP's vocabulary -- ONLY when they add up to the
 * total the backend reported (which is Reap's own final amount), else none. `discount` is NEGATIVE (UCP
 * `total.json`: a discount amount is `exclusiveMaximum: 0`). Tax is a row only when it is NOT already inside the
 * prices (`tax_included`, pivota-backend migration 247); when it is, the total's text says so instead.
 */
// The backend's own reconciliation tolerance (`QUOTE_RECONCILE_TOLERANCE_MINOR`, services/reap_agentic_purchase.py):
// a quote whose total is within one minor unit of its components is accepted there, so a view can carry that
// residual. It is shown as its own ROUNDING row rather than hiding the breakdown (review of #2323, S1).
export const REAP_BREAKDOWN_ROUNDING_TOLERANCE_MINOR = 1;

/**
 * `{ rows, unreconciled }`. `rows` are the priced breakdown rows between `subtotal` and `total`, in UCP's
 * vocabulary, and they ALWAYS add up to the total when present. A residual of at most
 * `REAP_BREAKDOWN_ROUNDING_TOLERANCE_MINOR` becomes a "Rounding" row -- `fee` when positive, `discount` when
 * negative, so each keeps UCP's sign rule (total.json: fee >= 0, discount < 0). A larger residual shows NO
 * breakdown (`unreconciled: true`, which the caller logs): this door never prints rows that do not add up.
 */
function breakdownRows({ lineTotal, total, shipping, tax, taxIncluded, discount }) {
  const rows = [];
  if (shipping !== null && shipping !== undefined) rows.push({ type: "fulfillment", amount: shipping, display_text: "Shipping, as quoted by the merchant" });
  if (tax !== null && tax !== undefined && taxIncluded !== true && tax > 0) rows.push({ type: "tax", amount: tax, display_text: "Tax, as quoted by the merchant" });
  if (discount) rows.push({ type: "discount", amount: -discount, display_text: "Offer code discount applied by the merchant" });
  const residual = total - rows.reduce((acc, r) => acc + r.amount, lineTotal);
  if (residual === 0) return { rows, unreconciled: false };
  if (Math.abs(residual) <= REAP_BREAKDOWN_ROUNDING_TOLERANCE_MINOR) {
    return { rows: [...rows, { type: residual > 0 ? "fee" : "discount", amount: residual, display_text: "Rounding" }], unreconciled: false };
  }
  return { rows: [], unreconciled: true };
}

/**
 * THE LINE ITEM'S DISPLAYED TITLE: `<product name> — <variant title>`, or the product name alone. Both halves are
 * MERCHANT text. A half is returned AS MAIN RETURNED IT (trimmed, byte for byte) unless it carries right-to-left
 * text; only then is it wrapped in FIRST STRONG ISOLATE ... POP DIRECTIONAL ISOLATE (U+2068 ... U+2069).
 *
 * WHY ISOLATE. The backend strips embeddings, overrides and isolates from merchant text but KEEPS the marks, and
 * real right-to-left letters exist. A name ending in RLM or an RTL letter makes the neutrals and digits that FOLLOW
 * it resolve right-to-left: "Silky Matte Lip Ink — 07 BURGUNDY INK" can display as "...Ink07 — BURGUNDY INK", and
 * digit runs can reorder across the dash. An isolate makes the half one neutral unit to its surroundings.
 *
 * WHY ONLY THEN. A title without RTL text cannot reorder, and a plain title must stay plain: it is compared with the
 * catalog title and with the storefront escalation lane's (which never isolates), it is forwarded to channels where
 * one invisible character changes the encoding (SMS: GSM-7 -> UCS-2), and partners read it verbatim. So an
 * all-Latin (or CJK, or any LTR) title is byte-identical to what this door returned before isolates existed.
 *
 * THE TRIGGER (`RTL_BEARING_RE`): a character in Unicode's default right-to-left ranges -- the blocks
 * DerivedBidiClass.txt assigns Bidi_Class R or AL by default (Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan,
 * Mandaic, the Hebrew/Arabic presentation forms, and the SMP RTL blocks incl. Adlam) -- plus RLM (U+200F); ALM
 * (U+061C) is inside the Arabic block. Explicit ranges because ECMAScript has no `\p{Bidi_Class=...}` (Node rejects
 * it), and a Script list must name every RTL script and lags the engine's Unicode version, where these default
 * ranges already cover the code points Unicode has not assigned yet. Measured against
 * Python unicodedata 16.0: every assigned R/AL code point is inside; the extra members are the same scripts' marks,
 * digits and punctuation (NSM/AN/EN/ON/...), for which an isolate is harmless. U+FEFF (BN) is excluded.
 *
 * INSIDE AN ISOLATED HALF, line and paragraph breaks (CR, LF, U+001C..U+001E, U+0085, U+2028, U+2029) are folded
 * to spaces -- a paragraph separator ends every isolate, so one inside a half would close ours early.
 *
 * IN EVERY HALF, embedding, override and isolate controls (U+202A..U+202E, U+2066..U+2069) are removed. The backend
 * already removes them, so on its output this is a no-op; it keeps every pair balanced (a stray PDI would close
 * OUR isolate early) and keeps a stray override from reaching the dash.
 *
 * ABSENT AND DUPLICATE HALVES are judged on the VISIBLE text: format characters (Cf) removed, whitespace runs
 * collapsed, trimmed. A half that is only RLM, LRM, ZWSP, ... is absent -- a missing name makes the title null
 * (the line shows the item id), a missing variant is omitted -- and a variant equal to the name on that key (a
 * trailing RLM on one of them included) is omitted.
 *
 * The checkout id and the idempotency key never include the title (encodeReapCheckoutId, reapIdempotencyKey).
 */
const BIDI_FSI = "\u2068";
const BIDI_PDI = "\u2069";
const RTL_BEARING_RE = /[\u0590-\u08FF\uFB1D-\uFDCF\uFDF0-\uFDFF\uFE70-\uFEFE\u200F\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const BIDI_NESTING_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const PARAGRAPH_BREAK_RE = /[\n\r\u001C-\u001E\u0085\u2028\u2029]/g;
const FORMAT_CHAR_RE = /\p{Cf}/gu;

/** `{ key, display }` for one merchant half, or null when it has no visible text. */
function titleHalf(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(BIDI_NESTING_CONTROL_RE, "").trim();
  const key = text.replace(FORMAT_CHAR_RE, "").replace(/\s+/g, " ").trim();
  if (!key) return null;
  if (!RTL_BEARING_RE.test(text)) return { key, display: text };
  return { key, display: `${BIDI_FSI}${text.replace(PARAGRAPH_BREAK_RE, " ").trim()}${BIDI_PDI}` };
}

export function reapLineItemTitle(productName, variantTitle) {
  const name = titleHalf(productName);
  if (!name) return null;
  const variant = titleHalf(variantTitle);
  return variant && variant.key !== name.key ? `${name.display} — ${variant.display}` : name.display;
}

function lineItemsAndTotals({ itemId, title, unitMinor, quantity, quotedTotal, finalTotal, discount, shipping, tax, taxIncluded, degraded }) {
  const lineTotal = unitMinor * quantity;
  if (!Number.isSafeInteger(lineTotal)) return null;
  const total = finalTotal ?? quotedTotal ?? lineTotal;
  const priced = (finalTotal !== null && finalTotal !== undefined) || (quotedTotal !== null && quotedTotal !== undefined);
  const baseText = finalTotal !== null && finalTotal !== undefined
    ? "Total charged, including the merchant's shipping and tax"
    : quotedTotal !== null && quotedTotal !== undefined
      ? "Quoted total, including the merchant's shipping and tax"
      : "Expected total before the merchant's shipping and tax";
  const totalText = priced && taxIncluded === true ? `${baseText} (tax is included in the prices)` : baseText;
  const breakdown = priced && !degraded
    ? breakdownRows({ lineTotal, total, shipping, tax, taxIncluded, discount })
    : { rows: [], unreconciled: false };
  const rows = breakdown.rows;
  return {
    unreconciled: breakdown.unreconciled,
    discountRowShown: rows.some((r) => r.type === "discount" && r.display_text !== "Rounding"),
    lineItems: [{
      id: "li_1",
      item: { id: itemId, title: title || itemId, price: unitMinor },
      quantity,
      totals: [
        { type: "subtotal", amount: lineTotal },
        { type: "total", amount: lineTotal },
      ],
    }],
    totals: [
      {
        type: "subtotal",
        amount: lineTotal,
        display_text: degraded ? "Subtotal as recorded at checkout creation (current state unavailable)" : "Subtotal at Pivota's catalog price",
      },
      // Shipping, tax (when not in the prices) and the offer-code discount (negative), ONLY when they reconcile
      // with the total -- which is the partner's own final amount; this door computes nothing.
      ...rows,
      { type: "total", amount: total, display_text: degraded ? "Expected total as recorded at checkout creation (current state unavailable)" : totalText },
    ],
  };
}

/**
 * The `incomplete` answer for a checkout whose backend read FAILED (transport, 5xx, any 4xx other than
 * `purchase_not_found`, timeout, a body that is not the documented shape). The snapshot in the id is the ONLY
 * source here, and the answer SAYS so (`reap.view_unavailable`). Never terminal: the purchase may be progressing,
 * and telling the agent otherwise would invite a second purchase.
 */
export function buildDegradedReapCheckout({ id, snapshot, now = Date.now(), env = process.env }) {
  const lt = lineItemsAndTotals({ itemId: snapshot.productId, title: null, unitMinor: snapshot.unitMinor, quantity: snapshot.quantity, degraded: true });
  return buildUcpCheckoutEnvelope({
    id,
    status: "incomplete",
    currency: snapshot.currency,
    lineItems: lt.lineItems,
    totals: lt.totals,
    expiresAt: new Date(now + ESCALATION_TTL_MS).toISOString(),
    env,
    messages: [
      warning("reap.view_unavailable", VIEW_UNAVAILABLE_MESSAGE, "$"),
      pollMessage(DEFAULT_POLL_SECONDS),
      // NO seller messages: the only source here is the id, which travels through the caller, and a crafted id
      // must not be able to make this door name a seller. A platform keeps the seller its last good answer named.
      info("reap.lane", LANE_MESSAGE, "$"),
    ],
  });
}

const STATE_SHAPE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The backend's purchase view -> the UCP checkout. EVERY displayed field comes from `view`: the item id (our
 * catalog `product_key`), title, quantity, currency, unit price and totals. The snapshot in the id is consulted
 * for ONE thing — that `view.id` is the purchase this id names. A view missing any of those fields is not the
 * documented shape: null, and the caller answers the degraded checkout, which says it is showing the snapshot.
 *
 * An UNKNOWN but well-formed state (a state the backend added after this door) is `incomplete` with a named
 * message — not a failed read — and `onUnrecognisedState` is told so the caller can log it once.
 */
export function mapReapPurchaseToCheckout({ id, snapshot, view, now = Date.now(), env = process.env, onUnrecognisedState, onUnreconciled }) {
  if (!isPlainObject(view)) return null;
  if (own(view, "id") !== snapshot.purchaseId) return null;
  const state = str(own(view, "state"));
  if (!state || !STATE_SHAPE_RE.test(state)) return null;
  const known = Object.prototype.hasOwnProperty.call(STATE_TO_STATUS, state);

  const totals = own(view, "totals");
  if (!isPlainObject(totals)) return null;
  const currency = typeof totals.currency === "string" && CURRENCY_RE.test(totals.currency) ? totals.currency : null;
  const unitMinor = safeMinor(totals.our_price_minor);
  const quantity = own(view, "quantity");
  // THE ITEM ID ECHOES THE CALLER'S — the id `create_checkout` was sent and will accept again, exactly as the
  // escalation lane echoes it. Our catalog `product_key` is never published (it names an internal merchant id);
  // it is the HIDDEN cross-check that the backend's view is of the product this checkout was opened for, and a
  // mismatch is a failed read.
  const itemId = snapshot.productId;
  if (str(own(view, "product_key")) !== snapshot.productKey) return null;
  if (!currency || unitMinor === null || !itemId
    || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > REAP_MAX_QUANTITY) return null;
  const title = reapLineItemTitle(own(view, "product_name"), own(view, "variant_title"));
  const lt = lineItemsAndTotals({
    itemId,
    title,
    unitMinor,
    quantity,
    quotedTotal: safeMinor(totals.quoted_total_minor),
    finalTotal: state === "completed" ? safeMinor(totals.final_total_minor) : null,
    discount: safeMinor(totals.discount_minor) || null,
    shipping: safeMinor(totals.shipping_minor),
    tax: safeMinor(totals.tax_minor),
    taxIncluded: totals.tax_included === true,
    degraded: false,
  });
  if (!lt) return null;
  if (lt.unreconciled && typeof onUnreconciled === "function") onUnreconciled();

  let status = known ? STATE_TO_STATUS[state] : "incomplete";
  let continueUrl;
  let expiresAt = new Date(now + ESCALATION_TTL_MS).toISOString();
  const messages = [];
  if (!known) {
    if (typeof onUnrecognisedState === "function") onUnrecognisedState(state);
    messages.push(info("reap.state_unrecognised", UNRECOGNISED_STATE_MESSAGE));
  } else if (PENDING_BUYER_STATES.has(state)) {
    // The ONLY states in which a hosted URL is read at all.
    //
    // THE DEADLINE IS `approval_deadline`, NOT THE PAGE'S OWN EXPIRY. Measured 2026-09-25 in the Reap sandbox: the
    // hosted page's `expiresAt` is created + 15 min, but an unapproved checkout is FAILED (not EXPIRED, never
    // PROCESSING) seconds after the QUOTE's `expiresAt` (created + 5 min). The backend publishes the earlier of the
    // two as `approval_deadline` on 'awaiting_approval'; `hosted_url_expires_at` is the fallback for
    // 'needs_enrollment' (nothing quoted yet) and for a backend that does not send the field. A deadline that is
    // PRESENT but unreadable is not skipped over for the longer one — `vetHostedUrl` refuses it and the answer is
    // `incomplete` — because the alternative is a link published with ten minutes it does not have.
    const deadline = own(view, "approval_deadline") ?? own(view, "hosted_url_expires_at");
    continueUrl = vetHostedUrl(own(view, "hosted_url"), deadline, now) || undefined;
    if (continueUrl) {
      expiresAt = new Date(Date.parse(deadline)).toISOString();
      messages.push(info(`reap.${state}`, STATE_MESSAGES[state], "$.continue_url"));
      // The bare instant, so a platform can read the deadline without parsing prose — the same reason
      // `reap.poll_after_seconds` is a bare integer. The same value is `expires_at` on the checkout.
      if (state === "awaiting_approval") messages.push(info("reap.approval_deadline", expiresAt, "$.expires_at"));
    } else {
      status = "incomplete";
      const passed = state === "awaiting_approval" ? passedInstant(own(view, "approval_deadline"), now) : null;
      if (passed) messages.push(warning("reap.approval_deadline_passed", `${DEADLINE_PASSED_MESSAGE} Closed at ${passed}.`));
      else messages.push(info("reap.hosted_page_not_ready", PENDING_WITHOUT_URL_MESSAGE));
    }
  } else if (state === "completed") {
    messages.push(info("reap.completed", STATE_MESSAGES.completed));
    const ref = str(own(view, "order_reference"));
    // `content` is the merchant's order reference verbatim, so a platform can read it without parsing prose.
    if (ref && ORDER_REFERENCE_RE.test(ref)) messages.push(info("reap.order_reference", ref));
  } else if (TERMINAL_STATES.has(state)) {
    // Backend reason codes come in two cases (`options:sole_label_differs:size`, `ENROLLMENT_NOT_ACTIVE`,
    // `AGENTIC_…`): shown LOWERCASED, and only when the folded value is a plain code.
    const raw = str(own(view, "refusal_reason")) || str(own(view, "last_error_code"));
    const reason = raw ? raw.toLowerCase() : null;
    const named = reason && REASON_RE.test(reason) ? ` Reason: ${reason}.` : "";
    // Keyed on the state as well as the code: the backend writes `approval_window_lapsed` on 'failed' only.
    const hint = named && Object.prototype.hasOwnProperty.call(REASON_HINTS, reason) && REASON_HINT_STATES[reason] === state ? REASON_HINTS[reason] : "";
    messages.push(warning(`reap.purchase_${state}`, `${STATE_MESSAGES[state]}${named}${hint}`));
  } else {
    messages.push(info(`reap.${state}`, STATE_MESSAGES[state]));
  }
  const outcome = str(own(view, "offer_code_outcome"));
  const knownOutcome = outcome && Object.prototype.hasOwnProperty.call(OFFER_CODE_MESSAGES, outcome) ? outcome : null;
  if (knownOutcome) {
    const [level, code, path, text] = OFFER_CODE_MESSAGES[knownOutcome];
    // `applied` claims a discount ROW only when one was emitted (S1): a breakdown that did not reconcile is
    // not shown, and the message must not point at a row that is not there.
    const content = knownOutcome === "applied" && !lt.discountRowShown ? APPLIED_WITHOUT_ROW_MESSAGE : text;
    messages.push((level === "warning" ? warning : info)(code, content, path));
  }
  if (!TERMINAL_STATES.has(state)) messages.push(pollMessage(pollSeconds(view)));
  // The seller, from the VIEW (its `merchant_domain`, and the `product_key` already checked equal to the id's).
  messages.push(...sellerMessages({ merchantDomain: viewMerchantDomain(view), productKey: snapshot.productKey }));
  messages.push(info("reap.lane", LANE_MESSAGE, "$"));

  const out = buildUcpCheckoutEnvelope({
    id,
    status,
    continueUrl,
    currency,
    lineItems: lt.lineItems,
    totals: lt.totals,
    expiresAt,
    env,
    messages,
  });
  const discounts = discountsObject(view, knownOutcome);
  return discounts ? { ...out, discounts } : out;
}

// A code as the backend echoes it (the buyer's own input, in flight; NULL once terminal). Bounded like the
// input rule's shape; a value outside it is simply not echoed.
function echoableCode(raw) {
  return typeof raw === "string" && raw.length > 0 && [...raw].length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(raw) ? raw : null;
}

/**
 * UCP's `discounts` object (`dev.ucp.shopping.discount`): `codes` echoes the code while the backend still holds
 * it, and `applied` carries the one code-based discount when the merchant applied it -- `amount` POSITIVE there
 * (types/amount.json, minimum 0), the negative is the `discount` total row. Absent when no code is known.
 */
function discountsObject(view, outcome) {
  const code = echoableCode(own(view, "offer_code"));
  const totals = own(view, "totals");
  const amount = isPlainObject(totals) ? safeMinor(totals.discount_minor) : null;
  const applied = outcome === "applied" && amount ? [{ ...(code ? { code } : {}), title: "Offer code", amount }] : [];
  if (!code && !applied.length) return null;
  return { ...(code ? { codes: [code] } : {}), applied };
}

// ---- the lane ----------------------------------------------------------------------------------------------

function emit(log, level, fields) {
  if (!log) return;
  const fn = typeof log[level] === "function" ? log[level] : log.warn;
  if (typeof fn !== "function") return;
  try {
    // CODES ONLY. Never a buyer field, a product or purchase id, a URL, or a backend body.
    fn.call(log, { event: "reap_agentic_lane", ...fields }, "reap agentic lane");
  } catch {
    // a logging failure must never change a checkout answer
  }
}

// Once per process per code: the two conditions logged this way are properties of a CALLER or of the BACKEND,
// not of one request, and a line per request would be noise. Bounded.
const LOGGED_ONCE = new Set();
function emitOnce(log, level, fields, key) {
  if (LOGGED_ONCE.has(key)) return;
  if (LOGGED_ONCE.size >= 64) return;
  LOGGED_ONCE.add(key);
  emit(log, level, fields);
}
/** Tests only. */
export function resetReapLaneLogOnceForTest() {
  LOGGED_ONCE.clear();
}

function attestedOrBodyEmail(attested, bodyValue) {
  const att = isPlainObject(attested) ? str(attested.attested_email) : null;
  if (att) return att;
  return normalizeEmail(bodyValue) || null;
}

// A 400 on POST proves NOTHING about eligibility: the backend checks consent and the address BEFORE it checks
// the merchant, so a non-eligible row answers `consent_required` too. The door therefore never refuses on these.
// It falls through to the storefront answer exactly as it would have, and — only for the two answers that mean
// "the buyer block is short" — attaches ONE informational message so the buyer agent can learn what the Reap route
// would need. The message is CONSTANT (fixed text, fixed field paths): no backend text and no request value can
// reach it.
const CONSENT_HINT_CODES = new Set(["consent_required"]);
const BUYER_DETAIL_HINT_CODES = new Set(["invalid_request", "invalid_address"]);
export const REAP_AVAILABLE_WITH_CONSENT_MESSAGE = Object.freeze({
  type: "info",
  code: "reap.available_with_consent",
  path: "$",
  content: [
    "This item may also be purchasable through Pivota's payment partner Reap, where the buyer adds a card and",
    "approves the total on Reap's own pages. To be offered that route, send create_checkout again with",
    "`checkout.buyer.consent_version` (the version tag of the Pivota terms the buyer accepted) and a destination",
    "carrying `checkout.fulfillment.methods[0].destinations[0].last_name` and",
    "`checkout.fulfillment.methods[0].destinations[0].phone_number`. Until then, this checkout completes on the",
    "seller's storefront as described here.",
  ].join(" "),
  content_type: "plain",
});

/**
 * THE DOOR-LEVEL EXPECTED-SELLER CHECK. Called by commerceToolSurface.callTool for EVERY UCP create_checkout,
 * BEFORE the Reap lane, the storefront escalation and the kernel. A no-op when the create carries no
 * `checkout.reap.expected_merchant_domain` (the adapter accepts that member only while the lane is on).
 * Otherwise every line's row is read (the SAME memoized read the lanes and the resolver use, so a match costs
 * no second read) and EVERY destination it can sell from or send the buyer to must be the expected seller
 * (`judgeRowSeller`: the explicit merchant fields AND the storefront target; for a native row the merchant's
 * registered store destinations). Throws `QUOTE_REQUIRED` / `ucp_seller_mismatch` — with the other seller's
 * host (`merchant_domain`) and the row's catalog `merchant_id` in the detail when known — on a different seller
 * (`cause: "different_seller"`), and FAILS CLOSED (`cause: "seller_unconfirmed"`) on a read that fails, a row
 * that is absent, a row with no destination, or a destination that is a Pivota hop, a redirector or unreadable.
 */
export async function assertExpectedSeller({ ucpArgs, params, executor, ctx, timeoutMs }) {
  const expected = reapExpectedMerchantDomain(ucpArgs);
  if (expected === undefined) return;
  const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
  const items = Array.isArray(quote.items) ? quote.items : [];
  const ids = items.map((it) => (isPlainObject(it) ? str(it.product_id) : null));
  if (ids.length === 0 || ids.some((id) => !id)) {
    throw sellerMismatchRefusal({ lineIndex: null, cause: "seller_unconfirmed" });
  }
  let rows;
  try {
    rows = await readCheckoutRows(ids.map((product_id) => ({ product_id, quantity: 1 })), executor, ctx, { timeoutMs });
  } catch {
    throw sellerMismatchRefusal({ lineIndex: null, cause: "seller_unconfirmed" });
  }
  ids.forEach((id, lineIndex) => {
    const row = rows.get(id);
    // EVERY destination the row can sell from or send the buyer to (ucpExpectedSeller.js, THE RULE).
    const verdict = judgeRowSeller(expected, row, isPlainObject(row) ? escalationTargetOf(row) : null);
    if (verdict.ok) return;
    throw sellerMismatchRefusal({
      lineIndex,
      merchantDomain: verdict.cause === "different_seller" ? verdict.host : null,
      merchantId: isPlainObject(row) ? reapMerchantIdOfProductKey(productKeyOf(row)) : null,
      cause: verdict.cause,
    });
  });
}

/**
 * Called by commerceToolSurface.callTool on the UCP dialect for the checkout operations, AFTER argument
 * translation + the allowlist + the identity check, and BEFORE the storefront escalation lane. Returns a UCP
 * checkout to answer with, or null to fall through to the next lane untouched.
 *
 * Never refuses a create: every create either opens a purchase or returns null. When the backend's 400 says the
 * buyer block was short (`consent_required`, or `invalid_request`/`invalid_address` with a buyer field actually
 * missing), the lane pushes `REAP_AVAILABLE_WITH_CONSENT_MESSAGE` onto `hints` and returns null; the door
 * attaches it to the storefront escalation answer. Throws only the update/complete refusals on a `reap_` id.
 */
export async function tryReapAgenticCheckout({
  op,
  params,
  ctx,
  executor,
  ucpArgs,
  attested = {},
  client,
  log,
  env = process.env,
  now = Date.now(),
  timeoutMs,
  shouldOfferPurchase,
  clock,
  hints,
}) {
  if (!reapAgenticLaneEnabled(env)) return null;
  if (!client || typeof client.startPurchase !== "function" || typeof client.getPurchase !== "function") return null;
  const opId = op && op.id;

  if (opId === "create_checkout_session") {
    return createReapCheckout({ params, ctx, executor, ucpArgs, attested, client, log, env, now, timeoutMs, shouldOfferPurchase, clock, hints });
  }

  const sessionId = str(own(params, "session_id"));
  const decoded = sessionId ? decodeReapCheckoutId(sessionId) : null;
  if (!decoded) return null; // not one of ours: the kernel path answers it (unknown id included)

  if (opId === "get_checkout_session") {
    // A caller the rail cannot serve gets TODAY's answer: the lane is skipped (no backend call, nothing rewritten),
    // exactly as on create. It is neither "unknown id" by the lane's hand nor an `incomplete` it cannot back.
    if (typeof client.hasCallerCredentials === "function" && !client.hasCallerCredentials()) {
      emitOnce(log, "info", { op: opId, outcome: "skipped", code: "no_caller_credentials" }, "no_caller_credentials_get");
      return null;
    }
    const res = await client.getPurchase(decoded.purchaseId);
    if (res && res.kind === "accepted") {
      const out = mapReapPurchaseToCheckout({
        id: sessionId,
        snapshot: decoded,
        view: res.purchase,
        now,
        env,
        onUnrecognisedState: () => emitOnce(log, "warn", { op: opId, outcome: "state_unrecognised", code: "unknown_state" }, "unknown_state"),
        onUnreconciled: () => emit(log, "warn", { op: opId, outcome: "breakdown_unreconciled", code: "breakdown_unreconciled" }),
      });
      if (out) return out;
      emit(log, "warn", { op: opId, outcome: "degraded", code: "malformed_view" });
      return buildDegradedReapCheckout({ id: sessionId, snapshot: decoded, now, env });
    }
    if (res && res.kind === "not_found") {
      // 404 `purchase_not_found` — unknown, or ANOTHER buyer's (the backend answers both alike, on purpose):
      // the kernel path gives the unknown-id answer. It is handed only what it needs to give it — the purchase
      // id, not the line snapshot the full id carries.
      emit(log, "info", { op: opId, outcome: "unknown_id", code: res.code || "not_found" });
      params.session_id = `${REAP_CHECKOUT_ID_PREFIX}${decoded.purchaseId}`;
      return null;
    }
    // Anything else — unavailable, 401/403/429/400, 404 `not_available_on_this_rail` (the dial turned off
    // mid-purchase), no credentials on this call — is NOT evidence the purchase does not exist. An "unknown id"
    // here would invite a re-create and a second purchase; the honest answer is `incomplete`, poll again.
    emit(log, "warn", { op: opId, outcome: "degraded", code: (res && res.code) || (res && res.kind) || "no_answer" });
    return buildDegradedReapCheckout({ id: sessionId, snapshot: decoded, now, env });
  }

  if (opId === "update_checkout_session" || opId === "complete_checkout_session") {
    const update = opId === "update_checkout_session";
    throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", {
      reason: update ? "ucp_reap_update_refused" : "ucp_reap_complete_refused",
      dialect: "ucp",
      acp_message: update
        ? `This checkout is fulfilled through Reap and cannot be changed here. To buy something different, create a new checkout; to continue this one, poll get_checkout and send the buyer to its continue_url when one is present.${reapOfferCode(ucpArgs) !== undefined ? " An offer code can only be set when a Reap checkout is CREATED (checkout.discounts.codes on create_checkout); to use one, create a new checkout with it." : ""}`
        : "This checkout completes on Reap's own hosted page, not through complete_checkout — Pivota takes no payment for it. Poll get_checkout and send the buyer to its continue_url to enter a card or approve the total.",
      acp_detail: { reason: "reap_agentic_checkout", completes_at: "continue_url" },
    });
  }

  return null;
}

async function createReapCheckout({ params, ctx, executor, ucpArgs, attested, client, log, env, now, timeoutMs, shouldOfferPurchase, clock, hints }) {
  const skip = (code) => { emit(log, "info", { op: "create_checkout_session", outcome: "skipped", code }); return null; };
  const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
  const items = Array.isArray(quote.items) ? quote.items.filter((it) => isPlainObject(it) && str(it.product_id)) : [];
  // SINGLE LINE: one purchase is one variant at Reap. A multi-line cart is not this lane's (quietly: most carts
  // are not, and a log per multi-line cart would be noise).
  if (items.length !== 1 || (Array.isArray(quote.items) && quote.items.length !== 1)) return null;
  const productId = str(items[0].product_id);
  const quantity = items[0].quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > REAP_MAX_QUANTITY) return null;

  // 1. THE CALLER CAN USE THE RAIL AT ALL. The backend needs the agent's API key AND the buyer's user token; an
  // MCP-OAuth caller, or one without X-Agent-User-JWT, can never be served, so the lane is skipped silently —
  // logged once per process, not per request — and the door answers exactly as it did without this lane.
  if (typeof client.hasCallerCredentials === "function" && !client.hasCallerCredentials()) {
    emitOnce(log, "info", { op: "create_checkout_session", outcome: "skipped", code: "no_caller_credentials" }, "no_caller_credentials");
    return null;
  }

  const gateClock = typeof clock === "function" ? clock : Date.now;
  const startedAt = gateClock();
  const doorBudgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS;

  // The SAME read the escalation lane and the checkout resolver perform, through the SAME per-call memo: a
  // row this lane declines is not read twice. A failed read is NOT this lane's refusal to give — it falls
  // through, and the next lane answers from the same (memoized) outcome exactly as it would have without us.
  let rows;
  try {
    rows = await readCheckoutRows([{ product_id: productId, quantity }], executor, ctx, { timeoutMs });
  } catch {
    return skip("row_read_failed");
  }
  const row = rows.get(productId);

  // 2. NATIVE FIRST. A row Pivota transacts itself never enters this lane.
  const target = escalationTargetOf(row);
  if (!target) return null;

  // 3. ROW ELIGIBILITY — cheap pre-filters; the backend decides authoritatively and its refusal falls through.
  const productKey = productKeyOf(row);
  if (!productKey) return skip("no_product_key");
  // A Shopify row takes the VARIANT lane (unchanged). An external-seed row takes the CART-LINK lane DIRECTLY while
  // both dials are on; with the cart-link dial off it is skipped exactly as before.
  const cartLinkDirect = !isShopifyRow(row, productKey) && reapCartLinkLaneEnabled(env) && isExternalSeedRow(row, productKey);
  if (!isShopifyRow(row, productKey) && !cartLinkDirect) return skip("not_shopify");
  // Only a key the backend's cart-link lane resolves is ever sent: a seed MIRROR key (see MIRROR_KEY_PREFIX), or,
  // with the enrichment dial on too, an ENRICHMENT key (see ENRICHMENT_BRAND_KEY_RE). Dial off: skipped as before.
  const enrichment = cartLinkDirect && reapCartLinkEnrichmentEnabled(env) && isEnrichmentCartLinkRow(row, productKey);
  if (cartLinkDirect && !enrichment && !isSeedMirrorRow(row, productKey)) return skip("row_key_unsupported");
  // The UCP line item has no variant carrier and the backend matches `variant_key` exactly (it has three live
  // spellings, never re-derived), so this lane omits it — which the backend accepts only for a product with
  // exactly one variant. A multi-variant row is not sent to be refused.
  if (enrichment ? !enrichmentAtMostOneVariant(row) : realVariantCount(row) > 1) return skip("multi_variant");
  const price = rowPrice(row);
  if (!price) return skip("row_unpriced");
  let merchantDomain;
  if (enrichment) {
    // An enrichment row's host is its storefront page, every other merchant field agreeing (see
    // enrichmentCartLinkMerchantDomain). Settled BEFORE the seller check, so a row with no host to send is logged
    // as that, not as a seller mismatch.
    const resolved = enrichmentCartLinkMerchantDomain(row);
    if (!resolved.host) return skip(resolved.code);
    merchantDomain = resolved.host;
  } else {
    merchantDomain = cartLinkDirect ? cartLinkMerchantDomain(row, target) : reapMerchantDomain(row, target);
  }
  // THE EXPECTED SELLER, AGAIN. The door has already REFUSED a create whose expected seller differs
  // (`assertExpectedSeller`, before every lane); this is belt and braces for a caller of this function that
  // skipped the door: never open a purchase from a seller the platform did not show. Fail closed. (An enrichment
  // row POSTs the host of the storefront target, which is one of the destinations judged here.)
  const expectedSeller = reapExpectedMerchantDomain(ucpArgs);
  if (expectedSeller !== undefined && !judgeRowSeller(expectedSeller, row, target).ok) {
    return skip("seller_mismatch");
  }
  if (!merchantDomain) return skip("no_merchant_domain");
  // Mirror rows must NAME one variant. An enrichment row need not: at most one variant was checked above, and the
  // backend proves the variant itself (the store's sole live variant, or one its proof names) before it opens
  // anything.
  if (cartLinkDirect && !enrichment && !cartLinkVariantResolvable(row, target, merchantDomain)) return skip("variant_unresolvable");

  // This row is routed away from the native money lane. A deliberate pause
  // must be a refusal, never a null that falls through to another checkout.
  if (!reapAgenticCreateEnabled(env)) {
    throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", {
      reason: "reap_create_paused", recovery: "keep polling existing Reap checkouts; new purchases are paused",
    });
  }

  // 4. THE PURCHASABILITY GATE — exactly as the escalation lane consults it: same switch, same singleton
  // client, same fail-open rule, same market source (the request's `checkout.context.address_country`, never
  // the buyer's postal address), same budget clamp.
  const gate = typeof shouldOfferPurchase === "function"
    ? shouldOfferPurchase
    : (args) => merchantPurchasability.getMerchantPurchasabilityClient().shouldOfferPurchase(args);
  const gateEnabled = merchantPurchasability.isGateEnabled(env);
  const budgetLeft = doorBudgetMs - (gateClock() - startedAt);
  const offer = await mayOfferPurchaseForDomain(
    merchantDomain,
    escalationBuyerMarket(ucpArgs),
    gate,
    gateEnabled,
    Math.min(Math.max(0, budgetLeft), ESCALATION_GATE_MAX_MS),
  );
  if (!offer) return skip("purchasability_declined");

  // 5. THE POST — with WHATEVER consent and buyer details the call carried. The door does not refuse on its own
  // judgement: only the rail can say whether it is armed, whether this merchant is eligible, and whether the
  // buyer block is complete, and it says the first two before the third. The buyer's email and address go to
  // the backend ONLY. Attested email wins over the body's, exactly as intake rule 1.
  // THE CHECKOUT ID MUST ROUND-TRIP, checked BEFORE the POST: the id is minted after the backend opens the
  // purchase, and an id this door cannot decode again would answer every later get_checkout as an unknown id
  // (an invitation to buy twice). Everything but the purchase id is known now, and that has a fixed shape.
  const probe = { purchaseId: `rp_${"0".repeat(24)}`, productId, productKey, quantity, currency: price.currency, unitMinor: price.amount };
  const decodedProbe = decodeReapCheckoutId(encodeReapCheckoutId(probe));
  if (!decodedProbe || Object.keys(probe).some((k) => decodedProbe[k] !== probe[k])) return skip("id_unencodable");

  const email = attestedOrBodyEmail(attested, quote.customer_email);
  const idempotencyKey = reapIdempotencyKey(params.idempotency_key);
  if (!idempotencyKey) return skip("no_idempotency_key");
  const buyer = {};
  if (email) buyer.email = email;
  const consentVersion = reapConsentVersion(ucpArgs);
  if (consentVersion !== undefined) buyer.consent_version = consentVersion;
  const shippingAddress = reapShippingAddress(ucpArgs);
  if (shippingAddress !== undefined) buyer.shipping_address = shippingAddress;
  const body = {
    merchant_domain: merchantDomain,
    product_key: productKey,
    quantity,
    buyer,
    idempotency_key: idempotencyKey,
  };
  const offerCode = reapOfferCodesEnabled(env) ? reapOfferCode(ucpArgs) : undefined;
  if (offerCode !== undefined) body.offer_code = offerCode;
  // The cart-link body is the SAME shape the Tier B retry below sends — `item_source` and the cart-link
  // idempotency namespace — so a direct cart-link purchase and a retried one are one request to the backend.
  const cartLinkBody = () => ({ ...body, item_source: "cart_link", idempotency_key: reapCartLinkIdempotencyKey(params.idempotency_key) });
  if (cartLinkDirect) emit(log, "info", { op: "create_checkout_session", outcome: "cart_link_direct", code: enrichment ? "enrichment" : "external_seed" });
  const unknownOutcome = () => new PivotaCommerceError("CHECKOUT_OUTCOME_UNKNOWN", {
    reason: "ucp_reap_create_outcome_unknown",
  });
  const dispatchCreate = async (requestBody) => {
    try { return await client.startPurchase(requestBody); }
    catch { throw unknownOutcome(); } // dispatch may have succeeded before a response was lost
  };
  let res = await dispatchCreate(cartLinkDirect ? cartLinkBody() : body);

  // TIER B, ONCE. Only on the one refusal that means "not on the operator allowlist" — never on a consent,
  // address or catalog refusal, which would refuse the cart-link lane for the same reason. A separate
  // idempotency key, because the two bodies differ (the backend hashes `item_source` into the request) and a
  // retry of this create must replay the cart-link purchase rather than conflict with the variant attempt.
  if (!cartLinkDirect && res && res.kind === "refused" && res.code === "merchant_not_eligible" && reapCartLinkLaneEnabled(env)) {
    emit(log, "info", { op: "create_checkout_session", outcome: "retry_cart_link", code: res.code });
    res = await dispatchCreate(cartLinkBody());
  }

  if (res && res.kind === "refused" && res.http_status === 400 && res.code === "invalid_offer_code") {
    if (Array.isArray(hints)) hints.push(REAP_OFFER_CODE_REFUSED_MESSAGE);
    emit(log, "info", { op: "create_checkout_session", outcome: "refused_hinted", code: res.code });
    return null;
  }
  if (res && res.kind === "refused" && res.http_status === 400) {
    const short = CONSENT_HINT_CODES.has(res.code)
      || (BUYER_DETAIL_HINT_CODES.has(res.code) && reapMissingBuyerFields(ucpArgs, email).length > 0);
    if (short && Array.isArray(hints)) hints.push(REAP_AVAILABLE_WITH_CONSENT_MESSAGE);
    emit(log, "info", { op: "create_checkout_session", outcome: short ? "refused_hinted" : "refused", code: res.code });
    return null;
  }

  if (!res || res.kind !== "accepted") {
    emit(log, res && res.kind === "unavailable" ? "warn" : "info", {
      op: "create_checkout_session",
      outcome: res && res.kind ? res.kind : "no_answer",
      code: (res && res.code) || "none",
    });
    // A dispatched POST with no authoritative refusal may have opened a
    // purchase. Never offer a fresh-spend fallback while its outcome is unknown.
    if (!res || res.kind === "unavailable" || res.code === "idempotency_conflict") {
      throw unknownOutcome();
    }
    if (res.code === "reap_create_paused") {
      throw new PivotaCommerceError("OPERATION_NOT_ALLOWED", { reason: "reap_create_paused" });
    }
    // Deterministic rejection before creation retains the documented fallback.
    return null;
  }
  if (!isPlainObject(res.purchase) || !PURCHASE_ID_RE.test(String(res.purchase.id || ""))) {
    throw unknownOutcome();
  }

  const snapshot = { purchaseId: res.purchase.id, productId, productKey, quantity, currency: price.currency, unitMinor: price.amount };
  const id = encodeReapCheckoutId(snapshot);
  emit(log, "info", { op: "create_checkout_session", outcome: "opened", code: "accepted" });
  // The 202 carries no line; the view is completed from OUR OWN server-side read of the row (never from the
  // caller), so the create answer and a later get answer describe the line the same way.
  const out = mapReapPurchaseToCheckout({
    id,
    snapshot,
    view: {
      id: res.purchase.id,
      state: res.purchase.state,
      poll_after_seconds: res.purchase.poll_after_seconds,
      // The host this lane just POSTed — the purchase's seller (the 202 carries no view of its own).
      merchant_domain: merchantDomain,
      product_key: productKey,
      product_name: str(own(row, "title")),
      quantity,
      totals: { currency: price.currency, our_price_minor: price.amount },
    },
    now,
    env,
  });
  return out || buildDegradedReapCheckout({ id, snapshot, now, env });
}

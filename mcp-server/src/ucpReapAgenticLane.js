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
// `consent_version` member and the create_checkout description mentions the Reap route.)

import { createHash } from "node:crypto";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import {
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
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
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

// Pivota's own hosts. A row URL can point at them — the canonical PDP (`agent.pivota.cc/products/sig_…`), or a
// signed attribution redirect (`https://<pivota host>/r?token=…`) riding in `external_redirect_url` — and none of
// them is the MERCHANT's domain.
const SELF_HOST_RE = /(^|\.)pivota\.cc$/;

/**
 * The backend's merchant key (`catalog_products.source_domain`): an explicit field when the read carries one,
 * else the host of the builder's storefront target, else the row's canonical/url — never one of Pivota's own
 * hosts, and never `destination_url` (a raw row URL that can be a tracking hop).
 *
 * AS OBSERVED, LOWERCASED ONLY. No `www.` is stripped, anywhere: production Shopify `source_domain` values carry
 * it (`www.Brand.com`), and a door that canonicalises on its own while the backend compares a different
 * spelling refuses every eligible row `row_not_found` and falls through SILENTLY. Canonicalising both sides
 * (lowercase + one leading `www.`) is the BACKEND's job, at lookup, where both spellings are in view.
 */
export function reapMerchantDomain(row, escalationTarget) {
  const explicit = str(own(row, "merchant_domain")) || str(own(row, "source_domain"));
  const hosts = explicit
    ? [explicit.toLowerCase()]
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
function pollMessage(seconds) {
  // `content` is the bare integer so a platform can read the cadence without parsing prose.
  return info("reap.poll_after_seconds", String(seconds));
}

const STATE_MESSAGES = Object.freeze({
  resolving: "Pivota has opened this purchase with the payment partner (Reap) and is confirming the item with the merchant. Nothing is charged. Poll get_checkout for the next step.",
  needs_enrollment: "The buyer must add a card on the payment partner's secure page at continue_url. Pivota never sees the card. Poll get_checkout afterwards.",
  quoting: "The merchant is pricing this order (item, shipping and tax). Nothing is charged. Poll get_checkout for the approval step.",
  awaiting_approval: "The order is priced. The buyer must review the total and approve it on the payment partner's page at continue_url. Nothing is charged until they approve.",
  processing: "The buyer approved; the payment partner is placing the order with the merchant. Poll get_checkout for the outcome.",
  completed: "The order was placed with the merchant through the payment partner.",
  refused: "This purchase was not placed: it could not be matched or priced exactly for this merchant. Nothing was charged.",
  failed: "This purchase could not be completed. Nothing further will happen on it.",
  expired: "This purchase expired before the buyer finished it. Nothing was charged. Create a new checkout to try again.",
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

function lineItemsAndTotals({ itemId, title, unitMinor, quantity, quotedTotal, finalTotal, degraded }) {
  const lineTotal = unitMinor * quantity;
  if (!Number.isSafeInteger(lineTotal)) return null;
  const total = finalTotal ?? quotedTotal ?? lineTotal;
  const totalText = finalTotal !== null && finalTotal !== undefined
    ? "Total charged, including the merchant's shipping and tax"
    : quotedTotal !== null && quotedTotal !== undefined
      ? "Quoted total, including the merchant's shipping and tax"
      : "Expected total before the merchant's shipping and tax";
  return {
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
export function mapReapPurchaseToCheckout({ id, snapshot, view, now = Date.now(), env = process.env, onUnrecognisedState }) {
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
  const productName = str(own(view, "product_name"));
  const variantTitle = str(own(view, "variant_title"));
  const title = productName ? (variantTitle && variantTitle !== productName ? `${productName} — ${variantTitle}` : productName) : null;
  const lt = lineItemsAndTotals({
    itemId,
    title,
    unitMinor,
    quantity,
    quotedTotal: safeMinor(totals.quoted_total_minor),
    finalTotal: state === "completed" ? safeMinor(totals.final_total_minor) : null,
    degraded: false,
  });
  if (!lt) return null;

  let status = known ? STATE_TO_STATUS[state] : "incomplete";
  let continueUrl;
  let expiresAt = new Date(now + ESCALATION_TTL_MS).toISOString();
  const messages = [];
  if (!known) {
    if (typeof onUnrecognisedState === "function") onUnrecognisedState(state);
    messages.push(info("reap.state_unrecognised", UNRECOGNISED_STATE_MESSAGE));
  } else if (PENDING_BUYER_STATES.has(state)) {
    // The ONLY states in which a hosted URL is read at all.
    const expiry = own(view, "hosted_url_expires_at");
    continueUrl = vetHostedUrl(own(view, "hosted_url"), expiry, now) || undefined;
    if (continueUrl) {
      expiresAt = new Date(Date.parse(expiry)).toISOString();
      messages.push(info(`reap.${state}`, STATE_MESSAGES[state], "$.continue_url"));
    } else {
      status = "incomplete";
      messages.push(info("reap.hosted_page_not_ready", PENDING_WITHOUT_URL_MESSAGE));
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
    messages.push(warning(`reap.purchase_${state}`, `${STATE_MESSAGES[state]}${named}`));
  } else {
    messages.push(info(`reap.${state}`, STATE_MESSAGES[state]));
  }
  if (!TERMINAL_STATES.has(state)) messages.push(pollMessage(pollSeconds(view)));
  messages.push(info("reap.lane", LANE_MESSAGE, "$"));

  return buildUcpCheckoutEnvelope({
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
        ? "This checkout is fulfilled through Reap and cannot be changed here. To buy something different, create a new checkout; to continue this one, poll get_checkout and send the buyer to its continue_url when one is present."
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
  if (!isShopifyRow(row, productKey)) return skip("not_shopify");
  // The UCP line item has no variant carrier and the backend matches `variant_key` exactly (it has three live
  // spellings, never re-derived), so this lane omits it — which the backend accepts only for a product with
  // exactly one variant. A multi-variant row is not sent to be refused.
  if (realVariantCount(row) > 1) return skip("multi_variant");
  const price = rowPrice(row);
  if (!price) return skip("row_unpriced");
  const merchantDomain = reapMerchantDomain(row, target);
  if (!merchantDomain) return skip("no_merchant_domain");

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
  const res = await client.startPurchase(body);

  if (res && res.kind === "refused" && res.http_status === 400) {
    const short = CONSENT_HINT_CODES.has(res.code)
      || (BUYER_DETAIL_HINT_CODES.has(res.code) && reapMissingBuyerFields(ucpArgs, email).length > 0);
    if (short && Array.isArray(hints)) hints.push(REAP_AVAILABLE_WITH_CONSENT_MESSAGE);
    emit(log, "info", { op: "create_checkout_session", outcome: short ? "refused_hinted" : "refused", code: res.code });
    return null;
  }

  if (!res || res.kind !== "accepted") {
    // REFUSED for any other reason (404 not_available_on_this_rail, 409 merchant_not_eligible / row_not_found /
    // idempotency_conflict, 401, …) or UNAVAILABLE: fall through to the next lane so
    // the buyer still gets an answer. On a timeout the purchase MAY exist; it then sits at `resolving` with no
    // card on it and expires on the backend's own clock, and a retry with the same idempotency-key replays it
    // rather than opening a second one.
    emit(log, res && res.kind === "unavailable" ? "warn" : "info", {
      op: "create_checkout_session",
      outcome: res && res.kind ? res.kind : "no_answer",
      code: (res && res.code) || "none",
    });
    return null;
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

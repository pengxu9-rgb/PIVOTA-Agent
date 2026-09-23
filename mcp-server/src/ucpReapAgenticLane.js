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
//   2. REAP — this module, for a non-native row that is eligible (see `createReapCheckout`).
//   3. STOREFRONT ESCALATION — ucpCheckoutEscalation.js, unchanged, when this lane returns null: not eligible,
//      skipped by the purchasability gate, or REFUSED by the backend. A refusal is a fall-through, never an
//      error, so the buyer still gets an answer.
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
//   snapshot     base64url JSON {v:1, i:<product id>, q:<quantity>, c:<currency>, u:<unit price, minor>} — the
//                line as it stood at creation, so a `get_checkout` whose backend read FAILS can still answer a
//                spec-conformant `incomplete` checkout (line items, currency, totals are required members)
//                instead of a terminal state. NO buyer data: no email, no address, no consent, no name.
//                It is display-only on the degraded path and is never sent anywhere; the backend's view
//                replaces it whenever the read succeeds.
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
//   GET unreachable / 5xx / timeout / malformed body -> incomplete + retry hint (NEVER terminal)
//   GET 4xx (404: unknown, another buyer's, rail dark) -> null -> the kernel's unknown-id answer
// A pending state whose hosted URL is absent, expired, or fails the host check below answers `incomplete`
// (the spec obliges `continue_url` on `requires_escalation`, so a pending state with nowhere to send the buyer
// is not published as one). A hosted URL is NEVER forwarded for any other state, whatever the body carries.
//
// ---- SWITCH ------------------------------------------------------------------------------------------------
//
// `REAP_AGENTIC_LANE_ENABLED` (default OFF, read per call). Off — or no client injected — every entry point
// returns null before reading anything, and the door is byte-identical to the door without this module.

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
/** The consent tag's shape: 1..32 printable ASCII characters (the backend refuses > 32 as consent_required). */
export const REAP_CONSENT_MAX_CHARS = 32;

const PURCHASE_ID_RE = /^rp_[0-9a-f]{24}$/;
const SNAPSHOT_RE = /^[A-Za-z0-9_-]{1,400}$/;
const MAX_ID_CHARS = 512;
const MAX_PRODUCT_ID_CHARS = 256;
const CURRENCY_RE = /^[A-Z]{3}$/;
const CONSENT_RE = /^[\x20-\x7E]+$/;
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

export function encodeReapCheckoutId({ purchaseId, productId, quantity, currency, unitMinor }) {
  if (!PURCHASE_ID_RE.test(String(purchaseId || ""))) throw new Error("encodeReapCheckoutId: not a backend purchase id");
  const snapshot = Buffer.from(JSON.stringify({ v: 1, i: productId, q: quantity, c: currency, u: unitMinor }), "utf8")
    .toString("base64url");
  return `${REAP_CHECKOUT_ID_PREFIX}${purchaseId}.${snapshot}`;
}

/** `{ purchaseId, productId, quantity, currency, unitMinor }` for one of ours, else null. Never throws. */
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
  if (!productId || productId !== productId.trim() || productId.length > MAX_PRODUCT_ID_CHARS || /[\u0000-\u001f\u007f]/.test(productId)) return null;
  if (!Number.isSafeInteger(snap.q) || snap.q < 1 || snap.q > REAP_MAX_QUANTITY) return null;
  if (typeof snap.c !== "string" || !CURRENCY_RE.test(snap.c)) return null;
  if (safeMinor(snap.u) === null) return null;
  // Canonical form only: a re-encoding of the same values with extra members or another key order is not an
  // id this door minted.
  if (encodeReapCheckoutId({ purchaseId, productId, quantity: snap.q, currency: snap.c, unitMinor: snap.u }) !== id) return null;
  return { purchaseId, productId, quantity: snap.q, currency: snap.c, unitMinor: snap.u };
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
 * REQUIRES on every purchase (400 consent_required) and stores against the purchase for ever. Read from the
 * RAW UCP body, like the escalation lane's market: the UCP `buyer` object is additionalProperties:true, so a
 * platform can send it today without a new tool or a new argument, and the canonical quote has nowhere
 * truthful to put it (it is not a pricing input). Null when absent or not a usable tag.
 */
export function reapConsentVersion(ucpArgs) {
  const raw = own(own(own(ucpArgs, "checkout"), "buyer"), "consent_version");
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > REAP_CONSENT_MAX_CHARS || !CONSENT_RE.test(v)) return null;
  return v;
}

function singleDestination(ucpArgs) {
  const methods = own(own(own(ucpArgs, "checkout"), "fulfillment"), "methods");
  if (!Array.isArray(methods) || methods.length !== 1) return null;
  const destinations = own(methods[0], "destinations");
  if (!Array.isArray(destinations) || destinations.length !== 1) return null;
  return isPlainObject(destinations[0]) ? destinations[0] : null;
}

const REAP_REQUIRED_ADDRESS_FIELDS = Object.freeze(["firstName", "lastName", "phone", "addressLine1", "city", "country"]);

/**
 * The shipping address in the REAP CLIENT'S field names (the backend contract: `firstName`, `lastName`, `phone`,
 * `addressLine1`, `city`, `country` required; `addressLine2`, `region`, `postalCode` optional), from the UCP
 * destination the argument adapter has already held to the shared completeness rule. The phone falls back to
 * `checkout.buyer.phone_number`. Null when a field the rail requires is missing — the lane then does not
 * enter (a surname or a phone the buyer did not give is never invented).
 */
export function reapShippingAddress(ucpArgs) {
  const dest = singleDestination(ucpArgs);
  if (!dest) return null;
  const buyer = own(own(ucpArgs, "checkout"), "buyer");
  const country = str(own(dest, "address_country"));
  const address = {
    firstName: str(own(dest, "first_name")),
    lastName: str(own(dest, "last_name")),
    phone: str(own(dest, "phone_number")) || str(own(buyer, "phone_number")),
    addressLine1: str(own(dest, "street_address")),
    addressLine2: str(own(dest, "extended_address")),
    city: str(own(dest, "address_locality")),
    region: str(own(dest, "address_region")),
    postalCode: str(own(dest, "postal_code")),
    country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
  };
  if (REAP_REQUIRED_ADDRESS_FIELDS.some((f) => !address[f])) return null;
  for (const k of Object.keys(address)) if (address[k] === null) delete address[k];
  return address;
}

// ---- the row -----------------------------------------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

// Pivota's own hosts. A row URL can point at them — the canonical PDP (`agent.pivota.cc/products/sig_…`), or a
// signed attribution redirect (`https://<pivota host>/r?token=…`) riding in `external_redirect_url` — and none of
// them is the MERCHANT's domain.
const SELF_HOST_RE = /(^|\.)pivota\.cc$/;

/**
 * The backend's merchant key (`catalog_products.source_domain`, compared lowercased): an explicit field when the
 * read carries one, else the host of the builder's storefront target, else the row's canonical/url — never one
 * of Pivota's own hosts, and never `destination_url` (a raw row URL that can be a tracking hop). A wrong guess is
 * cheap by construction: the backend answers `row_not_found` / `merchant_not_eligible` and the lane falls through.
 */
export function reapMerchantDomain(row, escalationTarget) {
  const explicit = str(own(row, "merchant_domain")) || str(own(row, "source_domain"));
  const hosts = explicit
    ? [explicit.toLowerCase().replace(/^www\./, "")]
    : [hostOf(escalationTarget), hostOf(str(own(row, "canonical_url"))), hostOf(str(own(row, "url")))];
  const candidate = hosts.find((h) => h && HOSTNAME_RE.test(h) && !SELF_HOST_RE.test(h));
  return candidate || null;
}

/** Our catalog key for the row (`catalog_products.product_key`), or null. */
function productKeyOf(row) {
  const key = str(own(row, "product_key")) || str(own(row, "catalog_product_key"));
  return key && key.length <= 512 ? key : null;
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

/** The hosted page, if it is one this door may hand a buyer, else null. */
export function vetHostedUrl(raw, expiresAt, now) {
  const url = str(raw);
  if (!url || url.length > 2048 || /[\u0000-\u0020\u007f]/.test(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== "443") return null;
  const host = parsed.hostname.toLowerCase();
  if (!REAP_HOSTED_URL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return null;
  if (expiresAt !== undefined && expiresAt !== null) {
    const t = Date.parse(String(expiresAt));
    if (!Number.isFinite(t) || t <= now) return null;
  }
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
const LANE_MESSAGE = [
  "This checkout is fulfilled through Reap, a payment partner: the buyer enters a card and approves the total on",
  "Reap's own pages, and Reap places the order with the merchant. Pivota never receives card details and does not",
  "hold or move money. This checkout cannot be updated or completed through update_checkout / complete_checkout.",
].join(" ");

function lineItemsAndTotals({ productId, title, unitMinor, quantity, quotedTotal, finalTotal, degraded }) {
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
      item: { id: productId, title: title || productId, price: unitMinor },
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
        display_text: degraded ? "Subtotal as of checkout creation (current state unavailable)" : "Subtotal at Pivota's catalog price",
      },
      { type: "total", amount: total, display_text: degraded ? "Expected total as of checkout creation (current state unavailable)" : totalText },
    ],
  };
}

/**
 * The `incomplete` answer for a checkout whose backend read FAILED (transport, 5xx, timeout, a body that is
 * not the documented shape). Built from the id's snapshot. Never terminal: the purchase may be progressing.
 */
export function buildDegradedReapCheckout({ id, snapshot, now = Date.now(), env = process.env }) {
  const lt = lineItemsAndTotals({ productId: snapshot.productId, title: null, unitMinor: snapshot.unitMinor, quantity: snapshot.quantity, degraded: true });
  return buildUcpCheckoutEnvelope({
    id,
    status: "incomplete",
    currency: snapshot.currency,
    lineItems: lt.lineItems,
    totals: lt.totals,
    expiresAt: new Date(now + ESCALATION_TTL_MS).toISOString(),
    env,
    messages: [
      warning("reap.purchase_state_unavailable", "The purchase's current state could not be read just now. Nothing has been lost; poll get_checkout again."),
      pollMessage(DEFAULT_POLL_SECONDS),
      info("reap.lane", LANE_MESSAGE, "$"),
    ],
  });
}

/**
 * The backend's purchase view -> the UCP checkout. `view` is either the GET body (`id`, `state`, `totals`, …)
 * or the POST 202 body normalised to `{ id, state, poll_after_seconds }`. Returns null when the view is not
 * the documented shape for THIS purchase — the caller answers the degraded checkout instead.
 */
export function mapReapPurchaseToCheckout({ id, snapshot, view, now = Date.now(), env = process.env }) {
  if (!isPlainObject(view)) return null;
  if (own(view, "id") !== snapshot.purchaseId) return null;
  const state = str(own(view, "state"));
  if (!state || !Object.prototype.hasOwnProperty.call(STATE_TO_STATUS, state)) return null;

  const totals = isPlainObject(own(view, "totals")) ? own(view, "totals") : null;
  const currency = totals && typeof totals.currency === "string" && CURRENCY_RE.test(totals.currency) ? totals.currency : snapshot.currency;
  const unitMinor = safeMinor(totals?.our_price_minor) ?? snapshot.unitMinor;
  const qtyRaw = own(view, "quantity");
  const quantity = Number.isSafeInteger(qtyRaw) && qtyRaw >= 1 && qtyRaw <= REAP_MAX_QUANTITY ? qtyRaw : snapshot.quantity;
  const productName = str(own(view, "product_name"));
  const variantTitle = str(own(view, "variant_title"));
  const title = productName ? (variantTitle && variantTitle !== productName ? `${productName} — ${variantTitle}` : productName) : null;
  const lt = lineItemsAndTotals({
    productId: snapshot.productId,
    title,
    unitMinor,
    quantity,
    quotedTotal: safeMinor(totals?.quoted_total_minor),
    finalTotal: state === "completed" ? safeMinor(totals?.final_total_minor) : null,
    degraded: false,
  });
  if (!lt) return null;

  let status = STATE_TO_STATUS[state];
  let continueUrl;
  let expiresAt = new Date(now + ESCALATION_TTL_MS).toISOString();
  const messages = [];
  if (PENDING_BUYER_STATES.has(state)) {
    // The ONLY states in which a hosted URL is read at all.
    continueUrl = vetHostedUrl(own(view, "hosted_url"), own(view, "hosted_url_expires_at"), now) || undefined;
    if (continueUrl) {
      const t = Date.parse(String(own(view, "hosted_url_expires_at") ?? ""));
      if (Number.isFinite(t)) expiresAt = new Date(t).toISOString();
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
    const reason = str(own(view, "refusal_reason")) || str(own(view, "last_error_code"));
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

function attestedOrBodyEmail(attested, bodyValue) {
  const att = isPlainObject(attested) ? str(attested.attested_email) : null;
  if (att) return att;
  return normalizeEmail(bodyValue) || null;
}

/**
 * Called by commerceToolSurface.callTool on the UCP dialect for the checkout operations, AFTER argument
 * translation + the allowlist + the identity check, and BEFORE the storefront escalation lane. Returns a UCP
 * checkout to answer with, or null to fall through to the next lane untouched. Throws only the two named
 * refusals: `reap_consent_required` (create, eligible row, no usable consent tag) and the update/complete
 * refusals on a `reap_` id.
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
}) {
  if (!reapAgenticLaneEnabled(env)) return null;
  if (!client || typeof client.startPurchase !== "function" || typeof client.getPurchase !== "function") return null;
  const opId = op && op.id;

  if (opId === "create_checkout_session") {
    return createReapCheckout({ params, ctx, executor, ucpArgs, attested, client, log, env, now, timeoutMs, shouldOfferPurchase, clock });
  }

  const sessionId = str(own(params, "session_id"));
  const decoded = sessionId ? decodeReapCheckoutId(sessionId) : null;
  if (!decoded) return null; // not one of ours: the kernel path answers it (unknown id included)

  if (opId === "get_checkout_session") {
    const res = await client.getPurchase(decoded.purchaseId);
    if (res && res.kind === "accepted") {
      const out = mapReapPurchaseToCheckout({ id: sessionId, snapshot: decoded, view: res.purchase, now, env });
      if (out) return out;
      emit(log, "warn", { op: opId, outcome: "degraded", code: "malformed_view" });
      return buildDegradedReapCheckout({ id: sessionId, snapshot: decoded, now, env });
    }
    if (res && res.kind === "unavailable") {
      emit(log, "warn", { op: opId, outcome: "degraded", code: res.code || "unavailable" });
      return buildDegradedReapCheckout({ id: sessionId, snapshot: decoded, now, env });
    }
    // not_found (404 — unknown, another buyer's, rail dark) / any other 4xx / unauthenticated: the id is
    // unknown to this buyer, and the kernel path gives the unknown-id answer.
    emit(log, "info", { op: opId, outcome: "unknown_id", code: (res && res.code) || (res && res.kind) || "no_answer" });
    return null;
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

async function createReapCheckout({ params, ctx, executor, ucpArgs, attested, client, log, env, now, timeoutMs, shouldOfferPurchase, clock }) {
  const skip = (code) => { emit(log, "info", { op: "create_checkout_session", outcome: "skipped", code }); return null; };
  const quote = isPlainObject(own(params, "quote")) ? own(params, "quote") : {};
  const items = Array.isArray(quote.items) ? quote.items.filter((it) => isPlainObject(it) && str(it.product_id)) : [];
  // SINGLE LINE: one purchase is one variant at Reap. A multi-line cart is not this lane's (quietly: most carts
  // are not, and a log per multi-line cart would be noise).
  if (items.length !== 1 || (Array.isArray(quote.items) && quote.items.length !== 1)) return null;
  const productId = str(items[0].product_id);
  const quantity = items[0].quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > REAP_MAX_QUANTITY) return null;

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

  // 1. NATIVE FIRST. A row Pivota transacts itself never enters this lane.
  const target = escalationTargetOf(row);
  if (!target) return null;

  // 2. ELIGIBILITY — cheap pre-filters; the backend decides authoritatively and a refusal falls through.
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

  // 3. THE PURCHASABILITY GATE — exactly as the escalation lane consults it: same switch, same singleton
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

  // 4. CONSENT — the one refusal this lane gives on create. The row IS eligible, so the buyer could be sold
  // this item through Reap; the backend will not open a purchase without the tag, and a silent fall-through
  // would leave the agent no way to learn it had to ask.
  const consentVersion = reapConsentVersion(ucpArgs);
  if (!consentVersion) {
    emit(log, "info", { op: "create_checkout_session", outcome: "refused", code: "reap_consent_required" });
    throw intakeRefusal("QUOTE_REQUIRED", "reap_consent_required", [
      "This item can be bought through Pivota's payment partner (Reap), which needs the buyer's consent first.",
      "Show the buyer Pivota's terms for this purchase, then resend create_checkout with",
      "`checkout.buyer.consent_version` set to the version tag of the terms they accepted (1-32 printable ASCII",
      "characters, e.g. \"reap-agentic-v1\").",
    ].join(" "), { required_fields: ["checkout.buyer.consent_version"], max_length: REAP_CONSENT_MAX_CHARS });
  }

  // 5. THE BUYER — to the backend ONLY. Attested email wins over the body's, exactly as intake rule 1.
  const email = attestedOrBodyEmail(attested, quote.customer_email);
  if (!email) return skip("no_buyer_email");
  const shippingAddress = reapShippingAddress(ucpArgs);
  if (!shippingAddress) return skip("address_incomplete");
  const idempotencyKey = reapIdempotencyKey(params.idempotency_key);
  if (!idempotencyKey) return skip("no_idempotency_key");

  const body = {
    merchant_domain: merchantDomain,
    product_key: productKey,
    quantity,
    buyer: { email, consent_version: consentVersion, shipping_address: shippingAddress },
    idempotency_key: idempotencyKey,
  };
  const res = await client.startPurchase(body);
  if (!res || res.kind !== "accepted") {
    // REFUSED (merchant_not_eligible, row_not_found, not_available_on_this_rail, …) or UNAVAILABLE: fall
    // through to the next lane so the buyer still gets an answer. On a timeout the purchase MAY exist; it
    // then sits at `resolving`/`needs_enrollment` with no card on it and expires on the backend's own clock,
    // and a retry with the same idempotency-key replays it rather than opening a second one.
    emit(log, res && res.kind === "unavailable" ? "warn" : "info", {
      op: "create_checkout_session",
      outcome: res && res.kind ? res.kind : "no_answer",
      code: (res && res.code) || "none",
    });
    return null;
  }

  const snapshot = { purchaseId: res.purchase.id, productId, quantity, currency: price.currency, unitMinor: price.amount };
  const id = encodeReapCheckoutId(snapshot);
  emit(log, "info", { op: "create_checkout_session", outcome: "opened", code: "accepted" });
  const out = mapReapPurchaseToCheckout({
    id,
    snapshot,
    view: { id: res.purchase.id, state: res.purchase.state, poll_after_seconds: res.purchase.poll_after_seconds, product_name: str(own(row, "title")) },
    now,
    env,
  });
  return out || buildDegradedReapCheckout({ id, snapshot, now, env });
}

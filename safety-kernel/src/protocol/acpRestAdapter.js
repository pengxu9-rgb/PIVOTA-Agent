// OpenAI ACP (Agentic Commerce Protocol) merchant-side REST adapter — the ChatGPT path. It exposes the five
// ACP checkout-session endpoints + a product feed, normalizes each into a CANONICAL operation, and routes it
// through the ONE canonical executor → kernel. Safety (quote-first, amount-from-quote, host-minted
// confirmation, idempotency, single-use, charge-once, ownership/T7, cross-user isolation) is enforced once in
// the executor/kernel and never re-implemented here — this module only does ACP protocol mechanics:
//
//   POST /checkout_sessions                      -> create_checkout_session
//   POST /checkout_sessions/{id}                 -> update_checkout_session   (re-quote)
//   GET  /checkout_sessions/{id}                 -> get_checkout_session
//   POST /checkout_sessions/{id}/complete        -> complete_checkout_session (verify payment_data -> order + charge)
//   POST /checkout_sessions/{id}/cancel          -> cancel_checkout_session
//   GET  /feed                                   -> product feed (discovery)
//
// Framework-agnostic: every handler takes a normalized request `{ headers, rawBody, body, params }` and returns
// `{ status, body, headers? }`. Wire it to Express/Fastify/etc. at the edge.
//
// SECURITY MODEL (the adapter boundary's job):
//   - Authenticate the PLATFORM per request (HMAC Signature + Timestamp with replay window, constant-time),
//     BEFORE any processing. Per-BUYER identity (ACP has no stable buyer id) is resolved from a verified
//     credential via the injected resolveUserRef — never from the request body.
//   - An ACP checkout session is bound to one buyer at creation (sessionStore); a later call with a different
//     resolved buyer is refused (no cross-buyer session access via a leaked/guessed session id).
//   - Request bodies are mapped to canonical params by ALLOWLIST — model/caller-set amounts never reach pricing.
//   - Errors are mapped to ACP error shapes with curated messages; internal detail is never surfaced.

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { PivotaCommerceError } from '../errors.js';
import { PIVOTA_TO_ACP_STATUS } from '../acpAp2.js';
import { sanitizeResult } from './resultSanitizer.js';
import { delegatedPaymentRefusalAcpResponse } from './delegatedPaymentRefusal.js';

const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000; // reject a Timestamp more than 5 minutes off (replay window)
const CREATE_DEDUP_TTL_MS = 15 * 60 * 1000; // window over which a replayed (buyer, idempotency_key) create dedupes
// Build a sanitized ACP checkout-session response. handoffAllowed=FALSE: a quote/session response carries NO
// legitimate payment redirect (that arrives at /complete via requires_action), so a merchant-supplied
// redirect-named string in line_items is NOT trusted as a handoff — it is scrubbed like any other string
// (Codex round-2 #2). Only the /complete response uses handoffAllowed=true.
const acpSessionBody = (id, session, stored) => sanitizeResult(toAcpSession(id, session, stored), { handoffAllowed: false });
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/**
 * Verify an ACP request signature. HMAC-SHA256 over `${timestamp}.${rawBody}`, hex, constant-time compared,
 * with a freshness window on the Timestamp (replay protection). Throws PivotaCommerceError on any failure.
 * Standalone + exported so the exact signing string can be swapped per the production integration contract.
 */
export function verifyAcpSignature({ signature, timestamp, rawBody, secret, maxSkewMs = DEFAULT_MAX_SKEW_MS, now = () => Date.now() }) {
  if (!nonEmpty(secret)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'no_signing_secret' });
  if (!nonEmpty(signature) || !nonEmpty(timestamp)) {
    throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'missing_signature_or_timestamp' });
  }
  // Timestamp freshness (replay protection). Accept unix seconds or millis.
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'bad_timestamp' });
  const tsMs = tsNum < 1e12 ? tsNum * 1000 : tsNum;
  if (Math.abs(now() - tsMs) > maxSkewMs) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'stale_timestamp' });

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody ?? ''}`).digest('hex');
  // constant-time compare; mismatched lengths can't be timingSafeEqual'd, so length-check first (not secret-dependent).
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'signature_mismatch' });
  }
  return true;
}

/**
 * @param {{
 *   executor: { execute: Function },         // canonical executor
 *   sessionStore: { get, set },              // KV: acpSid -> { quote_id, order_id, user_ref }
 *   signingSecret?: string,                  // for the built-in HMAC verifier
 *   authenticate?: (req) => Promise<void>,   // custom auth (overrides built-in); MUST throw on failure
 *   resolveUserRef: (req) => Promise<string|{user_ref:string,customer_email?:string,customer_name?:string}|undefined>,
 *                                            // verified per-buyer identity (NEVER from body). The object form
 *                                            // carries ATTESTED buyer fields; see requireBuyer.
 *   getProducts?: (query) => Promise<Array>, // product feed source
 *   mapFeedItem?: (product) => object,       // product -> ACP feed item
 *   variantResolutionTimeoutMs?: number,     // bound on the door's default-variant resolution (see below)
 *   maxClockSkewMs?: number,
 *   now?: () => number,
 * }} deps
 */
export function createAcpRestAdapter(deps = {}) {
  const { executor, sessionStore, signingSecret, authenticate, resolveUserRef, getProducts, mapFeedItem, publicFeed = false, maxClockSkewMs = DEFAULT_MAX_SKEW_MS, now = () => Date.now() } = deps;
  if (!executor || typeof executor.execute !== 'function') throw new Error('createAcpRestAdapter requires a canonical executor');
  if (!sessionStore || typeof sessionStore.get !== 'function' || typeof sessionStore.set !== 'function' || typeof sessionStore.putIfAbsent !== 'function') throw new Error('createAcpRestAdapter requires a sessionStore (get/set/putIfAbsent)');
  if (typeof resolveUserRef !== 'function') throw new Error('createAcpRestAdapter requires resolveUserRef');
  if (typeof authenticate !== 'function' && !nonEmpty(signingSecret)) {
    throw new Error('createAcpRestAdapter requires signingSecret or a custom authenticate() — refusing to run unauthenticated');
  }

  const auth = typeof authenticate === 'function'
    ? authenticate
    : async (req) => verifyAcpSignature({
        signature: header(req, 'signature'), timestamp: header(req, 'timestamp'),
        rawBody: req.rawBody, secret: signingSecret, maxSkewMs: maxClockSkewMs, now,
      });

  // Resolve the verified buyer; checkout ops are user-scoped so a missing buyer fails closed.
  //
  // `resolveUserRef` may return EITHER the historical bare `user_ref` string OR a buyer-identity object
  // `{ user_ref, customer_email?, customer_name? }` carrying fields ATTESTED by the buyer credential the
  // integrator verified (see identity/userTokenVerifier.js `attestedBuyerFromClaims`). Both shapes are
  // supported so every existing wiring keeps working unchanged; the object form is what lets an attested
  // email beat a caller-asserted one (see mapItemsToQuote). Ownership is unchanged either way: `user_ref`
  // is still whatever the injected resolver derived, and NOTHING here reads identity from the body.
  async function requireBuyer(req) {
    const resolved = await resolveUserRef(req);
    const identity = isPlainObject(resolved) ? resolved : { user_ref: resolved };
    if (!nonEmpty(identity.user_ref)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'no_verified_buyer' });
    return {
      user_ref: identity.user_ref.trim(),
      // A malformed attested address is treated as ABSENT rather than fatal: it is the IdP's field, the
      // buyer cannot fix it, and the body fallback below is then allowed to supply a usable one.
      attested_email: normalizeEmail(identity.customer_email),
      attested_name: nonEmpty(identity.customer_name) ? identity.customer_name.trim() : undefined,
    };
  }

  // Load a session the requester OWNS (bound to their buyer at creation). A leaked/guessed id from another
  // buyer is refused; a malformed store record fails closed (Codex P2).
  async function ownedSession(acpSid, user_ref) {
    const s = await sessionStore.get(acpSid);
    if (!s) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'unknown_checkout_session', checkout_session_id: acpSid });
    if (!isPlainObject(s) || !nonEmpty(s.user_ref) || !nonEmpty(s.quote_id)) {
      throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'malformed_session_record' });
    }
    if (s.user_ref !== user_ref) throw new PivotaCommerceError('STATE_LINKAGE_MISMATCH', { reason: 'session_buyer_mismatch' });
    return s;
  }

  function requireIdempotencyKey(req) {
    const key = header(req, 'idempotency-key');
    if (!nonEmpty(key)) throw new PivotaCommerceError('IDEMPOTENCY_CONFLICT', { reason: 'missing_idempotency_key' });
    return key;
  }

  // The signature authenticates rawBody (the exact signed bytes). Derive the trusted body by PARSING THOSE
  // bytes — never a separately-supplied parsed `body` that a middleware could have mutated after signing
  // (Codex P0). Body-bearing requests with no raw body fail closed.
  function trustedBody(req) {
    if (!nonEmpty(req?.rawBody)) throw new PivotaCommerceError('USER_AUTH_REQUIRED', { reason: 'missing_raw_body' });
    let parsed;
    try { parsed = JSON.parse(req.rawBody); } catch { throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'invalid_json_body' }); }
    if (!isPlainObject(parsed)) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'body_not_object' });
    return parsed;
  }

  // ---- default-variant resolution (see the intake section below for WHY) ----------------------------------

  // Bounded so a slow or hanging product read can never add an unbounded stall to session creation. The whole
  // batch shares ONE deadline, so a 20-item cart costs the same wall clock as a 1-item cart. Expiry is a
  // REFUSAL, never a fall-through.
  const variantResolutionTimeoutMs = Number.isFinite(deps.variantResolutionTimeoutMs) && deps.variantResolutionTimeoutMs > 0
    ? deps.variantResolutionTimeoutMs
    : DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS;

  // The SAME read the executor already exposes to every other protocol surface: canonical `get_product` ->
  // read('get_product_detail'). No new transport, no new credential, no second copy of the read path. The
  // canonical contract marks get_product `requiresUserRef:false, mutating:false`, so this passes no gate it
  // could weaken: no idempotency key, no session binding, no money path. ctx carries the verified buyer for
  // upstream attribution only.
  async function readProductVariantIds(product_id, merchant_id, ctx) {
    const product = { product_id };
    if (nonEmpty(merchant_id)) product.merchant_id = merchant_id;
    return variantIdsFromProductRead(await executor.execute('get_product', { payload: { product } }, ctx));
  }

  // Fill in `variant_id` for every item that arrived without one. FAIL-CLOSED at every exit: a read that
  // throws, expires, resolves nothing, or resolves more than one candidate REFUSES the item. Nothing here can
  // fall through to a forged id — the only value ever written is one the product read returned.
  async function resolveDefaultVariants(items, merchant_id, ctx) {
    const needing = items.filter((it) => !nonEmpty(it.variant_id));
    if (needing.length === 0) return;
    // One read per DISTINCT product_id (the same product twice in a cart is one lookup).
    const byProduct = new Map(needing.map((it) => [it.product_id, null]));
    const productIds = [...byProduct.keys()];
    let resolved;
    try {
      resolved = await withDeadline(
        Promise.all(productIds.map((pid) => readProductVariantIds(pid, merchant_id, ctx))),
        variantResolutionTimeoutMs,
      );
    } catch {
      // An errored/expired lookup is a REFUSAL. The internal cause is never surfaced (it can carry ids and
      // upstream detail); the caller is told what is actionable — retry, or name the variant.
      throw itemVariantRefusal('resolution_unavailable', VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE);
    }
    productIds.forEach((pid, i) => byProduct.set(pid, resolved[i]));
    for (const it of needing) {
      const variantIds = byProduct.get(it.product_id) ?? [];
      if (variantIds.length === 0) {
        throw itemVariantRefusal('no_variants', VARIANT_NOT_RESOLVABLE_MESSAGE, { variant_count: 0 });
      }
      if (variantIds.length > 1) {
        throw itemVariantRefusal('ambiguous', variantAmbiguousMessage(variantIds.length), { variant_count: variantIds.length });
      }
      it.variant_id = variantIds[0];
    }
  }

  // ---- handlers -------------------------------------------------------------------------------------------

  async function createCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const buyer = await requireBuyer(req);
      const { user_ref } = buyer;
      // priced from the SIGNED bytes (validates non-empty items; resolves each item's default variant)
      const quote = await mapItemsToQuote(trustedBody(req), buyer, resolveDefaultVariants);

      // ACP-layer create idempotency (Codex P1): a replayed (buyer, key) returns the ORIGINAL session instead
      // of minting a new one — no quote/inventory-hold amplification. (Concurrent first-time creates with the
      // same key race on the claim; the loser's quote simply expires unused — documented, acceptable.)
      // JSON-tuple key (NOT a delimiter-join): unambiguous regardless of whether buyer/key contain spaces, so
      // two distinct (buyer, key) pairs can never collide (Codex round-2 #3; same lesson as the executor scoping).
      const createKey = JSON.stringify(['acpcreate', user_ref, idempotency_key]);
      const minted = randomUUID();
      const claimed = await sessionStore.putIfAbsent(createKey, { acp_session_id: minted }, { ttlMs: CREATE_DEDUP_TTL_MS });
      if (!claimed) {
        const prior = await sessionStore.get(createKey);
        const stored = await ownedSession(prior.acp_session_id, user_ref);
        const session = await executor.execute('get_checkout_session', { session_id: stored.quote_id }, { user_ref, acp_session_id: prior.acp_session_id });
        return { status: 200, body: acpSessionBody(prior.acp_session_id, session, stored) };
      }

      const ctx = { user_ref, acp_session_id: minted };
      const session = await executor.execute('create_checkout_session', { idempotency_key, quote }, ctx);
      await sessionStore.set(minted, { quote_id: session.session_id, order_id: null, user_ref });
      return { status: 201, body: acpSessionBody(minted, session) };
    });
  }

  async function updateCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const buyer = await requireBuyer(req);
      const { user_ref } = buyer;
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      // An update RE-MINTS the quote snapshot (executor: create/update share previewQuote), and the snapshot
      // is the ONLY carrier of buyer_context on this lane — so the update body must carry the buyer/address
      // intake again, exactly as create did. Anything it omits is not "kept", it is DROPPED.
      const quote = await mapItemsToQuote(trustedBody(req), buyer, resolveDefaultVariants);
      const ctx = { user_ref, acp_session_id };
      const session = await executor.execute('update_checkout_session', { idempotency_key, session_id: stored.quote_id, quote }, ctx);
      await sessionStore.set(acp_session_id, { ...stored, quote_id: session.session_id });
      return { status: 200, body: acpSessionBody(acp_session_id, session, stored) };
    });
  }

  async function getCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const { user_ref } = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      const ctx = { user_ref, acp_session_id };
      const session = await executor.execute('get_checkout_session', { session_id: stored.quote_id }, ctx);
      return { status: 200, body: acpSessionBody(acp_session_id, session, stored) };
    });
  }

  async function completeCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const { user_ref } = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      const body = trustedBody(req);
      const ctx = { user_ref, acp_session_id };
      const out = await executor.execute('complete_checkout_session', {
        idempotency_key,
        session_id: stored.quote_id,
        authorization_checkout_session_id: acp_session_id,
        payment_authorization: paymentAuthorization(body), // ACP `payment_data` — verified by the executor
        shipping_address: mapAddress(body),
      }, ctx);
      await sessionStore.set(acp_session_id, { ...stored, order_id: out.order?.order_id ?? stored.order_id });
      // checkout flow → payment redirect handoff preserved verbatim; secrets/amounts elsewhere scrubbed.
      return { status: 200, body: sanitizeResult(toAcpOrder(acp_session_id, out), { handoffAllowed: true }) };
    });
  }

  async function cancelCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const { user_ref } = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      const ctx = { user_ref, acp_session_id };
      await executor.execute('cancel_checkout_session', { idempotency_key, session_id: stored.quote_id, order_id: stored.order_id ?? undefined }, ctx);
      return { status: 200, body: { id: acp_session_id, object: 'checkout_session', status: 'canceled' } };
    });
  }

  // Product feed (discovery). Authenticated by default like every other endpoint; only served unauthenticated
  // when the integrator EXPLICITLY opts in via publicFeed:true (catalog is public data). Codex P1.
  async function productFeed(req) {
    return guard(async () => {
      if (!publicFeed) await auth(req);
      if (typeof getProducts !== 'function') throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'no_feed_source' });
      // For an AUTHENTICATED feed, the filter query must come from the SIGNED body, not an unsigned parsed body
      // (Codex round-2 #1). For a public feed there is no signature, so the unsigned body/params are expected.
      // `req.query` here is the caller's ALLOW-LISTED pagination (limit/cursor/
      // page) built in src/server.js — never Express's raw `req.query`.
      //
      // Ordering is deliberate and backward-compatible: a body `query` still
      // wins, so every existing caller raising the limit via a JSON body on a
      // GET keeps working unchanged. The query string is the new, discoverable
      // path for crawlers that issue a plain GET.
      //
      // The AUTHENTICATED branch is untouched: its filter must come from the
      // SIGNED body, and letting an unsigned query string contribute there
      // would reopen exactly the hole the signed-body rule closes.
      const query = publicFeed
        ? (req?.body?.query ?? req?.query ?? req?.params ?? {})
        : (nonEmpty(req?.rawBody) ? (trustedBody(req).query ?? {}) : {});
      const products = await getProducts(query);
      const items = (Array.isArray(products) ? products : []).map((p) => (mapFeedItem ? mapFeedItem(p) : defaultFeedItem(p)));
      // feed is NOT a checkout flow → no handoff preservation; scrub aggressively.
      return { status: 200, body: sanitizeResult({ version: ACP_FEED_VERSION, count: items.length, products: items }, { handoffAllowed: false }) };
    });
  }

  return {
    createCheckoutSession, updateCheckoutSession, getCheckoutSession,
    completeCheckoutSession, cancelCheckoutSession, productFeed,
    delegatePayment,
  };
}

/**
 * POST /agentic_commerce/delegate_payment — PERMANENT refusal.
 *
 * NOT a handler in the usual sense: it is a CONSTANT. It ignores its argument entirely.
 *
 *  - No body parse. An ACP delegate_payment body carries raw cardholder data — `payment_method.number` and
 *    `cvc`. Parsing it would put a PAN and a CVC into this process's heap for no purpose whatsoever.
 *  - No signature verification, deliberately. `verifyAcpSignature` HMACs `rawBody`, i.e. it must READ the
 *    cardholder bytes to authenticate them. Authenticating a request we will refuse regardless is a pure
 *    liability, so the refusal is answered before auth. This also means no unauthenticated caller can learn
 *    anything from it: the answer is a fixed string that is true for everyone.
 *  - No logging, no echo of any request field. The response is built from module constants only.
 *  - Not behind any flag. A refusal is not a capability; the answer is identical in every configuration
 *    because it is an architectural fact, not a rollout stage.
 *
 * Exported OUTSIDE createAcpRestAdapter's closure so it needs no executor, kernel, store or secret — nothing
 * it could reach even in principle.
 */
export function delegatePayment() {
  return delegatedPaymentRefusalAcpResponse();
}

// ---- request helpers --------------------------------------------------------------------------------------

const header = (req, name) => {
  const h = req?.headers ?? {};
  const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
  return typeof v === 'string' ? v.trim() : undefined;
};
const pathId = (req) => {
  const id = req?.params?.checkout_session_id ?? req?.params?.id;
  if (!nonEmpty(id)) throw new PivotaCommerceError('QUOTE_NOT_FOUND', { reason: 'missing_checkout_session_id' });
  return id.trim();
};

// ---- intake validation (P1-P3) ----------------------------------------------------------------------------
//
// Everything below refuses AT INTAKE (create/update) what the ORDER lane hard-requires, so an agent learns
// which field is missing from the door it is talking to instead of from an opaque 400 several calls later —
// after it has already presented a payment credential. All three refusals were verified against
// pivota-backend origin/main `routes/agent_v2.py`, which is the lane this gateway's create_order calls:
//
//   - customer_email : `agent_v2.py` -> `if not customer_email: 400 INVALID_BUYER_CONTEXT`. UNCONDITIONAL.
//   - shipping addr  : `_coerce_shipping_address` -> 400 INVALID_BUYER_CONTEXT + `missing_fields`, requiring
//                      name, address_line1, city, postal_code, country. UNCONDITIONAL at order creation.
//   - variant_id     : the shared `buildQuotePreviewV2Body` SYNTHESISES `variant_id = variant_id || sku ||
//                      product_id` and DROPS any item with no product_id. That builder is shared with other
//                      lanes and is deliberately NOT changed here — this door RESOLVES the variant instead,
//                      so the forging fallback is never what fills the field on this lane (see below).
//
// The refusal bodies below name FIELDS, never VALUES: a buyer email is PII and must not reach an error body
// or a log line, so nothing here ever echoes the address it rejected.
//
// ---- ITEM IDENTITY: RESOLVE, DON'T FORGE, AND DON'T REFUSE WHAT IS RESOLVABLE ------------------------------
//
// An earlier revision of this door refused ANY item without a real `variant_id`. That refusal was
// UNSATISFIABLE from Pivota's own ACP feed, which publishes `{id (sig_*), title, price, brand, availability,
// currency, description, image_link, link}` and NO variant identity whatsoever — so an agent that discovered a
// product through GET /acp/feed had nowhere to obtain a variant_id and could never open a checkout session.
//
// The door therefore RESOLVES the product's default variant, and refuses only when resolution is genuinely
// ambiguous or impossible:
//   exactly one variant  -> use it
//   zero variants        -> refuse (`no_variants`)
//   more than one        -> refuse (`ambiguous`, with the count — the door will not guess an option)
//   read errors/expires  -> refuse (`resolution_unavailable`)
//
// Three properties this must keep, in order of importance:
//
//  1. NEVER synthesise a variant id from a product id. The only value ever written into `variant_id` here is
//     one the product read returned. A forged id does not fail loudly — it PRICES A DIFFERENT CART and
//     succeeds, which is the whole reason this path exists.
//  2. FAIL CLOSED. Every non-unique outcome (including a read that throws or times out) refuses the item.
//     There is no path from a failed resolution to a priced quote.
//  3. REFUSE BEFORE PRICING. Resolution runs inside mapItemsToQuote, i.e. before the executor is asked for
//     `preview_quote` — a refused request performs no pricing call and takes no inventory hold.
//
// The resolved id's SHAPE is never inspected. Live feed products resolve to real storefront ids
// (`48930014462260`) and to synthetic canonical placeholders (`merit:c7e0303d89a516b5::canonical`) alike;
// telling those apart is index-lane knowledge that must not leak into a protocol door. If a resolved id later
// fails to price, that surfaces as a quote failure — fail-closed and diagnosable.

// The five fields pivota-backend `_coerce_shipping_address` requires, in its own order.
const REQUIRED_ADDRESS_FIELDS = Object.freeze(['name', 'address_line1', 'city', 'postal_code', 'country']);
// Conservative shape check only — the backend validates again. Deliberately DUPLICATED from
// identity/userTokenVerifier.js rather than imported: that module pulls in `jose`, and this adapter is
// constructed by jose-free consumers (see the mcp-server note in productionWiring.js). Two four-line regexes
// are a smaller cost than dragging a crypto dependency into an import graph that does not need it.
const EMAIL_SHAPE = /^[^\s@,;<>"'\\]+@[^\s@,;<>"'\\]+\.[^\s@,;<>"'\\]{2,}$/;

/** Trim + shape-check an email. Returns undefined for anything unusable — NEVER echoes the input. */
function normalizeEmail(value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v && EMAIL_SHAPE.test(v) ? v : undefined;
}

/**
 * An intake refusal carrying a curated message + a structured `detail` block.
 *
 * `code` stays one of the contract-stable PivotaErrorCodes (ACP clients already branch on it); the specific,
 * actionable fact lives in the message and in `detail`, exactly as the delegate_payment refusal does. The
 * `acp_detail` key is an EXPLICIT opt-in read by guard() — ordinary PivotaCommerceError detail (which can
 * carry ids and internal reasons) is still never surfaced.
 */
function intakeRefusal(code, reason, message, extra = {}) {
  return new PivotaCommerceError(code, {
    reason,
    acp_message: message,
    acp_detail: { reason, ...extra },
  });
}

const BUYER_EMAIL_REQUIRED_MESSAGE = [
  'A buyer email is required to create a checkout session.',
  'Supply it as `buyer.email` (or `customer_email`) in the request body, or present a buyer credential whose',
  'verified claims carry an `email`. An attested email from the buyer credential always wins; a body value is',
  'used only when the credential carries none.',
].join(' ');

// Every item-identity refusal keeps the SAME contract-stable code (QUOTE_REQUIRED) and the same
// `detail.reason` (`acp_item_identity_required`); `detail.variant_resolution` is what distinguishes the
// cases, and `detail.variant_count` carries the count when one is known. `required_item_fields` is kept on
// all of them because a fully-specified item resolves whatever the outcome was.
function itemVariantRefusal(variant_resolution, message, extra = {}) {
  return intakeRefusal('QUOTE_REQUIRED', 'acp_item_identity_required', message, {
    required_item_fields: ['product_id', 'variant_id'],
    variant_resolution,
    ...extra,
  });
}

const ITEM_PRODUCT_ID_REQUIRED_MESSAGE = [
  'Every item must carry a `product_id`.',
  'A `sku_id` alone is not resolvable at this door: the shared quote-body builder reads `sku`, not `sku_id`,',
  'so a `sku_id`-only cart prices as an EMPTY cart. `variant_id` is optional — when it is omitted this door',
  "resolves the product's default variant and refuses if that resolution is ambiguous or impossible.",
].join(' ');

const VARIANT_NOT_RESOLVABLE_MESSAGE = [
  'No purchasable variant could be resolved for this item: the product read returned no variants.',
  'Supply `variant_id` explicitly, or re-run product discovery — as it stands this product cannot be priced.',
].join(' ');

const variantAmbiguousMessage = (count) => [
  `This item is ambiguous: the product resolves to ${count} variants and the request names none.`,
  'Supply `variant_id` for the exact option the buyer chose. This door will not pick one for you, because',
  'guessing prices a cart the buyer did not ask for.',
].join(' ');

const VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE = [
  "The item's default variant could not be resolved: the product read failed or timed out.",
  'The request is refused rather than priced against a guessed variant. Retry, or supply `variant_id`.',
].join(' ');

// Short by design: this runs inside checkout-session creation, so it bounds how long an agent waits before
// the door answers. Overridable per-wiring via `variantResolutionTimeoutMs`.
const DEFAULT_VARIANT_RESOLUTION_TIMEOUT_MS = 3000;

const ADDRESS_INCOMPLETE_MESSAGE = [
  'The fulfillment address is incomplete. An address is optional here — a checkout session may be created',
  'without one and the address supplied later via POST /checkout_sessions/{checkout_session_id} — but an',
  'address that IS supplied must be complete, because order creation requires all of',
  `${REQUIRED_ADDRESS_FIELDS.join(', ')}.`,
  '(`name` may be given as `recipient_name`.)',
].join(' ');

// ACP items -> canonical quote request, by ALLOWLIST (a caller-set amount/total/currency never reaches pricing).
// Requires a non-empty items array with a scalar product/variant id and a positive safe-integer quantity each,
// so a `{}` / `{items:[]}` body can't drive a default/zero-item quote on a loose backend (Codex P2).
//
// `buyer` is the VERIFIED identity from requireBuyer, not anything read from the body.
//
// `resolveDefaultVariants` is the closure-bound resolver above; it is the ONLY step in here that talks to
// another service, and it runs LAST — after every cheap refusal — so a request that was going to be refused
// anyway never costs an upstream read.
async function mapItemsToQuote(body, buyer = {}, resolveDefaultVariants) {
  const b = isPlainObject(body) ? body : {};
  const rawItems = Array.isArray(b.items) ? b.items : [];
  if (rawItems.length === 0) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'no_items' });
  const items = rawItems.map((it) => {
    const item = pick(it, ['product_id', 'sku_id', 'variant_id', 'quantity']);
    // P3. `product_id` is REQUIRED: without it the shared quote-body builder silently DROPS the item from
    // offer_refs, so a `sku_id`-only cart prices as an EMPTY cart. `variant_id` is optional and resolved
    // below; an unusable value (empty string, non-string) is treated as ABSENT so resolution fills it
    // rather than passing junk to pricing.
    if (!nonEmpty(item.product_id)) {
      throw itemVariantRefusal('product_id_required', ITEM_PRODUCT_ID_REQUIRED_MESSAGE);
    }
    if (nonEmpty(item.variant_id)) item.variant_id = item.variant_id.trim();
    else delete item.variant_id;
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new PivotaCommerceError('QUOTE_REQUIRED', { reason: 'item_bad_quantity' });
    return item;
  });
  const quote = { merchant_id: str(b.merchant_id) ?? str(b.merchant?.id), items };
  const codes = Array.isArray(b.discount_codes) ? b.discount_codes.filter((c) => typeof c === 'string') : undefined;
  if (codes && codes.length) quote.discount_codes = codes;
  const addr = mapAddress(b);
  if (addr) quote.shipping_address = addr;

  // P1. PRECEDENCE IS THE POINT: the attested address is read FIRST, so a body value can only ever fill a
  // gap and can never override what the verified buyer credential asserted. The body value is not even
  // parsed when an attested one exists, so a malformed/hostile body email is inert on that path.
  const acpBuyer = isPlainObject(b.buyer) ? b.buyer : {};
  const customer_email = buyer.attested_email ?? normalizeEmail(acpBuyer.email ?? b.customer_email);
  if (!customer_email) {
    throw intakeRefusal('QUOTE_REQUIRED', 'acp_buyer_email_required', BUYER_EMAIL_REQUIRED_MESSAGE, {
      accepted_body_fields: ['buyer.email', 'customer_email'],
      attested_source: 'buyer_credential_claims.email',
      attested_wins: true,
    });
  }
  // Reaches the kernel's buyer_context via kernel.js buyerContextFromQuotePayload (quote.customer_email /
  // quote.customer_name), which is what the order lane's buyer_context is built from.
  quote.customer_email = customer_email;
  const customer_name = buyer.attested_name
    ?? joinName(acpBuyer.first_name, acpBuyer.last_name)
    ?? (nonEmpty(b.customer_name) ? b.customer_name.trim() : undefined);
  if (customer_name) quote.customer_name = customer_name;

  // LAST: resolve a default variant for every item that arrived without one (items are mutated in place, so
  // the resolved id is what reaches `quote.items` and therefore pricing). Deliberately after the buyer/address
  // refusals — those are free, this one is a network read — and deliberately before the caller's
  // `preview_quote`, so a refused request never prices anything or takes an inventory hold.
  if (typeof resolveDefaultVariants !== 'function') {
    // FAIL CLOSED on a wiring mistake too: with no resolver threaded, an item that still lacks a variant_id
    // would reach pricing unresolved and be forged by the shared builder — the exact hole this door closes.
    // (A fully-specified cart is unaffected; there is nothing to resolve.)
    if (items.some((it) => !nonEmpty(it.variant_id))) {
      throw itemVariantRefusal('resolution_unavailable', VARIANT_RESOLUTION_UNAVAILABLE_MESSAGE);
    }
  } else {
    await resolveDefaultVariants(items, quote.merchant_id, { user_ref: buyer.user_ref });
  }
  return quote;
}

// A product read -> the DISTINCT variant ids it published, in order. Accepts the shapes the canonical
// `get_product` read returns across lanes (`{product:{variants}}`, `{data:{product:{variants}}}`, or a bare
// product), and both spellings of the id. Nothing is derived: an entry with no id of its own contributes
// nothing, and a product with no variants yields an empty list (which REFUSES upstream).
function variantIdsFromProductRead(result) {
  const r = isPlainObject(result) ? result : {};
  const product = isPlainObject(r.product) ? r.product
    : isPlainObject(r.data) && isPlainObject(r.data.product) ? r.data.product
    : r;
  const ids = [];
  for (const v of Array.isArray(product.variants) ? product.variants : []) {
    const id = variantIdOf(v);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function variantIdOf(v) {
  if (!isPlainObject(v)) return undefined;
  for (const key of ['variant_id', 'id']) {
    const raw = v[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    // Numeric storefront ids are common upstream; stringifying the value the READ returned is not
    // synthesis — it is still that variant's own id, never anything derived from the product id.
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  }
  return undefined;
}

// Race a promise against a deadline. The loser's later settlement is already handled by the race, so a slow
// read that finishes after expiry cannot surface as an unhandled rejection; the timer is unref'd so it never
// holds the process open.
function withDeadline(promise, ms) {
  if (!(ms > 0)) return promise;
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('variant_resolution_timeout')), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

function joinName(first, last) {
  const parts = [first, last].filter((p) => nonEmpty(p)).map((p) => p.trim());
  return parts.length ? parts.join(' ') : undefined;
}

// P2. Optional-but-COMPLETE-IF-PRESENT, applied wherever an address is supplied to this door.
//
// Optional, because ACP permits an address-less create (an agent prices first, the buyer picks a destination
// after) and this door HAS an update op that genuinely re-maps the address: update re-runs mapItemsToQuote
// and the executor's create/update both go through kernel.previewQuote, minting a fresh snapshot whose
// buyer_context carries the new address. Requiring one at create would refuse a spec-legal request that the
// protocol expects to succeed.
//
// Complete-if-present, because a PARTIAL address is worse than none: it silently prices shipping/tax against
// a destination the order lane will then reject, and the caller does not find out until completion.
//
// `recipient_name` is preserved (not renamed): both src/server.js buildInvokeBuyerContext and the kernel's
// normalizeBuyerAddress already map recipient_name -> name. `name` is now also carried through, so a caller
// using the plain ACP spelling is no longer silently stripped of the recipient.
function mapAddress(body) {
  const a = isPlainObject(body?.fulfillment_address) ? body.fulfillment_address
    : isPlainObject(body?.shipping_address) ? body.shipping_address
    : isPlainObject(body?.address) ? body.address : null;
  if (!a) return undefined;
  const out = pick(a, ['country', 'city', 'state', 'postal_code', 'address_line1', 'address_line2', 'name', 'recipient_name', 'phone']);
  const effective = { ...out, name: nonEmpty(out.name) ? out.name : out.recipient_name };
  const missing = REQUIRED_ADDRESS_FIELDS.filter((f) => !nonEmpty(effective[f]));
  if (missing.length) {
    throw intakeRefusal('QUOTE_REQUIRED', 'acp_fulfillment_address_incomplete', ADDRESS_INCOMPLETE_MESSAGE, {
      missing_fields: missing,
      required_fields: [...REQUIRED_ADDRESS_FIELDS],
    });
  }
  return out;
}

// ACP `payment_data` is the delegated-token / credential envelope; opaque to the kernel, VERIFIED by the
// executor's verifyPaymentAuthorization. Safe-clone so a hostile __proto__ key can't pollute downstream.
function paymentAuthorization(body) {
  const pd = body?.payment_data ?? body?.payment;
  return pd === undefined ? undefined : safeClone(pd);
}

// ---- response mapping (ACP shapes; reuses the canonical status vocabulary) --------------------------------

function toAcpSession(id, session, stored) {
  return {
    id,
    object: 'checkout_session',
    status: stored?.order_id ? PIVOTA_TO_ACP_STATUS.order_created : PIVOTA_TO_ACP_STATUS.quote_issued,
    currency: session.currency,
    merchant_of_record: session.merchant_of_record,
    line_items: session.line_items,
    totals: session.totals,
    expires_at: session.expires_at,
    order: stored?.order_id ? { id: stored.order_id } : undefined,
  };
}

function toAcpOrder(id, out) {
  // Read the raw payment; the response is run through the shared sanitizer at the boundary (which preserves the
  // redirect handoff verbatim and scrubs secrets). requires_action is built from redirect/qr/instructions only —
  // never client_secret/ap2_state.
  const payment = (out && typeof out.payment === 'object' && out.payment) || {};
  const acpStatus = payment.order_status === 'paid' ? PIVOTA_TO_ACP_STATUS.payment_succeeded
    : payment.order_status === 'charge_pending' ? PIVOTA_TO_ACP_STATUS.payment_requires_action
    : payment.order_status === 'failed' ? PIVOTA_TO_ACP_STATUS.payment_failed
    : PIVOTA_TO_ACP_STATUS.order_created;
  return {
    id,
    object: 'checkout_session',
    status: acpStatus,
    order: { id: out.order?.order_id, amount_total: out.order?.amount_total, currency: out.order?.currency },
    // requires_action handoff surfaced verbatim for the buyer (never fabricated); raw secrets already scrubbed.
    requires_action: payment.redirect_url || payment.qr_code || payment.instructions
      ? { redirect_url: payment.redirect_url, qr_code: payment.qr_code, instructions: payment.instructions }
      : undefined,
    payment_status: payment.payment_status,
  };
}

const ACP_FEED_VERSION = '2026-04-17';
function defaultFeedItem(p) {
  const o = isPlainObject(p) ? p : {};
  // raw mapping; the whole feed body is run through the shared sanitizer at the response boundary.
  return {
    id: o.id ?? o.product_id ?? o.sku_id,
    title: o.title ?? o.name,
    description: o.description,
    link: o.link ?? o.url,
    image_link: o.image_link ?? o.image ?? (Array.isArray(o.images) ? o.images[0] : undefined),
    price: o.price,
    currency: o.currency,
    availability: o.availability ?? (o.in_stock === false ? 'out_of_stock' : o.in_stock === true ? 'in_stock' : undefined),
    brand: o.brand /* NOT `?? o.merchant_id` — see src/acpFeedItem.js (#1851). A
       merchant id is not a brand, and this adapter is reused verbatim by every
       caller, including productionWiring.js which constructs it with NO
       mapFeedItem and therefore lands here. */,
    variants: o.variants,
  };
}

// ---- error mapping (ACP error shape; never leaks internal detail) -----------------------------------------

const STATUS_BY_CODE = Object.freeze({
  USER_AUTH_REQUIRED: 401,
  STATE_LINKAGE_MISMATCH: 409,
  QUOTE_NOT_FOUND: 404,
  QUOTE_EXPIRED: 409,
  QUOTE_ALREADY_USED: 409,
  QUOTE_REQUIRED: 400,
  PRICE_CHANGED: 409,
  OUT_OF_STOCK: 409,
  CONFIRMATION_REQUIRED: 402,
  CONFIRMATION_INVALID: 402,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENT_REPLAY: 409,
  PAYMENT_REQUIRES_ACTION: 402,
  MERCHANT_UNAVAILABLE: 503,
  // The two TERMINAL read outcomes. Both mean "there is nothing at this id and there never will be", so both
  // are 404 — matching statusForCommerceKernelError in src/server.js. Without an entry here they fell to the
  // `?? 400` default below, which tells an ACP client its REQUEST was malformed: a different lie in the same
  // family as the retry trap these codes exist to end, and one that points a caller at fixing its payload
  // instead of at its id. NO_MERCHANT_OFFER's omission is a pre-existing hole from #1829; both are fixed
  // together because leaving one behind would have the door answer two statuses for one class of fact.
  NO_MERCHANT_OFFER: 404,
  UNKNOWN_PRODUCT_ID: 404,
  OPERATION_NOT_ALLOWED: 409,
});

// Run a handler, mapping any throw to an ACP error response. PivotaCommerceError → its code + curated
// userMessage; anything else → a generic 500 (a raw error message is NEVER surfaced).
//
// The `detail` block is EXPLICIT OPT-IN via `detail.acp_detail` (intakeRefusal), matching the shape the
// delegate_payment refusal already emits: `{ type, code, message, detail }`. Ordinary PivotaCommerceError
// detail — which carries ids, session ids and internal reasons — is still never surfaced, and by
// construction an acp_detail block names FIELDS only, never a value taken from the request (no PII).
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PivotaCommerceError) {
      const acpDetail = isPlainObject(err.detail?.acp_detail) ? err.detail.acp_detail : null;
      const body = {
        type: 'error',
        code: err.code,
        message: acpDetail && nonEmpty(err.detail.acp_message) ? err.detail.acp_message : err.userMessage,
      };
      if (acpDetail) body.detail = { ...acpDetail };
      return { status: STATUS_BY_CODE[err.code] ?? 400, body };
    }
    return { status: 500, body: { type: 'error', code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } };
  }
}

// ---- small utilities --------------------------------------------------------------------------------------

function pick(src, keys) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const k of keys) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}
function safeClone(v, depth = 0) {
  if (v === null || typeof v !== 'object') return v;
  if (depth > 32) return null;
  if (Array.isArray(v)) return v.map((x) => safeClone(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = safeClone(v[k], depth + 1);
  }
  return out;
}
function str(v) { return typeof v === 'string' ? v : undefined; }

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
//
// THE BUYER'S MARKET ON THIS DOOR is the country of the fulfillment address (see "the buyer's market" below):
// a priced answer for a known market is in that market's currency, or the request is refused by name.

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { PivotaCommerceError } from '../errors.js';
import { PIVOTA_TO_ACP_STATUS } from '../acpAp2.js';
import { sanitizeResult } from './resultSanitizer.js';
import { delegatedPaymentRefusalAcpResponse } from './delegatedPaymentRefusal.js';
import { quoteMarketOf } from './canonicalExecutor.js';
// The SHARED intake rules (attested-wins precedence, the required-address field set, default-variant
// resolution). They used to live in this file; they MOVED to buyerIntake.js when the MCP door turned out to
// have the same three defects, so that there is ONE definition rather than two that can drift. Behaviour here
// is unchanged — every refusal keeps its code, its `detail.reason` and its message.
import {
  assertNoUnresolvedVariants,
  createDefaultVariantResolver,
  joinName,
  normalizeAttestedBuyer,
  normalizeCartItems,
  assertIdempotencyKeyAcceptable,
  assertLineQuantitiesWithinMaximum,
  assertNoDuplicateLines,
  intakeRefusal,
  pickCompleteAddress,
  resolveBuyerEmail,
  resolveBuyerName,
  surfaceableIntakeRefusal,
} from './buyerIntake.js';

// This adapter IS the ACP door; every ctx it builds says so, which scopes the delegated-PSP-token lane.
const ACP_PROTOCOL_NAME = 'acp';

// Where this door's caller supplies or replaces the fulfillment address. Named as the concrete REST endpoint.
const ADDRESS_UPDATE_HINT = 'POST /checkout_sessions/{checkout_session_id}';
const MAX_SESSION_WRITE_ATTEMPTS = 4; // conditional writes of one session record a request tries before it gives up
// A session is open until it has an order or was cancelled.
const sessionIsOpen = (record) => isPlainObject(record) && !record.order_id && record.canceled !== true;
const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000; // reject a Timestamp more than 5 minutes off (replay window)
const CREATE_DEDUP_TTL_MS = 15 * 60 * 1000; // window over which a replayed (buyer, idempotency_key) create dedupes
// How long a create's claim on the caller's key is held while the create is still running. It must outlast the
// slowest create (one pricer call, bounded by the pricer transport's own deadline: 60 s by default at the gateway),
// and it bounds how long an attempt that never finished (a crashed process, an outcome nobody can know) keeps the
// key. The same number as the kernel ledger's claim lease (idempotencyLedger.js), for the same reason.
const CREATE_CLAIM_LEASE_MS = 2 * 60 * 1000;
const CREATE_PENDING = 'pending'; // the claim of a create that has not finished: no session is behind it yet
const CREATE_DONE = 'done'; // the claim of a create whose session was written: a replay reads that session back
const MAX_CREATE_CLAIM_ATTEMPTS = 3; // a claim released between our failed write and our read is tried again
// The reasons of the kernel ledger (idempotencyLedger.js), with its meanings: `in_flight` an earlier attempt still
// holds the key, `lease_lost_after_op` this attempt priced but another holds the key now, `race` the key changed
// hands on every try.
const outcomeUnknown = (reason) => new PivotaCommerceError('CHECKOUT_OUTCOME_UNKNOWN', { reason });

// DID THE CREATE FAIL WITH NOTHING BEHIND IT? True only for a refusal whose outcome is known: one this process
// raised itself, or one the pricer ANSWERED. Then no quote was recorded and no session written, and the claim can
// be given back. False for everything else, which is every failure whose outcome nobody here can know:
//   - the pricer was asked and no answer came back (the deadline passed, the connection was lost): it may still
//     be pricing. The transport says so on the error: `upstream_timeout`, or an `upstream_status` that is not a
//     status (src/server.js throwCommerceKernelUpstreamError writes both);
//   - anything that is not a refusal at all (a store that failed while the quote was being recorded, a bug).
function createFailedWithNothingBehindIt(err) {
  if (!(err instanceof PivotaCommerceError)) return false;
  const detail = isPlainObject(err.detail) ? err.detail : {};
  if (detail.upstream_timeout === true) return false;
  if ('upstream_status' in detail && !Number.isInteger(detail.upstream_status)) return false;
  return true;
}
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
 *   marketCurrencyOf?: (market: string) => string|null, // the currency a market (upper-case ISO 3166-1 alpha-2)
 *                                            // is priced in, null when none. No table is kept here. Without it
 *                                            // a request that names a market is refused, never priced unjudged.
 *   maxClockSkewMs?: number,
 *   now?: () => number,
 * }} deps
 */
export function createAcpRestAdapter(deps = {}) {
  const { executor: canonicalExecutor, sessionStore, signingSecret, authenticate, resolveUserRef, getProducts, mapFeedItem, publicFeed = false, maxClockSkewMs = DEFAULT_MAX_SKEW_MS, now = () => Date.now() } = deps;
  if (!canonicalExecutor || typeof canonicalExecutor.execute !== 'function') throw new Error('createAcpRestAdapter requires a canonical executor');
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

  // ---- the buyer's market ------------------------------------------------------------------------------------
  //
  // WHERE IT COMES FROM. An ACP checkout request names the buyer's market in one place: the `country` of its
  // fulfillment address (ISO 3166-1 alpha-2), which is optional on create and on update. This door reads no
  // request currency, no locale and no header as a market, and it never infers one.
  //
  // THE RULE, applied on every operation of this door that states or takes money, whenever the market is known:
  //   - CREATE and UPDATE with an address: the market goes to the executor with the currency this door's source
  //     prices it in (`marketCurrencyOf`). The executor refuses a market with no currency before any quote
  //     (`market_not_priced`), sends the market with the quote, and refuses a quote that is not in the market's
  //     currency before anything is recorded (`seller_not_priced_in_market_currency`). Nothing is converted or
  //     relabelled. (`marketOfAddress`, `marketParamsOf`; canonicalExecutor.js `quoteMarketOf`.)
  //   - AN UPDATE THAT CARRIES AN ADDRESS REPLACES THE SESSION'S MARKET, and says so to the executor
  //     (`market_replaces_session_market`): it is judged for the NEW country, and when it succeeds the new market
  //     is the one recorded on the session's quote. Without that statement the executor judges an update for the
  //     market the session already has, which is right for a door whose updates cannot name one.
  //   - CREATE with NO address: no market is known, none is assumed, and the session is priced in the seller's
  //     own currency, not judged (the same decided behaviour as a checkout that names no market on the other
  //     doors). Such a session holds no address, and an order needs one, so it cannot be paid as it stands.
  //   - UPDATE with NO address NEVER TAKES A MARKET AWAY. The address is dropped from the quote, as everything an
  //     update omits is; the session's market is not. The re-quote is judged for the market the session has: the
  //     one a refused request left on it (the mark below) when there is one, else the one recorded on its quote
  //     (the executor reads it). Only a session that never had a market is re-priced unjudged.
  //   - COMPLETE is judged for EVERY market that applies, none in place of another (the executor,
  //     judgeSessionMarkets), before either payment lane. The session is paid only if
  //       (1) the country of the address the completion carries is priced in the locked quote's currency (that
  //           address is where the order ships when the quote holds none), and
  //       (2) that country IS the market recorded on the quote, when the quote records one: another country, even
  //           one priced in the same currency, was never priced (tax, shipping) and needs an update first, and
  //       (3) no mark blocks it (below).
  //     A quote that holds an address was judged for that address's country when it was priced, and records it.
  //     A session created with no address is therefore judged at the latest here, before any money moves.
  //   - COMPLETE WITH NO ADDRESS TO SHIP TO (none on the session's quote, none on the completion) is refused by
  //     name before any order is asked for (`acp_fulfillment_address_required`), whether or not the session has a
  //     market: an order needs the address. So a session is paid only with an address, and the country of the
  //     address the order ships to is always one the locked quote was judged for: the quote's own address when
  //     it holds one (judged when it was priced), else the completion's (judged at completion, (1)-(3) above).
  //   - THE MARK. An UPDATE refused for its market changes no quote, so the session still holds
  //     the quote it had. When that HELD quote is not priced for the refused market (the market has no currency,
  //     or another currency than the held quote's), the market is written on the session record
  //     (`refused_market`): the buyer named a market the session cannot be paid for, so until an update succeeds
  //     every read and completion of the session answers that refusal. The mark only ever ADDS a judgement: a
  //     completion's own address is judged first and in its own right. When the held quote IS priced for the
  //     refused market (it was the update's new cart that was not), nothing is written: the session is as it was,
  //     and its completions are judged as in (1)-(3). The next update that succeeds removes the mark. A country
  //     this door cannot read is an ordinary intake refusal and marks nothing. A refused COMPLETION marks
  //     nothing either: each completion is judged for its own address, so the next one, correctly addressed, is
  //     not held back by the last.
  //   - A SESSION THAT IS OVER IS NEVER MARKED OR RE-PRICED. A completed session (it has an order) and a cancelled
  //     one refuse an update by name before anything is priced, and are read as what they are: the completed
  //     checkout, or `canceled`. A cancelled session is not completed: a cancellation takes the quote's single-use
  //     claim, the one an order takes, so of a cancellation and a completion exactly one wins.
  //   - EVERY WRITE OF THE SESSION RECORD IS CONDITIONAL on the record still being the one this request read
  //     (writeSession): a request that lost a race re-reads and decides again, so a refused or late request never
  //     puts back an old quote id, and never erases an order id or a cancellation.
  //
  // With no `marketCurrencyOf` wired, a request that names a market is refused (fail closed): this door never
  // prices a named market without judging it.
  const { marketCurrencyOf } = deps;
  const marketParamsOf = (market) => {
    if (market === undefined) return {};
    if (typeof marketCurrencyOf !== 'function') throw new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'no_market_currency_source' });
    const currency = marketCurrencyOf(market);
    // `market` alone when nothing is priced for it: the executor refuses that by name. Never a default of either.
    return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? { market, market_currency: currency } : { market };
  };
  // The mark a refused request left on a session, as the executor is told of it: a market HELD AGAINST the session,
  // judged beside whatever the request itself names and never instead of it. Nothing for a session that is over.
  const heldMarketParams = (stored) => {
    if (!sessionIsOpen(stored) || stored.refused_market === undefined || stored.refused_market === null) return {};
    const { market, market_currency } = marketParamsOf(stored.refused_market);
    return market_currency === undefined ? { held_market: market } : { held_market: market, held_market_currency: market_currency };
  };

  // ---- the session record ------------------------------------------------------------------------------------
  //
  // `{ quote_id, order_id, user_ref, refused_market?, canceled?, rev }`. `rev` is rewritten on every write and is
  // what a conditional write compares, so ANY change to the record since this request read it (another quote, an
  // order, a cancellation, a mark) makes the write fail and the request decide again on what is there now.
  // `decide(current)` returns the record to write, or null to write nothing. A record written before `rev` existed
  // is re-read and compared on its quote id; a store with no conditional write is written as it always was.
  const conditionalSessionWrites = typeof sessionStore.compareAndSet === 'function';
  async function writeSession(acp_session_id, read, decide) {
    let current = read;
    for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt += 1) {
      if (attempt > 0 || !nonEmpty(current?.rev)) current = await sessionStore.get(acp_session_id);
      if (!isPlainObject(current)) return null;
      const next = decide(current);
      if (!next) return null;
      const written = { ...next, rev: randomUUID() };
      if (!conditionalSessionWrites) { await sessionStore.set(acp_session_id, written); return written; }
      const [field, value] = nonEmpty(current.rev) ? ['rev', current.rev] : ['quote_id', current.quote_id];
      if (await sessionStore.compareAndSet(acp_session_id, field, value, written)) return written;
    }
    throw outcomeUnknown('race');
  }
  // What an update or a completion is told on a session that is over, before anything is priced or paid.
  function assertSessionOpen(stored) {
    if (stored.canceled === true) throw new PivotaCommerceError('ORDER_CANCELED', { reason: 'checkout_session_canceled' });
    if (stored.order_id) throw new PivotaCommerceError('QUOTE_ALREADY_USED', { reason: 'checkout_session_completed' });
  }
  // THE MARK (see "the buyer's market"), written by a refused UPDATE. `market`: the market of a market refusal,
  // or null. The refusal was of the update's new cart, so the HELD quote's own currency is read to see whether it
  // is priced for the market: if it is, nothing is marked.
  // Never throws: the refusal is the caller's answer whatever happens here. When nothing could be written the
  // session is exactly as it was, which is safe: every completion is still judged for the address it ships to.
  async function markRefusedMarket(acp_session_id, stored, market, ctx) {
    if (!market || !sessionIsOpen(stored)) return;
    try {
      const marketCurrency = marketParamsOf(market).market_currency;
      if (marketCurrency !== undefined) {
        const held = await canonicalExecutor.execute('get_checkout_session', { session_id: stored.quote_id }, ctx);
        if (held && held.currency === marketCurrency) return;
      }
      // Only the session this request judged: one that has since been re-priced, completed or cancelled is left
      // to the request that did that.
      await writeSession(acp_session_id, stored, (current) => (
        sessionIsOpen(current) && current.quote_id === stored.quote_id && current.refused_market !== market
          ? { ...current, refused_market: market } : null
      ));
    } catch { /* the refusal is the answer */ }
  }
  // A session as this door reads it out: `canceled` for a cancelled one; else its quote, judged for a mark.
  async function readSession(acp_session_id, stored, ctx) {
    if (stored.canceled === true) return { status: 200, body: { id: acp_session_id, object: 'checkout_session', status: 'canceled' } };
    const session = await executor.execute('get_checkout_session', { session_id: stored.quote_id, ...heldMarketParams(stored) }, ctx);
    return { status: 200, body: acpSessionBody(acp_session_id, session, stored) };
  }
  // What the executor is told about the market of an UPDATE. Two members, both this door's own words (nothing in a
  // request body reaches either: an update's call is built member by member below, and its `quote` by allowlist):
  //   - `judge_session_market: true`, on EVERY update. The executor reads the market recorded on a session, and
  //     judges the re-quote for it, only on a call a door marked so. This door's market rule is on whenever the
  //     door is, so it marks every update: an update with no address is judged for the session's recorded market.
  //   - the market of the address the update carries, else the market a refused request left on the session, with
  //     `market_replaces_session_market: true`: either one REPLACES the market recorded on the session's quote.
  // Neither market: only the mark is sent, and the executor judges the update for the recorded market, if any.
  const updateMarketParams = (stored, address) => {
    const named = marketOfAddress(address);
    const market = named !== undefined ? named
      : stored.refused_market !== undefined && stored.refused_market !== null ? stored.refused_market : undefined;
    return {
      judge_session_market: true,
      ...(market === undefined ? {} : { ...marketParamsOf(market), market_replaces_session_market: true }),
    };
  };
  // Every cart a CREATE prices goes through here, so the market of its address travels with it. The executor is
  // the one place the rule is applied (quoteMarketOf); nothing else about a call is changed. An update names its
  // market itself (updateMarketParams), because what it means depends on the session.
  const executor = {
    execute(opId, params, ctx) {
      if (opId !== 'create_checkout_session') return canonicalExecutor.execute(opId, params, ctx);
      return canonicalExecutor.execute(opId, { ...params, ...marketParamsOf(marketOfAddress(params?.quote?.shipping_address)) }, ctx);
    },
  };
  // The cheap half of the rule, asked at intake: a market nothing is priced for is refused before a variant is
  // read, a claim is written or a quote is asked for. The executor asks again.
  const assertMarketPriced = (address, stage) => { quoteMarketOf(marketParamsOf(marketOfAddress(address)), stage); };

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
      ...normalizeAttestedBuyer(identity),
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
    // The shared rule (buyerIntake.js), here so a key it refuses is refused before the buyer is resolved, a session
    // is loaded or a product is read. THE KEY IS JUDGED AS SENT: the header value as the HTTP layer hands it over,
    // before `header()` removes the whitespace around it, so this door refuses exactly the keys the other doors
    // refuse. What can differ between the two values over HTTP is narrow: the HTTP layer has already removed the
    // spaces and tabs around a header value, and of the characters a header byte can decode to (U+0000 to U+00FF)
    // the only other one `trim()` removes that it lets through is U+00A0, the no-break space (byte 0xA0).
    assertIdempotencyKeyAcceptable(headerAsSent(req, 'idempotency-key'));
    // What this door USES is the value without the whitespace around it, as it always was, so every key still
    // accepted names the record it named before. Judged too: a second check on the value about to be used.
    assertIdempotencyKeyAcceptable(key);
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

  // ---- default-variant resolution ---------------------------------------------------------------------------
  //
  // The rule (resolve, never forge; refuse when ambiguous/impossible/mis-identified) and the load bounds live
  // in buyerIntake.js, shared with the MCP door. This door only supplies the executor and its own deadline.
  const resolveDefaultVariants = createDefaultVariantResolver({ executor, timeoutMs: deps.variantResolutionTimeoutMs });

  // ---- handlers -------------------------------------------------------------------------------------------

  async function createCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const buyer = await requireBuyer(req);
      const { user_ref } = buyer;
      // priced from the SIGNED bytes (validates non-empty items; resolves each item's default variant; refuses a
      // cart whose lines, as sent or as resolved, name one product and variant twice). Every refusal the cart can
      // get from intake is raised here, BEFORE the claim below is written.
      const quote = await mapItemsToQuote(trustedBody(req), buyer, resolveDefaultVariants, (address) => assertMarketPriced(address, 'create'));

      // ACP-layer create idempotency (Codex P1): a replayed (buyer, key) returns the ORIGINAL session instead
      // of minting a new one — no quote/inventory-hold amplification.
      // JSON-tuple key (NOT a delimiter-join): unambiguous regardless of whether buyer/key contain spaces, so
      // two distinct (buyer, key) pairs can never collide (Codex round-2 #3; same lesson as the executor scoping).
      //
      // THE CLAIM IS HELD ONLY WHILE IT STANDS FOR SOMETHING. It is written before the pricer is called, so that
      // two creates under one key never both price. It used to stay whatever happened next: a create the pricer
      // refused left the key pointing at a session that was never written, and the caller's retry with the same
      // key (which a retriable refusal invites) was answered QUOTE_NOT_FOUND for the whole window. Now, as the
      // kernel ledger does it (idempotencyLedger.js):
      //   - the claim is PENDING under a lease (CREATE_CLAIM_LEASE_MS) while the create runs. Another create
      //     under the key in that time is told the outcome is not known yet, to ask again with the same key
      //     (`in_flight`), and prices nothing;
      //   - a create that fails with nothing behind it (createFailedWithNothingBehindIt) RELEASES its claim: the
      //     same key is a first create again at once;
      //   - a create whose outcome nobody can know keeps its claim until the lease ends. The pricer may still be
      //     working on it, so the key asks nothing more of the pricer meanwhile; after the lease a create under
      //     the key is a first create. A process that died mid-create leaves exactly this, and it ends the same way;
      //   - a create that succeeds writes its session and then turns the claim into DONE, for what is left of the
      //     dedup window counted from the claim (as before). Only a DONE claim is replayed.
      // Every write after the claim is conditional on the claim still being THIS attempt's (its minted session
      // id, unique to the attempt): an attempt that outlived its lease can neither delete nor finish a claim that
      // another attempt has since written.
      const createKey = JSON.stringify(['acpcreate', user_ref, idempotency_key]);
      const minted = randomUUID();
      // A store with no conditional write cannot give a claim back safely, so on such a store the claim is what
      // it always was: written once for the whole window and never released.
      const conditional = typeof sessionStore.compareAndSet === 'function' && typeof sessionStore.compareAndDelete === 'function';
      const claimedAt = now();
      const claim = conditional ? { acp_session_id: minted, status: CREATE_PENDING } : { acp_session_id: minted };
      let claimed = false;
      for (let attempt = 0; attempt < MAX_CREATE_CLAIM_ATTEMPTS; attempt += 1) {
        claimed = await sessionStore.putIfAbsent(createKey, claim, { ttlMs: conditional ? CREATE_CLAIM_LEASE_MS : CREATE_DEDUP_TTL_MS });
        if (claimed) break;
        const prior = await sessionStore.get(createKey);
        // Released (or expired) between the two calls: the key is free, so try to claim it again.
        if (prior === undefined || prior === null) continue;
        if (isPlainObject(prior) && prior.status === CREATE_PENDING) throw outcomeUnknown('in_flight');
        const stored = await ownedSession(prior.acp_session_id, user_ref);
        return readSession(prior.acp_session_id, stored, { user_ref, acp_session_id: prior.acp_session_id, protocol: ACP_PROTOCOL_NAME });
      }
      if (!claimed) throw outcomeUnknown('race');

      const ctx = { user_ref, acp_session_id: minted, protocol: ACP_PROTOCOL_NAME };
      let session;
      try {
        session = await executor.execute('create_checkout_session', { idempotency_key, quote }, ctx);
      } catch (err) {
        if (conditional && createFailedWithNothingBehindIt(err)) {
          // OUR claim only. A failure to release changes nothing the caller is told: the lease ends the claim.
          try { await sessionStore.compareAndDelete(createKey, 'acp_session_id', minted); } catch { /* the lease ends it */ }
        }
        throw err;
      }
      await sessionStore.set(minted, { quote_id: session.session_id, order_id: null, user_ref, rev: randomUUID() });
      if (conditional) {
        const remainingMs = Math.max(1, CREATE_DEDUP_TTL_MS - (now() - claimedAt));
        const finished = await sessionStore.compareAndSet(createKey, 'acp_session_id', minted, { acp_session_id: minted, status: CREATE_DONE }, { ttlMs: remainingMs });
        if (!finished) {
          // The lease ended while this attempt was still pricing, and the key is no longer ours: another attempt
          // may have created the session this key stands for. Ours is never handed out.
          if (typeof sessionStore.delete === 'function') {
            try { await sessionStore.delete(minted); } catch { /* nothing points at it */ }
          }
          throw outcomeUnknown('lease_lost_after_op');
        }
      }
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
      // The per-line ceiling is decided on the body alone, so it is answered before the session is loaded (one
      // store read). After the buyer, never before: a caller with no verified buyer is still told that first. A
      // body that does not parse is left to the checks below, in their own order.
      assertLineQuantitiesWithinMaximum(peekItems(req));
      // One line per product and variant, at the same place for the same reason.
      assertNoDuplicateLines(peekItems(req));
      const stored = await ownedSession(acp_session_id, user_ref);
      // A session that is over is not re-priced: refused by name here, before the cart is read or priced.
      assertSessionOpen(stored);
      // An update RE-MINTS the quote snapshot (executor: create/update share previewQuote), and the snapshot
      // is the ONLY carrier of buyer_context on this lane — so the update body must carry the buyer/address
      // intake again, exactly as create did. Anything it omits is not "kept", it is DROPPED.
      const ctx = { user_ref, acp_session_id, protocol: ACP_PROTOCOL_NAME };
      let session;
      try {
        const quote = await mapItemsToQuote(trustedBody(req), buyer, resolveDefaultVariants, (address) => assertMarketPriced(address, 'update'));
        session = await executor.execute('update_checkout_session', { idempotency_key, session_id: stored.quote_id, quote, ...updateMarketParams(stored, quote.shipping_address) }, ctx);
      } catch (err) {
        // REFUSED FOR ITS MARKET: no quote was recorded, so the session still holds the one it had. It is marked
        // only when that held quote is not priced for the market this update named (markRefusedMarket).
        await markRefusedMarket(acp_session_id, stored, marketOfMarketRefusal(err), ctx);
        throw err;
      }
      // The session now holds this update's quote, judged for this update's market: an earlier mark is gone.
      // Written only onto a session that is still open: one completed or cancelled while this update was being
      // priced keeps what it has (the quote this update minted is never handed out), and the caller is told so.
      const written = await writeSession(acp_session_id, stored, (current) => {
        if (!sessionIsOpen(current)) return null;
        const { refused_market: _answered, ...kept } = current;
        return { ...kept, quote_id: session.session_id };
      });
      if (!written) {
        assertSessionOpen(await ownedSession(acp_session_id, user_ref));
        throw outcomeUnknown('race');
      }
      return { status: 200, body: acpSessionBody(acp_session_id, session, written) };
    });
  }

  async function getCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const { user_ref } = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      return readSession(acp_session_id, stored, { user_ref, acp_session_id, protocol: ACP_PROTOCOL_NAME });
    });
  }

  async function completeCheckoutSession(req) {
    return guard(async () => {
      await auth(req);
      const idempotency_key = requireIdempotencyKey(req);
      const { user_ref } = await requireBuyer(req);
      const acp_session_id = pathId(req);
      const stored = await ownedSession(acp_session_id, user_ref);
      // A cancelled session is not paid. (A completed one goes on: the same key replays its order, and any other
      // key is refused by the kernel, whose single-use claim on the quote is what makes that so.)
      if (stored.canceled === true) assertSessionOpen(stored);
      const body = trustedBody(req);
      const ctx = { user_ref, acp_session_id, protocol: ACP_PROTOCOL_NAME };
      const shipping_address = addressForMarket(mapAddress(body));
      let out;
      try {
        out = await executor.execute('complete_checkout_session', {
          idempotency_key,
          session_id: stored.quote_id,
          authorization_checkout_session_id: acp_session_id,
          payment_authorization: paymentAuthorization(body), // ACP `payment_data` — verified by the executor
          shipping_address,
          // EVERY market this completion is judged for, before either payment lane (the executor,
          // judgeSessionMarkets): the country of the address it carries, in its own right, and the mark a refused
          // request left on the session, beside it and never in its place.
          ...marketParamsOf(marketOfAddress(shipping_address)),
          ...heldMarketParams(stored),
          // A completion with no address to ship to (none on the session's quote, none here) is refused by name
          // before any order is asked for (the executor reads the quote). The value says where to supply one.
          fulfillment_address_required: ADDRESS_UPDATE_HINT,
        }, ctx);
      } catch (err) {
        // A session a cancellation won (it holds the quote's single-use claim, see cancelCheckoutSession) answers
        // as cancelled, whether or not the record said so when this completion read it.
        if (err instanceof PivotaCommerceError && err.code === 'QUOTE_ALREADY_USED' && err.detail?.claim === 'canceled') {
          throw new PivotaCommerceError('ORDER_CANCELED', { reason: 'checkout_session_canceled' });
        }
        // A completion refused for its market writes nothing: every completion is judged for its own address, so a
        // mark from this one would add no judgement and would only stand in the way of a later, correct one.
        throw err;
      }
      // THE ORDER ID IS NEVER LOST, AND THE SESSION'S QUOTE IS THE ONE THAT WAS PAID. Written on top of whatever the
      // record is now: an update that re-priced the session while this completion was being paid does not leave a
      // completed session pointing at an unpaid quote.
      const order_id = out.order?.order_id ?? stored.order_id;
      // Money moved: whatever else the record says, the session is completed (never cancelled, never marked).
      const completed = (current) => { const { refused_market: _answered, canceled: _never, ...kept } = current; return { ...kept, quote_id: stored.quote_id, order_id }; };
      try {
        await writeSession(acp_session_id, stored, completed);
      } catch (err) {
        if (!(err instanceof PivotaCommerceError)) throw err;
        // Every conditional try lost its race: write it over what is there. The order exists; the record says so.
        const current = await sessionStore.get(acp_session_id);
        await sessionStore.set(acp_session_id, { ...completed(isPlainObject(current) ? current : stored), rev: randomUUID() });
      }
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
      const ctx = { user_ref, acp_session_id, protocol: ACP_PROTOCOL_NAME };
      const canceled = { status: 200, body: { id: acp_session_id, object: 'checkout_session', status: 'canceled' } };
      // A CANCELLATION AND A COMPLETION OF ONE SESSION: EXACTLY ONE WINS. For a session with no order the executor
      // takes the quote's single-use claim (`cancel_claims_session`), the claim an order takes: once the
      // cancellation holds it no completion can be paid, and when an order holds it (a completion that finished,
      // or is still in flight) the cancellation is refused and nothing is recorded. For a session WITH an order
      // the executor answers for the order (a paid one is not cancelled).
      // The record is written `canceled` only for the session this request cancelled, AS IT IS NOW: if an order id
      // has appeared on it since it was read, or it has been re-priced (the claim taken above is on the quote it
      // held then, not the one it holds now), nothing is written and the request decides again on what is there:
      // it claims the quote the session holds now. So exactly one of a cancellation and a completion wins for the
      // SESSION, whatever quote it holds. The tries are bounded; a session re-priced under every one of them is
      // answered "outcome unknown, ask again" (409, retriable) and is not recorded as cancelled.
      for (let attempt = 0; attempt < MAX_SESSION_WRITE_ATTEMPTS; attempt += 1) {
        const stored = await ownedSession(acp_session_id, user_ref);
        if (stored.canceled === true) return canceled; // cancelling again is the same answer
        await executor.execute('cancel_checkout_session', { idempotency_key, session_id: stored.quote_id, order_id: stored.order_id ?? undefined, cancel_claims_session: true }, ctx);
        let sessionChanged = false;
        try {
          await writeSession(acp_session_id, stored, (current) => {
            if (current.canceled === true) return null;
            if ((current.order_id ?? null) !== (stored.order_id ?? null) || current.quote_id !== stored.quote_id) { sessionChanged = true; return null; }
            const { refused_market: _answered, ...kept } = current;
            return { ...kept, canceled: true };
          });
        } catch { /* the cancellation was done; the next cancel writes it */ }
        if (!sessionChanged) return canceled;
      }
      throw outcomeUnknown('race');
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

// The cart lines of the SIGNED body, or undefined when it is absent, not JSON or not an object. Never throws:
// what is wrong with such a body is `trustedBody`'s to say, where it always said it.
const peekItems = (req) => {
  try {
    const parsed = typeof req?.rawBody === 'string' ? JSON.parse(req.rawBody) : undefined;
    return isPlainObject(parsed) ? parsed.items : undefined;
  } catch {
    return undefined;
  }
};

/** A header's value exactly as the request carries it (a string), else undefined. Read, never altered. */
const headerAsSent = (req, name) => {
  const h = req?.headers ?? {};
  const v = h[name] ?? h[name.toLowerCase()] ?? h[name.toUpperCase()];
  return typeof v === 'string' ? v : undefined;
};
const header = (req, name) => {
  const v = headerAsSent(req, name);
  return v === undefined ? undefined : v.trim();
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
// ---- WHERE THE RULES LIVE ----------------------------------------------------------------------------------
//
// The three rules themselves — attested-wins email precedence, the required-address field set, and
// default-variant resolution (resolve, never forge; refuse when ambiguous, impossible or mis-identified) —
// plus the per-cart load bounds and every refusal message live in ./buyerIntake.js, which is shared with the
// MCP commerce door. Read that file for WHY each rule is what it is; this file only maps ACP's body shapes
// onto it.

// ACP body -> canonical quote request. Every RULE here is imported from ./buyerIntake.js; what this function
// owns is the ACP body SHAPE — where ACP puts the merchant, the buyer, the address and the discount codes.
// A caller-set amount/total/currency never reaches pricing, because nothing here copies one.
//
// `buyer` is the VERIFIED identity from requireBuyer, not anything read from the body.
//
// `resolveDefaultVariants` is the closure-bound resolver above; it is the ONLY step in here that talks to
// another service, and it runs LAST — after every cheap refusal — so a request that was going to be refused
// anyway never costs an upstream read.
async function mapItemsToQuote(body, buyer = {}, resolveDefaultVariants, assertMarketPriced) {
  const b = isPlainObject(body) ? body : {};
  const items = normalizeCartItems(b.items);
  const quote = { merchant_id: str(b.merchant_id) ?? str(b.merchant?.id), items };
  const codes = Array.isArray(b.discount_codes) ? b.discount_codes.filter((c) => typeof c === 'string') : undefined;
  if (codes && codes.length) quote.discount_codes = codes;
  const addr = mapAddress(b);
  if (addr) quote.shipping_address = addr;

  // PRECEDENCE IS THE POINT — enforced in resolveBuyerEmail: the attested address is read FIRST, so a body
  // value can only ever fill a gap and can never override what the verified buyer credential asserted.
  //
  // ACP's two body spellings collapse with `??` BEFORE normalization, deliberately: a PRESENT-but-malformed
  // `buyer.email` is the caller's error and must be refused, not silently papered over by a `customer_email`
  // sitting beside it.
  const acpBuyer = isPlainObject(b.buyer) ? b.buyer : {};
  // Reaches the kernel's buyer_context via kernel.js buyerContextFromQuotePayload (quote.customer_email /
  // quote.customer_name), which is what the order lane's buyer_context is built from.
  quote.customer_email = resolveBuyerEmail(buyer.attested_email, [acpBuyer.email ?? b.customer_email], {
    acceptedBodyFields: ['buyer.email', 'customer_email'],
  });
  const customer_name = resolveBuyerName(buyer.attested_name, [joinName(acpBuyer.first_name, acpBuyer.last_name), b.customer_name]);
  if (customer_name) quote.customer_name = customer_name;

  // THE MARKET THE ADDRESS NAMES, asked here when the door supplies the check: after the refusals that cost
  // nothing and can be fixed by the caller (the lines, the address, the buyer), and before the variant read and
  // the caller's claim and quote. A country this door cannot read, and a market nothing is priced for, are
  // refused by name with nothing read, claimed or priced. No address: no market, and nothing is asked.
  if (typeof assertMarketPriced === 'function') assertMarketPriced(quote.shipping_address);
  // The address travels with its country as that market code (addressForMarket), from here on.
  if (quote.shipping_address) quote.shipping_address = addressForMarket(quote.shipping_address);

  // LAST: resolve a default variant for every item that arrived without one (items are mutated in place, so
  // the resolved id is what reaches `quote.items` and therefore pricing). Deliberately after the buyer/address
  // refusals — those are free, this one is a network read — and deliberately before the caller's
  // `preview_quote`, so a refused request never prices anything or takes an inventory hold.
  //
  // DEAD TODAY, KEPT ON PURPOSE: both call sites (create/update) always pass the closure, so the fail-closed
  // branch is unreachable through the adapter. It is defence in depth against a future call site —
  // mapItemsToQuote is a plain module-level function and nothing forces the third argument.
  if (typeof resolveDefaultVariants !== 'function') assertNoUnresolvedVariants(items);
  else await resolveDefaultVariants(items, quote.merchant_id, { user_ref: buyer.user_ref });
  // ONE LINE PER PRODUCT AND VARIANT, ASKED AGAIN ON THE RESOLVED LINES, HERE. `normalizeCartItems` asked it on the
  // lines as sent; a line that named no variant now carries the one the read resolved, so a line that named a
  // variant and a line that named none are refused here when they turned out to be the same. It must be HERE and
  // not left to the executor: a create writes its claim on the caller's key between this function and the
  // executor, and a cart that intake refuses claims nothing (a store with no conditional write could not give
  // the claim back at all). The refusal tells the caller to merge the lines and send again; with the same key,
  // that retry must be a first create. The executor still asks, as the second check.
  assertNoDuplicateLines(items);
  return quote;
}

// Which ACP body field carries the address is ACP's business; that it must be COMPLETE IF PRESENT is the
// shared rule (buyerIntake.js pickCompleteAddress), because the five required fields come from
// pivota-backend `_coerce_shipping_address` and are the same for every door.
//
// Optional, because ACP permits an address-less create (an agent prices first, the buyer picks a destination
// after) and this door HAS an update op that genuinely re-maps the address: update re-runs mapItemsToQuote
// and the executor's create/update both go through kernel.previewQuote, minting a fresh snapshot whose
// buyer_context carries the new address. Requiring one at create would refuse a spec-legal request that the
// protocol expects to succeed.
function mapAddress(body) {
  const a = isPlainObject(body?.fulfillment_address) ? body.fulfillment_address
    : isPlainObject(body?.shipping_address) ? body.shipping_address
    : isPlainObject(body?.address) ? body.address : null;
  if (!a) return undefined;
  // Name the concrete REST endpoint: an ACP client reads this out of `body.message`, and 'the update op'
  // does not tell it where to send one.
  return pickCompleteAddress(a, { updateHint: ADDRESS_UPDATE_HINT });
}

// THE BUYER'S MARKET, AS THIS PROTOCOL NAMES IT: the country of the fulfillment address, read as an ISO 3166-1
// alpha-2 code in any letter case. `undefined` when there is no address: the request names no market, and none
// is assumed. A country that is not two letters is refused by name; it is not echoed, guessed or priced.
function marketOfAddress(address) {
  if (!isPlainObject(address)) return undefined;
  // Two ASCII letters, tested BEFORE the case is changed: upper-casing folds some other letters into ASCII ones
  // (a long s into S, a dotless i into I), and a country that is not written in ASCII is not read as one that is.
  const written = typeof address.country === 'string' ? address.country.trim() : '';
  const market = /^[A-Za-z]{2}$/.test(written) ? written.toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(market)) {
    throw intakeRefusal('QUOTE_REQUIRED', 'market_invalid',
      'The fulfillment address `country` is not a country code this door can read, so there is no buyer market to price this checkout for. Send the buyer\'s country as ISO 3166-1 alpha-2 (two letters); a market is never guessed, and nothing was priced.',
      { rejected_field: 'fulfillment_address.country' });
  }
  return market;
}

// THE ADDRESS AS IT IS PRICED AND SHIPPED: with its country written as the market it was read as (two ASCII
// letters, upper case), so the country this door judges is, letter for letter, the country the quote and the order
// are sent with. `undefined` in, `undefined` out; a country that cannot be read is refused by name (marketOfAddress).
function addressForMarket(address) {
  return isPlainObject(address) ? { ...address, country: marketOfAddress(address) } : address;
}

// The market named by one of the two market refusals (canonicalExecutor.js quoteMarketOf), else null. Read from
// the refusal's own published detail, which only that rule writes with these reasons.
const MARKET_REFUSAL_REASONS = Object.freeze(['market_not_priced', 'seller_not_priced_in_market_currency']);
function marketOfMarketRefusal(err) {
  if (!(err instanceof PivotaCommerceError) || err.code !== 'NO_MERCHANT_OFFER') return null;
  const detail = surfaceableIntakeRefusal(err)?.detail;
  if (!detail || !MARKET_REFUSAL_REASONS.includes(detail.reason)) return null;
  return typeof detail.market === 'string' && /^[A-Z]{2}$/.test(detail.market) ? detail.market : null;
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
    // The AP2 binding JWT the wallet must hash. Allowlisted responses drop anything not named
    // here, so omitting it left AP2 unusable on this door even with the flag on. It is minted
    // over `id` (the ACP session id) — see attachAp2CheckoutJwt — and survives the sanitizer by
    // key+shape; see AP2_CHECKOUT_JWT_KEYS in resultSanitizer.js.
    ap2_checkout_jwt: session.ap2_checkout_jwt,
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
  // A create under a key whose earlier attempt has not finished, or whose outcome is not known. A conflict with
  // that attempt, not a malformed request (the `?? 400` default): the same request with the same key is the way on.
  CHECKOUT_OUTCOME_UNKNOWN: 409,
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
  // PARTNER_DOOR_ONE_PRODUCT_ID: the product exists and is withheld. 404 like the two above, and like
  // statusForCommerceKernelError in src/server.js (the other two new codes are 400 on both sides, the default).
  PRODUCT_NOT_SERVABLE: 404,
  OPERATION_NOT_ALLOWED: 409,
  PARTNER_ASSERTION_REJECTED: 409,
  ORDER_CANCELED: 409,
});

// Run a handler, mapping any throw to an ACP error response. PivotaCommerceError → its code + curated
// userMessage; anything else → a generic 500 (a raw error message is NEVER surfaced).
//
// The `detail` block is EXPLICIT OPT-IN via `detail.acp_detail` (buyerIntake.js intakeRefusal), matching the shape the
// delegate_payment refusal already emits: `{ type, code, message, detail }`. Ordinary PivotaCommerceError
// detail — which carries ids, session ids and internal reasons — is still never surfaced, and by
// construction an acp_detail block names FIELDS only, never a value taken from the request (no PII).
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PivotaCommerceError) {
      // The opt-in read lives in buyerIntake.js so both doors decide "is this refusal safe to surface?" the
      // same way, rather than each hand-inspecting the detail block.
      const surfaceable = surfaceableIntakeRefusal(err);
      const body = {
        type: 'error',
        code: err.code,
        message: surfaceable ? surfaceable.message : err.userMessage,
      };
      if (surfaceable) body.detail = surfaceable.detail;
      return { status: STATUS_BY_CODE[err.code] ?? 400, body };
    }
    return { status: 500, body: { type: 'error', code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } };
  }
}

// ---- small utilities --------------------------------------------------------------------------------------

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

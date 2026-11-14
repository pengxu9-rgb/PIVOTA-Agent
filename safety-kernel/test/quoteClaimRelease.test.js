// THE QUOTE'S SINGLE-USE CLAIM AFTER A FAILED create_order.
//
// createOrder claims the quote, then asks the upstream for the order. The claim has no expiry. The rule:
//
//   - the upstream REFUSED BEFORE ANY ORDER COULD EXIST (one of the listed status-and-code answers its order
//     path gives from its prologue) -> the claim is given back (this attempt's own claim only). The same key, or
//     another, is then a first attempt on that quote, judged afresh.
//   - ANYTHING ELSE -> the claim is KEPT: no answer, a status from in front of the upstream, every 5xx (a coded
//     503 included: the upstream answers it when its database was busy, which can be after the order was
//     written), a refusal its write step raises (stock, the quote re-read: that step can run twice in one
//     request), "this quote was already consumed", a failure that is not a refusal, an order that exists upstream
//     but could not be recorded here. The ledger gives the caller's key back on those too, so the claim is the
//     last guard against a second create_order.
//
// Driven through the three callers of createOrder (the executor's complete_checkout_session and
// create_payment_link, and the ACP REST adapter's complete), on both stores (in-memory, and Postgres over the
// shared SQL fake), with an injected clock and gates. Nothing waits on real time.
//
// The upstream here raises errors in the shape the gateway transport raises them (src/server.js
// throwCommerceKernelUpstreamError): the real transport is exercised by tests/quote_claim_release_door.
// Every name is a placeholder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { PostgresKvStore } from '../src/stores/postgresKvStore.js';
import { PivotaCommerceError } from '../src/errors.js';
import { readFileSync } from 'node:fs';
import { upstreamAnsweredRefusal, refusalsByStatus, REFUSED_BEFORE_ANY_ORDER, ASSERTION_REASONS_BEFORE_ANY_ORDER } from '../src/upstreamRefusal.js';
import { redact } from '../src/redact.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';
import { marketCurrencyOf } from './helpers/marketCurrency.js';

const T0 = 1_900_000_000_000;
const KSECRET = 'claim-kernel-secret-0123456789abcdef';
const ACP_SECRET = 'claim-acp-secret-0123456789abcdef';
const STORES = ['memory', 'postgres'];
const CALLERS = ['complete', 'payment_link', 'acp_complete'];
// What the stub backend prices a request in, by the country the request ships to (`none`: the request names no
// country). The gateway code under test holds no such table: a quote's currency is whatever the pricer answered.
const PRICED_IN = Object.freeze({ US: 'USD', SG: 'SGD', GB: 'GBP', DE: 'EUR', none: 'USD' });
const MARKETS = ['US', 'SG', 'GB', 'DE', null];
// The ACP door cannot reach an order for two of these. It refuses a market it has no currency for (DE) by name
// before any quote, and it refuses to complete a session that has no fulfillment address anywhere (no market)
// before any order is asked for: both pinned below. The tool doors keep all five.
const marketsFor = (caller) => (caller === 'acp_complete' ? MARKETS.filter((m) => m !== 'DE' && m !== null) : MARKETS);
const TOTAL = 11300;
const address = (country) => ({ name: 'Buyer One', address_line1: '1 Example Road', city: 'Exampleton', postal_code: '00001', country });

// ---- the upstream's failures, as the transport raises them ---------------------------------------------------

const KERNEL_CODE = { OUT_OF_STOCK: 'OUT_OF_STOCK', QUOTE_EXPIRED: 'QUOTE_EXPIRED', PRICE_CHANGED: 'PRICE_CHANGED', QUOTE_MISMATCH: 'PRICE_CHANGED', PARTNER_ASSERTION_REJECTED: 'PARTNER_ASSERTION_REJECTED' };
/**
 * A response that arrived: `status`, the error code the transport took from its body (null: it found none), and
 * the route's own detail, which the transport hands over whole. By default the detail names that same code in
 * `error`, as a raise site that chose the code writes it; `route` replaces the detail (undefined: none at all).
 * A refused caller assertion also says why (`reason`, `path` unless given).
 */
const answered = (status, upstreamCode = null, { route, reason = 'path' } = {}) => {
  const ownDetail = typeof upstreamCode === 'string'
    ? { error: upstreamCode, message: 'placeholder', ...(upstreamCode === 'PARTNER_ASSERTION_REJECTED' ? { reason } : {}) }
    : undefined;
  return new PivotaCommerceError((typeof upstreamCode === 'string' && Object.hasOwn(KERNEL_CODE, upstreamCode) && KERNEL_CODE[upstreamCode]) || 'MERCHANT_UNAVAILABLE', {
    operation: 'create_order', upstream_status: status, upstream_code: upstreamCode, message: undefined,
    upstream_detail: route === undefined ? ownDetail : route,
  });
};
/** No response: the deadline passed (`timeout`), or the connection failed. */
const noAnswer = ({ timeout = false } = {}) => new PivotaCommerceError('MERCHANT_UNAVAILABLE', {
  operation: 'create_order', upstream_status: null, upstream_code: null, message: undefined, upstream_detail: undefined,
  ...(timeout ? { upstream_timeout: true } : {}),
});

// ---- one world: a kernel, its stores, a scripted upstream, the three callers ---------------------------------

function world({ store = 'memory', requireBackendAmount = true } = {}) {
  let t = T0;
  const now = () => t;
  const db = store === 'postgres' ? makeFakePgDb(now) : null;
  const stores = new Map();
  const storeFactory = (ns) => {
    if (!stores.has(ns)) stores.set(ns, db ? new PostgresKvStore({ db, namespace: ns, now }) : new InMemoryKvStore({ now }));
    return stores.get(ns);
  };
  const log = [];
  const logger = { info: (event, fields) => log.push({ level: 'info', event, fields }), warn: (event, fields) => log.push({ level: 'warn', event, fields }), error() {} };

  const sent = []; // every upstream call, in order
  const upstreamOrders = []; // every order the upstream made
  const script = []; // create_order steps, consumed in order; none left = the order is made
  let quoteSeq = 0;
  const makeOrder = (payload, overrides = {}) => {
    const order = { order_id: `ord_${String(upstreamOrders.length + 1).padStart(4, '0')}`, quote_id: payload.order.quote_id, currency: payload.order._currency, total: payload.order._locked_totals.total };
    upstreamOrders.push(order);
    return { order_id: order.order_id, backend_amount_present: true, backend_amount_minor: order.total, backend_currency: order.currency, acp_state: {}, ...overrides };
  };
  const kernelUpstream = async (op, payload, headers) => {
    sent.push({ op, payload, headers });
    if (op === 'preview_quote') {
      const country = payload.quote?.shipping_address?.country;
      quoteSeq += 1;
      return {
        quote_id: `bq_${String(quoteSeq).padStart(4, '0')}`, merchant_of_record: 'merch_A', currency: PRICED_IN[country ?? 'none'],
        locked_totals: { subtotal: 10000, tax: 800, shipping: 500, total: TOTAL }, line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {},
      };
    }
    if (op === 'create_order') {
      const step = script.shift();
      return step ? step(payload, makeOrder) : makeOrder(payload);
    }
    if (op === 'submit_payment') return { payment_id: `pay_${payload.payment.order_id}`, payment_status: 'succeeded' };
    return {};
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KSECRET, log: logger, storeFactory, now, requireBackendAmount });
  const verified = [];
  const linkCalls = [];
  const executor = createCanonicalExecutor({
    kernel,
    upstream: async (op, payload) => {
      if (op === 'create_payment_link') { linkCalls.push(payload); return { checkout_url: `https://pay.example/c/${payload.order_id}`, checkout_session_id: `cs_${payload.order_id}` }; }
      return {};
    },
    verifyPaymentAuthorization: async (_a, b) => { verified.push(b); return { ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }; },
    hostedLinkEnabled: true,
  });
  const sessionStore = storeFactory('acp_sessions');
  const adapter = createAcpRestAdapter({
    executor, sessionStore, signingSecret: ACP_SECRET, now,
    resolveUserRef: async (req) => req.headers['x-test-buyer'],
    getProducts: async () => [],
    // The ACP door judges a quote's currency against the buyer's market and refuses without a source of it.
    marketCurrencyOf,
  });
  const acpReq = ({ body = {}, id, key }) => {
    const rawBody = JSON.stringify(body);
    const timestamp = String(t);
    return {
      headers: { timestamp, signature: createHmac('sha256', ACP_SECRET).update(`${timestamp}.${rawBody}`).digest('hex'), 'idempotency-key': key, 'x-test-buyer': 'buyer_1' },
      rawBody, body, params: id ? { checkout_session_id: id } : {},
    };
  };

  let opened = 0;
  /** A priced session for `market` (null: the request names no country), reached the way `caller` reaches one. */
  async function open(caller, market) {
    opened += 1;
    const key = `idem-open-${String(opened).padStart(4, '0')}`;
    if (caller === 'acp_complete') {
      const body = { merchant_id: 'merch_A', buyer: { email: 'buyer@example.test' }, items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], ...(market ? { fulfillment_address: address(market) } : {}) };
      const r = await adapter.createCheckoutSession(acpReq({ body, key }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const stored = await sessionStore.get(r.body.id);
      return { caller, market, acpId: r.body.id, quoteId: stored.quote_id, ctx: { user_ref: 'buyer_1', acp_session_id: r.body.id }, currency: r.body.currency };
    }
    const ctx = { user_ref: 'buyer_1', acp_session_id: `sess_${opened}` };
    const quote = { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }], customer_email: 'buyer@example.test', ...(market ? { shipping_address: address(market) } : {}) };
    const s = await executor.execute('create_checkout_session', { idempotency_key: key, quote }, ctx);
    return { caller, market, quoteId: s.session_id, ctx, currency: s.currency };
  }
  /**
   * One attempt at the order, the way `caller` makes it. Answers `{ ok, order_id, currency, code, reason, wire }`:
   * `wire` is everything the caller's own caller would see (the error as thrown, or the ACP response).
   */
  async function attempt(h, key) {
    try {
      if (h.caller === 'acp_complete') {
        const r = await adapter.completeCheckoutSession(acpReq({ body: { payment_data: { method: 'acp_delegated_token', token: 'placeholder' } }, id: h.acpId, key }));
        if (r.status === 200) return { ok: true, order_id: r.body.order.id, currency: r.body.order.currency, wire: r };
        return { ok: false, code: r.body.code, wire: r };
      }
      if (h.caller === 'complete') {
        const out = await executor.execute('complete_checkout_session', { idempotency_key: key, session_id: h.quoteId, payment_authorization: { method: 'acp_delegated_token', token: 'placeholder' } }, h.ctx);
        return { ok: true, order_id: out.order.order_id, currency: out.order.currency, amount_total: out.order.amount_total, wire: out };
      }
      const out = await executor.execute('create_payment_link', { idempotency_key: key, session_id: h.quoteId, customer_email: 'buyer@example.test' }, h.ctx);
      return { ok: true, order_id: out.order_id, currency: out.currency, amount_total: out.amount_total, wire: out };
    } catch (err) {
      if (!(err instanceof PivotaCommerceError)) return { ok: false, code: 'THROWN', reason: String(err?.message), wire: { thrown: String(err?.message) } };
      return { ok: false, code: err.code, reason: err.detail?.reason ?? null, wire: { code: err.code, retriable: err.retriable, message: err.message, detail: err.detail } };
    }
  }
  const claims = storeFactory('quote_claims');
  const createsSent = () => sent.filter((c) => c.op === 'create_order');
  return {
    kernel, executor, adapter, script, sent, upstreamOrders, log, verified, linkCalls, claims, storeFactory, db,
    open, attempt, createsSent, advance: (ms) => { t += ms; }, now,
  };
}

/** A gate: `step` waits at the upstream until `release()`, then does `then`. `reached` resolves when it is waiting. */
function gate(then) {
  let release;
  let arrive;
  const reached = new Promise((r) => { arrive = r; });
  const opened = new Promise((r) => { release = r; });
  const step = async (payload, makeOrder) => { arrive(); await opened; return then(payload, makeOrder); };
  return { step, reached, release };
}
const refuse = (status, code) => () => { throw answered(status, code); };
/**
 * Wait until the gate's request is at the upstream. If the attempt answers first it never got there: fail now,
 * with its answer, instead of waiting on a gate nobody will reach.
 */
const atUpstream = (g, running) => Promise.race([
  g.reached,
  running.then((r) => { throw new Error(`the attempt answered before it reached the upstream: ${JSON.stringify(r.wire)}`); }),
]);
// The two refusals the tests release with: one at each status the list has more than one code for.
const RELEASED = Object.freeze({ status: 400, code: 'INVALID_BUYER_CONTEXT' });
const RELEASED_409 = Object.freeze({ status: 409, code: 'PREFLIGHT_FAILED' });
const each = (fn) => async () => { for (const store of STORES) for (const caller of CALLERS) await fn(store, caller, `${store} / ${caller}`); };

// ---- the rule itself -----------------------------------------------------------------------------------------

const ALLOWED = [
  [400, 'INVALID_QUOTE'], [400, 'INVALID_BUYER_CONTEXT'], [400, 'QUOTE_REQUIRED_BEFORE_PURCHASE'], [400, 'QUOTE_MERCHANT_MISMATCH'], [400, 'VARIANT_REQUIRED'],
  [404, 'QUOTE_NOT_FOUND'],
  [409, 'PARTNER_ASSERTION_REJECTED'], [409, 'UNSUPPORTED_COMMERCE_PATH'], [409, 'PREFLIGHT_FAILED'],
];

const LIST_FILE = new URL('../contracts/order_create_prologue_refusals.json', import.meta.url);
// The file, to the byte: the upstream's repository holds the same bytes.
const LIST_FILE_TEXT = `[
  [400, "INVALID_BUYER_CONTEXT"],
  [400, "INVALID_QUOTE"],
  [400, "QUOTE_MERCHANT_MISMATCH"],
  [400, "QUOTE_REQUIRED_BEFORE_PURCHASE"],
  [400, "VARIANT_REQUIRED"],
  [404, "QUOTE_NOT_FOUND"],
  [409, "PARTNER_ASSERTION_REJECTED"],
  [409, "PREFLIGHT_FAILED"],
  [409, "UNSUPPORTED_COMMERCE_PATH"]
]
`;

test('the list of answers that give a claim back is the data file, and the file is exactly these nine status-and-code pairs', () => {
  const text = readFileSync(LIST_FILE, 'utf8');
  assert.equal(text, LIST_FILE_TEXT, 'the file, byte for byte');
  const pairs = JSON.parse(text);
  assert.deepEqual([...pairs].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)), pairs, 'sorted by status, then by code');
  assert.deepEqual(pairs.map(([st, c]) => `${st} ${c}`).sort(), ALLOWED.map(([st, c]) => `${st} ${c}`).sort());
  // The rule holds exactly the file: every pair of the file releases, and the rule's own table is the file's.
  assert.deepEqual(REFUSED_BEFORE_ANY_ORDER, refusalsByStatus(pairs));
  assert.deepEqual(Object.entries(REFUSED_BEFORE_ANY_ORDER).flatMap(([st, codes]) => codes.map((c) => [Number(st), c])), pairs);
  assert.deepEqual(REFUSED_BEFORE_ANY_ORDER, {
    400: ['INVALID_BUYER_CONTEXT', 'INVALID_QUOTE', 'QUOTE_MERCHANT_MISMATCH', 'QUOTE_REQUIRED_BEFORE_PURCHASE', 'VARIANT_REQUIRED'],
    404: ['QUOTE_NOT_FOUND'],
    409: ['PARTNER_ASSERTION_REJECTED', 'PREFLIGHT_FAILED', 'UNSUPPORTED_COMMERCE_PATH'],
  });
  assert.ok(Object.isFrozen(REFUSED_BEFORE_ANY_ORDER) && Object.values(REFUSED_BEFORE_ANY_ORDER).every(Object.isFrozen));
  for (const [status, code] of pairs) {
    const expected = { upstream_status: status, upstream_code: code, ...(code === 'PARTNER_ASSERTION_REJECTED' ? { upstream_reason: 'path' } : {}) };
    assert.deepEqual(upstreamAnsweredRefusal(answered(status, code)), expected, `${status} ${code}`);
  }
  // A file that is not a list of [status, "CODE"] pairs is refused when it is loaded, never read loosely.
  for (const bad of [null, {}, [], [[400]], [['400', 'INVALID_QUOTE']], [[400, 'invalid_quote']], [[400, 'INVALID_QUOTE', 'x']], [{ status: 400, code: 'INVALID_QUOTE' }], [[400.5, 'INVALID_QUOTE']]]) {
    assert.throws(() => refusalsByStatus(bad), /order_create_prologue_refusals/, JSON.stringify(bad));
  }
});

test('a listed code gives the claim back only when the route\'s own detail names it: not from the envelope\'s outer code, not from a message', () => {
  const listed = (route) => answered(400, 'INVALID_BUYER_CONTEXT', { route });
  // The only releasing form: the raise site wrote the code in its detail.
  assert.deepEqual(upstreamAnsweredRefusal(listed({ error: 'INVALID_BUYER_CONTEXT', message: 'buyer_context.customer_email is required for order creation' })), { upstream_status: 400, upstream_code: 'INVALID_BUYER_CONTEXT' });
  const kept = [
    // The transport found the code in the envelope's status-derived `error.code`: the detail names none.
    ['the code only in the outer error.code', { message: 'Insufficient inventory', items: [] }],
    // The transport found it in the envelope's message: the detail's `error` is the prose, or is absent.
    ['the code only in a message string', { message: 'INVALID_BUYER_CONTEXT' }],
    ['the detail naming prose', { error: 'buyer context is invalid' }],
    ['the detail naming another listed code', { error: 'INVALID_QUOTE' }],
    ['the detail naming the code in lower case', { error: 'invalid_buyer_context' }],
    ['the detail naming the code under another member', { code: 'INVALID_BUYER_CONTEXT' }],
    ['the detail naming a list that holds the code', { error: ['INVALID_BUYER_CONTEXT'] }],
    ['an empty detail', {}],
    ['a detail that is a string', 'INVALID_BUYER_CONTEXT'],
    ['a detail that is a list', ['INVALID_BUYER_CONTEXT']],
    ['a null detail', null],
  ];
  for (const [label, route] of kept) assert.equal(upstreamAnsweredRefusal(listed(route)), null, label);
  // No detail at all (the transport passes none on when the body had none).
  assert.equal(upstreamAnsweredRefusal(new PivotaCommerceError('MERCHANT_UNAVAILABLE', { upstream_status: 400, upstream_code: 'INVALID_BUYER_CONTEXT' })), null, 'no detail');
  // Every listed pair, with the code present in `upstream_code` and absent from the detail.
  for (const [status, code] of ALLOWED) {
    assert.equal(upstreamAnsweredRefusal(answered(status, code, { route: { message: code, reason: 'path' } })), null, `${status} ${code}`);
  }
});

test('a refused caller assertion gives the claim back for eight reasons; replay, stale, subject, no reason and any other reason keep it', () => {
  assert.deepEqual(ASSERTION_REASONS_BEFORE_ANY_ORDER, ['no_secret', 'malformed', 'bad_mac', 'op', 'method', 'path', 'resource', 'body']);
  assert.ok(Object.isFrozen(ASSERTION_REASONS_BEFORE_ANY_ORDER));
  const refused = (route) => answered(409, 'PARTNER_ASSERTION_REJECTED', { route });
  const message = 'The partner assertion on this request was refused; it was not made as any partner.';
  for (const reason of ASSERTION_REASONS_BEFORE_ANY_ORDER) {
    assert.deepEqual(upstreamAnsweredRefusal(refused({ error: 'PARTNER_ASSERTION_REJECTED', reason, message })), { upstream_status: 409, upstream_code: 'PARTNER_ASSERTION_REJECTED', upstream_reason: reason }, reason);
  }
  const kept = [
    ['replay: the upstream already accepted this very request once', { reason: 'replay' }],
    ['stale: what a second copy is told once the nonce is forgotten', { reason: 'stale' }],
    ['subject: the agent record was switched off, or could not be read (cannot tell)', { reason: 'subject' }],
    ['no reason', {}],
    ['a null reason', { reason: null }],
    ['an empty reason', { reason: '' }],
    ['a reason that is not a string', { reason: 7 }],
    ['a reason that is a list holding a good one', { reason: ['path'] }],
    ['a reason this rule does not know', { reason: 'nonce_store_unavailable' }],
    ['a good reason in upper case', { reason: 'PATH' }],
    ['a good reason with a space after it', { reason: 'path ' }],
    ['replay beside a good reason under another name', { reason: 'replay', why: 'path' }],
    ['a reason named like something every list has', { reason: 'length' }],
  ];
  for (const [label, extra] of kept) assert.equal(upstreamAnsweredRefusal(refused({ error: 'PARTNER_ASSERTION_REJECTED', message, ...extra })), null, label);
  // The reason is read only for that code: another listed code that happens to say `replay` is not an assertion.
  assert.deepEqual(upstreamAnsweredRefusal(answered(409, 'PREFLIGHT_FAILED', { route: { error: 'PREFLIGHT_FAILED', reason: 'replay' } })), { upstream_status: 409, upstream_code: 'PREFLIGHT_FAILED' });
});

test('nothing else gives a claim back: no 503, no consumed quote, no refusal of the write step, no listed code at another status, no status class', () => {
  const allCodes = ALLOWED.map(([, code]) => code);
  // Every listed code at every status it is NOT listed for.
  for (const code of allCodes) {
    for (const status of [200, 399, 400, 401, 403, 404, 408, 409, 422, 429, 499, 500, 502, 503, 504]) {
      if (ALLOWED.some(([st, c]) => st === status && c === code)) continue;
      assert.equal(upstreamAnsweredRefusal(answered(status, code)), null, `${status} ${code}`);
    }
  }
  // Everything a listed refusal carries (the status, the code, the route's detail naming it), with one thing wrong.
  const full = (over) => ({ upstream_status: 400, upstream_code: 'INVALID_BUYER_CONTEXT', upstream_detail: { error: 'INVALID_BUYER_CONTEXT', message: 'placeholder' }, ...over });
  assert.deepEqual(upstreamAnsweredRefusal(new PivotaCommerceError('MERCHANT_UNAVAILABLE', full({}))), { upstream_status: 400, upstream_code: 'INVALID_BUYER_CONTEXT' }, 'the control: nothing wrong releases');
  const no = [
    // The upstream's database was busy: the order may have been written before it said so.
    ['a 503 the upstream names', answered(503, 'TEMPORARY_UNAVAILABLE')],
    ['a 503 with the code the upstream gives every 503', answered(503, 'EXTERNAL_SERVICE_ERROR')],
    // An order already used this quote.
    ['a consumed quote', answered(409, 'QUOTE_CONSUMED')],
    // Raised by the write step, which can run a second time in one request after its first run wrote the order.
    ['an expired quote', answered(409, 'QUOTE_EXPIRED')],
    ['a quote that no longer matches', answered(409, 'QUOTE_MISMATCH')],
    ['a quote that must be repriced', answered(409, 'QUOTE_STALE_REPRICE_REQUIRED')],
    ['a quote not found by the write step', answered(409, 'QUOTE_NOT_FOUND')],
    ['an out-of-stock code', answered(409, 'OUT_OF_STOCK')],
    ['a merchant not accepting orders', answered(403, 'MERCHANT_NOT_ACCEPTING_ORDERS')],
    ['a quote required by the write step', answered(400, 'QUOTE_REQUIRED')],
    ['a checkout quote required by the write step', answered(400, 'CHECKOUT_QUOTE_REQUIRED')],
    // The codes the upstream derives from the status alone: they say nothing about where the failure was.
    ['a 400 with the code every 400 gets (insufficient inventory arrives as this)', answered(400, 'INVALID_REQUEST')],
    ['a 401 with the code every 401 gets', answered(401, 'UNAUTHORIZED')],
    ['a 403 with the code every 403 gets', answered(403, 'FORBIDDEN')],
    ['a 404 with the code every 404 gets', answered(404, 'PRODUCT_NOT_FOUND')],
    ['a 409 with the code every 409 gets', answered(409, 'CONFLICT')],
    ['a 429 with the code every 429 gets', answered(429, 'RATE_LIMIT_EXCEEDED')],
    ['a 500 with the code every 500 gets', answered(500, 'INTERNAL_SERVER_ERROR')],
    ['a 502 with a code', answered(502, 'EXTERNAL_SERVICE_ERROR')],
    ['a 504 with a code', answered(504, 'TEMPORARY_UNAVAILABLE')],
    ['a 408 with a code', answered(408, 'REQUEST_TIMEOUT')],
    // No code, or not one of the listed codes exactly.
    ['a listed status that names no code', answered(400, null)],
    ['a listed code in lower case', answered(400, 'invalid_buyer_context')],
    ['a listed code with a space after it', answered(400, 'INVALID_BUYER_CONTEXT ')],
    ['a listed code as the start of another', answered(400, 'INVALID_BUYER_CONTEXT_V2')],
    ['an empty code', answered(400, '')],
    ['a code that is not a string', answered(400, 400)],
    ['a code that is a list holding a listed code', answered(400, ['INVALID_QUOTE'])],
    ['a code named like something every object has', answered(400, 'toString')],
    ['a status named like something every object has', new PivotaCommerceError('MERCHANT_UNAVAILABLE', { upstream_status: 'constructor', upstream_code: 'INVALID_QUOTE' })],
    // The transport did not vouch for it.
    ['a deadline', noAnswer({ timeout: true })],
    ['a lost connection', noAnswer()],
    ['a deadline that also carries a listed status and code', new PivotaCommerceError('MERCHANT_UNAVAILABLE', full({ upstream_timeout: true }))],
    ['a listed status as a string', new PivotaCommerceError('MERCHANT_UNAVAILABLE', full({ upstream_status: '400' }))],
    ['a status that is not whole', new PivotaCommerceError('MERCHANT_UNAVAILABLE', full({ upstream_status: 400.5 }))],
    ['a listed code with no status', new PivotaCommerceError('MERCHANT_UNAVAILABLE', (({ upstream_status: _s, ...rest }) => rest)(full({})))],
    ['a listed code with a null status', new PivotaCommerceError('MERCHANT_UNAVAILABLE', full({ upstream_status: null }))],
    ['a refusal this process raised itself', new PivotaCommerceError('OUT_OF_STOCK')],
    ['a refusal with a reason and a status under another name', new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'backend_http_error', status: 400, code: 'INVALID_BUYER_CONTEXT' })],
    ['a refusal whose detail is a list', Object.assign(new PivotaCommerceError('MERCHANT_UNAVAILABLE'), { detail: [400, 'INVALID_BUYER_CONTEXT'] })],
    ['a refusal with no detail', Object.assign(new PivotaCommerceError('MERCHANT_UNAVAILABLE'), { detail: null })],
    ['a plain error', new Error('socket hang up')],
    ['a plain error dressed as a listed refusal', Object.assign(new Error('x'), { code: 'MERCHANT_UNAVAILABLE', detail: full({}) })],
    ['a string', 'INVALID_BUYER_CONTEXT'],
    ['nothing', undefined],
    ['null', null],
  ];
  for (const [label, err] of no) assert.equal(upstreamAnsweredRefusal(err), null, label);
});

// ---- a refusal before any order gives the claim back ------------------------------------------------------------------

test('a refusal before any order (400 INVALID_BUYER_CONTEXT): the failing attempt is answered as raised, the claim is gone, and the same key then creates the order exactly once', each(async (store, caller, label) => {
  for (const market of marketsFor(caller)) {
    const w = world({ store });
    const h = await w.open(caller, market);
    assert.equal(h.currency, PRICED_IN[market ?? 'none'], `${label} ${market}: the session is priced in the request market's currency`);
    w.script.push(refuse(RELEASED.status, RELEASED.code));
    const first = await w.attempt(h, 'idem-claim-0001');
    assert.equal(first.ok, false, label);
    assert.equal(first.code, 'MERCHANT_UNAVAILABLE', label);
    if (caller !== 'acp_complete') {
      assert.deepEqual(first.wire, { code: 'MERCHANT_UNAVAILABLE', retriable: true, message: 'The merchant is temporarily unreachable. Please try again shortly.', detail: { operation: 'create_order', upstream_status: 400, upstream_code: 'INVALID_BUYER_CONTEXT', message: undefined, upstream_detail: { error: 'INVALID_BUYER_CONTEXT', message: 'placeholder' } } }, label);
    } else {
      assert.deepEqual(first.wire, { status: 503, body: { type: 'error', code: 'MERCHANT_UNAVAILABLE', message: 'The merchant is temporarily unreachable. Please try again shortly.' } }, label);
    }
    assert.equal(await w.claims.get(h.quoteId), undefined, `${label}: the claim was given back`);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), false, label);
    assert.equal(w.upstreamOrders.length, 0, label);

    const second = await w.attempt(h, 'idem-claim-0001');
    assert.equal(second.ok, true, `${label} ${market}: ${JSON.stringify(second.wire)}`);
    assert.equal(w.createsSent().length, 2, `${label}: one refused create, one that made the order`);
    assert.equal(w.upstreamOrders.length, 1, `${label}: exactly one order`);
    assert.equal(second.order_id, w.upstreamOrders[0].order_id, label);
    // The order is in the currency the request market was priced in, at the locked total, both as told to the
    // upstream and as answered.
    assert.equal(second.currency, PRICED_IN[market ?? 'none'], `${label} ${market}`);
    assert.equal(w.createsSent()[1].payload.order._currency, PRICED_IN[market ?? 'none'], `${label} ${market}`);
    assert.equal(w.createsSent()[1].payload.order._locked_totals.total, TOTAL, label);
    assert.equal(w.upstreamOrders[0].currency, PRICED_IN[market ?? 'none'], label);
    // Both sends carried the same idempotency key, so an upstream that did keep something replays it.
    assert.equal(w.createsSent()[0].headers['Idempotency-Key'], w.createsSent()[1].headers['Idempotency-Key'], label);

    // A third call with the key replays the one order and sends nothing.
    const third = await w.attempt(h, 'idem-claim-0001');
    assert.equal(third.ok, true, label);
    assert.equal(third.order_id, second.order_id, label);
    assert.equal(w.createsSent().length, 2, label);
    assert.equal(w.upstreamOrders.length, 1, label);
    // The claim is held again, by the attempt that made the order.
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, label);
    // And another key on the spent quote is refused, as before.
    const other = await w.attempt(h, 'idem-claim-0002');
    assert.equal(other.code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.createsSent().length, 2, label);
  }
}));

test('every listed refusal gives the claim back, and a DIFFERENT key is then a first attempt too', each(async (store, caller, label) => {
  for (const [status, code] of ALLOWED) {
    const kernelCode = Object.hasOwn(KERNEL_CODE, code) ? KERNEL_CODE[code] : 'MERCHANT_UNAVAILABLE';
    const w = world({ store });
    const h = await w.open(caller, 'US');
    w.script.push(refuse(status, code));
    const first = await w.attempt(h, 'idem-named-0001');
    assert.equal(first.code, kernelCode, `${label} ${code}`);
    assert.equal(await w.claims.get(h.quoteId), undefined, `${label} ${code}: released`);
    assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')), [
      { level: 'info', event: 'quote_claim_released', fields: { quote_id: h.quoteId, code: kernelCode, released: true, upstream_status: status, upstream_code: code, ...(code === 'PARTNER_ASSERTION_REJECTED' ? { upstream_reason: 'path' } : {}) } },
    ], `${label} ${code}`);
    const second = await w.attempt(h, 'idem-named-0002');
    assert.equal(second.ok, true, `${label} ${code}: ${JSON.stringify(second.wire)}`);
    assert.equal(w.upstreamOrders.length, 1, `${label} ${code}`);
    // The first key is free as well: it now meets the spent quote, like any other key.
    const again = await w.attempt(h, 'idem-named-0001');
    assert.equal(again.code, 'QUOTE_ALREADY_USED', `${label} ${code}`);
    assert.equal(w.createsSent().length, 2, `${label} ${code}`);
  }
}));

test('after a released refusal the retry is judged afresh: expiry, the upstream\'s own view of the quote, and the locked total', each(async (store, caller, label) => {
  const first = async (w, h, key) => assert.equal((await w.attempt(h, key)).code, 'MERCHANT_UNAVAILABLE', label);
  // (a) the quote expired meanwhile: refused before anything is sent.
  {
    const w = world({ store });
    const h = await w.open(caller, 'SG');
    w.script.push(refuse(RELEASED_409.status, RELEASED_409.code));
    await first(w, h, 'idem-fresh-0001');
    w.advance(10 * 60 * 1000 + 1);
    const retry = await w.attempt(h, 'idem-fresh-0001');
    assert.equal(retry.code, 'QUOTE_EXPIRED', `${label}: ${JSON.stringify(retry.wire)}`);
    assert.equal(w.createsSent().length, 1, `${label}: an expired quote sends no create_order`);
    assert.equal(w.upstreamOrders.length, 0, label);
  }
  // (b) the upstream refuses the retry: again from its prologue (released again), then from its write step,
  //     saying the price changed (relayed, and from then on the claim is kept).
  {
    const w = world({ store });
    const h = await w.open(caller, 'GB');
    w.script.push(refuse(RELEASED_409.status, RELEASED_409.code), refuse(400, 'QUOTE_MERCHANT_MISMATCH'), refuse(409, 'QUOTE_MISMATCH'));
    await first(w, h, 'idem-fresh-0002');
    await first(w, h, 'idem-fresh-0002');
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), false, label);
    const retry = await w.attempt(h, 'idem-fresh-0002');
    assert.equal(retry.code, 'PRICE_CHANGED', label);
    assert.equal(w.upstreamOrders.length, 0, label);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, `${label}: a refusal of the write step keeps the claim`);
    assert.equal((await w.attempt(h, 'idem-fresh-0002')).code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.createsSent().length, 3, label);
  }
  // (c) the upstream makes the order at ANOTHER amount, or in another currency: never answered as an order.
  for (const overrides of [{ backend_amount_minor: TOTAL + 100 }, { backend_currency: 'USD' }, { backend_amount_present: false }]) {
    const w = world({ store });
    const h = await w.open(caller, 'GB');
    w.script.push(refuse(RELEASED_409.status, RELEASED_409.code), (payload, makeOrder) => makeOrder(payload, overrides));
    await first(w, h, 'idem-fresh-0003');
    const retry = await w.attempt(h, 'idem-fresh-0003');
    assert.equal(retry.code, 'PRICE_CHANGED', `${label} ${JSON.stringify(overrides)}: ${JSON.stringify(retry.wire)}`);
    // An order exists upstream now, so this claim stays.
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, label);
    const after = await w.attempt(h, 'idem-fresh-0003');
    assert.equal(after.ok, false, label);
    assert.equal(w.createsSent().length, 2, `${label}: nothing more is sent`);
    assert.equal(w.upstreamOrders.length, 1, label);
  }
  // (d) the retry goes through: the order is made at the locked total, in the quote's currency, and what is
  //     sent to the upstream is the same locked quote as the first time.
  {
    const w = world({ store });
    const market = caller === 'acp_complete' ? 'GB' : 'DE';
    const h = await w.open(caller, market);
    w.script.push(refuse(RELEASED_409.status, RELEASED_409.code));
    await first(w, h, 'idem-fresh-0004');
    const retry = await w.attempt(h, 'idem-fresh-0004');
    assert.equal(retry.ok, true, label);
    assert.equal(retry.currency, PRICED_IN[market], label);
    const [a, b] = w.createsSent();
    assert.deepEqual(b.payload, a.payload, `${label}: the retry sends the same locked quote`);
    assert.equal(b.payload.order._locked_totals.total, TOTAL, label);
  }
}));

test('on the ACP door a market with no currency (DE) is refused by name before any quote, so no claim is ever written for it', async () => {
  for (const store of STORES) {
    const w = world({ store });
    await assert.rejects(() => w.open('acp_complete', 'DE'), (err) => /NO_MERCHANT_OFFER/.test(String(err?.message)) && /market_not_priced|DE/.test(String(err?.message)), store);
    assert.equal(w.upstreamOrders.length, 0, store);
  }
});

test('on the ACP door a session with no fulfillment address is refused by name at completion, before any order, and its claim is never taken', async () => {
  for (const store of STORES) {
    const w = world({ store });
    const h = await w.open('acp_complete', null);
    const r = await w.attempt(h, 'idem-noaddr-0001');
    assert.equal(r.ok, false, store);
    assert.equal(r.code, 'QUOTE_REQUIRED', store);
    assert.equal(w.upstreamOrders.length, 0, store);
    assert.equal(w.createsSent().length, 0, store);
    assert.equal((await w.claims.get(h.quoteId)) ?? null, null, `${store}: no claim`);
  }
});

// ---- everything else keeps it ----------------------------------------------------------------------------------

const UNKNOWN_OUTCOMES = [
  ['a deadline', () => { throw noAnswer({ timeout: true }); }, 'MERCHANT_UNAVAILABLE'],
  ['a lost connection', () => { throw noAnswer(); }, 'MERCHANT_UNAVAILABLE'],
  ['a 502 with a code', refuse(502, 'TEMPORARY_UNAVAILABLE'), 'MERCHANT_UNAVAILABLE'],
  ['a 504 with a code', refuse(504, 'TEMPORARY_UNAVAILABLE'), 'MERCHANT_UNAVAILABLE'],
  ['a 500 with a code', refuse(500, 'TEMPORARY_UNAVAILABLE'), 'MERCHANT_UNAVAILABLE'],
  ['a 503 with no code', refuse(503, null), 'MERCHANT_UNAVAILABLE'],
  ['a 503 the upstream names (its database was busy)', refuse(503, 'TEMPORARY_UNAVAILABLE'), 'MERCHANT_UNAVAILABLE'],
  ['a consumed quote', refuse(409, 'QUOTE_CONSUMED'), 'MERCHANT_UNAVAILABLE'],
  ['an expired quote', refuse(409, 'QUOTE_EXPIRED'), 'QUOTE_EXPIRED'],
  ['a quote that no longer matches', refuse(409, 'QUOTE_MISMATCH'), 'PRICE_CHANGED'],
  ['an out-of-stock code', refuse(409, 'OUT_OF_STOCK'), 'OUT_OF_STOCK'],
  ['insufficient inventory, as the upstream sends it (400, the code every 400 gets)', refuse(400, 'INVALID_REQUEST'), 'MERCHANT_UNAVAILABLE'],
  ['a merchant not accepting orders', refuse(403, 'MERCHANT_NOT_ACCEPTING_ORDERS'), 'MERCHANT_UNAVAILABLE'],
  ['a listed code at a status it is not listed for', refuse(409, 'INVALID_BUYER_CONTEXT'), 'MERCHANT_UNAVAILABLE'],
  ['a rate limit', refuse(429, 'RATE_LIMIT_EXCEEDED'), 'MERCHANT_UNAVAILABLE'],
  ['a refused caller assertion: replay', () => { throw answered(409, 'PARTNER_ASSERTION_REJECTED', { reason: 'replay' }); }, 'PARTNER_ASSERTION_REJECTED'],
  ['a refused caller assertion: stale', () => { throw answered(409, 'PARTNER_ASSERTION_REJECTED', { reason: 'stale' }); }, 'PARTNER_ASSERTION_REJECTED'],
  ['a refused caller assertion: subject', () => { throw answered(409, 'PARTNER_ASSERTION_REJECTED', { reason: 'subject' }); }, 'PARTNER_ASSERTION_REJECTED'],
  ['a refused caller assertion with no reason', () => { throw answered(409, 'PARTNER_ASSERTION_REJECTED', { route: { error: 'PARTNER_ASSERTION_REJECTED' } }); }, 'PARTNER_ASSERTION_REJECTED'],
  ['a listed code the transport took from a message, not from the route\'s detail', () => { throw answered(400, 'INVALID_BUYER_CONTEXT', { route: { message: 'INVALID_BUYER_CONTEXT' } }); }, 'MERCHANT_UNAVAILABLE'],
  ['a listed code the transport took from the outer status-derived code', () => { throw answered(400, 'INVALID_QUOTE', { route: { message: 'placeholder', items: [] } }); }, 'MERCHANT_UNAVAILABLE'],
  ['a 409 with no code', refuse(409, null), 'MERCHANT_UNAVAILABLE'],
  ['a 408 with a code', refuse(408, 'REQUEST_TIMEOUT'), 'MERCHANT_UNAVAILABLE'],
  ['a refusal with no status', () => { throw new PivotaCommerceError('OUT_OF_STOCK'); }, 'OUT_OF_STOCK'],
  ['a failure that is not a refusal', () => { throw new TypeError('cannot read the answer'); }, null],
];

test('an outcome nobody can know keeps the claim: the same key and another key both send NO second create_order', each(async (store, caller, label) => {
  for (const [name, step, code] of UNKNOWN_OUTCOMES) {
    for (const landed of [false, true]) {
      const w = world({ store });
      const h = await w.open(caller, 'US');
      // `landed`: the upstream made the order and the answer was lost. From here the two cases look the same.
      w.script.push((payload, makeOrder) => { if (landed) makeOrder(payload); return step(); });
      const first = await w.attempt(h, 'idem-unknown-0001');
      assert.equal(first.ok, false, `${label} ${name}`);
      if (code) assert.equal(first.code, code, `${label} ${name}`);
      assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, `${label} ${name}: the claim is kept`);
      assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')), [
        { level: 'warn', event: 'quote_claim_kept', fields: { quote_id: h.quoteId, code, reason: 'create_order_outcome_unknown' } },
      ], `${label} ${name}`);

      for (const key of ['idem-unknown-0001', 'idem-unknown-0002', 'idem-unknown-0001']) {
        const retry = await w.attempt(h, key);
        // What a retry is told while the claim is held is what it was told before this rule existed.
        assert.equal(retry.code, 'QUOTE_ALREADY_USED', `${label} ${name} ${key}: ${JSON.stringify(retry.wire)}`);
        assert.equal(w.createsSent().length, 1, `${label} ${name} ${key}: no second create_order`);
      }
      assert.equal(w.upstreamOrders.length, landed ? 1 : 0, `${label} ${name}`);
      // Time does not free it either: the claim has no expiry.
      w.advance(5 * 60 * 1000);
      assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, `${label} ${name}`);
      assert.equal((await w.attempt(h, 'idem-unknown-0001')).code, 'QUOTE_ALREADY_USED', `${label} ${name}`);
      assert.equal(w.createsSent().length, 1, `${label} ${name}`);
    }
  }
}));

test('an order that exists upstream and could not be recorded here keeps the claim, and nothing is ever sent again', each(async (store, caller, label) => {
  // The order record's write fails after the upstream made the order.
  const w = world({ store });
  const h = await w.open(caller, 'US');
  const orders = w.storeFactory('orders');
  const realSet = orders.set.bind(orders);
  let failing = true;
  orders.set = async (...args) => { if (failing) throw new Error('store write failed'); return realSet(...args); };
  const first = await w.attempt(h, 'idem-write-0001');
  assert.equal(first.ok, false, label);
  assert.equal(w.upstreamOrders.length, 1, label);
  assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, `${label}: kept`);
  assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')), [], `${label}: the claim was never up for release`);
  failing = false;
  const sameKey = await w.attempt(h, 'idem-write-0001');
  // The complete lane reads the claim before anything else; the payment link meets its own order key first.
  assert.equal(sameKey.code, caller === 'payment_link' ? 'IDEMPOTENCY_CONFLICT' : 'QUOTE_ALREADY_USED', `${label}: ${JSON.stringify(sameKey.wire)}`);
  if (caller === 'payment_link') assert.equal(sameKey.reason, 'ambiguous_prior_attempt', label);
  assert.equal((await w.attempt(h, 'idem-write-0002')).code, 'QUOTE_ALREADY_USED', label);
  assert.equal(w.createsSent().length, 1, `${label}: one create_order, ever`);
  assert.equal(w.upstreamOrders.length, 1, label);
}));

test('a failure AFTER the order was made and recorded keeps the claim (the payment link\'s page, the charge)', async () => {
  for (const store of STORES) {
    // The hosted page could not be minted: the order exists, the claim stays.
    {
      const w = world({ store });
      const h = await w.open('payment_link', 'US');
      const exec = createCanonicalExecutor({ kernel: w.kernel, hostedLinkEnabled: true, upstream: async () => { throw answered(RELEASED.status, RELEASED.code); } });
      await assert.rejects(exec.execute('create_payment_link', { idempotency_key: 'idem-after-0001', session_id: h.quoteId }, h.ctx), (e) => e.code === 'MERCHANT_UNAVAILABLE');
      assert.equal(w.upstreamOrders.length, 1, store);
      assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, store);
      await assert.rejects(exec.execute('create_payment_link', { idempotency_key: 'idem-after-0001', session_id: h.quoteId }, h.ctx), (e) => e.code === 'IDEMPOTENCY_CONFLICT' && e.detail.reason === 'ambiguous_prior_attempt');
      await assert.rejects(exec.execute('create_payment_link', { idempotency_key: 'idem-after-0002', session_id: h.quoteId }, h.ctx), (e) => e.code === 'QUOTE_ALREADY_USED');
      assert.equal(w.createsSent().length, 1, store);
    }
    // The charge was refused by name: still an order, still claimed.
    {
      const w = world({ store });
      const h = await w.open('complete', 'US');
      const realUpstream = w.kernel._upstream;
      w.kernel._upstream = async (op, ...rest) => { if (op === 'submit_payment') throw answered(RELEASED.status, RELEASED.code); return realUpstream(op, ...rest); };
      assert.equal((await w.attempt(h, 'idem-after-0003')).code, 'MERCHANT_UNAVAILABLE', store);
      assert.equal(w.upstreamOrders.length, 1, store);
      assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, store);
      assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')), [], store);
      assert.equal((await w.attempt(h, 'idem-after-0003')).code, 'IDEMPOTENCY_CONFLICT', store);
      assert.equal((await w.attempt(h, 'idem-after-0004')).code, 'QUOTE_ALREADY_USED', store);
      assert.equal(w.createsSent().length, 1, store);
    }
  }
});

// ---- the release is this attempt's own, and can change no answer ---------------------------------------------

test('the claim names its attempt, and only that attempt\'s claim is ever deleted', each(async (store, caller, label) => {
  const w = world({ store });
  const h = await w.open(caller, 'US');
  const g = gate(refuse(RELEASED.status, RELEASED.code));
  w.script.push(g.step);
  const running = w.attempt(h, 'idem-own-0001');
  await atUpstream(g, running);
  const mine = await w.claims.get(h.quoteId);
  assert.equal(typeof mine.claim_id, 'string', label);
  assert.match(mine.claim_id, /^[0-9a-f-]{36}$/, label);
  assert.equal(typeof mine.idempotency_key, 'string', label);
  // While this attempt waits on the upstream the record becomes someone else's: the same caller key, another
  // attempt. (No path here does that today: the claim has no expiry. The delete must not depend on that.)
  const theirs = { idempotency_key: mine.idempotency_key, claim_id: '00000000-0000-4000-8000-000000000000' };
  await w.claims.set(h.quoteId, theirs);
  g.release();
  assert.equal((await running).code, 'MERCHANT_UNAVAILABLE', label);
  assert.deepEqual(await w.claims.get(h.quoteId), theirs, `${label}: another attempt's claim is untouched`);
  assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')).map((l) => [l.event, l.fields.released]), [['quote_claim_released', false]], label);
  assert.equal((await w.attempt(h, 'idem-own-0001')).code, 'QUOTE_ALREADY_USED', label);
  assert.equal(w.createsSent().length, 1, label);
}));

test('a claim written by an older build (no claim_id) or by a cancel is never deleted', async () => {
  for (const store of STORES) {
    for (const foreign of [{ idempotency_key: 'someone-elses-key' }, { canceled: true }, { idempotency_key: 'k', claim_id: null }, { claim_id: 'undefined' }]) {
      const w = world({ store });
      const h = await w.open('payment_link', 'US');
      const g = gate(refuse(RELEASED_409.status, RELEASED_409.code));
      w.script.push(g.step);
      const running = w.attempt(h, 'idem-old-0001');
      await atUpstream(g, running);
      await w.claims.set(h.quoteId, foreign);
      g.release();
      assert.equal((await running).code, 'MERCHANT_UNAVAILABLE', store);
      assert.deepEqual(await w.claims.get(h.quoteId), foreign, `${store} ${JSON.stringify(foreign)}`);
    }
  }
});

test('a release that fails, a store that cannot delete conditionally and a logger that throws all leave the answer as raised and the claim in place', each(async (store, caller, label) => {
  // The conditional delete throws.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    w.claims.compareAndDelete = async () => { throw new Error('store unavailable'); };
    w.script.push(refuse(RELEASED.status, RELEASED.code));
    const first = await w.attempt(h, 'idem-fail-0001');
    assert.equal(first.code, 'MERCHANT_UNAVAILABLE', `${label}: ${JSON.stringify(first.wire)}`);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, label);
    assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')).map((l) => [l.level, l.event, l.fields.reason]), [['warn', 'quote_claim_kept', 'release_failed']], label);
    assert.equal((await w.attempt(h, 'idem-fail-0001')).code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.createsSent().length, 1, label);
  }
  // The store has no conditional delete: the plain delete is never used instead.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    w.claims.compareAndDelete = undefined;
    let deletes = 0;
    const realDelete = w.claims.delete.bind(w.claims);
    w.claims.delete = async (...a) => { deletes += 1; return realDelete(...a); };
    w.script.push(refuse(RELEASED.status, RELEASED.code));
    assert.equal((await w.attempt(h, 'idem-fail-0002')).code, 'MERCHANT_UNAVAILABLE', label);
    assert.equal(deletes, 0, label);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, label);
  }
  // The logger throws on every line: the release still happens and the answer is the upstream's.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    w.kernel._log = { info() { throw new Error('logger down'); }, warn() { throw new Error('logger down'); } };
    w.script.push(refuse(RELEASED.status, RELEASED.code), () => { throw noAnswer({ timeout: true }); });
    assert.equal((await w.attempt(h, 'idem-fail-0003')).code, 'MERCHANT_UNAVAILABLE', label);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), false, label);
    assert.equal((await w.attempt(h, 'idem-fail-0003')).code, 'MERCHANT_UNAVAILABLE', label);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, label);
  }
}));

test('the claim is given back before the failed attempt answers, and before the ledger gives the key back', each(async (store, caller, label) => {
  const w = world({ store });
  const h = await w.open(caller, 'US');
  const order = [];
  const realCad = w.claims.compareAndDelete.bind(w.claims);
  w.claims.compareAndDelete = async (...a) => { const r = await realCad(...a); order.push('claim'); return r; };
  const ledger = w.storeFactory('idempotency');
  const realLedgerCad = ledger.compareAndDelete.bind(ledger);
  ledger.compareAndDelete = async (...a) => { order.push('ledger'); return realLedgerCad(...a); };
  w.script.push(refuse(RELEASED.status, RELEASED.code));
  await w.attempt(h, 'idem-order-0001');
  order.push('answered');
  assert.equal(order[0], 'claim', `${label}: ${order.join(',')}`);
  assert.equal(order[order.length - 1], 'answered', label);
  assert.ok(order.filter((x) => x === 'ledger').length >= 1, label);
  assert.equal(order.filter((x) => x === 'claim').length, 1, label);
}));

// ---- races -----------------------------------------------------------------------------------------------------

test('two attempts with the SAME key: the second waits out the first, and after a named refusal the key creates one order', each(async (store, caller, label) => {
  const w = world({ store });
  const h = await w.open(caller, 'US');
  const g = gate(refuse(RELEASED.status, RELEASED.code));
  w.script.push(g.step);
  const a = w.attempt(h, 'idem-race-0001');
  await atUpstream(g, a);
  // B arrives while A is at the upstream: refused by the ledger, sends nothing.
  const b = await w.attempt(h, 'idem-race-0001');
  assert.equal(b.code, 'IDEMPOTENCY_CONFLICT', `${label}: ${JSON.stringify(b.wire)}`);
  assert.equal(b.reason ?? 'in_flight', 'in_flight', label);
  assert.equal(w.createsSent().length, 1, label);
  g.release();
  assert.equal((await a).code, 'MERCHANT_UNAVAILABLE', label);
  // Now two more at once with the key: one makes the order, the other is refused or replays it. Never two.
  const g2 = gate((payload, makeOrder) => makeOrder(payload));
  w.script.push(g2.step);
  const c = w.attempt(h, 'idem-race-0001');
  await atUpstream(g2, c);
  const d = await w.attempt(h, 'idem-race-0001');
  assert.equal(d.code, 'IDEMPOTENCY_CONFLICT', label);
  g2.release();
  assert.equal((await c).ok, true, label);
  assert.equal(w.createsSent().length, 2, label);
  assert.equal(w.upstreamOrders.length, 1, label);
  const e = await w.attempt(h, 'idem-race-0001');
  assert.equal(e.ok, true, label);
  assert.equal(e.order_id, w.upstreamOrders[0].order_id, label);
  assert.equal(w.createsSent().length, 2, label);
}));

test('two attempts with DIFFERENT keys on one quote, every order of arrival: at most one create_order is ever in flight, and one order', each(async (store, caller, label) => {
  // A is at the upstream; B arrives: refused, sends nothing. A is then refused by name; C creates.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    const g = gate(refuse(RELEASED_409.status, RELEASED_409.code));
    w.script.push(g.step);
    const a = w.attempt(h, 'idem-diff-000A');
    await atUpstream(g, a);
    const b = await w.attempt(h, 'idem-diff-000B');
    assert.equal(b.code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.createsSent().length, 1, label);
    g.release();
    assert.equal((await a).code, 'MERCHANT_UNAVAILABLE', label);
    const c = await w.attempt(h, 'idem-diff-000B');
    assert.equal(c.ok, true, `${label}: ${JSON.stringify(c.wire)}`);
    assert.equal(w.upstreamOrders.length, 1, label);
  }
  // A is at the upstream and SUCCEEDS; B arrived meanwhile and after: refused both times.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    const g = gate((payload, makeOrder) => makeOrder(payload));
    w.script.push(g.step);
    const a = w.attempt(h, 'idem-diff-000C');
    await atUpstream(g, a);
    assert.equal((await w.attempt(h, 'idem-diff-000D')).code, 'QUOTE_ALREADY_USED', label);
    g.release();
    assert.equal((await a).ok, true, label);
    assert.equal((await w.attempt(h, 'idem-diff-000D')).code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.createsSent().length, 1, label);
    assert.equal(w.upstreamOrders.length, 1, label);
  }
  // A is at the upstream and its outcome is never known; B, before and after: refused, nothing sent.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    const g = gate((payload, makeOrder) => { makeOrder(payload); throw noAnswer({ timeout: true }); });
    w.script.push(g.step);
    const a = w.attempt(h, 'idem-diff-000E');
    await atUpstream(g, a);
    assert.equal((await w.attempt(h, 'idem-diff-000F')).code, 'QUOTE_ALREADY_USED', label);
    g.release();
    assert.equal((await a).code, 'MERCHANT_UNAVAILABLE', label);
    assert.equal((await w.attempt(h, 'idem-diff-000F')).code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.createsSent().length, 1, label);
    assert.equal(w.upstreamOrders.length, 1, label);
  }
  // A is refused by name; B and C then start together: one claims and creates, the other is refused.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    w.script.push(refuse(RELEASED.status, RELEASED.code));
    assert.equal((await w.attempt(h, 'idem-diff-000G')).code, 'MERCHANT_UNAVAILABLE', label);
    const g = gate((payload, makeOrder) => makeOrder(payload));
    w.script.push(g.step);
    const b = w.attempt(h, 'idem-diff-000H');
    const c = w.attempt(h, 'idem-diff-000I');
    await atUpstream(g, c);
    g.release();
    const results = await Promise.all([b, c]);
    assert.equal(results.filter((r) => r.ok).length, 1, `${label}: ${JSON.stringify(results.map((r) => r.code ?? 'ok'))}`);
    assert.equal(results.filter((r) => r.code === 'QUOTE_ALREADY_USED').length, 1, label);
    assert.equal(w.createsSent().length, 2, label);
    assert.equal(w.upstreamOrders.length, 1, label);
  }
}));

test('the release lands while another key is between its two reads of the claim: that key is refused or creates, never both creating', each(async (store, caller, label) => {
  // B's claim attempt is held at the store until A's release has landed: B then wins the claim and creates.
  const w = world({ store });
  const h = await w.open(caller, 'US');
  const gA = gate(refuse(RELEASED.status, RELEASED.code));
  w.script.push(gA.step);
  const a = w.attempt(h, 'idem-mid-000A');
  await atUpstream(gA, a);
  const realPut = w.claims.putIfAbsent.bind(w.claims);
  let hold;
  let held;
  const bAtClaim = new Promise((r) => { held = r; });
  w.claims.putIfAbsent = async (...args) => { held(); await new Promise((r) => { hold = r; }); w.claims.putIfAbsent = realPut; return realPut(...args); };
  // The complete lane's advisory read would refuse B first; let it through so B reaches the real claim.
  const realIsClaimed = w.kernel.isQuoteClaimed.bind(w.kernel);
  w.kernel.isQuoteClaimed = async () => false;
  const b = w.attempt(h, 'idem-mid-000B');
  await Promise.race([bAtClaim, b.then((r) => { throw new Error(`the second key answered before it reached the claim: ${JSON.stringify(r.wire)}`); })]);
  w.kernel.isQuoteClaimed = realIsClaimed;
  gA.release();
  assert.equal((await a).code, 'MERCHANT_UNAVAILABLE', label);
  assert.equal(await w.claims.get(h.quoteId), undefined, label);
  hold();
  const rb = await b;
  assert.equal(rb.ok, true, `${label}: ${JSON.stringify(rb.wire)}`);
  assert.equal(w.createsSent().length, 2, label);
  assert.equal(w.upstreamOrders.length, 1, label);
  assert.equal((await w.attempt(h, 'idem-mid-000A')).code, 'QUOTE_ALREADY_USED', label);
  assert.equal(w.createsSent().length, 2, label);
}));

test('the ledger lease runs out while the first attempt is still at the upstream: the key\'s second attempt sends nothing, whatever the first then hears', each(async (store, caller, label) => {
  for (const ending of ['refused', 'created', 'unknown']) {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    const g = gate((payload, makeOrder) => {
      if (ending === 'refused') throw answered(RELEASED.status, RELEASED.code);
      const made = makeOrder(payload);
      if (ending === 'unknown') throw noAnswer({ timeout: true });
      return made;
    });
    w.script.push(g.step);
    const a = w.attempt(h, 'idem-lease-0001');
    await atUpstream(g, a);
    w.advance(2 * 60 * 1000 + 1); // past the ledger's claim lease; the quote (10 min) is still live
    const b = await w.attempt(h, 'idem-lease-0001');
    assert.equal(b.code, 'QUOTE_ALREADY_USED', `${label} ${ending}: ${JSON.stringify(b.wire)}`);
    assert.equal(w.createsSent().length, 1, `${label} ${ending}`);
    g.release();
    const ra = await a;
    assert.equal(ra.ok, false, `${label} ${ending}: an attempt that lost its lease never answers an order`);
    if (ending === 'refused') {
      // A's own claim is given back; A's ledger records were B's to delete and are gone. The key starts over.
      assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), false, `${label} ${ending}`);
      const c = await w.attempt(h, 'idem-lease-0001');
      assert.equal(c.ok, true, `${label} ${ending}: ${JSON.stringify(c.wire)}`);
      assert.equal(w.upstreamOrders.length, 1, `${label} ${ending}`);
    } else {
      assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, `${label} ${ending}`);
      const c = await w.attempt(h, 'idem-lease-0001');
      assert.equal(c.ok, false, `${label} ${ending}`);
      assert.equal(w.createsSent().length, 1, `${label} ${ending}`);
      assert.equal(w.upstreamOrders.length, 1, `${label} ${ending}`);
    }
  }
}));

// ---- what must not have moved ------------------------------------------------------------------------------------

test('a refusal before the claim leaves no claim and sends nothing: an unknown session, another buyer\'s, an expired one, a short key', each(async (store, caller, label) => {
  const w = world({ store });
  const h = await w.open(caller, 'US');
  const before = w.sent.length;
  assert.equal((await w.attempt(h, 'short')).code, 'IDEMPOTENCY_CONFLICT', label);
  if (caller !== 'acp_complete') {
    assert.equal((await w.attempt({ ...h, quoteId: 'q_00000000-0000-4000-8000-000000000000' }, 'idem-pre-0001')).code, 'QUOTE_NOT_FOUND', label);
    assert.equal((await w.attempt({ ...h, ctx: { user_ref: 'buyer_2', acp_session_id: h.ctx.acp_session_id } }, 'idem-pre-0002')).code, 'STATE_LINKAGE_MISMATCH', label);
  }
  w.advance(10 * 60 * 1000 + 1);
  assert.equal((await w.attempt(h, 'idem-pre-0003')).code, 'QUOTE_EXPIRED', label);
  assert.equal(w.sent.length, before, `${label}: nothing was sent`);
  assert.equal(await w.claims.get(h.quoteId), undefined, label);
  assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')), [], label);
}));

test('a first attempt that succeeds is what it was: one create_order, one order in the request market\'s currency, a claim that stays', each(async (store, caller, label) => {
  for (const market of marketsFor(caller)) {
    const w = world({ store });
    const h = await w.open(caller, market);
    const r = await w.attempt(h, 'idem-plain-0001');
    assert.equal(r.ok, true, `${label} ${market}: ${JSON.stringify(r.wire)}`);
    assert.equal(r.currency, PRICED_IN[market ?? 'none'], `${label} ${market}`);
    assert.equal(w.createsSent().length, 1, label);
    assert.equal(w.createsSent()[0].payload.order._currency, PRICED_IN[market ?? 'none'], label);
    const claim = await w.claims.get(h.quoteId);
    assert.deepEqual(Object.keys(claim).sort(), ['claim_id', 'idempotency_key'], label);
    assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')), [], label);
    assert.equal((await w.attempt(h, 'idem-plain-0002')).code, 'QUOTE_ALREADY_USED', label);
  }
}));

// ---- the claim's id, pinned by assertion ---------------------------------------------------------------------------

test('the claim is written WITH its attempt\'s id before the upstream is asked, a fresh id for every attempt and every kernel', each(async (store, caller, label) => {
  const w = world({ store });
  const h = await w.open(caller, 'US');
  const seen = [];
  // No gate: the upstream step itself reads the claim that is in the store while the order is being asked for.
  const readThen = (then) => async (payload, makeOrder) => { seen.push(await w.claims.get(h.quoteId)); return then(payload, makeOrder); };
  w.script.push(readThen(refuse(RELEASED.status, RELEASED.code)), readThen(refuse(RELEASED_409.status, RELEASED_409.code)), readThen((payload, makeOrder) => makeOrder(payload)));
  assert.equal((await w.attempt(h, 'idem-id-0001')).code, 'MERCHANT_UNAVAILABLE', label);
  assert.equal(await w.claims.get(h.quoteId), undefined, `${label}: released`);
  assert.equal((await w.attempt(h, 'idem-id-0001')).code, 'MERCHANT_UNAVAILABLE', label);
  assert.equal(await w.claims.get(h.quoteId), undefined, `${label}: released again`);
  assert.equal((await w.attempt(h, 'idem-id-0002')).ok, true, label);
  assert.equal(seen.length, 3, `${label}: all three attempts reached the upstream`);
  for (const claim of seen) {
    assert.deepEqual(Object.keys(claim).sort(), ['claim_id', 'idempotency_key'], label);
    assert.match(claim.claim_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `${label}: a random id of its own`);
  }
  assert.equal(new Set(seen.map((c) => c.claim_id)).size, 3, `${label}: three attempts, three ids`);
  assert.equal(seen[0].idempotency_key, seen[1].idempotency_key, `${label}: the same caller key twice, and still two ids`);
  assert.deepEqual(await w.claims.get(h.quoteId), seen[2], `${label}: the claim that stays is the one that made the order`);
  // Another kernel (another process) never reuses an id either.
  const w2 = world({ store });
  const h2 = await w2.open(caller, 'US');
  assert.equal((await w2.attempt(h2, 'idem-id-0001')).ok, true, label);
  assert.equal(seen.map((c) => c.claim_id).includes((await w2.claims.get(h2.quoteId)).claim_id), false, label);
}));

test('a release matches the attempt\'s id and nothing else: an older build\'s claim under the SAME caller key survives it', each(async (store, caller, label) => {
  // Every shape a claim on this quote can have that is not this attempt's, each carrying this attempt's own
  // caller key where it has one. None may be deleted by this attempt's release.
  const foreign = (mine) => [
    { idempotency_key: mine.idempotency_key }, // an older build's claim, same caller key
    { idempotency_key: mine.idempotency_key, claim_id: '00000000-0000-4000-8000-000000000000' }, // another attempt, same caller key
    { idempotency_key: mine.idempotency_key, claim_id: mine.claim_id.toUpperCase() },
    { idempotency_key: mine.idempotency_key, claim_id: `${mine.claim_id} ` },
    { idempotency_key: mine.idempotency_key, claim_id: null },
    { idempotency_key: mine.idempotency_key, canceled: true },
  ];
  for (let i = 0; i < 6; i += 1) {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    let theirs;
    // No gate: the upstream step swaps the record, then refuses by a listed answer.
    w.script.push(async () => {
      const mine = await w.claims.get(h.quoteId);
      theirs = foreign(mine)[i];
      await w.claims.set(h.quoteId, theirs);
      throw answered(RELEASED.status, RELEASED.code);
    });
    const first = await w.attempt(h, 'idem-key-0001');
    assert.equal(first.code, 'MERCHANT_UNAVAILABLE', `${label} #${i}`);
    assert.ok(theirs, `${label} #${i}: the attempt reached the upstream`);
    assert.deepEqual(await w.claims.get(h.quoteId), theirs, `${label} #${i}: ${JSON.stringify(theirs)} survives`);
    assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')).map((l) => [l.event, l.fields.released]), [['quote_claim_released', false]], `${label} #${i}`);
    // The quote is still spent for everyone, the first key included. On the ACP door a claim that a
    // cancellation holds answers as the cancellation it is.
    const spent = theirs.canceled === true && caller === 'acp_complete' ? 'ORDER_CANCELED' : 'QUOTE_ALREADY_USED';
    assert.equal((await w.attempt(h, 'idem-key-0001')).code, spent, `${label} #${i}`);
    assert.equal(w.createsSent().length, 1, `${label} #${i}`);
  }
}));

test('the failed create rejects with the very error the upstream raised, not a copy of it', async () => {
  for (const store of STORES) {
    for (const raised of [answered(RELEASED.status, RELEASED.code), answered(503, 'TEMPORARY_UNAVAILABLE'), noAnswer({ timeout: true }), new TypeError('cannot read the answer')]) {
      const w = world({ store });
      const h = await w.open('complete', 'US');
      w.script.push(() => { throw raised; });
      await assert.rejects(
        w.kernel.createOrder({ idempotency_key: 'idem-same-0001', order: { quote_id: h.quoteId, shipping_address: {} } }, h.ctx),
        (err) => err === raised,
        `${store} ${raised.message}`,
      );
    }
  }
});

// ---- the order that exists behind a coded refusal -----------------------------------------------------------------

test('an order was written and the upstream still answered a coded refusal (a busy 503, a consumed quote, a refusal of its write step): no key ever sends a second create_order', each(async (store, caller, label) => {
  for (const [status, code] of [[503, 'TEMPORARY_UNAVAILABLE'], [503, 'EXTERNAL_SERVICE_ERROR'], [409, 'QUOTE_CONSUMED'], [400, 'INVALID_REQUEST'], [409, 'QUOTE_EXPIRED'], [409, 'CONFLICT'], [403, 'MERCHANT_NOT_ACCEPTING_ORDERS']]) {
    const w = world({ store });
    const h = await w.open(caller, 'SG');
    w.script.push((payload, makeOrder) => { makeOrder(payload); throw answered(status, code); });
    const first = await w.attempt(h, 'idem-behind-0001');
    assert.equal(first.ok, false, `${label} ${status} ${code}`);
    assert.equal(w.upstreamOrders.length, 1, `${label} ${status} ${code}: the order exists`);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, `${label} ${status} ${code}: kept`);
    // The retries the reviewer drove to a second order: the same key, another key, and both again later.
    for (const key of ['idem-behind-0001', 'idem-behind-0002', 'idem-behind-0001', 'idem-behind-0003']) {
      const retry = await w.attempt(h, key);
      assert.equal(retry.code, 'QUOTE_ALREADY_USED', `${label} ${status} ${code} ${key}: ${JSON.stringify(retry.wire)}`);
    }
    w.advance(3 * 60 * 1000);
    assert.equal((await w.attempt(h, 'idem-behind-0001')).code, 'QUOTE_ALREADY_USED', `${label} ${status} ${code}`);
    assert.equal(w.createsSent().length, 1, `${label} ${status} ${code}: one create_order, ever`);
    assert.equal(w.upstreamOrders.length, 1, `${label} ${status} ${code}: one order`);
  }
}));

// ---- the two claim log lines -----------------------------------------------------------------------------------

test('the claim log lines carry the quote id whole, and everything else in them is still redacted', async () => {
  // A quote id whose digits the redactor's card-number pattern matches across the hyphens.
  const quoteId = 'q_12345678-1234-4123-8123-123456789012';
  assert.notEqual(redact(quoteId), quoteId, 'this id is one the redactor would blank');
  const lines = [];
  const kernel = new SafetyKernel({ upstream: async () => ({}), secret: KSECRET, log: { info: (event, fields) => lines.push(['info', event, fields]), warn: (event, fields) => lines.push(['warn', event, fields]) } });
  const card = '4111 1111 1111 1111';

  // KEPT, for a failure whose code is a card-like number: the id is whole, the number is not there.
  await kernel._settleQuoteClaimAfterFailedCreate(quoteId, 'claim-0001', Object.assign(new Error('x'), { code: card }));
  // KEPT, for a failure whose code is an object holding key-like members.
  await kernel._settleQuoteClaimAfterFailedCreate(quoteId, 'claim-0001', Object.assign(new Error('x'), { code: { api_key: 'key-placeholder-0000000000000000', token: 'tok-placeholder', note: `card ${card}` } }));
  // RELEASED (nothing to delete: reported `released: false`).
  await kernel._settleQuoteClaimAfterFailedCreate(quoteId, 'claim-0001', answered(RELEASED.status, RELEASED.code));
  // KEPT because the delete failed.
  kernel._quoteClaims.compareAndDelete = async () => { throw new Error('store unavailable'); };
  await kernel._settleQuoteClaimAfterFailedCreate(quoteId, 'claim-0001', answered(409, 'PARTNER_ASSERTION_REJECTED', { reason: 'body' }));

  assert.deepEqual(lines, [
    ['warn', 'quote_claim_kept', { quote_id: quoteId, code: '[REDACTED_PAN]', reason: 'create_order_outcome_unknown' }],
    ['warn', 'quote_claim_kept', { quote_id: quoteId, code: { api_key: '[REDACTED]', token: '[REDACTED]', note: 'card [REDACTED_PAN]' }, reason: 'create_order_outcome_unknown' }],
    ['info', 'quote_claim_released', { quote_id: quoteId, code: 'MERCHANT_UNAVAILABLE', released: false, upstream_status: 400, upstream_code: 'INVALID_BUYER_CONTEXT' }],
    ['warn', 'quote_claim_kept', { quote_id: quoteId, code: 'PARTNER_ASSERTION_REJECTED', reason: 'release_failed', upstream_status: 409, upstream_code: 'PARTNER_ASSERTION_REJECTED', upstream_reason: 'body' }],
  ]);
  // Said the other way round: each line is the quote id plus the REDACTED rest, and no line holds the card
  // number or either key anywhere.
  for (const [, , fields] of lines) {
    const { quote_id: id, ...rest } = fields;
    assert.equal(id, quoteId);
    assert.deepEqual(rest, redact(rest), 'redacting the rest again changes nothing');
    assert.doesNotMatch(JSON.stringify(fields), /4111|key-placeholder|tok-placeholder/);
  }
});

// THE QUOTE'S SINGLE-USE CLAIM AFTER A FAILED create_order.
//
// createOrder claims the quote, then asks the upstream for the order. The claim has no expiry. The rule:
//
//   - the upstream ANSWERED A REFUSAL BY NAME  -> the claim is given back (this attempt's own claim only). The
//     same key, or another, is then a first attempt on that quote, judged afresh.
//   - ANYTHING ELSE (no answer, a status from in front of the upstream, a failure that is not a refusal, an
//     order that exists upstream but could not be recorded here) -> the claim is KEPT. The ledger gives the
//     caller's key back on those too, so the claim is the last guard against a second create_order.
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
import { upstreamAnsweredRefusal } from '../src/upstreamRefusal.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';

const T0 = 1_900_000_000_000;
const KSECRET = 'claim-kernel-secret-0123456789abcdef';
const ACP_SECRET = 'claim-acp-secret-0123456789abcdef';
const STORES = ['memory', 'postgres'];
const CALLERS = ['complete', 'payment_link', 'acp_complete'];
// What the stub backend prices a request in, by the country the request ships to (`none`: the request names no
// country). The gateway code under test holds no such table: a quote's currency is whatever the pricer answered.
const PRICED_IN = Object.freeze({ US: 'USD', SG: 'SGD', GB: 'GBP', DE: 'EUR', none: 'USD' });
const MARKETS = ['US', 'SG', 'GB', 'DE', null];
const TOTAL = 11300;
const address = (country) => ({ name: 'Buyer One', address_line1: '1 Example Road', city: 'Exampleton', postal_code: '00001', country });

// ---- the upstream's failures, as the transport raises them ---------------------------------------------------

const KERNEL_CODE = { OUT_OF_STOCK: 'OUT_OF_STOCK', QUOTE_EXPIRED: 'QUOTE_EXPIRED', PRICE_CHANGED: 'PRICE_CHANGED', QUOTE_MISMATCH: 'PRICE_CHANGED', PARTNER_ASSERTION_REJECTED: 'PARTNER_ASSERTION_REJECTED' };
/** A response that arrived: `status`, and the error code its body named (null: it named none). */
const answered = (status, upstreamCode = null) => new PivotaCommerceError(KERNEL_CODE[upstreamCode] ?? 'MERCHANT_UNAVAILABLE', {
  operation: 'create_order', upstream_status: status, upstream_code: upstreamCode, message: undefined, upstream_detail: undefined,
});
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
const each = (fn) => async () => { for (const store of STORES) for (const caller of CALLERS) await fn(store, caller, `${store} / ${caller}`); };

// ---- the rule itself -----------------------------------------------------------------------------------------

test('what counts as an answered refusal: a named code on a 4xx (not 408) or a 503, from the transport, and nothing else', () => {
  const yes = [
    [503, 'TEMPORARY_UNAVAILABLE'], [409, 'OUT_OF_STOCK'], [409, 'QUOTE_EXPIRED'], [409, 'QUOTE_MISMATCH'], [409, 'PARTNER_ASSERTION_REJECTED'],
    [400, 'INVALID_BUYER_CONTEXT'], [403, 'MERCHANT_NOT_ACCEPTING_ORDERS'], [404, 'QUOTE_NOT_FOUND'], [422, 'VARIANT_REQUIRED'], [429, 'RATE_LIMITED'], [499, 'A1'],
  ];
  for (const [status, code] of yes) {
    assert.deepEqual(upstreamAnsweredRefusal(answered(status, code)), { upstream_status: status, upstream_code: code }, `${status} ${code}`);
  }
  const no = [
    ['a 502 with a code', answered(502, 'TEMPORARY_UNAVAILABLE')],
    ['a 504 with a code', answered(504, 'TEMPORARY_UNAVAILABLE')],
    ['a 500 with a code', answered(500, 'TEMPORARY_UNAVAILABLE')],
    ['a 501 with a code', answered(501, 'NOT_IMPLEMENTED')],
    ['a 505 with a code', answered(505, 'TEMPORARY_UNAVAILABLE')],
    ['a 599 with a code', answered(599, 'TEMPORARY_UNAVAILABLE')],
    ['a 408 with a code', answered(408, 'REQUEST_TIMEOUT')],
    ['a 399 with a code', answered(399, 'TEMPORARY_UNAVAILABLE')],
    ['a 200 with a code', answered(200, 'TEMPORARY_UNAVAILABLE')],
    ['a 503 that names no code (the platform in front)', answered(503, null)],
    ['a 409 that names no code', answered(409, null)],
    ['a 503 whose code is prose', answered(503, 'Service Unavailable')],
    ['a 503 whose code is lower case', answered(503, 'temporary_unavailable')],
    ['a 503 whose code is one letter', answered(503, 'A')],
    ['a 503 whose code is an empty string', answered(503, '')],
    ['a 503 whose code is not a string', answered(503, 503)],
    ['a 503 whose code is longer than a code', answered(503, `A${'B'.repeat(80)}`)],
    ['a deadline', noAnswer({ timeout: true })],
    ['a lost connection', noAnswer()],
    ['a deadline that also carries a status and a code', new PivotaCommerceError('MERCHANT_UNAVAILABLE', { upstream_status: 503, upstream_code: 'TEMPORARY_UNAVAILABLE', upstream_timeout: true })],
    ['a status as a string', new PivotaCommerceError('MERCHANT_UNAVAILABLE', { upstream_status: '503', upstream_code: 'TEMPORARY_UNAVAILABLE' })],
    ['a 409 as a string', new PivotaCommerceError('OUT_OF_STOCK', { upstream_status: '409', upstream_code: 'OUT_OF_STOCK' })],
    ['a status that is not whole', new PivotaCommerceError('MERCHANT_UNAVAILABLE', { upstream_status: 503.5, upstream_code: 'TEMPORARY_UNAVAILABLE' })],
    ['a refusal this process raised itself', new PivotaCommerceError('OUT_OF_STOCK')],
    ['a refusal with a reason and no status', new PivotaCommerceError('MERCHANT_UNAVAILABLE', { reason: 'backend_http_error', status: 503 })],
    ['a refusal whose detail is an array', Object.assign(new PivotaCommerceError('OUT_OF_STOCK'), { detail: [503, 'OUT_OF_STOCK'] })],
    ['a refusal with no detail', Object.assign(new PivotaCommerceError('OUT_OF_STOCK'), { detail: null })],
    ['a plain error', new Error('socket hang up')],
    ['a plain error dressed as a refusal', Object.assign(new Error('x'), { code: 'OUT_OF_STOCK', detail: { upstream_status: 409, upstream_code: 'OUT_OF_STOCK' } })],
    ['a string', 'OUT_OF_STOCK'],
    ['nothing', undefined],
    ['null', null],
  ];
  for (const [label, err] of no) assert.equal(upstreamAnsweredRefusal(err), null, label);
});

// ---- an answered refusal gives the claim back ------------------------------------------------------------------

test('an answered 503: the failing attempt is answered as raised, the claim is gone, and the same key then creates the order exactly once', each(async (store, caller, label) => {
  for (const market of MARKETS) {
    const w = world({ store });
    const h = await w.open(caller, market);
    assert.equal(h.currency, PRICED_IN[market ?? 'none'], `${label} ${market}: the session is priced in the request market's currency`);
    w.script.push(refuse(503, 'TEMPORARY_UNAVAILABLE'));
    const first = await w.attempt(h, 'idem-claim-0001');
    assert.equal(first.ok, false, label);
    assert.equal(first.code, 'MERCHANT_UNAVAILABLE', label);
    if (caller !== 'acp_complete') {
      assert.deepEqual(first.wire, { code: 'MERCHANT_UNAVAILABLE', retriable: true, message: 'The merchant is temporarily unreachable. Please try again shortly.', detail: { operation: 'create_order', upstream_status: 503, upstream_code: 'TEMPORARY_UNAVAILABLE', message: undefined, upstream_detail: undefined } }, label);
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

test('every named refusal gives the claim back, and a DIFFERENT key is then a first attempt too', each(async (store, caller, label) => {
  for (const [status, code, kernelCode] of [
    [409, 'OUT_OF_STOCK', 'OUT_OF_STOCK'], [409, 'QUOTE_EXPIRED', 'QUOTE_EXPIRED'], [409, 'QUOTE_MISMATCH', 'PRICE_CHANGED'],
    [409, 'PARTNER_ASSERTION_REJECTED', 'PARTNER_ASSERTION_REJECTED'], [400, 'INVALID_BUYER_CONTEXT', 'MERCHANT_UNAVAILABLE'],
    [429, 'RATE_LIMITED', 'MERCHANT_UNAVAILABLE'], [503, 'TEMPORARY_UNAVAILABLE', 'MERCHANT_UNAVAILABLE'],
  ]) {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    w.script.push(refuse(status, code));
    const first = await w.attempt(h, 'idem-named-0001');
    assert.equal(first.code, kernelCode, `${label} ${code}`);
    assert.equal(await w.claims.get(h.quoteId), undefined, `${label} ${code}: released`);
    assert.deepEqual(w.log.filter((l) => l.event.startsWith('quote_claim')), [
      { level: 'info', event: 'quote_claim_released', fields: { quote_id: h.quoteId, code: kernelCode, released: true, upstream_status: status, upstream_code: code } },
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

test('after an answered OUT_OF_STOCK the retry is judged afresh: expiry, the upstream\'s own view of the price, and the locked total', each(async (store, caller, label) => {
  // (a) the quote expired meanwhile: refused before anything is sent.
  {
    const w = world({ store });
    const h = await w.open(caller, 'SG');
    w.script.push(refuse(409, 'OUT_OF_STOCK'));
    assert.equal((await w.attempt(h, 'idem-fresh-0001')).code, 'OUT_OF_STOCK', label);
    w.advance(10 * 60 * 1000 + 1);
    const retry = await w.attempt(h, 'idem-fresh-0001');
    assert.equal(retry.code, 'QUOTE_EXPIRED', `${label}: ${JSON.stringify(retry.wire)}`);
    assert.equal(w.createsSent().length, 1, `${label}: an expired quote sends no create_order`);
    assert.equal(w.upstreamOrders.length, 0, label);
  }
  // (b) the upstream now says the price changed: relayed, claim given back again, no order.
  {
    const w = world({ store });
    const h = await w.open(caller, 'GB');
    w.script.push(refuse(409, 'OUT_OF_STOCK'), refuse(409, 'QUOTE_MISMATCH'));
    assert.equal((await w.attempt(h, 'idem-fresh-0002')).code, 'OUT_OF_STOCK', label);
    const retry = await w.attempt(h, 'idem-fresh-0002');
    assert.equal(retry.code, 'PRICE_CHANGED', label);
    assert.equal(w.upstreamOrders.length, 0, label);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), false, label);
  }
  // (c) the upstream makes the order at ANOTHER amount, or in another currency: never answered as an order.
  for (const overrides of [{ backend_amount_minor: TOTAL + 100 }, { backend_currency: 'USD' }, { backend_amount_present: false }]) {
    const w = world({ store });
    const h = await w.open(caller, 'GB');
    w.script.push(refuse(409, 'OUT_OF_STOCK'), (payload, makeOrder) => makeOrder(payload, overrides));
    assert.equal((await w.attempt(h, 'idem-fresh-0003')).code, 'OUT_OF_STOCK', label);
    const retry = await w.attempt(h, 'idem-fresh-0003');
    assert.equal(retry.code, 'PRICE_CHANGED', `${label} ${JSON.stringify(overrides)}: ${JSON.stringify(retry.wire)}`);
    // An order exists upstream now, so this claim stays.
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, label);
    const after = await w.attempt(h, 'idem-fresh-0003');
    assert.equal(after.ok, false, label);
    assert.equal(w.createsSent().length, 2, `${label}: nothing more is sent`);
    assert.equal(w.upstreamOrders.length, 1, label);
  }
  // (d) the item is back: the order is made at the locked total, in the quote's currency, and what is sent to
  //     the upstream is the same locked quote as the first time.
  {
    const w = world({ store });
    const h = await w.open(caller, 'DE');
    w.script.push(refuse(409, 'OUT_OF_STOCK'));
    assert.equal((await w.attempt(h, 'idem-fresh-0004')).code, 'OUT_OF_STOCK', label);
    const retry = await w.attempt(h, 'idem-fresh-0004');
    assert.equal(retry.ok, true, label);
    assert.equal(retry.currency, 'EUR', label);
    const [a, b] = w.createsSent();
    assert.deepEqual(b.payload, a.payload, `${label}: the retry sends the same locked quote`);
    assert.equal(b.payload.order._locked_totals.total, TOTAL, label);
  }
}));

// ---- everything else keeps it ----------------------------------------------------------------------------------

const UNKNOWN_OUTCOMES = [
  ['a deadline', () => { throw noAnswer({ timeout: true }); }, 'MERCHANT_UNAVAILABLE'],
  ['a lost connection', () => { throw noAnswer(); }, 'MERCHANT_UNAVAILABLE'],
  ['a 502 with a code', refuse(502, 'TEMPORARY_UNAVAILABLE'), 'MERCHANT_UNAVAILABLE'],
  ['a 504 with a code', refuse(504, 'TEMPORARY_UNAVAILABLE'), 'MERCHANT_UNAVAILABLE'],
  ['a 500 with a code', refuse(500, 'TEMPORARY_UNAVAILABLE'), 'MERCHANT_UNAVAILABLE'],
  ['a 503 with no code', refuse(503, null), 'MERCHANT_UNAVAILABLE'],
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
      const exec = createCanonicalExecutor({ kernel: w.kernel, hostedLinkEnabled: true, upstream: async () => { throw answered(503, 'TEMPORARY_UNAVAILABLE'); } });
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
      w.kernel._upstream = async (op, ...rest) => { if (op === 'submit_payment') throw answered(503, 'TEMPORARY_UNAVAILABLE'); return realUpstream(op, ...rest); };
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
  const g = gate(refuse(503, 'TEMPORARY_UNAVAILABLE'));
  w.script.push(g.step);
  const running = w.attempt(h, 'idem-own-0001');
  await g.reached;
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
      const g = gate(refuse(409, 'OUT_OF_STOCK'));
      w.script.push(g.step);
      const running = w.attempt(h, 'idem-old-0001');
      await g.reached;
      await w.claims.set(h.quoteId, foreign);
      g.release();
      assert.equal((await running).code, 'OUT_OF_STOCK', store);
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
    w.script.push(refuse(503, 'TEMPORARY_UNAVAILABLE'));
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
    w.script.push(refuse(503, 'TEMPORARY_UNAVAILABLE'));
    assert.equal((await w.attempt(h, 'idem-fail-0002')).code, 'MERCHANT_UNAVAILABLE', label);
    assert.equal(deletes, 0, label);
    assert.equal(await w.kernel.isQuoteClaimed(h.quoteId), true, label);
  }
  // The logger throws on every line: the release still happens and the answer is the upstream's.
  {
    const w = world({ store });
    const h = await w.open(caller, 'US');
    w.kernel._log = { info() { throw new Error('logger down'); }, warn() { throw new Error('logger down'); } };
    w.script.push(refuse(503, 'TEMPORARY_UNAVAILABLE'), () => { throw noAnswer({ timeout: true }); });
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
  w.script.push(refuse(503, 'TEMPORARY_UNAVAILABLE'));
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
  const g = gate(refuse(503, 'TEMPORARY_UNAVAILABLE'));
  w.script.push(g.step);
  const a = w.attempt(h, 'idem-race-0001');
  await g.reached;
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
  await g2.reached;
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
    const g = gate(refuse(409, 'OUT_OF_STOCK'));
    w.script.push(g.step);
    const a = w.attempt(h, 'idem-diff-000A');
    await g.reached;
    const b = await w.attempt(h, 'idem-diff-000B');
    assert.equal(b.code, 'QUOTE_ALREADY_USED', label);
    assert.equal(w.createsSent().length, 1, label);
    g.release();
    assert.equal((await a).code, 'OUT_OF_STOCK', label);
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
    await g.reached;
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
    await g.reached;
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
    w.script.push(refuse(503, 'TEMPORARY_UNAVAILABLE'));
    assert.equal((await w.attempt(h, 'idem-diff-000G')).code, 'MERCHANT_UNAVAILABLE', label);
    const g = gate((payload, makeOrder) => makeOrder(payload));
    w.script.push(g.step);
    const b = w.attempt(h, 'idem-diff-000H');
    const c = w.attempt(h, 'idem-diff-000I');
    await g.reached;
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
  const gA = gate(refuse(503, 'TEMPORARY_UNAVAILABLE'));
  w.script.push(gA.step);
  const a = w.attempt(h, 'idem-mid-000A');
  await gA.reached;
  const realPut = w.claims.putIfAbsent.bind(w.claims);
  let hold;
  let held;
  const bAtClaim = new Promise((r) => { held = r; });
  w.claims.putIfAbsent = async (...args) => { held(); await new Promise((r) => { hold = r; }); w.claims.putIfAbsent = realPut; return realPut(...args); };
  // The complete lane's advisory read would refuse B first; let it through so B reaches the real claim.
  const realIsClaimed = w.kernel.isQuoteClaimed.bind(w.kernel);
  w.kernel.isQuoteClaimed = async () => false;
  const b = w.attempt(h, 'idem-mid-000B');
  await bAtClaim;
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
      if (ending === 'refused') throw answered(503, 'TEMPORARY_UNAVAILABLE');
      const made = makeOrder(payload);
      if (ending === 'unknown') throw noAnswer({ timeout: true });
      return made;
    });
    w.script.push(g.step);
    const a = w.attempt(h, 'idem-lease-0001');
    await g.reached;
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
  for (const market of MARKETS) {
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

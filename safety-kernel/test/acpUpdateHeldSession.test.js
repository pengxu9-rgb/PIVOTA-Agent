// AN ACP UPDATE NEVER REOPENS A SESSION WHOSE QUOTE'S CLAIM IS HELD.
//
// The ACP REST door keeps one session id across re-quotes: an update points the id at a fresh quote. Its record says
// a session is over only once a completion has ANSWERED (it writes the order id then). A completion that took the
// claim and then failed (its payment step, or the order call itself, had an unknown outcome) left the record open,
// and an update re-priced it: a second completion then made a second order and opened a second payment page.
//
// Now an update is refused when the claim of the quote the session holds is held (an order, an order call whose
// outcome is unknown, a cancellation), by the names the door already gives a session that is over; it is asked again
// after the update writes (a completion may have taken the claim while the update was pricing), and a completion that
// fails with the claim held points the record back at its quote. Driven over both stores, through the real adapter,
// executor and kernel, with a scripted upstream, and raced: no interleaving of an update and a completion, followed by
// a completion under another key, ever makes a second order. Every name is a placeholder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { PostgresKvStore } from '../src/stores/postgresKvStore.js';
import { PivotaCommerceError } from '../src/errors.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';
import { marketCurrencyOf } from './helpers/marketCurrency.js';

const SECRET = 'acp-held-signing-secret-0123456789';
const KSECRET = 'acp-held-kernel-secret-0123456789';
const T0 = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const PRICED_IN = Object.freeze({ US: 'USD', SG: 'SGD', GB: 'GBP' });
const address = (country) => ({ name: 'Buyer One', address_line1: '1 Example Road', city: 'Exampleton', postal_code: '00001', country });
// The transport's no-answer and 5xx shapes (src/server.js throwCommerceKernelUpstreamError).
const noAnswer = () => new PivotaCommerceError('MERCHANT_UNAVAILABLE', { operation: 'x', upstream_status: null, upstream_code: null, upstream_timeout: true });
const busy = () => new PivotaCommerceError('MERCHANT_UNAVAILABLE', { operation: 'x', upstream_status: 503, upstream_code: 'TEMPORARY_UNAVAILABLE' });

/** `delay()`: an optional hook awaited at every upstream step and every session-store call, for the races. */
function door({ storeKind = 'memory', delay = null } = {}) {
  const calls = [];
  const orders = [];
  const script = { create_order: [], submit_payment: [] };
  const pause = async () => { if (delay) await delay(); };
  const kernelUpstream = async (op, payload) => {
    calls.push(op);
    await pause();
    if (op === 'preview_quote') {
      const country = payload.quote?.shipping_address?.country;
      const total = (payload.quote.items ?? []).reduce((n, i) => n + 1800 * i.quantity, 0);
      return { quote_id: `uq_${calls.length}`, merchant_of_record: 'merch_A', currency: PRICED_IN[country] || 'USD', locked_totals: { subtotal: total, tax: 0, shipping: 0, total }, line_items: [], acp_state: {} };
    }
    if (op === 'create_order') {
      const step = script.create_order.shift();
      if (step) return step(payload, () => { orders.push(payload.order.quote_id); });
      orders.push(payload.order.quote_id);
      return { order_id: `o_${orders.length}`, acp_state: {} };
    }
    if (op === 'submit_payment') {
      const step = script.submit_payment.shift();
      if (step) return step(payload);
      return { payment_id: `pay_${payload.payment.order_id}`, payment_status: 'requires_action', redirect_url: `https://pay.example.test/${payload.payment.order_id}` };
    }
    return {};
  };
  let t = T0;
  const now = () => t;
  const db = storeKind === 'postgres' ? makeFakePgDb(now) : null;
  const stores = new Map();
  const storeFactory = (ns) => {
    if (!stores.has(ns)) stores.set(ns, db ? new PostgresKvStore({ db, namespace: ns, now }) : new InMemoryKvStore({ now }));
    return stores.get(ns);
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KSECRET, log: quiet, storeFactory, now });
  const executor = createCanonicalExecutor({
    kernel, upstream: async () => ({}),
    verifyPaymentAuthorization: async (_a, b) => { await pause(); return { ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }; },
  });
  const inner = storeFactory('acp_sessions');
  const sessionStore = {
    get: async (k) => { await pause(); return inner.get(k); },
    set: async (...a) => { await pause(); return inner.set(...a); },
    putIfAbsent: async (...a) => inner.putIfAbsent(...a),
    compareAndSet: async (...a) => { await pause(); return inner.compareAndSet(...a); },
    compareAndDelete: async (...a) => inner.compareAndDelete(...a),
    delete: async (...a) => inner.delete(...a),
  };
  const adapter = createAcpRestAdapter({ executor, sessionStore, signingSecret: SECRET, resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }), marketCurrencyOf, now });
  let keys = 0;
  const req = ({ body, id, key }) => {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(T0);
    keys += 1;
    return { headers: { timestamp, signature: createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex'), 'idempotency-key': key || `idem-held-${String(keys).padStart(5, '0')}` }, rawBody, body, params: id ? { checkout_session_id: id } : {} };
  };
  const cart = (country, quantity = 1) => ({ merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity }], fulfillment_address: address(country) });
  return {
    kernel, calls, orders, script, inner,
    ops: (op) => calls.filter((c) => c === op).length,
    create: (country) => adapter.createCheckoutSession(req({ body: cart(country) })),
    update: (id, country, quantity = 2) => adapter.updateCheckoutSession(req({ id, body: cart(country, quantity) })),
    complete: (id, key) => adapter.completeCheckoutSession(req({ id, key, body: { payment_data: { token: 'tok_1' } } })),
    cancel: (id) => adapter.cancelCheckoutSession(req({ id, body: {} })),
    read: (id) => adapter.getCheckoutSession(req({ id })),
    record: (id) => inner.get(id),
  };
}

const STORES = ['memory', 'postgres'];
const MARKETS = ['US', 'SG', 'GB'];

test('an update of a session whose completion made the order and then had an unknown payment step is refused: the session reads completed, nothing is priced, and another completion makes no second order', async () => {
  for (const storeKind of STORES) {
    for (const market of MARKETS) {
      const label = `${storeKind} ${market}`;
      const d = door({ storeKind });
      const id = (await d.create(market)).body.id;
      const held = (await d.record(id)).quote_id;
      d.script.submit_payment.push(() => { throw busy(); });
      const done = await d.complete(id, 'idem-held-pay-0001');
      assert.deepEqual([done.status, done.body.code], [409, 'CHECKOUT_OUTCOME_UNKNOWN'], label);
      const priced = d.ops('preview_quote');
      const updated = await d.update(id, market, 3);
      assert.deepEqual(updated, { status: 409, body: { type: 'error', code: 'QUOTE_ALREADY_USED', message: updated.body.message } }, label);
      assert.equal(d.ops('preview_quote'), priced, `${label}: nothing priced`);
      assert.equal((await d.record(id)).quote_id, held, label);
      const got = await d.read(id);
      assert.deepEqual([got.body.status, got.body.order], ['checkout.completed', { id: 'o_1', status: 'charge_pending' }], label);
      assert.equal(got.body.currency, PRICED_IN[market], label);
      const again = await d.complete(id, 'idem-held-pay-0002');
      assert.equal(again.body.code, 'QUOTE_ALREADY_USED', label);
      assert.deepEqual([d.orders.length, d.ops('create_order'), d.ops('submit_payment')], [1, 1, 1], `${label}: one order, one payment call`);
    }
  }
});

test('an update of a session whose order call had an unknown outcome is refused (the session reads in progress); after a cancellation whose record write failed, it is refused as canceled', async () => {
  for (const storeKind of STORES) {
    const d = door({ storeKind });
    const id = (await d.create('US')).body.id;
    d.script.create_order.push(() => { throw noAnswer(); });
    assert.equal((await d.complete(id, 'idem-held-pay-0003')).body.code, 'CHECKOUT_OUTCOME_UNKNOWN');
    const updated = await d.update(id, 'US');
    assert.deepEqual([updated.status, updated.body.code], [409, 'QUOTE_ALREADY_USED'], storeKind);
    assert.deepEqual([(await d.read(id)).body.status, (await d.read(id)).body.order_outcome], ['checkout.in_progress', 'unknown']);
    assert.equal((await d.complete(id, 'idem-held-pay-0004')).body.code, 'QUOTE_ALREADY_USED');
    assert.equal(d.ops('create_order'), 1, storeKind);

    // A cancellation took the claim, and its record write did not land: the record reads open, the claim says canceled.
    const c = door({ storeKind });
    const cid = (await c.create('SG')).body.id;
    await c.kernel._quoteClaims.putIfAbsent((await c.record(cid)).quote_id, { canceled: true });
    const refused = await c.update(cid, 'SG');
    assert.deepEqual([refused.status, refused.body.code], [409, 'ORDER_CANCELED'], storeKind);
    assert.equal(c.ops('preview_quote'), 1, `${storeKind}: only the create was priced`);
  }
});

test('an open session is re-priced as before; an update after a completed (recorded) order is refused by its record as before', async () => {
  for (const storeKind of STORES) {
    for (const market of MARKETS) {
      const d = door({ storeKind });
      const id = (await d.create(market)).body.id;
      const updated = await d.update(id, market, 2);
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.deepEqual([updated.body.status, updated.body.currency, updated.body.totals.total], ['checkout.created', PRICED_IN[market], 3600]);
      assert.equal((await d.complete(id)).status, 200);
      assert.equal((await d.update(id, market)).body.code, 'QUOTE_ALREADY_USED');
      assert.equal(d.orders.length, 1);
    }
  }
});

test('the update\'s second look: a completion that takes the claim while the update is pricing is seen after the write, the record is pointed back at the held quote, and the update is refused', async () => {
  for (const storeKind of STORES) {
    for (const outcome of ['paid', 'payment_unknown', 'order_unknown']) {
      const label = `${storeKind} ${outcome}`;
      let hold = null;
      const d = door({ storeKind, delay: () => hold && hold() });
      const id = (await d.create('GB')).body.id;
      const first = (await d.record(id)).quote_id;
      if (outcome === 'payment_unknown') d.script.submit_payment.push(() => { throw busy(); });
      if (outcome === 'order_unknown') d.script.create_order.push(() => { throw noAnswer(); });
      // The update prices while the completion runs to its end: the update's pricing waits on the completion.
      let completing;
      let releaseUpdate;
      const updatePriced = new Promise((r) => { releaseUpdate = r; });
      hold = async () => {
        if (d.calls.at(-1) === 'preview_quote' && !completing) {
          hold = null;
          completing = d.complete(id, 'idem-held-race-0001');
          await completing;
          releaseUpdate();
        }
      };
      const updated = await d.update(id, 'GB', 3);
      await updatePriced;
      const done = await completing;
      assert.equal(updated.status, 409, `${label}: ${JSON.stringify(updated.body)}`);
      assert.equal(updated.body.code, 'QUOTE_ALREADY_USED', label);
      assert.equal((await d.record(id)).quote_id, first, `${label}: the record points at the claimed quote`);
      if (outcome === 'paid') assert.equal(done.status, 200, label);
      const again = await d.complete(id, 'idem-held-race-0002');
      assert.notEqual(again.status, 200, `${label}: ${JSON.stringify(again.body)}`);
      assert.ok(d.orders.length <= 1, label);
      assert.equal(d.ops('create_order'), 1, `${label}: one order call`);
    }
  }
});

test('RACE: an update and a completion of one session started together, in every order of their steps, then a completion under another key: never a second order, never a second payment page', async () => {
  let seed = 0x5eed;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const OUTCOMES = ['paid', 'payment_unknown', 'order_unknown', 'order_unknown_landed'];
  let pairs = 0;
  for (const storeKind of STORES) {
    for (let i = 0; i < 100; i += 1) {
      const outcome = OUTCOMES[i % OUTCOMES.length];
      const market = MARKETS[i % MARKETS.length];
      const label = `${storeKind} #${i} ${outcome} ${market}`;
      // Each step yields a random number of turns, so the two requests interleave differently every time.
      const d = door({ storeKind, delay: async () => { for (let n = Math.floor(rand() * 6); n > 0; n -= 1) await new Promise((r) => setImmediate(r)); } });
      const id = (await d.create(market)).body.id;
      if (outcome === 'payment_unknown') d.script.submit_payment.push(() => { throw busy(); });
      if (outcome === 'order_unknown') d.script.create_order.push(() => { throw noAnswer(); });
      if (outcome === 'order_unknown_landed') d.script.create_order.push((_p, land) => { land(); throw noAnswer(); });
      const [u, c] = await Promise.all([d.update(id, market, 2 + (i % 3)), d.complete(id, `idem-race-a-${i}`)]);
      assert.ok([200, 409].includes(u.status), `${label}: update ${JSON.stringify(u.body)}`);
      const second = await d.complete(id, `idem-race-b-${i}`);
      // At most one order, whatever happened; and never an order on each of two quotes.
      assert.ok(d.orders.length <= 1, `${label}: ${d.orders.length} orders (update ${u.status}, complete ${c.status} ${c.body.code}, second ${second.status} ${second.body.code})`);
      assert.ok(d.ops('submit_payment') <= 1, `${label}: ${d.ops('submit_payment')} payment calls`);
      // Once an order call was made the session never reads open again.
      if (d.ops('create_order') > 0) {
        const got = await d.read(id);
        assert.notEqual(got.body.status, 'checkout.created', `${label}: ${JSON.stringify(got.body)}`);
        const later = await d.update(id, market);
        assert.equal(later.status, 409, `${label}: ${JSON.stringify(later.body)}`);
      }
      pairs += 1;
    }
  }
  assert.equal(pairs, 200);
});

test('the claim-only read is the ACP door\'s alone: on any other door the same member is ignored, and the read is the session as before (ownership and expiry included)', async () => {
  const d = door();
  const id = (await d.create('US')).body.id;
  const quoteId = (await d.record(id)).quote_id;
  const kernel = d.kernel;
  const executor = createCanonicalExecutor({ kernel, upstream: async () => ({}) });
  const acpCtx = { user_ref: 'buyer_1', acp_session_id: id, protocol: 'acp' };
  assert.deepEqual(await executor.execute('get_checkout_session', { session_id: quoteId, session_claim_only: true }, acpCtx), { session_id: quoteId, status: 'ready_for_payment', order_id: null });
  for (const ctx of [{ ...acpCtx, protocol: undefined }, { ...acpCtx, protocol: 'mcp' }, { ...acpCtx, protocol: 'ucp' }]) {
    const read = await executor.execute('get_checkout_session', { session_id: quoteId, session_claim_only: true }, ctx);
    assert.deepEqual([read.session_id, read.status, read.currency, typeof read.totals], [quoteId, 'ready_for_payment', 'USD', 'object'], String(ctx.protocol));
    // Another buyer is refused as before; the claim-only member opens nothing.
    const other = await executor.execute('get_checkout_session', { session_id: quoteId, session_claim_only: true }, { ...ctx, user_ref: 'buyer_2' }).then(() => null, (e) => e);
    assert.equal(other?.code, 'STATE_LINKAGE_MISMATCH', String(ctx.protocol));
  }
});

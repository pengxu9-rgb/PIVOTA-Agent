// The ACP REST door holds a priced answer for a known buyer market to that market's currency (acpRestAdapter.js,
// "the buyer's market"; canonicalExecutor.js, quoteMarketOf). At the adapter, the executor and the kernel, with a
// recording pricer that answers in the seller's own currency whatever market it is sent, and the VERIFIED payment
// lane (the door suite, tests/acp_market_currency_door.node.test.cjs, completes on the delegated-token lane).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { surfaceableIntakeRefusal } from '../src/protocol/buyerIntake.js';
import { marketCurrencyOf } from './helpers/marketCurrency.js';

const SECRET = 'acp-signing-secret-0123456789abcdef';
const KSECRET = 'acp-kernel-secret-0123456789abcdef';
const FIXED_NOW = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const MISMATCH = 'seller_not_priced_in_market_currency';

/** `source`: the door's market -> currency source (`null` = none wired). `sellerCurrency`: what the pricer answers in. */
function setup({ sellerCurrency = 'USD', source = marketCurrencyOf, store = new InMemoryKvStore({ now: () => FIXED_NOW }) } = {}) {
  const calls = [];
  const verified = [];
  const kernelUpstream = async (op, payload) => {
    calls.push({ op, payload: structuredClone(payload) });
    if (op === 'preview_quote') {
      return {
        quote_id: `uq_${calls.length}`, merchant_of_record: 'merch_A', currency: sellerCurrency,
        locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 },
        line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {},
      };
    }
    if (op === 'create_order') return { order_id: `o_${calls.length}`, acp_state: {} };
    if (op === 'submit_payment') return { order_id: payload.order_id, payment_id: 'pay1', payment_status: 'succeeded' };
    return {};
  };
  const verifyPaymentAuthorization = async (_authorization, bound) => { verified.push(bound); return { ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref }; };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KSECRET, log: quiet, now: () => FIXED_NOW });
  const executor = createCanonicalExecutor({ kernel, upstream: async () => ({}), verifyPaymentAuthorization });
  const adapter = createAcpRestAdapter({
    executor, sessionStore: store, signingSecret: SECRET, resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }),
    ...(source ? { marketCurrencyOf: source } : {}), now: () => FIXED_NOW,
  });
  const ops = (op) => calls.filter((c) => c.op === op);
  return { adapter, executor, kernel, store, calls, ops, verified };
}

let keys = 0;
function req({ body, id } = {}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(FIXED_NOW);
  keys += 1;
  return {
    headers: { timestamp, signature: createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex'), 'idempotency-key': `idem-acp-market-${String(keys).padStart(4, '0')}` },
    rawBody, body, params: id ? { checkout_session_id: id } : {},
  };
}
const addressIn = (country) => (country === undefined ? {} : { fulfillment_address: { name: 'Example Buyer', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000', country } });
const cart = (country, quantity = 1) => ({ merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity }], ...addressIn(country) });
const completion = (country) => ({ payment_data: { token: 'tok_1' }, ...addressIn(country) });
const refusedBy = (answer, reason, market) => {
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.equal(answer.body.code, 'NO_MERCHANT_OFFER');
  assert.equal(answer.body.detail.reason, reason);
  assert.equal(answer.body.detail.market, market);
};

// ---- the adapter ------------------------------------------------------------------------------------------------

test('create: the address\'s country is the market; the quote carries it and must be in its currency', async () => {
  const usd = setup({ sellerCurrency: 'USD' });
  const priced = await usd.adapter.createCheckoutSession(req({ body: cart('US') }));
  assert.equal(priced.status, 201);
  assert.equal(priced.body.currency, 'USD');
  assert.equal(usd.ops('preview_quote')[0].payload.market, 'US');
  assert.equal('market_currency' in usd.ops('preview_quote')[0].payload, false, 'the currency is this door\'s check, never a request to the pricer');

  const refused = await usd.adapter.createCheckoutSession(req({ body: cart('SG') }));
  refusedBy(refused, MISMATCH, 'SG');
  assert.deepEqual(refused.body.detail, { reason: MISMATCH, market: 'SG', market_currency: 'SGD', seller_currencies: ['USD'] });
  assert.match(refused.body.message, /no checkout session was created/);
  assert.equal(usd.ops('preview_quote').length, 2);

  const unpriced = await usd.adapter.createCheckoutSession(req({ body: cart('DE') }));
  refusedBy(unpriced, 'market_not_priced', 'DE');
  assert.deepEqual(unpriced.body.detail, { reason: 'market_not_priced', market: 'DE' });
  assert.equal(usd.ops('preview_quote').length, 2, 'nothing was priced for it');
});

test('create with no address: no market is sent, none is assumed, and the answer is in the seller\'s own currency', async () => {
  for (const sellerCurrency of ['USD', 'SGD']) {
    const door = setup({ sellerCurrency });
    const answer = await door.adapter.createCheckoutSession(req({ body: cart(undefined) }));
    assert.equal(answer.status, 201);
    assert.equal(answer.body.currency, sellerCurrency);
    assert.deepEqual(Object.keys(door.ops('preview_quote')[0].payload), ['quote'], 'the pricing call is the one it always was');
  }
});

test('a refused update marks the session with the market it named; the mark is what the session is read and completed against', async () => {
  const door = setup({ sellerCurrency: 'USD' });
  const created = await door.adapter.createCheckoutSession(req({ body: cart('US') }));
  const id = created.body.id;
  const before = await door.store.get(id);
  assert.equal('refused_market' in before, false);

  const refused = await door.adapter.updateCheckoutSession(req({ id, body: cart('SG', 2) }));
  refusedBy(refused, MISMATCH, 'SG');
  assert.match(refused.body.message, /the checkout session was not re-priced/);
  assert.deepEqual(await door.store.get(id), { ...before, refused_market: 'SG' }, 'the quote it holds is the one it had');

  const read = await door.adapter.getCheckoutSession(req({ id }));
  refusedBy(read, MISMATCH, 'SG');
  assert.match(read.body.message, /neither read out nor paid/);
  assert.deepEqual(read.body.detail, { reason: MISMATCH, market: 'SG', market_currency: 'SGD', seller_currencies: ['USD'] });

  for (const country of [undefined, 'US', 'SG']) {
    refusedBy(await door.adapter.completeCheckoutSession(req({ id, body: completion(country) })), MISMATCH, 'SG');
  }
  assert.deepEqual([door.verified, door.ops('create_order'), door.ops('submit_payment')], [[], [], []], 'no authorization presented, no order, no charge');

  // An update the seller is priced for removes the mark, and the session is paid in that market's currency.
  const fixed = await door.adapter.updateCheckoutSession(req({ id, body: cart('US', 3) }));
  assert.equal(fixed.status, 200);
  assert.equal('refused_market' in (await door.store.get(id)), false);
  const paid = await door.adapter.completeCheckoutSession(req({ id, body: completion(undefined) }));
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.order.currency, 'USD');
  assert.equal(door.ops('submit_payment').length, 1);
});

test('an update refused because nothing is priced for its market marks the session too, with no quote asked', async () => {
  const door = setup({ sellerCurrency: 'USD' });
  const id = (await door.adapter.createCheckoutSession(req({ body: cart(undefined) }))).body.id;
  refusedBy(await door.adapter.updateCheckoutSession(req({ id, body: cart('ZZ') })), 'market_not_priced', 'ZZ');
  assert.equal(door.ops('preview_quote').length, 1, 'only the create was priced');
  assert.equal((await door.store.get(id)).refused_market, 'ZZ');
  refusedBy(await door.adapter.getCheckoutSession(req({ id })), 'market_not_priced', 'ZZ');
  refusedBy(await door.adapter.completeCheckoutSession(req({ id, body: completion('US') })), 'market_not_priced', 'ZZ');
  const cancelled = await door.adapter.cancelCheckoutSession(req({ id, body: {} }));
  assert.equal(cancelled.status, 200);
});

test('a completion that brings the address is judged against it before the authorization is presented; refused, it marks the session', async () => {
  const door = setup({ sellerCurrency: 'USD' });
  const id = (await door.adapter.createCheckoutSession(req({ body: cart(undefined) }))).body.id;
  refusedBy(await door.adapter.completeCheckoutSession(req({ id, body: completion('GB') })), MISMATCH, 'GB');
  assert.deepEqual([door.verified, door.ops('create_order'), door.ops('submit_payment')], [[], [], []]);
  assert.equal((await door.store.get(id)).refused_market, 'GB');
  refusedBy(await door.adapter.completeCheckoutSession(req({ id, body: completion('US') })), MISMATCH, 'GB');

  const other = setup({ sellerCurrency: 'USD' });
  const otherId = (await other.adapter.createCheckoutSession(req({ body: cart(undefined) }))).body.id;
  const paid = await other.adapter.completeCheckoutSession(req({ id: otherId, body: completion('US') }));
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.deepEqual(other.verified.map((b) => b.currency), ['USD']);
  assert.equal(other.ops('create_order')[0].payload.order.shipping_address.country, 'US');
});

test('an intake refusal on an update is not a market refusal and marks nothing', async () => {
  const door = setup({ sellerCurrency: 'USD' });
  const id = (await door.adapter.createCheckoutSession(req({ body: cart('US') }))).body.id;
  const before = await door.store.get(id);
  for (const body of [
    { ...cart(undefined), fulfillment_address: { name: 'Example Buyer', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000', country: 'Nowhere Land' } },
    { ...cart(undefined), fulfillment_address: { name: 'Example Buyer', country: 'SG' } },
    { merchant_id: 'merch_A', items: [], ...addressIn('SG') },
  ]) {
    const answer = await door.adapter.updateCheckoutSession(req({ id, body }));
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.deepEqual(await door.store.get(id), before);
  }
  assert.equal((await door.adapter.getCheckoutSession(req({ id }))).status, 200);
});

test('a country that is not two letters is refused by name and never reaches the source or the pricer', async () => {
  const asked = [];
  const door = setup({ source: (market) => { asked.push(market); return marketCurrencyOf(market); } });
  for (const country of ['Singapore', 'S1', 'U S', 'USA', '12']) {
    const answer = await door.adapter.createCheckoutSession(req({ body: cart(country) }));
    assert.equal(answer.status, 400);
    assert.deepEqual(answer.body.detail, { reason: 'market_invalid', rejected_field: 'fulfillment_address.country' });
    assert.equal(JSON.stringify(answer.body).includes(country), false);
  }
  assert.deepEqual([asked, door.calls], [[], []]);
  // Letter case and surrounding space are not what makes a code unreadable.
  assert.equal((await door.adapter.createCheckoutSession(req({ body: cart(' us ') }))).status, 201);
  assert.deepEqual(asked, ['US', 'US'], 'asked at intake and again with the quote, upper-cased both times');
});

test('whatever the source answers that is not a currency code, the market is refused as not priced: no default, nothing priced', async () => {
  for (const answer of [null, undefined, '', 'usd', 'US', 'USDX', 840, {}, true]) {
    const door = setup({ source: () => answer });
    refusedBy(await door.adapter.createCheckoutSession(req({ body: cart('US') })), 'market_not_priced', 'US');
    assert.deepEqual(door.calls, []);
  }
});

test('with no source wired, a request that names a market is refused and never priced; one that names none is unchanged', async () => {
  const door = setup({ source: null });
  const none = await door.adapter.createCheckoutSession(req({ body: cart(undefined) }));
  assert.equal(none.status, 201);
  const id = none.body.id;
  for (const answer of [
    await door.adapter.createCheckoutSession(req({ body: cart('US') })),
    await door.adapter.updateCheckoutSession(req({ id, body: cart('US') })),
    await door.adapter.completeCheckoutSession(req({ id, body: completion('US') })),
  ]) {
    assert.equal(answer.status, 503, JSON.stringify(answer.body));
    assert.equal(answer.body.code, 'MERCHANT_UNAVAILABLE');
  }
  assert.equal(door.ops('preview_quote').length, 1, 'only the address-less create was priced');
  assert.deepEqual([door.ops('create_order'), door.ops('submit_payment')], [[], []]);
});

test('the market is asked before the variant read: a market nothing is priced for costs no read', async () => {
  const reads = [];
  const kernel = new SafetyKernel({ upstream: async () => ({}), secret: KSECRET, log: quiet, now: () => FIXED_NOW });
  const executor = createCanonicalExecutor({ kernel, upstream: async (op, payload) => { reads.push({ op, payload }); return {}; } });
  const adapter = createAcpRestAdapter({ executor, sessionStore: new InMemoryKvStore({ now: () => FIXED_NOW }), signingSecret: SECRET, resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }), marketCurrencyOf, now: () => FIXED_NOW });
  const body = { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }], ...addressIn('DE') };
  refusedBy(await adapter.createCheckoutSession(req({ body })), 'market_not_priced', 'DE');
  assert.deepEqual(reads, []);
});

test('a mark that is not a market code fails closed: the session is not read out or paid', async () => {
  const door = setup();
  const id = (await door.adapter.createCheckoutSession(req({ body: cart('US') }))).body.id;
  for (const bad of ['sg', 'SGP', 7, '']) {
    await door.store.set(id, { ...(await door.store.get(id)), refused_market: bad });
    const read = await door.adapter.getCheckoutSession(req({ id }));
    assert.equal(read.status, 400, JSON.stringify(read.body));
    assert.equal(read.body.detail.reason, 'market_invalid');
    const done = await door.adapter.completeCheckoutSession(req({ id, body: completion('US') }));
    assert.equal(done.status, 400);
  }
  assert.deepEqual([door.ops('create_order'), door.ops('submit_payment')], [[], []]);
});

// ---- the executor: a session that exists, held to a market a door names for it -------------------------------------

const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const QUOTE = { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test' };
const refusal = (p) => p.then(() => assert.fail('expected a refusal'), (e) => e);

test('get_checkout_session: with no market it reads as before; with one, only a session in that market\'s currency is read out', async () => {
  const { executor } = setup({ sellerCurrency: 'SGD' });
  const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-exec-get-01', quote: QUOTE }, CTX);
  assert.equal((await executor.execute('get_checkout_session', { session_id: session.session_id }, CTX)).currency, 'SGD');
  assert.equal((await executor.execute('get_checkout_session', { session_id: session.session_id, market: 'SG', market_currency: 'SGD' }, CTX)).currency, 'SGD');
  const mismatch = await refusal(executor.execute('get_checkout_session', { session_id: session.session_id, market: 'US', market_currency: 'USD' }, CTX));
  assert.deepEqual(surfaceableIntakeRefusal(mismatch).detail, { reason: MISMATCH, market: 'US', market_currency: 'USD', seller_currencies: ['SGD'] });
  const unpriced = await refusal(executor.execute('get_checkout_session', { session_id: session.session_id, market: 'DE' }, CTX));
  assert.deepEqual(surfaceableIntakeRefusal(unpriced).detail, { reason: 'market_not_priced', market: 'DE' });
  // Ownership answers first, as it always did: another buyer learns nothing about the session's market.
  const foreign = await refusal(executor.execute('get_checkout_session', { session_id: session.session_id, market: 'DE' }, { ...CTX, user_ref: 'user_2' }));
  assert.equal(surfaceableIntakeRefusal(foreign), null);
});

test('complete_checkout_session: a market the locked quote is not priced for is refused before the verifier, the order and the charge, and the key is released', async () => {
  const { executor, verified, ops } = setup({ sellerCurrency: 'USD' });
  const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-exec-complete-01', quote: QUOTE }, CTX);
  const complete = (market) => executor.execute('complete_checkout_session', {
    idempotency_key: 'idem-exec-complete-02', session_id: session.session_id, payment_authorization: { token: 'tok_1' }, ...market,
  }, CTX);
  for (const market of [{ market: 'SG', market_currency: 'SGD' }, { market: 'DE' }, { market: 'sg', market_currency: 'SGD' }]) {
    const err = await refusal(complete(market));
    assert.ok(surfaceableIntakeRefusal(err), 'a named refusal');
    assert.deepEqual([verified, ops('create_order'), ops('submit_payment')], [[], [], []]);
  }
  // The same key, for the market the quote is priced for: a first completion.
  const paid = await complete({ market: 'US', market_currency: 'USD' });
  assert.equal(paid.order.currency, 'USD');
  assert.deepEqual([verified.length, ops('create_order').length, ops('submit_payment').length], [1, 1, 1]);
});

test('complete_checkout_session with no market is the completion it always was', async () => {
  for (const sellerCurrency of ['USD', 'SGD']) {
    const { executor, ops } = setup({ sellerCurrency });
    const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-exec-complete-03', quote: QUOTE }, CTX);
    const paid = await executor.execute('complete_checkout_session', { idempotency_key: 'idem-exec-complete-04', session_id: session.session_id, payment_authorization: { token: 'tok_1' } }, CTX);
    assert.equal(paid.order.currency, sellerCurrency);
    assert.equal(ops('submit_payment').length, 1);
  }
});

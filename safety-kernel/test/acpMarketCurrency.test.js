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

// ---- a market refusal and the create's claim on the caller's key ------------------------------------------------
//
// Over real HTTP, on both session stores (helpers/acpCreateDoor.js, whose store records every call it receives). A
// create writes a claim on (buyer, Idempotency-Key) before it asks the pricer. A market refusal is a failure whose
// outcome is known, with nothing behind it:
//   - refused before the pricer (a market nothing is priced for, a country that cannot be read): no claim is written;
//   - refused on the quote's currency (after one quote): the claim is released;
// so the same key, with an address the seller is priced for, is a first create. The mark a refused update leaves is
// on the SESSION record; the claim record is another row and is not touched by it.
import { bootAcpCreateDoor, cart as claimCart, PRICER_CURRENCY, UNIT_MINOR } from './helpers/acpCreateDoor.js';

const CLAIM_PORT = 5733;
async function withClaimDoor(storeKind, fn) {
  const door = await bootAcpCreateDoor({ port: CLAIM_PORT, storeKind });
  try { await fn(door); } finally { await door.close(); }
}
// A pricer step that answers in `currency` whatever the cart's destination: the seller's own currency.
const pricedIn = (currency) => (payload) => ({
  quote_id: `uq_seller_${currency}`, merchant_of_record: payload.quote.merchant_id, currency,
  locked_totals: { subtotal: UNIT_MINOR, tax: 0, shipping: 0, total: UNIT_MINOR }, line_items: [], acp_state: {},
});
const isClaimCall = (call) => String(call.key).startsWith('["acpcreate"');

for (const storeKind of ['memory', 'postgres']) {
  test(`[${storeKind}] a create refused on the quote's currency releases its claim: the same key with a corrected address is a first create`, async () => {
    await withClaimDoor(storeKind, async (door) => {
      const key = 'idem-market-claim-01';
      door.pricer.script(pricedIn('USD'));
      const refused = await door.create(claimCart(1, 'SG'), { key });
      assert.equal(refused.status, 404, refused.text);
      assert.deepEqual(refused.body.detail, { reason: MISMATCH, market: 'SG', market_currency: PRICER_CURRENCY.SG, seller_currencies: ['USD'] });
      assert.equal(door.pricer.calls.length, 1, 'refused after one quote');
      assert.deepEqual(door.store.calls.filter(isClaimCall).map((c) => c.name), ['putIfAbsent', 'compareAndDelete'], 'the claim was written, then released');
      assert.deepEqual([await door.store.claims(), await door.store.sessions()], [[], []], 'nothing is behind the refusal');
      assert.equal(door.kernelStores.get('quotes')?._m.size ?? 0, 0, 'no quote was recorded');

      const created = await door.create(claimCart(1, 'US'), { key });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.body.currency, 'USD');
      assert.equal(door.pricer.calls.length, 2, 'one quote for the session');
      const claims = await door.store.claims();
      assert.deepEqual(claims.map((row) => row.value), [{ acp_session_id: created.body.id, status: 'done' }]);
    });
  });

  for (const [name, country, status, reason] of [
    ['a market nothing is priced for', 'ZZ', 404, 'market_not_priced'],
    ['a country that cannot be read', 'Nowhere Land', 400, 'market_invalid'],
  ]) {
    test(`[${storeKind}] a create refused for ${name} writes no claim: the same key is usable at once`, async () => {
      await withClaimDoor(storeKind, async (door) => {
        const key = 'idem-market-claim-02';
        const refused = await door.create(claimCart(1, country), { key });
        assert.equal(refused.status, status, refused.text);
        assert.equal(refused.body.detail.reason, reason);
        assert.deepEqual([door.pricer.calls, door.store.calls], [[], []], 'the pricer was not asked and the store was not touched');
        const created = await door.create(claimCart(1, 'US'), { key });
        assert.equal(created.status, 201, created.text);
        assert.equal(door.pricer.calls.length, 1);
      });
    });
  }

  test(`[${storeKind}] a refused update marks the session row and leaves the claim row alone: the create replay answers the named refusal`, async () => {
    await withClaimDoor(storeKind, async (door) => {
      const key = 'idem-market-claim-03';
      const created = await door.create(claimCart(1, 'US'), { key });
      assert.equal(created.status, 201, created.text);
      const id = created.body.id;
      const claimBefore = await door.store.claims();
      assert.deepEqual(claimBefore.map((row) => row.value), [{ acp_session_id: id, status: 'done' }]);
      const sessionBefore = (await door.store.sessions())[0].value;

      door.pricer.script(pricedIn('USD'));
      const refused = await door.send('POST', `/checkout_sessions/${id}`, claimCart(2, 'SG'), { key: 'idem-market-claim-04' });
      assert.equal(refused.status, 404, refused.text);
      assert.equal(refused.body.detail.reason, MISMATCH);
      assert.deepEqual(await door.store.claims(), claimBefore, 'the claim record is as it was');
      assert.deepEqual((await door.store.sessions()).map((row) => row.value), [{ ...sessionBefore, refused_market: 'SG' }], 'one session row, marked');

      // The replay of the create: the named refusal. Not "outcome unknown", and not the priced body it once had.
      const pricedCalls = door.pricer.calls.length;
      const replay = await door.create(claimCart(1, 'US'), { key });
      assert.equal(replay.status, 404, replay.text);
      assert.equal(replay.body.code, 'NO_MERCHANT_OFFER');
      assert.deepEqual(replay.body.detail, { reason: MISMATCH, market: 'SG', market_currency: PRICER_CURRENCY.SG, seller_currencies: ['USD'] });
      assert.equal(replay.body.totals, undefined);
      assert.equal(door.pricer.calls.length, pricedCalls, 'a replay prices nothing');
      assert.deepEqual(await door.store.claims(), claimBefore);

      // An update the seller is priced for: the mark goes, and the replay is the session again.
      const fixed = await door.send('POST', `/checkout_sessions/${id}`, claimCart(3, 'US'), { key: 'idem-market-claim-05' });
      assert.equal(fixed.status, 200, fixed.text);
      const again = await door.create(claimCart(1, 'US'), { key });
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.id, id);
      assert.equal(again.body.totals.total, UNIT_MINOR * 3);
      assert.deepEqual(await door.store.claims(), claimBefore);
      assert.equal('refused_market' in (await door.store.sessions())[0].value, false);
    });
  });

  test(`[${storeKind}] a create whose pricer does not answer in time, with a market named: the key is held for the lease (unchanged)`, async () => {
    await withClaimDoor(storeKind, async (door) => {
      const key = 'idem-market-claim-06';
      door.pricer.script(() => { throw door.timedOut(); });
      const failed = await door.create(claimCart(1, 'SG'), { key });
      assert.equal(failed.status, 503, failed.text);
      assert.equal((await door.store.claims())[0].value.status, 'pending');
      const held = await door.create(claimCart(1, 'SG'), { key });
      assert.equal(held.status, 409, held.text);
      assert.equal(held.body.code, 'CHECKOUT_OUTCOME_UNKNOWN');
      assert.equal(door.pricer.calls.length, 1, 'nothing more is asked of the pricer meanwhile');
    });
  });
}

// ---- the market recorded on the session's quote, and who may replace it ---------------------------------------------
//
// The kernel records the market a quote was judged for on its snapshot, and an update is judged for the session's
// recorded market. The ACP door's updates can carry a new address, so that door states that such an update's market
// replaces the session's (`market_replaces_session_market`). The statement is honoured only on a call that door
// built, and only when the call names a market.

const ACP_CTX = { user_ref: 'buyer_1', protocol: 'acp' };
const recordedMarket = async (door, id) => {
  const stored = await door.store.get(id);
  return door.kernel.quotes.sessionMarket(stored.quote_id, { user_ref: 'buyer_1', acp_session_id: id });
};

test('the market recorded on the session follows a successful address change, and only a successful one', async () => {
  // A pricer that answers in the currency of the cart's merchant, whatever market it is sent.
  const calls = [];
  const kernel = new SafetyKernel({
    upstream: async (op, payload) => {
      calls.push({ op, payload: structuredClone(payload) });
      return {
        quote_id: `uq_${calls.length}`, merchant_of_record: payload.quote.merchant_id, currency: payload.quote.merchant_id === 'merch_SGD' ? 'SGD' : 'USD',
        locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [], acp_state: {},
      };
    },
    secret: KSECRET, log: quiet, now: () => FIXED_NOW,
  });
  const store = new InMemoryKvStore({ now: () => FIXED_NOW });
  const adapter = createAcpRestAdapter({
    executor: createCanonicalExecutor({ kernel, upstream: async () => ({}) }), sessionStore: store, signingSecret: SECRET,
    resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }), marketCurrencyOf, now: () => FIXED_NOW,
  });
  const door = { store, kernel };
  const from = (merchant_id, country, quantity = 1) => ({ ...cart(country, quantity), merchant_id });
  const marketsAsked = () => calls.map((c) => c.payload.market ?? null);

  const id = (await adapter.createCheckoutSession(req({ body: from('merch_USD', 'US') }))).body.id;
  assert.deepEqual(await recordedMarket(door, id), { market: 'US', market_currency: 'USD' });

  // Refused change (the seller is not priced for SG): the session keeps its quote and its recorded market.
  const quoteBefore = (await store.get(id)).quote_id;
  refusedBy(await adapter.updateCheckoutSession(req({ id, body: from('merch_USD', 'SG') })), MISMATCH, 'SG');
  assert.equal((await store.get(id)).quote_id, quoteBefore);
  assert.deepEqual(await recordedMarket(door, id), { market: 'US', market_currency: 'USD' }, 'SG was never recorded');
  assert.equal((await store.get(id)).refused_market, 'SG');

  // Successful change to SG with a seller priced in SGD: the recorded market is the new one, the mark is gone.
  const moved = await adapter.updateCheckoutSession(req({ id, body: from('merch_SGD', 'SG') }));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.currency, 'SGD');
  assert.deepEqual(await recordedMarket(door, id), { market: 'SG', market_currency: 'SGD' });
  assert.equal('refused_market' in (await store.get(id)), false);

  // No address: the market is not taken away. Judged for SG, recorded as SG; a seller priced in USD is refused for SG.
  const kept = await adapter.updateCheckoutSession(req({ id, body: from('merch_SGD', undefined, 2) }));
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.deepEqual(await recordedMarket(door, id), { market: 'SG', market_currency: 'SGD' });
  refusedBy(await adapter.updateCheckoutSession(req({ id, body: from('merch_USD', undefined) })), MISMATCH, 'SG');
  assert.deepEqual(await recordedMarket(door, id), { market: 'SG', market_currency: 'SGD' });
  assert.deepEqual(marketsAsked(), ['US', 'SG', 'SG', 'SG', 'SG'], 'every quote was asked for the market it was judged for');
});

test('a session created with no address records no market; an address-less update leaves it so; an address gives it one', async () => {
  const door = setup({ sellerCurrency: 'SGD' });
  const id = (await door.adapter.createCheckoutSession(req({ body: cart(undefined) }))).body.id;
  assert.equal(await recordedMarket(door, id), null);
  assert.equal((await door.adapter.updateCheckoutSession(req({ id, body: cart(undefined, 2) }))).status, 200);
  assert.equal(await recordedMarket(door, id), null);
  assert.deepEqual(Object.keys(door.ops('preview_quote').at(-1).payload), ['quote']);
  assert.equal((await door.adapter.updateCheckoutSession(req({ id, body: cart('SG', 2) }))).status, 200);
  assert.deepEqual(await recordedMarket(door, id), { market: 'SG', market_currency: 'SGD' });
});

test('only the ACP door\'s own call can replace a session\'s market: the same members on another door\'s update are judged for the recorded market', async () => {
  for (const ctx of [{ user_ref: 'buyer_1', acp_session_id: 'sess_1' }, { user_ref: 'buyer_1', acp_session_id: 'sess_1', protocol: 'mcp' }, { user_ref: 'buyer_1', acp_session_id: 'sess_1', protocol: 'ACP' }]) {
    const { executor, kernel, ops } = setup({ sellerCurrency: 'USD' });
    const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-move-0001', quote: QUOTE, market: 'US', market_currency: 'USD' }, ctx);
    // Were SG honoured, a USD quote would be refused. It is not read: the update is judged for US, and stays US.
    const updated = await executor.execute('update_checkout_session', {
      idempotency_key: 'idem-move-0002', session_id: session.session_id, quote: QUOTE,
      market: 'SG', market_currency: 'SGD', market_replaces_session_market: true,
    }, ctx);
    assert.equal(updated.currency, 'USD');
    assert.equal(ops('preview_quote').at(-1).payload.market, 'US');
    assert.deepEqual(await kernel.quotes.sessionMarket(updated.session_id, ctx), { market: 'US', market_currency: 'USD' });
  }
});

test('on the ACP door\'s call the statement replaces the market only when a market is named; it never removes one', async () => {
  const ctx = { ...ACP_CTX, acp_session_id: 'sess_1' };
  const { executor, kernel, ops } = setup({ sellerCurrency: 'USD' });
  const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-move-0003', quote: QUOTE, market: 'US', market_currency: 'USD' }, ctx);
  for (const none of [{}, { market: undefined }, { market: null }]) {
    const updated = await executor.execute('update_checkout_session', { idempotency_key: `idem-move-000${ops('preview_quote').length + 3}`, session_id: session.session_id, quote: QUOTE, market_replaces_session_market: true, ...none }, ctx);
    assert.equal(ops('preview_quote').at(-1).payload.market, 'US', 'judged for the recorded market');
    assert.deepEqual(await kernel.quotes.sessionMarket(updated.session_id, ctx), { market: 'US', market_currency: 'USD' });
  }
  // Named: judged for the new market (refused here, the seller is priced in USD), and nothing is recorded for it.
  const err = await refusal(executor.execute('update_checkout_session', { idempotency_key: 'idem-move-0009', session_id: session.session_id, quote: QUOTE, market: 'SG', market_currency: 'SGD', market_replaces_session_market: true }, ctx));
  assert.equal(surfaceableIntakeRefusal(err).detail.reason, MISMATCH);
  assert.equal(surfaceableIntakeRefusal(err).detail.market, 'SG');
  // Without the statement the same members are judged for the recorded market, on this door too.
  const plain = await executor.execute('update_checkout_session', { idempotency_key: 'idem-move-0010', session_id: session.session_id, quote: QUOTE, market: 'SG', market_currency: 'SGD' }, ctx);
  assert.equal(plain.currency, 'USD');
  assert.equal(ops('preview_quote').at(-1).payload.market, 'US');
});

test('the registry\'s own check still stands behind a replaced market: a quote recorded for the new market must be in its currency', async () => {
  const ctx = { ...ACP_CTX, acp_session_id: 'sess_1' };
  const { kernel } = setup({ sellerCurrency: 'USD' });
  // The door's judgement taken away (an accept that lets anything through): the registry refuses to record it.
  const err = await refusal(kernel.previewQuote({ quote: QUOTE, market: 'SG' }, ctx, { acceptQuoteCurrency: () => {}, sessionMarket: { market: 'SG', market_currency: 'SGD' } }));
  assert.equal(err.detail.reason, 'quote_not_in_session_market_currency');
  assert.equal(kernel.quotes._store._m?.size ?? 0, 0, 'nothing was recorded');
  // And a quote in the new market's currency is recorded for it.
  const sgd = setup({ sellerCurrency: 'SGD' });
  const quote = await sgd.kernel.previewQuote({ quote: QUOTE, market: 'SG' }, ctx, { acceptQuoteCurrency: () => {}, sessionMarket: { market: 'SG', market_currency: 'SGD' } });
  assert.deepEqual(await sgd.kernel.quotes.sessionMarket(quote.quote_id, ctx), { market: 'SG', market_currency: 'SGD' });
});

test('one set of stage words: each stage has its own sentence, and an unknown stage is worded as a create', async () => {
  const { quoteMarketOf } = await import('../src/protocol/canonicalExecutor.js');
  const sentence = (stage) => {
    try { quoteMarketOf({ market: 'SG', market_currency: 'SGD' }, stage).accept('USD'); } catch (e) { return surfaceableIntakeRefusal(e).message; }
    return assert.fail('expected a refusal');
  };
  assert.match(sentence('create'), /and no checkout session was created\./);
  assert.match(sentence('update'), /and the checkout session was not re-priced\./);
  assert.match(sentence('session'), /and this checkout session was neither read out nor paid\./);
  assert.equal(sentence(undefined), sentence('create'));
  assert.equal(sentence('complete'), sentence('create'));
  assert.deepEqual(Object.keys(quoteMarketOf({ market: 'SG', market_currency: 'SGD' })), ['market', 'currency', 'accept']);
});

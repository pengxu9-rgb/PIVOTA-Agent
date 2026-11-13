// A checkout that names a market is priced in that market's currency or refused by name (canonicalExecutor.js,
// quoteMarketOf; kernel.js, previewQuote's `acceptQuoteCurrency`). At the executor and the kernel, with a recording
// upstream: what reaches the pricing call, what is answered, and that a refused quote leaves no session behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { PivotaCommerceError } from '../src/errors.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { surfaceableIntakeRefusal } from '../src/protocol/buyerIntake.js';

const SECRET = 'exec-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const quiet = { info() {}, warn() {}, error() {} };
const QUOTE = { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }] };

function setup({ currency = 'USD', upstreamQuote } = {}) {
  const priced = [];
  const kernelUpstream = async (op, payload) => {
    if (op !== 'preview_quote') return {};
    priced.push(structuredClone(payload));
    return upstreamQuote || {
      quote_id: 'uq_1', merchant_of_record: 'merch_A', currency,
      locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 },
      line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {},
    };
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const issued = [];
  const realIssue = kernel.quotes.issue.bind(kernel.quotes);
  kernel.quotes.issue = async (snapshot) => { issued.push(snapshot); return realIssue(snapshot); };
  const exec = createCanonicalExecutor({ kernel, upstream: async () => ({}) });
  let n = 0;
  const run = (opId, extra = {}) => { n += 1; return exec.execute(opId, { idempotency_key: `idem-quote-market-${n}`, quote: QUOTE, ...extra }, CTX); };
  return { kernel, run, priced, issued };
}
const refusal = (p) => p.then(() => assert.fail('expected a refusal'), (e) => e);
const detailOf = (err) => surfaceableIntakeRefusal(err).detail;

test('no market: the pricing call is the one it always was, and the answer is in the seller\'s currency', async () => {
  for (const currency of ['USD', 'SGD']) {
    const { run, priced, issued } = setup({ currency });
    const session = await run('create_checkout_session');
    assert.equal(session.currency, currency);
    assert.deepEqual(priced, [{ quote: QUOTE }], 'nothing but the quote');
    assert.equal(issued.length, 1);
  }
});

test('a market whose currency the quote is in: priced, and the market travels in the pricing call', async () => {
  for (const [market, currency] of [['US', 'USD'], ['SG', 'SGD'], ['GB', 'GBP']]) {
    for (const opId of ['create_checkout_session', 'update_checkout_session']) {
      const { run, priced, issued } = setup({ currency });
      const session = await run(opId, { market, market_currency: currency, ...(opId === 'update_checkout_session' ? { session_id: 'q_any' } : {}) });
      assert.equal(session.currency, currency);
      assert.deepEqual(session.totals, { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, 'the quote\'s own amounts');
      assert.deepEqual(priced, [{ quote: QUOTE, market }], 'the market, and never its currency');
      assert.equal(issued.length, 1);
    }
  }
});

test('the upstream currency is compared in its canonical upper case', async () => {
  const { run } = setup({ currency: 'sgd' });
  assert.equal((await run('create_checkout_session', { market: 'SG', market_currency: 'SGD' })).currency, 'SGD');
});

test('a quote in another currency than the market\'s: refused by name, after one pricing call, and NO session exists', async () => {
  for (const [market, marketCurrency, sellerCurrency] of [['SG', 'SGD', 'USD'], ['GB', 'GBP', 'USD'], ['US', 'USD', 'SGD'], ['GB', 'GBP', 'EUR']]) {
    for (const opId of ['create_checkout_session', 'update_checkout_session']) {
      const { run, priced, issued } = setup({ currency: sellerCurrency });
      const err = await refusal(run(opId, { market, market_currency: marketCurrency }));
      assert.ok(err instanceof PivotaCommerceError);
      assert.equal(err.code, 'NO_MERCHANT_OFFER');
      assert.equal(err.retriable, false);
      assert.deepEqual(detailOf(err), { reason: 'seller_not_priced_in_market_currency', market, market_currency: marketCurrency, seller_currencies: [sellerCurrency] });
      const { message } = surfaceableIntakeRefusal(err);
      assert.ok(message.includes(`priced in ${sellerCurrency}`) && message.includes(`must be in ${marketCurrency}`), message);
      assert.equal(/\d/.test(message), false, 'the refusal states no amount');
      assert.equal(priced.length, 1);
      assert.equal(priced[0].market, market);
      assert.deepEqual(issued, [], 'nothing was snapshotted');
    }
  }
});

test('a market with no currency: refused by name BEFORE any pricing call, and the market is named', async () => {
  for (const market of ['DE', 'ZZ']) {
    for (const marketCurrency of [undefined, null, '', 'usd', 'US', 'USDX', 840, {}]) {
      const { run, priced, issued } = setup();
      const err = await refusal(run('create_checkout_session', { market, market_currency: marketCurrency }));
      assert.equal(err.code, 'NO_MERCHANT_OFFER', String(marketCurrency));
      assert.deepEqual(detailOf(err), { reason: 'market_not_priced', market });
      assert.ok(surfaceableIntakeRefusal(err).message.includes(market));
      assert.deepEqual([priced, issued], [[], []], 'nothing was priced or snapshotted');
    }
  }
});

test('the bounds answer before the market: a duplicate line, a quantity above the ceiling and a short key are refused as themselves for any market', async () => {
  const line = QUOTE.items[0];
  for (const members of [{ market: 'SG', market_currency: 'SGD' }, { market: 'DE' }, { market: 'ZZ' }, { market: 'usa' }, {}]) {
    for (const opId of ['create_checkout_session', 'update_checkout_session']) {
      const label = `${opId} ${JSON.stringify(members)}`;
      const dup = setup({ currency: 'USD' });
      const dupErr = await refusal(dup.run(opId, { ...members, quote: { ...QUOTE, items: [line, { ...line, quantity: 2 }] } }));
      assert.equal(detailOf(dupErr).reason, 'duplicate_line_for_product_variant', label);
      const many = setup({ currency: 'USD' });
      const manyErr = await refusal(many.run(opId, { ...members, quote: { ...QUOTE, items: [{ ...line, quantity: 100000 }] } }));
      assert.notEqual(detailOf(manyErr).reason, 'market_not_priced', label);
      assert.notEqual(detailOf(manyErr).reason, 'market_invalid', label);
      assert.match(detailOf(manyErr).reason, /quantity/, label);
      const short = setup({ currency: 'USD' });
      const shortErr = await refusal(short.run(opId, { ...members, idempotency_key: 'k1' }));
      assert.match(String(detailOf(shortErr).reason), /idempotency_key/, label);
      assert.deepEqual([dup.priced, dup.issued, many.priced, many.issued, short.priced, short.issued], [[], [], [], [], [], []], label);
    }
  }
});

test('a market that is not an upper-case two-letter code is never priced and never echoed', async () => {
  for (const market of ['usa', 'sg', 'U', 'S G', '', 12, true, {}, ['US']]) {
    const { run, priced, issued } = setup();
    const err = await refusal(run('create_checkout_session', { market, market_currency: 'USD' }));
    assert.equal(err.code, 'QUOTE_REQUIRED', JSON.stringify(market));
    assert.deepEqual(detailOf(err), { reason: 'market_invalid', rejected_field: 'market' });
    assert.deepEqual([priced, issued], [[], []]);
  }
  // null is "names none", as absent is.
  const { run, priced } = setup();
  await run('create_checkout_session', { market: null, market_currency: 'SGD' });
  assert.deepEqual(priced, [{ quote: QUOTE }]);
});

test('kernel.previewQuote: the acceptor sees the canonical currency once, before the snapshot, and only for a well-formed quote', async () => {
  const seen = [];
  const { kernel, issued } = setup({ currency: 'gbp' });
  await kernel.previewQuote({ quote: QUOTE }, CTX, { acceptQuoteCurrency: (currency) => { seen.push([currency, issued.length]); } });
  assert.deepEqual(seen, [['GBP', 0]]);
  assert.equal(issued.length, 1);

  const refused = new Error('not this currency');
  const second = setup({ currency: 'USD' });
  await assert.rejects(second.kernel.previewQuote({ quote: QUOTE }, CTX, { acceptQuoteCurrency: () => { throw refused; } }), (e) => e === refused);
  assert.deepEqual(second.issued, []);

  // A malformed upstream quote is refused as it always was, and the acceptor is never asked about it.
  const malformed = setup({ upstreamQuote: { quote_id: 'uq_2', merchant_of_record: 'merch_A', currency: 'USD', locked_totals: { total: 1.5 } } });
  let asked = 0;
  await assert.rejects(malformed.kernel.previewQuote({ quote: QUOTE }, CTX, { acceptQuoteCurrency: () => { asked += 1; } }), (e) => e.code === 'MERCHANT_UNAVAILABLE');
  assert.equal(asked, 0);

  // Without an acceptor (every caller before this rule), and with a non-function one, nothing changes.
  for (const opts of [undefined, {}, { acceptQuoteCurrency: 'SGD' }, null]) {
    const plain = setup({ currency: 'EUR' });
    assert.equal((await plain.kernel.previewQuote({ quote: QUOTE }, CTX, ...(opts === undefined ? [] : [opts]))).currency, 'EUR');
  }
});

// ---- a session keeps the market it was created for (update) ------------------------------------------------------

// A kernel whose pricing currency a test can change between calls, and a create that returns the session.
function sessionSetup(currency = 'SGD') {
  const state = { currency };
  const priced = [];
  const kernelUpstream = async (op, payload) => {
    if (op === 'create_order') return { order_id: 'o_1', acp_state: {} };
    if (op !== 'preview_quote') return {};
    priced.push(structuredClone(payload));
    return { quote_id: `uq_${priced.length}`, merchant_of_record: 'merch_A', currency: state.currency, locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [{ product_id: 'p1', quantity: 1 }], acp_state: {} };
  };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: SECRET, log: quiet });
  const exec = createCanonicalExecutor({ kernel, upstream: async () => ({}) });
  let n = 0;
  const run = (opId, extra = {}, ctx = CTX) => { n += 1; return exec.execute(opId, { idempotency_key: `idem-session-market-${n}`, quote: QUOTE, ...extra }, ctx); };
  return { kernel, run, priced, state };
}
const SG = { market: 'SG', market_currency: 'SGD' };

test('the market is recorded on the session at create, and only when the create named one', async () => {
  const { kernel, run } = sessionSetup('SGD');
  const bound = await run('create_checkout_session', SG);
  assert.deepEqual(await kernel.quotes.sessionMarket(bound.session_id, CTX), SG);
  const unbound = await run('create_checkout_session');
  assert.equal(await kernel.quotes.sessionMarket(unbound.session_id, CTX), null);
  const snapshot = await kernel.quotes.resolveForOrder(unbound.session_id, CTX);
  assert.equal('market' in snapshot || 'market_currency' in snapshot, false, 'a session with no market records none');
  // The answer itself does not change shape: the market is the session's record, not a member of the answer.
  assert.equal('market' in bound || 'market_currency' in bound, false);
});

test('an update is judged for the market of the SESSION: priced while the re-quote is in its currency, and the new session is bound too', async () => {
  const { kernel, run, priced, state } = sessionSetup('SGD');
  const created = await run('create_checkout_session', SG);
  const updated = await run('update_checkout_session', { session_id: created.session_id });
  assert.equal(updated.currency, 'SGD');
  assert.notEqual(updated.session_id, created.session_id);
  assert.equal(priced[1].market, 'SG', 'the re-quote carries the session\'s market');
  assert.deepEqual(await kernel.quotes.sessionMarket(updated.session_id, CTX), SG);
  state.currency = 'USD';
  const err = await refusal(run('update_checkout_session', { session_id: updated.session_id }));
  assert.deepEqual(detailOf(err), { reason: 'seller_not_priced_in_market_currency', market: 'SG', market_currency: 'SGD', seller_currencies: ['USD'] });
  assert.ok(surfaceableIntakeRefusal(err).message.includes('the checkout session was not re-priced'));
});

test('a refused update leaves the session exactly as it was, and it still completes in its judged currency', async () => {
  const { kernel, run, state } = sessionSetup('SGD');
  const created = await run('create_checkout_session', SG);
  const before = structuredClone(await kernel.quotes.resolveForOrder(created.session_id, CTX));
  state.currency = 'USD';
  await refusal(run('update_checkout_session', { session_id: created.session_id }));
  assert.deepEqual(structuredClone(await kernel.quotes.resolveForOrder(created.session_id, CTX)), before);
  const read = await run('get_checkout_session', { session_id: created.session_id });
  assert.equal(read.currency, 'SGD');
  const order = await kernel.createOrder({ idempotency_key: 'idem-order-0001', order: { quote_id: created.session_id, shipping_address: {} } }, CTX);
  assert.equal(order.currency, 'SGD', 'the order is in the currency that was judged');
});

test('the session\'s market is the one judged, whatever market the update itself carries: a session cannot be moved to another market', async () => {
  const { kernel, run, priced, state } = sessionSetup('SGD');
  const created = await run('create_checkout_session', SG);
  state.currency = 'USD';
  for (const carried of [{ market: 'US', market_currency: 'USD' }, { market: 'DE' }, { market: 'usa' }, { market: null }]) {
    const err = await refusal(run('update_checkout_session', { session_id: created.session_id, ...carried }));
    assert.equal(detailOf(err).reason, 'seller_not_priced_in_market_currency', JSON.stringify(carried));
    assert.equal(detailOf(err).market, 'SG');
    assert.equal(priced.at(-1).market, 'SG');
  }
  assert.deepEqual(await kernel.quotes.sessionMarket(created.session_id, CTX), SG);
});

test('a session created with no market is updated unjudged and never acquires one; an id that is not this buyer\'s session carries none', async () => {
  const { kernel, run, priced, state } = sessionSetup('USD');
  const created = await run('create_checkout_session');
  state.currency = 'SGD';
  const updated = await run('update_checkout_session', { session_id: created.session_id });
  assert.equal(updated.currency, 'SGD');
  assert.deepEqual(priced.at(-1), { quote: QUOTE }, 'no market in the re-quote');
  assert.equal(await kernel.quotes.sessionMarket(updated.session_id, CTX), null);

  // Another buyer's bound session, an id that never existed, and no id at all: no market, priced as before.
  state.currency = 'USD';
  const bound = await run('create_checkout_session', { market: 'US', market_currency: 'USD' });
  state.currency = 'SGD';
  const OTHER = { user_ref: 'user_2', acp_session_id: 'acp_2' };
  for (const [session_id, ctx] of [[bound.session_id, OTHER], [bound.session_id, { ...CTX, acp_session_id: 'acp_other' }], ['q_never', CTX], [undefined, CTX], [42, CTX]]) {
    const out = await run('update_checkout_session', { session_id }, ctx);
    assert.equal(out.currency, 'SGD', String(session_id));
    assert.deepEqual(priced.at(-1), { quote: QUOTE });
  }
  assert.equal(await kernel.quotes.sessionMarket(bound.session_id, OTHER), null, 'nothing is said about another buyer\'s session');
});

test('the bounds answer before the session is read on an update of a bound session', async () => {
  const { kernel, run, priced, state } = sessionSetup('SGD');
  const created = await run('create_checkout_session', SG);
  state.currency = 'USD';
  let reads = 0;
  const real = kernel.quotes.sessionMarket.bind(kernel.quotes);
  kernel.quotes.sessionMarket = async (...a) => { reads += 1; return real(...a); };
  const line = QUOTE.items[0];
  const err = await refusal(run('update_checkout_session', { session_id: created.session_id, quote: { ...QUOTE, items: [line, { ...line, quantity: 2 }] } }));
  assert.equal(detailOf(err).reason, 'duplicate_line_for_product_variant');
  assert.deepEqual([reads, priced.length], [0, 1], 'refused before the session read and before any re-quote');
  await refusal(run('update_checkout_session', { session_id: created.session_id }));
  assert.equal(reads, 1, 'one read of the session record per update, and none on a create');
  await run('create_checkout_session').catch(() => null);
  assert.equal(reads, 1);
});

test('the registry never stores a market-bound snapshot in another currency, and records only a well-formed market', async () => {
  const { kernel } = sessionSetup('SGD');
  const base = { user_ref: 'user_1', acp_session_id: 'acp_1', merchant_of_record: 'merch_A', upstream_quote_id: 'uq', locked_totals: { total: 1 }, line_items: [] };
  await assert.rejects(kernel.quotes.issue({ ...base, currency: 'USD', market: SG }), (e) => e.code === 'MERCHANT_UNAVAILABLE' && e.detail.reason === 'quote_not_in_session_market_currency');
  const ok = await kernel.quotes.issue({ ...base, currency: 'SGD', market: SG });
  assert.deepEqual([ok.market, ok.market_currency], ['SG', 'SGD']);
  for (const market of [undefined, null, 'SG', {}, { market: 'SG' }, { market: 'sg', market_currency: 'SGD' }, { market: 'SG', market_currency: 'sgd' }, { market: 'SG', market_currency: '' }]) {
    const snap = await kernel.quotes.issue({ ...base, currency: 'USD', market });
    assert.equal('market' in snap || 'market_currency' in snap, false, JSON.stringify(market));
    assert.equal(await kernel.quotes.sessionMarket(snap.quote_id, CTX), null);
  }
});

test('the refusal never repeats a currency the pricing engine sent that is not a three-letter code', async () => {
  for (const [raw, mustNotAppear] of [[' GBP ', 'GBP'], ['GBP,EUR', 'GBP'], ['gbp;', 'GBP'], ['DOLLARS', 'DOLLARS'], [702, '702']]) {
    const { run } = setup({ currency: raw });
    const err = await refusal(run('create_checkout_session', SG));
    assert.deepEqual(detailOf(err), { reason: 'seller_not_priced_in_market_currency', market: 'SG', market_currency: 'SGD' }, String(raw));
    const { message } = surfaceableIntakeRefusal(err);
    assert.ok(message.includes('priced in another currency'), message);
    assert.equal(message.includes(mustNotAppear), false, message);
    assert.equal(JSON.stringify(detailOf(err)).includes(mustNotAppear), false);
  }
  // A well-formed code is named, as before.
  const { run } = setup({ currency: 'eur' });
  assert.deepEqual(detailOf(await refusal(run('create_checkout_session', SG))).seller_currencies, ['EUR']);
});

// A shipping address is where the order is sent, and its country is not the buyer's market on this path: it is
// never read as one. An update that changes the address country is still judged for the session's market, a session
// with no market does not acquire one from an address, and the address still travels to the pricing call.
test('a shipping address country is not the market: it neither moves a session\'s market nor gives one to a session without', async () => {
  const address = (country) => ({ country, city: 'City', postal_code: '00000', address_line1: '1 Street', recipient_name: 'A Buyer' });
  const { kernel, run, priced, state } = sessionSetup('SGD');
  const created = await run('create_checkout_session', { ...SG, quote: { ...QUOTE, shipping_address: address('SG') } });
  const moved = await run('update_checkout_session', { session_id: created.session_id, quote: { ...QUOTE, shipping_address: address('US') } });
  assert.equal(moved.currency, 'SGD');
  assert.equal(priced.at(-1).market, 'SG');
  assert.equal(priced.at(-1).quote.shipping_address.country, 'US', 'the address is sent as given');
  assert.deepEqual(await kernel.quotes.sessionMarket(moved.session_id, CTX), SG);
  state.currency = 'USD';
  const err = await refusal(run('update_checkout_session', { session_id: created.session_id, quote: { ...QUOTE, shipping_address: address('US') } }));
  assert.equal(detailOf(err).market, 'SG', 'a USD re-quote for a US address is still refused for the session\'s SG');

  const plain = await run('create_checkout_session', { quote: { ...QUOTE, shipping_address: address('GB') } });
  assert.equal(plain.currency, 'USD');
  assert.equal('market' in priced.at(-1), false);
  assert.equal(await kernel.quotes.sessionMarket(plain.session_id, CTX), null);
});

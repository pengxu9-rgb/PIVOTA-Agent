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

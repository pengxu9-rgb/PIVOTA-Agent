'use strict';

/*
 * The landed total (audit item 9), surfaced through the warm-handoff internal route.
 *
 * The service already builds a priced create_checkout preview against the merchant — synthetic
 * address, no PII, never completed and never paid — and the route was dropping it. It is the only
 * source that can answer "what will the buyer actually be charged", because it INCLUDES shipping
 * and tax and it names its currency. The storefront `.js` endpoint the backend otherwise reads
 * carries a bare unit price with no currency code at all.
 *
 * These pin the one rule that matters here: an amount and its currency move together.
 */

const assert = require('node:assert/strict');

const { pricedTotals } = require('../src/services/ucpWarmHandoffInternalRoute');

test('a complete priced preview is projected to its money fields', () => {
  const out = pricedTotals({
    total: 48.5,
    currency: 'USD',
    subtotal: 41.99,
    tax: 3.51,
    shipping_options: [{ id: 'std', price: 3.0 }],
    continue_url: 'https://brand.com/checkouts/cn/abc',
    messages: ['note'],
    requires_escalation: false,
  });
  assert.deepEqual(out, {
    total: 48.5,
    currency: 'USD',
    subtotal: 41.99,
    tax: 3.51,
    requires_escalation: false,
  });
});

test('the projection is NARROWING — it does not leak the handoff url or free text back', () => {
  // The caller already holds the continue_url; echoing it here would widen an internal contract
  // for no gain, and `messages` is merchant-authored free text with no reason to cross this hop.
  const out = pricedTotals({
    total: 10, currency: 'USD',
    continue_url: 'https://brand.com/checkouts/cn/secret',
    messages: ['merchant says hello'],
    shipping_options: [{ id: 'std' }],
  });
  assert.equal(out.continue_url, undefined);
  assert.equal(out.messages, undefined);
  assert.equal(out.shipping_options, undefined);
});

test('an amount with no currency is withheld ENTIRELY, not published bare', () => {
  // Quoting 4500 as dollars when the merchant meant yen is worse than saying nothing. This is the
  // amount-without-its-currency class both repos have now fixed several times.
  for (const preview of [
    { total: 4500 },
    { total: 4500, currency: '' },
    { total: 4500, currency: '   ' },
    { total: 4500, currency: null },
    { total: 4500, currency: 42 },
    { total: 4500, currency: 'US' },
    { total: 4500, currency: 'DOLLARS' },
    { total: 4500, currency: 'U5D' },
  ]) {
    assert.equal(pricedTotals(preview), null,
      `must withhold a total whose currency is ${JSON.stringify(preview.currency)}`);
  }
});

test('a currency with no amount says nothing and is withheld too', () => {
  assert.equal(pricedTotals({ currency: 'JPY' }), null);
  assert.equal(pricedTotals({ currency: 'JPY', total: null }), null);
});

test('a non-numeric total is refused rather than relayed', () => {
  // A string total would sort and compare as text wherever a caller does arithmetic on it.
  for (const total of ['48.50', {}, [], true, NaN, Infinity, -Infinity]) {
    assert.equal(pricedTotals({ total, currency: 'USD' }), null,
      `must refuse ${JSON.stringify(total)}`);
  }
});

test('a zero total is real and survives', () => {
  // A fully-discounted or gift order is a legitimate total. Treating 0 as absent would withhold it.
  const out = pricedTotals({ total: 0, currency: 'USD' });
  assert.equal(out.total, 0);
  assert.equal(out.currency, 'USD');
});

test('subtotal and tax degrade on their own — they are not the promise', () => {
  // Unlike the total, these are supporting detail. A merchant that omits tax must not cost the
  // caller the total it CAN quote.
  const out = pricedTotals({ total: 48.5, currency: 'USD', subtotal: 'nope', tax: undefined });
  assert.equal(out.total, 48.5);
  assert.equal(out.subtotal, null);
  assert.equal(out.tax, null);
});

test('requires_escalation is relayed and needs an explicit true', () => {
  // It means the merchant still needs an address or payment on the STOREFRONT — i.e. this total
  // is the best computable WITHOUT the buyer, and must not be presented as final.
  assert.equal(pricedTotals({ total: 1, currency: 'USD', requires_escalation: true })
    .requires_escalation, true);
  for (const truthy of ['true', 1, {}]) {
    assert.equal(
      pricedTotals({ total: 1, currency: 'USD', requires_escalation: truthy }).requires_escalation,
      false,
      `a truthy ${JSON.stringify(truthy)} must not raise the escalation flag`,
    );
  }
});

test('a missing or non-object preview is null, never a throw', () => {
  // The preview key is ABSENT whenever the flag is off, which is the default — so this is the
  // ordinary path, not an edge case.
  for (const bad of [undefined, null, 'nope', 42, [], true]) {
    assert.equal(pricedTotals(bad), null);
  }
});

'use strict';

/*
 * What create_checkout can honestly assert about price (audit item 9), surfaced through the
 * warm-handoff internal route.
 *
 * THE AUDIT'S PREMISE WAS WRONG, and these encode the corrected one. B7 assumed UCP
 * `create_checkout` "returns the same numbers anonymously" as the admin API. It does not: the
 * live schema has no `shipping_address` field, Shopify collects the delivery address on the
 * STOREFRONT, and shipping/tax quotes are therefore not returned at this step at all
 * (ucpBuyerAgentClient.js:1017,1253 — live-verified against cosrx). On the real path
 * `total === subtotal`, `shipping_options` is `[]`, `tax` is `null`, and the checkout comes back
 * `requires_escalation`.
 *
 * So what crosses this hop is a PRE-SHIPPING SUBTOTAL IN MINOR UNITS. Its value over the
 * storefront `.js` endpoint is not completeness — it is that it NAMES ITS CURRENCY, which `.js`
 * does not do at all.
 */

const assert = require('node:assert/strict');

const { pricedTotals } = require('../src/services/ucpWarmHandoffInternalRoute');

// The shape the repo's own live fixture carries (cosrx, 2026-07-13): STRING amounts, minor units,
// no shipping, no tax, escalation required.
const LIVE = {
  subtotal: '1600',
  total: '1600',
  currency: 'USD',
  tax: null,
  shipping_options: [],
  requires_escalation: true,
};

test('the LIVE merchant shape is accepted — string amounts, minor units', () => {
  // The first cut of this required `typeof total === 'number'`, which made the feature inert on
  // the only merchant payload anyone has actually verified. `pickMoney` is documented "no math,
  // no coercion" and passes strings straight through.
  assert.deepEqual(pricedTotals(LIVE), {
    subtotal_minor: 1600,
    currency: 'USD',
    tax_minor: null,
    includes_shipping: false,
    includes_tax: false,
    requires_escalation: true,
  });
});

test('the amount is MINOR units and the key says so', () => {
  // `1600 USD` is $16.00. A bare `total: 1600` beside a currency code is the same
  // amount-without-its-unit hazard as a missing currency, one level down — and it errs in the
  // direction that overstates by 100x.
  const out = pricedTotals(LIVE);
  assert.equal(out.subtotal_minor, 1600);
  assert.ok(!('total' in out), 'must not publish a bare `total` that reads as major units');
  assert.ok(!('subtotal' in out), 'the unscaled name is exactly the ambiguity being removed');
});

test('a DECIMAL amount is refused rather than guessed at', () => {
  // "16.00" means the merchant is not using the convention we are about to publish under.
  // Guessing which it is would be the whole bug.
  for (const amount of ['16.00', '16.5', '1,600', '1600.0']) {
    assert.equal(pricedTotals({ total: amount, currency: 'USD' }), null,
      `must refuse ${JSON.stringify(amount)}`);
  }
});

test('shipping and tax exclusions are STATED, not left to be inferred', () => {
  // On the live path both are false every single time. A caller that assumes otherwise quotes a
  // number the buyer will not be charged.
  const out = pricedTotals(LIVE);
  assert.equal(out.includes_shipping, false);
  assert.equal(out.includes_tax, false);

  const withBoth = pricedTotals({
    ...LIVE, tax: '300', shipping_options: [{ id: 'std', price: '500' }],
  });
  assert.equal(withBoth.includes_tax, true);
  assert.equal(withBoth.tax_minor, 300);
  assert.equal(withBoth.includes_shipping, true);
});

test('an amount with no usable currency is withheld ENTIRELY', () => {
  for (const currency of ['', '   ', null, 42, 'US', 'DOLLARS', 'USDT', 'U5D', 'usd '.repeat(2)]) {
    assert.equal(pricedTotals({ total: '1600', currency }), null,
      `must withhold for currency ${JSON.stringify(currency)}`);
  }
});

test('XXX is refused — it is the ISO code for "no currency"', () => {
  // An assertion that there is no unit is not a unit.
  assert.equal(pricedTotals({ total: '1600', currency: 'XXX' }), null);
  assert.equal(pricedTotals({ total: '1600', currency: 'xxx' }), null);
});

test('a lowercase or padded currency still normalises', () => {
  assert.equal(pricedTotals({ total: '1600', currency: ' usd ' }).currency, 'USD');
  assert.equal(pricedTotals({ total: '1600', currency: 'Jpy' }).currency, 'JPY');
});

test('a currency with no amount says nothing and is withheld', () => {
  assert.equal(pricedTotals({ currency: 'JPY' }), null);
  assert.equal(pricedTotals({ currency: 'JPY', total: null }), null);
});

test('a negative amount is refused — there is no negative subtotal', () => {
  assert.equal(pricedTotals({ total: -1600, currency: 'USD' }), null);
  assert.equal(pricedTotals({ total: '-1600', currency: 'USD' }), null);
});

test('a zero subtotal is real and survives', () => {
  const out = pricedTotals({ total: 0, currency: 'USD' });
  assert.equal(out.subtotal_minor, 0);
});

test('a non-integer or unsafe numeric amount is refused', () => {
  for (const total of [16.5, 1e21, NaN, Infinity, {}, [], true, '1e21']) {
    assert.equal(pricedTotals({ total, currency: 'USD' }), null,
      `must refuse ${JSON.stringify(total)}`);
  }
});

test('subtotal is preferred over total when both are present', () => {
  // They are equal on the live path, but `subtotal` is the one whose NAME matches what we publish.
  const out = pricedTotals({ subtotal: '1600', total: '9999', currency: 'USD' });
  assert.equal(out.subtotal_minor, 1600);
});

test('the projection NARROWS — no handoff url, no merchant free text', () => {
  const out = pricedTotals({
    ...LIVE,
    continue_url: 'https://brand.com/checkouts/cn/secret',
    messages: ['merchant text'],
    item: { id: 'gid://x' },
    checkout_status: 'requires_escalation',
  });
  for (const leaked of ['continue_url', 'messages', 'item', 'checkout_status', 'shipping_options']) {
    assert.equal(out[leaked], undefined, `${leaked} must not cross the hop`);
  }
});

test('requires_escalation is relayed and needs an explicit true', () => {
  assert.equal(pricedTotals(LIVE).requires_escalation, true);
  for (const truthy of ['true', 1, {}]) {
    assert.equal(
      pricedTotals({ ...LIVE, requires_escalation: truthy }).requires_escalation, false,
      `a truthy ${JSON.stringify(truthy)} must not raise it`,
    );
  }
});

test('a missing or non-object preview is null, never a throw', () => {
  // The preview key is ABSENT whenever the flag is off, which is the default.
  for (const bad of [undefined, null, 'nope', 42, [], true]) {
    assert.equal(pricedTotals(bad), null);
  }
});

'use strict';

// UCP calls shipping `fulfillment` on the wire, and `type` is free text.
//
// The totals type enum (ucp.dev/2026-04-08/schemas/shopping/types/total.json) is
// "subtotal, items_discount, discount, FULFILLMENT, tax, fee, total". "Shipping" and "Delivery"
// appear in that schema ONLY under `display_text` — "Text to display against the amount (e.g.,
// 'Shipping', 'Delivery')". They are the human label, never the key. Verified live against
// cosrx-renewal.myshopify.com: `fulfillment` appears 12 times in its checkout schemas,
// `"shipping"` as a totals type zero times, `delivery` zero times.
//
// Matching the label instead of the key made this read a merchant that HAD quoted shipping as
// having quoted none. The identical omission caused a real bug in pivota-backend (#1923): a
// landed checkout read as unlanded and earned card headroom it should not have had.
//
// Two different severities, stated honestly:
//   * SHIPPING is latent here — `buildPreview` does not carry `shipping` into the warm-handoff
//     preview, so nothing consumes it yet. Fixed so it cannot arrive silently later.
//   * The unnormalised type key is LIVE for tax: `tax` IS carried into the preview and reaches
//     `pricedTotals().includes_tax`, so a merchant sending "Tax" was read as quoting none.

const test = require('node:test');
const assert = require('node:assert');

const { createUcpBuyerAgentClient } = require('../src/services/ucpBuyerAgentClient.js');

const { normalizePricedCheckout } = createUcpBuyerAgentClient({ env: {} });
const wrap = (payload) => ({ content: [{ type: 'json', json: payload }] });

const BASE = { line_items: [{ title: 'Toner', quantity: 1 }], currency: 'USD' };

test('the spec wire name for shipping is read', () => {
  const out = normalizePricedCheckout(wrap({
    ...BASE,
    totals: [{ type: 'fulfillment', amount: '800', display_text: 'Shipping' }],
  }));
  assert.strictEqual(out.shipping, '800');
});

test('the display spellings still work, for merchants that ignore the enum', () => {
  for (const type of ['shipping', 'delivery']) {
    const out = normalizePricedCheckout(wrap({ ...BASE, totals: [{ type, amount: '800' }] }));
    assert.strictEqual(out.shipping, '800', `totals type ${type}`);
  }
});

test('`fulfillment` wins over a display spelling when a merchant sends both', () => {
  const out = normalizePricedCheckout(wrap({
    ...BASE,
    totals: [{ type: 'shipping', amount: '111' }, { type: 'fulfillment', amount: '800' }],
  }));
  assert.strictEqual(out.shipping, '800');
});

test('a top-level total_shipping still outranks the totals index', () => {
  const out = normalizePricedCheckout(wrap({
    ...BASE, total_shipping: '900', totals: [{ type: 'fulfillment', amount: '800' }],
  }));
  assert.strictEqual(out.shipping, '900');
});

test('the totals type key is normalised — LIVE for tax', () => {
  // `tax` is carried into the warm-handoff preview and reaches pricedTotals().includes_tax, so
  // an unnormalised key here publishes "the merchant quoted no tax" for one that did.
  for (const raw of ['Tax', '  tax  ', 'TAX', '\tTax\n']) {
    const out = normalizePricedCheckout(wrap({ ...BASE, totals: [{ type: raw, amount: '190' }] }));
    assert.strictEqual(out.tax, '190', `totals type ${JSON.stringify(raw)}`);
  }
});

test('normalisation applies to shipping too', () => {
  const out = normalizePricedCheckout(wrap({
    ...BASE, totals: [{ type: ' Fulfillment ', amount: '800' }],
  }));
  assert.strictEqual(out.shipping, '800');
});

test('a spec-shaped LANDED checkout reads as carrying both components', () => {
  const out = normalizePricedCheckout(wrap({
    ...BASE,
    totals: [
      { type: 'subtotal', amount: '2317' },
      { type: 'fulfillment', amount: '800', display_text: 'Shipping' },
      { type: 'tax', amount: '190' },
      { type: 'total', amount: '3307' },
    ],
  }));
  assert.strictEqual(out.subtotal, '2317');
  assert.strictEqual(out.shipping, '800');
  assert.strictEqual(out.tax, '190');
  assert.strictEqual(out.total, '3307');
});

test('a bare pre-address checkout still reads as carrying neither', () => {
  // B7's measured live shape. The fix must not invent coverage where there is none.
  const out = normalizePricedCheckout(wrap({
    ...BASE, tax: null, totals: [{ type: 'subtotal', amount: '2317' }, { type: 'total', amount: '2317' }],
  }));
  assert.strictEqual(out.shipping, null);
  assert.strictEqual(out.tax, null);
});

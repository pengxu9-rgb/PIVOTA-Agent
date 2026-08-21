'use strict';

// The concern-selector prompt told the model a British price was American.
//
// buildConcernSelectorDisplayCandidates built each candidate's price_label from the RAW `row.price`:
//
//   price_label: formatRecoAssistantPromptPriceLabel(row.price) || null
//
// A bare scalar carries no currency, so normalizePriceObject fell back to its flat 'USD' and a row
// that declared its currency in a sibling field had that currency discarded. 88 GBP was stated to the
// model as "$88" and 4500 JPY as "$4500" -- a relabel, not a loss, and the model then reasoned about
// budget and value in the wrong money.
//
// This is precisely the defect #2065 closed for the catalog reader, surviving at the one call site
// that never used that reader. Every sibling price_label in this file already goes through
// extractCatalogCandidatePrice (routes.js:23115, :61253); this one did not. It now does, which also
// stops the selector missing a price carried as price_amount / offer_price / offers[] instead of
// `price` -- seeds extractCatalogCandidatePrice reads and a raw `row.price` never sees.
//
// Guarded here rather than in the card suite because the two surfaces resolve currency separately:
// the card reads row.currency as its fallback, the prompt did not, and only a test that renders BOTH
// from one row can see them disagree.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');
const { normalizeRecommendationProductCard } = require('../src/auroraBff/chatCardFactory');
const { RECO_PRICE_CEILING_KNOWN_CURRENCIES } = require('../src/auroraBff/recoPriceCeiling');

const buildSelector = __internal.buildConcernSelectorDisplayCandidates;

function selectorLabelFor(row) {
  const out = buildSelector([{ product_id: 'p1', name: 'P', brand: 'B', ...row }]);
  assert.equal(out.length, 1, 'the row should survive into the selector candidates');
  return out[0].price_label;
}

test('a scalar price keeps the currency its row declared', () => {
  assert.equal(selectorLabelFor({ price: 88, currency: 'GBP' }), 'GBP 88');
  assert.equal(selectorLabelFor({ price: '88', currency: 'GBP' }), 'GBP 88');
  assert.equal(selectorLabelFor({ price: 4500, currency: 'JPY' }), 'JPY 4500');
  assert.equal(selectorLabelFor({ price: 59, currency: 'EUR' }), 'EUR 59');

  // The exact regression, stated so it cannot come back quietly.
  assert.notEqual(selectorLabelFor({ price: 88, currency: 'GBP' }), '$88');
  assert.notEqual(selectorLabelFor({ price: 4500, currency: 'JPY' }), '$4500');
});

test('every currency the lane knows survives the selector as its own code', () => {
  assert.equal(RECO_PRICE_CEILING_KNOWN_CURRENCIES.length, 14);
  let checked = 0;
  for (const currency of RECO_PRICE_CEILING_KNOWN_CURRENCIES) {
    const label = selectorLabelFor({ price: 4500, currency });
    if (currency === 'USD') {
      assert.equal(label, '$4500');
    } else {
      assert.equal(label, `${currency} 4500`, `${currency} was relabelled`);
      assert.ok(!label.startsWith('$'), `${currency} stated as US dollars: ${label}`);
    }
    checked += 1;
  }
  assert.equal(checked, 14, 'the per-currency loop did not run for every known currency');
});

test('the selector and the card never state different money for one row', () => {
  // They render differently ON PURPOSE -- the card prefers a glyph, the prompt always states a code,
  // because a model reading "¥4500" cannot tell JPY from CNY. What must agree is WHICH currency.
  const glyphs = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', KRW: '₩' };
  for (const currency of RECO_PRICE_CEILING_KNOWN_CURRENCIES) {
    for (const price of [{ amount: 4500, currency }, 4500]) {
      const row = typeof price === 'object' ? { price } : { price, currency };
      const selector = selectorLabelFor(row);
      const card = normalizeRecommendationProductCard({ name: 'P', brand: 'B', ...row }).price_label;

      const expectedSelector = currency === 'USD' ? '$4500' : `${currency} 4500`;
      const expectedCard = glyphs[currency] ? `${glyphs[currency]}4500` : `${currency} 4500`;
      assert.equal(selector, expectedSelector, `selector for ${currency} / ${JSON.stringify(price)}`);
      assert.equal(card, expectedCard, `card for ${currency} / ${JSON.stringify(price)}`);
    }
  }
});

test('a price the row carries under another seed is no longer invisible to the selector', () => {
  // extractCatalogCandidatePrice reads ~26 seeds; a raw row.price saw exactly one. These rows used to
  // reach the model with no price at all, which also let them past any budget reasoning.
  assert.equal(selectorLabelFor({ price_amount: 59, currency: 'EUR' }), 'EUR 59');
  assert.equal(selectorLabelFor({ offer_price: 42, currency: 'CAD' }), 'CAD 42');
  assert.equal(selectorLabelFor({ price: { amount: 88, currency: 'GBP' } }), 'GBP 88');
  assert.equal(selectorLabelFor({ sku: { price: 19.99, currency: 'USD' } }), '$19.99');

  // The sku fallback is load-bearing, not decoration: extractCatalogCandidatePrice reads a NESTED
  // sku.price, but not every seed one level down -- a price the sku carries as price_amount is only
  // found by reading the sku itself. Without the second call this row reaches the model priceless.
  assert.equal(selectorLabelFor({ sku: { price_amount: 42, currency: 'EUR' } }), 'EUR 42');
  assert.equal(selectorLabelFor({ sku: { offer_price: 33, currency: 'JPY' } }), 'JPY 33');
});

test('a row with no readable price states no price, never a fabricated one', () => {
  for (const row of [{}, { price: null }, { price: '' }, { price: false }, { price: 'abc' }, { price: { unknown: true } }]) {
    assert.equal(selectorLabelFor(row), null, `${JSON.stringify(row)} must yield no label`);
  }
  // A boolean is not a dollar, and 0 / negative are "no price" to this reader.
  assert.equal(selectorLabelFor({ price: true, currency: 'GBP' }), null);
  assert.equal(selectorLabelFor({ price: 0, currency: 'GBP' }), null);
  assert.equal(selectorLabelFor({ price: -5, currency: 'GBP' }), null);
});

test('an undeclared currency still reads as USD, the lane default', () => {
  assert.equal(selectorLabelFor({ price: 29.9 }), '$29.90');
  assert.equal(selectorLabelFor({ price: 29.9, currency: 'not-a-code' }), '$29.90');
  // A currency declared as text the price itself carries still wins where it can be read.
  assert.equal(selectorLabelFor({ price: '£88' }), 'GBP 88');
});

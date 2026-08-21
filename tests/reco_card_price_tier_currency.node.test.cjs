'use strict';

// A price band measured in dollars cannot be read off a yen amount.
//
// inferPriceTierFromAmount compares against 20 and 45. Those are US DOLLARS, not numbers -- and it was
// handed the raw amount whatever currency it was in, so it read the unit as if it were a dollar:
//
//   4500 JPY  (about 30 USD, an ordinary mid product)  -> 'premium'
//   1500 JPY  (about 10 USD, plainly budget)           -> 'premium'
//   40000 KRW (about 30 USD)                           -> 'premium'
//   200 SEK   (about 19 USD)                           -> 'premium'
//
// Every currency whose unit is worth less than a dollar was systematically called expensive. The bands
// are as old as the file; what made this REACHABLE is #2065 and #2069, which stopped a declared
// non-USD currency being discarded and stamped USD before it ever got here -- the same pattern as the
// price_label defect, where fixing the data layer turned a dormant rendering bug into a live lie.
//
// Converting is not on the table: this lane holds no FX rates. That is the stated reason
// classifyRecoCandidateAgainstPriceCeiling returns 'unknown' for a foreign currency instead of a
// verdict (recoPriceCeiling.js), and the reason the ceiling upstream disables itself on an
// unrecognized one. So the tier is not derived at all where it cannot be derived honestly, and the
// card falls back to a declared tier or to the neutral 'mid'. A missing band is recoverable; a
// confident wrong one is not -- price_tier drives budget telemetry and any price-ascending sort.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeRecommendationProductCard } = require('../src/auroraBff/chatCardFactory');
const { RECO_PRICE_CEILING_KNOWN_CURRENCIES } = require('../src/auroraBff/recoPriceCeiling');

const cardFor = (row) => normalizeRecommendationProductCard({ name: 'P', brand: 'B', ...row });

test('a foreign-currency amount never buys a price band', () => {
  // Each of these was 'premium' before, on an amount worth about 10-30 USD.
  for (const [amount, currency] of [[4500, 'JPY'], [1500, 'JPY'], [40000, 'KRW'], [200, 'SEK'], [900, 'TWD']]) {
    const card = cardFor({ price: { amount, currency } });
    assert.equal(card.price_tier, 'mid', `${amount} ${currency} should not be banded`);
    assert.notEqual(card.price_tier, 'premium', `${amount} ${currency} was called expensive`);
    // The price itself is still carried and still rendered -- only the BAND is withheld.
    assert.equal(card.price.amount, amount);
    assert.equal(card.price.currency, currency);
    assert.ok(card.price_label, 'the price must still render');
  }
});

test('no known currency other than USD is banded from its raw amount', () => {
  assert.equal(RECO_PRICE_CEILING_KNOWN_CURRENCIES.length, 14);
  let checked = 0;
  for (const currency of RECO_PRICE_CEILING_KNOWN_CURRENCIES) {
    // 4500 is 'premium' under the dollar bands; only USD may actually say so.
    const tier = cardFor({ price: { amount: 4500, currency } }).price_tier;
    assert.equal(tier, currency === 'USD' ? 'premium' : 'mid', `${currency} banded as ${tier}`);
    checked += 1;
  }
  assert.equal(checked, 14, 'the per-currency loop did not run');
});

test('US dollar amounts are banded exactly as before', () => {
  assert.equal(cardFor({ price: { amount: 15, currency: 'USD' } }).price_tier, 'budget');
  assert.equal(cardFor({ price: { amount: 19.99, currency: 'USD' } }).price_tier, 'budget');
  assert.equal(cardFor({ price: { amount: 20, currency: 'USD' } }).price_tier, 'mid');
  assert.equal(cardFor({ price: { amount: 30, currency: 'USD' } }).price_tier, 'mid');
  assert.equal(cardFor({ price: { amount: 44.99, currency: 'USD' } }).price_tier, 'mid');
  assert.equal(cardFor({ price: { amount: 45, currency: 'USD' } }).price_tier, 'premium');
  assert.equal(cardFor({ price: { amount: 60, currency: 'USD' } }).price_tier, 'premium');

  // An undeclared currency is USD on this path -- normalizePrice already stamped it, and the serving
  // layer normalizes catalog prices to USD -- so it still bands.
  assert.equal(cardFor({ price: 15 }).price_tier, 'budget');
  assert.equal(cardFor({ price: { amount: 60 } }).price_tier, 'premium');
});

test('a tier the row DECLARES is still honoured, with or without a price', () => {
  // price_tier is a real independent signal, not only a derived one: the research lane emits
  // { name, price_tier } with no price at all, and so do the LLM candidate shapes. Withholding a
  // derived band must not turn into discarding a declared one.
  assert.equal(cardFor({ price_tier: 'premium' }).price_tier, 'premium');
  assert.equal(cardFor({ price_tier: 'budget' }).price_tier, 'budget');
  assert.equal(cardFor({ price: { amount: 4500, currency: 'JPY' }, price_tier: 'budget' }).price_tier, 'budget');
  // Including where it disagrees with a USD amount -- that precedence is pre-existing and deliberate.
  assert.equal(cardFor({ price: { amount: 200, currency: 'USD' }, price_tier: 'budget' }).price_tier, 'budget');
  // A token that is not a band is not a tier.
  assert.equal(cardFor({ price: { amount: 15, currency: 'USD' }, price_tier: 'cheap' }).price_tier, 'budget');
});

test('a card with no usable price still falls to the neutral band', () => {
  for (const price of [null, '', { amount: null }, { unknown: true }, -5]) {
    assert.equal(cardFor({ price }).price_tier, 'mid', `${JSON.stringify(price)}`);
  }
  assert.equal(cardFor({}).price_tier, 'mid');
});

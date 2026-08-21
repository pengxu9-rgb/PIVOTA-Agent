'use strict';

// One row, one price: the card and the prompt must READ text the same way, not only render it.
//
// #2069 gave the two surfaces a shared FORMATTER. It did not give them a shared READER, so they still
// disagreed about what a string price says. After #2074 taught the reco lane about decimal commas the
// gap was plain: '1,299' reached the model as 1299 while the card -- Number('1,299') is NaN -- said
// "Price unavailable" for the same product, and '$12.30' was a price to one surface and nothing to the
// other. Both now parse through src/auroraBff/priceAmountText.js.
//
// The rule this suite exists to hold: AMOUNT AND CURRENCY MOVE TOGETHER. Sharing only the number
// parser would be worse than sharing neither -- the card would read '£88' as 88 and then label it with
// the row's fallback currency, printing "$88" for a British price, which is the relabel #2065, #2069
// and #2076 each closed somewhere else. A price written as text carries its currency IN the text.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePriceAmount, inferCurrencyFromPriceText } = require('../src/auroraBff/priceAmountText');
const { normalizeRecommendationProductCard } = require('../src/auroraBff/chatCardFactory');
const { __internal } = require('../src/auroraBff/routes');

const cardFor = (price) => normalizeRecommendationProductCard({ name: 'P', brand: 'B', price });

test('a decimal comma is a decimal point, on the card as well as in the prompt', () => {
  // The defect this closes: every one of these was "Price unavailable" on the card.
  assert.equal(cardFor('1,299').price_label, '$1299');
  assert.equal(cardFor('35,30').price_label, '$35.30');
  assert.equal(cardFor('1,299.50').price_label, '$1299.50');
  assert.equal(cardFor('1.234.567,89').price_label, '$1234567.89');
  assert.equal(cardFor('19,99').price_label, '$19.99');
  assert.equal(cardFor('1 299').price_label, '$1299');
});

test('a currency written into the price text is read WITH the amount, never dropped', () => {
  // The trap: parse the number but not the currency, and '£88' becomes "$88".
  const gbp = cardFor('£88');
  assert.equal(gbp.price.currency, 'GBP');
  assert.equal(gbp.price_label, '£88');
  assert.notEqual(gbp.price_label, '$88');

  const eur = cardFor('€35,30');
  assert.equal(eur.price.currency, 'EUR');
  assert.equal(eur.price_label, '€35.30');

  assert.equal(cardFor('12,5 EUR').price.currency, 'EUR');
  assert.equal(cardFor('$12.30').price.currency, 'USD');
  assert.equal(cardFor('From $1,299.00').price_label, '$1299');

  // Precedence, where the text and a sibling field DISAGREE: the text wins, because it is the more
  // specific statement about this price. This mirrors the scalar leg of normalizePriceObject
  // (`inferredCurrency || normalizeCurrencyCode(fallbackCurrency)`), and it is the assertion that
  // decides whether '£88' beside a stale `currency: 'USD'` renders as "£88" or as "$88".
  const conflicted = normalizeRecommendationProductCard({ name: 'P', brand: 'B', price: '£88', currency: 'USD' });
  assert.equal(conflicted.price.currency, 'GBP', 'the currency in the price text must win');
  assert.equal(conflicted.price_label, '£88');
  assert.equal(
    __internal.normalizePriceObject('£88', { fallbackCurrency: 'USD' }).currency,
    'GBP',
    'and the prompt must agree with it',
  );

  // Where the text carries NO currency evidence, the sibling field is all there is, and it wins.
  assert.equal(normalizeRecommendationProductCard({ name: 'P', brand: 'B', price: 88, currency: 'GBP' }).price.currency, 'GBP');
  assert.equal(normalizeRecommendationProductCard({ name: 'P', brand: 'B', price: '88', currency: 'GBP' }).price.currency, 'GBP');
});

test('the card and the prompt resolve one price text to one currency and one amount', () => {
  const prompt = __internal.formatRecoAssistantPromptPriceLabel;
  const normalize = __internal.normalizePriceObject;
  const texts = ['1,299', '35,30', '1,299.50', '1.234.567,89', '19.99', '19,99', '$12.30',
    '£88', '€35,30', '12,5 EUR', 'From $1,299.00', '1 299', '19.99', '1.299'];
  let compared = 0;
  for (const text of texts) {
    const card = cardFor(text);
    const promptPrice = normalize(text, { fallbackCurrency: 'USD' });
    assert.ok(promptPrice, `prompt read nothing from ${text}`);
    assert.ok(card.price, `card read nothing from ${text}`);
    // They present differently on purpose (glyph vs code); the CURRENCY and the AMOUNT must match.
    assert.equal(card.price.currency, promptPrice.currency, `currency for ${text}`);
    assert.equal(card.price.amount, promptPrice.amount, `amount for ${text}`);
    assert.ok(prompt(text), `prompt produced no label for ${text}`);
    compared += 1;
  }
  assert.equal(compared, texts.length, 'the comparison loop did not run');
});

test('text that states no price still states none', () => {
  for (const text of ['', '   ', 'abc', 'call for pricing', '-', ',', '.']) {
    assert.equal(parsePriceAmount(text), null, JSON.stringify(text));
    assert.ok(!cardFor(text).price_label, `${JSON.stringify(text)} produced a label`);
  }
  // An overflow is not a price, and its digits must NOT be salvaged back into one.
  assert.equal(parsePriceAmount('1e999'), null);
  assert.notEqual(parsePriceAmount('1e999'), 1999);
});

test('a negative amount is not a price on either surface', () => {
  // It used to render: "$-5", and inferPriceTierFromAmount then called the product 'budget'.
  for (const amount of [-5, '-5', '-0.01']) {
    const card = cardFor(amount);
    assert.ok(!card.price_label || card.price_label === 'Price unavailable', `${amount} rendered`);
    assert.notEqual(card.price_tier, 'budget', `${amount} bought a budget tier`);
  }
  assert.equal(cardFor({ amount: -5, currency: 'USD' }).price_label, 'Price unavailable');
});

test('a declared zero stays a card decision, and is the only place the two lanes differ', () => {
  // Deliberate and documented: the reco lane calls 0 "no price"; the card states it. Pinned so the
  // difference stays a decision someone made rather than a drift someone introduces.
  assert.equal(cardFor(0).price_label, '$0');
  assert.equal(cardFor({ amount: 0, currency: 'USD' }).price_label, '$0');
  assert.equal(__internal.normalizePriceObject(0, { fallbackCurrency: 'USD' }), null);
});

test('the shared reader keeps amount and policy separate', () => {
  // parsePriceAmount reports what the text SAYS; refusing a zero or a negative is the caller's rule.
  assert.equal(parsePriceAmount('0'), 0);
  assert.equal(parsePriceAmount('-5'), -5);
  assert.equal(parsePriceAmount('19,99'), 19.99);
  assert.equal(parsePriceAmount(true), null, 'a boolean is not a dollar');
  assert.equal(parsePriceAmount(['19.99']), 19.99, 'a single-element list is an amount');
  assert.equal(inferCurrencyFromPriceText('£88'), 'GBP');
  assert.equal(inferCurrencyFromPriceText('88'), '', 'no evidence means no claim');
});

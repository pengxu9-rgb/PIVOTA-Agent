'use strict';

// A card must not contradict itself about what money it is quoting.
//
// formatPriceLabel (src/auroraBff/chatCardFactory.js) special-cased GBP/EUR/CNY and fell back to '$'
// for EVERY other currency, so normalizeRecommendationProductCard turned
// { amount: 4500, currency: 'JPY' } into price_label '$4500' on a card whose price.currency correctly
// read 'JPY'. Ten of the fourteen currencies the reco lane recognizes were rendered as US dollars:
// JPY, KRW, CHF, SEK, CAD, AUD, HKD, SGD, TWD, NZD. 4500 JPY is about 30 USD; '$4500' is not a
// rounding error, it is a different product.
//
// The string had always been wrong. What changed is that it became reachable: #2065 fixed the data
// layer so a declared non-USD currency survives to the card instead of being discarded and stamped
// USD, so the card can now carry a real currency next to a label that denies it.
//
// The two formatters had also drifted from each other -- the reco prompt's
// formatRecoAssistantPromptPriceLabel already emitted 'JPY 4500' for the same price the card called
// '$4500'. Both now render through src/auroraBff/priceLabelFormat.js.
//
// The rule these tests enforce is NEVER PRINT A SYMBOL WE ARE NOT SURE OF. A label may carry a symbol
// only where that glyph unambiguously belongs to the code; otherwise it states the bare ISO code. A
// code is honest. A wrong symbol restates the price in another country's money and the reader cannot
// tell. So "renders CAD 4500" is the assertion, not a placeholder for a nicer symbol later.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatDisplayPriceLabel,
  formatPromptPriceLabel,
  DISPLAY_PRICE_SYMBOLS,
  PROMPT_PRICE_SYMBOLS,
} = require('../src/auroraBff/priceLabelFormat');
const { normalizeRecommendationProductCard } = require('../src/auroraBff/chatCardFactory');
const { RECO_PRICE_CEILING_KNOWN_CURRENCIES } = require('../src/auroraBff/recoPriceCeiling');

// Every currency glyph this repo is willing to print, from whichever table. A label for a code that
// owns none of them must contain none of them -- that is the check the old '$' fallback failed.
const ALL_SYMBOLS = Array.from(
  new Set([...Object.values(DISPLAY_PRICE_SYMBOLS), ...Object.values(PROMPT_PRICE_SYMBOLS)]),
);

function cardLabelFor(price) {
  const card = normalizeRecommendationProductCard({ name: 'Test Product', brand: 'Test Brand', price });
  assert.ok(card, 'normalizeRecommendationProductCard returned nothing for a well-formed row');
  return card;
}

test('every currency the reco lane knows renders its own symbol or its own code, never another currency\'s symbol', () => {
  // Pinned so this loop cannot quietly become a no-op, and so a currency added to the ceiling
  // allowlist without a rendering decision fails here rather than shipping as '$'.
  assert.equal(RECO_PRICE_CEILING_KNOWN_CURRENCIES.length, 14);

  let checked = 0;
  for (const currency of RECO_PRICE_CEILING_KNOWN_CURRENCIES) {
    const card = cardLabelFor({ amount: 4500, currency });
    const label = card.price_label;

    // The card still agrees with itself: the currency it declares is the one it was given.
    assert.equal(card.price.currency, currency, `price.currency lost for ${currency}`);

    const symbol = DISPLAY_PRICE_SYMBOLS[currency];
    if (symbol) {
      assert.equal(label, `${symbol}4500`, `${currency} should render its own symbol`);
    } else {
      assert.equal(label, `${currency} 4500`, `${currency} has no certain symbol and must state its code`);
      for (const glyph of ALL_SYMBOLS) {
        assert.ok(
          !label.includes(glyph),
          `${currency} rendered the currency glyph ${glyph} it does not own: ${label}`,
        );
      }
    }

    // The wrong-symbol rule, stated directly: only USD may be a dollar sign.
    if (currency !== 'USD') {
      assert.ok(!label.startsWith('$'), `${currency} rendered as US dollars: ${label}`);
    }
    checked += 1;
  }
  assert.equal(checked, 14, 'the per-currency loop did not run for every known currency');
});

test('the ten currencies that used to render as US dollars', () => {
  // The exact regression, spelled out rather than derived, so a change to the table above cannot
  // silently restore any one of them to '$'.
  const expected = {
    JPY: '¥4500',
    KRW: '₩4500',
    CHF: 'CHF 4500',
    SEK: 'SEK 4500',
    CAD: 'CAD 4500',
    AUD: 'AUD 4500',
    HKD: 'HKD 4500',
    SGD: 'SGD 4500',
    TWD: 'TWD 4500',
    NZD: 'NZD 4500',
  };
  for (const [currency, label] of Object.entries(expected)) {
    assert.equal(cardLabelFor({ amount: 4500, currency }).price_label, label);
    assert.notEqual(cardLabelFor({ amount: 4500, currency }).price_label, '$4500');
  }
});

test('USD and the symbols that were already correct still render as symbols', () => {
  assert.equal(cardLabelFor({ amount: 4500, currency: 'USD' }).price_label, '$4500');
  assert.equal(cardLabelFor({ amount: 29.9, currency: 'USD' }).price_label, '$29.90');
  assert.equal(cardLabelFor({ amount: 4500, currency: 'EUR' }).price_label, '€4500');
  assert.equal(cardLabelFor({ amount: 4500, currency: 'GBP' }).price_label, '£4500');
  assert.equal(cardLabelFor({ amount: 4500, currency: 'CNY' }).price_label, '¥4500');
  // Not an ISO code, but the card formatter accepted it before and still does.
  assert.equal(formatDisplayPriceLabel(4500, 'RMB'), '¥4500');
});

test('an unknown or absent currency degrades to something honest', () => {
  // A well-formed code we hold no glyph for states itself. It must never borrow one.
  assert.equal(formatDisplayPriceLabel(4500, 'BRL'), 'BRL 4500');
  assert.equal(formatDisplayPriceLabel(4500, 'XYZ'), 'XYZ 4500');

  // No currency at all: the serving path normalizes catalog prices to USD, and normalizePrice already
  // stamps the card 'USD', so the label and the field agree on the same default.
  const noCurrency = cardLabelFor({ amount: 4500 });
  assert.equal(noCurrency.price.currency, 'USD');
  assert.equal(noCurrency.price_label, '$4500');

  // Junk that is not a three-letter code cannot reach the symbol table.
  for (const junk of ['', '   ', '!!', 'US DOLLARS', null, undefined, 42, {}]) {
    assert.equal(formatDisplayPriceLabel(4500, junk), '$4500', `junk currency ${JSON.stringify(junk)}`);
  }

  // Case and stray punctuation normalize rather than falling through to '$'.
  assert.equal(formatDisplayPriceLabel(4500, 'jpy'), '¥4500');
  assert.equal(formatDisplayPriceLabel(4500, ' jpy '), '¥4500');
  assert.equal(formatDisplayPriceLabel(4500, 'cad'), 'CAD 4500');
});

test('a price with no amount says so instead of quoting a number', () => {
  // Number(null), Number(''), Number(false) and Number([]) are each a finite 0, so a formatter that
  // reaches for Number() alone prints a confident '$0' for four different kinds of missing price.
  for (const amount of [null, undefined, '', '   ', false, true, [], {}, NaN, Infinity]) {
    assert.equal(formatDisplayPriceLabel(amount, 'USD'), '', `${JSON.stringify(amount)} is not an amount`);
    assert.equal(formatPromptPriceLabel(amount, 'JPY'), '', `${JSON.stringify(amount)} is not an amount`);
  }
  // A numeric string is an amount.
  assert.equal(formatDisplayPriceLabel('4500', 'JPY'), '¥4500');

  // The card's own policy for a price it cannot render is words, not a fabricated figure.
  assert.equal(cardLabelFor({ amount: null, currency: 'JPY' }).price_label, 'Price unavailable');
  assert.equal(cardLabelFor({ amount: 4500, currency: 'JPY', unknown: true }).price_label, 'Price unavailable');
});

test('amounts read as money', () => {
  assert.equal(formatDisplayPriceLabel(4500, 'JPY'), '¥4500', 'a whole amount stays whole');
  assert.equal(formatDisplayPriceLabel(12.5, 'USD'), '$12.50', 'a fractional amount gets both decimals');
  assert.equal(formatDisplayPriceLabel(4.62, 'USD'), '$4.62');
  assert.equal(formatDisplayPriceLabel(12.5, 'CAD'), 'CAD 12.50');
});

test('the card and the prompt never disagree about which currency a price is in', () => {
  const { __internal } = require('../src/auroraBff/routes');
  const formatPromptLabel = __internal.formatRecoAssistantPromptPriceLabel;
  assert.equal(typeof formatPromptLabel, 'function');

  for (const currency of RECO_PRICE_CEILING_KNOWN_CURRENCIES) {
    const price = { amount: 4500, currency };
    const cardLabel = cardLabelFor(price).price_label;
    const promptLabel = formatPromptLabel(price);

    // The prompt states every non-USD price as a bare code on purpose: it is read by a model with no
    // currency field beside it, and '¥' alone does not distinguish JPY from CNY.
    if (currency === 'USD') {
      assert.equal(promptLabel, '$4500');
      assert.equal(cardLabel, '$4500');
    } else {
      assert.equal(promptLabel, `${currency} 4500`);
      // Neither surface may claim US dollars for a price that is not in them.
      assert.ok(!promptLabel.startsWith('$'), `prompt rendered ${currency} as US dollars: ${promptLabel}`);
      assert.ok(!cardLabel.startsWith('$'), `card rendered ${currency} as US dollars: ${cardLabel}`);
    }

    // The one thing that must never drift: both labels resolve the SAME currency.
    const expectedGlyph = DISPLAY_PRICE_SYMBOLS[currency];
    const cardStatesCurrency = expectedGlyph ? cardLabel.startsWith(expectedGlyph) : cardLabel.startsWith(`${currency} `);
    assert.ok(cardStatesCurrency, `card label does not state ${currency}: ${cardLabel}`);
  }
});

test('an explicit price_label on the row still wins', () => {
  // Pre-existing precedence, pinned so the shared formatter cannot start overwriting a caller's label.
  const card = normalizeRecommendationProductCard({
    name: 'Test Product',
    brand: 'Test Brand',
    price: { amount: 4500, currency: 'JPY' },
    price_label: 'about 30 dollars',
  });
  assert.equal(card.price_label, 'about 30 dollars');
});

// A product with no price must not be advertised as free.
//
// Found by the suite above, and a distinct defect from the currency label. asNumber() reaches for
// Number() on anything that is not already a number, and Number(null), Number(''), Number(false) and
// Number([]) are each a finite 0. normalizePrice's `unknown` test keys on `amount == null`, so it only
// ever fired for `undefined` -- the one no-amount shape Number() maps to NaN. Every other shape
// produced { amount: 0, unknown: false }: price_label '$0' and price_tier 'budget', a free product
// invented out of a missing field, and one that then sorts to the top of any price-ascending view.
//
// This is the card-side twin of #2063, which closed the same fabrication on the prompt side.
test('a missing price is never rendered as a free product', () => {
  for (const amount of [null, '', '   ', false, []]) {
    const card = cardLabelFor({ amount, currency: 'JPY' });
    assert.equal(card.price.unknown, true, `amount ${JSON.stringify(amount)} should be unknown`);
    assert.equal(card.price.amount, null);
    assert.equal(card.price_label, 'Price unavailable');
    assert.notEqual(card.price_label, '¥0');
    // inferPriceTierFromAmount read the fabricated 0 and called the product 'budget'.
    assert.notEqual(card.price_tier, 'budget', `amount ${JSON.stringify(amount)} bought a budget tier`);
  }

  // A row whose price is literally null took the scalar path and conjured a whole USD price object --
  // { amount: 0, currency: 'USD' } assembled out of a field that said there was no price. The row's
  // own null now passes through (the card spreads the row), and no label is invented for it.
  const nullPrice = normalizeRecommendationProductCard({ name: 'Test Product', brand: 'Test Brand', price: null });
  assert.ok(!nullPrice.price, 'a null price must not become a price object');
  assert.equal(Object.prototype.hasOwnProperty.call(nullPrice, 'price_label'), false, 'no label for no price');
  assert.notEqual(nullPrice.price_tier, 'budget');

  // A declared zero is data, not absence, and still renders.
  const freeProduct = cardLabelFor({ amount: 0, currency: 'USD' });
  assert.equal(freeProduct.price_label, '$0');
  assert.equal(freeProduct.price.unknown, false);
});

// The invariant that makes the two "cannot render this" fallbacks unreachable.
//
// formatPriceLabel ends in `|| 'Price unavailable'` and formatRecoAssistantPromptPriceLabel ends in
// `|| null`. Neither fires today, because normalizePrice and normalizePriceObject each return either
// nothing, an explicitly unknown price, or a price whose amount is a finite number -- there is no
// fourth shape for a formatter to fail on. A mutant that deletes either fallback therefore survives.
// Rather than write a test that cannot fail, this pins the PRECONDITION those fallbacks rest on: if a
// normalizer ever starts emitting a priced-but-unrenderable object, this fails here and the guards
// become load-bearing again.
test('a priced card always carries an amount its formatter can render', () => {
  const amounts = [null, undefined, '', '   ', false, true, [], {}, NaN, Infinity, -Infinity,
    'abc', '12abc', '4500', ' 4500 ', 0, -5, 12.5, { amount: 5 }, { amount: 'x' }];
  const currencies = ['USD', 'JPY', 'CAD', null, 'zz', ''];

  let priced = 0;
  for (const amount of amounts) {
    for (const currency of currencies) {
      const card = cardLabelFor({ amount, currency });
      const price = card.price;
      if (!price || price.unknown === true) {
        // An unknown price says so in words and never quotes a figure.
        if (price) assert.equal(card.price_label, 'Price unavailable');
        continue;
      }
      priced += 1;
      assert.equal(typeof price.amount, 'number', `priced card carries a non-number: ${JSON.stringify(price)}`);
      assert.ok(Number.isFinite(price.amount), `priced card carries a non-finite amount: ${JSON.stringify(price)}`);
      assert.ok(card.price_label, `priced card produced an empty label: ${JSON.stringify(price)}`);
      assert.notEqual(card.price_label, 'Price unavailable', 'a card with a real amount must quote it');
    }
  }
  // Guards against the loop degenerating to all-unknown and asserting nothing.
  assert.ok(priced > 0, 'no priced card was exercised');
});

// A single-element list is a real amount, and the card must read it the way the prompt does.
//
// Both surfaces are fed by catalog and crawl rows, and those genuinely deliver `{ amount: ['19.99'] }`,
// `offers: [{ price: ['19.99'] }]` and `price_info: { price: ['19.99'] }`. toPositiveNumberOrNull
// (src/auroraBff/routes.js) accepts them on purpose and records that rejecting arrays there was
// MEASURED and "dropped every one of those to no price". A strict amount reader that refuses arrays
// looks safer and is not: it re-opens the card/prompt split from the other side, with the card saying
// "Price unavailable" for a row the prompt priced at EUR 19.99.
test('a single-element list is read as an amount, the same as the prompt reads it', () => {
  assert.equal(cardLabelFor({ amount: ['19.99'], currency: 'EUR' }).price_label, '€19.99');
  assert.equal(cardLabelFor({ amount: [19.99], currency: 'USD' }).price_label, '$19.99');
  assert.equal(normalizeRecommendationProductCard({ name: 'P', brand: 'B', price: ['19.99'] }).price_label, '$19.99');

  // Only a one-element list of a real amount. Number(['']), Number([null]) and Number([]) are each a
  // finite 0 -- the coercion the strict reader exists to refuse -- and Number(['19.99','20']) is NaN.
  for (const amount of [[], ['', ''], ['19.99', '20'], [''], [null], [false], ['abc']]) {
    const card = cardLabelFor({ amount, currency: 'EUR' });
    assert.equal(card.price.unknown, true, `${JSON.stringify(amount)} is not an amount`);
    assert.equal(card.price_label, 'Price unavailable');
  }
});

// The card's `price` field must never hold a raw row value.
//
// normalizeRecommendationProductCard spreads `...row` and then conditionally overrides `price`. While
// every malformed price still coerced to a (fabricated) zero object, the override always fired and
// nothing downstream could see a non-object. Once the reader started declining values, the raw one
// survived instead: `price: ['19.99']` shipped a card whose `price` was an ARRAY -- truthy, so a
// consumer's `card.price.amount` read undefined rather than throwing, and `price_label` was absent.
// The field goes out over the /v1 chat response, so its type is a wire contract.
test('the card price field is always a price object, an explicit null, or absent', () => {
  // A NON-object the reader declines resolves to an explicit null: there is no price object to carry,
  // and the raw value must not be left in its place.
  for (const raw of [null, '', '   ', false, true, 'abc', [], ['19.99', '20'], NaN]) {
    const card = normalizeRecommendationProductCard({ name: 'P', brand: 'B', price: raw });
    assert.equal(card.price, null, `a price of ${JSON.stringify(raw)} must resolve to an explicit null`);
    assert.equal(Object.prototype.hasOwnProperty.call(card, 'price_label'), false, 'no label for an unreadable price');
  }

  // A price-shaped OBJECT with no readable amount keeps its shape and says so, which is how the card
  // reports an unknown price rather than omitting the field.
  for (const raw of [{}, { amount: null }, { amount: '', currency: 'JPY' }]) {
    const card = normalizeRecommendationProductCard({ name: 'P', brand: 'B', price: raw });
    assert.equal(card.price.unknown, true, JSON.stringify(raw));
    assert.equal(card.price.amount, null);
    assert.equal(card.price_label, 'Price unavailable');
  }

  // A row that never mentioned a price keeps the key absent -- "no price here" is not the same
  // statement as "a price we could not read".
  const silent = normalizeRecommendationProductCard({ name: 'P', brand: 'B' });
  assert.equal(Object.prototype.hasOwnProperty.call(silent, 'price'), false);

  // A readable price always lands as an object carrying an amount.
  for (const raw of [19.99, '19.99', ['19.99'], { amount: 19.99, currency: 'JPY' }]) {
    const card = normalizeRecommendationProductCard({ name: 'P', brand: 'B', price: raw });
    assert.ok(card.price && typeof card.price === 'object' && !Array.isArray(card.price), JSON.stringify(raw));
    assert.ok('amount' in card.price, JSON.stringify(raw));
  }
});

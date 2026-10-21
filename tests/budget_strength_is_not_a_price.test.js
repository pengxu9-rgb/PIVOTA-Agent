'use strict';

// A strength, concentration or size next to a number is never a price -- with
// SEARCH_BUDGET_REQUIRE_MARKER on or off.
//
// Flag off, the parser fell back to the first number in the query, so "1.0% retinol serum" became a
// 1.00 max price and the ingredient lane's budget filter dropped every row. Flag on, the plain "N%"
// form was already safe, but a bound word before a full-width "％" ("niacinamide serum max 10％"), a
// range of strengths ("between 5 and 10％") or a multiplier ("under 2x") still became a cap.
//
// Queries with no strength/size number must parse exactly as before: the replay comparison in the PR
// pins that; the budgets below pin the cases that sit right next to a strength.

const { parseBudgetToPriceConstraint, extractIntentRuleBased } = require('../src/findProductsMulti/intent');

const FLAG = 'SEARCH_BUDGET_REQUIRE_MARKER';
let saved;
beforeEach(() => {
  saved = process.env[FLAG];
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

const max = (currency, value) => ({ currency, min: null, max: value });

const FLAG_STATES = [
  ['flag on', '1'],
  ['flag off', undefined],
];

// Never a budget, in either flag state.
const STRENGTHS = [
  '1.0% retinol serum',
  '2.0% salicylic acid',
  '10.0% niacinamide',
  '15.0% vitamin c',
  '1% retinol serum',
  '0.5% retinol',
  '10 % niacinamide',
  '10％ niacinamide',
  '10 ％ niacinamide',
  'niacinamide 10 percent serum',
  'under 1.0% retinol',
  'retinol under 1%',
  'niacinamide serum max 10％',
  'salicylic acid under 2％',
  'around 10％ niacinamide',
  '~10％ niacinamide',
  '<10％ niacinamide',
  '预算10％',
  '10％ or less niacinamide',
  '10%以下 niacinamide',
  'vitamin c serum 10-15%',
  '5％-10％ niacinamide',
  'between 5 and 10% niacinamide',
  'between 5 and 10％ niacinamide',
  'under 1 per cent retinol',
  'under 2 per cent',
  'under 2 per-cent',
  'niacinamide 10 pct serum',
  // a tight 〜 ～ 到 – — join and "between ... &" spread like - does
  '10〜15％ niacinamide',
  '10～15％ niacinamide',
  '10到15％ niacinamide',
  'between 5 & 10％ niacinamide',
  'vitamin c 10–15%',
  'vitamin c 10—15%',
  '2X serum',
  // sizes and strengths with no currency of their own
  '50ml toner',
  '30 ml serum',
  'under 50 ml',
  '1.7 oz cream',
  '1.7 fl oz cream',
  'under 5 oz',
  '500mg vitamin c',
  'max 50mg',
  'Laneige lip sleeping mask 20g',
  'under 30 g',
  '2x serum',
  'under 2x',
  '3x or less',
  'spf 50 sunscreen',
  'spf50 sunscreen',
  'spf 30-50 sunscreen',
  'under spf 30',
  'sunscreen 50 spf',
  '30-50ml toner',
  '30ml-50 toner',
  'under 1.5x',
];

// No budget with the flag on. A strength reaches across a spaced " - " / " to " / " and ", or two
// hops, only in these; flag off they keep main's legacy reading of the bare number next to the
// strength, because nothing spreads across a clause separator or further than one hop.
const FLAG_ON_STRENGTHS = [
  'vitamin c serum 10 to 15％',
  'price 5-10％',
  '10% to 20',
  '10% - 20 niacinamide',
  '1-2-3%',
  'around 5-10% niacinamide',
  'spf 30 and 50',
  'between spf 30 and 50',
  'spf 30 ~ 50',
  'sunscreen 50 pa+++',
];

// Real budgets sitting next to a strength or size.
const BUDGETS_NEXT_TO_STRENGTH = [
  ['under $30 1% retinol serum', max('USD', 30)],
  ['1% retinol serum under $20', max('USD', 20)],
  ['1.0% retinol serum under $20', max('USD', 20)],
  ['retinol 1% under 25', max(null, 25)],
  ['10％ niacinamide under 300元', max('CNY', 300)],
  ['niacinamide 10% under $8', max('USD', 8)],
  ['under $30 SPF 50 sunscreen', max('USD', 30)],
  ['30 dollar spf 50', max('USD', 30)],
  ['50ml toner under $15', max('USD', 15)],
  ['2x serum 20 bucks', max(null, 20)],
  // "and" joins a range only after "between": 30 is still the cap
  ['serum under 30 and 2% bha', max(null, 30)],
  ['budget: 30 and 2% bha', max(null, 30)],
  // a currency-marked end of a range is kept, even next to a strength
  ['niacinamide serum under $25 - 10% strength', max('USD', 25)],
  ['niacinamide 10% - 20 dollars', max('USD', 20)],
  // a number right after SPF is still a price when a currency word follows it
  ['sunscreen spf under 30 dollars', max('USD', 30)],
  // a currency code before the number keeps it, whatever unit follows
  ['usd 30 spf 50', max('USD', 30)],
  ['spf 30 and 50 dollars', max('USD', 50)],
  // review of #2485 (S1): an "x" that counts packs ("x 3", "x2") or sits before a word is not a
  // strength -- only an "x" glued to the number with no digit after it is ("2x", "1.5x")
  ['lip balm under 10 x 3', max(null, 10)],
  ['sheet masks under 20 x 10', max(null, 20)],
  ['under 15 x2 pack', max(null, 15)],
  ['under 20 x 2 pack', max(null, 20)],
  ['under 20 x2', max(null, 20)],
  ['around 30 x 2', { currency: null, min: 22.5, max: 37.5 }],
  ['under 30 x rhode', max(null, 30)],
  ['sunscreen under 30 x spf 50', max(null, 30)],
  ['under 20x2 pack', max(null, 20)],
  ['under 30x 2 pack', max(null, 30)],
  ['under 30xl hoodie', max(null, 30)],
  ['under 30 pa', max(null, 30)],
  ['serum under 30 - 10% niacinamide', max(null, 30)],
  // review r3 (B1): a currency range's unmarked far end shares the currency, so a strength or size
  // after it never collapses the range to its low end
  ['$20-40 - 10% niacinamide', { currency: 'USD', min: 20, max: 40 }],
  ['$20-40 – 50ml', { currency: 'USD', min: 20, max: 40 }],
  ['S$20-40 ~ 50ml', { currency: 'SGD', min: 20, max: 40 }],
  ['¥200-400 - 50ml', { currency: 'CNY', min: 200, max: 400 }],
  ['€20-40 to 2% bha', { currency: 'EUR', min: 20, max: 40 }],
  ['price $20-40 - 50ml', { currency: 'USD', min: 20, max: 40 }],
  ['under $20-40 - 50ml', { currency: 'USD', min: 20, max: 40 }],
  ['$20-40-10% niacinamide', { currency: 'USD', min: 20, max: 40 }],
  ['$20 - 40-50ml', { currency: 'USD', min: 20, max: 40 }],
  // (B2) a spread never runs through a range that is a budget
  ['price 20-40 - 10% niacinamide', { currency: null, min: 20, max: 40 }],
  ['price 20-40-50ml', { currency: null, min: 20, max: 40 }],
  ['50ml - 20-30 usd', { currency: 'USD', min: 20, max: 30 }],
  // (S1) a bound number before a spaced strength is a budget, whatever its size
  ['serum under 15 - 20% vitamin c', max(null, 15)],
  ['peel under 25 - 30% aha', max(null, 25)],
  ['under 10 - 10% niacinamide', max(null, 10)],
  ['under 30 - 100% silk', max(null, 30)],
  ['less than 20 - 30% off', max(null, 20)],
  ['under 5 - 10% off', max(null, 5)],
  ['max 30 to 100% silk', max(null, 30)],
  ['budget 30 to 100% silk', max(null, 30)],
  ['under 15-20% vitamin c', max(null, 15)],
  // (S2) a bound AFTER the number protects it too
  ['spf 50 - 30 or less', max(null, 30)],
  ['50ml ~ 30 or less', max(null, 30)],
  ['spf 50 ~ 300以内', max(null, 300)],
  ['50ml - 300以下', max(null, 300)],
  ['spf 50 - 300左右', { currency: null, min: 225, max: 375 }],
  ['spf 50 - 30 max', max(null, 30)],
  ['spf 50 - 30 and under', max(null, 30)],
  ['50ml ~30', max(null, 30)],
  ['10%-30 or less', max(null, 30)],
  ['spf 50+ $30', max('USD', 30)],
];

// Budgets with the flag on (= main). Flag off, main's legacy parser reads the spaced pair as a range
// and these keep that reading: a size never spreads across a clause separator, and a size range
// with a bare end is left whole.
const FLAG_ON_BUDGETS = [
  ['under 20 - 2x', max(null, 20)],
  ['under 30 - 50ml', max(null, 30)],
  ['under 25 – 50ml', max(null, 25)],
  ['under 25 — 50ml', max(null, 25)],
  ['under 30 ~ 50ml', max(null, 30)],
  ['under 30 to 50ml', max(null, 30)],
  ['serum between 20 and 40 - 10% niacinamide', { currency: null, min: 20, max: 40 }],
  ['between 20 and 40 - 50ml', { currency: null, min: 20, max: 40 }],
  ['between 20 and 40-50ml', { currency: null, min: 20, max: 40 }],
  ['spf 30-50 - 20-30 usd', { currency: 'USD', min: 20, max: 30 }],
  ['spf 30 ~ 50 - $15', max('USD', 15)],
];

// Plain budgets: unchanged.
const PLAIN_BUDGETS = [
  ['retinol serum under 30', max(null, 30)],
  ['serum under $30', max('USD', 30)],
  ['under 20 mlbb lipstick', max(null, 20)],
  ['under 40 gift set', max(null, 40)],
  ['under 30 xl hoodie', max(null, 30)],
  ['moisturizer under 30 pack of 2', max(null, 30)],
];

describe.each(FLAG_STATES)('%s', (_label, flagValue) => {
  beforeEach(() => {
    if (flagValue === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flagValue;
  });

  test.each(STRENGTHS)('"%s" -> no budget', (q) => {
    expect(parseBudgetToPriceConstraint(q)).toBeNull();
  });

  test.each(BUDGETS_NEXT_TO_STRENGTH)('"%s" keeps its budget', (q, expected) => {
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });

  test.each(PLAIN_BUDGETS)('plain budget "%s" is unchanged', (q, expected) => {
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });

  test('"spf 50+ sunscreen $30": the SPF "+" no longer turns the $30 into a floor', () => {
    expect(parseBudgetToPriceConstraint('spf 50+ sunscreen $30')).toEqual(max('USD', 30));
  });

  test('the intent the search SQL enforces carries no cap for "1.0% retinol serum"', () => {
    expect(extractIntentRuleBased('1.0% retinol serum', []).hard_constraints.price).toEqual({
      currency: null,
      min: null,
      max: null,
    });
  });

  test('a long run of strengths parses in bounded time', () => {
    const started = Date.now();
    parseBudgetToPriceConstraint('1% - '.repeat(20000));
    parseBudgetToPriceConstraint('between 1 and 2% '.repeat(20000));
    parseBudgetToPriceConstraint(`${'1-'.repeat(249)}1%`);
    parseBudgetToPriceConstraint(`${'$1-'.repeat(166)}1%`);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

test('flag off, a bare number with no unit still falls back to the legacy cap', () => {
  delete process.env[FLAG];
  expect(parseBudgetToPriceConstraint('retinol 0.5')).toEqual(max(null, 0.5));
  expect(parseBudgetToPriceConstraint('K18')).toEqual(max(null, 18));
});

test('flag on, a size with a soft-bound partner reads as main does: no budget', () => {
  // "around 30 - 50ml" / "about 5-10 ml": the soft bound's partner is kept, and the masked size after
  // the dash still counts as the digit it replaced, so countsThings refuses the 30 / 5.
  process.env[FLAG] = '1';
  expect(parseBudgetToPriceConstraint('around 30 - 50ml')).toBeNull();
  expect(parseBudgetToPriceConstraint('about 5-10 ml')).toBeNull();
  expect(parseBudgetToPriceConstraint('max 30 - 50ml')).toBeNull();
});

describe('flag on only', () => {
  beforeEach(() => {
    process.env[FLAG] = '1';
  });

  test.each(FLAG_ON_STRENGTHS)('"%s" -> no budget', (q) => {
    expect(parseBudgetToPriceConstraint(q)).toBeNull();
  });

  test.each(FLAG_ON_BUDGETS)('"%s" keeps its budget', (q, expected) => {
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });
});

// Every bound word the mask knows protects the number it marks from a tight strength join: the
// query parses exactly as its budget phrase alone. Flag off that holds for every entry. Flag on it
// holds for the hard bounds; after a soft bound ("around", "max", "budget", "~", "预算"...) main's
// countsThings already refuses a number followed by "-<digit>", so the query has no budget either way.
const BOUND_WORDS_BEFORE = [
  'under', 'below', 'less than', 'no more than', 'at most', 'up to', 'max', 'maximum', 'around', 'about',
  'approx', 'approximately', 'roughly', 'over', 'above', 'more than', 'at least', 'from', 'starting from',
  'starting at', 'budget', 'budget of', 'price', 'prices', 'priced', '<', '>', '≤', '≥', '~', '≈', '＜', '＞',
  '<=', '>=', '预算', '不超过', '至多', '最多', '至少', '不低于',
];
const SOFT_BOUND_WORDS = new Set([
  'max', 'maximum', 'around', 'about', 'approx', 'approximately', 'roughly', 'budget', 'budget of', '<', '~',
  '≈', '预算',
]);
const BOUND_WORDS_AFTER = [
  'or less', 'or under', 'or below', 'or more', 'or above', 'and under', 'and below', 'and up', 'and above',
  'and over', 'max', 'maximum', '以内', '以下', '以上', '左右', '起', '之间',
];
const afterPhrase = (word) => (/^[a-z]/.test(word) ? `30 ${word}` : `300${word}`);

describe.each(FLAG_STATES)('bound words, %s', (_label, flagValue) => {
  beforeEach(() => {
    if (flagValue === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flagValue;
  });

  test.each(BOUND_WORDS_BEFORE)('"serum %s 30-10%%" parses as "serum %s 30"', (word) => {
    const got = parseBudgetToPriceConstraint(`serum ${word} 30-10%`);
    if (flagValue !== undefined && SOFT_BOUND_WORDS.has(word)) expect(got).toBeNull();
    else expect(got).toEqual(parseBudgetToPriceConstraint(`serum ${word} 30`));
  });

  test.each(BOUND_WORDS_AFTER)('"serum 10%%-<n> %s" parses as "serum <n> %s"', (word) => {
    expect(parseBudgetToPriceConstraint(`serum 10%-${afterPhrase(word)}`)).toEqual(
      parseBudgetToPriceConstraint(`serum ${afterPhrase(word)}`),
    );
  });
});

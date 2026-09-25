'use strict';

// SEARCH_BUDGET_REQUIRE_MARKER (default OFF): a bare number in a query is never a budget.
//
// Measured on prod 2026-09-25 (gateway 91ecb2fe / 8d6c2108): parseBudgetToPriceConstraint fell back
// to the FIRST number in the query and treated it as a max budget, and since 113df702a that cap is
// enforced in the canonical SQL -- "K18" served 2 of its 29 rows (only the $12.60/$14 minis), and
// "retinol 0.5", "3CE lip tint", "niacinamide 10% serum" were capped at $0.50 / $3 / $10.

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
const on = () => {
  process.env[FLAG] = '1';
};
const off = () => {
  delete process.env[FLAG];
};

const max = (currency, value) => ({ currency, min: null, max: value });

// Numbers that are brand names, strengths, sizes, SPF or model numbers -- never a price.
const PHANTOMS = [
  'K18',
  'K18 hair mask',
  '3CE lip tint',
  'Olaplex No 3',
  'Olaplex No 4-5',
  'retinol 0.5',
  'niacinamide 10% serum',
  'vitamin c serum 15%',
  'Laneige lip sleeping mask 20g',
  'spf 50 sunscreen',
  'SPF 30 moisturizer',
  'spf 30-50 sunscreen',
  'Tower 28',
  '3-in-1 cleanser',
  'under 50ml travel shampoo',
  '20-40 ml',
  'retinol 10 and 20',
  // "SPF 50 and above sunscreen": 以上 is a bound word, but the number belongs to SPF
  'spf50以上的防晒霜',
  'SPF 50以上',
  // ages and durations after a bound word are not prices either
  'under 30 years old',
  'under 25 age skincare',
  'about 5 minutes',
  'spf 50+ sunscreen',
  'vitamin c serum 10-20%',
  'between 10 and 20% niacinamide',
  'price 10-20%',
  // re-review of #2275: soft markers (about / max / ~ / < / budget / or less) with no
  // currency also count things -- they must never bring the K18/3CE phantoms back
  'K18 max',
  'No7 max',
  'Olaplex No 3 max',
  'what about 3CE lip tint',
  'tell me about 2 serums',
  'apply about 2 drops',
  'approximately 10 products',
  'max 3 layers',
  'budget 2-in-1 shampoo',
  '~3 drops',
  'love this serum <3',
  '预算3步护肤',
  '2 or less ingredients',
  'serum 30~50',
  'spf 30 ~ 50',
  'spf about 30',
  '3刀片剃须刀',
  // a number must not backtrack out of a glued word: "about 111SKIN" is not "about 11"
  'tell me about 111SKIN',
  // third review: count nouns / classifiers after any marker
  'max 10 items',
  'about 20 reviews',
  '~50 reviews',
  'around 30s',
  'around 100k',
  'budget 10-step routine',
  '预算10个',
  'about 20 lipsticks', // a plural noun not on the count list
];

// Real budgets: identical with the flag on and off.
const BUDGETS = [
  ['serum under $30', max('USD', 30)],
  ['toner $25', max('USD', 25)],
  ['lipstick 20 dollars', max('USD', 20)],
  ['moisturizer under 40', max(null, 40)],
  ['sunscreen under 30 dollars', max('USD', 30)],
  ['cleanser at most 15', max(null, 15)],
  ['foundation 50 usd', max('USD', 50)],
  ['spf 50 under $25', max('USD', 25)],
  ['niacinamide 10% under $8', max('USD', 8)],
  ['price 20-40', { currency: null, min: 20, max: 40 }],
  ['30-50 dollars', { currency: 'USD', min: 30, max: 50 }],
  ['around $30', { currency: 'USD', min: 22.5, max: 37.5 }],
  ['300元以内', max('CNY', 300)],
  ['100元左右的面霜', { currency: 'CNY', min: 75, max: 125 }],
  ['200以上', { currency: null, min: 200, max: null }],
  ['50块', max(null, 50)],
  // Review of #2275: a size/SPF/"fl..." word AFTER a marked amount must not cancel it --
  // the unit check reads the text after the NUMBER, and only for an unmarked number.
  ['under $30 SPF 50 sunscreen', max('USD', 30)],
  ['300元以内 spf50', max('CNY', 300)],
  ['30 dollar spf 50', max('USD', 30)],
  ['under $30 fluid foundation', max('USD', 30)],
  ['under 40 floral perfume', max(null, 40)],
  ['under 20 mlbb lipstick', max(null, 20)],
  ["under 20 l'oreal serum", max(null, 20)],
  ['serum under 30 in pink', max(null, 30)],
  ['under $30 pa++++ sunscreen', max('USD', 30)],
  ['moisturizer under 30 pack of 2', max(null, 30)],
  // "and" is a range only after "between"
  ['retinol 1 and 2 under $40', max('USD', 40)],
  // unambiguous markers the bare-number fallback used to catch by accident
  ['max 40', max(null, 40)],
  ['30 max', max(null, 30)],
  ['budget 30', max(null, 30)],
  ['budget: 30', max(null, 30)],
  ['预算300', max(null, 300)],
  ['< 30', max(null, 30)],
  ['~30', max(null, 30)],
  ['around 30', { currency: null, min: 22.5, max: 37.5 }],
  ['30 or less', max(null, 30)],
  ['30 bucks', max(null, 30)],
  ['30刀', max(null, 30)],
  ['100-200块', { currency: null, min: 100, max: 200 }],
  ['20 to 30 bucks', { currency: null, min: 20, max: 30 }],
  ['100到200之间', { currency: null, min: 100, max: 200 }],
  // third review: "budget"/预算 are hard markers -- a product word after the number is fine
  ['预算300买面霜', max(null, 300)],
  ['预算300 面霜', max(null, 300)],
  ['budget 30 serum', max(null, 30)],
  ['budget 4.5', max(null, 4.5)],
  // ...and a singular product word after a soft marker is fine too
  ['max 40 serum', max(null, 40)],
  ['max 40 hydrating serum', max(null, 40)],
  ['around 30 moisturizer', { currency: null, min: 22.5, max: 37.5 }],
  ['< 30 cleanser', max(null, 30)],
  ['30 or less serum', max(null, 30)],
  ['around 30-40 serum', { currency: null, min: 30, max: 40 }],
  ['200刀以内', max(null, 200)],
  ['200刀以下的精华', max(null, 200)],
];

describe('flag OFF: byte-identical to the legacy parser (bug pinned, not fixed)', () => {
  test.each([
    ['K18', max(null, 18)],
    ['retinol 0.5', max(null, 0.5)],
    ['3CE lip tint', max(null, 3)],
    ['niacinamide 10% serum', max(null, 10)],
    ['serum 20-40', { currency: null, min: 20, max: 40 }],
    ['between 20 and 40', max(null, 20)],
    ['$20-$40 serum', max('USD', 20)],
  ])('%s', (q, expected) => {
    off();
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });

  test.each(BUDGETS)('real budget %s', (q, expected) => {
    off();
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });
});

describe('flag ON: a bare number is never a budget', () => {
  test.each(PHANTOMS)('%s -> no budget', (q) => {
    on();
    expect(parseBudgetToPriceConstraint(q)).toBeNull();
  });

  test.each(BUDGETS)('real budget %s is unchanged', (q, expected) => {
    on();
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });

  test.each([
    ['between 20 and 40', { currency: null, min: 20, max: 40 }],
    ['$20-$40 serum', { currency: 'USD', min: 20, max: 40 }],
    ['lipstick $15 to $25', { currency: 'USD', min: 15, max: 25 }],
  ])('range %s is read whole (was capped at the first number)', (q, expected) => {
    on();
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });

  test.each([
    ['spf 30-50 sunscreen under $20', max('USD', 20)],
    ['Olaplex No 4-5 under $30', max('USD', 30)],
    ['5-10 minute mask under $30', max('USD', 30)],
    ['20-40 ml under $30', max('USD', 30)],
    ['vitamin c 10-20% under $30', max('USD', 30)],
  ])('an unmarked range never overrides the real budget: %s', (q, expected) => {
    on();
    expect(parseBudgetToPriceConstraint(q)).toEqual(expected);
  });

  test.each([
    ['about', ' '.repeat(20000)],
    ['max', '\n'.repeat(20000) + 'x'],
    ['预算', ' '.repeat(20000)],
    ['budget of', ' '.repeat(20000)],
    ['between', ' '.repeat(50000) + 'x'],
    ['1 -', ' '.repeat(50000) + 'x'],
    ['under', ' '.repeat(50000) + 'x'],
    ['spf 1-2 ', 'spf 1-2 '.repeat(25000)],
  ])('a long whitespace run after "%s" parses in linear time', (head, tail) => {
    // re-review of #2275: chained optional \s* runs backtracked super-linearly ("about" +
    // 5,000 spaces took 29 s on the event loop).
    on();
    const started = Date.now();
    parseBudgetToPriceConstraint(`${head}${tail}`);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('an unmarked range is not a budget ("serum 20-40")', () => {
    on();
    expect(parseBudgetToPriceConstraint('serum 20-40')).toBeNull();
  });
});

describe('through the intent the search SQL enforces', () => {
  test('"K18" carries no price cap with the flag on, and still does with it off', () => {
    on();
    expect(extractIntentRuleBased('K18', []).hard_constraints.price).toEqual({ currency: null, min: null, max: null });
    off();
    expect(extractIntentRuleBased('K18', []).hard_constraints.price).toEqual(expect.objectContaining({ max: 18 }));
  });

  test('a real budget still reaches the intent with the flag on', () => {
    on();
    expect(extractIntentRuleBased('serum under $30', []).hard_constraints.price).toEqual(
      expect.objectContaining({ currency: 'USD', max: 30 }),
    );
  });
});

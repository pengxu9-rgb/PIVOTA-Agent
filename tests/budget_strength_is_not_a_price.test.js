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
  'vitamin c serum 10 to 15％',
  '5％-10％ niacinamide',
  'between 5 and 10% niacinamide',
  'between 5 and 10％ niacinamide',
  'price 5-10％',
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
  'sunscreen 50 pa+++',
  'spf 50 sunscreen',
  'spf50 sunscreen',
  'spf 30-50 sunscreen',
  'under spf 30',
  'sunscreen 50 spf',
  '30-50ml toner',
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
  // a currency-marked end of a range is kept, even next to a strength
  ['niacinamide serum under $25 - 10% strength', max('USD', 25)],
  ['niacinamide 10% - 20 dollars', max('USD', 20)],
  // a number right after SPF is still a price when a currency word follows it
  ['sunscreen spf under 30 dollars', max('USD', 30)],
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
    expect(Date.now() - started).toBeLessThan(250);
  });
});

test('flag off, a bare number with no unit still falls back to the legacy cap', () => {
  delete process.env[FLAG];
  expect(parseBudgetToPriceConstraint('retinol 0.5')).toEqual(max(null, 0.5));
  expect(parseBudgetToPriceConstraint('K18')).toEqual(max(null, 18));
});

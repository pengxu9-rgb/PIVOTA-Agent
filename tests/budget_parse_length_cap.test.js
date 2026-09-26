'use strict';

// parseBudgetToPriceConstraint reads only the first 500 characters of the query.
//
// Measured 2026-09-26 on main (91ecb2fe8): the range regex, the "N+" min-bound probe and the
// currency-suffix regex backtrack quadratically on a long run of digits. extractIntentRuleBased on
// 20k digits + "x" took 1.4 s and 50k digits took 8.6 s, all of it synchronous on the event loop,
// and nothing upstream bounds the query (express.json accepts 10mb). Every real query in 30 days of
// prod logs was at most 65 characters, so the cap changes no real parse.

const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');

const price = (q) => extractIntentRuleBased(q, [], []).hard_constraints.price;
const NO_BUDGET = { currency: null, min: null, max: null };

const elapsedMs = (fn) => {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};

// With the cap, each of these takes a few milliseconds; without it, 50k digits takes seconds
// (8.6 s locally), so a 250 ms ceiling is far from both.
const CEILING_MS = 250;
const N = 50000;

// One shape per super-linear regex: the range regex fails on the trailing "x", the "N+" probe on
// the missing "+", the currency suffix on the missing unit. Full-width digits are normalised to
// ASCII before matching, so they reach the same regexes.
const SLOW_SHAPES = {
  'ascii digits + x': '1'.repeat(N) + 'x',
  'ascii digits alone': '1'.repeat(N),
  'full-width digits + x': '１'.repeat(N) + 'x',
  'digits after a real budget': 'serum under $30 ' + '9'.repeat(N),
};

describe('budget parser: bounded time on a long run of digits', () => {
  test.each(Object.entries(SLOW_SHAPES))('%s parses under the ceiling', (_name, q) => {
    price('warm up the regexes'); // first-call compilation is not what this test measures
    expect(elapsedMs(() => price(q))).toBeLessThan(CEILING_MS);
  });
});

describe('budget parser: the cap is the only change', () => {
  test('a budget inside the first 500 characters is still read', () => {
    const q = 'a'.repeat(480) + ' under $30';
    expect(q.length).toBeLessThanOrEqual(500);
    expect(price(q)).toEqual({ currency: 'USD', min: null, max: 30 });
  });

  test('text past 500 characters is not read', () => {
    expect(price('a'.repeat(600) + ' under $30')).toEqual(NO_BUDGET);
  });

  test('a long query parses exactly as its first 500 characters do', () => {
    const head = 'moisturizer for dry skin, 20-40 dollars, ';
    const q = head.repeat(30);
    expect(q.length).toBeGreaterThan(500);
    expect(price(q)).toEqual(price(q.slice(0, 500)));
    expect(price(q)).toEqual({ currency: 'USD', min: 20, max: 40 });
  });

  test.each([
    ['serum under $30', { currency: 'USD', min: null, max: 30 }],
    ['toner $25', { currency: 'USD', min: null, max: 25 }],
    ['moisturizer for dry skin under 25', { currency: null, min: null, max: 25 }],
    ['300元以内', { currency: 'CNY', min: null, max: 300 }],
    ['100元左右的面霜', { currency: 'CNY', min: 75, max: 125 }],
    ['serum 30-50 dollars', { currency: 'USD', min: 30, max: 50 }],
    ['sunscreen', NO_BUDGET],
  ])('real-length query %j is unchanged', (q, expected) => {
    expect(price(q)).toEqual(expected);
  });
});

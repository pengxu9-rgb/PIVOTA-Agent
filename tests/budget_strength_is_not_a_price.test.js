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
  '1.7 fl. oz cream',
  '1.7fl.oz cream',
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
  // the age/count guard reads "spf-50" like "spf 50" (r5 sweep survivor Y05)
  'kids under 12 spf-50',
  // review r5 (B1): a soft bound or budget word before a strength range is no budget, as on main --
  // the masked strength still counts as the digit it replaced
  'around 5 - 10% niacinamide serum',
  'about 10 - 15% vitamin c serum',
  'max 10 - 20% aha',
  '~10 - 15% vitamin c',
  '< 10 - 20% glycolic',
  'budget 5 - 10% serum',
  '预算 5 - 10%精华',
  'about 5 - 10 ml',
  'about 30 - 50 ml toner',
  'budget 30 - 50ml',
  'around 30 - 50ml',
  'max 30 - 50ml',
  '预算 150 - 50 g',
  'my budget is 35 - 10%',
  'my budget is 35 - 200 mg serum',
  // (should-fix) an age or a count before "spf N" is no budget
  'sunscreen for women over 40 spf 50',
  'kids under 12 spf 50',
  'under 2 spf 30 baby sunscreen',
  'at least 2 spf 50 sunscreens',
  // a suffix currency on a number that has no marker word is no budget with the flag on
  'moins de 30€ 0.025% tretinoin',
  // r3 sweep survivor A07: a percentage is masked even right after a currency
  'usd 30% off serum',
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
  // review r4 (B1): every parser marker protects its number -- "range", "cost", "价格", "预算是",
  // "budget is", "budget:", "max is", "around:"
  ['price range 20-40-10% serum', { currency: null, min: 20, max: 40 }],
  ['价格200-300-50ml', { currency: null, min: 200, max: 300 }],
  ['预算是200-300-50ml', { currency: null, min: 200, max: 300 }],
  ['my budget is 35～10% serum', max(null, 35)],
  ['budget: 30～50ml', max(null, 30)],
  ['cost 20-40-2x serum', { currency: null, min: 20, max: 40 }],
  ['max is 30～10% serum', max(null, 30)],
  ['around: 20-40-50ml', { currency: null, min: 20, max: 40 }],
  ['price range 20-40 - 50ml', { currency: null, min: 20, max: 40 }],
  // (R2) a marker never crosses a spaced " - " / " ~ ": the tight strength range keeps its low end
  ['spf 50 - $40 - 2-4% serum', max('USD', 40)],
  ['toner spf 50～€20 - 50-100ml', max('EUR', 20)],
  ['$30 - 5-10% niacinamide', max('USD', 30)],
  ['under $40 - 2-4% bha', max('USD', 40)],
  ['€20 – 1-2% retinol', max('EUR', 20)],
  ['under $25 - 2x serum', max('USD', 25)],
  // ...and "20 to 40 dollars" is one budget range the parser reads, so it stays whole
  ['30 ml-20 to 40 dollars', { currency: 'USD', min: 20, max: 40 }],
  // a marker never travels into a strength range: "$15 to 5-10%" is the $15 and a 5-10% strength
  ['$15 to 5-10% serum', max('USD', 15)],
  ['$15-5-10% serum', max('USD', 15)],
  // r5 sweep survivors: every marked range is protected, not only the first (X04), a currency-word
  // range read high to low is not (X08), and a between-range's second end keeps a range of its own
  // (P06g)
  ['between 5 and 10％ niacinamide $20 - 40-10%', { currency: 'USD', min: 20, max: 40 }],
  ['price 5-10％ then $20 - 40-10%', { currency: 'USD', min: 20, max: 40 }],
  ['10%-30 - 20 usd', max('USD', 20)],
  ['between 5% and 10-20 dollars serum', { currency: 'USD', min: 10, max: 20 }],
  // (S2) a currency glued after a number is that number's, not the next one's
  ['under 40€ 50ml', max('EUR', 40)],
  ['under 30$ 50ml', max('USD', 30)],
  // (S4) the SPF in "30 spf 50" belongs to the 50
  ['under 30 spf 50', max(null, 30)],
  // a hard bound before a spaced size keeps its budget (the parser's bounded match counts nothing)
  ['under 30 - 50ml', max(null, 30)],
  // review r5 (B2): a spaced budget range the parser reads keeps both ends, whatever strength
  // follows its second end
  ['price 20 - 40-10% serum', { currency: null, min: 20, max: 40 }],
  ['$20 - 40-10% serum', { currency: 'USD', min: 20, max: 40 }],
  ['budget 20 - 40-50ml', { currency: null, min: 20, max: 40 }],
  ['预算 200 - 300-50ml', { currency: null, min: 200, max: 300 }],
  ['around 20 - 40-50ml', { currency: null, min: 20, max: 40 }],
  ['price 20 – 40–50ml', { currency: null, min: 20, max: 40 }],
  ['$20 - 40-50ml', { currency: 'USD', min: 20, max: 40 }],
  // ...but a "range" read high to low is the strength range's start, not a budget
  ['$30 - 5-10% niacinamide', max('USD', 30)],
  // (should-fix) every currency word the parser reads after an amount protects it
  ['10%-30 singapore dollars', max('SGD', 30)],
  ['10%-300日圆', max('JPY', 300)],
  ['10%-300新加坡元', max('SGD', 300)],
  // (should-fix) "spf-50" is the 50's SPF too
  ['under 30 spf-50', max(null, 30)],
  // r3 sweep survivors: a currency right before a size number keeps it a price (S05)
  ['toner under $30 ml', max('USD', 30)],
  // r4 sweep survivors: a currency CODE right before a size number keeps it a price (C02), and a
  // glued "to" is a range join too, sharing the currency (G13)
  ['toner under usd 30 ml', max('USD', 30)],
  ['$20to40-50ml', { currency: 'USD', min: 20, max: 40 }],
  // "between 5% and 10": the second end of a between-range keeps a currency or bound of its own
  ['between 5% and 10 dollars serum', max('USD', 10)],
  ['between 5% and 10 or less serum', max(null, 10)],
];

// Budgets with the flag on (= main). Flag off, main's legacy parser reads the spaced pair as a range
// and these keep that reading: a size never spreads across a clause separator, and a size range
// with a bare end is left whole.
const FLAG_ON_BUDGETS = [
  ['under 20 - 2x', max(null, 20)],
  ['under 25 – 50ml', max(null, 25)],
  ['under 25 — 50ml', max(null, 25)],
  ['under 30 ~ 50ml', max(null, 30)],
  ['under 30 to 50ml', max(null, 30)],
  ['serum between 20 and 40 - 10% niacinamide', { currency: null, min: 20, max: 40 }],
  ['between 20 and 40 - 50ml', { currency: null, min: 20, max: 40 }],
  ['between 20 and 40-50ml', { currency: null, min: 20, max: 40 }],
  ['spf 30-50 - 20-30 usd', { currency: 'USD', min: 20, max: 30 }],
  ['spf 30 ~ 50 - $15', max('USD', 15)],
  // (S4) the range is no longer refused for an "spf" that belongs to the next number
  ['$15-$30 spf 50', { currency: 'USD', min: 15, max: 30 }],
  ['300元 ~ 5 - 10% serum', max('CNY', 300)],
  // the age/count guard is narrow: a bare large number after "over" before "spf N" stays a budget,
  // as the same phrasing without spf does on main
  ['over 60 spf 50 pa++++', { currency: null, min: 60, max: null }],
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

test('flag on, a soft bound tight-joined to a size counts things, as before masking: no budget', () => {
  // "about 5-10 ml": the 5 is kept (bound), and the masked size right after the tight "-" still
  // counts as the digit it replaced, so countsThings refuses the 5 as main did.
  process.env[FLAG] = '1';
  expect(parseBudgetToPriceConstraint('about 5-10 ml')).toBeNull();
  expect(parseBudgetToPriceConstraint('around 30-50ml')).toBeNull();
});

describe('flag off: nothing spreads across a spaced join, and a bare number next to a strength stays legacy', () => {
  beforeEach(() => {
    delete process.env[FLAG];
  });
  // r3 sweep survivors G01-G03: the join must be tight on BOTH sides of the separator
  test.each(['serum 30 - 10% niacinamide', 'serum 30 -10% niacinamide', 'serum 30- 10% niacinamide'])(
    '"%s" keeps the 30',
    (q) => {
      expect(parseBudgetToPriceConstraint(q)).toEqual(max(null, 30));
    },
  );
  // r4 sweep survivors, all decided by what the flag-off fallback reads:
  // a currency glued after a number protects it from a tight strength join (C05)
  test('"niacinamide 10%-30€" keeps the 30€', () => {
    expect(parseBudgetToPriceConstraint('niacinamide 10%-30€')).toEqual(max('EUR', 30));
  });
  // "and" joins a range only after "between" (G18), and nothing spreads across "to" (P02)
  test.each([
    ['serum 20 and 10%', 20],
    ['10% to 20', 20],
    ['30ml to 50 toner', 30],
  ])('"%s" keeps its bare number', (q, value) => {
    expect(parseBudgetToPriceConstraint(q)).toEqual(max(null, value));
  });
  // a between-range spreads from either end (r4b sweep survivor P06)
  test('"between 5% and 10 serum" has no budget', () => {
    expect(parseBudgetToPriceConstraint('between 5% and 10 serum')).toBeNull();
  });
  // a size whose spaced partner stays bare is left whole, as main reads it (G15, R06)
  test('"toner 50ml - 30" reads as main does', () => {
    expect(parseBudgetToPriceConstraint('toner 50ml - 30')).toEqual(max(null, 50));
  });
  // ...in both directions: the bare end before the size restores it too (W7)
  test('"30 - 50ml toner" reads as main does', () => {
    expect(parseBudgetToPriceConstraint('30 - 50ml toner')).toEqual({ currency: null, min: 30, max: 50 });
  });
  // "spf-50" is the 50's SPF (r5 sweep survivor S03b)
  test('"serum spf-50" has no budget', () => {
    expect(parseBudgetToPriceConstraint('serum spf-50')).toBeNull();
  });
  // a size next to a protected budget range stays masked (r5 sweep survivor R10)
  test('"between 20 and 40-50ml" keeps the between budget, not the size range', () => {
    expect(parseBudgetToPriceConstraint('between 20 and 40-50ml')).toEqual(max(null, 20));
  });
  // "between" is not a budget marker of its own: "between 5-10%" is a strength range (r5b sweep survivor I08)
  test.each(['between 5-10% serum', 'between 5–10％ serum'])('"%s" has no budget', (q) => {
    expect(parseBudgetToPriceConstraint(q)).toBeNull();
  });
  // "between" needs no space before the number (M7)
  test.each(['between5 and 10% serum', 'between5% and 10 serum'])('"%s" has no budget', (q) => {
    expect(parseBudgetToPriceConstraint(q)).toBeNull();
  });
  // one hop only: in "1-2-3%" the 2 is the 3%'s partner, the 1 is not
  test('"vitamin c 1-2-3%" keeps the legacy 1', () => {
    expect(parseBudgetToPriceConstraint('vitamin c 1-2-3%')).toEqual(max(null, 1));
  });
  // r3 sweep survivor A05: "percentile" is not "percent"
  test('"top 5 percentile serum" is not masked', () => {
    expect(parseBudgetToPriceConstraint('top 5 percentile serum')).toEqual(max(null, 5));
  });
  test('"moins de 30€ 0.025% tretinoin" keeps the 30€, not the strength', () => {
    expect(parseBudgetToPriceConstraint('moins de 30€ 0.025% tretinoin')).toEqual(max('EUR', 30));
  });
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

'use strict';

// Every budget marker the parser reads is also a bound word for the strength mask, so a strength
// tight-joined to a budget can never swallow it (review r4 of #2485, B1: "price range 20-40-10%",
// "预算是200-300-50ml", "my budget is 35～10%" lost their budgets because the mask's list was a
// hand-copied subset). Both sides are built from the same source strings in intent.js; this test
// fails if anyone splits them again. Each example below is first checked against the PARSER regex
// it belongs to (so the example really is a parser marker), then against the mask.

const { __budgetMarkerVocabulary: V } = require('../src/findProductsMulti/intent');

const BOUNDED = [
  '以内', '以下', '不超过', '至多', '最多', 'at most', 'up to', 'under', '<=', '＜=', '≤', 'less than', 'below', '以上',
  '至少', '不低于', '>=', '＞=', '≥', 'over', 'above', 'more than', 'at least', 'from', 'starting from', 'starting at',
];
const BUDGET_WORDS = [
  'budget', 'budget of', 'budget is', 'budget:', 'budget of is', 'max budget', 'maximum budget', 'max budget of',
  '预算', '预算是', '预算在', '预算大概', '预算大约',
];
const SOFT = ['max', 'maximum', 'around', 'about', 'approx', 'approximately', 'roughly'].flatMap((w) => [
  w,
  `${w} is`,
  `${w}:`,
]).concat(['<', '~', '≈']);
const RANGE_WORDS = ['price', 'priced', 'budget', 'range', 'spend', 'cost', 'around', 'about', 'approx', 'approximately', 'roughly']
  .flatMap((w) => ['', ' of', ' is', ' in', ':'].map((c) => `${w}${c}`))
  .concat(['预算', '价格', '价位'].flatMap((w) => ['', '在', '是', ':'].map((c) => `${w}${c}`)))
  .concat(['price range']);
const POSTFIX = ['bucks', 'quid', 'or less', 'or under', 'and under', 'and below', 'max'];
const CJK_POSTFIX = ['', '元', '块钱', '块', '美元', '美金', '日元', '円', '刀'].flatMap((c) =>
  ['以内', '以下', '以上', '左右', '起'].map((w) => `${c}${w}`),
);

describe('a parser marker before a number is a mask bound word', () => {
  test.each(BOUNDED)('bounded "%s"', (w) => {
    expect(V.BOUNDED_AMOUNT_RE.test(`${w} 30`)).toBe(true);
    expect(V.BOUND_WORD_BEFORE_RE.test(`serum ${w} `)).toBe(true);
  });
  test.each(BUDGET_WORDS)('budget word "%s"', (w) => {
    expect(V.BUDGET_WORD_AMOUNT_RE.test(`my ${w} 30`)).toBe(true);
    expect(V.BOUND_WORD_BEFORE_RE.test(`my ${w} `)).toBe(true);
  });
  test.each(SOFT)('soft bound "%s"', (w) => {
    expect(V.SOFT_BOUND_AMOUNT_RE.test(`serum ${w} 30`)).toBe(true);
    expect(V.BOUND_WORD_BEFORE_RE.test(`serum ${w} `)).toBe(true);
  });
  test.each(RANGE_WORDS)('range price word "%s"', (w) => {
    expect(V.RANGE_PRICE_WORD_BEFORE_RE.test(`serum ${w} `)).toBe(true);
    expect(V.BOUND_WORD_BEFORE_RE.test(`serum ${w} `)).toBe(true);
  });
});

describe('a parser marker after a number is a mask bound word', () => {
  test.each(POSTFIX)('postfix "%s"', (w) => {
    expect(V.POSTFIX_BOUND_RE.test(`serum 30 ${w}`)).toBe(true);
    expect(V.BOUND_WORD_AFTER_RE.test(` ${w} serum`)).toBe(true);
  });
  test.each(CJK_POSTFIX)('CJK postfix "%s"', (w) => {
    expect(V.CJK_POSTFIX_BOUND_RE.test(`面霜300${w}`)).toBe(true);
    expect(V.BOUND_WORD_AFTER_RE.test(`${w}的面霜`)).toBe(true);
  });
  test('range suffix 之间', () => {
    expect(V.RANGE_BOUND_SUFFIX_RE.test('之间的面霜')).toBe(true);
    expect(V.BOUND_WORD_AFTER_RE.test('之间的面霜')).toBe(true);
  });
});

test('a symbol right after a number is a range separator, not a bound (as in the parser)', () => {
  expect(V.SOFT_BOUND_AMOUNT_RE.exec('spf 30 ~ 50')).toBeNull();
  expect(V.BOUND_WORD_BEFORE_RE.test('spf 30 ~ ')).toBe(false);
  expect(V.BOUND_WORD_BEFORE_RE.test('50ml ~')).toBe(true);
});

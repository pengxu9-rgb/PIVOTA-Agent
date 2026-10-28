'use strict';

// The budget x strength grid (scripts/budget-strength-grid.cjs, tests/fixtures/budget_strength_grid.json).
//
// GRID: 232 budget phrases -- the parser's full marker vocabulary (bound words, "budget"/预算 words with
// their connectors, soft bounds, range price words, postfix and CJK bounds, every currency word it
// reads), plus spaced budget ranges ("price 20 - 40", "$20 - 40", "预算 200 - 300") -- x 29 strength/
// size phrases x 3 products x 12 arrangements = 242,208 queries. Each query's expected parse is its
// budget phrase's parse alone, pinned from main's parser; the fixture also pins where main already
// missed it. No query may regress -- miss the expectation where main met it -- in either flag state.
//
// SWEEP: 38 soft-bound / budget / bound words x 16 strength and size RANGES, spaced and tight (5 - 10%,
// 5-10%, 5 ~ 10%, 30 - 50 ml, 100 - 200 mg, ...) x 3 products x 4 arrangements = 7,296 queries,
// expected to parse exactly as main parses the whole query. The mask may remove a budget main read
// from a strength range; it must never add one. With the marker on it must change nothing else.

const crypto = require('crypto');
const fs = require('fs');
const { parseBudgetToPriceConstraint } = require('../src/findProductsMulti/intent');
const {
  buildGrid,
  buildSweep,
  evaluateGrid,
  evaluateSweep,
  budgetPhraseDrift,
  decodeIndices,
  FIXTURE,
} = require('../scripts/budget-strength-grid.cjs');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The pinned "main already missed" sets and main's sweep parses. Pinned here too, so the fixture
// cannot be edited to hide a regression: re-pinning means updating these deliberately.
const PINS = {
  marker_on: { count: 18123, sha256: 'f6d544ea0187e50daf58321cf95f99000045a8d2d0dec773859217f4d34f400a' },
  marker_off: { count: 84792, sha256: '3ab47820d83004552f82167d3c6f2f66134c9376a63bd0f0f588868e66a2e9d3' },
  sweep_marker_on: 'abf00fea14b12f0949fe1378c14ce553ba9a0f684b7f752f62ff7926db16002b',
  sweep_marker_off: '77e498ea9c6832568101fb2bb817afaa1a387188fb246635b8f1f05bbd241ee8',
};

test('the grid is 232 budgets x 29 strengths x 3 products x 12 arrangements, the sweep 38 x 16 x 3 x 4', () => {
  expect([fixture.budgets.length, fixture.strengths.length, fixture.products.length, fixture.arrangements.length])
    .toEqual([232, 29, 3, 12]);
  expect(buildGrid(fixture)).toHaveLength(242208);
  const s = fixture.sweep;
  expect([s.words.length, s.ranges.length, s.products.length, s.arrangements.length]).toEqual([38, 16, 3, 4]);
  expect(buildSweep(fixture)).toHaveLength(7296);
});

describe.each(['marker_on', 'marker_off'])('%s', (state) => {
  test('the pinned "main already missed" set and main\'s sweep parses are the reviewed ones', () => {
    const indices = decodeIndices(fixture.pins[state].pinned_wrong);
    expect(indices).toHaveLength(PINS[state].count);
    expect(sha(indices)).toBe(PINS[state].sha256);
    expect(sha(fixture.pins[`sweep_${state}`])).toBe(PINS[`sweep_${state}`]);
  });

  test('each budget phrase alone still parses as pinned (re-pin deliberately if main changes it)', () => {
    expect(budgetPhraseDrift(fixture, parseBudgetToPriceConstraint, state)).toEqual([]);
  });

  test('no grid query loses or changes a budget that main kept', () => {
    const result = evaluateGrid(fixture, parseBudgetToPriceConstraint, state);
    expect(result.regressions.slice(0, 10)).toEqual([]);
    expect(result.regressions).toHaveLength(0);
    // and the change is a net fix, not a reshuffle
    expect(result.fixes.length).toBeGreaterThan(0);
  });

  test('the sweep never adds a budget main did not read', () => {
    const result = evaluateSweep(fixture, parseBudgetToPriceConstraint, state);
    expect(result.phantomsAdded.slice(0, 10)).toEqual([]);
    expect(result.phantomsAdded).toHaveLength(0);
  });
});

test('marker on: the sweep reads exactly as main, apart from strength-range phantoms it removes', () => {
  const result = evaluateSweep(fixture, parseBudgetToPriceConstraint, 'marker_on');
  expect(result.changed.slice(0, 10)).toEqual([]);
  expect(result.changed).toHaveLength(0);
  expect(result.same + result.phantomsRemoved.length).toBe(result.total);
});

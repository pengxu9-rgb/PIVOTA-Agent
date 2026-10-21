'use strict';

// The budget x strength grid (scripts/budget-strength-grid.cjs, tests/fixtures/budget_strength_grid.json):
// 204 budget phrases -- the parser's full marker vocabulary: bound words, "budget"/预算 words with their
// connectors, soft bounds, range price words, postfix and CJK bounds -- x 29 strength/size phrases x
// 3 products x 12 arrangements = 212,976 queries. Each query's expected parse is its budget phrase's
// parse alone, pinned from main's parser; the fixture also pins where main already missed it. No
// query may regress -- miss the expectation where main met it -- in either flag state. The full
// grid parses in about a second per state, so CI runs all of it.

const crypto = require('crypto');
const fs = require('fs');
const { parseBudgetToPriceConstraint } = require('../src/findProductsMulti/intent');
const {
  buildGrid,
  evaluateGrid,
  budgetPhraseDrift,
  decodeIndices,
  FIXTURE,
} = require('../scripts/budget-strength-grid.cjs');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// The pinned "main already missed these" sets. Pinned here too, so the fixture cannot be widened to
// hide a regression: re-pinning means updating these deliberately.
const PINNED_WRONG = {
  marker_on: { count: 17124, sha256: '43613a0b53e6f7677a45ae8643d763101b553df9929ee907dc566f0702ffb64f' },
  marker_off: { count: 80577, sha256: '7b89a26308a06a25411e151d8379980cab33d93bd73ffcce449e5b3547044abd' },
};

test('the grid is 204 budgets x 29 strengths x 3 products x 12 arrangements', () => {
  expect([fixture.budgets.length, fixture.strengths.length, fixture.products.length, fixture.arrangements.length])
    .toEqual([204, 29, 3, 12]);
  expect(buildGrid(fixture)).toHaveLength(212976);
});

describe.each(['marker_on', 'marker_off'])('%s', (state) => {
  test('the pinned "main already missed" set is the reviewed one', () => {
    const indices = decodeIndices(fixture.pins[state].pinned_wrong);
    expect(indices).toHaveLength(PINNED_WRONG[state].count);
    expect(crypto.createHash('sha256').update(JSON.stringify(indices)).digest('hex')).toBe(
      PINNED_WRONG[state].sha256,
    );
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
});

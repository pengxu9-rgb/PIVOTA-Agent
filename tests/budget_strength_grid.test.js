'use strict';

// The budget x strength grid (scripts/budget-strength-grid.cjs, tests/fixtures/budget_strength_grid.json):
// 37 budget phrases x 29 strength/size phrases x 3 products x 12 arrangements = 38,628 queries. Each
// query's expected parse is its budget phrase's parse alone, pinned from main's parser; the fixture
// also pins where main already missed it. No query may regress -- miss the expectation where main
// met it -- in either flag state. The full grid parses in well under a second, so CI runs all of it.

const fs = require('fs');
const { parseBudgetToPriceConstraint } = require('../src/findProductsMulti/intent');
const { buildGrid, evaluateGrid, budgetPhraseDrift, FIXTURE } = require('../scripts/budget-strength-grid.cjs');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('the grid is the specified 37 x 29 x 3 x 12', () => {
  expect([fixture.budgets.length, fixture.strengths.length, fixture.products.length, fixture.arrangements.length])
    .toEqual([37, 29, 3, 12]);
  expect(buildGrid(fixture)).toHaveLength(38628);
});

describe.each(['marker_on', 'marker_off'])('%s', (state) => {
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

'use strict';

// Search acceptance set -- see tests/acceptance/cases.json `_about` and
// search_acceptance_harness.cjs for what this layer does and does not prove.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const h = require('./search_acceptance_harness.cjs');

const cases = h.loadCases();
const rows = h.loadRows();

test('every case is well-formed, and every known failure says why and what tracks it', () => {
  const ids = new Set();
  for (const c of cases.cases) {
    assert.ok(c.id && !ids.has(c.id), `duplicate or missing id: ${c.id}`);
    ids.add(c.id);
    assert.ok(typeof c.query === 'string' && c.query.trim(), `${c.id}: query`);
    assert.ok(['pass', 'known_fail'].includes(c.status), `${c.id}: status must be pass or known_fail`);
    if (c.status === 'known_fail') {
      assert.ok(c.reason && c.reason.trim(), `${c.id}: a known failure needs a reason`);
      assert.ok(c.tracked_by && c.tracked_by.trim(), `${c.id}: a known failure needs tracked_by`);
    }
    if (c.expect && /target/.test(c.expect.kind)) {
      assert.ok(rows.some((r) => String(r.product_id) === c.expect.target), `${c.id}: target ${c.expect.target} is not in the fixture`);
    }
  }
});

for (const c of cases.cases) {
  test(`[${c.group}] ${c.id}: ${JSON.stringify(c.query)} -> ${c.status}`, () => {
    const { pass, detail } = h.evaluateCase(c, rows);
    if (c.status === 'pass') {
      assert.ok(pass, `REGRESSION: ${c.id} used to pass. ${JSON.stringify(detail)}`);
    } else {
      assert.ok(
        !pass,
        `${c.id} NOW PASSES. Promote it to "status": "pass" in tests/acceptance/cases.json in this change ` +
          `(and drop reason/tracked_by), so the improvement is recorded. Was: ${c.reason}`,
      );
    }
  });
}

test('no-deletion ratchet: no query serves fewer fixture rows than the baseline', () => {
  const baseline = JSON.parse(fs.readFileSync(h.BASELINE_PATH, 'utf8'));
  const diff = h.compareToBaseline(baseline.eligible, h.computeEligibleSets(cases, rows));
  assert.deepEqual(diff.missingQueries, [], 'baseline queries no longer in cases.json -- regenerate the baseline');
  assert.deepEqual(diff.untracked, [], 'queries not in the baseline -- run scripts/acceptance/update_eligible_baseline.cjs');
  assert.deepEqual(
    diff.removals,
    [],
    `${diff.removals.length} previously served row(s) removed. If intended, regenerate with ` +
      '--approve-removals "<reason>".',
  );
});

test('the ratchet comparison detects a removal, an addition and an untracked query', () => {
  // CONTROL for the test above: an empty diff must mean "nothing changed", not "the
  // comparison cannot see changes".
  const diff = h.compareToBaseline(
    { 'SG|a': ['1', '2'], 'SG|gone': ['9'] },
    { 'SG|a': ['2', '3'], 'SG|new': ['4'] },
  );
  assert.deepEqual(diff.removals, [{ query: 'SG|a', product_id: '1' }]);
  assert.deepEqual(diff.additions, [{ query: 'SG|a', product_id: '3' }]);
  assert.deepEqual(diff.missingQueries, ['SG|gone']);
  assert.deepEqual(diff.untracked, ['SG|new']);
});

test('a safe-empty contract serves nothing, even though the gate function admits every row', () => {
  // The harness's own premise. Without it, every ambiguous query would score as a pass.
  const { safeEmpty, eligible } = h.evaluateQuery('IPSA Time Reset Aqua', 'SG', rows);
  assert.equal(safeEmpty, true);
  assert.equal(eligible.length, 0);
  const served = h.evaluateQuery('cleanser', 'SG', rows);
  assert.equal(served.safeEmpty, false);
  assert.ok(served.eligible.length > 0, 'CONTROL: a classified query serves rows');
});

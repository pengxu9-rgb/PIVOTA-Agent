#!/usr/bin/env node
'use strict';

// Regenerates tests/acceptance/fixtures/eligible_baseline.json: for every acceptance and
// ratchet query, the fixture rows the gate currently SERVES.
//
// The baseline is a no-deletion ratchet. Additions are recorded freely. A REMOVAL -- a row
// served before and not now -- is refused unless named on the command line with a reason:
//
//   node scripts/acceptance/update_eligible_baseline.cjs
//   node scripts/acceptance/update_eligible_baseline.cjs --approve-removals "why these rows should no longer be served"
//
// Untracking a query counts as removing every row it protected.
// The reason is appended to the baseline's `approved_removals` log with the removed rows,
// so a deliberate tightening is visible in review and an accidental one cannot be
// regenerated away.

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const fs = require('fs');
const h = require('../../tests/acceptance/search_acceptance_harness.cjs');

function main(argv, { baselinePath = h.BASELINE_PATH, log = console.log, error = console.error } = {}) {
  const flag = argv.indexOf('--approve-removals');
  const reason = flag >= 0 ? String(argv[flag + 1] || '').trim() : '';
  if (flag >= 0 && !reason) {
    error('update_eligible_baseline: --approve-removals needs a reason');
    return 2;
  }

  const current = h.computeEligibleSets();
  const previous = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  const removalLog = (previous && previous.approved_removals) || [];

  if (previous) {
    const diff = h.compareToBaseline(previous.eligible, current);
    if (diff.removals.length && !reason) {
      error(`update_eligible_baseline: REFUSED -- ${diff.removals.length} previously served row(s) would be removed:`);
      for (const r of diff.removals.slice(0, 40)) error(`  ${r.query}  ${r.product_id}`);
      error('Re-run with --approve-removals "<reason>" if that is intended.');
      return 1;
    }
    if (diff.removals.length) {
      removalLog.push({ at: new Date().toISOString(), reason, removals: diff.removals });
    }
    log(`additions: ${diff.additions.length}, removals: ${diff.removals.length}, dropped queries: ${diff.missingQueries.length}, new queries: ${diff.untracked.length}`);
  }

  const doc = {
    _about: 'No-deletion ratchet for tests/acceptance. Regenerate only with scripts/acceptance/update_eligible_baseline.cjs.',
    approved_removals: removalLog,
    eligible: current,
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 1)}\n`);
  log(`wrote ${Object.keys(current).length} queries to ${baselinePath}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };

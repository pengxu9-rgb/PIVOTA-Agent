'use strict';

// Guards the two properties that make the weekly identity catch-up safe to run
// unattended. Both are about the SAME hazard, approached from opposite ends.
//
// THE HAZARD (measured in prod 2026-07-30): `liveReadEnabled` computes to
// `PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE && !reviewRequired && eligible`, and
// that env flag is UNSET in production — so every listing the builder produces
// carries `live_read_enabled: false`. The writer's ON CONFLICT arm used to
// take `EXCLUDED.live_read_enabled`, so one blanket apply would have written
// false over all 7,604 existing listings and demoted the entire live public
// surface (5,429 rows) to shadow. Same failure class as the relationship-graph
// upsert that reverted 203 human labels.
//
// Defence 1 (selection): --only-uncovered adds a NOT EXISTS so the run cannot
//   reach the ON CONFLICT branch at all.
// Defence 2 (writer): the ON CONFLICT arm preserves the stored value, so even
//   a blanket run cannot revert an operator's live-read decision.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { _internals } = require('../src/services/pdpIdentityGraph');
const { fetchBackfillProducts } = _internals;

const GRAPH_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'pdpIdentityGraph.js'),
  'utf8',
);

function capture() {
  const seen = [];
  const queryFn = async (sql) => {
    seen.push(String(sql));
    return { rows: [] };
  };
  return { seen, queryFn };
}

test('only-uncovered adds the NOT EXISTS guard to the external-seed lane', async () => {
  const { seen, queryFn } = capture();
  await fetchBackfillProducts({ onlyUncovered: true, queryFn });
  const seedSql = seen.find((s) => s.includes('external_product_seeds'));
  assert.ok(seedSql, 'external-seed lane did not run');
  assert.match(seedSql, /NOT EXISTS/);
  assert.match(seedSql, /pdp_identity_listing/);
  assert.match(seedSql, /pil\.product_id = e\.external_product_id/);
});

test('the guard is OFF by default — an explicit opt-in, not a silent filter', async () => {
  const { seen, queryFn } = capture();
  await fetchBackfillProducts({ queryFn });
  const seedSql = seen.find((s) => s.includes('external_product_seeds'));
  assert.ok(seedSql);
  assert.ok(
    !/NOT EXISTS\s*\(\s*SELECT 1 FROM pdp_identity_listing/.test(seedSql),
    'default mode must still scan all active seeds',
  );
});

test('the ON CONFLICT arm PRESERVES live_read_enabled, never takes EXCLUDED', () => {
  // Structural, because the alternative is a prod-only failure: taking
  // EXCLUDED here writes the recomputed default (false, flag unset) over an
  // operator-enabled row.
  assert.ok(
    GRAPH_SRC.includes('live_read_enabled = pdp_identity_listing.live_read_enabled'),
    'the upsert must preserve the stored live_read_enabled',
  );
  assert.ok(
    !GRAPH_SRC.includes('live_read_enabled = EXCLUDED.live_read_enabled'),
    'taking EXCLUDED.live_read_enabled would revert operator live-read decisions',
  );
});

test('the scheduled workflow run is pinned to uncovered-only', () => {
  const wf = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'pdp-identity-graph-backfill.yml'),
    'utf8',
  );
  assert.match(wf, /schedule:/, 'the catch-up must actually be scheduled');
  // The whole safety argument for an unattended APPLY rests on this pin.
  assert.match(
    wf,
    /IN_ONLY_UNCOVERED:.*github\.event_name == 'schedule' && 'true'/,
    'scheduled runs must force only-uncovered',
  );
  assert.match(wf, /--only-uncovered/);
});

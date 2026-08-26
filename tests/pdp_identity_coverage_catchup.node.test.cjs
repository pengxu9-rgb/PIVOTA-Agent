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

test('the guard must NOT correlate on merchant_id — it cannot see its own output', async () => {
  // THE defect this file exists to prevent, and the one a SQL-text assertion
  // missed on the first cut. Since #1770 an external-seed listing is keyed to
  // the per-brand observed seller (merch_obs_…), NOT the legacy 'external_seed'
  // bucket. A `pil.merchant_id = $1` conjunct therefore fails to match the rows
  // THIS job mints: week 1 mints under merch_obs_, week 2 re-selects them as
  // "uncovered" and re-enters ON CONFLICT — unattended, against prod, forever.
  const { seen, queryFn } = capture();
  await fetchBackfillProducts({ onlyUncovered: true, queryFn });
  const seedSql = seen.find((s) => s.includes('external_product_seeds'));
  const guard = seedSql.slice(seedSql.indexOf('NOT EXISTS'));
  const guardBlock = guard.slice(0, guard.indexOf(')') + 1);
  assert.ok(
    !/pil\.merchant_id/.test(guardBlock),
    'the uncovered guard must key on product_id alone; merchant_id makes it blind to merch_obs_ listings',
  );
  assert.match(guardBlock, /pil\.source_kind = 'external_seed'/);
});

test('catch-up mode does not touch the internal (products_cache) lane', async () => {
  // An internal listing's key is resolved from JSONB in JS, so no SQL
  // predicate reproduces it; running that lane in catch-up mode would re-enter
  // ON CONFLICT for rows that already have listings. Skipped on purpose.
  const { seen, queryFn } = capture();
  await fetchBackfillProducts({ onlyUncovered: true, queryFn });
  assert.ok(
    !seen.some((s) => s.includes('products_cache')),
    'catch-up mode must not query the internal lane',
  );
  const plain = capture();
  await fetchBackfillProducts({ queryFn: plain.queryFn });
  assert.ok(
    plain.seen.some((s) => s.includes('products_cache')),
    'default mode must still cover the internal lane',
  );
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
  // Scoped to the ON CONFLICT block so a future mention in a comment cannot
  // flip this green or red by accident.
  const conflictBlock = GRAPH_SRC.slice(
    GRAPH_SRC.indexOf('ON CONFLICT (source_listing_ref) DO UPDATE SET'),
  ).slice(0, 4000);
  assert.ok(
    conflictBlock.includes('live_read_enabled = pdp_identity_listing.live_read_enabled'),
    'the upsert must preserve the stored live_read_enabled',
  );
  assert.ok(
    !conflictBlock.includes('live_read_enabled = EXCLUDED.live_read_enabled'),
    'taking EXCLUDED.live_read_enabled would revert operator live-read decisions',
  );
});

test('the unattended lane lives in Cloud Run now — this workflow must not re-grow a schedule', () => {
  // The weekly catch-up moved to the Cloud Run Job `pdp-identity-graph-backfill`
  // (pivota-prod/us-west1, pivota-backend infra/gcp/setup_scheduler.sh), whose
  // command line hard-pins `--limit 2000 --only-uncovered` — the uncovered-only
  // pin this test used to check on the GH scheduled path now lives there, where
  // CI here cannot see it. What CI here CAN hold: this workflow's DATABASE_URL
  // secret points at the Railway proxy decommissioned 2026-08-25, so a re-added
  // `schedule:` trigger is a lane that can only fail — and if the secret is ever
  // repointed, an unattended GH apply lane needs the uncovered-only pin argued
  // all over again, in this test.
  const wf = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'pdp-identity-graph-backfill.yml'),
    'utf8',
  );
  assert.ok(
    !/^\s*schedule:/m.test(wf),
    'the scheduled catch-up moved to the Cloud Run Job pdp-identity-graph-backfill; a GH schedule here runs against a decommissioned DATABASE_URL',
  );
  // The surviving manual path stays fail-safe: a bare dispatch is a dry run,
  // and the uncovered-only plumbing is still wired for ad-hoc catch-ups.
  assert.match(wf, /dry_run:[\s\S]{0,200}?default: true/, 'manual dispatch must default to dry-run');
  assert.match(wf, /--only-uncovered/);
});

#!/usr/bin/env node
'use strict';

/**
 * The relationship graph's nightly READOUT: what last night's relgraph-sync did, in counts.
 *
 * WHY THIS EXISTS. After every 10:37Z relgraph-sync, someone read the run ledger, the review-error
 * quarantine and the review pool BY HAND from a laptop (ad-hoc SQL against prod through one-off
 * Cloud Run jobs), because the health job checks the SERVING set and says nothing about the night's
 * review work. This module is those readouts, committed, so the scheduled `relgraph-health` Cloud
 * Run job prints them every day and nobody's machine is in the path.
 *
 * REPORT-ONLY. Nothing here decides the health job's exit code. A failed nightly already fails
 * relgraph-sync's own execution (and pages through the "Cloud Run job failing" policy); a readout
 * that also paged would double-count one incident and would change the health job's severity in
 * the same change that adds it.
 *
 * COUNTS AND STATUS ONLY. No ids, product refs, titles or review text leave the database: every
 * query aggregates, and the run rows carry only the ledger's own counters. The log line is safe to
 * keep in Cloud Logging.
 *
 * READ-ONLY. Three SELECTs. LIMIT caps the rows RETURNED, not the work: the two
 * relationship_candidate_labels GROUP BYs still scan every `generated` row. They run under the pool's
 * 30s statement_timeout, and a timeout is recorded by the health job, never thrown.
 */

const { closePool, query } = require('../src/db');

const DEFAULT_RUN_DAYS = 7;
const MAX_RUN_DAYS = 35;
// Mirrors the review's own quarantine rule (ai_review_error.consecutive >= 2 skips the row).
const QUARANTINE_CONSECUTIVE = 2;

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** The sync routine's recent runs, newest first, as the ledger records them. */
async function loadRecentRuns({ runDays }, queryFn = query) {
  const res = await queryFn(
    `
    SELECT
      to_char(generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS generated_at,
      trigger,
      status,
      failed_step,
      apply_review,
      affected_count,
      edge_count,
      reviewed_count,
      approved_count,
      review_rejected_count,
      summary->>'review_error_count' AS review_error_count,
      summary->>'error_quarantine_entered_count' AS quarantine_entered_count,
      summary->>'error_quarantine_skipped_count' AS quarantine_skipped_count
    FROM relationship_graph_routine_runs
    WHERE run_kind = 'sync_routine'
      AND generated_at >= now() - ($1 || ' days')::interval
    ORDER BY generated_at DESC
    LIMIT 60
    `,
    [String(runDays)],
  );
  return ((res && res.rows) || []).map((r) => ({
    generated_at: r.generated_at || null,
    trigger: r.trigger || null,
    status: r.status || null,
    failed_step: r.failed_step || null,
    apply_review: r.apply_review ?? null,
    affected: toInt(r.affected_count),
    edges: toInt(r.edge_count),
    reviewed: toInt(r.reviewed_count),
    approved: toInt(r.approved_count),
    review_rejected: toInt(r.review_rejected_count),
    review_errors: toInt(r.review_error_count),
    quarantine_entered: toInt(r.quarantine_entered_count),
    quarantine_skipped: toInt(r.quarantine_skipped_count),
  }));
}

/** Generated labels carrying a review-error memo, by streak length and last error code. */
async function loadErrorQuarantine(queryFn = query) {
  const res = await queryFn(
    `
    SELECT
      CASE
        WHEN (provenance->'ai_review_error'->>'consecutive') ~ '^[0-9]+$'
          THEN (provenance->'ai_review_error'->>'consecutive')::int
        ELSE NULL
      END AS consecutive,
      coalesce(provenance->'ai_review_error'->>'last_code', 'unknown') AS last_code,
      count(*)::int AS n
    FROM relationship_candidate_labels
    WHERE label_state = 'generated'
      AND provenance ? 'ai_review_error'
    GROUP BY 1, 2
    ORDER BY 1 NULLS LAST, 2
    LIMIT 200
    `,
  );
  const rows = ((res && res.rows) || []).map((r) => ({
    consecutive: toInt(r.consecutive),
    last_code: String(r.last_code || 'unknown').slice(0, 80),
    n: toInt(r.n) || 0,
  }));
  const quarantined = rows
    .filter((r) => r.consecutive !== null && r.consecutive >= QUARANTINE_CONSECUTIVE)
    .reduce((sum, r) => sum + r.n, 0);
  return { quarantined, buckets: rows };
}

/**
 * The generated competitive_alternative pool the nightly review draws from, by memo state. The
 * review applies further skips in code (fingerprints, rubric/validator versions), so these buckets
 * are an upper bound on what it will look at, not a prediction of it.
 */
async function loadReviewPool(queryFn = query) {
  const res = await queryFn(
    `
    SELECT bucket, count(*)::int AS n
    FROM (
      SELECT CASE
        WHEN (provenance->'ai_review_error'->>'consecutive') ~ '^[0-9]+$'
             AND (provenance->'ai_review_error'->>'consecutive')::int >= $1 THEN 'error_quarantined'
        WHEN provenance ? 'ai_review_last' THEN 'has_review_memo'
        WHEN provenance ? 'ai_review_error' THEN 'error_once'
        ELSE 'no_memo'
      END AS bucket
      FROM relationship_candidate_labels
      WHERE label_state = 'generated'
        AND relation_type = 'competitive_alternative'
        AND coalesce(score_total, 0) >= 0
    ) pool
    GROUP BY bucket
    ORDER BY bucket
    LIMIT 10
    `,
    [QUARANTINE_CONSECUTIVE],
  );
  const out = { error_quarantined: 0, has_review_memo: 0, error_once: 0, no_memo: 0 };
  for (const r of (res && res.rows) || []) {
    if (Object.prototype.hasOwnProperty.call(out, r.bucket)) out[r.bucket] = toInt(r.n) || 0;
  }
  return out;
}

// The ledger's statuses that mean a run broke. `running` and the `skipped*` family are not failures:
// counting them as failed would turn a disabled night or an in-flight run into an alarm.
const FAILED_STATUSES = new Set(['failed', 'error']);

/** Pure: the headline a reader needs first, from the run list (newest first). */
function summarizeRuns(runs) {
  const last = runs[0] || null;
  const reviewed = runs.map((r) => r.reviewed).filter((n) => Number.isFinite(n));
  const statusCounts = {};
  for (const r of runs) {
    const key = r.status || 'unknown';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  return {
    last_run_at: last ? last.generated_at : null,
    last_status: last ? last.status : null,
    last_failed_step: last ? last.failed_step : null,
    runs: runs.length,
    failed_runs: runs.filter((r) => FAILED_STATUSES.has(r.status)).length,
    status_counts: statusCounts,
    reviewed_total: reviewed.reduce((a, b) => a + b, 0),
  };
}

async function runNightlyReadout(options = {}, queryFn = query) {
  const runDays = Math.min(
    MAX_RUN_DAYS,
    Math.max(1, toInt(options.runDays) || DEFAULT_RUN_DAYS),
  );
  const runs = await loadRecentRuns({ runDays }, queryFn);
  const quarantine = await loadErrorQuarantine(queryFn);
  const pool = await loadReviewPool(queryFn);
  return {
    run_days: runDays,
    summary: summarizeRuns(runs),
    runs,
    error_quarantine: quarantine,
    review_pool: pool,
  };
}

async function main() {
  const i = process.argv.indexOf('--run-days');
  const runDays = i === -1 ? undefined : process.argv[i + 1];
  try {
    const report = await runNightlyReadout({ runDays });
    process.stdout.write(`${JSON.stringify({ message: 'relgraph_nightly_readout', ...report })}\n`);
  } finally {
    await closePool().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[relgraph-nightly-readout] FAILED: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  runNightlyReadout,
  loadRecentRuns,
  loadErrorQuarantine,
  loadReviewPool,
  summarizeRuns,
  DEFAULT_RUN_DAYS,
  QUARANTINE_CONSECUTIVE,
};

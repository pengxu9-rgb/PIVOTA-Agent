#!/usr/bin/env node
'use strict';

/**
 * The relationship graph's daily health job, for the Cloud Run path.
 *
 * WHY THIS EXISTS. `Relationship Graph Serving Guard Audit` ran on a GitHub-hosted runner and last
 * succeeded 2026-08-25. On 2026-08-25 the Railway DATABASE_URL was decommissioned
 * (pivota-backend infra/gcp/setup_scheduler.sh:338) and prod Postgres became private-only —
 * `pivota-pg` has `ipv4Enabled: false`, a single RFC1918 address (10.25.0.2), and no authorized
 * networks. A GitHub-hosted runner has no route to it and never will; the `read ECONNRESET` those
 * runs report is GitHub's network resetting traffic to a non-routable address, not a database
 * fault. So the audit has had NO coverage since 2026-08-26 and cannot be repaired where it lives.
 *
 * The gate logic used to live in the workflow YAML as an inline `node -e`, which is why it could
 * not simply be pointed at a Cloud Run job. It lives here now, in code, with tests.
 *
 * WHAT IT CHECKS, in one run so a single daily job covers the graph:
 *   1. serving guard  — approved rows that are suppressed, and any critical suppression reason.
 *   2. expiry risk    — >30% of serving edges expiring within 14 days, or the serving set falling
 *                       below 500 rows, or emptying entirely. This was a SECOND step in the retired
 *                       workflow and was missed on the first port; review caught it.
 *   3. no-op runs     — the ledger passing while nothing is applied (see
 *                       audit-relationship-graph-noop-runs.js for why it is keyed on
 *                       applied_count and not on the edges view's created_at).
 *
 * Exit codes: 0 clean, 1 a threshold was breached, 2 the job itself failed. A breach and a crash
 * must not look the same — the whole point of this work is that a green signal over a broken thing
 * is the defect.
 */

const { closePool } = require('../src/db');
const { runServingGuardAudit } = require('./audit-relationship-graph-serving-guard');
const { runNoopAudit } = require('./audit-relationship-graph-noop-runs');
const {
  DEFAULT_THRESHOLDS,
  runServingStatusReport,
} = require('./report-relationship-graph-serving-status');

// The three reasons the retired workflow hardcoded as CRITICAL_REASONS. Defaulted HERE rather than
// left to the caller: the Cloud Run job passes thresholds through env, and a reason list that is
// empty unless someone remembers an env var is a check that silently never fires — which is the
// defect this job exists to report, committed inside it. Review caught exactly that.
const DEFAULT_CRITICAL_REASONS = [
  'ai_approved_dupe_quarantined',
  'candidate_ref_unresolvable_nested_product_prefix',
  'anchor_ref_unresolvable_nested_product_prefix',
];

// The retired workflow's SECOND step, "Serving expiry risk alarm": all markets, fail when more than
// 30% of serving edges expire inside 14 days, or when the serving set falls below 500 rows.
const DEFAULT_MAX_EXPIRING_14D_PCT = 30;
const DEFAULT_MIN_TOTAL_ROWS = 500;

const DEFAULTS = {
  market: 'US',
  maxSuppressedRows: 0,
  maxSuppressedPct: 0,
  criticalReasons: DEFAULT_CRITICAL_REASONS,
  failOnNoop: false,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const at = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : null;
  };
  const reasons = at('critical-reasons') || env.RELGRAPH_CRITICAL_REASONS || '';
  // SEMICOLON *OR* COMMA. gcloud's --set-env-vars is itself comma-separated, so a comma-joined
  // list cannot be carried through it — infra/gcp/setup_scheduler.sh joins the three reasons with
  // ';'. Splitting on only one of the two would deliver the whole string as a single bogus reason
  // that matches nothing, which is the silent-no-op defect this job reports, in the job.
  const parsedReasons = String(reasons).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  return {
    market: (at('market') || env.RELGRAPH_MARKET || DEFAULTS.market).toUpperCase(),
    maxSuppressedRows: num(
      at('max-suppressed-rows') ?? env.RELGRAPH_MAX_SUPPRESSED_ROWS,
      DEFAULTS.maxSuppressedRows,
    ),
    maxSuppressedPct: num(
      at('max-suppressed-pct') ?? env.RELGRAPH_MAX_SUPPRESSED_PCT,
      DEFAULTS.maxSuppressedPct,
    ),
    // An explicit list overrides; an ABSENT one keeps the workflow's three, never an empty list.
    criticalReasons: parsedReasons.length ? parsedReasons : DEFAULT_CRITICAL_REASONS,
    maxExpiring14dPct: num(
      at('max-expiring-14d-pct') ?? env.RELGRAPH_MAX_EXPIRING_14D_PCT,
      DEFAULT_MAX_EXPIRING_14D_PCT,
    ),
    minTotalRows: num(at('min-total-rows') ?? env.RELGRAPH_MIN_TOTAL_ROWS, DEFAULT_MIN_TOTAL_ROWS),
    // Report-only until someone decides the no-op state should page. The serving-guard thresholds
    // were already enforcing before the move, so they stay enforcing; changing both severities in
    // one migration would make it impossible to tell a migration bug from a real finding.
    failOnNoop: argv.includes('--fail-on-noop') || env.RELGRAPH_FAIL_ON_NOOP === 'true',
  };
}

/** Pure: turn an audit report plus thresholds into violations. Ported from the workflow's node -e. */
function evaluateServingGuard(report, opts) {
  const suppressedRows = Number((report && report.suppressed_rows) || 0);
  const suppressedPct = Number((report && report.suppressed_pct) || 0);
  const byReason = (report && report.by_reason) || {};
  const violations = [];
  if (Number.isFinite(opts.maxSuppressedRows) && suppressedRows > opts.maxSuppressedRows) {
    violations.push({
      metric: 'suppressed_rows',
      observed: suppressedRows,
      max: opts.maxSuppressedRows,
    });
  }
  if (Number.isFinite(opts.maxSuppressedPct) && suppressedPct > opts.maxSuppressedPct) {
    violations.push({
      metric: 'suppressed_pct',
      observed: suppressedPct,
      max: opts.maxSuppressedPct,
    });
  }
  for (const reason of opts.criticalReasons || []) {
    const count = Number(byReason[reason] || 0);
    if (count > 0) {
      violations.push({ metric: 'critical_reason', reason, observed: count, max: 0 });
    }
  }
  return {
    ok: violations.length === 0,
    total_rows: report && report.total_rows,
    safe_rows: report && report.safe_rows,
    suppressed_rows: suppressedRows,
    suppressed_pct: suppressedPct,
    violations,
  };
}

/**
 * The retired workflow's expiry alarm, ported verbatim in behaviour:
 * fail when >maxExpiring14dPct of serving edges expire within 14 days, when the serving set is
 * below minTotalRows, or when it is EMPTY — 0% of 0 rows must never read as healthy, because at
 * that point the cliff has already happened.
 */
function evaluateExpiryRisk(report) {
  const expiring = report && report.checks && report.checks.expiring_14d_pct;
  const floor = report && report.checks && report.checks.total_rows;
  const totalRows = Number((report && report.coverage && report.coverage.total_rows) || 0);
  const servingEmpty = totalRows === 0;
  const violations = [];
  if (expiring && expiring.status === 'fail') violations.push({ metric: 'expiring_14d_pct' });
  if (floor && floor.status === 'fail') violations.push({ metric: 'total_rows' });
  if (servingEmpty) violations.push({ metric: 'serving_empty' });
  return { ok: violations.length === 0, total_rows: totalRows, violations };
}

async function runHealthJob(opts, deps = {}) {
  const servingAudit = deps.runServingGuardAudit || runServingGuardAudit;
  const noopAudit = deps.runNoopAudit || runNoopAudit;
  const statusReport = deps.runServingStatusReport || runServingStatusReport;

  const report = await servingAudit({ market: opts.market });
  const gate = evaluateServingGuard(report, opts);

  // ALL MARKETS, as the retired step did — an expiry cliff in one market is still a cliff.
  const status = await statusReport({
    market: '',
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      maxExpiring14dPct: opts.maxExpiring14dPct,
      minTotalRows: opts.minTotalRows,
    },
  });
  const expiry = evaluateExpiryRisk(status);

  const noop = await noopAudit({});
  const failed = !gate.ok || !expiry.ok || (noop.noop && opts.failOnNoop);
  return { market: opts.market, gate, expiry, noop, ok: !failed };
}

async function main() {
  const opts = parseArgs();
  let result;
  try {
    result = await runHealthJob(opts);
  } catch (err) {
    process.stderr.write(`[relgraph-health] FAILED: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2; // a crash is not a finding
    return;
  } finally {
    await closePool().catch(() => {});
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[relgraph-health] FAILED: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  parseArgs,
  evaluateServingGuard,
  evaluateExpiryRisk,
  runHealthJob,
  DEFAULT_CRITICAL_REASONS,
};

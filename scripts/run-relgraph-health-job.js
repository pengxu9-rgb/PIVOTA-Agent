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
 *   2. no-op runs     — the ledger passing while nothing is applied (see
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

const DEFAULTS = {
  market: 'US',
  maxSuppressedRows: 0,
  maxSuppressedPct: 0,
  criticalReasons: [],
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
    criticalReasons: String(reasons)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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

async function runHealthJob(opts, deps = {}) {
  const servingAudit = deps.runServingGuardAudit || runServingGuardAudit;
  const noopAudit = deps.runNoopAudit || runNoopAudit;
  const report = await servingAudit({ market: opts.market });
  const gate = evaluateServingGuard(report, opts);
  const noop = await noopAudit({});
  const failed = !gate.ok || (noop.noop && opts.failOnNoop);
  return { market: opts.market, gate, noop, ok: !failed };
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

module.exports = { parseArgs, evaluateServingGuard, runHealthJob };

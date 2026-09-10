#!/usr/bin/env node
'use strict';

/**
 * THE LEDGER IS NOT THE DATA.
 *
 * `relationship_graph_routine_runs` recorded `sync_routine: passed` every day through 2026-09-09
 * while the graph gained nothing. The daily job selects a 24h window, finds nothing changed, and
 * passes under `--allow-empty-selection`. A green run ledger is indistinguishable from a working
 * one unless something compares a run to its OUTPUT — which is what this does.
 *
 * Generalise the shape, not the instance: any "did it run" signal read as "is it working" fails
 * this way.
 *
 * KEYED ON applied_count, DELIBERATELY. An earlier version of this check (in pivota-backend, since
 * removed) compared the ledger to `max(created_at)` on `product_relationship_edges`. That is a VIEW
 * over `relationship_candidate_labels` (migration 051: `label_state IN ('human_approved',
 * 'ai_approved')` and not expired), so `created_at` there is the CANDIDATE LABEL's creation time —
 * and `renew-relationship-ai-approved-labels.js` moves `last_verified_at`/`expires_at` and never
 * `created_at`. That version would have fired on a healthy fortnight of renewals with no new
 * approvals: a "no new approvals" signal wearing a "frozen data" name. `applied_count` is what the
 * run itself claims it changed, so the comparison needs no assumption about the view.
 *
 * WHY IT LIVES HERE. The tables are this repo's. pivota-backend's invariant sweep reached across
 * the service boundary to read them and its own sample-contract gate failed with `UndefinedTable`
 * on a bare database — correctly.
 *
 * ⚠️ DO NOT WIRE THIS TO A GITHUB SCHEDULE. Both relationship-graph workflows here are dead:
 * `Relationship Graph Sync Routine` and `Relationship Graph Serving Guard Audit` last succeeded
 * 2026-08-25 and have failed or not fired since 2026-08-26, because a GitHub runner can no longer
 * reach prod Postgres (`ECONNRESET` at the first query). Adding a detector to a workflow that
 * cannot run reproduces the exact defect it detects. Run it from the Cloud Run path that does
 * work — the `relgraph-sync` job reaches the database fine.
 *
 * Usage:
 *   node scripts/audit-relationship-graph-noop-runs.js [--window-days 14] [--recent-hours 48]
 *   ... --json           machine-readable report on stdout
 *   ... --fail-on-noop   exit 1 when the contradiction holds (default: report only)
 */

const { closePool, query } = require('../src/db');

const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_RECENT_HOURS = 48;

function parseInteger(value, fallback, { min = 1, max = 3650 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseArgs(argv = process.argv.slice(2)) {
  const at = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : null;
  };
  return {
    windowDays: parseInteger(at('window-days'), DEFAULT_WINDOW_DAYS),
    recentHours: parseInteger(at('recent-hours'), DEFAULT_RECENT_HOURS, { min: 1, max: 24 * 30 }),
    json: argv.includes('--json'),
    failOnNoop: argv.includes('--fail-on-noop'),
  };
}

/**
 * Two facts, one query, so they describe the SAME instant. Read separately, a run landing between
 * them could make a real contradiction look clean.
 */
async function loadRunFacts({ windowDays, recentHours }, queryFn = query) {
  const res = await queryFn(
    `
    SELECT
      count(*) FILTER (
        WHERE status = 'passed' AND completed_at > now() - ($1 || ' hours')::interval
      )::int AS recent_passed,
      count(*) FILTER (
        WHERE status = 'passed' AND completed_at > now() - ($2 || ' days')::interval
      )::int AS window_passed,
      coalesce(max(applied_count) FILTER (
        WHERE status = 'passed' AND completed_at > now() - ($2 || ' days')::interval
      ), 0)::int AS window_max_applied,
      max(completed_at) FILTER (WHERE status = 'passed') AS last_passed_at
    FROM relationship_graph_routine_runs
    `,
    [String(recentHours), String(windowDays)],
  );
  const row = (res && res.rows && res.rows[0]) || {};
  return {
    recent_passed: Number(row.recent_passed || 0),
    window_passed: Number(row.window_passed || 0),
    window_max_applied: Number(row.window_max_applied || 0),
    last_passed_at: row.last_passed_at || null,
  };
}

/**
 * The contradiction: something passed recently, and NOTHING in the window applied anything.
 *
 * `recent_passed > 0` is load-bearing. Without it a repo whose job simply stopped running would
 * report the same "nothing applied" — but that is a DEAD CRON, a different defect with a different
 * fix, and conflating them would send someone to debug the wrong thing.
 */
function classifyRunFacts(facts) {
  const recent = Number(facts.recent_passed || 0);
  const applied = Number(facts.window_max_applied || 0);
  const noop = recent > 0 && applied === 0;
  return {
    ...facts,
    noop,
    verdict: noop
      ? 'runs_pass_without_applying'
      : recent === 0
        ? 'no_recent_passing_run'
        : 'applying',
  };
}

async function runNoopAudit(options = {}, queryFn = query) {
  const opts = { windowDays: DEFAULT_WINDOW_DAYS, recentHours: DEFAULT_RECENT_HOURS, ...options };
  const facts = await loadRunFacts(opts, queryFn);
  return {
    window_days: opts.windowDays,
    recent_hours: opts.recentHours,
    ...classifyRunFacts(facts),
  };
}

async function main() {
  const args = parseArgs();
  let report;
  try {
    report = await runNoopAudit(args);
  } finally {
    await closePool().catch(() => {});
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[relgraph-noop] verdict=${report.verdict} recent_passed=${report.recent_passed} ` +
        `window_passed=${report.window_passed} window_max_applied=${report.window_max_applied} ` +
        `last_passed_at=${report.last_passed_at}`,
    );
  }
  if (report.noop && args.failOnNoop) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[relgraph-noop] failed:', err && err.message ? err.message : err);
    process.exitCode = 2;
  });
}

module.exports = { parseArgs, loadRunFacts, classifyRunFacts, runNoopAudit };

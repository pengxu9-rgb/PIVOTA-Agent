#!/usr/bin/env node
'use strict';

const { closePool, query } = require('../src/db');

const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function argValue(argv, name, fallback = '') {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseTimestamp(value) {
  const text = normalizeString(value, 100);
  if (!text) return '';
  const ms = new Date(text).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid timestamp: ${text}`);
  }
  return new Date(ms).toISOString();
}

function usage() {
  return [
    'Usage:',
    '  DATABASE_URL=... node scripts/report-relationship-graph-run-ledger.js [--market US|--all-markets] [--trigger railway_cron] [--status passed|failed|skipped|unknown] [--limit N] [--since timestamp|--hours N] [--max-age-minutes N] [--fail-on-empty] [--fail-on-latest-failed] [--json]',
    '',
    'Read-only operator status for relationship_graph_routine_runs.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2), { now = new Date() } = {}) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };
  const allMarkets = hasFlag(argv, 'all-markets');
  const hours = parseInteger(argValue(argv, 'hours'), 0, { min: 0, max: 24 * 365 });
  const sinceInput = normalizeString(argValue(argv, 'since'), 100);
  const since = sinceInput
    ? parseTimestamp(sinceInput)
    : (hours ? new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString() : '');

  return {
    market: allMarkets ? '' : (normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase() || DEFAULT_MARKET),
    trigger: normalizeString(argValue(argv, 'trigger'), 120),
    status: normalizeString(argValue(argv, 'status'), 40).toLowerCase(),
    runKind: normalizeString(argValue(argv, 'run-kind'), 80).toLowerCase(),
    since,
    limit: parseInteger(argValue(argv, 'limit'), DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT }),
    maxAgeMinutes: parseInteger(argValue(argv, 'max-age-minutes'), 0, { min: 0, max: 30 * 24 * 60 }),
    failOnEmpty: hasFlag(argv, 'fail-on-empty'),
    failOnLatestFailed: hasFlag(argv, 'fail-on-latest-failed') || hasFlag(argv, 'fail-on-latest-non-passing'),
    json: hasFlag(argv, 'json'),
  };
}

function buildRunLedgerSql(options = {}) {
  const params = [];
  const where = [];

  if (options.market) {
    params.push(normalizeString(options.market, 24).toUpperCase());
    where.push(`upper(market) = $${params.length}`);
  }
  if (options.trigger) {
    params.push(normalizeString(options.trigger, 120));
    where.push(`trigger = $${params.length}`);
  }
  if (options.status) {
    params.push(normalizeString(options.status, 40).toLowerCase());
    where.push(`status = $${params.length}`);
  }
  if (options.runKind) {
    params.push(normalizeString(options.runKind, 80).toLowerCase());
    where.push(`run_kind = $${params.length}`);
  }
  if (options.since) {
    params.push(parseTimestamp(options.since));
    where.push(`generated_at >= $${params.length}`);
  }

  const limit = parseInteger(options.limit, DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT });
  params.push(limit);
  const whereSql = where.length ? `WHERE ${where.join('\n        AND ')}` : '';

  return {
    sql: `
      SELECT
        run_id,
        run_kind,
        trigger,
        routine_run_id,
        market,
        status,
        dry_run,
        apply_sync,
        apply_build,
        apply_review,
        cutoff,
        selector_updated_since,
        selector_sources,
        selector_limit,
        affected_count,
        anchor_count,
        edge_count,
        rejected_count,
        reviewed_count,
        approved_count,
        review_rejected_count,
        applied_count,
        serving_total_rows,
        serving_safe_rows,
        serving_suppressed_rows,
        serving_suppressed_pct,
        db_lock_requested,
        db_lock_acquired,
        failed_step,
        out_dir,
        summary_path,
        generated_at,
        completed_at,
        created_at,
        updated_at
      FROM relationship_graph_routine_runs
      ${whereSql}
      ORDER BY generated_at DESC NULLS LAST, created_at DESC
      LIMIT $${params.length}::int
    `,
    params,
  };
}

async function loadRunLedgerRows({ queryFn = query, ...options } = {}) {
  const { sql, params } = buildRunLedgerSql(options);
  const res = await queryFn(sql, params);
  return Array.isArray(res && res.rows) ? res.rows : [];
}

function latestAgeMinutes(latest, now = new Date()) {
  const ms = new Date(latest?.generated_at || latest?.created_at || '').getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round((now.getTime() - ms) / 60000);
}

function buildRunLedgerReport(rows = [], options = {}, { now = new Date() } = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const latest = normalizedRows[0] || null;
  const ageMinutes = latest ? latestAgeMinutes(latest, now) : null;
  const checks = {
    has_runs: normalizedRows.length > 0,
    latest_passed: latest ? latest.status === 'passed' : false,
    latest_fresh: options.maxAgeMinutes ? (ageMinutes != null && ageMinutes <= options.maxAgeMinutes) : true,
  };
  const ok = (
    (!options.failOnEmpty || checks.has_runs)
    && (!options.failOnLatestFailed || checks.latest_passed)
    && checks.latest_fresh
  );

  return {
    schema_version: 'relationship_graph_run_ledger_report.v1',
    generated_at: now.toISOString(),
    ok,
    filters: {
      market: options.market || null,
      trigger: options.trigger || null,
      status: options.status || null,
      run_kind: options.runKind || null,
      since: options.since || null,
      limit: options.limit || DEFAULT_LIMIT,
      max_age_minutes: options.maxAgeMinutes || null,
    },
    checks,
    latest_age_minutes: ageMinutes,
    latest,
    runs: normalizedRows,
  };
}

function compactValue(value) {
  if (value == null) return '-';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function formatRunLedgerText(report = {}) {
  const lines = [];
  lines.push(`relationship graph run ledger: ${report.ok ? 'ok' : 'not_ok'}`);
  const latest = report.latest;
  if (!latest) {
    lines.push('latest: none');
    return `${lines.join('\n')}\n`;
  }

  lines.push([
    `latest=${compactValue(latest.run_id)}`,
    `status=${compactValue(latest.status)}`,
    `trigger=${compactValue(latest.trigger)}`,
    `market=${compactValue(latest.market)}`,
    `age_min=${compactValue(report.latest_age_minutes)}`,
  ].join(' '));
  lines.push('run_id status trigger generated_at affected anchors edges reviewed applied safe suppressed db_lock failed_step');
  for (const row of report.runs || []) {
    lines.push([
      row.run_id,
      row.status,
      row.trigger || '-',
      row.generated_at ? new Date(row.generated_at).toISOString() : '-',
      compactValue(row.affected_count),
      compactValue(row.anchor_count),
      compactValue(row.edge_count),
      compactValue(row.reviewed_count),
      compactValue(row.applied_count),
      compactValue(row.serving_safe_rows),
      compactValue(row.serving_suppressed_rows),
      row.db_lock_requested ? (row.db_lock_acquired ? 'acquired' : 'missed') : 'not_requested',
      row.failed_step || '-',
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

async function runReport(options, { queryFn = query, now = new Date() } = {}) {
  const rows = await loadRunLedgerRows({ queryFn, ...options });
  return buildRunLedgerReport(rows, options, { now });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }

  const report = await runReport(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatRunLedgerText(report));
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}

module.exports = {
  buildRunLedgerReport,
  buildRunLedgerSql,
  formatRunLedgerText,
  loadRunLedgerRows,
  parseArgs,
  runReport,
};

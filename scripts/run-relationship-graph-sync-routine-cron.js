#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
  WRAPPER_CONFIRM_TOKEN,
  formatRoutineFailure,
  parseArgs,
  runSyncRoutine,
} = require('./run-relationship-graph-sync-routine');

const DEFAULT_SELECT_HOURS = 24;
const DEFAULT_MARKET = 'US';
const DEFAULT_SELECT_LIMIT = 250;
const DEFAULT_LIMIT = 200;
const DEFAULT_REVIEW_LIMIT = 250;
const DEFAULT_SELECT_SOURCES = 'catalog_products,external_product_seeds';
const DEFAULT_RUN_TRIGGER = 'railway_cron';

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function parseBooleanEnv(value, fallback = false) {
  const text = normalizeString(value, 40).toLowerCase();
  if (!text) return Boolean(fallback);
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return Boolean(fallback);
}

function parseNumberEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = normalizeString(value, 80);
  if (!text) return fallback;
  const number = Number(text);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function dateStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
}

function pushArg(args, name, value) {
  const text = normalizeString(value, 5000);
  if (!text) return;
  args.push(`--${name}`, text);
}

function pushFlag(args, name, enabled) {
  if (enabled) args.push(`--${name}`);
}

function buildCronArgs(env = process.env, { now = new Date() } = {}) {
  const enabled = parseBooleanEnv(env.RELGRAPH_SYNC_CRON_ENABLED, true);
  if (!enabled) {
    return {
      enabled: false,
      args: [],
      dryRun: true,
      reason: 'RELGRAPH_SYNC_CRON_ENABLED=false',
    };
  }

  if (parseBooleanEnv(env.RELGRAPH_SYNC_APPLY_SYNC, false)) {
    throw new Error('RELGRAPH_SYNC_APPLY_SYNC is not supported for selector cron jobs');
  }

  const selectHours = parseNumberEnv(env.RELGRAPH_SYNC_SELECT_HOURS, DEFAULT_SELECT_HOURS, {
    min: 1,
    max: 24 * 365,
  });
  const defaultSince = new Date(now.getTime() - selectHours * 60 * 60 * 1000).toISOString();
  const selectUpdatedSince = normalizeString(
    env.RELGRAPH_SYNC_SELECT_UPDATED_SINCE || env.RELGRAPH_SYNC_UPDATED_SINCE,
    100,
  ) || defaultSince;
  if (Number.isNaN(new Date(selectUpdatedSince).getTime())) {
    throw new Error(`invalid RELGRAPH_SYNC_SELECT_UPDATED_SINCE timestamp: ${selectUpdatedSince}`);
  }

  const skipReview = parseBooleanEnv(env.RELGRAPH_SYNC_SKIP_REVIEW, false);
  const cutoff = normalizeString(env.RELGRAPH_SYNC_CUTOFF, 100) || selectUpdatedSince;
  if (!skipReview && Number.isNaN(new Date(cutoff).getTime())) {
    throw new Error(`invalid RELGRAPH_SYNC_CUTOFF timestamp: ${cutoff}`);
  }

  const applyBuild = parseBooleanEnv(env.RELGRAPH_SYNC_APPLY_BUILD, false);
  const applyReview = parseBooleanEnv(env.RELGRAPH_SYNC_APPLY_REVIEW, false);
  const dryRun = !(applyBuild || applyReview);
  if (!dryRun) {
    if (!parseBooleanEnv(env.RELGRAPH_SYNC_ALLOW_WRITES, false)) {
      throw new Error('write-mode cron jobs require RELGRAPH_SYNC_ALLOW_WRITES=true');
    }
    if (normalizeString(env.RELGRAPH_SYNC_CONFIRM, 120) !== WRAPPER_CONFIRM_TOKEN) {
      throw new Error(`write-mode cron jobs require RELGRAPH_SYNC_CONFIRM=${WRAPPER_CONFIRM_TOKEN}`);
    }
  }

  // ai_approved renewal is a non-LLM, label_state-preserving write that only
  // extends expiry on rows that still verify. It applies by default on schedule
  // so the 45-day freshness cliff cannot empty serving again; it is NOT gated
  // behind RELGRAPH_SYNC_ALLOW_WRITES, which protects LLM-driven build/review
  // label-state writes.
  const skipRenewal = parseBooleanEnv(env.RELGRAPH_SYNC_SKIP_RENEWAL, false);
  const applyRenewal = !skipRenewal && parseBooleanEnv(env.RELGRAPH_SYNC_APPLY_RENEWAL, true);

  const outDir = normalizeString(env.RELGRAPH_SYNC_OUT_DIR, 2000)
    || path.join('/tmp', 'relationship-graph-sync-routine', `relgraph_sync_cron_${dateStamp(now)}`);
  const allowEmpty = parseBooleanEnv(env.RELGRAPH_SYNC_ALLOW_EMPTY, true);
  const recordRunLedger = parseBooleanEnv(env.RELGRAPH_SYNC_RUN_LEDGER_ENABLED, true);
  const runTrigger = normalizeString(env.RELGRAPH_SYNC_RUN_TRIGGER, 120) || DEFAULT_RUN_TRIGGER;
  const runLedgerFailClosed = parseBooleanEnv(env.RELGRAPH_SYNC_RUN_LEDGER_FAIL_CLOSED, false);
  const args = [
    '--market',
    normalizeString(env.RELGRAPH_SYNC_MARKET, 24).toUpperCase() || DEFAULT_MARKET,
    '--out-dir',
    outDir,
    '--select-updated-since',
    selectUpdatedSince,
    '--select-sources',
    normalizeString(env.RELGRAPH_SYNC_SELECT_SOURCES, 1000) || DEFAULT_SELECT_SOURCES,
    '--select-limit',
    String(parseNumberEnv(env.RELGRAPH_SYNC_SELECT_LIMIT, DEFAULT_SELECT_LIMIT, { min: 1, max: 5000 })),
    '--limit',
    String(parseNumberEnv(env.RELGRAPH_SYNC_LIMIT, DEFAULT_LIMIT, { min: 1, max: 2000 })),
    '--review-limit',
    String(parseNumberEnv(env.RELGRAPH_SYNC_REVIEW_LIMIT, DEFAULT_REVIEW_LIMIT, { min: 1, max: 5000 })),
  ];

  if (skipReview) {
    args.push('--skip-review');
  } else {
    args.push('--cutoff', cutoff);
  }

  pushArg(args, 'source-limit', env.RELGRAPH_SYNC_SOURCE_LIMIT);
  pushArg(args, 'review-min-score', env.RELGRAPH_SYNC_REVIEW_MIN_SCORE);
  pushArg(args, 'review-relation-types', env.RELGRAPH_SYNC_REVIEW_RELATION_TYPES);
  pushArg(args, 'review-exclude-relation-types', env.RELGRAPH_SYNC_REVIEW_EXCLUDE_RELATION_TYPES);
  pushArg(args, 'serving-audit-limit', env.RELGRAPH_SYNC_SERVING_AUDIT_LIMIT);
  pushArg(args, 'serving-audit-examples', env.RELGRAPH_SYNC_SERVING_AUDIT_EXAMPLES);
  pushArg(args, 'max-serving-suppressed-pct', env.RELGRAPH_SYNC_MAX_SERVING_SUPPRESSED_PCT);
  pushArg(args, 'max-serving-suppressed-rows', env.RELGRAPH_SYNC_MAX_SERVING_SUPPRESSED_ROWS);
  pushArg(args, 'fail-on-serving-suppression-reasons', env.RELGRAPH_SYNC_FAIL_ON_SERVING_SUPPRESSION_REASONS);
  pushArg(args, 'renewal-window-days', env.RELGRAPH_SYNC_RENEWAL_WINDOW_DAYS);
  pushArg(args, 'renewal-max-age-days', env.RELGRAPH_SYNC_RENEWAL_MAX_AGE_DAYS);
  pushArg(args, 'lock-stale-after-minutes', env.RELGRAPH_SYNC_LOCK_STALE_AFTER_MINUTES);
  pushArg(args, 'step-timeout-minutes', env.RELGRAPH_SYNC_STEP_TIMEOUT_MINUTES);
  pushArg(args, 'step-timeout-ms', env.RELGRAPH_SYNC_STEP_TIMEOUT_MS);
  pushArg(args, 'db-lock-key', env.RELGRAPH_SYNC_DB_LOCK_KEY);

  pushFlag(args, 'allow-empty-selection', allowEmpty);
  pushFlag(args, 'allow-empty-build', allowEmpty);
  pushFlag(args, 'allow-dupe-ai-approval', parseBooleanEnv(env.RELGRAPH_SYNC_ALLOW_DUPE_AI_APPROVAL, false));
  // Single-pass scoping: review only the anchors this run's build produced (vs the global score-ordered
  // backlog). Default ON so a manifest/selector run reviews what it built; opt out with =false.
  pushFlag(args, 'scope-review-to-build-anchors', parseBooleanEnv(env.RELGRAPH_SYNC_SCOPE_REVIEW_TO_BUILD, true));
  pushFlag(args, 'upsert-serving-state', parseBooleanEnv(env.RELGRAPH_SYNC_UPSERT_SERVING_STATE, false));
  pushFlag(
    args,
    'bootstrap-reviewed-identity-live-read',
    parseBooleanEnv(env.RELGRAPH_SYNC_BOOTSTRAP_REVIEWED_IDENTITY_LIVE_READ, false),
  );
  pushFlag(
    args,
    'allow-review-required-catalog-mirror',
    parseBooleanEnv(env.RELGRAPH_SYNC_ALLOW_REVIEW_REQUIRED_CATALOG_MIRROR, false),
  );
  pushFlag(args, 'skip-build', parseBooleanEnv(env.RELGRAPH_SYNC_SKIP_BUILD, false));
  pushFlag(args, 'skip-validation', parseBooleanEnv(env.RELGRAPH_SYNC_SKIP_VALIDATION, false));
  pushFlag(args, 'skip-serving-audit', parseBooleanEnv(env.RELGRAPH_SYNC_SKIP_SERVING_AUDIT, false));
  pushFlag(args, 'skip-pba-sig-refresh', parseBooleanEnv(env.RELGRAPH_SYNC_SKIP_PBA_SIG_REFRESH, false));
  pushFlag(args, 'skip-renewal', skipRenewal);
  pushFlag(args, 'apply-renewal', applyRenewal);
  pushFlag(args, 'apply-build', applyBuild);
  pushFlag(args, 'apply-review', applyReview);
  pushFlag(args, 'record-run-ledger', recordRunLedger);
  if (recordRunLedger) {
    pushArg(args, 'run-trigger', runTrigger);
    pushFlag(args, 'run-ledger-fail-closed', runLedgerFailClosed);
  }
  if (!dryRun || applyRenewal) {
    args.push('--confirm', WRAPPER_CONFIRM_TOKEN);
  }

  return {
    enabled: true,
    args,
    cutoff: skipReview ? '' : cutoff,
    selectUpdatedSince,
    outDir,
    dryRun,
    applyRenewal,
    skipRenewal,
    recordRunLedger,
    runTrigger: recordRunLedger ? runTrigger : '',
    runLedgerFailClosed: recordRunLedger && runLedgerFailClosed,
  };
}

async function runCron({
  env = process.env,
  now = new Date(),
  cwd = process.cwd(),
  runner,
  ledgerRecorder,
  parseArgsImpl = parseArgs,
  runSyncRoutineImpl = runSyncRoutine,
} = {}) {
  const config = buildCronArgs(env, { now });
  const report = {
    schema_version: 'relationship_graph_sync_routine_cron.v1',
    generated_at: now.toISOString(),
    enabled: config.enabled,
    ok: true,
    skipped: !config.enabled,
    dry_run: config.dryRun,
    apply_renewal: Boolean(config.applyRenewal),
    cutoff: config.cutoff || null,
    select_updated_since: config.selectUpdatedSince || null,
    out_dir: config.outDir || null,
  };
  if (!config.enabled) {
    report.reason = config.reason;
    return report;
  }

  const options = parseArgsImpl(config.args, { now, cwd });
  const summary = await runSyncRoutineImpl(options, { runner, ledgerRecorder, now, cwd });
  report.ok = Boolean(summary && summary.ok);
  report.summary = summary;
  return report;
}

async function main() {
  const report = await runCron();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${formatRoutineFailure(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      const { closePool } = require('../src/db');
      return closePool().catch(() => {});
    });
}

module.exports = {
  buildCronArgs,
  parseBooleanEnv,
  runCron,
};

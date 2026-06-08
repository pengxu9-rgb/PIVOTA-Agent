#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { recordRelationshipGraphRun } = require('../src/services/relationshipGraphRunLedger');
const { APPLY_CONFIRM_TOKEN: ROUTINE_CONFIRM_TOKEN } = require('./run-relationship-graph-routine-job');

const WRAPPER_CONFIRM_TOKEN = 'APPLY_RELGRAPH_SYNC_ROUTINE';
const SYNC_CONFIRM_TOKEN = 'SYNC_REVIEWED_EXTERNAL_SEEDS_TO_CATALOG';
const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 200;
const DEFAULT_REVIEW_LIMIT = 250;
const DEFAULT_LOCK_STALE_AFTER_MINUTES = 180;
const DEFAULT_MAX_SERVING_SUPPRESSED_PCT = 1;
const DEFAULT_MAX_SERVING_SUPPRESSED_ROWS = 25;
const DEFAULT_SELECT_LIMIT = 250;
const DEFAULT_SELECT_SOURCES = ['catalog_products', 'external_product_seeds'];
const DEFAULT_FAIL_REASONS = [
  'ai_approved_dupe_quarantined',
  'candidate_ref_unresolvable_nested_product_prefix',
  'anchor_ref_unresolvable_nested_product_prefix',
];
const OUTPUT_TAIL_CHARS = 12000;

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

function parseNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseDelimitedList(value, fallback = []) {
  const text = normalizeString(value, 5000);
  if (!text) return [...fallback];
  return Array.from(
    new Set(
      text
        .split(/[,\s]+/)
        .map((item) => normalizeString(item, 200).toLowerCase())
        .filter(Boolean),
    ),
  );
}

function dateStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
}

function resolvePathMaybeRelative(filePath, cwd = process.cwd()) {
  const text = normalizeString(filePath, 2000);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function scriptPath(scriptName) {
  return path.join(__dirname, scriptName);
}

function pushArg(args, name, value) {
  if (value == null || value === '') return;
  args.push(`--${name}`, String(value));
}

function pushFlag(args, name, enabled) {
  if (enabled) args.push(`--${name}`);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/run-relationship-graph-sync-routine.js --cutoff <timestamp> (--affected-products-file path | --external-product-ids a,b | --external-product-ids-file path | --select-updated-since timestamp) [--out-dir path]',
    '',
    'Dry-run by default. Writes require --confirm APPLY_RELGRAPH_SYNC_ROUTINE.',
    'When external product IDs are supplied, catalog sync is dry-run unless --apply-sync is passed.',
    'When --select-updated-since or --select-hours is supplied, a read-only affected-products manifest is generated first.',
    'Graph writes require --apply-build and/or --apply-review; routine confirmation is passed through internally.',
    'Production gates are on by default: --db-lock, stale lock recovery, serving suppression thresholds, and critical reason gating.',
    'Use --record-run-ledger to persist run status and counters to relationship_graph_routine_runs.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2), { now = new Date(), cwd = process.cwd() } = {}) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };

  const skipReview = hasFlag(argv, 'skip-review');
  const cutoff = normalizeString(argValue(argv, 'cutoff'), 80);
  if (!skipReview && !cutoff) {
    throw new Error('--cutoff is required unless --skip-review is set');
  }
  if (cutoff && Number.isNaN(new Date(cutoff).getTime())) {
    throw new Error(`invalid --cutoff timestamp: ${cutoff}`);
  }

  const affectedProductsFileInput = normalizeString(argValue(argv, 'affected-products-file'), 2000);
  const externalProductIds = normalizeString(argValue(argv, 'external-product-ids'), 8000);
  const externalProductIdsFile = normalizeString(argValue(argv, 'external-product-ids-file'), 2000);
  const selectHours = parseNumber(argValue(argv, 'select-hours'), 0, { min: 0, max: 24 * 365 });
  const selectUpdatedSinceInput = normalizeString(
    argValue(argv, 'select-updated-since') || argValue(argv, 'updated-since') || argValue(argv, 'since'),
    100,
  );
  const selectUpdatedSince = selectUpdatedSinceInput || (
    selectHours ? new Date(now.getTime() - selectHours * 60 * 60 * 1000).toISOString() : ''
  );
  if (selectUpdatedSince && Number.isNaN(new Date(selectUpdatedSince).getTime())) {
    throw new Error(`invalid --select-updated-since timestamp: ${selectUpdatedSince}`);
  }
  const usesSelector = Boolean(selectUpdatedSince);
  const inputModes = [
    Boolean(affectedProductsFileInput),
    Boolean(externalProductIds || externalProductIdsFile),
    usesSelector,
  ].filter(Boolean).length;
  if (!inputModes) {
    throw new Error(
      '--affected-products-file, --external-product-ids, --external-product-ids-file, or --select-updated-since/--select-hours is required',
    );
  }
  if (inputModes > 1) {
    throw new Error('affected-products, external product ID, and selector inputs are mutually exclusive');
  }

  const applySync = hasFlag(argv, 'apply-sync');
  const applyBuild = hasFlag(argv, 'apply-build');
  const applyReview = hasFlag(argv, 'apply-review');
  const confirm = normalizeString(argValue(argv, 'confirm'), 120);
  if ((applySync || applyBuild || applyReview) && confirm !== WRAPPER_CONFIRM_TOKEN) {
    throw new Error(`write-mode sync routine jobs require --confirm ${WRAPPER_CONFIRM_TOKEN}`);
  }
  if (usesSelector && applySync) {
    throw new Error('--apply-sync requires explicit external product ID inputs; selector mode is read-only');
  }
  if (!affectedProductsFileInput && !usesSelector && !applySync && (applyBuild || applyReview)) {
    throw new Error('graph apply mode cannot follow a dry-run catalog sync; pass --apply-sync or provide --affected-products-file');
  }

  const outDir = resolvePathMaybeRelative(
    argValue(argv, 'out-dir') || path.join('reports', 'product_relationship_graph', `sync_routine_${dateStamp(now)}`),
    cwd,
  );
  const affectedProductsFile = affectedProductsFileInput
    ? resolvePathMaybeRelative(affectedProductsFileInput, cwd)
    : path.join(outDir, 'affected-products.json');
  const syncOut = resolvePathMaybeRelative(argValue(argv, 'sync-out') || path.join(outDir, 'catalog_sync.json'), cwd);
  const routineOutDir = resolvePathMaybeRelative(argValue(argv, 'routine-out-dir') || path.join(outDir, 'routine'), cwd);

  return {
    cutoff,
    market: normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase() || DEFAULT_MARKET,
    outDir,
    summaryOut: resolvePathMaybeRelative(argValue(argv, 'summary-out') || path.join(outDir, 'sync_routine_summary.json'), cwd),
    affectedProductsFile,
    usesExistingAffectedProductsFile: Boolean(affectedProductsFileInput),
    syncOut,
    routineOutDir,
    externalProductIds,
    externalProductIdsFile: externalProductIdsFile ? resolvePathMaybeRelative(externalProductIdsFile, cwd) : '',
    usesSelector,
    selectUpdatedSince,
    selectSources: parseDelimitedList(argValue(argv, 'select-sources'), DEFAULT_SELECT_SOURCES),
    selectLimit: parseNumber(argValue(argv, 'select-limit'), DEFAULT_SELECT_LIMIT, { min: 1, max: 5000 }),
    allowEmptySelection: hasFlag(argv, 'allow-empty-selection') || hasFlag(argv, 'allow-empty'),
    applySync,
    applyBuild,
    applyReview,
    limit: parseNumber(argValue(argv, 'limit'), DEFAULT_LIMIT, { min: 1, max: 2000 }),
    sourceLimit: parseNumber(argValue(argv, 'source-limit'), 0, { min: 0, max: 100000 }),
    reviewLimit: parseNumber(argValue(argv, 'review-limit'), DEFAULT_REVIEW_LIMIT, { min: 1, max: 5000 }),
    reviewMinScore: parseNumber(argValue(argv, 'review-min-score'), 0, { min: 0, max: 1 }),
    reviewRelationTypes: normalizeString(argValue(argv, 'review-relation-types'), 1000),
    reviewExcludeRelationTypes: normalizeString(argValue(argv, 'review-exclude-relation-types'), 1000),
    allowDupeAiApproval: hasFlag(argv, 'allow-dupe-ai-approval'),
    servingAuditLimit: parseNumber(argValue(argv, 'serving-audit-limit'), 0, { min: 0, max: 250000 }),
    servingAuditExamples: parseNumber(argValue(argv, 'serving-audit-examples'), 8, { min: 0, max: 100 }),
    maxServingSuppressedPct: parseNumber(argValue(argv, 'max-serving-suppressed-pct'), DEFAULT_MAX_SERVING_SUPPRESSED_PCT, {
      min: 0,
      max: 100,
    }),
    maxServingSuppressedRows: parseNumber(argValue(argv, 'max-serving-suppressed-rows'), DEFAULT_MAX_SERVING_SUPPRESSED_ROWS, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    failOnServingSuppressionReasons: parseDelimitedList(
      argValue(argv, 'fail-on-serving-suppression-reasons'),
      DEFAULT_FAIL_REASONS,
    ),
    dbLock: !hasFlag(argv, 'no-db-lock'),
    dbLockKey: normalizeString(argValue(argv, 'db-lock-key'), 500),
    lockStaleAfterMinutes: parseNumber(
      argValue(argv, 'lock-stale-after-minutes'),
      DEFAULT_LOCK_STALE_AFTER_MINUTES,
      { min: 0, max: 30 * 24 * 60 },
    ),
    syncBatchSize: parseNumber(argValue(argv, 'sync-batch-size'), 0, { min: 0, max: 500 }),
    upsertServingState: hasFlag(argv, 'upsert-serving-state'),
    bootstrapReviewedIdentityLiveRead: hasFlag(argv, 'bootstrap-reviewed-identity-live-read'),
    allowReviewRequiredCatalogMirror: hasFlag(argv, 'allow-review-required-catalog-mirror'),
    skipBuild: hasFlag(argv, 'skip-build'),
    skipReview,
    skipValidation: hasFlag(argv, 'skip-validation'),
    skipServingAudit: hasFlag(argv, 'skip-serving-audit'),
    skipPbaSigRefresh: hasFlag(argv, 'skip-pba-sig-refresh'),
    allowEmptyBuild: hasFlag(argv, 'allow-empty-build'),
    recordRunLedger: hasFlag(argv, 'record-run-ledger'),
    runTrigger: normalizeString(argValue(argv, 'run-trigger') || argValue(argv, 'ledger-trigger'), 120),
    runLedgerFailClosed: hasFlag(argv, 'run-ledger-fail-closed') || hasFlag(argv, 'ledger-fail-closed'),
  };
}

function serializableOptions(options = {}) {
  return {
    market: options.market,
    cutoff: options.cutoff || null,
    affected_products_file: options.affectedProductsFile,
    uses_existing_affected_products_file: Boolean(options.usesExistingAffectedProductsFile),
    external_product_ids: options.externalProductIds || null,
    external_product_ids_file: options.externalProductIdsFile || null,
    selector: options.usesSelector
      ? {
        updated_since: options.selectUpdatedSince,
        sources: options.selectSources || [],
        limit: options.selectLimit,
        allow_empty_selection: Boolean(options.allowEmptySelection),
      }
      : null,
    dry_run: !(options.applySync || options.applyBuild || options.applyReview),
    apply_sync: Boolean(options.applySync),
    apply_build: Boolean(options.applyBuild),
    apply_review: Boolean(options.applyReview),
    db_lock: Boolean(options.dbLock),
    lock_stale_after_minutes: options.lockStaleAfterMinutes,
    max_serving_suppressed_pct: options.maxServingSuppressedPct,
    max_serving_suppressed_rows: options.maxServingSuppressedRows,
    fail_on_serving_suppression_reasons: options.failOnServingSuppressionReasons || [],
    record_run_ledger: Boolean(options.recordRunLedger),
    run_trigger: options.runTrigger || null,
    run_ledger_fail_closed: Boolean(options.runLedgerFailClosed),
  };
}

function buildSyncRoutineSteps(options = {}) {
  const node = process.execPath;
  const steps = [];

  if (options.usesSelector) {
    const args = [
      scriptPath('select-relationship-graph-affected-products.js'),
      '--market',
      options.market,
      '--updated-since',
      options.selectUpdatedSince,
      '--sources',
      (options.selectSources || DEFAULT_SELECT_SOURCES).join(','),
      '--limit',
      String(options.selectLimit || DEFAULT_SELECT_LIMIT),
      '--out',
      options.affectedProductsFile,
    ];
    pushFlag(args, 'allow-empty-selection', options.allowEmptySelection);
    steps.push({
      id: 'affected_product_selector',
      command: node,
      args,
      artifact: options.affectedProductsFile,
    });
  } else if (!options.usesExistingAffectedProductsFile) {
    const args = [
      scriptPath('sync-external-seeds-to-catalog.cjs'),
      '--market',
      options.market,
      '--affected-products-out',
      options.affectedProductsFile,
      '--out',
      options.syncOut,
    ];
    pushArg(args, 'external-product-ids', options.externalProductIds);
    pushArg(args, 'external-product-ids-file', options.externalProductIdsFile);
    pushArg(args, 'batch-size', options.syncBatchSize || '');
    pushFlag(args, 'upsert-serving-state', options.upsertServingState);
    pushFlag(args, 'bootstrap-reviewed-identity-live-read', options.bootstrapReviewedIdentityLiveRead);
    pushFlag(args, 'allow-review-required-catalog-mirror', options.allowReviewRequiredCatalogMirror);
    if (options.applySync) {
      args.push('--apply', '--confirm', SYNC_CONFIRM_TOKEN);
    } else {
      args.push('--dry-run');
    }
    steps.push({
      id: 'catalog_sync',
      command: node,
      args,
      artifact: options.syncOut,
    });
  }

  const routineArgs = [
    scriptPath('run-relationship-graph-routine-job.js'),
    '--market',
    options.market,
    '--affected-products-file',
    options.affectedProductsFile,
    '--out-dir',
    options.routineOutDir,
    '--limit',
    String(options.limit),
    '--review-limit',
    String(options.reviewLimit),
    '--review-min-score',
    String(options.reviewMinScore),
    '--serving-audit-examples',
    String(options.servingAuditExamples),
    '--max-serving-suppressed-pct',
    String(options.maxServingSuppressedPct),
    '--max-serving-suppressed-rows',
    String(options.maxServingSuppressedRows),
    '--fail-on-serving-suppression-reasons',
    (options.failOnServingSuppressionReasons || []).join(','),
    '--lock-stale-after-minutes',
    String(options.lockStaleAfterMinutes),
  ];
  if (options.skipReview) {
    routineArgs.push('--skip-review');
  } else {
    routineArgs.push('--cutoff', options.cutoff);
  }
  pushArg(routineArgs, 'source-limit', options.sourceLimit || '');
  pushArg(routineArgs, 'review-relation-types', options.reviewRelationTypes);
  pushArg(routineArgs, 'review-exclude-relation-types', options.reviewExcludeRelationTypes);
  pushArg(routineArgs, 'serving-audit-limit', options.servingAuditLimit || '');
  pushFlag(routineArgs, 'allow-dupe-ai-approval', options.allowDupeAiApproval);
  pushFlag(routineArgs, 'db-lock', options.dbLock);
  pushArg(routineArgs, 'db-lock-key', options.dbLockKey);
  pushFlag(routineArgs, 'apply-build', options.applyBuild);
  pushFlag(routineArgs, 'apply-review', options.applyReview);
  if (options.applyBuild || options.applyReview) {
    routineArgs.push('--confirm', ROUTINE_CONFIRM_TOKEN);
  }
  pushFlag(routineArgs, 'skip-build', options.skipBuild);
  pushFlag(routineArgs, 'skip-validation', options.skipValidation);
  pushFlag(routineArgs, 'skip-serving-audit', options.skipServingAudit);
  pushFlag(routineArgs, 'skip-pba-sig-refresh', options.skipPbaSigRefresh);
  pushFlag(routineArgs, 'allow-empty-build', options.allowEmptyBuild);
  steps.push({
    id: 'relationship_graph_routine',
    command: node,
    args: routineArgs,
    artifact: path.join(options.routineOutDir, 'routine_summary.json'),
  });

  return {
    artifacts: {
      affected_products: options.affectedProductsFile,
      affected_product_selector: options.usesSelector ? options.affectedProductsFile : null,
      catalog_sync: options.usesExistingAffectedProductsFile || options.usesSelector ? null : options.syncOut,
      routine_summary: path.join(options.routineOutDir, 'routine_summary.json'),
      summary: options.summaryOut,
    },
    steps,
  };
}

function tailOutput(value, max = OUTPUT_TAIL_CHARS) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(text.length - max);
}

function runCommand(command, args, { cwd = process.cwd(), env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = tailOutput(stdout + chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderr = tailOutput(stderr + chunk.toString());
    });
    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code == null ? 1 : code, stdout, stderr });
    });
  });
}

function writeSummary(filePath, summary) {
  const resolved = resolvePathMaybeRelative(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return resolved;
}

async function recordRunLedgerSafe(summary, options, { ledgerRecorder = recordRelationshipGraphRun } = {}) {
  if (!options.recordRunLedger) return { skipped: true };

  const requestedAt = new Date().toISOString();
  summary.ledger = {
    requested: true,
    recorded: false,
    trigger: options.runTrigger || '',
    requested_at: requestedAt,
  };

  try {
    const record = await ledgerRecorder(summary, {
      runKind: 'sync_routine',
      trigger: options.runTrigger || '',
    });
    summary.ledger = {
      ...summary.ledger,
      recorded: true,
      recorded_at: new Date().toISOString(),
      run_id: record?.run_id || summary.run_id,
      status: record?.status || null,
    };
    return { record };
  } catch (err) {
    summary.ledger = {
      ...summary.ledger,
      recorded: false,
      error_code: err && err.code ? String(err.code) : null,
      error_message: err && err.message ? String(err.message) : String(err),
    };
    return { error: err };
  }
}

async function runSyncRoutine(
  options,
  {
    runner = runCommand,
    cwd = process.cwd(),
    now = new Date(),
    ledgerRecorder = recordRelationshipGraphRun,
  } = {},
) {
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.mkdirSync(options.routineOutDir, { recursive: true });
  const { artifacts, steps } = buildSyncRoutineSteps(options);
  const summary = {
    schema_version: 'relationship_graph_sync_routine.v1',
    run_id: `relgraph_sync_routine_${dateStamp(now)}`,
    generated_at: now.toISOString(),
    out_dir: options.outDir,
    options: serializableOptions(options),
    artifacts,
    steps: [],
    ok: true,
  };
  writeSummary(options.summaryOut, summary);

  for (const step of steps) {
    const startedAt = new Date().toISOString();
    // eslint-disable-next-line no-await-in-loop
    const result = await runner(step.command, step.args, { cwd, env: step.env || {} });
    const record = {
      id: step.id,
      status: result.exitCode === 0 ? 'passed' : 'failed',
      command: step.command,
      args: step.args,
      artifact: step.artifact,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      exit_code: result.exitCode,
      stdout_tail: tailOutput(result.stdout),
      stderr_tail: tailOutput(result.stderr),
    };
    summary.steps.push(record);
    if (result.exitCode !== 0) {
      summary.ok = false;
      summary.failed_step = step.id;
      summary.summary_path = writeSummary(options.summaryOut, summary);
      const err = new Error(`relationship graph sync routine failed at step: ${step.id}`);
      const ledgerResult = await recordRunLedgerSafe(summary, options, { ledgerRecorder });
      summary.summary_path = writeSummary(options.summaryOut, summary);
      if (ledgerResult.error) {
        err.ledger_error = ledgerResult.error;
      }
      err.summary = summary;
      throw err;
    }
    writeSummary(options.summaryOut, summary);
  }

  summary.summary_path = writeSummary(options.summaryOut, summary);
  const ledgerResult = await recordRunLedgerSafe(summary, options, { ledgerRecorder });
  summary.summary_path = writeSummary(options.summaryOut, summary);
  if (ledgerResult.error && options.runLedgerFailClosed) {
    const err = new Error(`relationship graph sync routine ledger recording failed: ${ledgerResult.error.message}`);
    err.code = 'RELGRAPH_RUN_LEDGER_FAILED';
    err.ledger_error = ledgerResult.error;
    err.summary = summary;
    throw err;
  }
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const summary = await runSyncRoutine(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (require.main === module) {
  main().catch((err) => {
    const summary = err && err.summary;
    if (summary) {
      process.stderr.write(`${err.message}\nsummary: ${summary.summary_path || summary.out_dir}\n`);
    } else {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_FAIL_REASONS,
  SYNC_CONFIRM_TOKEN,
  WRAPPER_CONFIRM_TOKEN,
  buildSyncRoutineSteps,
  parseArgs,
  recordRunLedgerSafe,
  runSyncRoutine,
};

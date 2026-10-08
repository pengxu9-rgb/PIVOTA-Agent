#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseTargetRecallOptions, appendTargetRecallArgs } = require('./lib/relationship-graph-target-recall-options');
const { readServingSnapshot, servingProgress, reviewMetrics, readReviewMetrics, reviewErrorGateExceeded } = require('../src/services/relationshipGraphServingProgress');

const { query } = require('../src/db');
const { requireAnchorAttemptsTable } = require('../src/auroraBff/relationshipGraphCoverage');

const { formatRoutineFailure } = require('./lib/format-routine-failure');

const APPLY_CONFIRM_TOKEN = 'APPLY_RELGRAPH_ROUTINE';
const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 200;
const DEFAULT_REVIEW_LIMIT = 250;
const DEFAULT_REVIEW_MIN_SCORE = 0;
const DEFAULT_SERVING_AUDIT_EXAMPLES = 8;
const DEFAULT_STEP_TIMEOUT_MINUTES = 20;
const DEFAULT_SERVING_AUDIT_TIMEOUT_MINUTES = 10;
const DEFAULT_DB_LOCK_HEARTBEAT_MS = 30000;
const OUTPUT_TAIL_CHARS = 12000;
const ROUTINE_LOCK_DIRNAME = 'relationship_graph_routine.lock';
// The serving audit attributes a row to this run when its last_verified_at is
// at or after the run's start. last_verified_at is stamped by the database
// clock and the run start by this process's clock; the allowance only widens
// the run's side (more rows gated), never the legacy side.
const RUN_SCOPE_CLOCK_SKEW_MS = 2 * 60 * 1000;
const DEFAULT_DB_LOCK_KEY = 'pivota.relationship_graph.routine';

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeKey(value, max = 160) {
  return normalizeString(value, max).toLowerCase();
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

function parseLockStaleAfterMs(argv = []) {
  const explicitMs = parseNumber(argValue(argv, 'lock-stale-after-ms'), 0, {
    min: 0,
    max: 30 * 24 * 60 * 60 * 1000,
  });
  if (explicitMs > 0) return Math.trunc(explicitMs);
  const minutes = parseNumber(argValue(argv, 'lock-stale-after-minutes'), 0, {
    min: 0,
    max: 30 * 24 * 60,
  });
  return Math.trunc(minutes * 60 * 1000);
}

function parseStepTimeoutMs(argv = []) {
  const explicitMs = parseNumber(argValue(argv, 'step-timeout-ms'), null, {
    min: 0,
    max: 12 * 60 * 60 * 1000,
  });
  if (explicitMs != null) return Math.trunc(explicitMs);
  const minutes = parseNumber(argValue(argv, 'step-timeout-minutes'), DEFAULT_STEP_TIMEOUT_MINUTES, {
    min: 0,
    max: 12 * 60,
  });
  return Math.trunc(minutes * 60 * 1000);
}

function parseServingAuditTimeoutMs(argv = [], stepTimeoutMs = 0) {
  const explicitMs = parseNumber(argValue(argv, 'serving-audit-timeout-ms'), null, {
    min: 0,
    max: 12 * 60 * 60 * 1000,
  });
  if (explicitMs != null) return Math.trunc(explicitMs);
  const minutesRaw = argValue(argv, 'serving-audit-timeout-minutes');
  const fallbackMs = Math.max(
    Math.trunc(Number(stepTimeoutMs) || 0),
    DEFAULT_SERVING_AUDIT_TIMEOUT_MINUTES * 60 * 1000,
  );
  if (minutesRaw == null || minutesRaw === '') return fallbackMs;
  const minutes = parseNumber(minutesRaw, DEFAULT_SERVING_AUDIT_TIMEOUT_MINUTES, { min: 0, max: 12 * 60 });
  return Math.trunc(minutes * 60 * 1000);
}

function parseDelimitedList(value, max = 5000) {
  return Array.from(new Set(
    normalizeString(value, max)
      .split(/[,\s]+/)
      .map((item) => normalizeKey(item))
      .filter(Boolean),
  ));
}

function dateStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
}

function resolvePathMaybeRelative(filePath, cwd = process.cwd()) {
  const text = normalizeString(filePath, 2000);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function usage() {
  return [
    'Usage:',
    '  node scripts/run-relationship-graph-routine-job.js --cutoff <timestamp> [--market US] [--limit N] [--affected-products-file path] [--out-dir path]',
    '',
    'Dry-run by default. To write generated labels or AI approvals, pass --apply-build and/or --apply-review with --confirm APPLY_RELGRAPH_ROUTINE.',
    'AI review excludes dupe by default. Use --allow-dupe-ai-approval only for a manual, audited run.',
    'Use --max-serving-suppressed-pct and/or --max-serving-suppressed-rows to fail the job when runtime serving guards suppress too many approved edges.',
    'Use --fail-on-serving-suppression-reasons reason_a,reason_b to fail when any listed suppression reason appears.',
    'Serving thresholds gate only the edges this run approved or renewed (last_verified_at at or after --run-started-at,',
    'default: this process start): any such edge the guard suppresses fails the job. Older (legacy) suppressed edges are',
    'reported as legacy_suppressed_* and logged at WARNING, but do not fail it — the read path already hides them.',
    'Use --db-lock for a Postgres advisory lock when running from distributed cron or CI.',
    'Use --lock-stale-after-minutes N only when a killed prior run may have left a local lock behind.',
    'Use --step-timeout-minutes N to fail closed when a child step hangs.',
    'Use --serving-audit-timeout-minutes N to override the serving-audit child timeout separately.',
    'Use --db-lock-heartbeat-ms N to keep the advisory-lock connection active during long child steps.',
    'Review fails above --max-review-error-rate (default 0.25) after --min-reviews-for-error-gate (default 20).',
    'Use --min-approval-confidence (default 0.70, range 0.5..0.99) for AI approvals.',
    'Use --skip-need-nodes for a product-anchor-only canary that does not generate curated need-node candidates.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2), { now = new Date() } = {}) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };

  const skipReview = hasFlag(argv, 'skip-review');
  const cutoff = normalizeString(argValue(argv, 'cutoff'), 80);
  if (!skipReview && !cutoff) {
    throw new Error('--cutoff is required unless --skip-review is set');
  }
  if (cutoff && Number.isNaN(new Date(cutoff).getTime())) {
    throw new Error(`invalid --cutoff timestamp: ${cutoff}`);
  }

  const applyBuild = hasFlag(argv, 'apply-build');
  const applyReview = hasFlag(argv, 'apply-review');
  const confirm = normalizeString(argValue(argv, 'confirm'), 120);
  if ((applyBuild || applyReview) && confirm !== APPLY_CONFIRM_TOKEN) {
    throw new Error(`write-mode routine jobs require --confirm ${APPLY_CONFIRM_TOKEN}`);
  }

  const reviewMode = argValue(argv, 'review-mode', process.env.RELGRAPH_AI_REVIEW_MODE || 'single');
  if (!['single', 'consensus'].includes(reviewMode)) throw new Error('review-mode must be single or consensus');
  const allowDupeAiApproval = hasFlag(argv, 'allow-dupe-ai-approval') || reviewMode === 'consensus';
  const reviewExcludeRelationTypes = normalizeString(argValue(argv, 'review-exclude-relation-types'), 1000)
    || (allowDupeAiApproval ? '' : 'dupe');
  const stepTimeoutMs = parseStepTimeoutMs(argv);
  const runStartedAtInput = normalizeString(argValue(argv, 'run-started-at'), 80);
  if (runStartedAtInput && Number.isNaN(new Date(runStartedAtInput).getTime())) {
    throw new Error(`invalid --run-started-at timestamp: ${runStartedAtInput}`);
  }

  return {
    reviewMode,
    runStartedAt: new Date(runStartedAtInput || now).toISOString(),
    cutoff,
    market: normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase() || DEFAULT_MARKET,
    limit: parseNumber(argValue(argv, 'limit'), DEFAULT_LIMIT, { min: 1, max: 2000 }),
    prioritizeUncovered: hasFlag(argv, 'prioritize-uncovered'),
    ...parseTargetRecallOptions({ hasFlag: (name) => hasFlag(argv, name), argValue: (name) => argValue(argv, name) }),
    coverageSiblingRefs: argValue(argv, 'coverage-sibling-refs', 'true'),
    uncoveredCooldownDays: Math.trunc(parseNumber(argValue(argv, 'uncovered-cooldown-days'), 7, { min: 1, max: 90 })),
    sourceLimit: parseNumber(argValue(argv, 'source-limit'), 0, { min: 0, max: 100000 }),
    anchorOffset: parseNumber(argValue(argv, 'anchor-offset'), 0, { min: 0, max: 1000000 }),
    minReviewsForErrorGate: Math.trunc(parseNumber(argValue(argv, 'min-reviews-for-error-gate'), 20, { min: 1, max: 5000 })),
    maxReviewErrorRate: parseNumber(argValue(argv, 'max-review-error-rate'), 0.25, { min: 0, max: 1 }),
    minApprovalConfidence: parseNumber(argValue(argv, 'min-approval-confidence'), 0.70, { min: 0.5, max: 0.99 }),
    reviewConcurrency: argValue(argv, 'review-concurrency') ? Math.trunc(parseNumber(argValue(argv, 'review-concurrency'), 1, { min: 1, max: 16 })) : '',
    reviewLimit: parseNumber(argValue(argv, 'review-limit'), DEFAULT_REVIEW_LIMIT, { min: 1, max: 5000 }),
    reviewMinScore: parseNumber(argValue(argv, 'review-min-score'), DEFAULT_REVIEW_MIN_SCORE, { min: 0, max: 1 }),
    reviewRelationTypes: normalizeString(argValue(argv, 'review-relation-types'), 1000),
    reviewExcludeRelationTypes,
    servingAuditLimit: parseNumber(argValue(argv, 'serving-audit-limit'), 0, { min: 0, max: 250000 }),
    servingAuditExamples: parseNumber(argValue(argv, 'serving-audit-examples'), DEFAULT_SERVING_AUDIT_EXAMPLES, {
      min: 0,
      max: 100,
    }),
    maxServingSuppressedPct: parseNumber(argValue(argv, 'max-serving-suppressed-pct'), null, { min: 0, max: 100 }),
    maxServingSuppressedRows: parseNumber(argValue(argv, 'max-serving-suppressed-rows'), null, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    }),
    failOnServingSuppressionReasons: parseDelimitedList(argValue(argv, 'fail-on-serving-suppression-reasons')),
    affectedRefs: normalizeString(argValue(argv, 'affected-refs'), 2000),
    affectedRefsFile: normalizeString(argValue(argv, 'affected-refs-file'), 2000),
    affectedProductsFile: normalizeString(argValue(argv, 'affected-products-file'), 2000),
    externalProductIdsFile: normalizeString(argValue(argv, 'external-product-ids-file'), 2000),
    sigIdsFile: normalizeString(argValue(argv, 'sig-ids-file'), 2000),
    contentKeysFile: normalizeString(argValue(argv, 'content-keys-file'), 2000),
    outDir: resolvePathMaybeRelative(
      argValue(argv, 'out-dir') || path.join('reports', `relationship_graph_routine_${dateStamp(now)}`),
    ),
    applyBuild,
    applyReview,
    allowDupeAiApproval,
    lockDir: normalizeString(argValue(argv, 'lock-dir'), 2000),
    lockStaleAfterMs: parseLockStaleAfterMs(argv),
    stepTimeoutMs,
    servingAuditTimeoutMs: parseServingAuditTimeoutMs(argv, stepTimeoutMs),
    dbLock: hasFlag(argv, 'db-lock'),
    dbLockKey: normalizeString(argValue(argv, 'db-lock-key', DEFAULT_DB_LOCK_KEY), 500) || DEFAULT_DB_LOCK_KEY,
    dbLockHeartbeatMs: parseNumber(argValue(argv, 'db-lock-heartbeat-ms'), DEFAULT_DB_LOCK_HEARTBEAT_MS, {
      min: 0,
      max: 60 * 60 * 1000,
    }),
    requireAnchors: !hasFlag(argv, 'allow-empty-build'),
    // Scope the review to the anchors the build produced (single-pass targeted review), instead of the
    // global top-N-by-score backlog — required for manifest/affected-scoped runs to review what they built.
    scopeReviewToBuildAnchors: hasFlag(argv, 'scope-review-to-build-anchors'),
    skipBuild: hasFlag(argv, 'skip-build'),
    skipNeedNodes: hasFlag(argv, 'skip-need-nodes'),
    skipLock: hasFlag(argv, 'skip-lock'),
    skipPbaSigRefresh: hasFlag(argv, 'skip-pba-sig-refresh'),
    skipValidation: hasFlag(argv, 'skip-validation'),
    skipReview,
    skipServingAudit: hasFlag(argv, 'skip-serving-audit'),
  };
}

function scriptPath(scriptName) {
  return path.join(__dirname, scriptName);
}

function pushArg(args, name, value) {
  if (value == null || value === '') return;
  args.push(`--${name}`, String(value));
}

function runScopeVerifiedSince(options = {}) {
  const startedMs = new Date(options.runStartedAt || '').getTime();
  if (!Number.isFinite(startedMs)) return '';
  return new Date(startedMs - RUN_SCOPE_CLOCK_SKEW_MS).toISOString();
}

function buildRoutineSteps(options) {
  const outDir = resolvePathMaybeRelative(options.outDir);
  const artifacts = {
    build: path.join(outDir, 'relationship_graph_build.json'),
    preflight: path.join(outDir, 'relationship_graph_preflight_validation.json'),
    review: path.join(outDir, 'relationship_graph_ai_review.json'),
    serving_audit: path.join(outDir, 'relationship_graph_serving_guard_audit.json'),
  };
  const node = process.execPath;
  const steps = [];
  const hasPbaSigRefreshFilters = Boolean(
    options.affectedProductsFile || options.externalProductIdsFile || options.sigIdsFile,
  );

  if (!options.skipPbaSigRefresh && hasPbaSigRefreshFilters) {
    const args = [
      scriptPath('refresh-product-beauty-attribute-sig-ids.js'),
      '--out',
      path.join(outDir, 'product_beauty_attribute_sig_refresh.json'),
    ];
    pushArg(args, 'affected-products-file', options.affectedProductsFile);
    pushArg(args, 'external-product-ids-file', options.externalProductIdsFile);
    pushArg(args, 'sig-ids-file', options.sigIdsFile);
    // --allow-empty-build already declares that the manifest may yield nothing
    // (a quiet day); the sig refresh reads the same manifest and needs the same
    // tolerance, or the routine dies at its first step on exactly those days
    // (production 2026-08-16T10:37Z: missing_pba_sig_refresh_filter).
    if (!options.requireAnchors) args.push('--allow-empty-filter');
    if (options.applyBuild) {
      args.push('--apply', '--confirm', 'REFRESH_PBA_SIG_IDS');
    }
    steps.push({
      id: 'pba_sig_refresh',
      command: node,
      args,
      artifact: path.join(outDir, 'product_beauty_attribute_sig_refresh.json'),
    });
  }

  if (!options.skipBuild) {
    const args = [
      scriptPath('build-product-relationship-graph.js'),
      '--market',
      options.market,
      '--limit',
      String(options.limit),
      '--anchor-offset',
      String(options.anchorOffset),
      '--out',
      artifacts.build,
    ];
    if (options.prioritizeUncovered) {
      args.push('--prioritize-uncovered');
      pushArg(args, 'uncovered-cooldown-days', options.uncoveredCooldownDays);
      pushArg(args, 'coverage-sibling-refs', options.coverageSiblingRefs);
    }
    if (options.sourceLimit) pushArg(args, 'source-limit', options.sourceLimit);
    appendTargetRecallArgs(args, options);
    pushArg(args, 'affected-refs', options.affectedRefs);
    pushArg(args, 'affected-refs-file', options.affectedRefsFile);
    pushArg(args, 'affected-products-file', options.affectedProductsFile);
    pushArg(args, 'external-product-ids-file', options.externalProductIdsFile);
    pushArg(args, 'sig-ids-file', options.sigIdsFile);
    pushArg(args, 'content-keys-file', options.contentKeysFile);
    if (options.requireAnchors) args.push('--require-anchors');
    if (options.skipNeedNodes) args.push('--skip-need-nodes');
    if (options.applyBuild) args.push('--apply');
    steps.push({ id: 'build', command: node, args, artifact: artifacts.build });
  }

  if (!options.skipValidation) {
    const args = [
      scriptPath('validate-preflight-against-labels.js'),
      '--output',
      artifacts.preflight,
    ];
    pushArg(args, 'limit', options.limit);
    steps.push({ id: 'preflight_validation', command: node, args, artifact: artifacts.preflight });
  }

  if (!options.skipReview) {
    const args = [
      scriptPath('review-relationship-candidate-labels.js'),
      '--cutoff',
      options.cutoff,
      '--min-score',
      String(options.reviewMinScore),
      '--limit',
      String(options.reviewLimit),
      '--out',
      artifacts.review,
    ];
    pushArg(args, 'concurrency', options.reviewConcurrency);
    pushArg(args, 'review-mode', options.reviewMode);
    pushArg(args, 'min-approval-confidence', options.minApprovalConfidence);
    pushArg(args, 'relation-types', options.reviewRelationTypes);
    pushArg(args, 'exclude-relation-types', options.reviewExcludeRelationTypes);
    // Single-pass scoping: review only the anchors this run's build produced (its build report).
    // The review step runs AFTER the build, so artifacts.build exists by then.
    if (options.scopeReviewToBuildAnchors && !options.skipBuild) {
      pushArg(args, 'anchor-refs-from-build', artifacts.build);
    }
    if (options.allowDupeAiApproval) args.push('--allow-dupe-ai-approval');
    if (options.applyReview) args.push('--apply');
    steps.push({
      id: 'ai_review',
      command: node,
      args,
      artifact: artifacts.review,
      env: options.applyReview ? { RELGRAPH_AI_REVIEW_APPLY: '1' } : {},
    });
  }

  if (!options.skipServingAudit) {
    const args = [
      scriptPath('audit-relationship-graph-serving-guard.js'),
      '--market',
      options.market,
      '--examples-per-reason',
      String(options.servingAuditExamples),
      '--out',
      artifacts.serving_audit,
    ];
    if (options.servingAuditLimit) pushArg(args, 'limit', options.servingAuditLimit);
    pushArg(args, 'run-verified-since', runScopeVerifiedSince(options));
    steps.push({
      id: 'serving_guard_audit',
      command: node,
      args,
      artifact: artifacts.serving_audit,
      timeoutMs: options.servingAuditTimeoutMs,
    });
  }

  return { artifacts, steps };
}

function tailOutput(value, max = OUTPUT_TAIL_CHARS) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(text.length - max);
}

function buildLockPath(options = {}) {
  const explicit = normalizeString(options.lockDir, 2000);
  if (explicit) return resolvePathMaybeRelative(explicit);
  const outDir = resolvePathMaybeRelative(options.outDir || path.join('reports', `relationship_graph_routine_${dateStamp()}`));
  return path.join(path.dirname(outDir), ROUTINE_LOCK_DIRNAME);
}

function readRoutineLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch (_err) {
    return null;
  }
}

function isStaleRoutineLockOwner(owner, staleAfterMs, nowMs = Date.now()) {
  if (!(staleAfterMs > 0)) return false;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return false;
  if (!String(owner.run_id || '').startsWith('relgraph_routine_')) return false;
  const startedAtMs = new Date(owner.started_at || '').getTime();
  if (!Number.isFinite(startedAtMs)) return false;
  return nowMs - startedAtMs > staleAfterMs;
}

function acquireRoutineLock(lockDir, metadata = {}, { staleAfterMs = 0, nowMs = Date.now() } = {}) {
  const resolved = resolvePathMaybeRelative(lockDir);
  if (!resolved) {
    const err = new Error('relationship graph routine lock path is required');
    err.code = 'ROUTINE_LOCK_PATH_REQUIRED';
    throw err;
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    fs.mkdirSync(resolved);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const owner = readRoutineLockOwner(resolved);
      if (isStaleRoutineLockOwner(owner, staleAfterMs, nowMs)) {
        fs.rmSync(resolved, { recursive: true, force: true });
        try {
          fs.mkdirSync(resolved);
        } catch (retryErr) {
          if (retryErr && retryErr.code !== 'EEXIST') throw retryErr;
          const held = new Error(`relationship graph routine job already running: ${resolved}`);
          held.code = 'ROUTINE_LOCK_HELD';
          held.lock_dir = resolved;
          held.owner = readRoutineLockOwner(resolved);
          throw held;
        }
      } else {
        const held = new Error(`relationship graph routine job already running: ${resolved}`);
        held.code = 'ROUTINE_LOCK_HELD';
        held.lock_dir = resolved;
        held.owner = owner;
        throw held;
      }
    } else {
      throw err;
    }
  }

  try {
    fs.writeFileSync(path.join(resolved, 'owner.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  } catch (err) {
    fs.rmSync(resolved, { recursive: true, force: true });
    throw err;
  }

  let released = false;
  return function releaseRoutineLock() {
    if (released) return;
    released = true;
    fs.rmSync(resolved, { recursive: true, force: true });
  };
}

function postgresAdvisoryLockParts(lockKey = DEFAULT_DB_LOCK_KEY) {
  const normalized = normalizeString(lockKey, 500) || DEFAULT_DB_LOCK_KEY;
  const digest = crypto.createHash('sha256').update(normalized).digest();
  return {
    lock_key: normalized,
    key_part_1: digest.readInt32BE(0),
    key_part_2: digest.readInt32BE(4),
  };
}

async function acquirePostgresAdvisoryLock(client, lockKey = DEFAULT_DB_LOCK_KEY) {
  if (!client || typeof client.query !== 'function') {
    const err = new Error('Postgres client is required for relationship graph routine DB lock');
    err.code = 'ROUTINE_DB_LOCK_CLIENT_REQUIRED';
    throw err;
  }

  const parts = postgresAdvisoryLockParts(lockKey);
  const params = [parts.key_part_1, parts.key_part_2];
  const res = await client.query(
    'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired',
    params,
  );
  const acquired = Boolean(res && res.rows && res.rows[0] && res.rows[0].acquired);
  if (!acquired) {
    const err = new Error(`relationship graph routine DB advisory lock already held: ${parts.lock_key}`);
    err.code = 'ROUTINE_DB_LOCK_HELD';
    err.lock_key = parts.lock_key;
    err.key_parts = params;
    throw err;
  }

  let released = false;
  return {
    lock: {
      acquired: true,
      lock_key: parts.lock_key,
      key_parts: params,
    },
    release: async () => {
      if (released) return;
      released = true;
      await client.query(
        'SELECT pg_advisory_unlock($1::integer, $2::integer) AS released',
        params,
      );
    },
  };
}

function startPostgresAdvisoryLockHeartbeat(client, { intervalMs = DEFAULT_DB_LOCK_HEARTBEAT_MS } = {}) {
  const resolvedIntervalMs = Math.trunc(Number(intervalMs) || 0);
  if (!(resolvedIntervalMs > 0)) {
    return {
      getError: () => null,
      stop: async () => null,
    };
  }

  let stopped = false;
  let firstError = null;
  let inFlight = Promise.resolve();
  const beat = () => {
    if (stopped || firstError) return;
    inFlight = inFlight.then(async () => {
      if (stopped || firstError) return;
      try {
        await client.query('SELECT 1 AS relationship_graph_routine_db_lock_keepalive');
      } catch (err) {
        firstError = err;
      }
    });
  };
  const timer = setInterval(beat, resolvedIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    getError: () => firstError,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      try {
        await inFlight;
      } catch (err) {
        if (!firstError) firstError = err;
      }
      return firstError;
    },
  };
}

async function withPostgresAdvisoryLock(options = {}, metadata = {}, fn, { withDbClient } = {}) {
  if (!options.dbLock) return fn(null);
  const db = withDbClient ? { withClient: withDbClient } : require('../src/db');
  return db.withClient(async (client) => {
    const { lock, release } = await acquirePostgresAdvisoryLock(client, options.dbLockKey);
    const heartbeat = startPostgresAdvisoryLockHeartbeat(client, {
      intervalMs: options.dbLockHeartbeatMs,
    });
    const lockInfo = {
      ...lock,
      owner: metadata,
    };
    try {
      return await fn(lockInfo, client);
    } finally {
      await heartbeat.stop();
      await release();
    }
  });
}

function hasServingAuditThresholds(options = {}) {
  return (
    options.maxServingSuppressedPct != null ||
    options.maxServingSuppressedRows != null ||
    (Array.isArray(options.failOnServingSuppressionReasons) && options.failOnServingSuppressionReasons.length > 0)
  );
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(resolvePathMaybeRelative(filePath), 'utf8'));
}

function hasRunScope(audit = {}) {
  return Boolean(audit && audit.run_verified_since) && Number.isFinite(Number(audit.run_suppressed_rows));
}

// Run-scoped gate. The reviewer refuses to approve an edge the guard would
// suppress and renewal skips one, so a suppressed edge this run wrote is a
// defect, not drift: one is enough to fail. The fail-on reasons are reported by
// name on the same rows. The whole-table row/percent budgets were a proxy for
// "this run made serving worse"; measured on the whole table they also fire on
// rows a later guard change re-classified, which is what failed 2026-10-02..08.
function evaluateRunScopedServingAuditThresholds(audit, options = {}) {
  const violations = [];
  const runSuppressed = parseNumber(audit.run_suppressed_rows, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const byRunReason = audit.run_suppressed_by_reason && typeof audit.run_suppressed_by_reason === 'object'
    && !Array.isArray(audit.run_suppressed_by_reason)
    ? Object.fromEntries(Object.entries(audit.run_suppressed_by_reason).map(([reason, count]) => [
      normalizeKey(reason),
      parseNumber(count, 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    ]))
    : {};
  if (runSuppressed > 0) {
    violations.push({
      metric: 'run_suppressed_rows',
      observed: runSuppressed,
      max: 0,
      message: `serving guard suppresses ${runSuppressed} approved edges this run approved or renewed`,
    });
  }
  for (const reason of Array.isArray(options.failOnServingSuppressionReasons)
    ? options.failOnServingSuppressionReasons
    : []) {
    const normalizedReason = normalizeKey(reason);
    const count = byRunReason[normalizedReason] || 0;
    if (count > 0) {
      violations.push({
        metric: 'suppression_reason',
        scope: 'run',
        reason: normalizedReason,
        observed: count,
        max: 0,
        message: `serving guard found ${count} approved edges this run wrote suppressed for ${normalizedReason}`,
      });
    }
  }
  return violations;
}

function servingAuditScopeSummary(audit = {}) {
  if (!hasRunScope(audit)) return null;
  const pick = (key, fallback) => (audit[key] == null ? fallback : audit[key]);
  return {
    run_verified_since: audit.run_verified_since,
    run_total_rows: pick('run_total_rows', 0),
    run_suppressed_rows: pick('run_suppressed_rows', 0),
    run_suppressed_pct: pick('run_suppressed_pct', 0),
    run_suppressed_by_reason: pick('run_suppressed_by_reason', {}),
    run_suppressed_examples: pick('run_suppressed_examples', {}),
    legacy_total_rows: pick('legacy_total_rows', 0),
    legacy_suppressed_rows: pick('legacy_suppressed_rows', 0),
    legacy_suppressed_pct: pick('legacy_suppressed_pct', 0),
    legacy_suppressed_by_reason: pick('legacy_suppressed_by_reason', {}),
    legacy_suppressed_examples: pick('legacy_suppressed_examples', {}),
  };
}

function legacySuppressionWarning(scope) {
  if (!scope || !(Number(scope.legacy_suppressed_rows) > 0)) return null;
  return {
    message: `${scope.legacy_suppressed_rows} legacy approved edges are suppressed by the serving guard `
      + '(approved before this run; hidden at read time; not a failure of this run)',
    legacy_suppressed_rows: scope.legacy_suppressed_rows,
    legacy_suppressed_pct: scope.legacy_suppressed_pct,
    legacy_suppressed_by_reason: scope.legacy_suppressed_by_reason,
  };
}

function evaluateServingAuditThresholds(audit = {}, options = {}) {
  // An artifact without the run split (an audit run without --run-verified-since) is
  // gated on the whole table, as before: fail closed, never open.
  if (hasRunScope(audit)) return evaluateRunScopedServingAuditThresholds(audit, options);
  const violations = [];
  const suppressedRows = parseNumber(audit.suppressed_rows, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const suppressedPct = parseNumber(audit.suppressed_pct, 0, { min: 0, max: 100 });
  const maxRows = options.maxServingSuppressedRows;
  const maxPct = options.maxServingSuppressedPct;
  const byReason = audit && audit.by_reason && typeof audit.by_reason === 'object' && !Array.isArray(audit.by_reason)
    ? audit.by_reason
    : {};
  const byNormalizedReason = Object.fromEntries(
    Object.entries(byReason).map(([reason, count]) => [
      normalizeKey(reason),
      parseNumber(count, 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    ]),
  );

  if (maxRows != null && suppressedRows > maxRows) {
    violations.push({
      metric: 'suppressed_rows',
      observed: suppressedRows,
      max: maxRows,
      message: `serving guard suppressed ${suppressedRows} approved edges, above max ${maxRows}`,
    });
  }
  if (maxPct != null && suppressedPct > maxPct) {
    violations.push({
      metric: 'suppressed_pct',
      observed: suppressedPct,
      max: maxPct,
      message: `serving guard suppressed ${suppressedPct}% of approved edges, above max ${maxPct}%`,
    });
  }
  for (const reason of Array.isArray(options.failOnServingSuppressionReasons)
    ? options.failOnServingSuppressionReasons
    : []) {
    const normalizedReason = normalizeKey(reason);
    const count = byNormalizedReason[normalizedReason] || 0;
    if (count > 0) {
      violations.push({
        metric: 'suppression_reason',
        reason: normalizedReason,
        observed: count,
        max: 0,
        message: `serving guard found ${count} approved edges suppressed for ${normalizedReason}`,
      });
    }
  }

  return violations;
}

function runCommand(command, args, { cwd = process.cwd(), env = {}, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timeoutTimer = null;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
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
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr = tailOutput(`${stderr}\nstep timed out after ${timeoutMs}ms; sent SIGTERM`.trim());
        if (!child.killed) child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          stderr = tailOutput(`${stderr}\nstep did not exit after SIGTERM; sent SIGKILL`.trim());
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, timeoutMs);
    }
    child.on('error', (err) => {
      finish({ exitCode: 1, stdout, stderr: `${stderr}\n${err.message}`.trim(), timedOut });
    });
    child.on('close', (code, signal) => {
      finish({
        exitCode: timedOut ? 124 : (code == null ? 1 : code),
        stdout,
        stderr,
        signal: signal || null,
        timedOut,
      });
    });
  });
}

function serializableOptions(options) {
  return {
    market: options.market,
    min_reviews_for_error_gate: options.minReviewsForErrorGate,
    max_review_error_rate: options.maxReviewErrorRate,
    min_approval_confidence: options.minApprovalConfidence,
    cutoff: options.cutoff,
    limit: options.limit,
    source_limit: options.sourceLimit || null,
    anchor_offset: options.anchorOffset,
    review_limit: options.reviewLimit,
    review_concurrency: options.reviewConcurrency || 1,
    review_min_score: options.reviewMinScore,
    review_relation_types: options.reviewRelationTypes || null,
    review_exclude_relation_types: options.reviewExcludeRelationTypes || null,
    serving_audit_limit: options.servingAuditLimit || null,
    max_serving_suppressed_pct: options.maxServingSuppressedPct,
    max_serving_suppressed_rows: options.maxServingSuppressedRows,
    fail_on_serving_suppression_reasons: options.failOnServingSuppressionReasons || [],
    affected_refs: options.affectedRefs || null,
    affected_refs_file: options.affectedRefsFile || null,
    affected_products_file: options.affectedProductsFile || null,
    external_product_ids_file: options.externalProductIdsFile || null,
    sig_ids_file: options.sigIdsFile || null,
    content_keys_file: options.contentKeysFile || null,
    dry_run: !(options.applyBuild || options.applyReview),
    apply_build: options.applyBuild,
    apply_review: options.applyReview,
    step_timeout_ms: options.stepTimeoutMs || null,
    serving_audit_timeout_ms: options.servingAuditTimeoutMs || null,
    run_started_at: options.runStartedAt || null,
    skip_need_nodes: Boolean(options.skipNeedNodes),
    allow_dupe_ai_approval: options.allowDupeAiApproval,
    lock_dir: options.lockDir || null,
    lock_stale_after_ms: options.lockStaleAfterMs || null,
    skip_lock: Boolean(options.skipLock),
    db_lock: Boolean(options.dbLock),
    db_lock_key: options.dbLockKey || null,
    db_lock_heartbeat_ms: options.dbLockHeartbeatMs || null,
  };
}

function writeSummary(outDir, summary) {
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'routine_summary.json');
  fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return target;
}

async function runRoutineJob(
  options,
  { runner = runCommand, cwd = process.cwd(), now = new Date(), withDbClient, progressReader = readServingSnapshot, reviewReader = readReviewMetrics, preflightQueryFn = query } = {},
) {
  const outDir = resolvePathMaybeRelative(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const { artifacts, steps } = buildRoutineSteps({ ...options, outDir });
  const lockDir = buildLockPath({ ...options, outDir });
  const runId = `relgraph_routine_${dateStamp(now)}`;
  const releaseLock = options.skipLock
    ? null
    : acquireRoutineLock(lockDir, {
      run_id: runId,
      pid: process.pid,
      started_at: now.toISOString(),
      out_dir: outDir,
    }, {
      staleAfterMs: options.lockStaleAfterMs || 0,
      nowMs: now.getTime(),
    });
  const summary = {
    run_id: runId,
    generated_at: now.toISOString(),
    out_dir: outDir,
    lock_dir: lockDir,
    lock_acquired: !options.skipLock,
    db_lock: {
      requested: Boolean(options.dbLock),
      acquired: false,
      lock_key: options.dbLockKey || DEFAULT_DB_LOCK_KEY,
    },
    options: serializableOptions(options),
    artifacts,
    steps: [],
    ok: true,
    ...reviewMetrics({}),
    served_edges_before: null,
    served_edges_after: null,
    distinct_anchors_served_before: null,
    distinct_anchors_served_after: null,
    anchors_newly_covered: null,
  };

  let beforeSnapshot;
  async function executeSteps(dbLockClient) {
    let reviewGateFailed = false;
    if (options.prioritizeUncovered) {
      try {
        // Direct affected-products manifests bypass selection. Check before the
        // first child (including pba_sig_refresh), not just inside the builder.
        // The default db.query resets its shared pool on transient errors.
        // Use the held client here so a reset cannot wait on this callback.
        const preflightQuery = preflightQueryFn === query && dbLockClient
          ? dbLockClient.query.bind(dbLockClient) : preflightQueryFn;
        await requireAnchorAttemptsTable(preflightQuery);
      } catch (error) {
        summary.ok = false;
        summary.failed_step = 'uncovered_priority_preflight';
        error.summary = summary;
        throw error;
      }
    }
    try {
      beforeSnapshot = await progressReader({ market: options.market });
    } catch (error) {
      summary.ok = false;
      summary.failed_step = 'serving_progress_before';
      summary.serving_progress_error = error.message;
      error.summary = summary;
      throw error;
    }
    for (const step of steps) {
      const startedAt = new Date().toISOString();
      // eslint-disable-next-line no-await-in-loop
      const timeoutMs = step.timeoutMs != null ? step.timeoutMs : options.stepTimeoutMs || 0;
      const result = await runner(step.command, step.args, {
        cwd,
        env: step.env || {},
        timeoutMs,
      });
      const record = {
        id: step.id,
        status: result.exitCode === 0 ? 'passed' : 'failed',
        command: step.command,
        args: step.args,
        artifact: step.artifact,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        exit_code: result.exitCode,
        signal: result.signal || null,
        timed_out: Boolean(result.timedOut),
        timeout_ms: timeoutMs || null,
        stdout_tail: tailOutput(result.stdout),
        stderr_tail: tailOutput(result.stderr),
      };
      summary.steps.push(record);
      if (step.id === 'ai_review') {
        try {
          Object.assign(summary, reviewReader(step.artifact, { required: result.exitCode === 0 }));
          if (result.exitCode === 0 && reviewErrorGateExceeded(summary, options)) {
            record.status = 'failed';
            record.exit_code = 1;
            record.threshold_status = 'failed';
            reviewGateFailed = true;
            summary.ok = false;
            summary.failed_step = 'ai_review';
            record.stderr_tail = `review error rate ${summary.review_error_rate} exceeds ${options.maxReviewErrorRate}`;
          }
        } catch (error) {
          record.status = 'failed';
          record.exit_code = 1;
          record.stderr_tail = error.message;
          result.exitCode = 1;
        }
      }
      if (result.exitCode !== 0) {
        summary.ok = false;
        summary.failed_step = step.id;
        summary.summary_path = writeSummary(outDir, summary);
        const err = new Error(`relationship graph routine job failed at step: ${step.id}`);
        err.summary = summary;
        throw err;
      }

      if (step.id === 'serving_guard_audit') {
        // Reported whether or not thresholds are set: the legacy backlog is
        // worth seeing even on runs that do not gate on it.
        let scope = null;
        try {
          scope = servingAuditScopeSummary(readJsonFile(step.artifact));
        } catch (_err) {
          scope = null; // the threshold block below reports an unreadable artifact when it gates
        }
        if (scope) {
          summary.serving_audit_scope = scope;
          record.serving_audit_scope = {
            run_suppressed_rows: scope.run_suppressed_rows,
            legacy_suppressed_rows: scope.legacy_suppressed_rows,
          };
          const warning = legacySuppressionWarning(scope);
          if (warning) {
            summary.warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
            summary.warnings.push(warning.message);
            process.stderr.write(`${JSON.stringify({ severity: 'WARNING', run_id: runId, ...warning })}\n`);
          }
        }
      }

      if (step.id === 'serving_guard_audit' && hasServingAuditThresholds(options)) {
        let audit;
        try {
          audit = readJsonFile(step.artifact);
        } catch (readErr) {
          record.status = 'failed';
          record.threshold_status = 'failed';
          record.threshold_error = readErr.message;
          summary.ok = false;
          summary.failed_step = 'serving_guard_audit_thresholds';
          summary.summary_path = writeSummary(outDir, summary);
          const err = new Error('relationship graph routine job could not read serving audit artifact for threshold evaluation');
          err.code = 'SERVING_AUDIT_THRESHOLD_READ_FAILED';
          err.summary = summary;
          throw err;
        }

        const violations = evaluateServingAuditThresholds(audit, options);
        record.threshold_status = violations.length ? 'failed' : 'passed';
        record.threshold_violations = violations;
        if (violations.length) {
          record.status = 'failed';
          summary.ok = false;
          summary.failed_step = 'serving_guard_audit_thresholds';
          summary.summary_path = writeSummary(outDir, summary);
          const err = new Error('relationship graph routine job failed serving audit thresholds');
          err.code = 'SERVING_AUDIT_THRESHOLD_VIOLATION';
          err.violations = violations;
          err.summary = summary;
          throw err;
        }
      }

      writeSummary(outDir, summary);
    }

    if (reviewGateFailed) {
      summary.ok = false;
      summary.failed_step = 'ai_review';
      summary.summary_path = writeSummary(outDir, summary);
      const error = new Error('relationship graph routine job failed at step: ai_review');
      error.summary = summary;
      throw error;
    }
    summary.summary_path = writeSummary(outDir, summary);
    return summary;
  }

  try {
    return await withPostgresAdvisoryLock(
      options,
      {
        run_id: runId,
        pid: process.pid,
        started_at: now.toISOString(),
        out_dir: outDir,
      },
      async (dbLockInfo, dbLockClient) => {
        if (dbLockInfo) {
          summary.db_lock = {
            requested: true,
            acquired: true,
            lock_key: dbLockInfo.lock_key,
            key_parts: dbLockInfo.key_parts,
          };
          writeSummary(outDir, summary);
        }
        try {
          return await executeSteps(dbLockClient);
        } finally {
          if (beforeSnapshot) {
            try {
              Object.assign(summary, servingProgress(beforeSnapshot, await progressReader({ market: options.market })));
            } catch (error) {
              summary.ok = false;
              summary.failed_step = summary.failed_step || 'serving_progress';
              summary.serving_progress_error = error.message;
              error.summary = summary;
              throw error;
            } finally {
              summary.summary_path = writeSummary(outDir, summary);
            }
          }
        }
      },
      { withDbClient },
    );
  } catch (err) {
    if (!err.summary) {
      summary.ok = false;
      summary.failed_step = options.dbLock && summary.steps.length === 0 ? 'db_advisory_lock' : 'routine_job';
      if (options.dbLock) {
        summary.db_lock = {
          ...summary.db_lock,
          acquired: false,
          error_code: err && err.code ? err.code : null,
          error_message: err && err.message ? err.message : String(err),
        };
      }
      summary.summary_path = writeSummary(outDir, summary);
      err.summary = summary;
    }
    summary.summary_path = writeSummary(outDir, summary);
    throw err;
  } finally {
    if (releaseLock) releaseLock();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const summary = await runRoutineJob(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (require.main === module) {
  main()
    .catch((err) => {
      // This process is spawned by the sync routine, which captures only our
      // stderr — so the inner step's exit code and stderr have to be printed
      // here or they die with the container along with the /tmp summary. Before
      // this, a cron failure reported "failed at step: pba_sig_refresh" and
      // nothing about why that step exited non-zero.
      process.stderr.write(`${formatRoutineFailure(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => {
      const { closePool } = require('../src/db');
      closePool().catch(() => {});
    });
}

module.exports = {
  APPLY_CONFIRM_TOKEN,
  RUN_SCOPE_CLOCK_SKEW_MS,
  acquireRoutineLock,
  acquirePostgresAdvisoryLock,
  buildLockPath,
  buildRoutineSteps,
  postgresAdvisoryLockParts,
  evaluateServingAuditThresholds,
  runScopeVerifiedSince,
  parseArgs,
  runCommand,
  runRoutineJob,
  startPostgresAdvisoryLockHeartbeat,
  withPostgresAdvisoryLock,
};

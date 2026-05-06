const logger = require('../logger');
const { query } = require('../db');
const { hasCatalogImageCacheConfig } = require('./catalogImageCacheStorage');

const runnerState = {
  scheduled: false,
  schedule_reason: 'not_initialized',
  started_at: null,
  last_tick_at: null,
  last_job_id: null,
  last_error: null,
  last_summary: null,
  processing: false,
};

let intervalHandle = null;
let timeoutHandle = null;

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback, { min = 1, max = 500 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeFetchMode(value) {
  const normalized = normalizeString(value || 'auto').toLowerCase();
  return ['auto', 'direct', 'browser'].includes(normalized) ? normalized : 'auto';
}

function buildRunnerConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.CATALOG_IMAGE_CACHE_JOB_RUNNER_ENABLED, true),
    intervalMs: parsePositiveInteger(env.CATALOG_IMAGE_CACHE_JOB_RUNNER_INTERVAL_MS, 30000, {
      min: 5000,
      max: 10 * 60 * 1000,
    }),
    initialDelayMs: parsePositiveInteger(env.CATALOG_IMAGE_CACHE_JOB_RUNNER_INITIAL_DELAY_MS, 10000, {
      min: 0,
      max: 10 * 60 * 1000,
    }),
    maxJobsPerTick: parsePositiveInteger(env.CATALOG_IMAGE_CACHE_JOB_RUNNER_MAX_JOBS_PER_TICK, 1, {
      min: 1,
      max: 10,
    }),
  };
}

async function claimNextJob() {
  const res = await query(
    `
      UPDATE external_seed_image_cache_jobs
      SET status = 'running',
          attempts = attempts + 1,
          locked_at = now(),
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = (
        SELECT id
        FROM external_seed_image_cache_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `,
  );
  return res.rows?.[0] || null;
}

function buildBackfillArgsFromJob(job) {
  const filters = job?.filters && typeof job.filters === 'object' && !Array.isArray(job.filters)
    ? job.filters
    : {};
  const productId = normalizeString(filters.product_id || filters.productId);
  const limit = parsePositiveInteger(filters.limit, productId ? 1 : 25, { min: 1, max: 500 });
  return {
    apply: true,
    dryRun: false,
    brand: normalizeString(filters.brand),
    host: normalizeString(filters.host).toLowerCase(),
    productId,
    market: normalizeString(filters.market || 'US').toUpperCase(),
    limit: productId ? 1 : limit,
    offset: parsePositiveInteger(filters.offset, 0, { min: 0, max: 100000 }),
    fetchMode: normalizeFetchMode(filters.fetch_mode || filters.fetchMode),
    forceCache: parseBoolean(filters.force_cache ?? filters.forceCache, true),
    out: normalizeString(filters.out),
    timeoutMs: parsePositiveInteger(
      filters.timeout_ms || filters.timeoutMs || process.env.CATALOG_IMAGE_CACHE_FETCH_TIMEOUT_MS,
      8000,
      { min: 1000, max: 60000 },
    ),
  };
}

async function markJobSucceeded(jobId, report) {
  const result = {
    mode: report?.mode || 'apply',
    generated_at: report?.generated_at || new Date().toISOString(),
    filters: report?.filters || null,
    summary: report?.summary || null,
    plans: Array.isArray(report?.plans)
      ? report.plans.map((plan) => ({
          external_product_id: plan.external_product_id || null,
          title: plan.title || null,
          changed: Boolean(plan.changed),
          visible_image_url_count: Array.isArray(plan.visible_image_urls) ? plan.visible_image_urls.length : 0,
          asset_count: Number(plan.asset_count || 0),
          quarantine_count: Number(plan.quarantine_count || 0),
        }))
      : [],
  };
  await query(
    `
      UPDATE external_seed_image_cache_jobs
      SET status = 'succeeded',
          result = $2::jsonb,
          error = NULL,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [jobId, JSON.stringify(result)],
  );
  runnerState.last_summary = result.summary || null;
}

async function markJobFailed(jobId, error) {
  const message = error?.message || String(error);
  await query(
    `
      UPDATE external_seed_image_cache_jobs
      SET status = 'failed',
          error = $2,
          completed_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [jobId, message],
  );
  runnerState.last_error = message;
}

async function processImageCacheJob(job) {
  const script = require('../../scripts/backfill-external-seed-image-cache.cjs');
  const run = script?._internals?.run;
  if (typeof run !== 'function') throw new Error('Image cache backfill runner is unavailable');
  const args = buildBackfillArgsFromJob(job);
  logger.info(
    {
      job_id: job.id,
      product_id: args.productId || null,
      brand: args.brand || null,
      host: args.host || null,
      market: args.market || null,
      limit: args.limit,
      force_cache: args.forceCache,
      fetch_mode: args.fetchMode,
    },
    'Processing external seed image cache job',
  );
  const report = await run(args);
  await markJobSucceeded(job.id, report);
  logger.info({ job_id: job.id, summary: report?.summary || null }, 'External seed image cache job complete');
}

async function runImageCacheJobRunnerTick(env = process.env) {
  const config = buildRunnerConfig(env);
  runnerState.last_tick_at = new Date().toISOString();
  runnerState.last_error = null;
  if (!config.enabled) {
    runnerState.schedule_reason = 'disabled';
    return { processed: 0, reason: 'disabled' };
  }
  if (!env.DATABASE_URL) {
    runnerState.schedule_reason = 'missing_database_url';
    return { processed: 0, reason: 'missing_database_url' };
  }
  if (!hasCatalogImageCacheConfig()) {
    runnerState.schedule_reason = 'missing_storage_config';
    return { processed: 0, reason: 'missing_storage_config' };
  }
  if (runnerState.processing) return { processed: 0, reason: 'already_processing' };

  runnerState.processing = true;
  let processed = 0;
  try {
    for (let idx = 0; idx < config.maxJobsPerTick; idx += 1) {
      const job = await claimNextJob();
      if (!job) break;
      runnerState.last_job_id = job.id;
      try {
        await processImageCacheJob(job);
      } catch (error) {
        await markJobFailed(job.id, error).catch((markErr) => {
          logger.warn(
            { job_id: job.id, err: markErr?.message || String(markErr) },
            'Failed to mark image cache job failed',
          );
        });
        logger.error(
          { job_id: job.id, err: error?.message || String(error) },
          'External seed image cache job failed',
        );
      }
      processed += 1;
    }
    runnerState.schedule_reason = 'scheduled';
    return { processed };
  } finally {
    runnerState.processing = false;
  }
}

function scheduleExternalSeedImageCacheJobRunner(env = process.env) {
  const config = buildRunnerConfig(env);
  if (!config.enabled) {
    runnerState.scheduled = false;
    runnerState.schedule_reason = 'disabled';
    return { scheduled: false, reason: 'disabled', config };
  }
  if (!env.DATABASE_URL) {
    runnerState.scheduled = false;
    runnerState.schedule_reason = 'missing_database_url';
    return { scheduled: false, reason: 'missing_database_url', config };
  }
  runnerState.scheduled = true;
  runnerState.schedule_reason = 'scheduled';
  runnerState.started_at = new Date().toISOString();
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  timeoutHandle = setTimeout(() => {
    runImageCacheJobRunnerTick(env).catch((err) => {
      runnerState.last_error = err?.message || String(err);
      logger.warn({ err: runnerState.last_error }, 'External seed image cache job runner tick failed');
    });
    intervalHandle = setInterval(() => {
      runImageCacheJobRunnerTick(env).catch((err) => {
        runnerState.last_error = err?.message || String(err);
        logger.warn({ err: runnerState.last_error }, 'External seed image cache job runner tick failed');
      });
    }, config.intervalMs);
  }, config.initialDelayMs);
  return { scheduled: true, config };
}

function getExternalSeedImageCacheJobRunnerStatus(env = process.env) {
  const config = buildRunnerConfig(env);
  return {
    enabled: config.enabled,
    storage_configured: hasCatalogImageCacheConfig(),
    database_configured: Boolean(env.DATABASE_URL),
    interval_ms: config.intervalMs,
    max_jobs_per_tick: config.maxJobsPerTick,
    state: { ...runnerState },
  };
}

module.exports = {
  buildBackfillArgsFromJob,
  buildRunnerConfig,
  getExternalSeedImageCacheJobRunnerStatus,
  runImageCacheJobRunnerTick,
  scheduleExternalSeedImageCacheJobRunner,
  _internals: {
    claimNextJob,
    parseBoolean,
    parsePositiveInteger,
  },
};

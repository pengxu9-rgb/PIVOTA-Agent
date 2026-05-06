const path = require('path');

const logger = require('../logger');

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

function parseProductIds(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasRunnableFilter(config) {
  return Boolean(config.productIds.length || config.brand || config.host);
}

function buildBootstrapConfig(env = process.env) {
  const productIds = parseProductIds(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_PRODUCT_IDS);
  const brand = normalizeString(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_BRAND);
  const host = normalizeString(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_HOST).toLowerCase();
  const market = normalizeString(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_MARKET || 'US').toUpperCase();
  const fetchMode = normalizeString(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_FETCH_MODE || 'auto').toLowerCase();
  const safeFetchMode = ['auto', 'direct', 'browser'].includes(fetchMode) ? fetchMode : 'auto';

  const config = {
    enabled: parseBoolean(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_ENABLED, false),
    apply: parseBoolean(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_APPLY, false),
    forceCache: parseBoolean(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_FORCE_CACHE, false),
    productIds,
    brand,
    host,
    market,
    limit: parsePositiveInteger(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_LIMIT, productIds.length || 25, {
      min: 1,
      max: 500,
    }),
    fetchMode: safeFetchMode,
    delayMs: parsePositiveInteger(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_DELAY_MS, 5000, {
      min: 0,
      max: 10 * 60 * 1000,
    }),
    out: normalizeString(env.CATALOG_IMAGE_CACHE_BOOTSTRAP_OUT),
  };
  config.runnable = config.enabled && hasRunnableFilter(config);
  return config;
}

function buildReportPath(config, env = process.env) {
  if (config.out) return config.out;
  const deploymentId = normalizeString(env.RAILWAY_DEPLOYMENT_ID || env.DEPLOYMENT_ID || 'local');
  const mode = config.apply ? 'apply' : 'dry-run';
  const target =
    config.productIds[0] ||
    config.brand ||
    config.host ||
    'filtered';
  const safeTarget = target.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80);
  return path.join(
    'reports',
    'runtime_ops',
    'external-seed-image-cache-bootstrap',
    `${deploymentId}-${safeTarget}-${mode}.json`,
  );
}

async function runExternalSeedImageCacheBootstrap(env = process.env) {
  const config = buildBootstrapConfig(env);
  if (!config.enabled) {
    return { skipped: true, reason: 'disabled', config };
  }
  if (!hasRunnableFilter(config)) {
    logger.warn(
      {
        env: [
          'CATALOG_IMAGE_CACHE_BOOTSTRAP_PRODUCT_IDS',
          'CATALOG_IMAGE_CACHE_BOOTSTRAP_BRAND',
          'CATALOG_IMAGE_CACHE_BOOTSTRAP_HOST',
        ],
      },
      'Catalog image cache bootstrap enabled without a product, brand, or host filter; skipping',
    );
    return { skipped: true, reason: 'missing_filter', config };
  }
  if (!env.DATABASE_URL) {
    logger.warn('Catalog image cache bootstrap skipped because DATABASE_URL is not configured');
    return { skipped: true, reason: 'missing_database_url', config };
  }

  const script = require('../../scripts/backfill-external-seed-image-cache.cjs');
  const run = script?._internals?.run;
  if (typeof run !== 'function') {
    throw new Error('Image cache backfill runner is unavailable');
  }

  const reportPath = buildReportPath(config, env);
  const commonArgs = {
    apply: config.apply,
    dryRun: !config.apply,
    brand: config.brand,
    host: config.host,
    market: config.market,
    limit: config.limit,
    offset: 0,
    fetchMode: config.fetchMode,
    forceCache: config.forceCache,
    out: reportPath,
    timeoutMs: parsePositiveInteger(env.CATALOG_IMAGE_CACHE_FETCH_TIMEOUT_MS, 8000, {
      min: 1000,
      max: 60000,
    }),
  };

  const productIds = config.productIds.length ? config.productIds : [''];
  const reports = [];
  for (const productId of productIds) {
    const args = {
      ...commonArgs,
      productId,
      limit: productId ? 1 : commonArgs.limit,
      out: productId && productIds.length > 1
        ? reportPath.replace(/\.json$/i, `-${productId}.json`)
        : reportPath,
    };
    logger.info(
      {
        product_id: productId || null,
        brand: args.brand || null,
        host: args.host || null,
        market: args.market || null,
        limit: args.limit,
        mode: args.apply ? 'apply' : 'dry_run',
        force_cache: args.forceCache,
        fetch_mode: args.fetchMode,
        out: args.out,
      },
      'Starting catalog image cache bootstrap backfill',
    );
    const report = await run(args);
    logger.info(
      {
        product_id: productId || null,
        summary: report?.summary || null,
        mode: report?.mode || null,
      },
      'Catalog image cache bootstrap backfill complete',
    );
    reports.push(report);
  }
  return { skipped: false, config, reports };
}

function scheduleExternalSeedImageCacheBootstrap(env = process.env) {
  const config = buildBootstrapConfig(env);
  if (!config.enabled) return { scheduled: false, reason: 'disabled', config };
  if (!hasRunnableFilter(config)) return { scheduled: false, reason: 'missing_filter', config };
  setTimeout(() => {
    runExternalSeedImageCacheBootstrap(env).catch((err) => {
      logger.error({ err: err?.message || String(err) }, 'Catalog image cache bootstrap backfill failed');
    });
  }, config.delayMs);
  return { scheduled: true, config };
}

module.exports = {
  buildBootstrapConfig,
  buildReportPath,
  runExternalSeedImageCacheBootstrap,
  scheduleExternalSeedImageCacheBootstrap,
  _internals: {
    hasRunnableFilter,
    parseBoolean,
    parseProductIds,
  },
};

#!/usr/bin/env node
'use strict';

const {
  runExtraction,
  resolveProviderConfig,
} = require('./extract-product-beauty-attributes');
const { query, closePool } = require('../src/db');

const DEFAULT_LIMIT = 50;
const DEFAULT_ALERT_THRESHOLD = 100;
const HARD_LIMIT_MAX = 500;

const GAP_SQL = `
  SELECT count(DISTINCT external_product_id)::int AS gap
  FROM external_product_seeds
  WHERE external_product_id LIKE 'ext_%'
    AND external_product_id NOT IN (SELECT product_key FROM product_beauty_attributes)
`;

async function fetchGapSize(queryFn) {
  const r = await queryFn(GAP_SQL);
  return r?.rows?.[0]?.gap ?? null;
}

function parsePositiveInt(raw, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function runDeltaJob({
  queryFn,
  runExtractionFn,
  providerConfig,
  limit,
  alertThreshold,
  startedAt = new Date().toISOString(),
  now = Date.now,
} = {}) {
  const t0 = now();

  if (!providerConfig?.apiKey || providerConfig.kind === 'missing') {
    return {
      metric: {
        ts: startedAt,
        job: 'pba_delta_extract',
        status: 'config_error',
        reason: 'missing_llm_credentials',
        gap_size_pre: await fetchGapSize(queryFn).catch(() => null),
        gap_size_post: null,
        products_attempted: 0,
        products_classified: 0,
        products_failed: 0,
        duration_ms: now() - t0,
        alert_threshold_exceeded: false,
      },
      exitCode: 2,
    };
  }

  const gapPre = await fetchGapSize(queryFn);
  if (gapPre === 0) {
    return {
      metric: {
        ts: startedAt,
        job: 'pba_delta_extract',
        status: 'noop',
        provider: providerConfig.provider,
        model: providerConfig.model,
        gap_size_pre: 0,
        gap_size_post: 0,
        products_attempted: 0,
        products_classified: 0,
        products_failed: 0,
        estimated_cost_usd: 0,
        duration_ms: now() - t0,
        alert_threshold_exceeded: false,
      },
      exitCode: 0,
    };
  }

  let summary = null;
  let runError = null;
  try {
    summary = await runExtractionFn({
      apply: true,
      limit,
      universeSource: 'external_seed',
      providerConfig,
      queryFn,
    });
  } catch (err) {
    runError = String(err?.message || err);
  }

  const gapPost = await fetchGapSize(queryFn);
  const alertFired = gapPost != null && gapPost > alertThreshold;

  return {
    metric: {
      ts: startedAt,
      job: 'pba_delta_extract',
      status: runError ? 'partial' : 'ok',
      provider: providerConfig.provider,
      model: providerConfig.model,
      gap_size_pre: gapPre,
      gap_size_post: gapPost,
      products_attempted: summary?.attempted ?? 0,
      products_classified: summary?.successful ?? 0,
      products_failed: summary?.failed ?? 0,
      estimated_cost_usd: summary?.estimated_cost_usd ?? null,
      duration_ms: now() - t0,
      alert_threshold_exceeded: alertFired,
      ...(runError ? { error: runError } : {}),
    },
    exitCode: 0,
  };
}

async function main({ env = process.env } = {}) {
  if (!env.DATABASE_URL) {
    process.stderr.write('FATAL: DATABASE_URL is required\n');
    process.exitCode = 1;
    return;
  }

  const limit = parsePositiveInt(env.PBA_DELTA_LIMIT, DEFAULT_LIMIT, { min: 1, max: HARD_LIMIT_MAX });
  const alertThreshold = parsePositiveInt(env.PBA_DELTA_ALERT_GAP_THRESHOLD, DEFAULT_ALERT_THRESHOLD, { min: 0 });
  const providerConfig = resolveProviderConfig(env);

  const { metric, exitCode } = await runDeltaJob({
    queryFn: query,
    runExtractionFn: runExtraction,
    providerConfig,
    limit,
    alertThreshold,
  });

  process.stdout.write(`${JSON.stringify(metric)}\n`);
  if (metric.alert_threshold_exceeded) {
    process.stderr.write(
      `[pba_delta_extract] ALERT: gap_size_post=${metric.gap_size_post} exceeds threshold=${alertThreshold} — backlog growing\n`,
    );
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closePool();
      } catch {
        // ignored
      }
    });
}

module.exports = {
  runDeltaJob,
  fetchGapSize,
  parsePositiveInt,
  GAP_SQL,
  DEFAULT_LIMIT,
  DEFAULT_ALERT_THRESHOLD,
  HARD_LIMIT_MAX,
  main,
};

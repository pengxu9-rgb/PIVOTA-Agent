#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { query, closePool } = require('../src/db');
const {
  buildImageAssetBackfillPlanForRow,
  collectExternalSeedImageCandidates,
  fetchImageForCache,
  shouldCacheOriginalImageUrl,
  sourceHostFromUrl,
} = require('../src/services/externalSeedImageCache');
const {
  hasCatalogImageCacheConfig,
  putCatalogImageCacheObject,
} = require('../src/services/catalogImageCacheStorage');

function argValue(name, argv = process.argv) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!/^https?:\/\//i.test(normalized)) return '';
  try {
    return new URL(normalized).toString();
  } catch {
    return '';
  }
}

function writeJsonFile(filePath, value) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv = process.argv) {
  const fetchMode = normalizeNonEmptyString(argValue('fetch-mode', argv) || 'auto').toLowerCase();
  if (!['auto', 'direct', 'browser'].includes(fetchMode)) {
    throw new Error('--fetch-mode must be auto, direct, or browser');
  }
  const limitArg = argValue('limit', argv);
  const offsetArg = argValue('offset', argv);
  return {
    apply: hasFlag('apply', argv),
    dryRun: hasFlag('dry-run', argv) || !hasFlag('apply', argv),
    brand: normalizeNonEmptyString(argValue('brand', argv)),
    host: normalizeNonEmptyString(argValue('host', argv)).toLowerCase(),
    productId: normalizeNonEmptyString(argValue('product-id', argv)),
    market: normalizeNonEmptyString(argValue('market', argv)).toUpperCase(),
    limit: limitArg == null ? 50 : Math.max(1, Number(limitArg) || 50),
    offset: Math.max(0, Number(offsetArg || 0) || 0),
    fetchMode,
    forceCache: hasFlag('force-cache', argv),
    out: argValue('out', argv) || '',
    timeoutMs: Math.max(1000, Number(argValue('timeout-ms', argv) || process.env.CATALOG_IMAGE_CACHE_FETCH_TIMEOUT_MS || 8000) || 8000),
  };
}

async function fetchRows(args) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (args.market) where.push(`market = ${bind(args.market)}`);
  if (args.brand) {
    where.push(`
      lower(coalesce(
        seed_data->>'brand',
        seed_data->'snapshot'->>'brand',
        ''
      )) = lower(${bind(args.brand)})
    `);
  }
  if (args.productId) {
    const b = bind(args.productId);
    where.push(`
      (
        external_product_id = ${b}
        OR seed_data->>'external_product_id' = ${b}
        OR seed_data->'snapshot'->>'external_product_id' = ${b}
      )
    `);
  }
  if (args.host) {
    const hostPattern = `%${args.host}%`;
    where.push(`(lower(coalesce(domain, '')) = lower(${bind(args.host)}) OR lower(seed_data::text) LIKE lower(${bind(hostPattern)}))`);
  }
  const res = await query(
    `
      SELECT id, external_product_id, market, tool, domain, canonical_url, destination_url, title, image_url, seed_data
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT ${bind(args.limit)}
      OFFSET ${bind(args.offset)}
    `,
    params,
  );
  return res.rows || [];
}

async function findExistingCachedUrlBySha(sha256) {
  const digest = normalizeNonEmptyString(sha256).toLowerCase();
  if (!digest) return '';
  const res = await query(
    `
      SELECT cached_url
      FROM external_seed_image_assets
      WHERE sha256 = $1
        AND cached_url IS NOT NULL
        AND cached_url <> ''
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [digest],
  );
  return normalizeUrlLike(res.rows?.[0]?.cached_url);
}

async function upsertImageAssetRecord({ row, candidate, check }) {
  const externalProductId = normalizeNonEmptyString(row.external_product_id) || normalizeNonEmptyString(row.seed_data?.external_product_id);
  await query(
    `
      INSERT INTO external_seed_image_assets (
        external_product_id,
        external_seed_id,
        original_url,
        cached_url,
        source_url,
        source_host,
        status,
        reason_codes,
        sha256,
        content_type,
        bytes,
        width,
        height,
        fetched_at,
        fetch_method,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
      ON CONFLICT (external_product_id, original_url)
      DO UPDATE SET
        cached_url = EXCLUDED.cached_url,
        source_url = EXCLUDED.source_url,
        source_host = EXCLUDED.source_host,
        status = EXCLUDED.status,
        reason_codes = EXCLUDED.reason_codes,
        sha256 = EXCLUDED.sha256,
        content_type = EXCLUDED.content_type,
        bytes = EXCLUDED.bytes,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        fetched_at = EXCLUDED.fetched_at,
        fetch_method = EXCLUDED.fetch_method,
        updated_at = now()
    `,
    [
      externalProductId,
      normalizeNonEmptyString(row.id),
      candidate.url,
      normalizeUrlLike(check.cached_url) || null,
      normalizeUrlLike(row.canonical_url) || normalizeUrlLike(row.destination_url) || null,
      candidate.source_host || sourceHostFromUrl(candidate.url) || null,
      normalizeNonEmptyString(check.status || 'unchecked'),
      Array.isArray(check.reason_codes) ? check.reason_codes : [],
      normalizeNonEmptyString(check.sha256) || null,
      normalizeNonEmptyString(check.content_type) || null,
      Number.isFinite(Number(check.bytes)) ? Number(check.bytes) : null,
      Number.isFinite(Number(check.width)) ? Number(check.width) : null,
      Number.isFinite(Number(check.height)) ? Number(check.height) : null,
      check.fetched_at || null,
      normalizeNonEmptyString(check.fetch_method) || null,
    ],
  );
}

function summarize(plans) {
  const summary = {
    rows_scanned: plans.length,
    rows_changed: plans.filter((plan) => plan.changed).length,
    visible_image_url_count: plans.reduce((sum, plan) => sum + plan.visible_image_urls.length, 0),
    asset_count: plans.reduce((sum, plan) => sum + plan.asset_count, 0),
    quarantine_count: plans.reduce((sum, plan) => sum + plan.quarantine_count, 0),
    status_counts: {},
    host_counts: {},
  };
  for (const plan of plans) {
    [...plan.assets, ...plan.quarantine_assets].forEach((asset) => {
      const status = asset.status || 'unknown';
      const host = asset.source_host || 'unknown';
      summary.status_counts[status] = (summary.status_counts[status] || 0) + 1;
      summary.host_counts[host] = (summary.host_counts[host] || 0) + 1;
    });
  }
  return summary;
}

async function buildChecksForRow(row, args) {
  const candidates = collectExternalSeedImageCandidates(row);
  const checksByUrl = {};
  for (const candidate of candidates) {
    const check = await fetchImageForCache(candidate.url, {
      fetchMode: args.fetchMode,
      timeoutMs: args.timeoutMs,
      sourceUrl: normalizeUrlLike(row.canonical_url) || normalizeUrlLike(row.destination_url) || '',
    });
    const needsCache = check.ok && shouldCacheOriginalImageUrl(candidate.url, { forceCache: args.forceCache });
    if (args.apply && needsCache) {
      if (!hasCatalogImageCacheConfig()) {
        throw new Error(
          'Catalog image cache storage is not configured; refusing to rewrite visible images without cached_url',
        );
      } else if (check.body && check.sha256) {
        const existing = await findExistingCachedUrlBySha(check.sha256);
        if (existing) {
          check.cached_url = existing;
        } else {
          const uploaded = await putCatalogImageCacheObject({
            body: check.body,
            contentType: check.content_type,
            sha256: check.sha256,
          });
          check.cached_url = uploaded.cached_url;
        }
        check.status = 'cached';
      }
    }
    const { body: _body, ...serializableCheck } = check;
    checksByUrl[candidate.url] = serializableCheck;
  }
  return checksByUrl;
}

async function applyPlan(row, plan, checksByUrl) {
  const candidates = collectExternalSeedImageCandidates(row);
  for (const candidate of candidates) {
    await upsertImageAssetRecord({ row, candidate, check: checksByUrl[candidate.url] || {} });
  }
  if (!plan.changed) return;
  await query(
    `
      UPDATE external_product_seeds
      SET seed_data = $2::jsonb,
          image_url = NULLIF($3, ''),
          updated_at = now()
      WHERE id = $1
    `,
    [row.id, JSON.stringify(plan.next_seed_data), plan.visible_image_urls[0] || ''],
  );
}

async function run(args = parseArgs()) {
  const rows = await fetchRows(args);
  const plans = [];
  for (const row of rows) {
    const checksByUrl = await buildChecksForRow(row, args);
    const plan = buildImageAssetBackfillPlanForRow(row, checksByUrl, { forceCache: args.forceCache });
    if (args.apply) {
      await applyPlan(row, plan, checksByUrl);
    }
    plans.push({
      seed_id: plan.seed_id,
      external_product_id: plan.external_product_id,
      title: row.title,
      brand: row.seed_data?.brand || row.seed_data?.snapshot?.brand || null,
      domain: row.domain,
      changed: plan.changed,
      visible_image_urls: plan.visible_image_urls,
      asset_count: plan.asset_count,
      quarantine_count: plan.quarantine_count,
      assets: plan.assets,
      quarantine_assets: plan.quarantine_assets,
      ...(args.dryRun ? { next_seed_data: plan.next_seed_data } : {}),
    });
  }
  const report = {
    mode: args.apply ? 'apply' : 'dry_run',
    generated_at: new Date().toISOString(),
    filters: {
      brand: args.brand || null,
      host: args.host || null,
      product_id: args.productId || null,
      market: args.market || null,
      limit: args.limit,
      offset: args.offset,
      fetch_mode: args.fetchMode,
    },
    summary: summarize(plans),
    plans,
  };
  if (args.out) writeJsonFile(args.out, report);
  return report;
}

if (require.main === module) {
  run()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => null));
}

module.exports = {
  _internals: {
    applyPlan,
    buildChecksForRow,
    fetchRows,
    parseArgs,
    run,
    summarize,
  },
};

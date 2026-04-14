#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const { query } = require('../src/db');
const { ensureJsonObject, collectSeedImageUrls } = require('../src/services/externalSeedProducts');
const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  normalizeTargetUrlForMarket,
} = require('./backfill-external-product-seeds-catalog');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  process.env.CATALOG_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';
const PRODUCT_URL_PATTERN = '(?:/products?/|/p/|/product/|\\.html(?:[?#]|$))';

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickFirstString(...values) {
  for (const value of values) {
    const normalized = normalizeNonEmptyString(value);
    if (normalized) return normalized;
  }
  return '';
}

function countArrayLike(value) {
  return Array.isArray(value) ? value.length : 0;
}

function collectProductImageUrls(product = {}) {
  const out = [];
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append);
      return;
    }
    const normalized = normalizeUrlLike(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };
  append(product.image_url);
  append(product.image_urls);
  append(product.images);
  normalizeArray(product.variants).forEach((variant) => {
    append(variant?.image_url);
    append(variant?.image_urls);
    append(variant?.images);
  });
  return out;
}

function buildSeedStats(row = {}) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const imageUrls = collectSeedImageUrls(seedData, row);
  const description = pickFirstString(
    seedData.pdp_description_raw,
    snapshot.pdp_description_raw,
    snapshot.description_raw,
    seedData.description_raw,
    seedData.description,
    snapshot.description,
  );
  const detailsSections = [
    ...normalizeArray(seedData.pdp_details_sections),
    ...normalizeArray(snapshot.pdp_details_sections),
    ...normalizeArray(seedData.details_sections),
    ...normalizeArray(snapshot.details_sections),
  ];
  const faqItems = [
    ...normalizeArray(seedData.pdp_faq_items),
    ...normalizeArray(snapshot.pdp_faq_items),
    ...normalizeArray(seedData.faq_items),
    ...normalizeArray(snapshot.faq_items),
  ];
  const howToUse = pickFirstString(
    seedData.pdp_how_to_use_raw,
    snapshot.pdp_how_to_use_raw,
    seedData.how_to_use_raw,
    snapshot.how_to_use_raw,
  );
  return {
    image_count: imageUrls.length,
    description_chars: description.length,
    details_sections_count: detailsSections.length,
    how_to_use_chars: howToUse.length,
    faq_count: faqItems.length,
  };
}

function buildExtractorStats(product = {}) {
  const description = pickFirstString(product.description_raw, product.description);
  return {
    image_count: collectProductImageUrls(product).length,
    description_chars: description.length,
    details_sections_count: countArrayLike(product.details_sections),
    how_to_use_chars: normalizeNonEmptyString(product.how_to_use_raw).length,
    faq_count: countArrayLike(product.faq_items),
  };
}

function getSeedUnderfillFlags(stats, options = {}) {
  const imageUnderfillMax = Number(options.imageUnderfillMax ?? 1);
  const shortDescriptionChars = Number(options.shortDescriptionChars ?? 220);
  const flags = [];
  if (stats.image_count <= imageUnderfillMax) flags.push('image_underfilled');
  if (stats.description_chars < shortDescriptionChars) flags.push('short_description');
  if (stats.details_sections_count === 0) flags.push('no_details_sections');
  if (stats.how_to_use_chars === 0) flags.push('no_how_to_use');
  if (stats.faq_count === 0) flags.push('no_faq_items');
  return flags;
}

function classifyCatalogRecovery(seedStats, extractorStats, options = {}) {
  const imageUnderfillMax = Number(options.imageUnderfillMax ?? 1);
  const shortDescriptionChars = Number(options.shortDescriptionChars ?? 220);
  const flags = [];
  if (seedStats.image_count <= imageUnderfillMax && extractorStats.image_count >= Math.max(3, seedStats.image_count + 2)) {
    flags.push('image_gallery_recoverable');
  }
  if (
    seedStats.description_chars < shortDescriptionChars &&
    extractorStats.description_chars >= shortDescriptionChars &&
    extractorStats.description_chars >= seedStats.description_chars + 80
  ) {
    flags.push('description_recoverable');
  }
  if (seedStats.details_sections_count === 0 && extractorStats.details_sections_count > 0) {
    flags.push('details_sections_recoverable');
  }
  if (seedStats.how_to_use_chars === 0 && extractorStats.how_to_use_chars > 0) {
    flags.push('how_to_use_recoverable');
  }
  if (seedStats.faq_count === 0 && extractorStats.faq_count > 0) {
    flags.push('faq_recoverable');
  }
  return flags;
}

function buildClassification({ seedUnderfillFlags, recoveryFlags, extractorError }) {
  if (extractorError) return 'extractor_probe_failed';
  if (recoveryFlags.length > 0) return 'stale_seed_backfill_recoverable';
  if (seedUnderfillFlags.length > 0) return 'extractor_underfilled_or_source_missing';
  return 'healthy';
}

function buildCandidateRowsSql(options = {}) {
  const where = [
    `status = 'active'`,
    `attached_product_key IS NULL`,
    `market = $1`,
    `(tool = '*' OR tool = 'creator_agents')`,
  ];
  const params = [options.market];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (options.seedId) where.push(`id::text = ${bind(options.seedId)}`);
  if (options.externalProductId) where.push(`external_product_id = ${bind(options.externalProductId)}`);
  if (options.domain) where.push(`domain = ${bind(options.domain)}`);
  if (options.brand) where.push(`lower(coalesce(seed_data->>'brand', seed_data->'snapshot'->>'brand', '')) = lower(${bind(options.brand)})`);

  const productPredicate = options.includeNonProducts ? 'TRUE' : `target_url ~* ${bind(PRODUCT_URL_PATTERN)}`;
  const underfillPredicate = options.includeFilled
    ? 'TRUE'
    : `
      (
        approx_image_count <= ${bind(Number(options.imageUnderfillMax ?? 1))}
        OR approx_description_chars < ${bind(Number(options.shortDescriptionChars ?? 220))}
        OR approx_details_sections_count = 0
        OR approx_how_to_use_chars = 0
        OR approx_faq_count = 0
      )
    `;

  params.push(Number(options.limit));
  const limitBind = `$${params.length}`;
  params.push(Number(options.offset));
  const offsetBind = `$${params.length}`;

  const sql = `
    WITH scoped AS (
      SELECT
        id,
        external_product_id,
        market,
        tool,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        coalesce(seed_data, '{}'::jsonb) AS seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at,
        coalesce(
          nullif(canonical_url, ''),
          nullif(destination_url, ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->'snapshot'->>'canonical_url', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->>'canonical_url', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->'snapshot'->>'destination_url', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->>'destination_url', '')
        ) AS target_url,
        greatest(
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'image_urls') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'image_urls') ELSE 0 END,
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'image_urls') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'image_urls') ELSE 0 END,
          CASE WHEN image_url IS NOT NULL AND image_url <> '' THEN 1 ELSE 0 END
        ) AS approx_image_count,
        char_length(coalesce(
          nullif(coalesce(seed_data, '{}'::jsonb)->>'pdp_description_raw', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->'snapshot'->>'pdp_description_raw', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->>'description_raw', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->'snapshot'->>'description_raw', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->>'description', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->'snapshot'->>'description', ''),
          ''
        )) AS approx_description_chars,
        greatest(
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'pdp_details_sections') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'pdp_details_sections') ELSE 0 END,
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'pdp_details_sections') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'pdp_details_sections') ELSE 0 END,
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'details_sections') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'details_sections') ELSE 0 END,
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'details_sections') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'details_sections') ELSE 0 END
        ) AS approx_details_sections_count,
        char_length(coalesce(
          nullif(coalesce(seed_data, '{}'::jsonb)->>'pdp_how_to_use_raw', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->'snapshot'->>'pdp_how_to_use_raw', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->>'how_to_use_raw', ''),
          nullif(coalesce(seed_data, '{}'::jsonb)->'snapshot'->>'how_to_use_raw', ''),
          ''
        )) AS approx_how_to_use_chars,
        greatest(
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'pdp_faq_items') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'pdp_faq_items') ELSE 0 END,
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'pdp_faq_items') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'pdp_faq_items') ELSE 0 END,
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'faq_items') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'faq_items') ELSE 0 END,
          CASE WHEN jsonb_typeof(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'faq_items') = 'array'
            THEN jsonb_array_length(coalesce(seed_data, '{}'::jsonb)->'snapshot'->'faq_items') ELSE 0 END
        ) AS approx_faq_count
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
    )
    SELECT
      id,
      external_product_id,
      market,
      tool,
      destination_url,
      canonical_url,
      domain,
      title,
      image_url,
      price_amount,
      price_currency,
      availability,
      seed_data,
      status,
      attached_product_key,
      created_at,
      updated_at,
      target_url,
      approx_image_count,
      approx_description_chars,
      approx_details_sections_count,
      approx_how_to_use_chars,
      approx_faq_count
    FROM scoped
    WHERE target_url IS NOT NULL
      AND ${productPredicate}
      AND ${underfillPredicate}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;

  return { sql, params };
}

async function fetchCandidateRows(options) {
  const { sql, params } = buildCandidateRowsSql(options);
  const res = await query(sql, params);
  return res.rows || [];
}

async function extractCatalogTruth(row, options) {
  const targetUrl = normalizeTargetUrlForMarket(pickSeedTargetUrl(row), row?.market);
  if (!targetUrl) return { target_url: '', response: null, product: null, error: 'missing_target_url' };
  const response = await axios.post(
    `${options.catalogBaseUrl.replace(/\/$/, '')}/api/extract`,
    buildExtractRequestBody(targetUrl, row),
    {
      timeout: Number(process.env.CATALOG_INTELLIGENCE_TIMEOUT_MS || 90000),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  const data = response.data || {};
  const product = chooseRepresentativeProduct(data, targetUrl, row);
  return {
    target_url: targetUrl,
    response: data,
    product,
    error: null,
  };
}

async function auditRowAgainstCatalog(row, options) {
  const seedStats = buildSeedStats(row);
  const seedUnderfillFlags = getSeedUnderfillFlags(seedStats, options);
  try {
    const extractor = await extractCatalogTruth(row, options);
    const extractorStats = buildExtractorStats(extractor.product || {});
    const recoveryFlags = classifyCatalogRecovery(seedStats, extractorStats, options);
    return {
      seed_id: row.id,
      external_product_id: row.external_product_id,
      domain: row.domain,
      market: row.market,
      title: row.title,
      target_url: extractor.target_url || row.target_url || pickSeedTargetUrl(row),
      seed_underfill_flags: seedUnderfillFlags,
      recovery_flags: recoveryFlags,
      classification: buildClassification({ seedUnderfillFlags, recoveryFlags, extractorError: extractor.error }),
      seed_stats: seedStats,
      extractor_stats: extractorStats,
      extractor_diagnostics: extractor.response?.diagnostics || null,
      recommended_action:
        recoveryFlags.length > 0
          ? 'run_catalog_backfill_after_catalog_extractor_deploy'
          : seedUnderfillFlags.length > 0
            ? 'inspect_extractor_or_source_site'
            : 'none',
    };
  } catch (error) {
    return {
      seed_id: row.id,
      external_product_id: row.external_product_id,
      domain: row.domain,
      market: row.market,
      title: row.title,
      target_url: row.target_url || pickSeedTargetUrl(row),
      seed_underfill_flags: seedUnderfillFlags,
      recovery_flags: [],
      classification: 'extractor_probe_failed',
      seed_stats: seedStats,
      extractor_stats: null,
      extractor_error: String(error?.message || error || 'unknown_error'),
      recommended_action: 'retry_or_inspect_catalog_extractor',
    };
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeResults(results) {
  const summary = {
    scanned: results.length,
    by_classification: {},
    by_recovery_flag: {},
    by_seed_underfill_flag: {},
    recoverable_external_product_ids: [],
    top_recoverable_domains: [],
  };
  const domainCounts = new Map();
  results.forEach((result) => {
    summary.by_classification[result.classification] = (summary.by_classification[result.classification] || 0) + 1;
    result.seed_underfill_flags.forEach((flag) => {
      summary.by_seed_underfill_flag[flag] = (summary.by_seed_underfill_flag[flag] || 0) + 1;
    });
    result.recovery_flags.forEach((flag) => {
      summary.by_recovery_flag[flag] = (summary.by_recovery_flag[flag] || 0) + 1;
    });
    if (result.classification === 'stale_seed_backfill_recoverable') {
      if (result.external_product_id) summary.recoverable_external_product_ids.push(result.external_product_id);
      const key = result.domain || 'unknown';
      domainCounts.set(key, (domainCounts.get(key) || 0) + 1);
    }
  });
  summary.recoverable_external_product_ids = [...new Set(summary.recoverable_external_product_ids)];
  summary.top_recoverable_domains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([domain, count]) => ({ domain, count }));
  return summary;
}

async function main() {
  const options = {
    market: normalizeNonEmptyString(argValue('market') || 'US').toUpperCase(),
    seedId: argValue('seed-id') || argValue('seedId') || null,
    externalProductId: argValue('external-product-id') || argValue('externalProductId') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    limit: Math.max(1, Math.min(Number(argValue('limit') || 50), 1000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    concurrency: Math.max(1, Math.min(Number(argValue('concurrency') || 3), 10)),
    imageUnderfillMax: Math.max(0, Number(argValue('image-underfill-max') || 1)),
    shortDescriptionChars: Math.max(20, Number(argValue('short-description-chars') || 220)),
    includeFilled: hasFlag('include-filled') || hasFlag('includeFilled'),
    includeNonProducts: hasFlag('include-non-products') || hasFlag('includeNonProducts'),
    catalogBaseUrl: DEFAULT_CATALOG_BASE_URL,
    out: argValue('out') || null,
  };
  const rows = await fetchCandidateRows(options);
  const results = await mapWithConcurrency(rows, options.concurrency, (row) => auditRowAgainstCatalog(row, options));
  const payload = {
    options: {
      ...options,
      catalogBaseUrl: options.catalogBaseUrl.replace(/\/\/[^/@]+@/, '//***@'),
    },
    summary: summarizeResults(results),
    results,
  };
  const output = `${JSON.stringify(payload, null, 2)}\n`;
  if (options.out) {
    ensureParentDir(options.out);
    fs.writeFileSync(options.out, output, 'utf8');
  }
  process.stdout.write(output);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  PRODUCT_URL_PATTERN,
  buildSeedStats,
  buildExtractorStats,
  getSeedUnderfillFlags,
  classifyCatalogRecovery,
  buildClassification,
  buildCandidateRowsSql,
  summarizeResults,
};

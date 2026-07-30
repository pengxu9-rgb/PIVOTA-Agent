#!/usr/bin/env node
'use strict';

/**
 * Recall-lane parity harness (Phase 0 of ADR-020 unified commerce index lanes,
 * docs/ADR-020-unified-commerce-index-lanes.md).
 *
 * Replays a query corpus through BOTH recall lanes and diffs the results so we
 * can enumerate the actual recall gaps between them before unifying:
 *
 *   Lane A (seed lane)    — `searchLocalExternalSeedProducts` from
 *                           src/auroraBff/routes.js (`__internal`), the staged
 *                           external_product_seeds scan used by chat grounding.
 *   Lane B (catalog lane) — `fetchCanonicalChainRows` from
 *                           src/services/canonicalCatalogSearch.js, the
 *                           canonical-chain catalog_products read.
 *
 * Both lanes run their own SELECT-only SQL through the shared pg pool; this
 * script performs NO writes.
 *
 * Identities are joined across lanes by, in priority order:
 *   1. external_product_id — seed items carry it directly; catalog rows that
 *      mirror external seeds encode it in the product_key suffix
 *      `prod::external_seed::external_seed::<external_product_id>` (see
 *      scripts/sync-external-seeds-to-catalog.cjs) and in source_product_id
 *      when platform = 'external_seed'.
 *   2. pivota_signature_id equality.
 *   3. content_key equality.
 *   4. Normalized brand+title fallback.
 *
 * Usage:
 *   node scripts/audit-recall-lane-parity.cjs \
 *     [--corpus /path/to/corpus.jsonl] \
 *     [--limit 8] [--max-queries 50] [--market US] \
 *     [--out reports/recall_lane_parity.json]
 *
 * Corpus format: JSONL, one object per line with a `query` string field
 * (eval_corpus_recall_v1.jsonl schema: {query, page, limit, lang, bucket}).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CORPUS_PATH =
  '/Users/pengchydan/dev/pivota-agent-ui/scripts/eval_corpus_recall_v1.jsonl';
const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_QUERIES = 50;
const EXTERNAL_SEED_PRODUCT_KEY_PREFIX = 'prod::external_seed::external_seed::';
const TOP_ONLY_IN_SEED_TITLES = 20;

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function asString(value) {
  return String(value == null ? '' : value).trim();
}

// ---------------------------------------------------------------------------
// Pure normalization / join / aggregate helpers (exported for tests).
// ---------------------------------------------------------------------------

function normalizeText(value) {
  return asString(value)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBrandTitleKey(brand, title) {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) return '';
  return `${normalizeText(brand)}|${normalizedTitle}`;
}

/**
 * Truncate one lane's raw rows to the per-lane limit BEFORE normalization.
 * fetchCanonicalChainRows returns up to limit*6 flattened chain rows; overlap@k
 * must compare the top-k of each lane, so slice to `limit` first.
 */
function truncateToLaneLimit(rows, limit) {
  const list = Array.isArray(rows) ? rows : [];
  const max = Math.trunc(Number(limit));
  if (!Number.isFinite(max) || max <= 0) return list.slice();
  return list.slice(0, max);
}

/**
 * Extract the external_product_id from a catalog product_key minted by
 * scripts/sync-external-seeds-to-catalog.cjs
 * (`prod::external_seed::external_seed::<external_product_id>`).
 * Returns '' for non-external-seed product keys.
 */
function externalProductIdFromProductKey(productKey) {
  const key = asString(productKey);
  if (!key.startsWith(EXTERNAL_SEED_PRODUCT_KEY_PREFIX)) return '';
  return key.slice(EXTERNAL_SEED_PRODUCT_KEY_PREFIX.length).trim();
}

/**
 * Normalize a seed-lane product (buildLocalExternalSeedSurfacingCandidate
 * output from routes.js / buildExternalSeedProduct) into an identity tuple.
 */
function normalizeSeedLaneItem(product) {
  if (!product || typeof product !== 'object') return null;
  const externalProductId = asString(
    product.external_product_id ||
      product.external_seed_product_id ||
      product.source_product_id ||
      product.platform_product_id ||
      product.product_id,
  );
  const title = asString(product.title);
  const brand = asString(product.brand || product.vendor);
  if (!externalProductId && !title) return null;
  return {
    lane: 'seed',
    external_product_id: externalProductId || null,
    product_key: null,
    pivota_signature_id: asString(product.pivota_signature_id || product.signature_id) || null,
    content_key: asString(product.content_key) || null,
    title,
    brand,
  };
}

/**
 * Normalize a catalog-lane row (fetchCanonicalChainRows flattened
 * canonical-chain row) into an identity tuple.
 */
function normalizeCatalogLaneItem(row) {
  if (!row || typeof row !== 'object') return null;
  const productKey = asString(row.product_key);
  const bridged = externalProductIdFromProductKey(productKey);
  const sourceProductId =
    asString(row.platform) === 'external_seed' ? asString(row.source_product_id) : '';
  const title = asString(row.product_title || row.title);
  const brand = asString(row.brand);
  if (!productKey && !title) return null;
  return {
    lane: 'catalog',
    external_product_id: bridged || sourceProductId || null,
    product_key: productKey || null,
    pivota_signature_id: asString(row.pivota_signature_id) || null,
    content_key: asString(row.content_key) || null,
    title,
    brand,
  };
}

/**
 * Join keys for one normalized identity tuple, strongest first.
 */
function identityJoinKeys(item) {
  const keys = [];
  if (!item || typeof item !== 'object') return keys;
  if (item.external_product_id) keys.push(`ext::${asString(item.external_product_id)}`);
  if (item.pivota_signature_id) keys.push(`sig::${asString(item.pivota_signature_id)}`);
  if (item.content_key) keys.push(`ck::${asString(item.content_key)}`);
  const brandTitle = normalizeBrandTitleKey(item.brand, item.title);
  if (brandTitle) keys.push(`bt::${brandTitle}`);
  return keys;
}

function summarizeItem(item) {
  return {
    title: item.title || null,
    brand: item.brand || null,
    ...(item.external_product_id ? { external_product_id: item.external_product_id } : {}),
    ...(item.product_key ? { product_key: item.product_key } : {}),
    ...(item.pivota_signature_id ? { pivota_signature_id: item.pivota_signature_id } : {}),
    ...(item.content_key ? { content_key: item.content_key } : {}),
  };
}

/**
 * Join two normalized item lists by any shared identity key.
 * Returns matched pairs plus per-lane leftovers.
 */
function joinLaneItems(seedItems, catalogItems) {
  const seed = (Array.isArray(seedItems) ? seedItems : []).filter(Boolean);
  const catalog = (Array.isArray(catalogItems) ? catalogItems : []).filter(Boolean);

  const catalogByKey = new Map();
  catalog.forEach((item, idx) => {
    for (const key of identityJoinKeys(item)) {
      if (!catalogByKey.has(key)) catalogByKey.set(key, []);
      catalogByKey.get(key).push(idx);
    }
  });

  const matchedCatalogIdx = new Set();
  const matches = [];
  const onlyInSeed = [];

  for (const seedItem of seed) {
    let match = null;
    for (const key of identityJoinKeys(seedItem)) {
      const candidates = catalogByKey.get(key);
      if (!candidates) continue;
      const idx = candidates.find((i) => !matchedCatalogIdx.has(i));
      if (idx == null) continue;
      matchedCatalogIdx.add(idx);
      match = { key, catalogItem: catalog[idx] };
      break;
    }
    if (match) {
      matches.push({
        join_key: match.key,
        join_kind: match.key.slice(0, match.key.indexOf('::')),
        seed: summarizeItem(seedItem),
        catalog: summarizeItem(match.catalogItem),
      });
    } else {
      onlyInSeed.push(summarizeItem(seedItem));
    }
  }

  const onlyInCatalog = catalog
    .filter((_, idx) => !matchedCatalogIdx.has(idx))
    .map(summarizeItem);

  return { matches, onlyInSeed, onlyInCatalog };
}

/**
 * Diff one query's results across the two lanes.
 *
 * `overlap_at_k` = matched seed items / seed item count — the fraction of the
 * incumbent seed lane's recall that the catalog lane also returns. When the
 * seed lane returned nothing, it is null (undefined coverage).
 *
 * When a lane threw (`seedError` / `catalogError` set), its empty result is an
 * error artifact, not a recall signal: `catalog_gap` is never flagged for
 * errored rows.
 */
function diffQueryResults({
  query,
  bucket = null,
  lang = null,
  seedItems,
  catalogItems,
  seedLatencyMs = null,
  catalogLatencyMs = null,
  seedReason = null,
  seedError = null,
  catalogError = null,
} = {}) {
  const { matches, onlyInSeed, onlyInCatalog } = joinLaneItems(seedItems, catalogItems);
  const seedCount = (Array.isArray(seedItems) ? seedItems : []).filter(Boolean).length;
  const catalogCount = (Array.isArray(catalogItems) ? catalogItems : []).filter(Boolean).length;
  const overlapCount = matches.length;
  const unionCount = seedCount + catalogCount - overlapCount;
  return {
    query: asString(query),
    ...(bucket ? { bucket } : {}),
    ...(lang ? { lang } : {}),
    seed_count: seedCount,
    catalog_count: catalogCount,
    overlap_count: overlapCount,
    overlap_at_k: seedCount > 0 ? overlapCount / seedCount : null,
    jaccard: unionCount > 0 ? overlapCount / unionCount : null,
    catalog_gap: !seedError && !catalogError && catalogCount === 0 && seedCount > 0,
    matches,
    only_in_seed: onlyInSeed,
    only_in_catalog: onlyInCatalog,
    seed_latency_ms: Number.isFinite(Number(seedLatencyMs)) ? Math.trunc(Number(seedLatencyMs)) : null,
    catalog_latency_ms: Number.isFinite(Number(catalogLatencyMs))
      ? Math.trunc(Number(catalogLatencyMs))
      : null,
    ...(seedReason ? { seed_reason: seedReason } : {}),
    ...(seedError ? { seed_error: asString(seedError) } : {}),
    ...(catalogError ? { catalog_error: asString(catalogError) } : {}),
  };
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * Aggregate per-query diffs into the corpus-level parity report.
 *
 * The headline gap metric is `catalog_zero_seed_positive_pct`: the share of
 * queries where the catalog lane returned 0 rows while the seed lane returned
 * at least one product — the recall the unified index must not lose.
 *
 * Rows where either lane errored (`seed_error` / `catalog_error`) are excluded
 * from the gap numerator AND denominator (an errored lane's empty result says
 * nothing about recall); they are surfaced via `queries_seed_error` /
 * `queries_catalog_error` instead.
 */
function aggregateParityReport(perQuery, { topOnlyInSeedTitles = TOP_ONLY_IN_SEED_TITLES } = {}) {
  const rows = (Array.isArray(perQuery) ? perQuery : []).filter(Boolean);
  const overlaps = rows
    .map((row) => row.overlap_at_k)
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number);

  const seedPositive = rows.filter((row) => Number(row.seed_count) > 0);
  const gapEligible = seedPositive.filter((row) => !row.seed_error && !row.catalog_error);
  const catalogZeroSeedPositive = gapEligible.filter((row) => Number(row.catalog_count) === 0);

  const onlyInSeedTitleCounts = new Map();
  for (const row of rows) {
    for (const item of Array.isArray(row.only_in_seed) ? row.only_in_seed : []) {
      const key = normalizeBrandTitleKey(item.brand, item.title);
      if (!key) continue;
      const entry = onlyInSeedTitleCounts.get(key) || {
        brand: item.brand || null,
        title: item.title || null,
        count: 0,
        queries: new Set(),
      };
      entry.count += 1;
      if (row.query) entry.queries.add(row.query);
      onlyInSeedTitleCounts.set(key, entry);
    }
  }
  const topOnlyInSeed = [...onlyInSeedTitleCounts.values()]
    .sort((a, b) => b.count - a.count || asString(a.title).localeCompare(asString(b.title)))
    .slice(0, Math.max(0, topOnlyInSeedTitles))
    .map((entry) => ({
      brand: entry.brand,
      title: entry.title,
      count: entry.count,
      queries: [...entry.queries].slice(0, 10),
    }));

  const seedLatencies = rows
    .map((row) => row.seed_latency_ms)
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number);
  const catalogLatencies = rows
    .map((row) => row.catalog_latency_ms)
    .filter((v) => v != null && Number.isFinite(Number(v)))
    .map(Number);

  return {
    queries_total: rows.length,
    queries_seed_positive: seedPositive.length,
    queries_catalog_positive: rows.filter((row) => Number(row.catalog_count) > 0).length,
    queries_both_empty: rows.filter(
      (row) => Number(row.seed_count) === 0 && Number(row.catalog_count) === 0,
    ).length,
    queries_seed_error: rows.filter((row) => row.seed_error).length,
    queries_catalog_error: rows.filter((row) => row.catalog_error).length,
    mean_overlap_at_k: round(mean(overlaps)),
    median_overlap_at_k: round(median(overlaps)),
    catalog_zero_seed_positive_count: catalogZeroSeedPositive.length,
    catalog_zero_seed_positive_pct:
      gapEligible.length > 0
        ? round((catalogZeroSeedPositive.length / gapEligible.length) * 100, 2)
        : null,
    catalog_zero_seed_positive_queries: catalogZeroSeedPositive.map((row) => row.query),
    top_only_in_seed_titles: topOnlyInSeed,
    mean_seed_latency_ms: round(mean(seedLatencies), 1),
    mean_catalog_latency_ms: round(mean(catalogLatencies), 1),
  };
}

/**
 * Parse one JSONL corpus line into {query, bucket, lang} (or null to skip).
 * eval_corpus_recall_v1.jsonl schema: {query, page, limit, lang, bucket}.
 */
function parseCorpusLine(line) {
  const trimmed = asString(line);
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const query = asString(parsed.query || parsed.q || parsed.text || parsed.prompt);
  if (!query) return null;
  return {
    query,
    bucket: asString(parsed.bucket) || null,
    lang: asString(parsed.lang) || null,
  };
}

function readCorpus(corpusPath, maxQueries) {
  const raw = fs.readFileSync(corpusPath, 'utf8');
  const entries = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseCorpusLine(line);
    if (!entry) continue;
    if (seen.has(entry.query)) continue;
    seen.add(entry.query);
    entries.push(entry);
    if (entries.length >= maxQueries) break;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// CLI runner. Lanes are required lazily so requiring this module in tests
// never boots routes.js or touches a database.
// ---------------------------------------------------------------------------

async function main() {
  const corpusPath = path.resolve(asString(argValue('corpus', DEFAULT_CORPUS_PATH)));
  const limit = Math.max(1, Math.trunc(Number(argValue('limit', DEFAULT_LIMIT)) || DEFAULT_LIMIT));
  const maxQueries = Math.max(
    1,
    Math.trunc(Number(argValue('max-queries', DEFAULT_MAX_QUERIES)) || DEFAULT_MAX_QUERIES),
  );
  const outPath = asString(argValue('out'));
  const verbose = hasFlag('verbose');

  // Both lanes must resolve the same market. The seed lane reads this env var
  // internally (searchLocalExternalSeedProducts); mirror it for the catalog
  // lane's marketId param.
  const market = asString(
    argValue('market', process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US'),
  ).toUpperCase();
  process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = market;

  // routes.js boots a large module graph; keep require-time side effects
  // quiet (mirrors tests/aurora_bff_product_intel.test.js env stubs).
  if (process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED == null) {
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  }
  if (process.env.AURORA_BFF_USE_MOCK == null) {
    process.env.AURORA_BFF_USE_MOCK = 'true';
  }

  if (!fs.existsSync(corpusPath)) {
    console.error(`corpus not found: ${corpusPath}`);
    process.exitCode = 1;
    return;
  }
  const corpus = readCorpus(corpusPath, maxQueries);
  if (!corpus.length) {
    console.error(`corpus is empty or has no parsable query lines: ${corpusPath}`);
    process.exitCode = 1;
    return;
  }

  const db = require('../src/db');
  const { __internal } = require('../src/auroraBff/routes');
  const searchLocalExternalSeedProducts = __internal?.searchLocalExternalSeedProducts;
  if (typeof searchLocalExternalSeedProducts !== 'function') {
    throw new Error('routes.js __internal.searchLocalExternalSeedProducts is unavailable');
  }
  const { fetchCanonicalChainRows } = require('../src/services/canonicalCatalogSearch');
  const dbQuery = (sql, params) => db.query(sql, params);

  console.log(
    `recall-lane parity: ${corpus.length} queries, limit=${limit}, market=${market}, corpus=${corpusPath}`,
  );

  const perQuery = [];
  try {
    for (const entry of corpus) {
      const seedStartedAt = Date.now();
      let seedOut;
      let seedError = null;
      try {
        seedOut = await searchLocalExternalSeedProducts({
          query: entry.query,
          limit,
          logger: null,
          transportPolicyMode: 'product_grounding_exact',
        });
      } catch (error) {
        seedError = `seed_lane_error: ${error?.message || error}`;
        seedOut = { ok: false, products: [], reason: seedError };
      }
      const seedLatencyMs = Date.now() - seedStartedAt;

      const catalogStartedAt = Date.now();
      let catalogRows;
      let catalogError = null;
      try {
        catalogRows = await fetchCanonicalChainRows({
          query: entry.query,
          marketId: market,
          limit,
          deps: { query: dbQuery },
        });
      } catch (error) {
        catalogRows = [];
        catalogError = `catalog_lane_error: ${error?.message || error}`;
      }
      const catalogLatencyMs = Date.now() - catalogStartedAt;

      const seedItems = (Array.isArray(seedOut?.products) ? seedOut.products : [])
        .map(normalizeSeedLaneItem)
        .filter(Boolean);
      // fetchCanonicalChainRows returns up to limit*6 flattened chain rows;
      // truncate to the per-lane limit so overlap@k compares k vs k.
      const catalogItems = truncateToLaneLimit(catalogRows, limit)
        .map(normalizeCatalogLaneItem)
        .filter(Boolean);

      const diff = diffQueryResults({
        query: entry.query,
        bucket: entry.bucket,
        lang: entry.lang,
        seedItems,
        catalogItems,
        seedLatencyMs,
        catalogLatencyMs,
        seedReason: seedOut?.ok ? null : asString(seedOut?.reason) || null,
        seedError,
        catalogError,
      });
      perQuery.push(diff);

      const line =
        `[${perQuery.length}/${corpus.length}] "${entry.query}" ` +
        `seed=${diff.seed_count} catalog=${diff.catalog_count} overlap=${diff.overlap_count} ` +
        `(${seedLatencyMs}ms / ${catalogLatencyMs}ms)` +
        (diff.catalog_gap ? ' CATALOG_GAP' : '');
      console.log(line);
      if (verbose && diff.only_in_seed.length) {
        for (const item of diff.only_in_seed) {
          console.log(`    only-in-seed: ${item.brand || '?'} — ${item.title || '?'}`);
        }
      }
    }
  } finally {
    try {
      await db.closePool();
    } catch {}
  }

  const aggregate = aggregateParityReport(perQuery);
  const report = {
    generated_at: new Date().toISOString(),
    corpus_path: corpusPath,
    market,
    limit,
    max_queries: maxQueries,
    aggregate,
    per_query: perQuery,
  };

  console.log('\n=== aggregate ===');
  console.log(JSON.stringify(aggregate, null, 2));

  if (outPath) {
    const resolvedOut = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(resolvedOut, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport written: ${resolvedOut}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  EXTERNAL_SEED_PRODUCT_KEY_PREFIX,
  normalizeText,
  normalizeBrandTitleKey,
  truncateToLaneLimit,
  externalProductIdFromProductKey,
  normalizeSeedLaneItem,
  normalizeCatalogLaneItem,
  identityJoinKeys,
  joinLaneItems,
  diffQueryResults,
  aggregateParityReport,
  parseCorpusLine,
};

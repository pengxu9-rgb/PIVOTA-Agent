#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const DEFAULT_MARKET = 'US';
const DEFAULT_LIMIT = 250;
const DEFAULT_SOURCES = ['catalog_products', 'external_product_seeds'];
const BEAUTY_TEXT_PATTERNS = [
  '%beauty%',
  '%skincare%',
  '%skin care%',
  '%serum%',
  '%moisturizer%',
  '%cleanser%',
  '%sunscreen%',
  '%spf%',
  '%makeup%',
  '%cosmetic%',
  '%fragrance%',
  '%hair%',
];

function normalizeString(value, max = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeLower(value, max = 512) {
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
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseDelimitedList(value, fallback = []) {
  const text = normalizeString(value, 5000);
  const values = text ? text.split(/[,\s;]+/g) : fallback;
  return Array.from(
    new Set(
      values
        .map((item) => normalizeLower(item, 80))
        .filter(Boolean)
        .map((item) => {
          if (['catalog', 'catalog_product', 'catalog-products'].includes(item)) return 'catalog_products';
          if (['seed', 'seeds', 'external_seed', 'external-seed', 'external-product-seeds'].includes(item)) {
            return 'external_product_seeds';
          }
          return item;
        })
        .filter((item) => DEFAULT_SOURCES.includes(item)),
    ),
  );
}

function normalizeTimestamp(value, { required = false } = {}) {
  const text = normalizeString(value, 100);
  if (!text) {
    if (required) throw new Error('--updated-since is required');
    return '';
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --updated-since timestamp: ${text}`);
  return date.toISOString();
}

function resolvePathMaybeRelative(filePath, cwd = process.cwd()) {
  const text = normalizeString(filePath, 2000);
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.join(cwd, text);
}

function writeJsonFile(filePath, payload) {
  const resolved = resolvePathMaybeRelative(filePath);
  if (!resolved) return '';
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

function dedupeStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeString(value, 512);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function productRef(value) {
  const text = normalizeString(value, 512);
  if (!text) return '';
  return /^[a-z][a-z0-9_+-]*:/i.test(text) ? text : `product:${text}`;
}

function hostname(value) {
  const text = normalizeString(value, 1000);
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    return new URL(text).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function buildCatalogAffectedRow(row = {}, market = DEFAULT_MARKET) {
  const sigId = normalizeString(row.pivota_signature_id);
  const sourceProductId = normalizeString(row.source_product_id);
  const productKey = normalizeString(row.product_key);
  const contentKey = normalizeString(row.content_key);
  const primaryRef = productRef(sigId || sourceProductId) || productKey;
  const canonicalUrl = normalizeString(row.canonical_url || row.pivota_canonical_url, 1000);
  const productRefs = dedupeStrings([
    primaryRef,
    productKey,
    sourceProductId,
    productRef(sourceProductId),
    sigId,
    productRef(sigId),
    contentKey,
  ]);
  return {
    source: 'catalog_products',
    product_ref: primaryRef,
    product_refs: productRefs,
    product_key: productKey,
    source_product_id: sourceProductId,
    pivota_signature_id: sigId,
    sig_id: sigId,
    content_key: contentKey,
    merchant_id: normalizeString(row.merchant_id),
    platform: normalizeString(row.platform),
    market: normalizeString(market).toUpperCase() || DEFAULT_MARKET,
    brand: normalizeString(row.brand),
    title: normalizeString(row.title),
    canonical_url: canonicalUrl,
    domain: hostname(canonicalUrl),
    updated_at: row.updated_at || null,
    created_at: row.created_at || null,
  };
}

function buildExternalSeedAffectedRow(row = {}, market = DEFAULT_MARKET) {
  const externalProductId = normalizeString(row.external_product_id || row.id);
  const sigId = normalizeString(row.pivota_signature_id);
  const productKey = normalizeString(row.catalog_product_key || row.attached_product_key);
  const contentKey = normalizeString(row.content_key);
  const primaryRef = productRef(sigId || externalProductId) || productKey;
  const canonicalUrl = normalizeString(row.catalog_canonical_url || row.canonical_url || row.destination_url, 1000);
  const productRefs = dedupeStrings([
    primaryRef,
    externalProductId,
    productRef(externalProductId),
    productKey,
    sigId,
    productRef(sigId),
    contentKey,
  ]);
  return {
    source: 'external_product_seeds',
    product_ref: primaryRef,
    product_refs: productRefs,
    external_product_id: externalProductId,
    source_product_id: externalProductId,
    product_key: productKey,
    pivota_signature_id: sigId,
    sig_id: sigId,
    content_key: contentKey,
    market: normalizeString(row.market || market).toUpperCase() || DEFAULT_MARKET,
    brand: normalizeString(row.catalog_brand || row.brand),
    title: normalizeString(row.catalog_title || row.title),
    canonical_url: canonicalUrl,
    domain: normalizeString(row.domain) || hostname(canonicalUrl),
    updated_at: row.updated_at || row.catalog_updated_at || null,
    created_at: row.created_at || null,
  };
}

async function fetchCatalogProductRows({
  queryFn = query,
  updatedSince,
  limit = DEFAULT_LIMIT,
} = {}) {
  const res = await queryFn(
    `
      SELECT
        cp.product_key,
        cp.source_product_id,
        cp.pivota_signature_id,
        cp.content_key,
        cp.merchant_id,
        cp.platform,
        cp.title,
        cp.description,
        cp.brand,
        cp.product_type,
        cp.category,
        cp.category_path,
        cp.canonical_url,
        cp.pivota_canonical_url,
        cp.updated_at,
        cp.created_at
      FROM catalog_products cp
      WHERE (
          cp.updated_at >= $1::timestamptz
          OR cp.created_at >= $1::timestamptz
        )
        AND (
          lower(concat_ws(
            ' ',
            cp.title,
            cp.description,
            cp.brand,
            cp.product_type,
            cp.category,
            cp.category_path,
            cp.category_label
          )) LIKE ANY($3::text[])
          OR lower(to_jsonb(cp.product_payload)::text) LIKE ANY($3::text[])
        )
      ORDER BY cp.updated_at DESC NULLS LAST, cp.created_at DESC NULLS LAST, cp.product_key ASC
      LIMIT $2
    `,
    [updatedSince, limit, BEAUTY_TEXT_PATTERNS],
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function fetchExternalSeedRows({
  queryFn = query,
  updatedSince,
  market = DEFAULT_MARKET,
  limit = DEFAULT_LIMIT,
} = {}) {
  const normalizedMarket = normalizeString(market).toUpperCase() || DEFAULT_MARKET;
  const res = await queryFn(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.attached_product_key,
        eps.market,
        eps.domain,
        eps.title,
        eps.canonical_url,
        eps.destination_url,
        eps.updated_at,
        eps.created_at,
        cp.product_key AS catalog_product_key,
        cp.pivota_signature_id,
        cp.content_key,
        cp.title AS catalog_title,
        cp.brand AS catalog_brand,
        cp.canonical_url AS catalog_canonical_url,
        cp.updated_at AS catalog_updated_at
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.source_product_id = eps.external_product_id
        OR cp.product_key = eps.attached_product_key
      WHERE COALESCE(eps.status, 'active') = 'active'
        AND upper(COALESCE(eps.market, $2)) = $2
        AND (
          eps.updated_at >= $1::timestamptz
          OR eps.created_at >= $1::timestamptz
          OR cp.updated_at >= $1::timestamptz
        )
        AND (
          lower(concat_ws(
            ' ',
            eps.title,
            eps.domain,
            cp.title,
            cp.brand,
            cp.product_type,
            cp.category,
            cp.category_path
          )) LIKE ANY($4::text[])
          OR lower(to_jsonb(eps.seed_data)::text) LIKE ANY($4::text[])
          OR lower(to_jsonb(cp.product_payload)::text) LIKE ANY($4::text[])
        )
      ORDER BY GREATEST(
        COALESCE(eps.updated_at, '-infinity'::timestamptz),
        COALESCE(eps.created_at, '-infinity'::timestamptz),
        COALESCE(cp.updated_at, '-infinity'::timestamptz)
      ) DESC,
      eps.id ASC
      LIMIT $3
    `,
    [updatedSince, normalizedMarket, limit, BEAUTY_TEXT_PATTERNS],
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

function buildAffectedProductsManifest({
  rows = [],
  market = DEFAULT_MARKET,
  updatedSince = '',
  sources = DEFAULT_SOURCES,
  limit = DEFAULT_LIMIT,
  generatedAt = new Date().toISOString(),
} = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const sourceCounts = normalizedRows.reduce((counts, row) => {
    const source = normalizeString(row.source) || 'unknown';
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  return {
    generated_at: generatedAt,
    source: 'relationship_graph_affected_selector',
    mode: 'select',
    market: normalizeString(market).toUpperCase() || DEFAULT_MARKET,
    selection: {
      updated_since: updatedSince || null,
      sources,
      limit,
      source_counts: sourceCounts,
    },
    affected_count: normalizedRows.length,
    external_product_ids: dedupeStrings(normalizedRows.map((row) => row.external_product_id)),
    source_product_ids: dedupeStrings(normalizedRows.map((row) => row.source_product_id)),
    product_keys: dedupeStrings(normalizedRows.map((row) => row.product_key)),
    sig_ids: dedupeStrings(normalizedRows.map((row) => row.pivota_signature_id || row.sig_id)),
    content_keys: dedupeStrings(normalizedRows.map((row) => row.content_key)),
    affected_refs: dedupeStrings(normalizedRows.flatMap((row) => row.product_refs || row.product_ref)),
    rows: normalizedRows,
  };
}

function parseArgs(argv = process.argv.slice(2), { now = new Date(), cwd = process.cwd() } = {}) {
  if (hasFlag(argv, 'help') || hasFlag(argv, 'h')) return { help: true };
  const hours = parseNumber(argValue(argv, 'hours') || argValue(argv, 'select-hours'), 0, { min: 0, max: 24 * 365 });
  const rawUpdatedSince =
    argValue(argv, 'updated-since') ||
    argValue(argv, 'select-updated-since') ||
    argValue(argv, 'since') ||
    (hours ? new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString() : '');
  const updatedSince = normalizeTimestamp(rawUpdatedSince, { required: true });
  const sources = parseDelimitedList(argValue(argv, 'sources') || argValue(argv, 'select-sources'), DEFAULT_SOURCES);
  if (!sources.length) throw new Error('--sources must include catalog_products and/or external_product_seeds');
  return {
    updatedSince,
    sources,
    market: normalizeString(argValue(argv, 'market', DEFAULT_MARKET), 24).toUpperCase() || DEFAULT_MARKET,
    limit: parseNumber(argValue(argv, 'limit') || argValue(argv, 'select-limit'), DEFAULT_LIMIT, { min: 1, max: 5000 }),
    out: resolvePathMaybeRelative(argValue(argv, 'out'), cwd),
    allowEmptySelection: hasFlag(argv, 'allow-empty-selection') || hasFlag(argv, 'allow-empty'),
  };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/select-relationship-graph-affected-products.js --updated-since <timestamp> [--sources catalog_products,external_product_seeds] [--out path]',
    '',
    'Read-only selector. Writes an affected-products manifest for relationship graph routines.',
  ].join('\n');
}

async function run(argv = process.argv.slice(2), { queryFn = query, now = new Date(), cwd = process.cwd() } = {}) {
  const options = parseArgs(argv, { now, cwd });
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }

  const rows = [];
  if (options.sources.includes('catalog_products')) {
    const catalogRows = await fetchCatalogProductRows({
      queryFn,
      updatedSince: options.updatedSince,
      limit: options.limit,
    });
    rows.push(...catalogRows.map((row) => buildCatalogAffectedRow(row, options.market)));
  }
  if (options.sources.includes('external_product_seeds')) {
    const seedRows = await fetchExternalSeedRows({
      queryFn,
      updatedSince: options.updatedSince,
      market: options.market,
      limit: options.limit,
    });
    rows.push(...seedRows.map((row) => buildExternalSeedAffectedRow(row, options.market)));
  }

  const manifest = buildAffectedProductsManifest({
    rows,
    market: options.market,
    updatedSince: options.updatedSince,
    sources: options.sources,
    limit: options.limit,
    generatedAt: now.toISOString(),
  });

  if (!manifest.affected_count && !options.allowEmptySelection) {
    const err = new Error('no_affected_products_selected');
    err.manifest = manifest;
    throw err;
  }

  if (options.out) writeJsonFile(options.out, manifest);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  run()
    .catch((err) => {
      process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}

module.exports = {
  DEFAULT_SOURCES,
  buildAffectedProductsManifest,
  buildCatalogAffectedRow,
  buildExternalSeedAffectedRow,
  fetchCatalogProductRows,
  fetchExternalSeedRows,
  parseArgs,
  run,
};

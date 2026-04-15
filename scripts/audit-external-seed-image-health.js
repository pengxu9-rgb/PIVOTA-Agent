#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { query } = require('../src/db');
const { ensureJsonObject } = require('../src/services/externalSeedProducts');
const { probeImageUrl } = require('./audit-external-product-pdp-quality');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function collectImageUrlsFromValue(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    const url = normalizeUrlLike(value);
    if (url) out.push(url);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageUrlsFromValue(item, out));
    return;
  }
  if (typeof value !== 'object') return;
  const typed = value;
  [
    typed.url,
    typed.src,
    typed.image,
    typed.image_url,
    typed.thumbnail_url,
    typed.primary_image_url,
  ].forEach((candidate) => collectImageUrlsFromValue(candidate, out));
  [
    typed.images,
    typed.image_urls,
    typed.media,
    typed.gallery,
    typed.variants,
    typed.preview_items,
    typed.line_preview_images,
  ].forEach((candidate) => collectImageUrlsFromValue(candidate, out));
}

function collectSeedImageUrls(row) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const out = [];
  [
    seedData.image_url,
    seedData.image_urls,
    seedData.images,
    seedData.media,
    seedData.variants,
    seedData.line_preview_images,
    snapshot.image_url,
    snapshot.image_urls,
    snapshot.images,
    snapshot.media,
    snapshot.variants,
    snapshot.line_preview_images,
  ].forEach((value) => collectImageUrlsFromValue(value, out));
  return Array.from(new Set(out));
}

async function fetchRows({ market, domain, limit, offset }) {
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
  if (market) where.push(`market = ${bind(market)}`);
  if (domain) where.push(`domain = ${bind(domain)}`);
  if (limit != null) {
    params.push(limit);
    const limitBind = `$${params.length}`;
    params.push(offset || 0);
    const offsetBind = `$${params.length}`;
    const res = await query(
      `
        SELECT id, external_product_id, market, domain, canonical_url, seed_data
        FROM external_product_seeds
        WHERE ${where.join('\n          AND ')}
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT ${limitBind}
        OFFSET ${offsetBind}
      `,
      params,
    );
    return res.rows || [];
  }
  const res = await query(
    `
      SELECT id, external_product_id, market, domain, canonical_url, seed_data
      FROM external_product_seeds
      WHERE ${where.join('\n        AND ')}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    `,
    params,
  );
  return res.rows || [];
}

async function checkUrls(urls, checkpoint, concurrency) {
  const queue = urls.filter((url) => !checkpoint.checked_urls[url]);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const current = queue[cursor];
      cursor += 1;
      checkpoint.checked_urls[current] = await probeImageUrl(current);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
}

function summarizeRows(rows, checkpoint) {
  const rowResults = rows.map((row) => {
    const urls = collectSeedImageUrls(row);
    const checks = urls.map((url) => checkpoint.checked_urls[url]).filter(Boolean);
    const broken = checks.filter((item) => !item.ok);
    return {
      seed_id: String(row.id),
      external_product_id: row.external_product_id,
      market: row.market,
      domain: row.domain,
      canonical_url: row.canonical_url,
      image_url_count: urls.length,
      checked_url_count: checks.length,
      broken_count: broken.length,
      broken_urls: broken.slice(0, 20),
    };
  });

  const domainBuckets = {};
  rowResults.forEach((item) => {
    const key = item.domain || 'unknown';
    const bucket =
      domainBuckets[key] ||
      {
        products_scanned: 0,
        products_with_broken_images: 0,
        checked_url_count: 0,
        broken_url_count: 0,
      };
    bucket.products_scanned += 1;
    bucket.checked_url_count += item.checked_url_count;
    bucket.broken_url_count += item.broken_count;
    if (item.broken_count > 0) bucket.products_with_broken_images += 1;
    domainBuckets[key] = bucket;
  });

  return {
    scanned: rowResults.length,
    products_with_broken_images: rowResults.filter((item) => item.broken_count > 0).length,
    checked_url_count: rowResults.reduce((sum, item) => sum + item.checked_url_count, 0),
    broken_url_count: rowResults.reduce((sum, item) => sum + item.broken_count, 0),
    domain_buckets: domainBuckets,
    results: rowResults,
  };
}

async function main() {
  const market = normalizeNonEmptyString(argValue('market')).toUpperCase();
  const domain = normalizeNonEmptyString(argValue('domain'));
  const limitArg = argValue('limit');
  const limit = limitArg == null ? null : Math.max(1, Number(limitArg) || 1);
  const offset = Math.max(0, Number(argValue('offset') || 0) || 0);
  const concurrency = Math.max(1, Math.min(16, Number(argValue('concurrency') || 4) || 4));
  const checkpointPath =
    argValue('checkpoint') ||
    path.join(process.cwd(), '.tmp', 'external-seed-image-health-checkpoint.json');
  const outPath =
    argValue('out') ||
    path.join(process.cwd(), 'reports', 'external-seed-image-health.json');
  const checkpoint = readJsonFile(checkpointPath, {
    checked_urls: {},
    updated_at: null,
  });

  checkpoint.checked_urls =
    checkpoint.checked_urls && typeof checkpoint.checked_urls === 'object'
      ? checkpoint.checked_urls
      : {};

  const rows = await fetchRows({ market, domain, limit, offset });
  const allUrls = Array.from(new Set(rows.flatMap((row) => collectSeedImageUrls(row))));
  await checkUrls(allUrls, checkpoint, concurrency);
  checkpoint.updated_at = new Date().toISOString();
  writeJsonFile(checkpointPath, checkpoint);

  const summary = summarizeRows(rows, checkpoint);
  writeJsonFile(outPath, summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  collectSeedImageUrls,
  summarizeRows,
  fetchRows,
};

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../../../src/db');
const { ensureJsonObject } = require('../../../src/services/externalSeedProducts');
const { readStoredRecallDoc } = require('../../../src/services/externalSeedRecall');
const { recommend } = require('../../../src/services/RecommendationEngine');

const WAVE12_EXTERNAL_PRODUCT_IDS = Object.freeze([
  'ext_1e27467ab07ddb83ad74c213',
  'ext_4e95b920b4c6a5295d55aa46',
  'ext_d17dfc05f98d0400d5129f1c',
  'ext_c0e5209513c083e2c649c1a1',
  'ext_d3d708f481903ba2a6f9b732',
]);

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const target = normalizeNonEmptyString(filePath);
  if (!target) {
    process.stdout.write(body);
    return;
  }
  ensureParentDir(target);
  fs.writeFileSync(target, body, 'utf8');
  process.stdout.write(body);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeNonEmptyString(value);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeAvailability(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return 'in_stock';
  return normalized;
}

function firstImage(seedData, snapshot, row) {
  const candidates = [
    row.image_url,
    seedData.image_url,
    seedData.image,
    snapshot.image_url,
    snapshot.image,
    ...(Array.isArray(seedData.images) ? seedData.images : []),
    ...(Array.isArray(snapshot.images) ? snapshot.images : []),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate.trim())) return candidate.trim();
    if (candidate && typeof candidate === 'object') {
      const url = firstNonEmpty(candidate.url, candidate.src, candidate.image_url);
      if (/^https?:\/\//i.test(url)) return url;
    }
  }
  return '';
}

function buildBaseProduct(row) {
  const seedData = ensureJsonObject(row.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const recall = readStoredRecallDoc(seedData);
  const title = firstNonEmpty(row.title, seedData.title, snapshot.title);
  const brand = firstNonEmpty(seedData.brand, seedData.brand_name, seedData.vendor, snapshot.brand, snapshot.vendor);
  const category = firstNonEmpty(
    recall.category,
    seedData.recall_category,
    seedData.category,
    seedData.product_type,
    snapshot.category,
    snapshot.product_type,
  );
  const categoryPath = firstNonEmpty(
    row.catalog_category_path,
    seedData.catalog_category_path,
    seedData.category_path,
    snapshot.catalog_category_path,
    snapshot.category_path,
  );
  const canonicalUrl = firstNonEmpty(row.canonical_url, seedData.canonical_url, snapshot.canonical_url, row.destination_url);
  const priceAmount = Number(row.price_amount ?? seedData.price_amount ?? seedData.price ?? snapshot.price_amount ?? snapshot.price);
  const priceCurrency = firstNonEmpty(row.price_currency, seedData.price_currency, snapshot.price_currency, 'USD').toUpperCase();
  return {
    merchant_id: 'external_seed',
    product_id: row.external_product_id,
    id: row.external_product_id,
    external_product_id: row.external_product_id,
    external_seed_id: row.id,
    title,
    name: title,
    brand,
    vendor: brand,
    category,
    product_type: category,
    category_path: categoryPath,
    catalog_category_path: categoryPath,
    semantic_vertical: firstNonEmpty(recall.vertical, seedData.semantic_vertical, seedData.recall_vertical),
    recall_vertical: firstNonEmpty(recall.vertical, seedData.semantic_vertical, seedData.recall_vertical),
    external_seed_recall: recall,
    canonical_url: canonicalUrl,
    destination_url: firstNonEmpty(row.destination_url, canonicalUrl),
    domain: firstNonEmpty(row.domain, seedData.domain),
    price_amount: Number.isFinite(priceAmount) ? priceAmount : null,
    price_currency: priceCurrency,
    currency: priceCurrency,
    availability: normalizeAvailability(row.availability || seedData.availability || snapshot.availability),
    image_url: firstImage(seedData, snapshot, row),
  };
}

function summarizeRecall(row) {
  const seedData = ensureJsonObject(row.seed_data);
  const recall = readStoredRecallDoc(seedData);
  return {
    seed_id: row.id,
    external_product_id: row.external_product_id,
    title: row.title,
    attached_product_key: row.attached_product_key,
    catalog_product_key: row.catalog_product_key,
    catalog_category_path: row.catalog_category_path,
    recall_category: recall.category || null,
    recall_vertical: recall.vertical || null,
    retrieval_title: recall.retrieval_title || null,
    retrieval_summary_length: normalizeNonEmptyString(recall.retrieval_summary).length,
    retrieval_body_length: normalizeNonEmptyString(recall.retrieval_body).length,
    alias_tokens: Array.isArray(recall.alias_tokens) ? recall.alias_tokens.slice(0, 30) : [],
  };
}

async function fetchRows() {
  const res = await query(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.market,
        eps.tool,
        eps.domain,
        eps.title,
        eps.destination_url,
        eps.canonical_url,
        eps.image_url,
        eps.price_amount,
        eps.price_currency,
        eps.availability,
        eps.attached_product_key,
        eps.seed_data,
        cp.product_key AS catalog_product_key,
        cp.category_path AS catalog_category_path
      FROM external_product_seeds eps
      LEFT JOIN catalog_products cp
        ON cp.product_key = eps.attached_product_key
      WHERE eps.external_product_id = ANY($1::text[])
      ORDER BY array_position($1::text[], eps.external_product_id)
    `,
    [WAVE12_EXTERNAL_PRODUCT_IDS],
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

async function probeRecommendations(row) {
  const baseProduct = buildBaseProduct(row);
  const externalFetchTimeoutMs = Number(argValue('external-fetch-timeout-ms') || 0);
  const response = await recommend({
    pdp_product: baseProduct,
    k: 6,
    locale: 'en-US',
    currency: baseProduct.price_currency || 'USD',
    options: {
      debug: true,
      no_cache: true,
      cache_bypass: true,
      similar_cache_bypass: true,
      hydrate_product_intel_cards: true,
      ...(Number.isFinite(externalFetchTimeoutMs) && externalFetchTimeoutMs > 0
        ? { external_fetch_timeout_ms: externalFetchTimeoutMs }
        : {}),
    },
  });
  const items = Array.isArray(response.items) ? response.items : [];
  return {
    seed_id: row.id,
    external_product_id: row.external_product_id,
    title: baseProduct.title,
    base: response.debug?.base || null,
    base_semantic: response.debug?.base_semantic || null,
    metadata: response.metadata || {},
    fetch_strategy: response.debug?.fetch_strategy || {},
    layers: response.debug?.layers || {},
    filters: response.debug?.filters || {},
    candidates_total: response.debug?.candidates_total ?? null,
    sources: response.debug?.sources || {},
    confidence: response.debug?.confidence || {},
    item_count: items.length,
    items: items.map((item) => ({
      product_id: item.product_id || item.id || null,
      merchant_id: item.merchant_id || null,
      title: item.title || item.name || null,
      brand: item.brand || item.vendor || null,
      category: item.category || item.product_type || null,
      source: item.source || item.metadata?.source || null,
      reason: item.reason || item.metadata?.reason || null,
      x_score: item.x_score ?? item.similarity ?? null,
      x_confidence: item.x_confidence || item.confidence || null,
      has_highlight: Boolean(
        normalizeNonEmptyString(item.highlight) ||
          normalizeNonEmptyString(item.subtitle) ||
          normalizeNonEmptyString(item.why_it_stands_out) ||
          normalizeNonEmptyString(item.product_intel?.why_it_stands_out),
      ),
    })),
  };
}

async function main() {
  const rows = await fetchRows();
  const recommendationDebug = [];
  for (const row of rows) {
    recommendationDebug.push(await probeRecommendations(row));
  }
  writeJson(argValue('out'), {
    generated_at: new Date().toISOString(),
    expected_external_product_ids: WAVE12_EXTERNAL_PRODUCT_IDS,
    row_count: rows.length,
    recall_rows: rows.map(summarizeRecall),
    recommendation_debug: recommendationDebug,
  });
}

main()
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });

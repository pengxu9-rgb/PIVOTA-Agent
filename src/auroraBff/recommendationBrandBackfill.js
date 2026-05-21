'use strict';

const { query } = require('../db');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimmed(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function firstString(...values) {
  for (const v of values) {
    const s = trimmed(typeof v === 'string' ? v : '');
    if (s) return s;
  }
  return '';
}

function readBrandFromCandidate(candidate) {
  if (typeof candidate === 'string') return trimmed(candidate);
  if (isPlainObject(candidate)) return firstString(candidate.name, candidate.value);
  return '';
}

function rowAlreadyHasBrand(row) {
  if (!isPlainObject(row)) return true;
  const product = isPlainObject(row.product) ? row.product : {};
  const sku = isPlainObject(row.sku) ? row.sku : {};
  return Boolean(
    readBrandFromCandidate(row.brand) ||
      readBrandFromCandidate(product.brand) ||
      readBrandFromCandidate(product.vendor) ||
      readBrandFromCandidate(sku.brand) ||
      readBrandFromCandidate(sku.Brand),
  );
}

function rowProductId(row) {
  if (!isPlainObject(row)) return '';
  const sku = isPlainObject(row.sku) ? row.sku : {};
  const product = isPlainObject(row.product) ? row.product : {};
  return firstString(
    row.product_id,
    row.productId,
    sku.product_id,
    sku.productId,
    product.product_id,
    product.productId,
  );
}

function rowMerchantId(row) {
  if (!isPlainObject(row)) return '';
  return firstString(row.merchant_id, row.merchantId);
}

function classifyProductId(productId) {
  const lowered = String(productId || '').toLowerCase();
  if (!lowered) return null;
  if (lowered.startsWith('sig_')) return { kind: 'sig', id: productId };
  if (lowered.startsWith('ext_') || lowered.startsWith('ext:') || lowered.includes(':')) {
    return { kind: 'ext', id: productId };
  }
  return { kind: 'merchant', id: productId };
}

/**
 * Build a lookup map `{ [key]: brand }` for recommendation rows that lack
 * brand. PURE: does NOT mutate `recommendations`. Returns `{}` on DB error,
 * empty rows, or no DATABASE_URL.
 *
 * Key forms:
 *   - `sig:<pivota_signature_id>`
 *   - `ext:<external_product_id>`
 *   - `mp:<merchant_id>::<source_product_id>`
 *
 * Callers compute the same key from a row at read time to look up the brand.
 */
async function buildBrandLookupMap(recommendations, deps = {}) {
  const out = {};
  const rows = Array.isArray(recommendations) ? recommendations : [];
  if (!rows.length || !process.env.DATABASE_URL) return out;
  const queryFn = typeof deps.queryFn === 'function' ? deps.queryFn : query;
  const logger = deps.logger || null;

  const sigIds = new Set();
  const extProductIds = new Set();
  const merchantPairs = new Map(); // pairKey → { merchantId, productId }

  for (const row of rows) {
    if (!isPlainObject(row) || rowAlreadyHasBrand(row)) continue;
    const productId = rowProductId(row);
    if (!productId) continue;
    const classified = classifyProductId(productId);
    if (!classified) continue;
    if (classified.kind === 'sig') sigIds.add(productId);
    else if (classified.kind === 'ext') extProductIds.add(productId);
    else {
      const merchantId = rowMerchantId(row);
      if (!merchantId) continue;
      const pairKey = `${merchantId}::${productId}`;
      if (!merchantPairs.has(pairKey)) merchantPairs.set(pairKey, { merchantId, productId });
    }
  }
  if (!sigIds.size && !extProductIds.size && !merchantPairs.size) return out;

  try {
    if (sigIds.size) {
      const res = await queryFn(
        `SELECT pivota_signature_id, brand
           FROM catalog_products
          WHERE pivota_signature_id = ANY($1::text[])
            AND brand IS NOT NULL
            AND length(trim(brand)) > 0`,
        [Array.from(sigIds)],
      );
      for (const r of res?.rows || []) {
        const sig = trimmed(r?.pivota_signature_id);
        const brand = trimmed(r?.brand);
        if (sig && brand && !out[`sig:${sig}`]) out[`sig:${sig}`] = brand;
      }
    }
    if (extProductIds.size) {
      const res = await queryFn(
        `SELECT
           eps.external_product_id,
           COALESCE(
             NULLIF(trim(cp.brand), ''),
             NULLIF(trim(eps.seed_data->>'brand'), ''),
             NULLIF(trim(eps.seed_data->'snapshot'->>'brand'), ''),
             NULLIF(trim(eps.seed_data->'derived'->'recall'->>'brand'), '')
           ) AS brand
         FROM external_product_seeds eps
         LEFT JOIN catalog_products cp ON cp.product_key = eps.attached_product_key
         WHERE eps.external_product_id = ANY($1::text[])`,
        [Array.from(extProductIds)],
      );
      for (const r of res?.rows || []) {
        const ext = trimmed(r?.external_product_id);
        const brand = trimmed(r?.brand);
        if (ext && brand && !out[`ext:${ext}`]) out[`ext:${ext}`] = brand;
      }
    }
    if (merchantPairs.size) {
      const merchantIds = Array.from(
        new Set(Array.from(merchantPairs.values()).map((p) => p.merchantId)),
      );
      const productIds = Array.from(
        new Set(Array.from(merchantPairs.values()).map((p) => p.productId)),
      );
      const res = await queryFn(
        `SELECT merchant_id, source_product_id, brand
           FROM catalog_products
          WHERE merchant_id = ANY($1::text[])
            AND source_product_id = ANY($2::text[])
            AND brand IS NOT NULL
            AND length(trim(brand)) > 0`,
        [merchantIds, productIds],
      );
      for (const r of res?.rows || []) {
        const mid = trimmed(r?.merchant_id);
        const pid = trimmed(r?.source_product_id);
        const brand = trimmed(r?.brand);
        const key = `mp:${mid}::${pid}`;
        if (mid && pid && brand && !out[key]) out[key] = brand;
      }
    }
  } catch (err) {
    const message = String(err?.message || err || '');
    if (
      err?.code === 'NO_DATABASE' ||
      (message.includes('catalog_products') && message.includes('does not exist'))
    ) {
      return out;
    }
    if (logger?.warn) {
      logger.warn(
        { err: message },
        'buildBrandLookupMap query failed; returning empty map',
      );
    }
  }
  return out;
}

/**
 * Read-side helper: given a row + the lookup map, return a brand string.
 * Returns '' when no match. Pure.
 */
function lookupBrandForRow(row, brandLookupMap) {
  if (!isPlainObject(row) || !isPlainObject(brandLookupMap)) return '';
  const productId = rowProductId(row);
  if (!productId) return '';
  const classified = classifyProductId(productId);
  if (!classified) return '';
  if (classified.kind === 'sig') return trimmed(brandLookupMap[`sig:${productId}`]);
  if (classified.kind === 'ext') return trimmed(brandLookupMap[`ext:${productId}`]);
  const merchantId = rowMerchantId(row);
  if (!merchantId) return '';
  return trimmed(brandLookupMap[`mp:${merchantId}::${productId}`]);
}

module.exports = { buildBrandLookupMap, lookupBrandForRow };

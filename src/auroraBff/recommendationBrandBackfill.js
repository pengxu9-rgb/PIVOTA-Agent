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

// Brand can be a string OR `{ name }` (PDP shape).
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

/**
 * Backfill `row.brand` on recommendation rows that lack brand by looking up
 * catalog_products (and external_product_seeds for domain-prefixed seed IDs).
 *
 * Pure-ish: returns a new array; rows that get a brand are shallow-copied with
 * the new field. Rows without a hit pass through unchanged.
 *
 * Fails open on DB errors — returns the input untouched.
 */
async function enrichRecommendationBrands(recommendations, deps = {}) {
  const rows = Array.isArray(recommendations) ? recommendations : [];
  if (!rows.length || !process.env.DATABASE_URL) return rows;
  const queryFn = typeof deps.queryFn === 'function' ? deps.queryFn : query;
  const logger = deps.logger || null;

  const sigIds = new Set();
  const extProductIds = new Set();
  const merchantPairs = new Map(); // key: `${merchant_id}::${productId}` → { merchant_id, product_id }

  const needs = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isPlainObject(row) || rowAlreadyHasBrand(row)) continue;
    const productId = rowProductId(row);
    if (!productId) continue;
    const lowered = productId.toLowerCase();
    let lookupKey = null;
    if (lowered.startsWith('sig_')) {
      sigIds.add(productId);
      lookupKey = `sig:${productId}`;
    } else if (lowered.startsWith('ext_') || lowered.startsWith('ext:') || lowered.includes(':')) {
      extProductIds.add(productId);
      lookupKey = `ext:${productId}`;
    } else {
      const merchantId = rowMerchantId(row);
      if (!merchantId) continue;
      const pairKey = `${merchantId}::${productId}`;
      merchantPairs.set(pairKey, { merchantId, productId });
      lookupKey = `mp:${pairKey}`;
    }
    needs.push({ index: i, lookupKey });
  }
  if (!needs.length) return rows;

  const brandByKey = new Map();
  try {
    if (sigIds.size) {
      const res = await queryFn(
        `SELECT pivota_signature_id, brand
           FROM catalog_products
          WHERE pivota_signature_id = ANY($1::text[])
            AND brand IS NOT NULL
            AND length(trim(brand)) > 0
          LIMIT $2`,
        [Array.from(sigIds), sigIds.size * 2],
      );
      for (const r of res?.rows || []) {
        const sig = trimmed(r?.pivota_signature_id);
        const brand = trimmed(r?.brand);
        if (sig && brand && !brandByKey.has(`sig:${sig}`)) brandByKey.set(`sig:${sig}`, brand);
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
        if (ext && brand && !brandByKey.has(`ext:${ext}`)) brandByKey.set(`ext:${ext}`, brand);
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
        if (mid && pid && brand && !brandByKey.has(key)) brandByKey.set(key, brand);
      }
    }
  } catch (err) {
    const message = String(err?.message || err || '');
    if (
      err?.code === 'NO_DATABASE' ||
      (message.includes('catalog_products') && message.includes('does not exist'))
    ) {
      return rows;
    }
    if (logger?.warn) {
      logger.warn(
        { err: message, total_needs: needs.length },
        'enrichRecommendationBrands query failed; passing rows through',
      );
    }
    return rows;
  }
  if (!brandByKey.size) return rows;

  const next = rows.slice();
  for (const need of needs) {
    const brand = brandByKey.get(need.lookupKey);
    if (!brand) continue;
    const original = next[need.index];
    if (!isPlainObject(original)) continue;
    next[need.index] = { ...original, brand };
  }
  return next;
}

module.exports = { enrichRecommendationBrands };

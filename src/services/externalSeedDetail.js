const { query } = require('../db');
const {
  EXTERNAL_SEED_MERCHANT_ID,
  buildExternalSeedProduct,
} = require('./externalSeedProducts');

const EXTERNAL_SEED_DETAIL_SCAN_LIMIT = Math.max(
  100,
  Math.min(10000, Number(process.env.EXTERNAL_SEED_DETAIL_SCAN_LIMIT || 5000) || 5000),
);
const EXTERNAL_SEED_DETAIL_CACHE_TTL_MS = Math.max(
  5000,
  Math.min(30 * 60 * 1000, Number(process.env.EXTERNAL_SEED_DETAIL_CACHE_TTL_MS || 10 * 60 * 1000) || 10 * 60 * 1000),
);
const EXTERNAL_SEED_DETAIL_CACHE_MAX_ENTRIES = Math.max(
  50,
  Math.min(10000, Number(process.env.EXTERNAL_SEED_DETAIL_CACHE_MAX_ENTRIES || 2000) || 2000),
);
const EXTERNAL_SEED_DETAIL_CACHE = new Map();

function asTrimmedString(value) {
  return String(value || '').trim();
}

function looksLikeStableExternalSeedId(productId) {
  return /^ext_[0-9a-f]{24}$/i.test(asTrimmedString(productId));
}

function materializeExternalSeedProduct(row) {
  const product = buildExternalSeedProduct(row);
  if (!product || typeof product !== 'object') return null;
  return {
    ...product,
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    market: asTrimmedString(row?.market) || product.market || undefined,
    tool: asTrimmedString(row?.tool) || product.tool || undefined,
    external_seed_id: product.external_seed_id || row?.id || null,
  };
}

function cloneProduct(product) {
  if (!product || typeof product !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(product));
  } catch {
    return { ...product };
  }
}

function getCachedExternalSeedDetail(productId) {
  const key = asTrimmedString(productId);
  if (!key) return null;
  const entry = EXTERNAL_SEED_DETAIL_CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    EXTERNAL_SEED_DETAIL_CACHE.delete(key);
    return null;
  }
  return cloneProduct(entry.product);
}

function setCachedExternalSeedDetail(productId, product) {
  const key = asTrimmedString(productId);
  if (!key || !product || typeof product !== 'object') return;
  if (EXTERNAL_SEED_DETAIL_CACHE.size >= EXTERNAL_SEED_DETAIL_CACHE_MAX_ENTRIES) {
    const overflow = EXTERNAL_SEED_DETAIL_CACHE.size - EXTERNAL_SEED_DETAIL_CACHE_MAX_ENTRIES + 1;
    let removed = 0;
    for (const oldestKey of EXTERNAL_SEED_DETAIL_CACHE.keys()) {
      EXTERNAL_SEED_DETAIL_CACHE.delete(oldestKey);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
  EXTERNAL_SEED_DETAIL_CACHE.set(key, {
    product: cloneProduct(product),
    expiresAtMs: Date.now() + EXTERNAL_SEED_DETAIL_CACHE_TTL_MS,
  });
}

function resetExternalSeedDetailCache() {
  EXTERNAL_SEED_DETAIL_CACHE.clear();
}

async function queryStableHashExternalSeedProduct({
  normalizedProductId,
  queryFn,
  selectSql,
  scanLimit,
}) {
  try {
    const result = await queryFn(
      `
        WITH stable_candidates AS (
          ${selectSql}
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT $2
        )
        SELECT *
        FROM stable_candidates
        WHERE (
          'ext_' || substr(
            encode(
              sha256(
                convert_to(
                  coalesce(
                    nullif(seed_data->'snapshot'->>'canonical_url', ''),
                    nullif(canonical_url, ''),
                    nullif(seed_data->>'canonical_url', ''),
                    nullif(seed_data->'snapshot'->>'destination_url', ''),
                    nullif(destination_url, ''),
                    nullif(seed_data->>'destination_url', '')
                  ),
                  'UTF8'
                )
              ),
              'hex'
            ),
            1,
            24
          )
        ) = $1
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 25
      `,
      [normalizedProductId, scanLimit],
    );

    for (const row of result?.rows || []) {
      const product = materializeExternalSeedProduct(row);
      if (asTrimmedString(product?.product_id) === normalizedProductId) return product;
    }
  } catch {
    // Fall back to the legacy bounded scan when the database lacks sha256 support.
  }
  return null;
}

async function findExternalSeedProductById({
  productId,
  queryFn = query,
  scanLimit = EXTERNAL_SEED_DETAIL_SCAN_LIMIT,
} = {}) {
  const normalizedProductId = asTrimmedString(productId);
  if (!normalizedProductId || typeof queryFn !== 'function') return null;
  const cached = getCachedExternalSeedDetail(normalizedProductId);
  if (cached) return cached;

  const selectSql = `
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
      updated_at,
      created_at
    FROM external_product_seeds
    WHERE status = 'active'
      AND attached_product_key IS NULL
  `;

  const directResult = await queryFn(
    `
      ${selectSql}
      AND (
        external_product_id = $1
        OR coalesce(seed_data->>'external_product_id', '') = $1
        OR coalesce(seed_data->>'product_id', '') = $1
        OR coalesce(seed_data->'snapshot'->>'product_id', '') = $1
      )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 25
    `,
    [normalizedProductId],
  );

  for (const row of directResult?.rows || []) {
    const product = materializeExternalSeedProduct(row);
    if (asTrimmedString(product?.product_id) === normalizedProductId) {
      setCachedExternalSeedDetail(normalizedProductId, product);
      return product;
    }
  }

  if (!looksLikeStableExternalSeedId(normalizedProductId)) return null;

  const safeScanLimit = Math.max(100, Math.min(10000, Number(scanLimit) || EXTERNAL_SEED_DETAIL_SCAN_LIMIT));
  const stableHashProduct = await queryStableHashExternalSeedProduct({
    normalizedProductId,
    queryFn,
    selectSql,
    scanLimit: safeScanLimit,
  });
  if (stableHashProduct) {
    setCachedExternalSeedDetail(normalizedProductId, stableHashProduct);
    return stableHashProduct;
  }

  const scanResult = await queryFn(
    `
      ${selectSql}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $1
    `,
    [safeScanLimit],
  );

  for (const row of scanResult?.rows || []) {
    const product = materializeExternalSeedProduct(row);
    if (asTrimmedString(product?.product_id) === normalizedProductId) {
      setCachedExternalSeedDetail(normalizedProductId, product);
      return product;
    }
  }

  return null;
}

module.exports = {
  EXTERNAL_SEED_DETAIL_SCAN_LIMIT,
  findExternalSeedProductById,
  looksLikeStableExternalSeedId,
  materializeExternalSeedProduct,
  _internals: {
    resetExternalSeedDetailCache,
  },
};

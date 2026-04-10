const { query } = require('../db');
const {
  EXTERNAL_SEED_MERCHANT_ID,
  buildExternalSeedProduct,
} = require('./externalSeedProducts');

const EXTERNAL_SEED_DETAIL_SCAN_LIMIT = Math.max(
  100,
  Math.min(10000, Number(process.env.EXTERNAL_SEED_DETAIL_SCAN_LIMIT || 5000) || 5000),
);

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

async function findExternalSeedProductById({
  productId,
  queryFn = query,
  scanLimit = EXTERNAL_SEED_DETAIL_SCAN_LIMIT,
} = {}) {
  const normalizedProductId = asTrimmedString(productId);
  if (!normalizedProductId || typeof queryFn !== 'function') return null;

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
    if (asTrimmedString(product?.product_id) === normalizedProductId) return product;
  }

  if (!looksLikeStableExternalSeedId(normalizedProductId)) return null;

  const safeScanLimit = Math.max(100, Math.min(10000, Number(scanLimit) || EXTERNAL_SEED_DETAIL_SCAN_LIMIT));
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
    if (asTrimmedString(product?.product_id) === normalizedProductId) return product;
  }

  return null;
}

module.exports = {
  EXTERNAL_SEED_DETAIL_SCAN_LIMIT,
  findExternalSeedProductById,
  looksLikeStableExternalSeedId,
  materializeExternalSeedProduct,
};

'use strict';

const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');

// Unminted referral pages have a durable content key but no sig_ alias. Resolve
// that key onto the stored seller/ref, retaining the identity the serving gate
// needs. A naked ext_ fallback changes the seller to the legacy seed bucket.
const REFERRAL_CONTENT_KEY_SQL = `/* referral_content_key_resolution */
  SELECT cp.merchant_id, cp.source_product_id, cp.product_key, cp.content_key,
         cp.platform, cp.source_system
  FROM catalog_products cp
  LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
  WHERE cp.content_key = $1
    AND cp.pivota_signature_id IS NULL
    AND cp.platform = 'external_seed'
    AND cp.source_system = 'external_product_seeds_mirror_v1'
    AND NULLIF(trim(cp.merchant_id), '') IS NOT NULL
    AND NULLIF(trim(cp.source_product_id), '') IS NOT NULL
    AND ${activeCatalogProductSourceWhere('cp', 'cm')}
  ORDER BY CASE cp.pdp_lifecycle_stage
             WHEN 'published' THEN 0 WHEN 'validated' THEN 1
             WHEN 'candidate' THEN 2 WHEN 'draft' THEN 3 ELSE 9 END,
           cp.updated_at DESC NULLS LAST, cp.product_key ASC
  LIMIT 1
`;

async function resolveReferralContentKey(contentKey, { queryFn } = {}) {
  const id = typeof contentKey === 'string' ? contentKey.trim() : '';
  if (!/^ck_[a-f0-9]{32}$/.test(id) || typeof queryFn !== 'function') return null;
  // Query errors propagate. They are unavailable reads, never evidence that
  // this product does not exist or permission to mint a new identity.
  const result = await queryFn(REFERRAL_CONTENT_KEY_SQL, [id]);
  const row = result?.rows?.[0];
  if (!row || row.content_key !== id || !row.merchant_id || !row.source_product_id) return null;
  return {
    merchant_id: row.merchant_id,
    product_id: row.source_product_id,
    product_key: row.product_key,
    content_key: row.content_key,
    platform: row.platform,
    source_system: row.source_system,
  };
}

module.exports = { resolveReferralContentKey, REFERRAL_CONTENT_KEY_SQL };

'use strict';

// Intentionally independent of PDP/detail/merchant sourcing. An unresolved
// purchase may outlive a proof or serving gate; only stored identity is needed
// to reproduce the original backend hash. Missing/ambiguous identity refuses
// recovery rather than choosing a different listing or fetching a storefront.
const IDENTITY_SQL = `
  SELECT cp.product_key, cp.platform, cp.source_system, cp.source_domain,
         cp.canonical_url,
         cp.product_payload->>'merchant_domain' AS merchant_domain,
         cp.product_payload->>'destination_url' AS destination_url,
         cp.product_payload->>'external_redirect_url' AS external_redirect_url,
         cp.product_payload->'snapshot'->>'destination_url' AS snapshot_destination_url
  FROM catalog_products cp
  WHERE cp.pivota_signature_id = $1 OR cp.product_key = $1 OR cp.source_product_id = $1
  LIMIT 2
`;

function createReapRecoveryIdentityReader({ query } = {}) {
  if (typeof query !== 'function') throw new TypeError('Recovery identity requires SQL query');
  return async (productId, ctx = {}) => {
    if (typeof productId !== 'string' || !productId.trim() || productId.length > 512
      || /[\u0000-\u001f\u007f]/.test(productId) || ctx.signal?.aborted) return null;
    const result = await query(IDENTITY_SQL, [productId.trim()]);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    if (rows.length !== 1 || ctx.signal?.aborted || !rows[0]?.product_key) return null;
    const row = rows[0];
    return {
      product_id: productId.trim(),
      product_key: row.product_key,
      platform: row.platform,
      source_system: row.source_system,
      source_domain: row.source_domain,
      merchant_domain: row.merchant_domain,
      canonical_url: row.canonical_url,
      destination_url: row.destination_url || row.snapshot_destination_url,
      external_redirect_url: row.external_redirect_url,
    };
  };
}

module.exports = { createReapRecoveryIdentityReader, IDENTITY_SQL };

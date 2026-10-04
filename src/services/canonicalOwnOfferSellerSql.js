'use strict';

// Shared official own-listing authority for discovery and selected canonical PDP money.
function buildCanonicalOwnOfferSellerSql() {
  return `(
    co.merchant_id = own_cp.merchant_id
    OR (
      own_cp.platform = 'external_seed'
      AND own_cp.source_system = 'catalog_enrichment_agent_v1'
      AND co.source_system = 'catalog_enrichment_agent_v1'
      AND co.offer_type = 'brand_direct' AND co.is_first_party IS TRUE
      AND co.offer_mode = 'external_referral' AND co.catalog_track = 'external_referral'
      AND co.truth_tier = 'primary' AND co.readiness_tier = 'referral_only'
      AND lower(own_cp.brand) ~ '[a-z0-9]'
      AND own_cp.source_domain IS NOT NULL
      AND own_cp.canonical_url ~ '^https://[a-z0-9.-]+/[^[:space:]?#]+$'
      AND substring(own_cp.canonical_url from '^https://([^/]+)') = own_cp.source_domain
      AND co.source_domain = own_cp.source_domain
      AND co.source_ref = own_cp.canonical_url
      AND co.offer_payload->>'destination_url' = own_cp.canonical_url
      AND co.offer_payload->>'canonical_url' = own_cp.canonical_url
      AND EXISTS (
        SELECT 1 FROM catalog_merchants listing_merchant
        WHERE listing_merchant.merchant_id = co.merchant_id
          AND listing_merchant.source_system = 'catalog_enrichment_agent_v1'
          AND listing_merchant.status = 'active' AND listing_merchant.indexable IS TRUE
          AND listing_merchant.source_ref = own_cp.source_domain
          AND listing_merchant.metadata_json->>'domain' = own_cp.source_domain
          AND co.merchant_id = 'agent_seed::' || left(trim(both '-' from
            regexp_replace(lower(own_cp.brand), '[^a-z0-9]+', '-', 'g')), 80)
      )
      AND EXISTS (
        SELECT 1 FROM catalog_skus listing_sku
        WHERE listing_sku.sku_key = co.sku_key
          AND listing_sku.product_key = own_cp.product_key
          AND listing_sku.merchant_id = own_cp.merchant_id
          AND listing_sku.currency = 'USD'
          AND listing_sku.suppressed_at IS NULL AND listing_sku.suppression_reason IS NULL
      )
    )
  )`;
}

module.exports = { buildCanonicalOwnOfferSellerSql };

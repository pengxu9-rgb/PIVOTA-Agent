'use strict';

const { notTestMerchantSql } = require('./testMerchantPolicy');

const EXTERNAL_SEED_MERCHANT_ID = 'external_seed';

function normalizeAlias(alias, fallback) {
  const text = String(alias || '').trim();
  return /^[a-z_][a-z0-9_]*$/i.test(text) ? text : fallback;
}

function productsCachePlatformExpr(alias = 'pc') {
  const a = normalizeAlias(alias, 'pc');
  return `
    lower(coalesce(
      nullif(trim(${a}.platform), ''),
      nullif(trim(${a}.product_data->>'platform'), ''),
      nullif(trim(${a}.product_data #>> '{platform_metadata,platform}'), '')
    ))
  `;
}

function activeProductsCacheSourceWhere(alias = 'pc') {
  const a = normalizeAlias(alias, 'pc');
  const platformExpr = productsCachePlatformExpr(a);
  // Test/demo rigs are excluded OUTSIDE the OR, never as another branch of it:
  // the external_seed branch below admits rows on merchant_id alone, so folding
  // the exclusion into the OR would let a rig keep serving through it.
  // products_cache has no source_domain column → merchant-id leg only.
  return `
    (
      ${notTestMerchantSql(a)}
      AND (
        ${a}.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'
        OR EXISTS (
          SELECT 1
          FROM merchant_stores ms_active_source
          WHERE ms_active_source.merchant_id = ${a}.merchant_id
            AND lower(coalesce(ms_active_source.status, '')) = 'active'
            AND coalesce(nullif(trim(ms_active_source.domain), ''), '') <> ''
            AND lower(coalesce(ms_active_source.platform, '')) = ${platformExpr}
        )
      )
    )
  `;
}

function catalogProductPlatformExpr(alias = 'cp') {
  const a = normalizeAlias(alias, 'cp');
  return `lower(coalesce(nullif(trim(${a}.platform), ''), ''))`;
}

function activeCatalogProductSourceWhere(productAlias = 'cp', merchantAlias = 'cm') {
  const p = normalizeAlias(productAlias, 'cp');
  const m = normalizeAlias(merchantAlias, 'cm');
  const platformExpr = catalogProductPlatformExpr(p);
  // Test/demo exclusion wraps the whole OR (external_seed branch admits on
  // merchant_id alone). catalog_products carries source_domain, so the demo
  // storefront-prefix leg is active here too — a re-connected demo store under
  // a new merchant_id is still excluded by domain.
  return `
    (
      ${notTestMerchantSql(p, { hasSourceDomain: true })}
      AND (
      ${p}.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'
      OR (
        -- 'observed' is the ADR-009 observed-seller-of-record status
        -- (merch_obs_… merchants minted by ensure_observed_seller). External
        -- seeds now live under those sellers instead of the legacy
        -- 'external_seed' bucket above, and ADR-009 (unblock merch_obs_ trust
        -- + serving) intends them to serve — so admit 'observed' alongside
        -- 'active'. Without this, every merch_obs_-keyed external seed is
        -- filtered out of the citable/category recall lane no matter its
        -- index_eligible/serving_eligible state.
        lower(coalesce(${m}.status, 'active')) IN ('active', 'observed')
        AND (
          NOT EXISTS (
            SELECT 1
            FROM merchant_stores ms_any_source
            WHERE ms_any_source.merchant_id = ${p}.merchant_id
          )
          OR EXISTS (
            SELECT 1
            FROM merchant_stores ms_active_source
            WHERE ms_active_source.merchant_id = ${p}.merchant_id
              AND lower(coalesce(ms_active_source.status, '')) = 'active'
              AND coalesce(nullif(trim(ms_active_source.domain), ''), '') <> ''
              AND (
                ${platformExpr} = ''
                OR lower(coalesce(ms_active_source.platform, '')) = ${platformExpr}
              )
          )
        )
      )
      )
    )
  `;
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  activeCatalogProductSourceWhere,
  activeProductsCacheSourceWhere,
};

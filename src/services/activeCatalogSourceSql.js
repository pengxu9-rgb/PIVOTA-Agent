'use strict';

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
  return `
    (
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
  return `
    (
      ${p}.merchant_id = '${EXTERNAL_SEED_MERCHANT_ID}'
      OR (
        lower(coalesce(${m}.status, 'active')) = 'active'
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
  `;
}

module.exports = {
  EXTERNAL_SEED_MERCHANT_ID,
  activeCatalogProductSourceWhere,
  activeProductsCacheSourceWhere,
};

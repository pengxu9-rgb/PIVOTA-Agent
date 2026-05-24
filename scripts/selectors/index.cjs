'use strict';

const LIMIT_PARAM_SCHEMA = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 10000 },
  },
  additionalProperties: false,
};

const selectors = [
  // FIXME: count diverges from audit by ~38% on 2026-05-24
  // (selector=18, audit≈13). This uses the current positive source-price
  // shape from external_product_seeds.price_amount.
  {
    name: 'missing_offers_fixable_positive_price',
    description: 'Active external seeds attached to catalog rows with no positive catalog offer but a positive source price.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
WITH seed_price AS (
  SELECT
    eps.id,
    eps.external_product_id,
    eps.attached_product_key,
    eps.title,
    eps.domain,
    eps.price_amount,
    eps.price_currency,
    eps.updated_at,
    eps.price_amount AS source_price
  FROM external_product_seeds eps
  WHERE eps.status = 'active'
    AND eps.attached_product_key IS NOT NULL
)
SELECT
  sp.id AS seed_id,
  sp.external_product_id,
  sp.attached_product_key AS product_key,
  sp.title,
  sp.domain,
  sp.source_price,
  sp.price_currency,
  sp.updated_at
FROM seed_price sp
WHERE sp.source_price > 0
  AND NOT EXISTS (
    SELECT 1
    FROM catalog_offers co
    WHERE co.product_key = sp.attached_product_key
      AND co.list_price > 0
  )
ORDER BY sp.updated_at DESC NULLS LAST, sp.id
`.trim(),
  },
  {
    name: 'missing_offers_blocked_no_positive_price',
    description: 'Active external seeds attached to catalog rows with no positive catalog offer and no positive source price.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
WITH seed_price AS (
  SELECT
    eps.id,
    eps.external_product_id,
    eps.attached_product_key,
    eps.title,
    eps.domain,
    eps.price_amount,
    eps.price_currency,
    eps.updated_at,
    eps.price_amount AS source_price
  FROM external_product_seeds eps
  WHERE eps.status = 'active'
    AND eps.attached_product_key IS NOT NULL
)
SELECT
  sp.id AS seed_id,
  sp.external_product_id,
  sp.attached_product_key AS product_key,
  sp.title,
  sp.domain,
  sp.source_price,
  sp.price_currency,
  sp.updated_at
FROM seed_price sp
WHERE (sp.source_price IS NULL OR sp.source_price <= 0)
  AND NOT EXISTS (
    SELECT 1
    FROM catalog_offers co
    WHERE co.product_key = sp.attached_product_key
      AND co.list_price > 0
  )
ORDER BY sp.updated_at DESC NULLS LAST, sp.id
`.trim(),
  },
  {
    name: 'missing_catalog_surface_image',
    description: 'Serving catalog rows whose denormalized PDP surface has no image.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  cp.product_key,
  cp.pivota_signature_id,
  cp.content_key,
  cp.source_system,
  cp.title,
  cp.brand,
  apv.image_url,
  cp.updated_at
FROM catalog_products cp
LEFT JOIN agent_pdp_view apv ON apv.content_key = cp.content_key
WHERE cp.sync_status = 'live'
  AND NULLIF(BTRIM(COALESCE(apv.image_url, cp.image_url, cp.product_payload->>'image_url')), '') IS NULL
ORDER BY cp.updated_at DESC NULLS LAST, cp.product_key
`.trim(),
  },
  // FIXME: count diverges from audit by ~7.5% on 2026-05-24
  // (selector=649, audit=604). This is limited to external seed mirror rows
  // and uses the materializer identity join convention.
  {
    name: 'identity_missing',
    description: 'Live catalog rows that do not have a matching PDP identity row.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  cp.product_key,
  cp.merchant_id,
  cp.platform,
  cp.source_product_id,
  cp.pivota_signature_id,
  cp.title,
  cp.brand,
  cp.updated_at
FROM catalog_products cp
LEFT JOIN pdp_identity_listing pil
  ON pil.merchant_id = cp.merchant_id
 AND pil.product_id = cp.source_product_id
WHERE cp.sync_status = 'live'
  AND cp.source_system = 'external_product_seeds_mirror_v1'
  AND pil.source_listing_ref IS NULL
ORDER BY cp.updated_at DESC NULLS LAST, cp.product_key
`.trim(),
  },
  {
    name: 'identity_approved_not_live',
    description: 'Approved identity rows that are not live-readable.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  pil.source_listing_ref,
  pil.merchant_id,
  pil.product_id,
  pil.source_kind,
  pil.identity_status,
  pil.live_read_enabled,
  pil.review_required,
  pil.updated_at
FROM pdp_identity_listing pil
WHERE pil.identity_status = 'approved'
  AND COALESCE(pil.live_read_enabled, false) IS NOT TRUE
ORDER BY pil.updated_at DESC NULLS LAST, pil.source_listing_ref
`.trim(),
  },
  // FIXME: count diverges from audit by ~9% on 2026-05-24
  // (selector=266, audit=244). The current schema exposes review_required
  // directly, with no narrower audit scope persisted.
  {
    name: 'identity_review_required',
    description: 'Identity rows currently held for manual review.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  pil.source_listing_ref,
  pil.merchant_id,
  pil.product_id,
  pil.source_kind,
  pil.identity_status,
  pil.live_read_enabled,
  pil.review_required,
  pil.review_reason_codes,
  pil.updated_at
FROM pdp_identity_listing pil
WHERE COALESCE(pil.review_required, false) IS TRUE
ORDER BY pil.updated_at DESC NULLS LAST, pil.source_listing_ref
`.trim(),
  },
  {
    name: 'catalog_payload_missing_seed_data',
    description: 'External-seed mirror catalog rows whose payload lost source seed fields.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  cp.product_key,
  cp.source_product_id AS external_product_id,
  cp.title,
  cp.brand,
  cp.source_ref,
  cp.updated_at
FROM catalog_products cp
WHERE cp.source_system = 'external_product_seeds_mirror_v1'
  AND (
    cp.product_payload IS NULL
    OR (
      jsonb_typeof(cp.product_payload->'seed_data') IS DISTINCT FROM 'object'
      AND jsonb_typeof(cp.product_payload->'external_seed') IS DISTINCT FROM 'object'
    )
  )
ORDER BY cp.updated_at DESC NULLS LAST, cp.product_key
`.trim(),
  },
  {
    name: 'catalog_payload_missing_snapshot',
    description: 'External-seed mirror catalog rows whose product_payload has no snapshot object.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  cp.product_key,
  cp.source_product_id AS external_product_id,
  cp.title,
  cp.brand,
  cp.source_ref,
  cp.updated_at
FROM catalog_products cp
WHERE cp.source_system = 'external_product_seeds_mirror_v1'
  AND (
    cp.product_payload IS NULL
    OR jsonb_typeof(cp.product_payload->'snapshot') IS DISTINCT FROM 'object'
  )
ORDER BY cp.updated_at DESC NULLS LAST, cp.product_key
`.trim(),
  },
  // FIXME: count diverges from audit by ~504% on 2026-05-24
  // (selector=1195, audit=198). The join now uses the canonical attachment key;
  // remaining gap appears to be catalog payload summary-location scope.
  {
    name: 'catalog_quality_summary_lost',
    description: 'External-seed mirror catalog rows missing PDP field quality summary in payload and snapshot.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  cp.product_key,
  cp.source_product_id AS external_product_id,
  cp.title,
  cp.brand,
  cp.source_ref,
  cp.updated_at,
  eps.updated_at AS seed_updated_at
FROM catalog_products cp
JOIN external_product_seeds eps
  ON eps.attached_product_key = cp.product_key
WHERE cp.source_system = 'external_product_seeds_mirror_v1'
  AND eps.status = 'active'
  AND (
    jsonb_typeof(eps.seed_data->'pdp_field_quality_summary') = 'object'
    OR jsonb_typeof(eps.seed_data->'snapshot'->'pdp_field_quality_summary') = 'object'
  )
  AND cp.product_payload IS NOT NULL
  AND jsonb_typeof(cp.product_payload->'pdp_field_quality_summary') IS DISTINCT FROM 'object'
  AND jsonb_typeof(cp.product_payload->'snapshot'->'pdp_field_quality_summary') IS DISTINCT FROM 'object'
ORDER BY eps.updated_at DESC NULLS LAST, cp.product_key
`.trim(),
  },
  {
    name: 'catalog_staler_than_seed',
    description: 'Catalog rows whose attached active external seed is newer than the mirrored catalog row.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  cp.product_key,
  cp.source_product_id AS external_product_id,
  cp.title,
  cp.brand,
  cp.updated_at AS catalog_updated_at,
  eps.updated_at AS seed_updated_at,
  eps.id AS seed_id
FROM catalog_products cp
JOIN external_product_seeds eps
  ON eps.attached_product_key = cp.product_key
WHERE eps.status = 'active'
  AND eps.updated_at > cp.updated_at
ORDER BY eps.updated_at DESC NULLS LAST, cp.product_key
`.trim(),
  },
  // FIXME: count diverges from audit by ~16% on 2026-05-24
  // (selector=613, audit=528). The query is scoped to external seed mirror
  // rows and recomputes identity, offer, content, and image gates live.
  {
    name: 'index_serving_contract_violation',
    description: 'Rows marked serving_eligible where at least one live-serving gate fails.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
WITH gated AS (
  SELECT
    ips.content_key,
    ips.pivota_signature_id,
    ips.serving_eligible,
    ips.last_consolidated_at,
    cp.product_key,
    cp.title,
    cp.brand,
    COALESCE(pil.identity_status, '') AS identity_status,
    COALESCE(pil.live_read_enabled, false) AS identity_live,
    COALESCE(pil.review_required, false) AS review_required,
    EXISTS (
      SELECT 1
      FROM catalog_offers co
      WHERE co.product_key = cp.product_key
        AND co.list_price > 0
    ) AS has_positive_offer,
    NULLIF(BTRIM(COALESCE(apv.image_url, cp.image_url, cp.product_payload->>'image_url')), '') IS NOT NULL AS has_image,
    COALESCE(LENGTH(NULLIF(BTRIM(COALESCE(apv.description, cp.description)), '')), 0) >= 50 AS has_description
  FROM index_pipeline_state ips
  JOIN catalog_products cp ON cp.content_key = ips.content_key
  LEFT JOIN agent_pdp_view apv ON apv.content_key = ips.content_key
  LEFT JOIN pdp_identity_listing pil
    ON pil.merchant_id = cp.merchant_id
   AND pil.product_id = cp.source_product_id
  WHERE ips.serving_eligible IS TRUE
    AND cp.source_system = 'external_product_seeds_mirror_v1'
)
SELECT *
FROM gated
WHERE NOT (
  identity_status = 'approved'
  AND identity_live IS TRUE
  AND review_required IS NOT TRUE
  AND has_positive_offer IS TRUE
  AND has_image IS TRUE
  AND has_description IS TRUE
)
ORDER BY last_consolidated_at DESC NULLS LAST, content_key
`.trim(),
  },
  {
    name: 'orphan_catalog_product',
    description: 'Catalog products with neither SKUs nor offers.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  cp.product_key,
  cp.merchant_id,
  cp.platform,
  cp.source_product_id,
  cp.source_system,
  cp.title,
  cp.brand,
  cp.updated_at
FROM catalog_products cp
WHERE NOT EXISTS (
    SELECT 1
    FROM catalog_skus cs
    WHERE cs.product_key = cp.product_key
  )
  AND NOT EXISTS (
    SELECT 1
    FROM catalog_offers co
    WHERE co.product_key = cp.product_key
  )
ORDER BY cp.updated_at DESC NULLS LAST, cp.product_key
`.trim(),
  },
  {
    name: 'orphan_offer_without_sku',
    description: 'Catalog offers whose sku_key no longer resolves to catalog_skus.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  co.offer_id,
  co.sku_key,
  co.product_key,
  co.merchant_id,
  co.source_system AS source,
  co.list_price,
  co.currency,
  co.created_at,
  co.updated_at
FROM catalog_offers co
LEFT JOIN catalog_skus cs ON cs.sku_key = co.sku_key
WHERE cs.sku_key IS NULL
ORDER BY co.updated_at DESC NULLS LAST, co.offer_id
`.trim(),
  },
  {
    name: 'zero_or_missing_price_offer',
    description: 'Catalog offers with list_price missing or non-positive.',
    paramSchema: LIMIT_PARAM_SCHEMA,
    query: `
SELECT
  co.offer_id,
  co.sku_key,
  co.product_key,
  co.merchant_id,
  co.source_system AS source,
  co.list_price,
  co.merchant_effective_price,
  co.currency,
  co.created_at,
  co.updated_at
FROM catalog_offers co
WHERE co.list_price IS NULL
   OR co.list_price <= 0
ORDER BY co.updated_at DESC NULLS LAST, co.offer_id
`.trim(),
  },
];

const selectorRegistry = Object.fromEntries(selectors.map((selector) => [selector.name, selector]));

function getSelector(name) {
  return selectorRegistry[String(name || '').trim()] || null;
}

module.exports = {
  getSelector,
  selectorRegistry,
  selectors,
};

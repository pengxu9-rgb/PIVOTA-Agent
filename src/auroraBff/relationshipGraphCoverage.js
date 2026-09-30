const { activeCatalogProductSourceWhere } = require('../services/activeCatalogSourceSql');

function normalizeUncoveredCooldownDays(value) {
  const n = Number(value);
  return value === '' || value == null || !Number.isFinite(n) ? 7 : Math.max(1, Math.min(90, Math.trunc(n)));
}

// Indexed member lookups mirror catalogEntityResolution's content-key/group membership paths.
// Count all member pg_ refs conservatively: the canonical resolver may choose any member group's
// id after dedupe. This avoids promoting a group that already has served or recently built edges.
function uncoveredLiveCatalogSql(alias = 'cp', { marketSql = '$2', cooldownDays = 7 } = {}) {
  const days = normalizeUncoveredCooldownDays(cooldownDays);
  return `${alias}.product_key IS NOT NULL
    AND ${activeCatalogProductSourceWhere(alias, 'cm')}
    AND ${alias}.suppressed_at IS NULL AND ${alias}.suppression_reason IS NULL
    AND NOT EXISTS (
      WITH member_keys AS (
        SELECT ${alias}.product_key
        UNION
        SELECT sibling.product_key FROM catalog_products sibling
        WHERE ${alias}.content_key IS NOT NULL AND ${alias}.content_key <> ''
          AND sibling.content_key = ${alias}.content_key
        UNION
        SELECT sibling.product_key
        FROM product_group_members own_member
        JOIN product_group_members sibling_member ON sibling_member.product_group_id = own_member.product_group_id
        JOIN catalog_products sibling ON sibling.merchant_id = sibling_member.merchant_id
          AND sibling.platform = sibling_member.platform
          AND sibling.source_product_id = sibling_member.platform_product_id
        WHERE own_member.merchant_id = ${alias}.merchant_id AND own_member.platform = ${alias}.platform
          AND own_member.platform_product_id = ${alias}.source_product_id
      ), members AS MATERIALIZED (
        SELECT member.* FROM member_keys
        JOIN catalog_products member ON member.product_key = member_keys.product_key
        LEFT JOIN catalog_merchants member_merchant ON member_merchant.merchant_id = member.merchant_id
        WHERE ${activeCatalogProductSourceWhere('member', 'member_merchant')}
      ), anchor_refs AS (
        SELECT lower('product:' || ref.id) AS ref FROM members
        CROSS JOIN LATERAL (VALUES (members.pivota_signature_id), (members.source_product_id)) ref(id)
        WHERE ref.id IS NOT NULL AND ref.id <> ''
        UNION
        SELECT lower('product:' || coverage_seed.external_product_id)
        FROM members JOIN external_product_seeds coverage_seed
          ON coverage_seed.attached_product_key = members.product_key
        UNION
        SELECT lower('product:' || pgm.product_group_id)
        FROM members JOIN product_group_members pgm ON pgm.merchant_id = members.merchant_id
          AND pgm.platform = members.platform AND pgm.platform_product_id = members.source_product_id
        WHERE pgm.product_group_id ~* '^pg_'
      )
      SELECT 1 FROM relationship_candidate_labels rcl
      WHERE lower(rcl.anchor_ref) IN (SELECT ref FROM anchor_refs)
        AND lower(rcl.market) = lower(${marketSql}) AND rcl.vertical = 'beauty'
        AND (
          (rcl.label_state IN ('ai_approved', 'human_approved')
            AND rcl.last_verified_at IS NOT NULL AND rcl.expires_at > now())
          OR rcl.created_at >= now() - interval '${days} days'
        )
    )`;
}

function productAnchorRefs(product) {
  // Loaded lazily: the serving graph also imports source normalization.
  const { buildAnchorRefsFromProduct } = require('./productRelationshipGraph');
  return buildAnchorRefsFromProduct(product)
    .filter((ref) => ref.startsWith('product:'))
    .map((ref) => ref.toLowerCase());
}

// Reuse serving's ref forms, including the signature identity preserved by #2265. A stable
// partition keeps each group's existing order after source normalization and deduplication.
function prioritizeUncoveredProducts(products, uncoveredProducts) {
  const refs = new Set(uncoveredProducts.flatMap(productAnchorRefs));
  const isUncovered = (product) => productAnchorRefs(product).some((ref) => refs.has(ref));
  return [...products.filter(isUncovered), ...products.filter((product) => !isUncovered(product))];
}

module.exports = { normalizeUncoveredCooldownDays, uncoveredLiveCatalogSql, prioritizeUncoveredProducts, productAnchorRefs };

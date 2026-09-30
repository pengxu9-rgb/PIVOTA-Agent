// Both lookups use idx_rcl_anchor_lookup(lower(anchor_ref), label_state). The attached-seed
// lookup also relies on idx_external_product_seeds_attached(attached_product_key, attached_variant_id).
function uncoveredLiveCatalogSql(alias = 'cp') {
  return `${alias}.pdp_will_render IS TRUE
    AND ${alias}.suppressed_at IS NULL AND ${alias}.suppression_reason IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM relationship_candidate_labels rcl
      WHERE lower(rcl.anchor_ref) = lower('product:' || ${alias}.pivota_signature_id)
        AND rcl.label_state IN ('ai_approved', 'human_approved')
        AND rcl.last_verified_at IS NOT NULL AND rcl.expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1 FROM external_product_seeds coverage_seed
      JOIN relationship_candidate_labels rcl
        ON lower(rcl.anchor_ref) = lower('product:' || coverage_seed.external_product_id)
      WHERE coverage_seed.attached_product_key = ${alias}.product_key
        AND rcl.label_state IN ('ai_approved', 'human_approved')
        AND rcl.last_verified_at IS NOT NULL AND rcl.expires_at > now()
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

module.exports = { uncoveredLiveCatalogSql, prioritizeUncoveredProducts, productAnchorRefs };

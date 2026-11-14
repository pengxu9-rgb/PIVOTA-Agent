'use strict';

const { queryWithBudget } = require('../db');
const {
  TABLE,
  validateReviewedIngredientEvidence,
  __internal: { formulaKey },
} = require('./relationshipReviewedIngredientEvidence');

const MAX_PROOFS_PER_PRODUCT = 4;

function proofMatchesVariant(sourceUrl, variantId, requestedSku) {
  const ids = new URL(sourceUrl).searchParams.getAll('variant');
  if (!requestedSku && ids.length === 0) return true;
  return ids.length === 1 && ids[0] === variantId;
}

async function loadRecommendationIngredientFormulas(refs, market, {
  query = queryWithBudget, nowMs = Date.now(),
} = {}) {
  // Resolve each recommendation through its own immutable catalog listing. A product-grain
  // observation cannot attest a distinct variant, and duplicate variant labels cannot bind proof.
  const result = await query(`
    SELECT target.ordinality, product.product_key, product.merchant_id, product.platform,
      CASE WHEN target.sku_id IS NOT NULL THEN variant.title END AS variant_title,
      variant.source_variant_id, evidence.*
    FROM jsonb_to_recordset($1::jsonb) AS target(ordinality int, product_id text, merchant_id text, sku_id text)
    JOIN LATERAL (
      SELECT cp.*, count(*) OVER () AS match_count
      FROM public.catalog_products cp
      WHERE (target.merchant_id IS NULL OR cp.merchant_id = target.merchant_id)
        AND (cp.pivota_signature_id = target.product_id
          OR (target.merchant_id IS NOT NULL AND cp.source_product_id = target.product_id))
      LIMIT 2
    ) product ON product.match_count = 1
    LEFT JOIN LATERAL (
      SELECT sku.title, sku.source_variant_id, count(*) OVER () AS match_count
      FROM public.catalog_skus sku
      WHERE sku.product_key = product.product_key AND sku.merchant_id = product.merchant_id
        AND sku.platform = product.platform AND sku.source_product_id = product.source_product_id
        AND (target.sku_id IS NULL OR sku.sku_key = target.sku_id OR sku.source_variant_id = target.sku_id)
      LIMIT 1
    ) variant ON variant.match_count = 1
    JOIN LATERAL (
      SELECT proof, evidence_id, identity_key, ingredient_text, formula_sha256, raw_source_sha256,
        source_url, source_observed_at, pivota_signature_id, product_id, source_product_id
      FROM ${TABLE} source
      WHERE source.product_key = product.product_key AND source.market = $2
        AND source.pivota_signature_id IN ('', coalesce(product.pivota_signature_id, ''))
        AND source.product_id IN ('', product.source_product_id, coalesce(product.pivota_signature_id, ''))
        AND source.source_product_id IN ('', product.source_product_id)
        AND source.merchant_id = product.merchant_id AND source.platform = product.platform
        AND ((target.sku_id IS NULL AND source.variant_title = '' AND source.variant_detail_label = ''
              AND (SELECT count(*) FROM public.catalog_skus s WHERE s.product_key = product.product_key) <= 1)
          OR (target.sku_id IS NOT NULL AND variant.title <> ''
              AND source.variant_title = variant.title AND source.variant_detail_label = ''
              AND (SELECT count(*) FROM public.catalog_skus s WHERE s.product_key = product.product_key
                   AND s.title = variant.title) = 1))
        AND source.source_observed_at >= $3::timestamptz - INTERVAL '45 days'
      ORDER BY source.source_observed_at DESC, source.evidence_id
      LIMIT $4
    ) evidence ON true
  `, [JSON.stringify(refs.map((ref, ordinality) => ({ ...ref, ordinality }))), market,
    new Date(nowMs).toISOString(), MAX_PROOFS_PER_PRODUCT + 1], { timeoutMs: 2500 });
  const proofsByPosition = new Map();
  for (const row of result.rows || []) {
    const proofs = proofsByPosition.get(row.ordinality) || [];
    proofs.push(row);
    proofsByPosition.set(row.ordinality, proofs);
  }

  return refs.map((ref, index) => {
    const rows = proofsByPosition.get(index) || [];
    if (!rows.length || rows.length > MAX_PROOFS_PER_PRODUCT) return null;
    try {
      const proofs = rows.map((row) => {
        const proof = validateReviewedIngredientEvidence(row.proof, { nowMs });
        if (proof.identity.market !== market || proof.identity.product_key !== row.product_key ||
            proof.identity.merchant_id !== row.merchant_id || proof.identity.platform !== row.platform ||
            proof.identity.variant_title !== (row.variant_title || '') || proof.identity.variant_detail_label !== '' ||
            proof.identity.pivota_signature_id !== row.pivota_signature_id || proof.identity.product_id !== row.product_id ||
            proof.identity.source_product_id !== row.source_product_id ||
            proof.evidence_id !== row.evidence_id || proof.identity_key !== row.identity_key ||
            proof.ingredient_text !== row.ingredient_text || proof.formula_sha256 !== row.formula_sha256 ||
            proof.raw_source_sha256 !== row.raw_source_sha256 || proof.source_url !== row.source_url ||
            Date.parse(proof.source_observed_at) !== new Date(row.source_observed_at).getTime() ||
            !proofMatchesVariant(proof.source_url, row.source_variant_id, ref.sku_id)) {
          throw new Error('ingredient_evidence_row_mismatch');
        }
        return proof;
      });
      if (new Set(proofs.map((proof) => formulaKey(proof.ingredient_text))).size !== 1) return null;
      const [proof] = proofs;
      return { ingredientText: proof.ingredient_text, sourceUrl: proof.source_url, market: proof.identity.market };
    } catch {
      return null;
    }
  });
}

module.exports = { loadRecommendationIngredientFormulas };

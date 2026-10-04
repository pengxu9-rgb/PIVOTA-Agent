'use strict';

const sample = require('./relgraph_1001_recommendation_sample.json');

// Local contract replay only. Titles/semantic expectations come from the supplied
// 10-01 sample; ids, review timestamps and stored approval rows are test data.
// These identifiers are deliberately not production anchor or publication proof.
function correctedAnchorFixture(nowMs = Date.now()) {
  const complement = sample.find((row) => row.i === 23);
  const variant = sample.find((row) => row.i === 29);
  const at = new Date(nowMs).toISOString();
  const expires = new Date(nowMs + 86400000).toISOString();
  const snapshot = (id, brand, title, extras = {}) => ({
    product_id: id, brand, title, name: title,
    merchant_id: 'fixture_seller', product_group_id: `fixture_group_${id}`,
    ...extras,
  });
  const makeEdge = (id, anchor, candidate, relationType = 'related_product') => ({
    id, anchor_type: 'product', anchor_ref: `product:${anchor.product_id}`,
    candidate_product_ref: `product:${candidate.product_id}`,
    anchor_snapshot: anchor, candidate_snapshot: candidate,
    relation_type: relationType, market: 'US', vertical: 'beauty',
    label_state: 'ai_approved', review_status: 'approved', evidence_grade: 'B',
    score_total: 0.9, score_breakdown: { category_use_case_match: 0.9 },
    source_refs: [{ type: 'regression_fixture', name: 'supplied_1001_sample' }],
    provenance: { regression_fixture: true, production_attestation: false },
    last_verified_at: at, expires_at: expires, created_at: at, updated_at: at,
  });
  // A shared product-line/review-family id must not turn different routine roles
  // into variants or equivalent retailer listings.
  const line = { product_line_id: 'fixture_line_shared', review_family_id: 'fixture_reviews_shared' };
  const anchor = snapshot('fixture_corrected_emulsion', complement.anchor_brand, complement.anchor_title, line);
  const candidate = snapshot('fixture_corrected_eye_cream', complement.candidate_brand, complement.candidate_title, line);
  const positive = makeEdge('fixture_corrected_complement_edge', anchor, candidate);
  positive.why_candidate = {
    relationship_kind: 'complement',
    summary: 'A different routine role; the shared collection is not variant identity.',
  };
  const sameProduct = makeEdge('fixture_same_product_size_edge',
    snapshot('fixture_size_30', 'Fixture House', 'Hydrating Face Cream 30ml'),
    snapshot('fixture_size_50', 'Fixture House', 'Hydrating Face Cream 50ml'),
    'competitive_alternative');
  const sameListing = makeEdge('fixture_duplicate_listing_edge',
    snapshot('fixture_listing_a', 'Fixture House', 'Hydrating Face Cream', { merchant_id: 'fixture_seller_a' }),
    snapshot('fixture_listing_b', 'Fixture House', 'Hydrating Face Cream', { merchant_id: 'fixture_seller_b' }));
  const shade = makeEdge('fixture_same_family_variant_edge',
    snapshot('fixture_shade_23', variant.anchor_brand, variant.anchor_title),
    snapshot('fixture_shade_27', variant.candidate_brand, variant.candidate_title));
  return { anchor, positive, sameProduct, sameListing, shade, rows: [positive, sameProduct, sameListing, shade] };
}

module.exports = { correctedAnchorFixture };

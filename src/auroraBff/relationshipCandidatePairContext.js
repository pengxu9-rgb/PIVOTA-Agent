'use strict';

const PAIR_LOCAL_FIELDS = Object.freeze([
  '_legacy_match', '_intel_match', 'curated_pair_evidence', 'legacy_dupe_kb_key', 'relation_hint',
  'score_total', 'similarity_score', 'score_breakdown', 'category_use_case_match',
  'ingredient_functional_similarity', 'price_advantage', 'evidence_quality', 'availability_confidence',
  'social_reference_strength', 'why_candidate', 'transitive_bridge_ref', 'transitive_path_confidence',
]);
const PAIR_SOURCE_TYPES = new Set(['aurora_dupe_kb', 'relationship_graph_transitive_recall']);
const pairType = value => PAIR_SOURCE_TYPES.has(String(value || '').trim().toLowerCase());
const pairSource = ref => pairType(ref?.type);
const SOURCE_TYPE_FIELDS = ['_source_type', 'source_type', 'sourceType', 'source'];
const hasPairCitations = product => Boolean(product && typeof product === 'object' && (
  ['source_refs', 'sourceRefs'].some(field => Array.isArray(product[field]) && product[field].some(pairSource)) ||
  SOURCE_TYPE_FIELDS.some(field => pairType(product[field]))));

function withoutPairCitations(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return product;
  const result = { ...product };
  for (const field of ['source_refs', 'sourceRefs']) {
    if (Array.isArray(product[field])) result[field] = product[field].filter(ref => !pairSource(ref));
  }
  for (const field of SOURCE_TYPE_FIELDS) {
    if (pairType(result[field])) delete result[field];
  }
  return result;
}

// Changing the anchor changes the pair. A bridge's reviewed pair is no proof of
// the new pair; its authority/grade cannot move with the listing.
function withoutRelationshipPairContext(product) {
  const result = withoutPairCitations(product);
  const hadPairAuthority = product._legacy_match || product.curated_pair_evidence || product.legacy_dupe_kb_key ||
    hasPairCitations(product) || (Array.isArray(product.ingredient_evidence) && product.ingredient_evidence.some(hasPairCitations));
  for (const field of PAIR_LOCAL_FIELDS) delete result[field];
  if (Array.isArray(product.ingredient_evidence)) {
    // A snapshot formula may carry the pair's refs alongside its actual INCI
    // citations. Shared listing evidence must retain only the latter.
    result.ingredient_evidence = product.ingredient_evidence.map(withoutPairCitations);
  }
  if (hadPairAuthority) { delete result.evidence_grade; delete result.evidenceGrade; }
  if (result.provenance) {
    const { curated_pair_evidence: _pair, ai_review: _review, ...listing } = result.provenance;
    result.provenance = listing;
  }
  return result;
}

module.exports = { PAIR_LOCAL_FIELDS, withoutRelationshipPairContext };

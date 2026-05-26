// Phase B preflight gates for the SKU relation graph.
//
// Goal: classify candidates produced by productRelationshipGraphBuilder into
// `prefilter_rejected` (won't reach reviewer queue) or `review_ready` BEFORE
// they consume human review capacity. Today's reviewer queue runs ~33%
// approval; Phase 0 analysis showed ~67% of human_rejected edges carried
// at least one of the four top failure-flag patterns. These gates encode
// structural predictors of those patterns using the 8 beauty attributes
// landed in PR #1553.
//
// Each gate is a PURE function. The caller composes them via applyAllGates.
// No DB I/O inside gates — the caller is responsible for resolving
// beauty attributes via productBeautyAttributes.lookupBeautyAttributesBatch
// before calling.

const MIN_CONFIDENCE_FOR_GATING = 0.7;

// Relation types where structural gates apply. `related_product` is
// intentionally exempt from form/area/spf gates — related products can
// legitimately span product_forms (lipstick + lip_liner, foundation + primer)
// and target_areas.
const STRUCTURAL_GATE_RELATION_TYPES = new Set([
  'dupe',
  'competitive_alternative',
  'niche_specialist',
]);

function isHighConfidence(attrs, field) {
  if (!attrs) return false;
  const value = attrs[field];
  const confidence = attrs[`${field}_confidence`];
  return value != null && confidence != null && Number(confidence) >= MIN_CONFIDENCE_FOR_GATING;
}

// Gate 1: product_form mismatch. If both anchor and candidate have a
// high-confidence product_form and they differ, the candidate is not a
// like-for-like alternative. Targets the 305 product_job_mismatch rejections.
function gateProductFormMismatch(anchorAttrs, candidateAttrs, relationType) {
  if (!STRUCTURAL_GATE_RELATION_TYPES.has(relationType)) {
    return { passes: true, reason: null };
  }
  if (!isHighConfidence(anchorAttrs, 'product_form')) return { passes: true, reason: null };
  if (!isHighConfidence(candidateAttrs, 'product_form')) return { passes: true, reason: null };
  if (anchorAttrs.product_form === candidateAttrs.product_form) {
    return { passes: true, reason: null };
  }
  return {
    passes: false,
    reason: `product_form_mismatch:${anchorAttrs.product_form}_vs_${candidateAttrs.product_form}`,
  };
}

// Gate 2: target_area mismatch. Face-vs-lips, body-vs-eyes, etc. — the
// candidate is not in the same product job space. Multi-area items pass
// through (foundation + primer both face, but a multi-area "body+face" set
// can pair with either).
function gateTargetAreaMismatch(anchorAttrs, candidateAttrs, relationType) {
  if (!STRUCTURAL_GATE_RELATION_TYPES.has(relationType)) {
    return { passes: true, reason: null };
  }
  if (!isHighConfidence(anchorAttrs, 'target_area')) return { passes: true, reason: null };
  if (!isHighConfidence(candidateAttrs, 'target_area')) return { passes: true, reason: null };
  if (anchorAttrs.target_area === 'multi_area' || candidateAttrs.target_area === 'multi_area') {
    return { passes: true, reason: null };
  }
  if (anchorAttrs.target_area === candidateAttrs.target_area) {
    return { passes: true, reason: null };
  }
  return {
    passes: false,
    reason: `target_area_mismatch:${anchorAttrs.target_area}_vs_${candidateAttrs.target_area}`,
  };
}

// Gate 3: SPF / OTC drug mismatch. A cosmetic moisturizer and an SPF
// moisturizer are not equivalent for compliance reasons (one carries an
// FDA-regulated claim, the other doesn't). Same logic for OTC drug claims
// (acne treatment etc. per FDA cosmetic-vs-drug guidance).
//
// dupe relation requires exact same compliance posture.
// competitive_alternative also requires same posture (you don't recommend a
// non-SPF as an alternative to a sunscreen).
// niche_specialist is exempt — a niche acne treatment may pair with a
// gentler cosmetic candidate by design.
function gateSpfOtcMismatch(anchorAttrs, candidateAttrs, relationType) {
  if (relationType !== 'dupe' && relationType !== 'competitive_alternative') {
    return { passes: true, reason: null };
  }
  if (!isHighConfidence(anchorAttrs, 'spf_or_otc_flag')) return { passes: true, reason: null };
  if (!isHighConfidence(candidateAttrs, 'spf_or_otc_flag')) return { passes: true, reason: null };
  const a = anchorAttrs.spf_or_otc_flag;
  const c = candidateAttrs.spf_or_otc_flag;
  if (a === c) return { passes: true, reason: null };
  // 'spf_otc' subsumes 'spf' or 'otc_drug' from a regulatory perspective.
  if ((a === 'spf' && c === 'spf_otc') || (a === 'spf_otc' && c === 'spf')) {
    return { passes: true, reason: null };
  }
  if ((a === 'otc_drug' && c === 'spf_otc') || (a === 'spf_otc' && c === 'otc_drug')) {
    return { passes: true, reason: null };
  }
  return {
    passes: false,
    reason: `spf_otc_mismatch:${a}_vs_${c}`,
  };
}

// applyAllGates: compose the gates. Returns { passes, label_state,
// prefilter_reasons }.
//
// label_state is what to write on the labels-table row:
//   - 'review_ready' if all gates pass
//   - 'prefilter_rejected' if any gate fails
//
// prefilter_reasons is an array of structured reason codes (one per failing
// gate). Caller persists these in a column (eg labels.prefilter_reasons) for
// future audit + recalibration.
function applyAllGates(anchorAttrs, candidateAttrs, relationType) {
  const results = [
    gateProductFormMismatch(anchorAttrs, candidateAttrs, relationType),
    gateTargetAreaMismatch(anchorAttrs, candidateAttrs, relationType),
    gateSpfOtcMismatch(anchorAttrs, candidateAttrs, relationType),
  ];
  const reasons = results.filter((r) => !r.passes).map((r) => r.reason);
  if (reasons.length === 0) {
    return { passes: true, label_state: 'review_ready', prefilter_reasons: [] };
  }
  return {
    passes: false,
    label_state: 'prefilter_rejected',
    prefilter_reasons: reasons,
  };
}

module.exports = {
  MIN_CONFIDENCE_FOR_GATING,
  STRUCTURAL_GATE_RELATION_TYPES,
  gateProductFormMismatch,
  gateTargetAreaMismatch,
  gateSpfOtcMismatch,
  applyAllGates,
};

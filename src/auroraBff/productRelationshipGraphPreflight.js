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

// Coarse families for the product_form gate. DeepSeek assigns granular form
// names; within-family mismatches are false positives because human reviewers
// treat them as legitimate competitive alternatives (e.g. lipstick ↔ lip_oil,
// cream ↔ lotion, bronzer ↔ powder). The gate compares families when both
// forms map to one; falls back to exact-match for any unmapped form.
// Calibrated against v1 validation results (approved_pass_rate=0.37, 256 FPs
// from product_form gate, 5/5 sample FPs confirmed within-family).
const PRODUCT_FORM_GROUPS = {
  // Lip color / finish delivery — all give lip pigment or gloss
  lipstick: 'lip_color', lip_stain: 'lip_color', lip_gloss: 'lip_color',
  lip_oil: 'lip_color', lip_tint: 'lip_color', lip_liner: 'lip_color',
  lip_pencil: 'lip_color', lip_crayon: 'lip_color', lip_lacquer: 'lip_color',
  lip_butter: 'lip_color',
  // Emollient face moisturizers (cream-weight textures) — gel is intentionally
  // excluded because cream-vs-gel was a human-rejected pair in validation.
  cream: 'face_emollient', lotion: 'face_emollient', gel_cream: 'face_emollient',
  milk: 'face_emollient', emulsion: 'face_emollient', fluid: 'face_emollient',
  // Face colour powders — bronzer ↔ powder and cream_powder ↔ powder both
  // appeared as approved competitive_alternative pairs in validation.
  powder: 'face_powder', bronzer: 'face_powder', blush: 'face_powder',
  highlighter: 'face_powder', setting_powder: 'face_powder',
  finishing_powder: 'face_powder', cream_powder: 'face_powder',
  // Fragrance concentration variants — all deliver the same scent at
  // different intensities; a shopper comparing them is doing competitive
  // alternative evaluation.
  eau_de_parfum: 'fragrance', eau_de_toilette: 'fragrance',
  parfum: 'fragrance', cologne: 'fragrance', perfume_oil: 'fragrance',
  solid_perfume: 'fragrance',
};

function isHighConfidence(attrs, field) {
  if (!attrs) return false;
  const value = attrs[field];
  const confidence = attrs[`${field}_confidence`];
  return value != null && confidence != null && Number(confidence) >= MIN_CONFIDENCE_FOR_GATING;
}

function productFormGroup(form) {
  return PRODUCT_FORM_GROUPS[form] || null;
}

// Gate 1: product_form mismatch. If both anchor and candidate have a
// high-confidence product_form and they differ outside the same form family,
// the candidate is not a like-for-like alternative.
function gateProductFormMismatch(anchorAttrs, candidateAttrs, relationType) {
  if (!STRUCTURAL_GATE_RELATION_TYPES.has(relationType)) {
    return { passes: true, reason: null };
  }
  if (!isHighConfidence(anchorAttrs, 'product_form')) return { passes: true, reason: null };
  if (!isHighConfidence(candidateAttrs, 'product_form')) return { passes: true, reason: null };
  const aForm = anchorAttrs.product_form;
  const cForm = candidateAttrs.product_form;
  if (aForm === cForm) return { passes: true, reason: null };
  const aGroup = productFormGroup(aForm);
  const cGroup = productFormGroup(cForm);
  if (aGroup !== null && aGroup === cGroup) return { passes: true, reason: null };
  return {
    passes: false,
    reason: `product_form_mismatch:${aForm}_vs_${cForm}`,
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

// Gate 3: SPF / OTC drug mismatch. Medicated products (otc_drug) and
// cosmetics are not equivalent — one carries FDA-regulated claims the other
// doesn't. Same for spf_otc combo products.
//
// cosmetic ↔ spf is intentionally EXEMPT: validation showed 19/441 approved
// competitive_alternative pairs were cosmetic ↔ spf (moisturizer with/without
// added SPF). Shoppers legitimately compare these as alternatives. Only the
// OTC drug axis (acne treatments, medicated formulas) signals genuine
// regulatory incompatibility.
//
// dupe and competitive_alternative: otc_drug axis gates apply.
// niche_specialist: fully exempt by design.
function gateSpfOtcMismatch(anchorAttrs, candidateAttrs, relationType) {
  if (relationType !== 'dupe' && relationType !== 'competitive_alternative') {
    return { passes: true, reason: null };
  }
  if (!isHighConfidence(anchorAttrs, 'spf_or_otc_flag')) return { passes: true, reason: null };
  if (!isHighConfidence(candidateAttrs, 'spf_or_otc_flag')) return { passes: true, reason: null };
  const a = anchorAttrs.spf_or_otc_flag;
  const c = candidateAttrs.spf_or_otc_flag;
  if (a === c) return { passes: true, reason: null };
  // spf_otc subsumes spf or otc_drug from a regulatory perspective.
  if ((a === 'spf' && c === 'spf_otc') || (a === 'spf_otc' && c === 'spf')) {
    return { passes: true, reason: null };
  }
  if ((a === 'otc_drug' && c === 'spf_otc') || (a === 'spf_otc' && c === 'otc_drug')) {
    return { passes: true, reason: null };
  }
  // cosmetic ↔ spf: SPF is an additive benefit on an otherwise-cosmetic product;
  // shoppers compare these as alternatives. Not a regulatory incompatibility.
  if ((a === 'cosmetic' && c === 'spf') || (a === 'spf' && c === 'cosmetic')) {
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
  PRODUCT_FORM_GROUPS,
  gateProductFormMismatch,
  gateTargetAreaMismatch,
  gateSpfOtcMismatch,
  applyAllGates,
};

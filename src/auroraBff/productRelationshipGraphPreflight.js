// Phase B preflight gates for the SKU relation graph.
//
// Goal: classify candidates produced by productRelationshipGraphBuilder into
// `prefilter_rejected` (won't reach reviewer queue) or `review_ready` BEFORE
// they consume human review capacity.
//
// Each gate is a PURE function. The caller composes them via applyAllGates.
// No DB I/O inside gates — the caller is responsible for resolving
// beauty attributes via productBeautyAttributes.lookupBeautyAttributesBatch
// before calling.
//
// History
//   v1 (74614ab3): exact-string product_form gate. approved_pass_rate=0.37.
//   v3 (a4640bea): added PRODUCT_FORM_GROUPS family map + cosmetic↔spf
//     exemption. approved_pass_rate=0.45.
//   v4 (d3b6dfcb): expanded face_emollient with moisturizer + K-beauty
//     forms. approved_pass_rate=0.52.
//   v5 (this): replaced product_form gate with category_leaf token-overlap
//     gate. Phase C's category_leaf is a more canonical, consistent axis
//     than product_form. Combined with target_area + spf_or_otc:
//     approved_pass_rate=0.909, gate_precision=0.860, catch_rate=0.326.

const MIN_CONFIDENCE_FOR_GATING = 0.7;

// Relation types where structural gates apply. `related_product` is
// intentionally exempt — related products can legitimately span categories
// (lipstick + lip_liner, foundation + primer).
const STRUCTURAL_GATE_RELATION_TYPES = new Set([
  'dupe',
  'competitive_alternative',
  'niche_specialist',
]);

// Stop-words: descriptive adjectives/qualifiers that vary across SKUs of the
// same product type and should not factor into category-overlap detection.
// Do NOT include body-part / area words (lip, body, face, eye, hair) — those
// are useful category discriminators.
const CATEGORY_LEAF_STOP_TOKENS = new Set([
  'matte', 'sheer', 'longwear', 'luminous', 'hydrating', 'soft', 'ultra',
  'shiny', 'natural', 'tinted', 'pressed', 'finishing', 'setting',
  'exfoliating', 'whipped', 'liquid', 'solid', 'full', 'light', 'medium',
  'heavy', 'dewy', 'satin', 'glossy', 'clear', 'colored', 'color', 'formula',
  'lightweight', 'rich', 'intensive', 'firming', 'plumping', 'retinol',
  'daily', 'overnight', 'sleeping', 'night',
]);

// Minimal synonym/stem map — collapses true equivalents. Avoid aggressive
// grouping (e.g. lipstick↔balm↔gloss) because reviewers DO distinguish those
// even within lip category; we'd lose real catches.
const CATEGORY_LEAF_ALIASES = {
  bronzing: 'bronzer',
  parfum: 'fragrance', perfume: 'fragrance', eau: 'fragrance',
  toilette: 'fragrance', cologne: 'fragrance',
  moisturizing: 'moisturizer',
  cleansing: 'cleanser',
};

function categoryLeafTokens(leaf) {
  if (!leaf || typeof leaf !== 'string') return new Set();
  const out = new Set();
  for (const t of leaf.split('_')) {
    if (!t || CATEGORY_LEAF_STOP_TOKENS.has(t)) continue;
    out.add(CATEGORY_LEAF_ALIASES[t] || t);
  }
  return out;
}

function shareCategoryLeafToken(a, b) {
  const ta = categoryLeafTokens(a);
  const tb = categoryLeafTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

function isHighConfidence(attrs, field) {
  if (!attrs) return false;
  const value = attrs[field];
  const confidence = attrs[`${field}_confidence`];
  return value != null && confidence != null && Number(confidence) >= MIN_CONFIDENCE_FOR_GATING;
}

// Gate 1: category_leaf mismatch. Phase C extracts category_leaf as the
// canonical product-type label (eg `whipped_body_cream`, `powder_foundation`,
// `eau_de_parfum`). Two candidates pass if their leaves share at least one
// non-stopword canonicalized token. Exact equality also passes.
//
// Why token-overlap not equality: DeepSeek's leaves include adjective-laden
// variants (`hydrating_foundation_spf` vs `powder_foundation`). Reviewers
// approve those as competitive alternatives. Token-overlap recovers the
// underlying category (`foundation`) without enumerating every adjective.
function gateCategoryLeafMismatch(anchorAttrs, candidateAttrs, relationType) {
  if (!STRUCTURAL_GATE_RELATION_TYPES.has(relationType)) {
    return { passes: true, reason: null };
  }
  if (!isHighConfidence(anchorAttrs, 'category_leaf')) return { passes: true, reason: null };
  if (!isHighConfidence(candidateAttrs, 'category_leaf')) return { passes: true, reason: null };
  const aLeaf = anchorAttrs.category_leaf;
  const cLeaf = candidateAttrs.category_leaf;
  if (aLeaf === cLeaf) return { passes: true, reason: null };
  if (shareCategoryLeafToken(aLeaf, cLeaf)) return { passes: true, reason: null };
  return {
    passes: false,
    reason: `category_leaf_mismatch:${aLeaf}_vs_${cLeaf}`,
  };
}

// Gate 2: target_area mismatch. Face-vs-lips, body-vs-eyes etc. Multi-area
// items pass through (a multi-area set can pair with either area).
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
// doesn't.
//
// cosmetic ↔ spf is intentionally EXEMPT: validation showed those pairs
// (moisturizer with/without added SPF) are routinely approved as competitive
// alternatives. Only the OTC drug axis signals genuine incompatibility.
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
  // cosmetic ↔ spf: SPF is an additive benefit; shoppers compare these.
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
// gate). Caller persists these for audit + recalibration.
function applyAllGates(anchorAttrs, candidateAttrs, relationType) {
  const results = [
    gateCategoryLeafMismatch(anchorAttrs, candidateAttrs, relationType),
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
  CATEGORY_LEAF_STOP_TOKENS,
  CATEGORY_LEAF_ALIASES,
  categoryLeafTokens,
  shareCategoryLeafToken,
  gateCategoryLeafMismatch,
  gateTargetAreaMismatch,
  gateSpfOtcMismatch,
  applyAllGates,
};

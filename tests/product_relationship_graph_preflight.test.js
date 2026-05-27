const {
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
} = require('../src/auroraBff/productRelationshipGraphPreflight');

function attrs(overrides = {}) {
  return {
    category_leaf: 'serum',
    category_leaf_confidence: 0.95,
    product_form: 'serum',
    product_form_confidence: 0.95,
    target_area: 'face',
    target_area_confidence: 0.95,
    spf_or_otc_flag: 'cosmetic',
    spf_or_otc_flag_confidence: 0.95,
    ...overrides,
  };
}

describe('preflight constants', () => {
  test('MIN_CONFIDENCE_FOR_GATING is 0.7', () => {
    expect(MIN_CONFIDENCE_FOR_GATING).toBe(0.7);
  });

  test('STRUCTURAL_GATE_RELATION_TYPES excludes related_product and includes the three strict types', () => {
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('dupe')).toBe(true);
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('competitive_alternative')).toBe(true);
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('niche_specialist')).toBe(true);
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('related_product')).toBe(false);
  });
});

describe('categoryLeafTokens', () => {
  test('splits on underscore and drops stopwords', () => {
    // matte, liquid, hydrating are stopwords; foundation, lipstick, spf, powder are kept.
    expect(categoryLeafTokens('matte_liquid_lipstick')).toEqual(new Set(['lipstick']));
    expect(categoryLeafTokens('hydrating_foundation_spf')).toEqual(new Set(['foundation', 'spf']));
    expect(categoryLeafTokens('powder_foundation')).toEqual(new Set(['foundation', 'powder']));
  });

  test('applies alias canonicalization (parfum → fragrance)', () => {
    // 'de' is not in STOP so it survives; the gate only needs one shared token
    // so the extra 'de' doesn't affect correctness.
    expect(categoryLeafTokens('eau_de_parfum').has('fragrance')).toBe(true);
    expect(categoryLeafTokens('solid_fragrance')).toEqual(new Set(['fragrance']));
  });

  test('applies alias canonicalization (bronzing → bronzer)', () => {
    // 'powder' is not in STOP; bronzer alias still ensures overlap with bare 'bronzer'.
    expect(categoryLeafTokens('bronzing_powder').has('bronzer')).toBe(true);
  });

  test('cream/lotion alias to moisturizer (v6: clears night_cream ↔ moisturizer FPs)', () => {
    expect(categoryLeafTokens('night_cream').has('moisturizer')).toBe(true);
    expect(categoryLeafTokens('body_cream').has('moisturizer')).toBe(true);
    expect(categoryLeafTokens('hydrating_lotion').has('moisturizer')).toBe(true);
    expect(categoryLeafTokens('vitamin_c_lotion').has('moisturizer')).toBe(true);
  });

  test('wash alias to cleanser (v6: clears face_wash ↔ daily_cleanser FPs)', () => {
    expect(categoryLeafTokens('face_wash').has('cleanser')).toBe(true);
    expect(categoryLeafTokens('foaming_face_wash').has('cleanser')).toBe(true);
    expect(categoryLeafTokens('daily_cleanser').has('cleanser')).toBe(true);
  });

  test('mist alias to toner (v6: clears toning_mist ↔ remineralising_toner FPs)', () => {
    expect(categoryLeafTokens('toning_mist').has('toner')).toBe(true);
    expect(categoryLeafTokens('remineralising_toner').has('toner')).toBe(true);
  });

  test('returns empty set for null or empty leaf', () => {
    expect(categoryLeafTokens(null)).toEqual(new Set());
    expect(categoryLeafTokens('')).toEqual(new Set());
  });

  test('preserves body-part / area words (lip, body, face) — they are useful discriminators', () => {
    expect(categoryLeafTokens('lip_liner').has('lip')).toBe(true);
    expect(categoryLeafTokens('body_oil').has('body')).toBe(true);
    expect(categoryLeafTokens('face_moisturizer').has('face')).toBe(true);
  });
});

describe('shareCategoryLeafToken', () => {
  test('returns true when tokens overlap', () => {
    expect(shareCategoryLeafToken('powder_foundation', 'hydrating_foundation_spf')).toBe(true);
    expect(shareCategoryLeafToken('eau_de_parfum', 'solid_fragrance')).toBe(true);
  });

  test('returns false when no tokens overlap', () => {
    expect(shareCategoryLeafToken('lip_balm', 'eye_cream')).toBe(false);
    expect(shareCategoryLeafToken('body_oil', 'natural_deodorant')).toBe(false);
  });

  test('returns false when either side is empty after stopword stripping', () => {
    expect(shareCategoryLeafToken('matte_liquid', 'sheer_glossy')).toBe(false);
  });
});

describe('gateCategoryLeafMismatch', () => {
  test('passes when both anchor and candidate have the same category_leaf', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'concealer' }),
      attrs({ category_leaf: 'concealer' }),
      'competitive_alternative',
    );
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('passes when category_leaves share a token (powder_foundation vs hydrating_foundation_spf)', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'powder_foundation' }),
      attrs({ category_leaf: 'hydrating_foundation_spf' }),
      'competitive_alternative',
    );
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('passes for fragrance synonyms (eau_de_parfum vs solid_fragrance)', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'eau_de_parfum' }),
      attrs({ category_leaf: 'solid_fragrance' }),
      'competitive_alternative',
    );
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('rejects when leaves do not share any token (lip_balm vs eye_cream)', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'lip_balm', product_form: 'balm' }),
      attrs({ category_leaf: 'eye_cream', product_form: 'cream' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('category_leaf_mismatch:lip_balm_vs_eye_cream');
  });

  test('rejects body_oil vs natural_deodorant (no overlap)', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'body_oil', product_form: 'oil' }),
      attrs({ category_leaf: 'natural_deodorant', product_form: 'deodorant' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
  });

  test('passes when anchor confidence below threshold (insufficient data)', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'lip_balm', category_leaf_confidence: 0.5 }),
      attrs({ category_leaf: 'eye_cream' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(true);
  });

  test('passes when candidate confidence below threshold', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'lip_balm' }),
      attrs({ category_leaf: 'eye_cream', category_leaf_confidence: 0.5 }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(true);
  });

  test('passes when category_leaf is null on either side', () => {
    expect(gateCategoryLeafMismatch(attrs({ category_leaf: null }), attrs({}), 'dupe').passes).toBe(true);
    expect(gateCategoryLeafMismatch(attrs({}), attrs({ category_leaf: null }), 'dupe').passes).toBe(true);
  });

  test('passes for related_product even on category mismatch (loose relation type)', () => {
    const r = gateCategoryLeafMismatch(
      attrs({ category_leaf: 'lipstick' }),
      attrs({ category_leaf: 'eye_shadow' }),
      'related_product',
    );
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('applies to all three structural relation types', () => {
    for (const rt of ['dupe', 'competitive_alternative', 'niche_specialist']) {
      const r = gateCategoryLeafMismatch(
        attrs({ category_leaf: 'lipstick', product_form: 'lipstick' }),
        attrs({ category_leaf: 'foundation', product_form: 'foundation' }),
        rt,
      );
      expect(r.passes).toBe(false);
    }
  });

  test('passes when one side has null attrs entirely', () => {
    expect(gateCategoryLeafMismatch(null, attrs({}), 'dupe').passes).toBe(true);
    expect(gateCategoryLeafMismatch(attrs({}), null, 'dupe').passes).toBe(true);
  });

  test('CATEGORY_LEAF_STOP_TOKENS and CATEGORY_LEAF_ALIASES are exported as plain objects/sets', () => {
    expect(CATEGORY_LEAF_STOP_TOKENS instanceof Set).toBe(true);
    expect(CATEGORY_LEAF_STOP_TOKENS.has('matte')).toBe(true);
    expect(CATEGORY_LEAF_STOP_TOKENS.has('foaming')).toBe(true);
    expect(typeof CATEGORY_LEAF_ALIASES).toBe('object');
    expect(CATEGORY_LEAF_ALIASES.parfum).toBe('fragrance');
    expect(CATEGORY_LEAF_ALIASES.bronzing).toBe('bronzer');
    expect(CATEGORY_LEAF_ALIASES.cream).toBe('moisturizer');
    expect(CATEGORY_LEAF_ALIASES.wash).toBe('cleanser');
  });

  describe('product_form fallback (v6)', () => {
    test('passes when leaves disagree but product_forms match (sheer_lipstick ↔ ultra_shine_lip_color)', () => {
      // category_leaf tokens: {lipstick} vs {lip} — no overlap.
      // product_form: both 'lipstick' high-conf → fallback passes.
      const r = gateCategoryLeafMismatch(
        attrs({ category_leaf: 'sheer_lipstick', product_form: 'lipstick' }),
        attrs({ category_leaf: 'ultra_shine_lip_color', product_form: 'lipstick' }),
        'competitive_alternative',
      );
      expect(r).toEqual({ passes: true, reason: null });
    });

    test('does NOT pass when leaves disagree AND product_forms also disagree (lip_liner ↔ lipstick TN preserved)', () => {
      const r = gateCategoryLeafMismatch(
        attrs({ category_leaf: 'lip_liner', product_form: 'lip_liner' }),
        attrs({ category_leaf: 'matte_liquid_lipstick', product_form: 'lipstick' }),
        'competitive_alternative',
      );
      expect(r.passes).toBe(false);
    });

    test('fallback requires high product_form confidence on both sides', () => {
      const r = gateCategoryLeafMismatch(
        attrs({ category_leaf: 'sheer_lipstick', product_form: 'lipstick', product_form_confidence: 0.5 }),
        attrs({ category_leaf: 'ultra_shine_lip_color', product_form: 'lipstick' }),
        'competitive_alternative',
      );
      expect(r.passes).toBe(false);
    });
  });
});

describe('gateTargetAreaMismatch', () => {
  test('passes when both target_areas are equal', () => {
    expect(gateTargetAreaMismatch(attrs({ target_area: 'face' }), attrs({ target_area: 'face' }), 'dupe').passes).toBe(true);
  });

  test('rejects face vs lips for strict relation types', () => {
    const r = gateTargetAreaMismatch(
      attrs({ target_area: 'face' }),
      attrs({ target_area: 'lips' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('target_area_mismatch:face_vs_lips');
  });

  test('multi_area on either side passes through', () => {
    expect(gateTargetAreaMismatch(attrs({ target_area: 'multi_area' }), attrs({ target_area: 'face' }), 'dupe').passes).toBe(true);
    expect(gateTargetAreaMismatch(attrs({ target_area: 'face' }), attrs({ target_area: 'multi_area' }), 'dupe').passes).toBe(true);
  });

  test('null target_area passes through (insufficient data)', () => {
    expect(gateTargetAreaMismatch(attrs({ target_area: null }), attrs({}), 'dupe').passes).toBe(true);
  });

  test('passes for related_product even on area mismatch', () => {
    expect(gateTargetAreaMismatch(
      attrs({ target_area: 'face' }),
      attrs({ target_area: 'lips' }),
      'related_product',
    ).passes).toBe(true);
  });

  test('cheeks ⊆ face: cheek_brush ↔ face_brush passes (v6)', () => {
    expect(gateTargetAreaMismatch(
      attrs({ target_area: 'cheeks' }),
      attrs({ target_area: 'face' }),
      'competitive_alternative',
    ).passes).toBe(true);
    expect(gateTargetAreaMismatch(
      attrs({ target_area: 'face' }),
      attrs({ target_area: 'cheeks' }),
      'competitive_alternative',
    ).passes).toBe(true);
  });

  test('cheeks does NOT compat with lips or body (only with face)', () => {
    expect(gateTargetAreaMismatch(
      attrs({ target_area: 'cheeks' }),
      attrs({ target_area: 'lips' }),
      'competitive_alternative',
    ).passes).toBe(false);
  });
});

describe('gateSpfOtcMismatch', () => {
  test('passes when both are cosmetic (the common case)', () => {
    expect(gateSpfOtcMismatch(attrs({}), attrs({}), 'dupe').passes).toBe(true);
  });

  test('passes cosmetic-vs-spf (moisturizer with/without SPF is a valid competitive alternative)', () => {
    const r = gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      attrs({ spf_or_otc_flag: 'spf' }),
      'competitive_alternative',
    );
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('passes cosmetic-vs-spf for dupe relation too', () => {
    const r = gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'spf' }),
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      'dupe',
    );
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('rejects cosmetic-vs-otc_drug for dupe', () => {
    const r = gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      attrs({ spf_or_otc_flag: 'otc_drug' }),
      'dupe',
    );
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('spf_otc_mismatch:cosmetic_vs_otc_drug');
  });

  test('rejects cosmetic-vs-otc_drug for competitive_alternative', () => {
    const r = gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      attrs({ spf_or_otc_flag: 'otc_drug' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
  });

  test('spf_otc subsumes spf', () => {
    expect(gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'spf' }),
      attrs({ spf_or_otc_flag: 'spf_otc' }),
      'dupe',
    ).passes).toBe(true);
  });

  test('spf_otc subsumes otc_drug', () => {
    expect(gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'otc_drug' }),
      attrs({ spf_or_otc_flag: 'spf_otc' }),
      'dupe',
    ).passes).toBe(true);
  });

  test('skipped for niche_specialist (intentionally exempt)', () => {
    expect(gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      attrs({ spf_or_otc_flag: 'otc_drug' }),
      'niche_specialist',
    ).passes).toBe(true);
  });

  test('skipped for related_product', () => {
    expect(gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      attrs({ spf_or_otc_flag: 'spf' }),
      'related_product',
    ).passes).toBe(true);
  });

  test('passes when confidence below threshold on either side', () => {
    expect(gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic', spf_or_otc_flag_confidence: 0.5 }),
      attrs({ spf_or_otc_flag: 'spf' }),
      'dupe',
    ).passes).toBe(true);
  });
});

describe('applyAllGates', () => {
  test('all-pass scenario yields review_ready', () => {
    const r = applyAllGates(
      attrs({ category_leaf: 'serum', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      attrs({ category_leaf: 'serum', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      'competitive_alternative',
    );
    expect(r).toEqual({ passes: true, label_state: 'review_ready', prefilter_reasons: [] });
  });

  test('single failing gate yields prefilter_rejected with one reason', () => {
    const r = applyAllGates(
      attrs({ category_leaf: 'lipstick', product_form: 'lipstick', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      attrs({ category_leaf: 'foundation', product_form: 'foundation', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
    expect(r.label_state).toBe('prefilter_rejected');
    expect(r.prefilter_reasons).toEqual(['category_leaf_mismatch:lipstick_vs_foundation']);
  });

  test('multiple failing gates accumulate reasons', () => {
    const r = applyAllGates(
      attrs({ category_leaf: 'lipstick', product_form: 'lipstick', target_area: 'lips', spf_or_otc_flag: 'cosmetic' }),
      attrs({ category_leaf: 'foundation', product_form: 'foundation', target_area: 'face', spf_or_otc_flag: 'otc_drug' }),
      'dupe',
    );
    expect(r.passes).toBe(false);
    expect(r.prefilter_reasons).toEqual(expect.arrayContaining([
      'category_leaf_mismatch:lipstick_vs_foundation',
      'target_area_mismatch:lips_vs_face',
      'spf_otc_mismatch:cosmetic_vs_otc_drug',
    ]));
    expect(r.prefilter_reasons.length).toBe(3);
  });

  test('related_product never rejects regardless of mismatches', () => {
    const r = applyAllGates(
      attrs({ category_leaf: 'lipstick', target_area: 'lips', spf_or_otc_flag: 'cosmetic' }),
      attrs({ category_leaf: 'foundation', target_area: 'face', spf_or_otc_flag: 'spf' }),
      'related_product',
    );
    expect(r).toEqual({ passes: true, label_state: 'review_ready', prefilter_reasons: [] });
  });

  test('missing attributes on either side pass through (insufficient data, no gating)', () => {
    expect(applyAllGates(null, attrs({}), 'dupe').passes).toBe(true);
    expect(applyAllGates(attrs({}), null, 'dupe').passes).toBe(true);
  });

  test('category_leaf token overlap passes (real-world FP fix)', () => {
    const r = applyAllGates(
      attrs({ category_leaf: 'powder_foundation', target_area: 'face' }),
      attrs({ category_leaf: 'hydrating_foundation_spf', target_area: 'face' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(true);
  });
});

const {
  MIN_CONFIDENCE_FOR_GATING,
  STRUCTURAL_GATE_RELATION_TYPES,
  gateProductFormMismatch,
  gateTargetAreaMismatch,
  gateSpfOtcMismatch,
  applyAllGates,
} = require('../src/auroraBff/productRelationshipGraphPreflight');

function attrs(overrides = {}) {
  return {
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

  test('STRUCTURAL_GATE_RELATION_TYPES excludes related_product (loose) and includes the three strict types', () => {
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('dupe')).toBe(true);
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('competitive_alternative')).toBe(true);
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('niche_specialist')).toBe(true);
    expect(STRUCTURAL_GATE_RELATION_TYPES.has('related_product')).toBe(false);
  });
});

describe('gateProductFormMismatch', () => {
  test('passes when both anchor and candidate have the same product_form', () => {
    const r = gateProductFormMismatch(attrs({ product_form: 'serum' }), attrs({ product_form: 'serum' }), 'competitive_alternative');
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('rejects when product_forms differ above confidence threshold', () => {
    const r = gateProductFormMismatch(
      attrs({ product_form: 'lipstick' }),
      attrs({ product_form: 'foundation' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('product_form_mismatch:lipstick_vs_foundation');
  });

  test('passes when anchor confidence is below threshold (insufficient data)', () => {
    const r = gateProductFormMismatch(
      attrs({ product_form: 'lipstick', product_form_confidence: 0.5 }),
      attrs({ product_form: 'foundation' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(true);
  });

  test('passes when candidate confidence is below threshold', () => {
    const r = gateProductFormMismatch(
      attrs({ product_form: 'lipstick' }),
      attrs({ product_form: 'foundation', product_form_confidence: 0.5 }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(true);
  });

  test('passes when product_form is null on either side', () => {
    expect(gateProductFormMismatch(attrs({ product_form: null }), attrs({}), 'dupe').passes).toBe(true);
    expect(gateProductFormMismatch(attrs({}), attrs({ product_form: null }), 'dupe').passes).toBe(true);
  });

  test('passes for related_product even on form mismatch (loose relation type)', () => {
    const r = gateProductFormMismatch(
      attrs({ product_form: 'lipstick' }),
      attrs({ product_form: 'lip_pencil' }),
      'related_product',
    );
    expect(r).toEqual({ passes: true, reason: null });
  });

  test('applies to all three structural relation types', () => {
    for (const rt of ['dupe', 'competitive_alternative', 'niche_specialist']) {
      const r = gateProductFormMismatch(
        attrs({ product_form: 'serum' }),
        attrs({ product_form: 'cream' }),
        rt,
      );
      expect(r.passes).toBe(false);
    }
  });

  test('passes when one side has null attrs entirely', () => {
    expect(gateProductFormMismatch(null, attrs({}), 'dupe').passes).toBe(true);
    expect(gateProductFormMismatch(attrs({}), null, 'dupe').passes).toBe(true);
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
});

describe('gateSpfOtcMismatch', () => {
  test('passes when both are cosmetic (the common case)', () => {
    expect(gateSpfOtcMismatch(attrs({}), attrs({}), 'dupe').passes).toBe(true);
  });

  test('rejects cosmetic-vs-spf for dupe (compliance gap)', () => {
    const r = gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      attrs({ spf_or_otc_flag: 'spf' }),
      'dupe',
    );
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('spf_otc_mismatch:cosmetic_vs_spf');
  });

  test('rejects cosmetic-vs-otc_drug for competitive_alternative', () => {
    const r = gateSpfOtcMismatch(
      attrs({ spf_or_otc_flag: 'cosmetic' }),
      attrs({ spf_or_otc_flag: 'otc_drug' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
  });

  test('spf_otc subsumes spf (both have sunscreen claim)', () => {
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
      attrs({ product_form: 'serum', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      attrs({ product_form: 'serum', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      'competitive_alternative',
    );
    expect(r).toEqual({ passes: true, label_state: 'review_ready', prefilter_reasons: [] });
  });

  test('single failing gate yields prefilter_rejected with one reason', () => {
    const r = applyAllGates(
      attrs({ product_form: 'lipstick', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      attrs({ product_form: 'foundation', target_area: 'face', spf_or_otc_flag: 'cosmetic' }),
      'competitive_alternative',
    );
    expect(r.passes).toBe(false);
    expect(r.label_state).toBe('prefilter_rejected');
    expect(r.prefilter_reasons).toEqual(['product_form_mismatch:lipstick_vs_foundation']);
  });

  test('multiple failing gates accumulate reasons', () => {
    const r = applyAllGates(
      attrs({ product_form: 'lipstick', target_area: 'lips', spf_or_otc_flag: 'cosmetic' }),
      attrs({ product_form: 'foundation', target_area: 'face', spf_or_otc_flag: 'spf' }),
      'dupe',
    );
    expect(r.passes).toBe(false);
    expect(r.prefilter_reasons).toEqual(expect.arrayContaining([
      'product_form_mismatch:lipstick_vs_foundation',
      'target_area_mismatch:lips_vs_face',
      'spf_otc_mismatch:cosmetic_vs_spf',
    ]));
    expect(r.prefilter_reasons.length).toBe(3);
  });

  test('related_product never rejects regardless of mismatches', () => {
    const r = applyAllGates(
      attrs({ product_form: 'lipstick', target_area: 'lips', spf_or_otc_flag: 'cosmetic' }),
      attrs({ product_form: 'foundation', target_area: 'face', spf_or_otc_flag: 'spf' }),
      'related_product',
    );
    expect(r).toEqual({ passes: true, label_state: 'review_ready', prefilter_reasons: [] });
  });

  test('missing attributes on either side pass through (insufficient data, no gating)', () => {
    expect(applyAllGates(null, attrs({}), 'dupe').passes).toBe(true);
    expect(applyAllGates(attrs({}), null, 'dupe').passes).toBe(true);
  });
});

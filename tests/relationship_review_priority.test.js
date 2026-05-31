const {
  FEATURE_NAMES,
  extractFeatures,
  computeReviewPriority,
  MODEL,
} = require('../src/auroraBff/relationshipReviewPriority');

function attrs(o = {}) {
  return {
    product_form: 'serum', category_leaf: 'vitamin_c_serum', target_area: 'face',
    scent_family: null, skin_concern: ['brightening'], claim_risk_level: 'medium', ...o,
  };
}

describe('extractFeatures', () => {
  test('vector length matches FEATURE_NAMES', () => {
    const v = extractFeatures({ anchorAttrs: attrs(), candidateAttrs: attrs(), relationType: 'competitive_alternative', scoreTotal: 0.9 });
    expect(v).toHaveLength(FEATURE_NAMES.length);
  });

  test('target_area match is 1 when equal, 0 when different, 0.5 when unknown', () => {
    const i = FEATURE_NAMES.indexOf('targetAreaMatch');
    expect(extractFeatures({ anchorAttrs: attrs({ target_area: 'face' }), candidateAttrs: attrs({ target_area: 'face' }) })[i]).toBe(1);
    expect(extractFeatures({ anchorAttrs: attrs({ target_area: 'face' }), candidateAttrs: attrs({ target_area: 'lips' }) })[i]).toBe(0);
    expect(extractFeatures({ anchorAttrs: attrs({ target_area: null }), candidateAttrs: attrs({ target_area: 'lips' }) })[i]).toBe(0.5);
  });

  test('category token overlap detects shared canonical token', () => {
    const i = FEATURE_NAMES.indexOf('categoryTokenOverlap');
    // cream/lotion alias to moisturizer → overlap
    expect(extractFeatures({ anchorAttrs: attrs({ category_leaf: 'rich_cream' }), candidateAttrs: attrs({ category_leaf: 'daily_lotion' }) })[i]).toBe(1);
    expect(extractFeatures({ anchorAttrs: attrs({ category_leaf: 'lipstick' }), candidateAttrs: attrs({ category_leaf: 'foundation' }) })[i]).toBe(0);
  });

  test('sameBrand is 1 only when both brands present and equal', () => {
    const i = FEATURE_NAMES.indexOf('sameBrand');
    expect(extractFeatures({ anchorAttrs: attrs(), candidateAttrs: attrs(), anchorBrand: 'Glow', candidateBrand: 'Glow' })[i]).toBe(1);
    expect(extractFeatures({ anchorAttrs: attrs(), candidateAttrs: attrs(), anchorBrand: 'Glow', candidateBrand: 'Lume' })[i]).toBe(0);
    expect(extractFeatures({ anchorAttrs: attrs(), candidateAttrs: attrs(), anchorBrand: 'Glow' })[i]).toBe(0);
  });

  test('skin_concern jaccard, 0.5 when both empty/unknown', () => {
    const i = FEATURE_NAMES.indexOf('skinConcernJaccard');
    expect(extractFeatures({ anchorAttrs: attrs({ skin_concern: ['a', 'b'] }), candidateAttrs: attrs({ skin_concern: ['a', 'b'] }) })[i]).toBe(1);
    expect(extractFeatures({ anchorAttrs: attrs({ skin_concern: [] }), candidateAttrs: attrs({ skin_concern: [] }) })[i]).toBe(0.5);
  });

  test('handles fully-missing attrs without throwing', () => {
    expect(() => extractFeatures({ anchorAttrs: null, candidateAttrs: null, relationType: 'dupe' })).not.toThrow();
  });
});

describe('computeReviewPriority', () => {
  test('returns null when no model is provided', () => {
    expect(computeReviewPriority({ anchorAttrs: attrs(), candidateAttrs: attrs() }, null)).toBeNull();
  });

  test('artifact is present and well-formed', () => {
    expect(MODEL).toBeTruthy();
    expect(MODEL.weights).toHaveLength(FEATURE_NAMES.length);
    expect(MODEL.cv_auc).toBeGreaterThan(0.6);
  });

  test('produces a probability in [0,1]', () => {
    const p = computeReviewPriority({ anchorAttrs: attrs(), candidateAttrs: attrs(), relationType: 'competitive_alternative', scoreTotal: 0.95 });
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  test('ranks a well-matched same-brand pair above a cross-area mismatch', () => {
    const good = computeReviewPriority({
      anchorAttrs: attrs({ target_area: 'face', category_leaf: 'vitamin_c_serum' }),
      candidateAttrs: attrs({ target_area: 'face', category_leaf: 'brightening_serum' }),
      relationType: 'competitive_alternative', scoreTotal: 0.95, anchorBrand: 'Glow', candidateBrand: 'Glow',
    });
    const bad = computeReviewPriority({
      anchorAttrs: attrs({ target_area: 'face', category_leaf: 'lipstick' }),
      candidateAttrs: attrs({ target_area: 'lips', category_leaf: 'mascara' }),
      relationType: 'competitive_alternative', scoreTotal: 0.95, anchorBrand: 'Glow', candidateBrand: 'Lume',
    });
    expect(good).toBeGreaterThan(bad);
  });
});

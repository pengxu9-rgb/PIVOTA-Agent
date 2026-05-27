const {
  numberArg,
  classifyEdgeForPrefilter,
} = require('../../scripts/build-product-relationship-graph');

describe('build product relationship graph CLI helpers', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  test('uses fallback when optional numeric flag is omitted', () => {
    process.argv = ['node', 'scripts/build-product-relationship-graph.js'];

    expect(numberArg('max-per-anchor', 24, { min: 1, max: 100 })).toBe(24);
  });

  test('clamps provided numeric flags', () => {
    process.argv = ['node', 'scripts/build-product-relationship-graph.js', '--max-per-anchor', '0'];

    expect(numberArg('max-per-anchor', 24, { min: 1, max: 100 })).toBe(1);
  });

  test('supports source-limit and anchor-offset numeric flags', () => {
    process.argv = [
      'node',
      'scripts/build-product-relationship-graph.js',
      '--source-limit',
      '1600',
      '--anchor-offset',
      '1200',
    ];

    expect(numberArg('source-limit', 200, { min: 200, max: 5000 })).toBe(1600);
    expect(numberArg('anchor-offset', 0, { min: 0, max: 5000 })).toBe(1200);
  });
});

describe('classifyEdgeForPrefilter — Phase B gate routing', () => {
  function edge(overrides = {}) {
    return {
      id: 'prel_test',
      anchor_ref: 'product:ext_a',
      candidate_product_ref: 'product:ext_b',
      relation_type: 'competitive_alternative',
      ...overrides,
    };
  }

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

  test('matching attrs: passed (label_state=generated, no reasons)', () => {
    const r = classifyEdgeForPrefilter({
      edge: edge(),
      defaultLabelState: 'generated',
      anchorAttrs: attrs(),
      candidateAttrs: attrs(),
    });
    expect(r).toEqual({ label_state: 'generated', prefilter_reasons: null, bucket: 'passed' });
  });

  test('clear category mismatch: rejected with reasons', () => {
    const r = classifyEdgeForPrefilter({
      edge: edge(),
      defaultLabelState: 'generated',
      anchorAttrs: attrs({ category_leaf: 'lip_balm', product_form: 'balm' }),
      candidateAttrs: attrs({ category_leaf: 'eye_cream', product_form: 'cream' }),
    });
    expect(r.label_state).toBe('prefilter_rejected');
    expect(r.bucket).toBe('rejected');
    expect(r.prefilter_reasons).toEqual(
      expect.arrayContaining(['category_leaf_mismatch:lip_balm_vs_eye_cream']),
    );
  });

  test('missing anchor attrs: skipped (passed-through, no gate applied)', () => {
    const r = classifyEdgeForPrefilter({
      edge: edge(),
      defaultLabelState: 'generated',
      anchorAttrs: undefined,
      candidateAttrs: attrs(),
    });
    expect(r).toEqual({ label_state: 'generated', prefilter_reasons: null, bucket: 'skipped' });
  });

  test('missing candidate attrs: skipped', () => {
    const r = classifyEdgeForPrefilter({
      edge: edge(),
      defaultLabelState: 'generated',
      anchorAttrs: attrs(),
      candidateAttrs: undefined,
    });
    expect(r.bucket).toBe('skipped');
  });

  test('explicit reviewer decision (human_approved) bypasses gate', () => {
    const r = classifyEdgeForPrefilter({
      edge: edge(),
      defaultLabelState: 'human_approved',
      // intentionally mismatched attrs that WOULD trigger the gate
      anchorAttrs: attrs({ category_leaf: 'lip_balm', product_form: 'balm' }),
      candidateAttrs: attrs({ category_leaf: 'eye_cream', product_form: 'cream' }),
    });
    expect(r).toEqual({ label_state: 'human_approved', prefilter_reasons: null, bucket: null });
  });

  test('explicit human_rejected bypasses gate', () => {
    const r = classifyEdgeForPrefilter({
      edge: edge(),
      defaultLabelState: 'human_rejected',
      anchorAttrs: attrs(),
      candidateAttrs: attrs(),
    });
    expect(r.label_state).toBe('human_rejected');
    expect(r.bucket).toBe(null);
  });

  test('related_product relation_type passes through gate (loose relation)', () => {
    const r = classifyEdgeForPrefilter({
      edge: edge({ relation_type: 'related_product' }),
      defaultLabelState: 'generated',
      anchorAttrs: attrs({ category_leaf: 'lipstick', product_form: 'lipstick' }),
      candidateAttrs: attrs({ category_leaf: 'lip_liner', product_form: 'lip_liner' }),
    });
    expect(r.bucket).toBe('passed');
    expect(r.label_state).toBe('generated');
  });
});

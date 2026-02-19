const {
  validateAndNormalizePrelabelOutput,
  fallbackInvalidJson,
} = require('../src/auroraBff/recoPrelabelValidator');

describe('aurora reco prelabel validator', () => {
  test('valid strict json passes', () => {
    const raw = JSON.stringify({
      suggested_label: 'relevant',
      wrong_block_target: null,
      confidence: 0.77,
      rationale_user_visible: 'Category and ingredient evidence aligns with the target block.',
      flags: ['needs_price_check'],
    });
    const out = validateAndNormalizePrelabelOutput(raw);
    expect(out.ok).toBe(true);
    expect(out.value.suggested_label).toBe('relevant');
    expect(out.value.wrong_block_target).toBeNull();
    expect(out.value.confidence).toBeCloseTo(0.77);
  });

  test('invalid json returns fallback object', () => {
    const out = validateAndNormalizePrelabelOutput('not-json');
    expect(out.ok).toBe(false);
    expect(out.value.suggested_label).toBe('not_relevant');
    expect(out.value.flags).toContain('invalid_json');
  });

  test('markdown fenced json is tolerated', () => {
    const out = validateAndNormalizePrelabelOutput(
      [
        '```json',
        '{',
        '  "suggested_label": "not_relevant",',
        '  "wrong_block_target": null,',
        '  "confidence": 0.31,',
        '  "rationale_user_visible": "Evidence is incomplete for this block.",',
        '  "flags": ["needs_category_check",],',
        '}',
        '```',
      ].join('\n'),
    );
    expect(out.ok).toBe(true);
    expect(out.value.suggested_label).toBe('not_relevant');
    expect(out.value.confidence).toBeCloseTo(0.31);
    expect(out.value.flags).toContain('needs_category_check');
  });

  test('nested wrapper object is extracted', () => {
    const out = validateAndNormalizePrelabelOutput(
      JSON.stringify({
        result: {
          suggested_label: 'wrong_block',
          wrong_block_target: 'related_products',
          confidence: 0.52,
          rationale_user_visible: 'The source is on-page related and should stay in related_products.',
          flags: ['needs_category_check'],
        },
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.value.suggested_label).toBe('wrong_block');
    expect(out.value.wrong_block_target).toBe('related_products');
  });

  test('fallback helper always emits invalid_json', () => {
    const out = fallbackInvalidJson(['low_social_signal']);
    expect(out.suggested_label).toBe('not_relevant');
    expect(out.flags).toEqual(expect.arrayContaining(['invalid_json', 'low_social_signal']));
  });
});

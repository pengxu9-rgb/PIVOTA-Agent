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

  test('fallback helper always emits invalid_json', () => {
    const out = fallbackInvalidJson(['low_social_signal']);
    expect(out.suggested_label).toBe('not_relevant');
    expect(out.flags).toEqual(expect.arrayContaining(['invalid_json', 'low_social_signal']));
  });
});

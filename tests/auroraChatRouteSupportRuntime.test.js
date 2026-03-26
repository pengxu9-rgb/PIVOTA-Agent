const { createChatRouteSupportRuntime } = require('../src/auroraBff/chatRouteSupportRuntime');

describe('createChatRouteSupportRuntime', () => {
  function createRuntime(overrides = {}) {
    return createChatRouteSupportRuntime({
      looksLikeSuitabilityRequest: jest.fn((message) => /适合我吗|suitable/i.test(String(message || ''))),
      looksLikeCompatibilityOrConflictQuestion: jest.fn((message) => /conflict/i.test(String(message || ''))),
      looksLikeWeatherOrEnvironmentQuestion: jest.fn((message) => /weather/i.test(String(message || ''))),
      looksLikeRecommendationRequest: jest.fn((message) => /recommend/i.test(String(message || ''))),
      ...overrides,
    });
  }

  test('extractProductInputFromFitCheckText strips wrappers and keeps product token', () => {
    const runtime = createRuntime();
    expect(
      runtime.extractProductInputFromFitCheckText('Evaluate: The Ordinary Niacinamide 10% + Zinc 1%'),
    ).toBe('The Ordinary Niacinamide 10% + Zinc 1%');
  });

  test('hasMeaningfulFitCheckAnchor rejects generic anchor prompts but accepts concrete names', () => {
    const runtime = createRuntime();
    expect(runtime.hasMeaningfulFitCheckAnchor({ message: 'Send a link' })).toBe(false);
    expect(runtime.hasMeaningfulFitCheckAnchor({ message: 'Is The Ordinary Niacinamide 10% + Zinc 1% suitable for me?' })).toBe(true);
  });

  test('looksLikeProductEvaluationIntentV2 excludes recommendation-only requests', () => {
    const runtime = createRuntime();
    expect(runtime.looksLikeProductEvaluationIntentV2('Can you recommend a product?', '')).toBe(false);
    expect(runtime.looksLikeProductEvaluationIntentV2('Can you evaluate this product for me?', '')).toBe(true);
    expect(runtime.looksLikeProductEvaluationIntentV2('', 'chip.action.analyze_product')).toBe(true);
  });

  test('buildRecoEntryChips localizes quick replies', () => {
    const runtime = createRuntime();
    expect(runtime.buildRecoEntryChips('CN').map((chip) => chip.label)).toEqual([
      '上传 daylight + indoor_white',
      '先用低置信度方案',
    ]);
    expect(runtime.buildRecoEntryChips('EN').map((chip) => chip.label)).toEqual([
      'Upload daylight + indoor_white',
      'Use low-confidence baseline',
    ]);
  });

  test('isRenderableCardForChatboxUi hides internal cards and keeps user-facing cards', () => {
    const runtime = createRuntime();
    expect(runtime.isRenderableCardForChatboxUi({ type: 'gate_notice' })).toBe(false);
    expect(runtime.isRenderableCardForChatboxUi({ type: 'aurora_structured' })).toBe(false);
    expect(runtime.isRenderableCardForChatboxUi({ type: 'product_analysis' })).toBe(true);
    expect(runtime.isRenderableCardForChatboxUi({ type: 'gate_notice' }, { debug: true })).toBe(true);
  });

  test('route inference prefers explicit message fit-check over reco cards', () => {
    const runtime = createRuntime();
    const fromCards = runtime.inferRouteFromCards([
      { type: 'recommendations', payload: { foo: 'bar' } },
    ]);
    const fromMessage = runtime.inferRouteFromMessageIntent('这个产品适合我吗？', { allowRecoCards: true });
    expect(runtime.resolveRouteHint(fromCards, fromMessage)).toEqual({
      route: 'fit-check',
      payload: {},
    });
  });
});

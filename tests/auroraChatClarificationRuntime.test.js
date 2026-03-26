const { createChatClarificationRuntime } = require('../src/auroraBff/chatClarificationRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    filterClarificationQuestionsForChips: jest.fn(({ clarification }) =>
      clarification && Array.isArray(clarification.questions) ? clarification.questions : []
    ),
    normalizeClarificationField: jest.fn((value) => {
      const text = String(value || '').trim().toLowerCase();
      if (text === 'skin_type') return 'skinType';
      if (text === 'budget') return 'budgetTier';
      return text || 'clarify';
    }),
    hasKnownClarificationFieldValue: jest.fn((profileSummary, field) => Boolean(profileSummary && profileSummary[field])),
    sanitizePendingClarification: jest.fn((value) => ({
      pending: {
        flow_id: value.flow_id,
        current: value.current,
        queue: value.queue,
      },
    })),
    buildChipsForQuestion: jest.fn((question) => [{ chip_id: `chip.${question.id}` }]),
    recordClarificationPresent: jest.fn(),
    recordRepeatedClarifyField: jest.fn(),
    recordClarificationFlowV2Started: jest.fn(),
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED: true,
    PENDING_CLARIFICATION_SCHEMA_V1: 1,
    makeFlowId: jest.fn(() => 'pc_test_123'),
    now: jest.fn(() => 1234567890),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatClarificationRuntime(deps),
  };
}

describe('aurora chat clarification runtime', () => {
  test('returns empty clarification state when upstream omits clarification payload', () => {
    const { runtime, deps } = buildRuntime();

    const result = runtime.deriveUpstreamClarification({
      upstream: {},
      profileSummary: {},
      filterKnown: true,
    });

    expect(result).toEqual({
      clarification: null,
      pendingClarificationFromUpstream: null,
      suggestedChips: [],
    });
    expect(deps.recordClarificationPresent).toHaveBeenCalledWith({ present: false });
    expect(deps.filterClarificationQuestionsForChips).toHaveBeenCalledWith({
      clarification: null,
      profileSummary: {},
      filterKnown: true,
    });
  });

  test('uses next remaining clarification question after known-field filtering', () => {
    const { runtime, deps } = buildRuntime({
      filterClarificationQuestionsForChips: jest.fn(() => [
        { id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] },
      ]),
    });

    const result = runtime.deriveUpstreamClarification({
      upstream: {
        clarification: {
          questions: [
            { id: 'skin_type', question: 'Skin type?', options: ['Dry', 'Oily'] },
            { id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] },
          ],
        },
      },
      profileSummary: { skinType: 'oily' },
      filterKnown: true,
      message: 'help me build a routine',
    });

    expect(result.pendingClarificationFromUpstream).toBeNull();
    expect(result.suggestedChips).toEqual([{ chip_id: 'chip.budget' }]);
    expect(deps.buildChipsForQuestion).toHaveBeenCalledWith(
      { id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] },
      { stepIndex: 1 },
    );
    expect(deps.recordClarificationFlowV2Started).not.toHaveBeenCalled();
  });

  test('seeds pending clarification queue when multiple clarification questions remain', () => {
    const { runtime, deps } = buildRuntime({
      filterClarificationQuestionsForChips: jest.fn(() => [
        { id: 'skin_type', question: 'Skin type?', options: ['Dry', 'Oily'] },
        { id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] },
        { id: 'goal', question: 'Goal?', options: ['Acne', 'Dryness'] },
      ]),
    });

    const result = runtime.deriveUpstreamClarification({
      upstream: {
        clarification: {
          questions: [
            { id: 'skin_type', question: 'Skin type?', options: ['Dry', 'Oily'] },
            { id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] },
            { id: 'goal', question: 'Goal?', options: ['Acne', 'Dryness'] },
          ],
        },
      },
      profileSummary: { skinType: 'oily' },
      filterKnown: false,
      upstreamMessage: 'show me a routine',
    });

    expect(result.suggestedChips).toEqual([{ chip_id: 'chip.skin_type' }]);
    expect(result.pendingClarificationFromUpstream).toEqual({
      flow_id: 'pc_test_123',
      current: { id: 'skin_type' },
      queue: [
        { id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] },
        { id: 'goal', question: 'Goal?', options: ['Acne', 'Dryness'] },
      ],
    });
    expect(deps.sanitizePendingClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        v: 1,
        flow_id: 'pc_test_123',
        created_at_ms: 1234567890,
        resume_user_text: 'show me a routine',
        current: { id: 'skin_type' },
      }),
      { recordMetrics: true },
    );
    expect(deps.recordClarificationFlowV2Started).toHaveBeenCalled();
    expect(deps.recordRepeatedClarifyField).toHaveBeenCalledWith({ field: 'skinType' });
  });
});

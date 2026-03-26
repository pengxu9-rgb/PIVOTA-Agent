const { createClarificationRuntime } = require('../src/auroraBff/clarificationRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    stableHashBase36: jest.fn(() => 'abc123hashvalue'),
    normalizeClarificationField: jest.fn((value) => {
      const text = String(value || '').trim().toLowerCase();
      if (text === 'skin_type' || text === 'skintype') return 'skinType';
      if (text === 'budget') return 'budgetTier';
      return text || 'clarify';
    }),
    filterableClarificationFields: new Set(['skinType', 'budgetTier']),
    hasKnownClarificationFieldValue: jest.fn((profileSummary, field) => Boolean(profileSummary && profileSummary[field])),
    recordClarificationSchemaInvalid: jest.fn(),
    recordClarificationQuestionFiltered: jest.fn(),
    recordRepeatedClarifyField: jest.fn(),
    recordClarificationAllQuestionsFiltered: jest.fn(),
    recordPendingClarificationUpgraded: jest.fn(),
    recordPendingClarificationTruncated: jest.fn(),
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    ...overrides,
  };

  return {
    deps,
    runtime: createClarificationRuntime(deps),
  };
}

describe('createClarificationRuntime', () => {
  test('filters clarification questions for already known profile fields', () => {
    const { runtime, deps } = buildRuntime();

    const questions = runtime.filterClarificationQuestionsForChips({
      clarification: {
        questions: [
          { id: 'skin_type', question: 'What is your skin type?', options: ['Dry', 'Oily'] },
          { id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] },
        ],
      },
      profileSummary: { skinType: 'oily' },
      filterKnown: true,
    });

    expect(questions).toEqual([{ id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] }]);
    expect(deps.recordClarificationQuestionFiltered).toHaveBeenCalledWith({ field: 'skinType' });
    expect(deps.recordRepeatedClarifyField).toHaveBeenCalledWith({ field: 'skinType' });
  });

  test('sanitizes legacy pending clarification payloads into canonical shape', () => {
    const { runtime, deps } = buildRuntime();

    const out = runtime.sanitizePendingClarification({
      created_at_ms: 123,
      resume_user_text: 'x'.repeat(900),
      current: { id: 'skin_type' },
      queue: [
        {
          id: 'budget',
          question: 'Q'.repeat(260),
          options: ['A'.repeat(100), 'Mid'],
        },
      ],
      history: [],
    });

    expect(out.pending.v).toBe(1);
    expect(out.pending.resume_user_text).toHaveLength(800);
    expect(out.pending.current.id).toBe('skin_type');
    expect(out.pending.queue[0].question).toHaveLength(200);
    expect(out.pending.queue[0].options[0]).toHaveLength(80);
    expect(deps.recordPendingClarificationUpgraded).toHaveBeenCalledWith({ from: 'legacy' });
    expect(deps.recordPendingClarificationTruncated).toHaveBeenCalled();
  });

  test('advances pending clarification and seeds the next question state', () => {
    const { runtime } = buildRuntime();

    const pending = runtime.sanitizePendingClarification(
      {
        v: 1,
        created_at_ms: 123,
        resume_user_text: 'help me build a routine',
        current: { id: 'skin_type' },
        queue: [{ id: 'budget', question: 'Budget?', options: ['Low', 'Mid'] }],
        history: [],
      },
      { recordMetrics: false },
    ).pending;

    const next = runtime.advancePendingClarification(pending, 'Dry', 'skin_type');

    expect(next.history[0]).toEqual(
      expect.objectContaining({
        question_id: 'skin_type',
        option: 'Dry',
      }),
    );
    expect(next.nextQuestion).toEqual(
      expect.objectContaining({
        id: 'budget',
        question: 'Budget?',
      }),
    );
    expect(next.nextPending).toEqual(
      expect.objectContaining({
        current: expect.objectContaining({ id: 'budget' }),
      }),
    );
  });
});

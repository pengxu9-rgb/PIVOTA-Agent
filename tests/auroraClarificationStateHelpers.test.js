const {
  createClarificationStateHelpers,
} = require('../src/auroraBff/clarificationStateHelpers');

function buildHelpers(overrides = {}) {
  const deps = {
    stableHashBase36: jest.fn(() => 'stablehashvalue123'),
    recordClarificationIdNormalizedEmpty: jest.fn(),
    normalizeBudgetHint: jest.fn((value) => {
      const text = String(value || '').trim();
      if (/50/.test(text)) return 'budget_50';
      return '';
    }),
    ...overrides,
  };

  return {
    deps,
    helpers: createClarificationStateHelpers(deps),
  };
}

describe('createClarificationStateHelpers', () => {
  test('normalizes common clarification ids and falls back to stable hash for empty ids', () => {
    const { helpers, deps } = buildHelpers();

    expect(helpers.normalizeClarificationField('皮肤类型')).toBe('skinType');
    expect(helpers.normalizeClarificationField('预算档')).toBe('budgetTier');

    const fallback = helpers.normalizeClarificationField('!!!');
    expect(fallback).toBe('cid_stablehashva');
    expect(deps.recordClarificationIdNormalizedEmpty).toHaveBeenCalledTimes(1);
  });

  test('builds resume-known profile fields and drops unknown values', () => {
    const { helpers } = buildHelpers();

    expect(
      helpers.buildResumeKnownProfileFields({
        skinType: 'oily',
        sensitivity: 'unknown',
        barrierStatus: 'healthy',
        goals: ['dehydration', ''],
        budgetTier: 'budget_friendly',
      }),
    ).toEqual({
      skinType: 'oily',
      barrierStatus: 'healthy',
      goals: ['dehydration'],
      budgetTier: 'budget_friendly',
    });
  });

  test('infers profile patches from clarification replies', () => {
    const { helpers } = buildHelpers();

    expect(
      helpers.inferProfilePatchFromClarification({
        clarificationId: 'skin_type',
        replyText: 'I have oily skin',
      }),
    ).toEqual({ skinType: 'oily' });

    expect(
      helpers.inferProfilePatchFromClarification({
        clarificationId: '预算档',
        replyText: '预算50以内',
      }),
    ).toEqual({ budgetTier: 'budget_50' });
  });

  test('parses clarification chip actions and detects pending state hints', () => {
    const { helpers } = buildHelpers();

    const action = {
      action_id: 'chip.clarify.skin_type.oily',
      data: {
        clarification_question_id: 'skin_type',
      },
    };

    expect(helpers.isClarifyChipAction(action)).toBe(true);
    expect(helpers.parseClarificationIdFromActionId(action.action_id)).toBe('skin_type');
    expect(helpers.parseClarificationReplyFromActionId(action.action_id)).toBe('oily');
    expect(helpers.extractClarificationQuestionIdFromAction(action)).toBe('skin_type');
    expect(helpers.hasPendingClarificationStateHint({ data: { clarification_step: 2 } })).toBe(true);
  });
});

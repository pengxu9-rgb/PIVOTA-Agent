const { createChatRecoPreludeRuntime } = require('../src/auroraBff/chatRecoPreludeRuntime');

function mergeRecoContext(base, patch) {
  if (!patch || typeof patch !== 'object') return base || null;
  return {
    ...(base && typeof base === 'object' ? base : {}),
    ...patch,
  };
}

function buildRuntime(overrides = {}) {
  const recordAuroraSkinFlowMetric = jest.fn();
  const recordAuroraRecoEntrySource = jest.fn();
  const runtime = createChatRecoPreludeRuntime({
    logger: { info: jest.fn() },
    mergeIngredientRecoContextValue: jest.fn(mergeRecoContext),
    pickFirstTrimmed: jest.fn((...values) => {
      for (const value of values) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text) return text;
      }
      return '';
    }),
    normalizeIngredientCandidateList: jest.fn((items, limit) => (Array.isArray(items) ? items.slice(0, limit) : [])),
    extractIngredientLookupTargetFromText: jest.fn(async () => ''),
    profileCompleteness: jest.fn(() => ({ score: 4, missing: [] })),
    evaluateSafetyBoundary: jest.fn(() => ({ block: false })),
    buildConfidenceNoticeCardPayload: jest.fn((payload) => payload),
    recordAuroraSkinFlowMetric,
    recordAuroraRecoEntrySource,
    ...overrides,
  });
  return {
    runtime,
    recordAuroraSkinFlowMetric,
    recordAuroraRecoEntrySource,
  };
}

function buildDeps(overrides = {}) {
  return {
    ingredientRecoContext: null,
    ingredientRecoOptInRequested: false,
    ingredientActionData: null,
    message: 'recommend something',
    ctx: { request_id: 'req_1', lang: 'EN' },
    recoEntrySourceDetail: 'profile_refine_rerun',
    safetyDecision: { block_level: 'warn' },
    profile: { skinType: 'dry' },
    identity: { auroraUid: 'aur_1', userId: 'user_1' },
    pendingSafetyAdvisory: { notice: 'pending' },
    pushGateDecision: jest.fn(() => ({ mode: 'advisory' })),
    enqueueGateAdvisory: jest.fn(),
    pendingClarificationPatchOverride: null,
    buildDiagnosisChips: jest.fn((_lang, fields) => fields.map((field) => ({ chip_id: `chip_${field}` }))),
    chatSafetyRuntime: {
      resolveSafetyGate: jest.fn(async ({ profile, pendingSafetyAdvisory }) => ({
        profile,
        pendingSafetyAdvisory,
        blockedEnvelope: null,
      })),
    },
    chatDiagnosisGateRuntime: {
      applyDiagnosisFirstProfileGate: jest.fn(() => ({ pendingClarificationPatchOverride: { pending: true } })),
    },
    buildEnvelope: jest.fn((_ctx, payload) => payload),
    makeChatAssistantMessage: jest.fn((content) => ({ content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    canonicalIntent: { intent: 'reco_products' },
    ...overrides,
  };
}

describe('aurora chat reco prelude runtime', () => {
  test('builds ingredient reco context and diagnosis-first refinement state', async () => {
    const { runtime, recordAuroraSkinFlowMetric, recordAuroraRecoEntrySource } = buildRuntime({
      profileCompleteness: jest.fn(() => ({ score: 1, missing: ['sensitivity', 'barrierStatus', 'goals'] })),
    });
    const deps = buildDeps({
      ingredientRecoOptInRequested: true,
      ingredientActionData: {
        ingredient_query: 'niacinamide',
        ingredient_goal: 'hydration',
        ingredient_candidates: ['niacinamide', 'glycerin'],
        product_candidates: [{ sku_id: 'sku_1' }],
        ingredient_sensitivity: 'low',
      },
    });

    const result = await runtime.prepareRecoRequestPrelude(deps);

    expect(result.blockedEnvelope).toBeNull();
    expect(result.recoTaskMode).toBe('ingredient_filtered_products');
    expect(result.recoContextIngredientQuery).toBe('niacinamide');
    expect(result.recoContextGoal).toBe('hydration');
    expect(result.recoContextSensitivity).toBe('low');
    expect(result.recoIngredientCandidates).toEqual(['niacinamide', 'glycerin']);
    expect(result.recoProductCandidates).toEqual([{ sku_id: 'sku_1' }]);
    expect(result.pendingClarificationPatchOverride).toEqual({ pending: true });
    expect(result.refinementChips).toEqual([{ chip_id: 'chip_sensitivity' }]);
    expect(recordAuroraSkinFlowMetric).toHaveBeenCalledWith({ stage: 'reco_request', hit: true });
    expect(recordAuroraRecoEntrySource).toHaveBeenCalledWith({ source: 'profile_refine_rerun' });
    expect(deps.chatDiagnosisGateRuntime.applyDiagnosisFirstProfileGate).toHaveBeenCalled();
  });

  test('falls back to text-derived ingredient lookup when no reco context is present', async () => {
    const { runtime } = buildRuntime({
      extractIngredientLookupTargetFromText: jest.fn(async () => 'azelaic acid'),
    });
    const deps = buildDeps();

    const result = await runtime.prepareRecoRequestPrelude(deps);

    expect(result.recoContextIngredientQuery).toBe('azelaic acid');
    expect(result.recoTaskMode).toBe('goal_based_products');
    expect(result.blockedEnvelope).toBeNull();
  });

  test('returns the safety gate blocked envelope without further reco processing', async () => {
    const { runtime } = buildRuntime();
    const deps = buildDeps({
      chatSafetyRuntime: {
        resolveSafetyGate: jest.fn(async () => ({
          profile: { skinType: 'dry' },
          pendingSafetyAdvisory: null,
          blockedEnvelope: { assistant_message: { content: 'blocked' } },
        })),
      },
    });

    const result = await runtime.prepareRecoRequestPrelude(deps);

    expect(result.blockedEnvelope).toEqual({ assistant_message: { content: 'blocked' } });
    expect(deps.chatDiagnosisGateRuntime.applyDiagnosisFirstProfileGate).not.toHaveBeenCalled();
  });

  test('builds a reco safety-boundary block envelope when medical boundary is triggered', async () => {
    const { runtime, recordAuroraSkinFlowMetric } = buildRuntime({
      profileCompleteness: jest.fn(() => ({ score: 3, missing: ['skinType'] })),
      evaluateSafetyBoundary: jest.fn(() => ({
        block: true,
        assistant_message: 'This should be blocked.',
        notice_bullets: ['seek medical care'],
      })),
    });
    const deps = buildDeps();

    const result = await runtime.prepareRecoRequestPrelude(deps);

    expect(result.blockedEnvelope).toEqual({
      assistant_message: { content: 'This should be blocked.' },
      suggested_chips: [],
      cards: [
        {
          card_id: 'conf_req_1',
          type: 'confidence_notice',
          payload: {
            language: 'EN',
            reason: 'safety_block',
            confidence: { score: 0, level: 'low', rationale: ['medical_boundary'] },
            severity: 'block',
            actions: ['seek_medical_care', 'pause_strong_actives', 'return_after_stabilization'],
            details: ['seek medical care'],
          },
        },
      ],
      session_patch: {},
      events: [
        {
          event_name: 'recos_requested',
          event_data: { explicit: true, blocked: true, reason: 'safety_boundary' },
        },
      ],
    });
    expect(recordAuroraSkinFlowMetric).toHaveBeenCalledWith({ stage: 'reco_safety_block', hit: true });
  });
});

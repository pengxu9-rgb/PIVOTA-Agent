const { createChatRecoArtifactRuntime } = require('../src/auroraBff/chatRecoArtifactRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    logger: {
      warn: jest.fn(),
      info: jest.fn(),
    },
    extractLatestArtifactIdFromSession: jest.fn(() => 'artifact_pref_1'),
    getLatestDiagnosisArtifact: jest.fn(),
    hasUsableArtifactForRecommendations: jest.fn(() => ({ ok: true, confidence_level: 'high' })),
    AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED: false,
    looksLikeLowRiskSkincareTask: jest.fn(() => false),
    AURORA_PRODUCT_MATCHER_ENABLED: true,
    buildRecoEntryChips: jest.fn(() => [{ chip_id: 'reco_entry' }]),
    getIngredientPlanByArtifactId: jest.fn(async () => null),
    buildIngredientPlan: jest.fn(() => ({ plan_kind: 'generated' })),
    saveIngredientPlan: jest.fn(async ({ plan }) => ({
      plan_id: 'plan_saved_1',
      created_at: '2026-03-24T00:00:00.000Z',
      plan_json: { ...plan, persisted: true },
    })),
    AURORA_INGREDIENT_PLAN_ENABLED: true,
    recordAuroraSkinFlowMetric: jest.fn(),
    ...overrides,
  };

  return {
    deps,
    runtime: createChatRecoArtifactRuntime(deps),
  };
}

describe('aurora chat reco artifact runtime', () => {
  test('loads artifact, reuses saved ingredient plan, and derives confidence fields', async () => {
    const latestArtifact = {
      artifact_id: 'artifact_1',
      created_at: '2026-03-24T01:00:00.000Z',
      artifact_json: {
        overall_confidence: { score: 0.83 },
      },
    };
    const { runtime, deps } = buildHarness({
      getLatestDiagnosisArtifact: jest.fn(async () => latestArtifact),
      getIngredientPlanByArtifactId: jest.fn(async () => ({
        plan_id: 'plan_existing_1',
        created_at: '2026-03-24T02:00:00.000Z',
        plan_json: { plan_kind: 'existing' },
      })),
      hasUsableArtifactForRecommendations: jest.fn(() => ({ ok: true, confidence_level: 'medium' })),
    });

    const result = await runtime.prepareRecoArtifactContext({
      ctx: { request_id: 'req_1', brief_id: 'brief_1', lang: 'EN' },
      session: { session_id: 'sess_1' },
      message: 'recommend products',
      profile: { skinType: 'dry' },
      identity: { auroraUid: 'aurora_1', userId: 'user_1' },
      refinementChips: [{ chip_id: 'refine' }],
      pushGateDecision: jest.fn(),
      enqueueGateAdvisory: jest.fn(),
    });

    expect(deps.extractLatestArtifactIdFromSession).toHaveBeenCalledWith({ session_id: 'sess_1' });
    expect(deps.getLatestDiagnosisArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        auroraUid: 'aurora_1',
        userId: 'user_1',
        sessionId: 'brief_1',
        preferArtifactId: 'artifact_pref_1',
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        latestArtifact,
        mappedIngredientPlan: {
          plan_kind: 'existing',
          plan_id: 'plan_existing_1',
          created_at: '2026-03-24T02:00:00.000Z',
        },
        artifactConfidenceLevel: 'medium',
        artifactConfidenceScore: 0.83,
        artifactGateOk: true,
        lowConfidenceArtifact: false,
      }),
    );
    expect(deps.buildIngredientPlan).not.toHaveBeenCalled();
    expect(deps.saveIngredientPlan).not.toHaveBeenCalled();
  });

  test('downgrades missing artifact gate to advisory with merged chips', async () => {
    const pushGateDecision = jest.fn(() => ({ mode: 'advisory' }));
    const enqueueGateAdvisory = jest.fn();
    const { runtime, deps } = buildHarness({
      getLatestDiagnosisArtifact: jest.fn(async () => null),
      hasUsableArtifactForRecommendations: jest.fn(() => ({ ok: false, reason: 'artifact_missing' })),
    });

    const result = await runtime.prepareRecoArtifactContext({
      ctx: { request_id: 'req_2', trace_id: 'trace_2', lang: 'CN' },
      session: {},
      message: '给我推荐',
      profile: {},
      identity: { auroraUid: 'aurora_2', userId: 'user_2' },
      refinementChips: [{ chip_id: 'refine_profile' }],
      pushGateDecision,
      enqueueGateAdvisory,
    });

    expect(pushGateDecision).toHaveBeenCalledWith('artifact_missing_gate', {
      reason_codes: ['artifact_missing'],
    });
    expect(enqueueGateAdvisory).toHaveBeenCalledWith(
      expect.objectContaining({
        gate_id: 'artifact_missing_gate',
        reason_codes: ['artifact_missing'],
        actions: ['upload_daylight_and_indoor_white', 'refine_profile'],
        chips: [{ chip_id: 'refine_profile' }, { chip_id: 'reco_entry' }],
      }),
    );
    expect(result.artifactGateOk).toBe(false);
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_2',
        trace_id: 'trace_2',
        artifact_reason: 'artifact_missing',
      }),
      'aurora bff: artifact gate downgraded to advisory',
    );
  });

  test('records nonblocking low-risk artifact bypass', async () => {
    const { runtime, deps } = buildHarness({
      AURORA_CHAT_NONBLOCKING_GATE_V1_ENABLED: true,
      looksLikeLowRiskSkincareTask: jest.fn(() => true),
      getLatestDiagnosisArtifact: jest.fn(async () => ({
        artifact_id: 'artifact_2',
        artifact_json: {},
      })),
      hasUsableArtifactForRecommendations: jest.fn(() => ({ ok: false, reason: 'artifact_missing' })),
    });

    const result = await runtime.prepareRecoArtifactContext({
      ctx: { request_id: 'req_3', trace_id: 'trace_3', lang: 'EN' },
      session: {},
      message: 'simple gentle moisturizer recommendation',
      profile: {},
      identity: { auroraUid: 'aurora_3', userId: 'user_3' },
      refinementChips: [],
      pushGateDecision: jest.fn(),
      enqueueGateAdvisory: jest.fn(),
    });

    expect(deps.recordAuroraSkinFlowMetric).toHaveBeenCalledWith({
      stage: 'artifact_gate_nonblocking_low_risk',
      hit: true,
    });
    expect(result.artifactGateOk).toBe(false);
  });

  test('builds and saves ingredient plan when no saved plan exists', async () => {
    const latestArtifact = {
      artifact_id: 'artifact_4',
      artifact_json: { artifact_kind: 'analysis' },
    };
    const { runtime, deps } = buildHarness({
      getLatestDiagnosisArtifact: jest.fn(async () => latestArtifact),
      hasUsableArtifactForRecommendations: jest.fn(() => ({ ok: true, confidence_level: 'low' })),
    });

    const result = await runtime.prepareRecoArtifactContext({
      ctx: { request_id: 'req_4', lang: 'EN' },
      session: {},
      message: 'recommend products',
      profile: { skinType: 'oily' },
      identity: { auroraUid: 'aurora_4', userId: 'user_4' },
      refinementChips: [],
      pushGateDecision: jest.fn(),
      enqueueGateAdvisory: jest.fn(),
    });

    expect(deps.buildIngredientPlan).toHaveBeenCalledWith({
      artifact: latestArtifact.artifact_json,
      profile: { skinType: 'oily' },
    });
    expect(deps.saveIngredientPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: 'artifact_4',
        auroraUid: 'aurora_4',
        userId: 'user_4',
        plan: { plan_kind: 'generated' },
      }),
    );
    expect(result.mappedIngredientPlan).toEqual(
      expect.objectContaining({
        plan_kind: 'generated',
        persisted: true,
        plan_id: 'plan_saved_1',
      }),
    );
    expect(result.lowConfidenceArtifact).toBe(true);
  });
});

const { z } = require('zod');

const { mountChatRoutes } = require('../src/auroraBff/routes/chatRoutes');

function pickFirstTrimmed(...values) {
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (value) return value;
  }
  return '';
}

function buildApp(overrides = {}) {
  const app = {
    post: jest.fn(),
  };

  const deps = {
    V1ChatRequestSchema: z.object({
      message: z.string().min(1),
    }),
    buildRequestContext: jest.fn(() => ({
      request_id: 'req_chat_owner_1',
      trace_id: 'trace_chat_owner_1',
      aurora_uid: 'uid_chat_owner_1',
      lang: 'EN',
    })),
    getRecoDogfoodSessionId: jest.fn(() => ''),
    computeAuroraChatRolloutContext: jest.fn(() => ({
      effective_flags: {
        profile_v2: false,
        qa_planner_v1: false,
        safety_engine_v1: false,
        travel_weather_live_v1: false,
        loop_breaker_v2: false,
        chat_response_meta: false,
      },
      policy_version: 'aurora_policy_v1',
      variant: 'legacy',
      bucket: 0,
      bucket_key_source: 'test',
      forced_variant: null,
      applied: false,
      build_sha: 'test-sha',
    })),
    AURORA_CHAT_GLOBAL_FLAGS: {
      profile_v2: false,
      qa_planner_v1: false,
      safety_engine_v1: false,
      travel_weather_live_v1: false,
      loop_breaker_v2: false,
      chat_response_meta: false,
    },
    AURORA_CHAT_POLICY_VERSION: 'aurora_policy_v1',
    INTENT_ENUM: {
      UNKNOWN: 'unknown',
    },
    AURORA_GATE_POLICY_META_VERSION: 'gate_policy_v1',
    resolveGateDecision: jest.fn(() => ({ mode: 'bypass' })),
    GATE_MODE: {
      BYPASS: 'bypass',
      ADVISORY: 'advisory',
    },
    DEFAULT_AGENT_STATE: 'S0_INIT',
    summarizeProfileForContext: jest.fn(() => ({})),
    resolvePreferredLegacyTravelPlan: jest.fn(() => null),
    BLOCK_LEVEL: { INFO: 'info' },
    isPlainObject: (value) => value != null && typeof value === 'object' && !Array.isArray(value),
    normalizeRecoSourceDetail: jest.fn((value) => value || null),
    pickFirstTrimmed,
    recordAuroraRecoContextUsed: jest.fn(),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, event_data: data || {} })),
    augmentEnvelopeProductAnalysisCardsForDogfood: jest.fn(({ envelope }) => envelope),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    applyReplyTemplates: jest.fn(({ envelope }) => envelope),
    shouldApplyRecoOutputGuard: jest.fn(() => false),
    applyLowOrMediumRecoGuardToEnvelope: jest.fn(({ envelope }) => ({
      envelope,
      applied: false,
      filteredCount: 0,
      totalCount: 0,
      fallbackApplied: false,
    })),
    recordAuroraSkinFlowMetric: jest.fn(),
    ensureNonEmptyChatCardsEnvelope: jest.fn(({ envelope }) => ({ envelope, applied: false, reason: null })),
    AURORA_MULTITURN_CONTRACT_GATE_V1_ENABLED: false,
    safelyApplyProductIntelGuardrailsToEnvelope: jest.fn(async ({ envelope }) => ({
      envelope,
      dropped: 0,
      externalized: 0,
      rejected: [],
      failed: false,
      error_code: null,
    })),
    executeAuroraOptionalStep: jest.fn(async ({ fn }) => fn()),
    upsertChatContextForIdentity: jest.fn(async () => {}),
    enrichIngredientReportCardsInEnvelope: jest.fn((envelope) => envelope),
    buildChatCardsResponse: jest.fn(({ envelope }) => ({
      cards: Array.isArray(envelope.cards) ? envelope.cards : [],
      ops: {},
    })),
    INGREDIENT_ROUTE_RULE_VERSION: 'ingredient_route_v1',
    recordAuroraIngredientsFlowMetric: jest.fn(),
    appendExperimentEventForIdentity: jest.fn(async () => {}),
    emitAudit: jest.fn(),
    AURORA_CHAT_LEGACY_ENVELOPE_RESPONSE: true,
    requireAuroraUid: jest.fn(),
    buildEnvelope: jest.fn((ctx, payload) => ({
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...payload,
    })),
    makeAssistantMessage: jest.fn((text) => ({ role: 'assistant', content: text })),
  };

  mountChatRoutes(app, {
    ...deps,
    ...overrides,
  });

  return { app, deps: { ...deps, ...overrides } };
}

describe('mountChatRoutes', () => {
  test('registers /v1/chat route owner', () => {
    const { app, deps } = buildApp();

    expect(app.post).toHaveBeenCalledWith('/v1/chat', expect.any(Function));
    expect(deps.buildRequestContext).not.toHaveBeenCalled();
  });
});

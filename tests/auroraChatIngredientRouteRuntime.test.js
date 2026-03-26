const { createChatIngredientRouteRuntime } = require('../src/auroraBff/chatIngredientRouteRuntime');

function buildHarness(overrides = {}) {
  const deps = {
    looksLikeRoutineRequest: jest.fn(() => false),
    looksLikeSuitabilityRequest: jest.fn(() => false),
    looksLikeCompatibilityOrConflictQuestion: jest.fn(() => false),
    looksLikeWeatherOrEnvironmentQuestion: jest.fn(() => false),
    messageContainsSpecificIngredientScienceTarget: jest.fn(() => false),
    chatSafetyRuntime: {
      resolveSafetyGate: jest.fn(async () => ({
        profile: { safe: true },
        pendingSafetyAdvisory: null,
        blockedEnvelope: null,
      })),
    },
    chatIngredientEntryRuntime: {
      resolveIngredientEntryEnvelope: jest.fn(async () => ({
        handled: false,
        envelope: null,
        ingredientRecoContext: { source: 'entry' },
        requestMessage: null,
      })),
    },
    chatRecommendationFlowRuntime: {
      resolveRecommendationFlow: jest.fn(async () => ({
        handled: false,
        envelope: null,
        profile: { after: 'reco' },
        ingredientRecoContext: { source: 'reco' },
        nextStateOverride: 'RECO_RESULTS',
        nextCtxState: 'RECO_RESULTS',
        pendingSafetyAdvisory: { advisory: true },
        pendingClarificationPatchOverride: { keep: true },
        policyMetaPatch: { gate_type: 'soft' },
      })),
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatIngredientRouteRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    ingredientScienceIntentEffective: false,
    safetyDecision: null,
    profile: { skinType: 'dry' },
    identity: { auroraUid: 'aurora_1' },
    pendingSafetyAdvisory: null,
    pushGateDecision: jest.fn(),
    ctx: { request_id: 'req_1', lang: 'EN', state: 'IDLE_CHAT', trigger_source: 'text' },
    buildEnvelope: jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload })),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    attachIngredientRouteMetaToSessionPatch: jest.fn((patch, meta) => ({ ...patch, ingredient_route_meta: meta })),
    ingredientRouteDecisionReasons: ['entity_alias_match'],
    INGREDIENT_ROUTE_RULE_VERSION: 'ingredient_route_v2_lite_20260301',
    req: {},
    ingredientRecoContext: { source: 'seed' },
    ingredientGoalRequest: { goal: '', sensitivity: 'unknown' },
    nextStateOverride: null,
    message: 'ingredient question',
    ingredientTextTrigger: false,
    ingredientEntryRequested: false,
    ingredientByGoalRequested: false,
    ingredientLookupRequested: false,
    ingredientResearchPollRequested: false,
    ingredientDiagnosisOptInRequested: false,
    ingredientLookupQuery: '',
    ingredientLookupTargetFromText: '',
    ingredientEntityMatch: { entity_match_type: 'none' },
    buildSafetyNoticeText: jest.fn(() => 'safety'),
    normalizedActionPayload: null,
    recommendationFlowArgs: {
      pendingClarificationPatchOverride: undefined,
    },
    ...overrides,
  };
}

describe('aurora chat ingredient route runtime', () => {
  test('returns blocked safety envelope before ingredient entry or recommendation flow', async () => {
    const { runtime, deps } = buildHarness({
      chatSafetyRuntime: {
        resolveSafetyGate: jest.fn(async () => ({
          profile: { safe: false },
          pendingSafetyAdvisory: { code: 'blocked' },
          blockedEnvelope: { blocked: true },
        })),
      },
    });

    const out = await runtime.resolveIngredientRouteFlow(buildArgs({
      ingredientScienceIntentEffective: true,
      safetyDecision: { block_level: 'high' },
      ingredientTextTrigger: true,
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope).toEqual({ blocked: true });
    expect(deps.chatIngredientEntryRuntime.resolveIngredientEntryEnvelope).not.toHaveBeenCalled();
    expect(deps.chatRecommendationFlowRuntime.resolveRecommendationFlow).not.toHaveBeenCalled();
    expect(deps.chatSafetyRuntime.resolveSafetyGate).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientRouteMeta: expect.objectContaining({
          routeSource: 'text',
          routeDecisionReasons: ['safety_block', 'entity_alias_match'],
        }),
      }),
    );
  });

  test('query-first ingredient text route can handle envelope before recommendation flow', async () => {
    const { runtime, deps } = buildHarness({
      chatIngredientEntryRuntime: {
        resolveIngredientEntryEnvelope: jest.fn(async () => ({
          handled: true,
          envelope: { kind: 'query_first' },
          ingredientRecoContext: { source: 'query_first' },
          requestMessage: 'ingredient_lookup_request',
        })),
      },
    });

    const out = await runtime.resolveIngredientRouteFlow(buildArgs({
      ingredientScienceIntentEffective: true,
      ingredientTextTrigger: true,
      ingredientLookupTargetFromText: 'retinol',
      ingredientEntityMatch: { entity_match_type: 'alias' },
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope).toEqual({ kind: 'query_first' });
    expect(out.requestMessage).toBe('ingredient_lookup_request');
    expect(deps.chatIngredientEntryRuntime.resolveIngredientEntryEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientTextQueryFirstEligible: true,
        ingredientLookupTargetFromText: 'retinol',
      }),
    );
    expect(deps.chatRecommendationFlowRuntime.resolveRecommendationFlow).not.toHaveBeenCalled();
  });

  test('science kickoff path forwards requestMessage and then continues into recommendation flow', async () => {
    const { runtime, deps } = buildHarness({
      chatIngredientEntryRuntime: {
        resolveIngredientEntryEnvelope: jest.fn(async () => ({
          handled: false,
          envelope: null,
          ingredientRecoContext: { source: 'science_kickoff' },
          requestMessage: 'ingredient_science_kickoff',
        })),
      },
    });

    const out = await runtime.resolveIngredientRouteFlow(buildArgs({
      ingredientScienceIntentEffective: true,
      ingredientTextTrigger: false,
      message: 'ingredient science please',
    }));

    expect(out.handled).toBe(false);
    expect(out.requestMessage).toBe('ingredient_science_kickoff');
    expect(out.ingredientRecoContext).toEqual({ source: 'reco' });
    expect(deps.chatIngredientEntryRuntime.resolveIngredientEntryEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldKickoffIngredientScience: true,
        ingredientScienceIntentEffective: true,
      }),
    );
    expect(deps.chatRecommendationFlowRuntime.resolveRecommendationFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientRecoContext: { source: 'science_kickoff' },
        ingredientScienceIntentEffective: true,
      }),
    );
  });

  test('passes recommendation flow state/profile updates through when unhandled', async () => {
    const { runtime } = buildHarness();

    const out = await runtime.resolveIngredientRouteFlow(buildArgs({
      recommendationFlowArgs: {
        pendingClarificationPatchOverride: { keep: false },
        someOtherArg: true,
      },
    }));

    expect(out.handled).toBe(false);
    expect(out.profile).toEqual({ after: 'reco' });
    expect(out.nextStateOverride).toBe('RECO_RESULTS');
    expect(out.nextCtxState).toBe('RECO_RESULTS');
    expect(out.pendingSafetyAdvisory).toEqual({ advisory: true });
    expect(out.pendingClarificationPatchOverride).toEqual({ keep: true });
    expect(out.policyMetaPatch).toEqual({ gate_type: 'soft' });
  });
});

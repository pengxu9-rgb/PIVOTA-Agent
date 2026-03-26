const { createChatPreUpstreamRuntime } = require('../src/auroraBff/chatPreUpstreamRuntime');

function buildArgs(overrides = {}) {
  return {
    effectiveChatFlags: { loop_breaker_v2: true },
    message: 'recommend products',
    actionId: 'action.reco',
    ctx: { request_id: 'req_1', trigger_source: 'text', state: 'S0', lang: 'EN' },
    canonicalIntent: { intent: 'reco_products' },
    profile: { skin_type: 'oily' },
    hasPlannerAnchor: false,
    debugUpstream: false,
    appliedProfilePatch: null,
    anchorProductId: '',
    anchorProductUrl: '',
    allowRecoCards: true,
    evaluateIntent: false,
    ingredientScienceIntentEffective: false,
    conflictIntentRequested: false,
    recommendationEntryRequested: true,
    diagnosisEntryRequested: false,
    normalizedActionPayload: null,
    pendingSafetyAdvisory: null,
    pushGateDecision: jest.fn(),
    enqueueGateAdvisory: jest.fn(),
    buildEnvelope: jest.fn((_ctx, payload) => payload),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    identity: { auroraUid: 'u_1' },
    session: { id: 'sess_1' },
    req: {},
    ingredientRecoContext: { route: 'seed' },
    ingredientGoalRequest: { goal: 'glow' },
    nextStateOverride: null,
    ingredientEntryRequested: false,
    ingredientByGoalRequested: false,
    ingredientLookupRequested: false,
    ingredientResearchPollRequested: false,
    ingredientRouteDecisionReasons: ['text_trigger'],
    ingredientLookupQuery: '',
    ingredientActionData: null,
    INGREDIENT_ROUTE_RULE_VERSION: 'v1',
    AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED: true,
    summarizeChatProfileForContext: jest.fn(() => ({ summarized: true })),
    recentLogs: [],
    chatContext: { thread_id: 'thread_1' },
    templateAcceptLanguage: 'en-US',
    agentState: 'S0',
    ingredientDiagnosisOptInRequested: false,
    ingredientTextTrigger: false,
    buildDiagnosisPrompt: jest.fn(() => 'prompt'),
    buildDiagnosisChips: jest.fn(() => []),
    profileCompleteness: jest.fn(() => ({ missing_fields: [] })),
    stateChangeAllowed: jest.fn(() => true),
    normalizeIngredientActionId: jest.fn((value) => value),
    attachIngredientRouteMetaToSessionPatch: jest.fn((patch) => patch),
    ingredientLookupTargetFromText: '',
    ingredientEntityMatch: { entity_match_type: 'none' },
    buildSafetyNoticeText: jest.fn(() => 'notice'),
    recommendationFlowArgs: {
      pendingClarificationPatchOverride: undefined,
    },
    requestMessage: 'recommend products',
    ...overrides,
  };
}

function buildRuntime(overrides = {}) {
  return createChatPreUpstreamRuntime({
    chatBoundaryPreludeRuntime: {
      prepareBoundaryPrelude: jest.fn().mockResolvedValue({
        plannerDecision: null,
        plannerPolicyMetaPatch: null,
        plannerSessionStatePatch: null,
        diagnosisFlowContinuationAllowed: false,
        safetyDecision: null,
        profile: { skin_type: 'oily' },
        pendingSafetyAdvisory: null,
        nextStateOverride: null,
        nextCtxState: 'S0',
        shouldBypassAvailabilityShortCircuit: false,
        blockedEnvelope: null,
      }),
    },
    chatIngredientEntryRuntime: {
      resolveIngredientEntryEnvelope: jest.fn().mockResolvedValue({
        handled: false,
        envelope: null,
        ingredientRecoContext: { route: 'seed' },
        requestMessage: null,
      }),
    },
    chatLoopBreakerRuntime: {
      maybeBuildLoopBreakerEnvelope: jest.fn(() => ({ handled: false, envelope: null })),
    },
    chatCatalogAvailabilityRuntime: {
      maybeBuildCatalogAvailabilityEnvelope: jest.fn().mockResolvedValue(null),
    },
    chatTravelEnvRuntime: {
      maybeBuildTravelEnvEnvelope: jest.fn().mockResolvedValue({
        handled: false,
        envelope: null,
        policyMetaPatch: null,
      }),
    },
    chatConflictRuntime: {
      maybeBuildConflictEnvelope: jest.fn().mockResolvedValue({ handled: false, envelope: null }),
    },
    chatDiagnosisGateRuntime: {
      resolveDiagnosisEntryEnvelope: jest.fn(() => ({ handled: false, envelope: null })),
    },
    chatIngredientRouteRuntime: {
      resolveIngredientRouteFlow: jest.fn().mockResolvedValue({
        handled: false,
        envelope: null,
        ingredientRecoContext: { route: 'updated' },
        profile: { skin_type: 'dry' },
        nextStateOverride: 'S_next',
        nextCtxState: 'S_next',
        pendingSafetyAdvisory: { gate: 'warn' },
        pendingClarificationPatchOverride: { question_id: 'q1' },
        requestMessage: 'rerun recommendations',
        policyMetaPatch: { route_source: 'ingredient_route' },
      }),
    },
    ...overrides,
  });
}

describe('aurora chat pre-upstream runtime', () => {
  test('returns blocked boundary envelope and preserves boundary patches', async () => {
    const runtime = buildRuntime({
      chatBoundaryPreludeRuntime: {
        prepareBoundaryPrelude: jest.fn().mockResolvedValue({
          plannerDecision: { next_step: 'ask', required_fields: ['skin_type'] },
          plannerPolicyMetaPatch: {
            gate_type: 'planner',
            loop_count: 2,
            break_applied: 'conservative_defaults',
          },
          plannerSessionStatePatch: { state: 'S6' },
          diagnosisFlowContinuationAllowed: true,
          safetyDecision: { level: 'advisory' },
          profile: { skin_type: 'combination' },
          pendingSafetyAdvisory: { gate: 'safety' },
          nextStateOverride: 'S6',
          nextCtxState: 'S6',
          shouldBypassAvailabilityShortCircuit: true,
          fitCheckAnchorGateType: 'fit_check',
          safetyPolicyMetaPatch: {
            safety_gate_mode: 'advisory',
            safety_advisory_emitted: true,
          },
          blockedEnvelope: { cards: [{ type: 'blocked' }] },
        }),
      },
    });
    const args = buildArgs();

    const result = await runtime.resolvePreUpstreamFlow(args);

    expect(result.handled).toBe(true);
    expect(result.envelope).toEqual({ cards: [{ type: 'blocked' }] });
    expect(result.plannerSessionStatePatch).toEqual({ state: 'S6' });
    expect(result.safetyDecision).toEqual({ level: 'advisory' });
    expect(result.profile).toEqual({ skin_type: 'combination' });
    expect(result.pendingSafetyAdvisory).toEqual({ gate: 'safety' });
    expect(result.nextStateOverride).toBe('S6');
    expect(result.nextCtxState).toBe('S6');
    expect(args.ctx.state).toBe('S6');
    expect(result.policyMetaPatch).toEqual({
      gate_type: 'fit_check',
      loop_count: 2,
      break_applied: 'conservative_defaults',
      safety_gate_mode: 'advisory',
      safety_advisory_emitted: true,
    });
  });

  test('returns loop-breaker envelope after boundary and ingredient entry pass through', async () => {
    const runtime = buildRuntime({
      chatBoundaryPreludeRuntime: {
        prepareBoundaryPrelude: jest.fn().mockResolvedValue({
          plannerDecision: {
            next_step: 'ask',
            required_fields: ['skin_type'],
            break_applied: 'conservative_defaults',
            loop_count: 3,
          },
          plannerPolicyMetaPatch: null,
          plannerSessionStatePatch: null,
          diagnosisFlowContinuationAllowed: false,
          safetyDecision: null,
          profile: { skin_type: 'oily' },
          pendingSafetyAdvisory: null,
          nextStateOverride: null,
          nextCtxState: 'S0',
          shouldBypassAvailabilityShortCircuit: false,
          blockedEnvelope: null,
        }),
      },
      chatLoopBreakerRuntime: {
        maybeBuildLoopBreakerEnvelope: jest.fn(() => ({
          handled: true,
          envelope: { cards: [{ type: 'loop_breaker' }] },
        })),
      },
    });

    const result = await runtime.resolvePreUpstreamFlow(buildArgs());

    expect(result.handled).toBe(true);
    expect(result.envelope).toEqual({ cards: [{ type: 'loop_breaker' }] });
  });

  test('propagates fallthrough state and policy patches through travel and ingredient route', async () => {
    const runtime = buildRuntime({
      chatBoundaryPreludeRuntime: {
        prepareBoundaryPrelude: jest.fn().mockResolvedValue({
          plannerDecision: { next_step: 'continue' },
          plannerPolicyMetaPatch: {
            gate_type: 'planner',
            loop_count: 1,
            break_applied: 'none',
          },
          plannerSessionStatePatch: { state: 'S1' },
          diagnosisFlowContinuationAllowed: false,
          safetyDecision: { level: 'ok' },
          profile: { skin_type: 'combination' },
          pendingSafetyAdvisory: null,
          nextStateOverride: 'S1',
          nextCtxState: 'S1',
          shouldBypassAvailabilityShortCircuit: true,
          blockedEnvelope: null,
        }),
      },
      chatIngredientEntryRuntime: {
        resolveIngredientEntryEnvelope: jest.fn().mockResolvedValue({
          handled: false,
          envelope: null,
          ingredientRecoContext: { route: 'entry' },
          requestMessage: 'ingredient request',
        }),
      },
      chatTravelEnvRuntime: {
        maybeBuildTravelEnvEnvelope: jest.fn().mockResolvedValue({
          handled: false,
          envelope: null,
          policyMetaPatch: {
            gate_type: 'weather',
            env_source: 'local_weather',
            degraded: true,
          },
        }),
      },
      chatIngredientRouteRuntime: {
        resolveIngredientRouteFlow: jest.fn().mockResolvedValue({
          handled: false,
          envelope: null,
          ingredientRecoContext: { route: 'reco' },
          profile: { skin_type: 'dry' },
          nextStateOverride: 'S_reco',
          nextCtxState: 'S_reco',
          pendingSafetyAdvisory: { gate: 'warn' },
          pendingClarificationPatchOverride: { question_id: 'clarify_budget' },
          requestMessage: 'rerun recommendations',
          policyMetaPatch: { route_source: 'ingredient_route' },
        }),
      },
    });

    const args = buildArgs();
    const result = await runtime.resolvePreUpstreamFlow(args);

    expect(result.handled).toBe(false);
    expect(result.plannerSessionStatePatch).toEqual({ state: 'S1' });
    expect(result.safetyDecision).toEqual({ level: 'ok' });
    expect(result.profile).toEqual({ skin_type: 'dry' });
    expect(result.pendingSafetyAdvisory).toEqual({ gate: 'warn' });
    expect(result.nextStateOverride).toBe('S_reco');
    expect(result.nextCtxState).toBe('S_reco');
    expect(result.ingredientRecoContext).toEqual({ route: 'reco' });
    expect(result.pendingClarificationPatchOverride).toEqual({ question_id: 'clarify_budget' });
    expect(result.requestMessage).toBe('rerun recommendations');
    expect(args.ctx.state).toBe('S_reco');
    expect(result.policyMetaPatch).toEqual({
      gate_type: 'weather',
      loop_count: 1,
      break_applied: 'none',
      env_source: 'local_weather',
      degraded: true,
      route_source: 'ingredient_route',
    });
  });
});

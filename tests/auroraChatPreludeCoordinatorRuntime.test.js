const { createChatPreludeCoordinatorRuntime } = require('../src/auroraBff/chatPreludeCoordinatorRuntime');

function buildArgs(overrides = {}) {
  return {
    parsedData: { session: { id: 'sess_1' } },
    ctx: { request_id: 'req_1', trace_id: 'trace_1', lang: 'EN', state: 'S0', trigger_source: 'text' },
    message: 'recommend a routine',
    actionId: 'action.reco',
    clarificationId: 'clar_1',
    actionReplyText: 'Yes',
    normalizedActionPayload: { action: 'reco' },
    profile: { skin_type: 'oily' },
    appliedProfilePatch: { skin_type: 'oily' },
    summarizeChatProfileForContext: jest.fn(() => ({ summarized: true })),
    pushGateDecision: jest.fn(),
    policyMeta: {},
    logger: { warn: jest.fn() },
    recordPendingClarificationAbandoned: jest.fn(),
    recordSessionPatchProfileEmitted: jest.fn(),
    buildChipsForQuestion: jest.fn(() => []),
    recordAuroraChatSkipped: jest.fn(),
    recordPendingClarificationStep: jest.fn(),
    recordPendingClarificationCompleted: jest.fn(),
    buildEnvelope: jest.fn((_ctx, payload) => payload),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, eventData) => ({ event_name: eventName, event_data: eventData })),
    getPendingClarification: jest.fn(() => null),
    AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED: true,
    canonicalIntent: { intent: 'reco_products' },
    INTENT_ENUM: { UNKNOWN: 'unknown' },
    requestMessage: 'recommend a routine',
    ingredientReplayContext: { source: 'seed' },
    skipRoutineRulesFallback: false,
    effectiveChatFlags: { feature: true },
    hasPlannerAnchor: false,
    debugUpstream: false,
    anchorProductId: '',
    anchorProductUrl: '',
    pendingSafetyAdvisory: null,
    enqueueGateAdvisory: jest.fn(),
    identity: { auroraUid: 'u_1' },
    session: { id: 'sess_1' },
    req: {},
    INGREDIENT_ROUTE_RULE_VERSION: 'v1',
    AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED: true,
    recentLogs: [],
    chatContext: { thread_id: 'thread_1' },
    templateAcceptLanguage: 'en-US',
    buildDiagnosisPrompt: jest.fn(() => 'prompt'),
    buildDiagnosisChips: jest.fn(() => []),
    profileCompleteness: jest.fn(() => ({ missing_fields: [] })),
    stateChangeAllowed: jest.fn(() => true),
    normalizeIngredientActionId: jest.fn((value) => value),
    recommendationFlowBaseArgs: {
      includeAlternatives: true,
      textDerivedProfilePatch: { concerns: ['dryness'] },
      textDerivedSkinLog: { tone: 'neutral' },
      latestRecoContextFromSession: { last_turn: 't_1' },
      chatSafetyRuntime: { owner: 'safety' },
      chatDiagnosisGateRuntime: { owner: 'diagnosis' },
    },
    ...overrides,
  };
}

function buildRuntime(overrides = {}) {
  return createChatPreludeCoordinatorRuntime({
    chatTurnStateRuntime: {
      prepareChatTurnPrelude: jest.fn(() => ({
        clientAgentState: 'S0',
        requestedTransition: { requested_next_state: 'RECO_RESULTS' },
        agentState: 'RECO_RESULTS',
        recoInteractionAllowed: true,
        allowRecoCards: true,
        upstreamMessage: 'upstream routine request',
        clarificationHistoryForUpstream: [{ id: 'q1' }],
        resumeContextForUpstream: { resume: true },
        pendingClarificationPatchOverride: undefined,
        forceUpstreamAfterPendingAbandon: false,
        earlyEnvelope: null,
      })),
    },
    chatIngredientPreludeRuntime: {
      prepareIngredientPrelude: jest.fn().mockResolvedValue({
        ingredientEntryRequested: false,
        ingredientLookupRequested: false,
        ingredientByGoalRequested: false,
        ingredientDiagnosisOptInRequested: false,
        ingredientResearchPollRequested: false,
        ingredientRecoOptInRequested: false,
        ingredientRouteDecisionReasons: ['text_trigger'],
        ingredientTextTrigger: true,
        ingredientLookupQuery: '',
        ingredientLookupTargetFromText: '',
        ingredientEntityMatch: { entity_match_type: 'none' },
        ingredientScienceIntentEffective: false,
        ingredientGoalRequest: { goal: 'glow' },
        ingredientActionData: { ingredient_goal: 'glow' },
        ingredientRecoContext: { seed: true },
        ingredientReplayContext: { route_source: 'text' },
        skipRoutineRulesFallback: true,
        upstreamMessage: 'ingredient-aware upstream message',
        conflictIntentRequested: false,
        evaluateIntent: false,
        recommendationEntryRequested: true,
        diagnosisEntryRequested: false,
      }),
    },
    chatIngredientLookupRuntime: {
      attachIngredientRouteMetaToSessionPatch: jest.fn((patch) => patch),
    },
    chatPreUpstreamRuntime: {
      resolvePreUpstreamFlow: jest.fn().mockResolvedValue({
        handled: false,
        envelope: null,
        plannerSessionStatePatch: { state: 'S6' },
        safetyDecision: { level: 'advisory' },
        profile: { skin_type: 'combination' },
        pendingSafetyAdvisory: { gate: 'warn' },
        nextStateOverride: 'S6',
        nextCtxState: 'S6',
        ingredientRecoContext: { seed: false, adopted: true },
        pendingClarificationPatchOverride: { question_id: 'q1' },
        requestMessage: 'rerun routine request',
        policyMetaPatch: { route_source: 'pre_upstream' },
      }),
    },
    chatSafetyRuntime: {
      buildSafetyNoticeText: jest.fn(({ safety, language }) => `${language}:${safety.level}`),
    },
    looksLikeIngredientScienceIntent: jest.fn(() => false),
    ...overrides,
  });
}

describe('aurora chat prelude coordinator runtime', () => {
  test('returns early envelope from chat turn prelude without invoking downstream runtimes', async () => {
    const prepareChatTurnPrelude = jest.fn(() => ({
      clientAgentState: 'S0',
      requestedTransition: null,
      agentState: 'S0',
      recoInteractionAllowed: false,
      allowRecoCards: false,
      upstreamMessage: 'noop',
      clarificationHistoryForUpstream: null,
      resumeContextForUpstream: null,
      pendingClarificationPatchOverride: undefined,
      forceUpstreamAfterPendingAbandon: false,
      earlyEnvelope: { cards: [{ type: 'clarification' }] },
    }));
    const prepareIngredientPrelude = jest.fn();
    const resolvePreUpstreamFlow = jest.fn();
    const runtime = buildRuntime({
      chatTurnStateRuntime: { prepareChatTurnPrelude },
      chatIngredientPreludeRuntime: { prepareIngredientPrelude },
      chatPreUpstreamRuntime: { resolvePreUpstreamFlow },
    });

    const result = await runtime.resolveChatPreludeFlow(buildArgs());

    expect(result).toEqual({
      handled: true,
      envelope: { cards: [{ type: 'clarification' }] },
      clientAgentState: 'S0',
      agentState: 'S0',
    });
    expect(prepareIngredientPrelude).not.toHaveBeenCalled();
    expect(resolvePreUpstreamFlow).not.toHaveBeenCalled();
  });

  test('coordinates turn, ingredient, and pre-upstream runtimes into one bundle', async () => {
    const looksLikeIngredientScienceIntent = jest.fn(() => true);
    const resolvePreUpstreamFlow = jest.fn().mockResolvedValue({
      handled: false,
      envelope: null,
      plannerSessionStatePatch: { state: 'S6' },
      safetyDecision: { level: 'advisory' },
      profile: { skin_type: 'combination' },
      pendingSafetyAdvisory: { gate: 'warn' },
      nextStateOverride: 'S6',
      nextCtxState: 'S6',
      ingredientRecoContext: { seed: false, adopted: true },
      pendingClarificationPatchOverride: { question_id: 'q1' },
      requestMessage: 'rerun routine request',
      policyMetaPatch: { route_source: 'pre_upstream' },
    });
    const runtime = buildRuntime({
      looksLikeIngredientScienceIntent,
      chatPreUpstreamRuntime: { resolvePreUpstreamFlow },
    });
    const args = buildArgs();

    const result = await runtime.resolveChatPreludeFlow(args);

    expect(looksLikeIngredientScienceIntent).toHaveBeenCalledWith(args.message, args.normalizedActionPayload);
    expect(result.handled).toBe(false);
    expect(result.clientAgentState).toBe('S0');
    expect(result.agentState).toBe('RECO_RESULTS');
    expect(result.allowRecoCards).toBe(true);
    expect(result.upstreamMessage).toBe('ingredient-aware upstream message');
    expect(result.clarificationHistoryForUpstream).toEqual([{ id: 'q1' }]);
    expect(result.resumeContextForUpstream).toEqual({ resume: true });
    expect(result.nextStateOverride).toBe('S6');
    expect(result.pendingClarificationPatchOverride).toEqual({ question_id: 'q1' });
    expect(result.plannerSessionStatePatch).toEqual({ state: 'S6' });
    expect(result.safetyDecision).toEqual({ level: 'advisory' });
    expect(result.profile).toEqual({ skin_type: 'combination' });
    expect(result.pendingSafetyAdvisory).toEqual({ gate: 'warn' });
    expect(result.requestMessage).toBe('rerun routine request');
    expect(result.policyMetaPatch).toEqual({ route_source: 'pre_upstream' });
    expect(result.ingredientRecoContext).toEqual({ seed: false, adopted: true });
    expect(result.ingredientReplayContext).toEqual({ route_source: 'text' });
    expect(result.skipRoutineRulesFallback).toBe(true);
    expect(resolvePreUpstreamFlow).toHaveBeenCalledTimes(1);
  });

  test('passes recommendation flow and safety helpers into pre-upstream flow', async () => {
    const resolvePreUpstreamFlow = jest.fn().mockResolvedValue({
      handled: true,
      envelope: { cards: [{ type: 'handled' }] },
      plannerSessionStatePatch: null,
      safetyDecision: null,
      profile: { skin_type: 'oily' },
      pendingSafetyAdvisory: null,
      nextStateOverride: null,
      nextCtxState: 'S0',
      ingredientRecoContext: { seed: true },
      pendingClarificationPatchOverride: undefined,
      requestMessage: 'recommend a routine',
      policyMetaPatch: null,
    });
    const runtime = buildRuntime({
      chatPreUpstreamRuntime: { resolvePreUpstreamFlow },
      chatTurnStateRuntime: {
        prepareChatTurnPrelude: jest.fn(() => ({
          clientAgentState: 'S0',
          requestedTransition: null,
          agentState: 'RECO_RESULTS',
          recoInteractionAllowed: true,
          allowRecoCards: true,
          upstreamMessage: 'upstream routine request',
          clarificationHistoryForUpstream: null,
          resumeContextForUpstream: null,
          pendingClarificationPatchOverride: undefined,
          forceUpstreamAfterPendingAbandon: true,
          earlyEnvelope: null,
        })),
      },
    });
    const args = buildArgs();

    const result = await runtime.resolveChatPreludeFlow(args);
    const forwarded = resolvePreUpstreamFlow.mock.calls[0][0];

    expect(result.handled).toBe(true);
    expect(result.envelope).toEqual({ cards: [{ type: 'handled' }] });
    expect(forwarded.attachIngredientRouteMetaToSessionPatch).toBeDefined();
    expect(forwarded.buildSafetyNoticeText({ level: 'warn' })).toBe('EN:warn');
    expect(forwarded.recommendationFlowArgs.forceUpstreamAfterPendingAbandon).toBe(true);
    expect(forwarded.recommendationFlowArgs.ingredientActionData).toEqual({ ingredient_goal: 'glow' });
    expect(forwarded.recommendationFlowArgs.ingredientLookupRequested).toBe(false);
    expect(forwarded.recommendationFlowArgs.ingredientByGoalRequested).toBe(false);
    expect(forwarded.recommendationFlowArgs.pendingClarificationPatchOverride).toBeUndefined();
  });
});

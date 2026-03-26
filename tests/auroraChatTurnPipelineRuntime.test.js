const { createChatTurnPipelineRuntime } = require('../src/auroraBff/chatTurnPipelineRuntime');

function buildArgs(overrides = {}) {
  return {
    ctx: { request_id: 'req_turn_pipeline_1', lang: 'EN' },
    parsedData: { session: { session_id: 'sess_1' } },
    message: 'Recommend a routine',
    actionId: 'action.recommend',
    clarificationId: 'clarify_1',
    actionReplyText: 'Sure',
    normalizedActionPayload: { foo: 'bar' },
    profile: { skin_type: 'dry' },
    appliedProfilePatch: null,
    summarizeChatProfileForContext: jest.fn((profileValue) => ({ profileValue })),
    pushGateDecision: jest.fn(),
    policyMeta: { gate_type: 'none' },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
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
    requestMessage: 'Recommend a routine',
    ingredientReplayContext: { entry: null },
    skipRoutineRulesFallback: false,
    effectiveChatFlags: { chat_response_meta: true },
    hasPlannerAnchor: false,
    debugUpstream: false,
    anchorProductId: 'prod_1',
    anchorProductUrl: 'https://example.com/p/1',
    pendingSafetyAdvisory: null,
    enqueueGateAdvisory: jest.fn(),
    identity: { auroraUid: 'u_1' },
    session: { session_id: 'sess_1' },
    req: { get: jest.fn() },
    INGREDIENT_ROUTE_RULE_VERSION: 'v1',
    AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED: true,
    recentLogs: [{ id: 'log_1' }],
    chatContext: { thread_id: 'thread_1' },
    templateAcceptLanguage: 'en-US',
    buildDiagnosisPrompt: jest.fn(() => 'prompt'),
    buildDiagnosisChips: jest.fn(() => []),
    profileCompleteness: jest.fn(() => ({ missing_fields: [] })),
    stateChangeAllowed: jest.fn(() => true),
    normalizeIngredientActionId: jest.fn((value) => value),
    recommendationFlowBaseArgs: {
      chatSafetyRuntime: { buildSafetyNoticeText: jest.fn(() => '') },
      chatDiagnosisGateRuntime: { resolveDiagnosisEntryEnvelope: jest.fn(() => ({ handled: false })) },
    },
    includeAlternatives: true,
    latestRecoContextFromSession: { source: 'session' },
    textDerivedProfilePatch: { tone: 'warm' },
    textDerivedSkinLog: { oiliness: 'medium' },
    llmProvider: 'gemini',
    llmModel: 'gemini-2.5-pro',
    upstreamMessages: [{ role: 'system', content: 'hi' }],
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED: true,
    profilePatchFromSession: { from_session: true },
    ...overrides,
  };
}

function buildRuntime(overrides = {}) {
  return createChatTurnPipelineRuntime({
    chatFollowupRuntime: {
      maybeBuildAnalysisFollowupEnvelope: jest.fn(() => null),
      maybeBuildFollowupAlternativesEnvelope: jest.fn(async () => null),
    },
    chatPreludeCoordinatorRuntime: {
      resolveChatPreludeFlow: jest.fn(async () => ({
        handled: false,
        clientAgentState: { state: 'client' },
        agentState: { state: 'agent' },
        allowRecoCards: true,
        upstreamMessage: 'upstream message',
        clarificationHistoryForUpstream: [{ field: 'budget' }],
        resumeContextForUpstream: { resume: true },
        forceUpstreamAfterPendingAbandon: false,
        nextStateOverride: 'S6',
        pendingClarificationPatchOverride: { question_id: 'q1' },
        plannerSessionStatePatch: { planner: true },
        safetyDecision: { level: 'advisory' },
        profile: { skin_type: 'combo' },
        pendingSafetyAdvisory: { gate_id: 'safety' },
        requestMessage: 'rerun request',
        ingredientReplayContext: { entry: 'ingredient' },
        skipRoutineRulesFallback: true,
        policyMetaPatch: { route_source: 'prelude' },
      })),
    },
    chatUpstreamTurnRuntime: {
      resolveUpstreamTurn: jest.fn(async () => ({
        envelope: { cards: [{ type: 'upstream' }] },
        llmRouteMetaForResponse: { provider: 'gemini' },
      })),
    },
    ...overrides,
  });
}

describe('aurora chat turn pipeline runtime', () => {
  test('short-circuits on analysis followup before prelude', async () => {
    const runtime = buildRuntime({
      chatFollowupRuntime: {
        maybeBuildAnalysisFollowupEnvelope: jest.fn(() => ({ cards: [{ type: 'followup' }] })),
        maybeBuildFollowupAlternativesEnvelope: jest.fn(async () => null),
      },
    });

    const result = await runtime.resolveChatTurnPipeline(buildArgs());

    expect(result).toEqual({
      handled: true,
      envelope: { cards: [{ type: 'followup' }] },
    });
  });

  test('returns prelude envelope plus replay state when prelude handles the turn', async () => {
    const preludeSpy = jest.fn(async () => ({
      handled: true,
      envelope: { cards: [{ type: 'prelude' }] },
      clientAgentState: { state: 'client_pre' },
      agentState: { state: 'agent_pre' },
      plannerSessionStatePatch: { planner: 'prelude' },
      safetyDecision: { level: 'block' },
      profile: { skin_type: 'oily' },
      pendingSafetyAdvisory: { gate_id: 'prelude_safety' },
      requestMessage: 'handled upstream',
      ingredientReplayContext: { entry: 'prelude' },
      skipRoutineRulesFallback: true,
      policyMetaPatch: { gate_type: 'prelude' },
    }));
    const runtime = buildRuntime({
      chatPreludeCoordinatorRuntime: {
        resolveChatPreludeFlow: preludeSpy,
      },
    });

    const result = await runtime.resolveChatTurnPipeline(buildArgs());

    expect(result).toEqual({
      handled: true,
      envelope: { cards: [{ type: 'prelude' }] },
      clientStateForReplay: { state: 'client_pre' },
      agentStateForReplay: { state: 'agent_pre' },
      plannerSessionStatePatch: { planner: 'prelude' },
      safetyDecision: { level: 'block' },
      profile: { skin_type: 'oily' },
      pendingSafetyAdvisory: { gate_id: 'prelude_safety' },
      requestMessage: 'handled upstream',
      ingredientReplayContext: { entry: 'prelude' },
      skipRoutineRulesFallback: true,
      policyMetaPatch: { gate_type: 'prelude' },
    });
  });

  test('runs upstream turn after prelude and returns envelope plus llm route meta', async () => {
    const upstreamSpy = jest.fn(async () => ({
      envelope: { cards: [{ type: 'upstream' }] },
      llmRouteMetaForResponse: { provider: 'gemini', model: 'gemini-2.5-pro' },
    }));
    const runtime = buildRuntime({
      chatUpstreamTurnRuntime: {
        resolveUpstreamTurn: upstreamSpy,
      },
    });

    const result = await runtime.resolveChatTurnPipeline(buildArgs());

    expect(result).toEqual({
      handled: true,
      envelope: { cards: [{ type: 'upstream' }] },
      llmRouteMetaForResponse: { provider: 'gemini', model: 'gemini-2.5-pro' },
      clientStateForReplay: { state: 'client' },
      agentStateForReplay: { state: 'agent' },
      plannerSessionStatePatch: { planner: true },
      safetyDecision: { level: 'advisory' },
      profile: { skin_type: 'combo' },
      pendingSafetyAdvisory: { gate_id: 'safety' },
      requestMessage: 'rerun request',
      ingredientReplayContext: { entry: 'ingredient' },
      skipRoutineRulesFallback: true,
      policyMetaPatch: { route_source: 'prelude' },
    });
    expect(upstreamSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamMessage: 'upstream message',
        nextStateOverride: 'S6',
        pendingClarificationPatchOverride: { question_id: 'q1' },
        allowRecoCards: true,
        profile: { skin_type: 'combo' },
      }),
    );
  });
});

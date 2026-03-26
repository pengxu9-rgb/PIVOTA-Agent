const { createChatUpstreamTurnRuntime } = require('../src/auroraBff/chatUpstreamTurnRuntime');

function buildRuntime(overrides = {}) {
  const deps = {
    chatUpstreamRequestRuntime: {
      requestUpstream: jest.fn(async () => ({
        upstream: { answer: 'upstream-body' },
        answer: 'upstream answer',
        hasLlmRouteMeta: true,
        llmRouteMeta: { route: 'aurora_chat' },
        llmRouteMetaForResponse: {
          llm_provider_requested: 'gemini',
          llm_model_requested: 'gemini-3',
          llm_provider_effective: 'gemini',
          llm_model_effective: 'gemini-3',
        },
      })),
    },
    chatUpstreamResponseRuntime: {
      buildUpstreamResponseEnvelope: jest.fn(async (args) => ({
        ok: true,
        answer: args.answer,
        profile_summary: args.profileSummary,
        pending: args.pendingClarificationPatchOverride,
      })),
    },
    ...overrides,
  };

  return {
    deps,
    runtime: createChatUpstreamTurnRuntime(deps),
  };
}

function buildArgs(overrides = {}) {
  return {
    ctx: { request_id: 'req_upstream_turn_1', lang: 'EN' },
    profile: { skinType: 'dry' },
    recentLogs: [{ id: 'log_1' }],
    upstreamMessage: 'tell me more',
    message: 'tell me more',
    agentState: 'IDLE_CHAT',
    normalizedActionPayload: { action_id: 'chip.start.reco_products' },
    clarificationId: 'clarify_1',
    clarificationHistoryForUpstream: [{ id: 'q1' }],
    resumeContextForUpstream: { clarification_history: [{ id: 'q1' }] },
    forceUpstreamAfterPendingAbandon: false,
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED: true,
    llmProvider: 'gemini',
    llmModel: 'gemini-3',
    anchorProductId: 'prod_1',
    anchorProductUrl: 'https://example.test/p/1',
    upstreamMessages: [{ role: 'user', content: 'tell me more' }],
    debugUpstream: false,
    allowRecoCards: true,
    includeAlternatives: true,
    actionId: 'chip.start.reco_products',
    req: { id: 'req' },
    appliedProfilePatch: { skinType: 'oily' },
    profilePatchFromSession: null,
    nextStateOverride: 'S7_PRODUCT_RECO',
    pendingClarificationPatchOverride: undefined,
    canonicalIntent: { intent: 'reco_products' },
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    summarizeChatProfileForContext: jest.fn((profile) => ({ summarized: profile.skinType })),
    ...overrides,
  };
}

describe('aurora chat upstream turn runtime', () => {
  test('delegates upstream request and response assembly with summarized profile and llm meta', async () => {
    const { runtime, deps } = buildRuntime();

    const out = await runtime.resolveUpstreamTurn(buildArgs());

    expect(deps.chatUpstreamRequestRuntime.requestUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        profileSummary: { summarized: 'dry' },
        resumeContextForUpstream: null,
        allowRecoCards: true,
      }),
    );
    expect(deps.chatUpstreamResponseRuntime.buildUpstreamResponseEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        upstream: { answer: 'upstream-body' },
        answer: 'upstream answer',
        profileSummary: { summarized: 'dry' },
        hasLlmRouteMeta: true,
        llmRouteMeta: { route: 'aurora_chat' },
      }),
    );
    expect(out).toEqual({
      envelope: {
        ok: true,
        answer: 'upstream answer',
        profile_summary: { summarized: 'dry' },
        pending: undefined,
      },
      profileSummary: { summarized: 'dry' },
      llmRouteMetaForResponse: {
        llm_provider_requested: 'gemini',
        llm_model_requested: 'gemini-3',
        llm_provider_effective: 'gemini',
        llm_model_effective: 'gemini-3',
      },
    });
  });

  test('passes resume context only when clarification-flow v2 resume handoff is forced', async () => {
    const { runtime, deps } = buildRuntime();

    await runtime.resolveUpstreamTurn(buildArgs({
      forceUpstreamAfterPendingAbandon: true,
    }));

    expect(deps.chatUpstreamRequestRuntime.requestUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeContextForUpstream: { clarification_history: [{ id: 'q1' }] },
      }),
    );
  });
});

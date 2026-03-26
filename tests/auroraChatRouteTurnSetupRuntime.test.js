const { createChatRouteTurnSetupRuntime } = require('../src/auroraBff/chatRouteTurnSetupRuntime');

function buildRuntime(overrides = {}) {
  const chatProfileRuntime = {
    loadIdentityContext: jest.fn(async () => ({
      identity: { auroraUid: 'aurora_user_1', userId: 'user_1' },
      profile: { skin_type: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      chatContext: { active_thread_summary: 'before' },
      profilePatchFromSession: { concern: 'redness' },
    })),
  };
  const chatTurnSetupRuntime = {
    prepareChatTurnSetup: jest.fn(async () => ({
      profile: { skin_type: 'oily' },
      recentLogs: [{ id: 'log_2' }],
      requestMessage: 'find me products',
      pendingPregnancyPolicyEvents: [{ event_name: 'pregnancy_policy_defaulted' }],
      actionId: 'chip.reco.start',
      clarificationId: 'clarify_1',
      llmRouteMetaForResponse: { llm_provider_effective: 'gemini' },
      canonicalIntentForResponse: {
        intent: 'reco_products',
        confidence: 0.93,
        entities: { goal: 'hydration' },
      },
      canonicalIntent: {
        intent: 'reco_products',
        source: 'action',
        confidence: 0.93,
        entities: { goal: 'hydration' },
      },
      normalizedActionPayload: { action_id: 'chip.reco.start', data: {} },
      latestRecoContextFromSession: { source: 'session' },
      appliedProfilePatch: { concern: 'redness' },
      textDerivedProfilePatch: { tone: 'calming' },
      textDerivedSkinLog: { text: 'stinging' },
      actionReplyText: 'yes',
      message: 'find me products',
      actionLabel: 'Start',
      includeAlternatives: true,
      debugUpstream: true,
      llmProvider: 'gemini',
      llmModel: 'gemini-2.5-pro',
      anchorProductId: 'prod_1',
      anchorProductUrl: 'https://example.com/p/1',
      upstreamMessages: [{ role: 'user', content: 'find me products' }],
      hasPlannerAnchor: true,
    })),
  };
  const getRecoDogfoodSessionId = jest.fn((_req, _ctx, sessionId) => `dogfood:${sessionId || 'generated'}`);
  const computeAuroraChatRolloutContext = jest.fn(() => ({
    effective_flags: {
      chat_response_meta: true,
      profile_v2: true,
    },
    variant: 'beta',
  }));
  const pickFirstTrimmed = (...values) => {
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    return '';
  };
  const addEmotionalPreambleToAssistantText = jest.fn((content, { profile }) => {
    return `[${profile?.skin_type || 'unknown'}] ${content}`;
  });

  const runtime = createChatRouteTurnSetupRuntime({
    chatProfileRuntime,
    chatTurnSetupRuntime,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    pickFirstTrimmed,
    addEmotionalPreambleToAssistantText,
    AURORA_CHAT_GLOBAL_FLAGS: { chat_response_meta: false, profile_v2: false },
    AURORA_CHAT_POLICY_VERSION: 'policy_v1',
    ...overrides,
  });

  return {
    runtime,
    chatProfileRuntime,
    chatTurnSetupRuntime,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    addEmotionalPreambleToAssistantText,
  };
}

function buildArgs(overrides = {}) {
  return {
    req: {},
    ctx: {
      request_id: 'req_1',
      trace_id: 'trace_1',
      lang: 'en',
    },
    parsedData: {
      session: {
        sessionId: 'session_1',
      },
    },
    routeState: {
      profile: null,
      recentLogs: [],
      chatContext: null,
      resolvedIdentity: { auroraUid: null, userId: null },
      requestMessage: '',
      pendingPregnancyPolicyEvents: [{ event_name: 'existing_event' }],
      actionIdForReplay: null,
      latestClarificationId: null,
      llmRouteMetaForResponse: null,
      canonicalIntentForResponse: null,
    },
    effectiveChatFlags: { chat_response_meta: false, profile_v2: false },
    policyMeta: {},
    INTENT_ENUM: {
      UNKNOWN: 'unknown',
    },
    makeAssistantMessage: jest.fn((content, format = 'text') => ({
      role: 'assistant',
      content,
      format,
    })),
    ...overrides,
  };
}

describe('aurora chat route turn setup runtime', () => {
  test('prepares route state and returns pipeline-ready turn fields', async () => {
    const {
      runtime,
      chatProfileRuntime,
      chatTurnSetupRuntime,
      getRecoDogfoodSessionId,
      computeAuroraChatRolloutContext,
      addEmotionalPreambleToAssistantText,
    } = buildRuntime();
    const args = buildArgs();

    const preparedTurn = await runtime.prepareChatRouteTurn(args);

    expect(getRecoDogfoodSessionId).toHaveBeenCalledWith(args.req, args.ctx, 'session_1');
    expect(chatProfileRuntime.loadIdentityContext).toHaveBeenCalledWith({
      req: args.req,
      ctx: args.ctx,
      session: args.parsedData.session,
    });
    expect(computeAuroraChatRolloutContext).toHaveBeenCalledWith({
      req: args.req,
      ctx: args.ctx,
      body: args.parsedData,
      identity: { auroraUid: 'aurora_user_1', userId: 'user_1' },
      globalFlags: { chat_response_meta: false, profile_v2: false },
      policyVersion: 'policy_v1',
    });
    expect(chatTurnSetupRuntime.prepareChatTurnSetup).toHaveBeenCalledWith({
      parsedData: args.parsedData,
      req: args.req,
      ctx: args.ctx,
      profile: { skin_type: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      identity: { auroraUid: 'aurora_user_1', userId: 'user_1' },
      effectiveChatFlags: { chat_response_meta: true, profile_v2: true },
    });
    expect(args.routeState).toEqual(
      expect.objectContaining({
        profile: { skin_type: 'oily' },
        recentLogs: [{ id: 'log_2' }],
        chatContext: { active_thread_summary: 'before' },
        resolvedIdentity: { auroraUid: 'aurora_user_1', userId: 'user_1' },
        requestMessage: 'find me products',
        actionIdForReplay: 'chip.reco.start',
        latestClarificationId: 'clarify_1',
        llmRouteMetaForResponse: { llm_provider_effective: 'gemini' },
        canonicalIntentForResponse: {
          intent: 'reco_products',
          confidence: 0.93,
          entities: { goal: 'hydration' },
        },
      }),
    );
    expect(args.routeState.pendingPregnancyPolicyEvents).toEqual([
      { event_name: 'existing_event' },
      { event_name: 'pregnancy_policy_defaulted' },
    ]);
    expect(args.policyMeta).toEqual({
      intent_canonical: 'reco_products',
      intent_source: 'action',
    });
    expect(preparedTurn).toEqual(
      expect.objectContaining({
        chatSessionId: 'dogfood:session_1',
        rolloutContext: {
          effective_flags: {
            chat_response_meta: true,
            profile_v2: true,
          },
          variant: 'beta',
        },
        effectiveChatFlags: { chat_response_meta: true, profile_v2: true },
        shouldAttachPolicyMeta: true,
        identity: { auroraUid: 'aurora_user_1', userId: 'user_1' },
        profilePatchFromSession: { concern: 'redness' },
        actionReplyText: 'yes',
        message: 'find me products',
        actionId: 'chip.reco.start',
        clarificationId: 'clarify_1',
        includeAlternatives: true,
        debugUpstream: true,
        llmProvider: 'gemini',
        llmModel: 'gemini-2.5-pro',
        anchorProductId: 'prod_1',
        anchorProductUrl: 'https://example.com/p/1',
        hasPlannerAnchor: true,
      }),
    );

    const assistantMessage = preparedTurn.makeChatAssistantMessage('hello there');
    expect(addEmotionalPreambleToAssistantText).toHaveBeenCalledWith('hello there', {
      language: 'en',
      profile: { skin_type: 'oily' },
      seed: 'req_1|trace_1|hello there',
    });
    expect(assistantMessage).toEqual({
      role: 'assistant',
      content: '[oily] hello there',
      format: 'text',
    });
  });

  test('falls back to incoming effective flags when rollout does not override them', async () => {
    const { runtime } = buildRuntime({
      computeAuroraChatRolloutContext: jest.fn(() => ({ variant: 'control' })),
    });
    const args = buildArgs({
      effectiveChatFlags: { chat_response_meta: false, profile_v2: true },
    });

    const preparedTurn = await runtime.prepareChatRouteTurn(args);

    expect(preparedTurn.rolloutContext).toEqual({ variant: 'control' });
    expect(preparedTurn.effectiveChatFlags).toEqual({ chat_response_meta: false, profile_v2: true });
    expect(preparedTurn.shouldAttachPolicyMeta).toBe(false);
  });

  test('throws when routeState is missing', async () => {
    const { runtime } = buildRuntime();

    await expect(
      runtime.prepareChatRouteTurn(
        buildArgs({
          routeState: null,
        }),
      ),
    ).rejects.toThrow('aurora chat route turn setup runtime missing routeState');
  });
});

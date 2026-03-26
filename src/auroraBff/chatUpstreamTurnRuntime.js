function createChatUpstreamTurnRuntime(options = {}) {
  const {
    chatUpstreamRequestRuntime,
    chatUpstreamResponseRuntime,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat upstream turn runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function resolveUpstreamTurn(args = {}) {
    const {
      ctx,
      profile = null,
      recentLogs = [],
      upstreamMessage = '',
      message = '',
      agentState = '',
      normalizedActionPayload = null,
      clarificationId = '',
      clarificationHistoryForUpstream = null,
      resumeContextForUpstream = null,
      forceUpstreamAfterPendingAbandon = false,
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED = false,
      llmProvider = '',
      llmModel = '',
      anchorProductId = '',
      anchorProductUrl = '',
      upstreamMessages = null,
      debugUpstream = false,
      allowRecoCards = false,
      includeAlternatives = false,
      actionId = '',
      req,
      appliedProfilePatch = null,
      profilePatchFromSession = null,
      nextStateOverride = null,
      pendingClarificationPatchOverride = undefined,
      canonicalIntent = null,
      makeChatAssistantMessage,
      summarizeChatProfileForContext,
    } = args;

    const requestUpstream = requireMethod(
      chatUpstreamRequestRuntime,
      'chatUpstreamRequestRuntime',
      'requestUpstream',
    );
    const buildUpstreamResponseEnvelope = requireMethod(
      chatUpstreamResponseRuntime,
      'chatUpstreamResponseRuntime',
      'buildUpstreamResponseEnvelope',
    );
    const summarizeChatProfileForContextFn = requireFunction(
      'summarizeChatProfileForContext',
      summarizeChatProfileForContext,
    );
    const makeChatAssistantMessageFn = requireFunction(
      'makeChatAssistantMessage',
      makeChatAssistantMessage,
    );

    const profileSummary = summarizeChatProfileForContextFn(profile);
    const upstreamRequestResult = await requestUpstream({
      ctx,
      profile,
      profileSummary,
      recentLogs,
      upstreamMessage,
      message,
      agentState,
      normalizedActionPayload,
      clarificationId,
      clarificationHistoryForUpstream,
      resumeContextForUpstream:
        AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED && forceUpstreamAfterPendingAbandon
          ? resumeContextForUpstream
          : null,
      llmProvider,
      llmModel,
      anchorProductId,
      anchorProductUrl,
      upstreamMessages,
      debugUpstream,
      allowRecoCards,
    });

    const envelope = await buildUpstreamResponseEnvelope({
      ctx,
      upstream: upstreamRequestResult.upstream,
      allowRecs: allowRecoCards,
      includeAlternatives,
      debugUpstream,
      answer: upstreamRequestResult.answer,
      message,
      upstreamMessage,
      actionId,
      req,
      anchorProductUrl,
      anchorProductId,
      llmProvider,
      llmModel,
      normalizedActionPayload,
      profile,
      recentLogs,
      profileSummary,
      appliedProfilePatch,
      profilePatchFromSession,
      nextStateOverride,
      pendingClarificationPatchOverride,
      hasLlmRouteMeta: upstreamRequestResult.hasLlmRouteMeta,
      llmRouteMeta: upstreamRequestResult.llmRouteMeta,
      canonicalIntent,
      makeChatAssistantMessage: makeChatAssistantMessageFn,
    });

    return {
      envelope,
      profileSummary,
      llmRouteMetaForResponse: upstreamRequestResult.llmRouteMetaForResponse || null,
    };
  }

  return {
    resolveUpstreamTurn,
  };
}

module.exports = {
  createChatUpstreamTurnRuntime,
};

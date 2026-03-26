function createChatRouteTurnSetupRuntime(options = {}) {
  const {
    chatProfileRuntime = null,
    chatTurnSetupRuntime = null,
    getRecoDogfoodSessionId = null,
    computeAuroraChatRolloutContext = null,
    pickFirstTrimmed = null,
    addEmotionalPreambleToAssistantText = null,
    AURORA_CHAT_GLOBAL_FLAGS = {},
    AURORA_CHAT_POLICY_VERSION = '',
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat route turn setup runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  async function prepareChatRouteTurn(args = {}) {
    const loadIdentityContext = requireMethod(
      chatProfileRuntime,
      'chatProfileRuntime',
      'loadIdentityContext',
    );
    const prepareChatTurnSetup = requireMethod(
      chatTurnSetupRuntime,
      'chatTurnSetupRuntime',
      'prepareChatTurnSetup',
    );
    const getRecoDogfoodSessionIdFn = requireFunction(
      'getRecoDogfoodSessionId',
      getRecoDogfoodSessionId,
    );
    const computeAuroraChatRolloutContextFn = requireFunction(
      'computeAuroraChatRolloutContext',
      computeAuroraChatRolloutContext,
    );
    const pickFirstTrimmedFn = requireFunction('pickFirstTrimmed', pickFirstTrimmed);
    const addEmotionalPreambleToAssistantTextFn = requireFunction(
      'addEmotionalPreambleToAssistantText',
      addEmotionalPreambleToAssistantText,
    );

    const {
      req,
      ctx,
      parsedData,
      routeState,
      effectiveChatFlags,
      policyMeta,
      INTENT_ENUM,
      makeAssistantMessage,
    } = args;

    if (!routeState || typeof routeState !== 'object') {
      throw new Error('aurora chat route turn setup runtime missing routeState');
    }

    const chatSessionId = getRecoDogfoodSessionIdFn(
      req,
      ctx,
      pickFirstTrimmedFn(
        parsedData?.session?.session_id,
        parsedData?.session?.sessionId,
        parsedData?.session?.id,
      ),
    );

    const {
      identity,
      profile: loadedProfile,
      recentLogs: loadedRecentLogs,
      chatContext: loadedChatContext,
      profilePatchFromSession,
    } = await loadIdentityContext({
      req,
      ctx,
      session: parsedData.session,
    });

    routeState.resolvedIdentity = {
      auroraUid: identity.auroraUid || null,
      userId: identity.userId || null,
    };

    const rolloutContext = computeAuroraChatRolloutContextFn({
      req,
      ctx,
      body: parsedData,
      identity,
      globalFlags: AURORA_CHAT_GLOBAL_FLAGS,
      policyVersion: AURORA_CHAT_POLICY_VERSION,
    });
    const nextEffectiveChatFlags = rolloutContext.effective_flags || effectiveChatFlags || {};
    const shouldAttachPolicyMeta = Boolean(nextEffectiveChatFlags.chat_response_meta);

    routeState.profile = loadedProfile;
    routeState.recentLogs = loadedRecentLogs;
    routeState.chatContext = loadedChatContext;

    const turnSetup = await prepareChatTurnSetup({
      parsedData,
      req,
      ctx,
      profile: routeState.profile,
      recentLogs: routeState.recentLogs,
      identity,
      effectiveChatFlags: nextEffectiveChatFlags,
    });

    routeState.profile = turnSetup.profile;
    routeState.recentLogs = turnSetup.recentLogs;
    routeState.requestMessage = turnSetup.requestMessage;
    routeState.pendingPregnancyPolicyEvents = [
      ...routeState.pendingPregnancyPolicyEvents,
      ...(Array.isArray(turnSetup.pendingPregnancyPolicyEvents)
        ? turnSetup.pendingPregnancyPolicyEvents
        : []),
    ];
    routeState.actionIdForReplay = String(turnSetup.actionId || '').trim() || null;
    routeState.latestClarificationId = turnSetup.clarificationId || null;
    routeState.llmRouteMetaForResponse = turnSetup.llmRouteMetaForResponse;
    routeState.canonicalIntentForResponse = turnSetup.canonicalIntentForResponse;

    const canonicalIntent = turnSetup.canonicalIntent;
    if (policyMeta && typeof policyMeta === 'object') {
      policyMeta.intent_canonical = canonicalIntent.intent || INTENT_ENUM.UNKNOWN;
      policyMeta.intent_source = canonicalIntent.source || 'none';
    }

    const makeChatAssistantMessage = (content, format = 'text') => {
      const preambleSeed = `${ctx.request_id || ''}|${ctx.trace_id || ''}|${String(content || '').slice(0, 96)}`;
      const text = addEmotionalPreambleToAssistantTextFn(content, {
        language: ctx.lang,
        profile: routeState.profile,
        seed: preambleSeed,
      });
      return makeAssistantMessage(text, format);
    };

    return {
      chatSessionId,
      rolloutContext,
      effectiveChatFlags: nextEffectiveChatFlags,
      shouldAttachPolicyMeta,
      identity,
      profilePatchFromSession,
      normalizedActionPayload: turnSetup.normalizedActionPayload,
      latestRecoContextFromSession: turnSetup.latestRecoContextFromSession,
      appliedProfilePatch: turnSetup.appliedProfilePatch,
      textDerivedProfilePatch: turnSetup.textDerivedProfilePatch,
      textDerivedSkinLog: turnSetup.textDerivedSkinLog,
      actionReplyText: turnSetup.actionReplyText,
      message: turnSetup.message,
      actionId: turnSetup.actionId,
      actionLabel: turnSetup.actionLabel,
      clarificationId: turnSetup.clarificationId,
      includeAlternatives: turnSetup.includeAlternatives,
      debugUpstream: turnSetup.debugUpstream,
      llmProvider: turnSetup.llmProvider,
      llmModel: turnSetup.llmModel,
      anchorProductId: turnSetup.anchorProductId,
      anchorProductUrl: turnSetup.anchorProductUrl,
      upstreamMessages: turnSetup.upstreamMessages,
      canonicalIntent,
      hasPlannerAnchor: turnSetup.hasPlannerAnchor,
      makeChatAssistantMessage,
    };
  }

  return {
    prepareChatRouteTurn,
  };
}

module.exports = {
  createChatRouteTurnSetupRuntime,
};

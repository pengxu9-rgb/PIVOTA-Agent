const { createChatRouteRuntimeBundle } = require('../bootstrapChatRouteRuntime');

function mountChatRoutes(app, deps = {}) {
  const {
    V1ChatRequestSchema,
    INTENT_ENUM,
    makeEvent,
    logger,
    requireAuroraUid,
    buildEnvelope,
    makeAssistantMessage,
    profileCompleteness,
    buildDiagnosisPrompt,
    buildDiagnosisChips,
    stateChangeAllowed,
    normalizeIngredientActionId,
    AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED,
    AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
    AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED,
    INGREDIENT_ROUTE_RULE_VERSION,
    getPendingClarification,
    recordPendingClarificationAbandoned,
    recordSessionPatchProfileEmitted,
    buildChipsForQuestion,
    recordAuroraChatSkipped,
    recordPendingClarificationStep,
    recordPendingClarificationCompleted,
  } = deps;

  const {
    chatDiagnosisGateRuntime,
    chatRouteDeliveryShellRuntime,
    chatRouteRequestShellRuntime,
    chatRouteTurnSetupRuntime,
    chatSafetyRuntime,
    chatTurnPipelineRuntime,
  } = createChatRouteRuntimeBundle(deps);

  app.post('/v1/chat', async (req, res) => {
    const parsed = V1ChatRequestSchema.safeParse(req.body || {});
    const requestShell = chatRouteRequestShellRuntime.createChatRouteRequestShell({
      req,
      res,
      rawBody: parsed.success ? parsed.data : req.body || {},
    });

    try {
      requireAuroraUid(requestShell.ctx);
      if (!parsed.success) {
        const envelope = requestShell.buildInvalidRequestEnvelope({
          parsedError: parsed.error,
        });
        return requestShell.sendChatEnvelope(envelope, 400);
      }

      const preparedTurn = await chatRouteTurnSetupRuntime.prepareChatRouteTurn({
        req,
        ctx: requestShell.ctx,
        parsedData: parsed.data,
        routeState: requestShell.routeState,
        effectiveChatFlags: requestShell.effectiveChatFlags,
        policyMeta: requestShell.policyMeta,
        INTENT_ENUM,
        makeAssistantMessage,
      });
      requestShell.applyPreparedTurn({ preparedTurn });
      const turnPipelineResult = await chatTurnPipelineRuntime.resolveChatTurnPipeline({
        ctx: requestShell.ctx,
        parsedData: parsed.data,
        message: preparedTurn.message,
        actionId: preparedTurn.actionId,
        clarificationId: preparedTurn.clarificationId,
        actionReplyText: preparedTurn.actionReplyText,
        normalizedActionPayload: preparedTurn.normalizedActionPayload,
        profile: requestShell.routeState.profile,
        appliedProfilePatch: preparedTurn.appliedProfilePatch,
        summarizeChatProfileForContext: requestShell.summarizeChatProfileForContext,
        pushGateDecision: requestShell.pushGateDecision,
        policyMeta: requestShell.policyMeta,
        logger,
        buildEnvelope,
        makeChatAssistantMessage: preparedTurn.makeChatAssistantMessage,
        makeEvent,
        recordPendingClarificationAbandoned,
        recordSessionPatchProfileEmitted,
        buildChipsForQuestion,
        recordAuroraChatSkipped,
        recordPendingClarificationStep,
        recordPendingClarificationCompleted,
        getPendingClarification,
        AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED,
        canonicalIntent: preparedTurn.canonicalIntent,
        INTENT_ENUM,
        requestMessage: requestShell.routeState.requestMessage,
        ingredientReplayContext: requestShell.routeState.ingredientReplayContext,
        skipRoutineRulesFallback: requestShell.routeState.skipRoutineRulesFallback,
        effectiveChatFlags: requestShell.effectiveChatFlags,
        hasPlannerAnchor: preparedTurn.hasPlannerAnchor,
        debugUpstream: preparedTurn.debugUpstream,
        anchorProductId: preparedTurn.anchorProductId,
        anchorProductUrl: preparedTurn.anchorProductUrl,
        pendingSafetyAdvisory: requestShell.routeState.pendingSafetyAdvisory,
        enqueueGateAdvisory: requestShell.enqueueGateAdvisory,
        identity: preparedTurn.identity,
        session: parsed.data.session,
        req,
        INGREDIENT_ROUTE_RULE_VERSION,
        AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED,
        recentLogs: requestShell.routeState.recentLogs,
        chatContext: requestShell.routeState.chatContext,
        templateAcceptLanguage: requestShell.templateCtx.accept_language || '',
        buildDiagnosisPrompt,
        buildDiagnosisChips,
        profileCompleteness,
        stateChangeAllowed,
        normalizeIngredientActionId,
        recommendationFlowBaseArgs: {
          forceUpstreamAfterPendingAbandon: false,
          chatSafetyRuntime,
          chatDiagnosisGateRuntime,
        },
        includeAlternatives: preparedTurn.includeAlternatives,
        latestRecoContextFromSession: preparedTurn.latestRecoContextFromSession,
        textDerivedProfilePatch: preparedTurn.textDerivedProfilePatch,
        textDerivedSkinLog: preparedTurn.textDerivedSkinLog,
        llmProvider: preparedTurn.llmProvider,
        llmModel: preparedTurn.llmModel,
        upstreamMessages: preparedTurn.upstreamMessages,
        AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED,
        profilePatchFromSession: preparedTurn.profilePatchFromSession,
      });
      chatRouteDeliveryShellRuntime.applyTurnPipelineResult({
        routeState: requestShell.routeState,
        turnPipelineResult,
        policyMeta: requestShell.policyMeta,
      });
      return requestShell.sendChatEnvelope(turnPipelineResult.envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.error({ err: err.message, status }, 'aurora bff chat failed');
      const envelope = buildEnvelope(requestShell.ctx, {
        assistant_message: makeAssistantMessage('Failed to process chat.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${requestShell.ctx.request_id}`, type: 'error', payload: { error: err.code || 'CHAT_FAILED' } }],
        session_patch: {},
        events: [makeEvent(requestShell.ctx, 'error', { code: err.code || 'CHAT_FAILED' })],
      });
      return requestShell.sendChatEnvelope(envelope, status);
    }
  });
}

module.exports = { mountChatRoutes };

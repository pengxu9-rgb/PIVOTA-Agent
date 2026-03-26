function createChatRouteRequestShellRuntime(options = {}) {
  const {
    buildRequestContext,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    AURORA_CHAT_GLOBAL_FLAGS = {},
    AURORA_CHAT_POLICY_VERSION = 'legacy',
    DEFAULT_AGENT_STATE = 'IDLE_CHAT',
    INTENT_ENUM = { UNKNOWN: 'unknown' },
    chatAdvisoryRuntime = null,
    chatEnvelopeMetaRuntime = null,
    chatPolicyRuntime = null,
    chatRouteDeliveryShellRuntime = null,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat route request shell runtime missing dependency: ${name}`);
  }

  function requireMethod(owner, ownerName, methodName) {
    const source = owner && typeof owner === 'object' ? owner : null;
    const value = source ? source[methodName] : null;
    return requireFunction(`${ownerName}.${methodName}`, value);
  }

  function buildTemplateCtx(ctx, req) {
    const acceptLanguage =
      req && typeof req.get === 'function'
        ? String(req.get('Accept-Language') || req.get('accept-language') || '').trim()
        : '';
    return {
      ...ctx,
      accept_language: acceptLanguage,
    };
  }

  function createChatRouteRequestShell({ req, res, rawBody } = {}) {
    const buildRequestContextFn = requireFunction('buildRequestContext', buildRequestContext);
    const getRecoDogfoodSessionIdFn = requireFunction('getRecoDogfoodSessionId', getRecoDogfoodSessionId);
    const computeAuroraChatRolloutContextFn = requireFunction(
      'computeAuroraChatRolloutContext',
      computeAuroraChatRolloutContext,
    );
    const createPolicyState = requireMethod(chatPolicyRuntime, 'chatPolicyRuntime', 'createPolicyState');
    const summarizeChatProfileForContextFn = requireMethod(
      chatEnvelopeMetaRuntime,
      'chatEnvelopeMetaRuntime',
      'summarizeChatProfileForContext',
    );
    const enqueueGateAdvisoryFn = requireMethod(
      chatAdvisoryRuntime,
      'chatAdvisoryRuntime',
      'enqueueGateAdvisory',
    );
    const createRouteState = requireMethod(
      chatRouteDeliveryShellRuntime,
      'chatRouteDeliveryShellRuntime',
      'createRouteState',
    );
    const sendChatEnvelopeFn = requireMethod(
      chatRouteDeliveryShellRuntime,
      'chatRouteDeliveryShellRuntime',
      'sendChatEnvelope',
    );
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeAssistantMessageFn = requireFunction('makeAssistantMessage', makeAssistantMessage);
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
    const ctx = buildRequestContextFn(req, body);
    const templateCtx = buildTemplateCtx(ctx, req);
    const routeState = createRouteState({
      defaultAgentState: DEFAULT_AGENT_STATE,
      unknownIntent: INTENT_ENUM.UNKNOWN,
    });

    const shell = {
      req,
      res,
      ctx,
      templateCtx,
      routeState,
      chatSessionId: getRecoDogfoodSessionIdFn(req, ctx, ''),
      rolloutContext: null,
      effectiveChatFlags: { ...AURORA_CHAT_GLOBAL_FLAGS },
      shouldAttachPolicyMeta: false,
      policyMeta: null,
      pushGateDecision: null,
      buildInvalidRequestEnvelope: null,
      summarizeChatProfileForContext: null,
      enqueueGateAdvisory: null,
      sendChatEnvelope: null,
      applyPreparedTurn: null,
    };

    shell.rolloutContext = computeAuroraChatRolloutContextFn({
      req,
      ctx,
      body,
      identity: null,
      globalFlags: AURORA_CHAT_GLOBAL_FLAGS,
      policyVersion: AURORA_CHAT_POLICY_VERSION,
    });
    shell.effectiveChatFlags = shell.rolloutContext.effective_flags || { ...AURORA_CHAT_GLOBAL_FLAGS };
    shell.shouldAttachPolicyMeta = Boolean(shell.effectiveChatFlags.chat_response_meta);

    const chatPolicyState = createPolicyState({
      rolloutContext: shell.rolloutContext,
      effectiveChatFlags: shell.effectiveChatFlags,
      INTENT_ENUM,
    });
    shell.policyMeta = chatPolicyState.policyMeta;
    shell.pushGateDecision = chatPolicyState.pushGateDecision;

    const refreshPolicyMetaRollout = () => {
      shell.effectiveChatFlags = shell.rolloutContext.effective_flags || shell.effectiveChatFlags;
      shell.shouldAttachPolicyMeta = Boolean(shell.effectiveChatFlags.chat_response_meta);
      chatPolicyState.refreshPolicyMetaRollout({
        rolloutContext: shell.rolloutContext,
        effectiveChatFlags: shell.effectiveChatFlags,
      });
    };

    refreshPolicyMetaRollout();

    shell.summarizeChatProfileForContext = (profileValue) =>
      summarizeChatProfileForContextFn({
        profileValue,
        effectiveChatFlags: shell.effectiveChatFlags,
      });

    shell.enqueueGateAdvisory = ({ gate_id, message, reason_codes, actions, chips } = {}) => {
      enqueueGateAdvisoryFn({
        pendingGateAdvisories: shell.routeState.pendingGateAdvisories,
        gate_id,
        message,
        reason_codes,
        actions,
        chips,
      });
    };

    shell.sendChatEnvelope = async (envelope, statusCode = 200) => {
      chatPolicyState.syncGatePolicyMeta();
      return sendChatEnvelopeFn({
        routeState: shell.routeState,
        envelope,
        statusCode,
        res: shell.res,
        req: shell.req,
        ctx: shell.ctx,
        templateCtx: shell.templateCtx,
        chatSessionId: shell.chatSessionId,
        policyMeta: shell.policyMeta,
        rolloutContext: shell.rolloutContext,
        shouldAttachPolicyMeta: shell.shouldAttachPolicyMeta,
      });
    };

    shell.buildInvalidRequestEnvelope = ({ parsedError } = {}) =>
      buildEnvelopeFn(shell.ctx, {
        assistant_message: makeAssistantMessageFn('Invalid request.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${shell.ctx.request_id}`,
            type: 'error',
            payload: {
              error: 'BAD_REQUEST',
              details:
                parsedError && typeof parsedError.format === 'function'
                  ? parsedError.format()
                  : parsedError || null,
            },
          },
        ],
        session_patch: {},
        events: [makeEventFn(shell.ctx, 'error', { code: 'BAD_REQUEST' })],
      });

    shell.applyPreparedTurn = ({ preparedTurn } = {}) => {
      const turn = preparedTurn && typeof preparedTurn === 'object' ? preparedTurn : {};
      shell.chatSessionId = turn.chatSessionId || shell.chatSessionId;
      shell.rolloutContext = turn.rolloutContext || shell.rolloutContext;
      shell.effectiveChatFlags = turn.effectiveChatFlags || shell.effectiveChatFlags;
      shell.shouldAttachPolicyMeta =
        typeof turn.shouldAttachPolicyMeta === 'boolean'
          ? turn.shouldAttachPolicyMeta
          : shell.shouldAttachPolicyMeta;
      refreshPolicyMetaRollout();
    };

    return shell;
  }

  return {
    createChatRouteRequestShell,
  };
}

module.exports = {
  createChatRouteRequestShellRuntime,
};

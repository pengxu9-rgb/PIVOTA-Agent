const { createChatRouteRequestShellRuntime } = require('../src/auroraBff/chatRouteRequestShellRuntime');

function buildRuntime() {
  const buildRequestContext = jest.fn((_req, body) => ({
    request_id: body.request_id || 'req_1',
    trace_id: 'trace_1',
    lang: 'en',
  }));
  const getRecoDogfoodSessionId = jest.fn((_req, _ctx, sessionId) => `dogfood:${sessionId || 'generated'}`);
  const computeAuroraChatRolloutContext = jest.fn(() => ({
    effective_flags: {
      chat_response_meta: true,
      profile_v2: true,
    },
    policy_version: 'policy_v2',
    variant: 'beta',
    bucket: 17,
    applied: true,
  }));
  const refreshPolicyMetaRollout = jest.fn();
  const syncGatePolicyMeta = jest.fn();
  const pushGateDecision = jest.fn();
  const policyMeta = { intent_canonical: 'unknown' };
  const chatPolicyRuntime = {
    createPolicyState: jest.fn(() => ({
      policyMeta,
      pushGateDecision,
      syncGatePolicyMeta,
      refreshPolicyMetaRollout,
    })),
  };
  const chatEnvelopeMetaRuntime = {
    summarizeChatProfileForContext: jest.fn(({ profileValue, effectiveChatFlags }) => ({
      profileValue,
      effectiveChatFlags,
    })),
  };
  const chatAdvisoryRuntime = {
    enqueueGateAdvisory: jest.fn(({ pendingGateAdvisories, gate_id }) => {
      pendingGateAdvisories.push({ gate_id });
    }),
  };
  const routeState = {
    pendingGateAdvisories: [],
    pendingPregnancyPolicyEvents: [],
  };
  const chatRouteDeliveryShellRuntime = {
    createRouteState: jest.fn(() => routeState),
    sendChatEnvelope: jest.fn(async () => ({ ok: true })),
  };
  const buildEnvelope = jest.fn((ctx, payload) => ({ ctx, ...payload }));
  const makeAssistantMessage = jest.fn((content) => ({ role: 'assistant', content }));
  const makeEvent = jest.fn((ctx, event_name, event_data) => ({ request_id: ctx.request_id, event_name, event_data }));
  const req = {
    get: jest.fn((name) => (String(name).toLowerCase() === 'accept-language' ? 'en-US' : '')),
  };
  const res = {};

  const runtime = createChatRouteRequestShellRuntime({
    buildRequestContext,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    AURORA_CHAT_GLOBAL_FLAGS: { chat_response_meta: false, profile_v2: false },
    AURORA_CHAT_POLICY_VERSION: 'policy_v1',
    DEFAULT_AGENT_STATE: 'IDLE_CHAT',
    INTENT_ENUM: { UNKNOWN: 'unknown' },
    chatAdvisoryRuntime,
    chatEnvelopeMetaRuntime,
    chatPolicyRuntime,
    chatRouteDeliveryShellRuntime,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
  });

  return {
    runtime,
    buildRequestContext,
    getRecoDogfoodSessionId,
    computeAuroraChatRolloutContext,
    chatPolicyRuntime,
    pushGateDecision,
    syncGatePolicyMeta,
    refreshPolicyMetaRollout,
    chatEnvelopeMetaRuntime,
    chatAdvisoryRuntime,
    chatRouteDeliveryShellRuntime,
    buildEnvelope,
    makeAssistantMessage,
    makeEvent,
    req,
    res,
    routeState,
    policyMeta,
  };
}

describe('aurora chat route request shell runtime', () => {
  test('creates request shell with stable initial context, policy, and helpers', () => {
    const {
      runtime,
      buildRequestContext,
      getRecoDogfoodSessionId,
      computeAuroraChatRolloutContext,
      chatPolicyRuntime,
      chatRouteDeliveryShellRuntime,
      chatEnvelopeMetaRuntime,
      chatAdvisoryRuntime,
      req,
      res,
      routeState,
      policyMeta,
      pushGateDecision,
    } = buildRuntime();

    const shell = runtime.createChatRouteRequestShell({
      req,
      res,
      rawBody: { session: { sessionId: 'session_1' } },
    });

    expect(buildRequestContext).toHaveBeenCalledWith(req, { session: { sessionId: 'session_1' } });
    expect(getRecoDogfoodSessionId).toHaveBeenCalledWith(req, shell.ctx, '');
    expect(computeAuroraChatRolloutContext).toHaveBeenCalledWith({
      req,
      ctx: shell.ctx,
      body: { session: { sessionId: 'session_1' } },
      identity: null,
      globalFlags: { chat_response_meta: false, profile_v2: false },
      policyVersion: 'policy_v1',
    });
    expect(chatPolicyRuntime.createPolicyState).toHaveBeenCalledWith({
      rolloutContext: shell.rolloutContext,
      effectiveChatFlags: { chat_response_meta: true, profile_v2: true },
      INTENT_ENUM: { UNKNOWN: 'unknown' },
    });
    expect(chatRouteDeliveryShellRuntime.createRouteState).toHaveBeenCalledWith({
      defaultAgentState: 'IDLE_CHAT',
      unknownIntent: 'unknown',
    });
    expect(shell.policyMeta).toBe(policyMeta);
    expect(shell.pushGateDecision).toBe(pushGateDecision);
    expect(shell.templateCtx.accept_language).toBe('en-US');

    expect(shell.summarizeChatProfileForContext({ skin_type: 'dry' })).toEqual({
      profileValue: { skin_type: 'dry' },
      effectiveChatFlags: { chat_response_meta: true, profile_v2: true },
    });
    expect(chatEnvelopeMetaRuntime.summarizeChatProfileForContext).toHaveBeenCalledWith({
      profileValue: { skin_type: 'dry' },
      effectiveChatFlags: { chat_response_meta: true, profile_v2: true },
    });

    shell.enqueueGateAdvisory({ gate_id: 'diag_gate' });
    expect(chatAdvisoryRuntime.enqueueGateAdvisory).toHaveBeenCalledWith({
      pendingGateAdvisories: routeState.pendingGateAdvisories,
      gate_id: 'diag_gate',
      message: undefined,
      reason_codes: undefined,
      actions: undefined,
      chips: undefined,
    });
    expect(routeState.pendingGateAdvisories).toEqual([{ gate_id: 'diag_gate' }]);
  });

  test('applies prepared turn rollout updates and delegates envelope delivery', async () => {
    const {
      runtime,
      refreshPolicyMetaRollout,
      syncGatePolicyMeta,
      chatRouteDeliveryShellRuntime,
      req,
      res,
      routeState,
      policyMeta,
    } = buildRuntime();

    const shell = runtime.createChatRouteRequestShell({
      req,
      res,
      rawBody: {},
    });
    shell.applyPreparedTurn({
      preparedTurn: {
        chatSessionId: 'dogfood:session_1',
        rolloutContext: {
          effective_flags: {
            chat_response_meta: false,
            profile_v2: false,
          },
          variant: 'control',
        },
        effectiveChatFlags: {
          chat_response_meta: false,
          profile_v2: false,
        },
        shouldAttachPolicyMeta: false,
      },
    });

    expect(refreshPolicyMetaRollout).toHaveBeenLastCalledWith({
      rolloutContext: {
        effective_flags: {
          chat_response_meta: false,
          profile_v2: false,
        },
        variant: 'control',
      },
      effectiveChatFlags: {
        chat_response_meta: false,
        profile_v2: false,
      },
    });

    await shell.sendChatEnvelope({ assistant_message: { content: 'hello' }, cards: [], events: [], session_patch: {} }, 201);

    expect(syncGatePolicyMeta).toHaveBeenCalled();
    expect(chatRouteDeliveryShellRuntime.sendChatEnvelope).toHaveBeenCalledWith({
      routeState,
      envelope: { assistant_message: { content: 'hello' }, cards: [], events: [], session_patch: {} },
      statusCode: 201,
      res,
      req,
      ctx: shell.ctx,
      templateCtx: shell.templateCtx,
      chatSessionId: 'dogfood:session_1',
      policyMeta,
      rolloutContext: {
        effective_flags: {
          chat_response_meta: false,
          profile_v2: false,
        },
        variant: 'control',
      },
      shouldAttachPolicyMeta: false,
    });
  });

  test('builds invalid request envelope through the shared shell owner', () => {
    const { runtime, buildEnvelope, makeAssistantMessage, makeEvent, req, res } = buildRuntime();
    const shell = runtime.createChatRouteRequestShell({
      req,
      res,
      rawBody: {},
    });

    const envelope = shell.buildInvalidRequestEnvelope({
      parsedError: {
        format: () => ({ payload: { _errors: ['bad'] } }),
      },
    });

    expect(makeAssistantMessage).toHaveBeenCalledWith('Invalid request.');
    expect(makeEvent).toHaveBeenCalledWith(shell.ctx, 'error', { code: 'BAD_REQUEST' });
    expect(buildEnvelope).toHaveBeenCalledWith(
      shell.ctx,
      expect.objectContaining({
        assistant_message: { role: 'assistant', content: 'Invalid request.' },
      }),
    );
    expect(envelope.cards[0]).toEqual({
      card_id: `err_${shell.ctx.request_id}`,
      type: 'error',
      payload: {
        error: 'BAD_REQUEST',
        details: { payload: { _errors: ['bad'] } },
      },
    });
  });
});

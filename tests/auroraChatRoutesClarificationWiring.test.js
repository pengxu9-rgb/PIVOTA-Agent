const { z } = require('zod');

const createChatRouteRuntimeBundle = jest.fn();

jest.mock('../src/auroraBff/bootstrapChatRouteRuntime', () => ({
  createChatRouteRuntimeBundle: (...args) => createChatRouteRuntimeBundle(...args),
}));

const { mountChatRoutes } = require('../src/auroraBff/routes/chatRoutes');

describe('mountChatRoutes clarification wiring', () => {
  test('forwards clarification-flow runtime dependencies into the turn pipeline', async () => {
    const prepareChatRouteTurn = jest.fn(async () => ({
      message: 'hello',
      actionId: 'chip.clarify.skin_type.Oily',
      clarificationId: 'skin_type',
      actionReplyText: 'Oily',
      normalizedActionPayload: {
        action_id: 'chip.clarify.skin_type.Oily',
        kind: 'chip',
        data: {
          clarification_id: 'skin_type',
        },
      },
      appliedProfilePatch: null,
      makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
      canonicalIntent: { intent: 'unknown', confidence: 0, entities: {} },
      hasPlannerAnchor: false,
      debugUpstream: false,
      anchorProductId: '',
      anchorProductUrl: '',
      identity: { auroraUid: 'uid_1' },
      includeAlternatives: false,
      latestRecoContextFromSession: null,
      textDerivedProfilePatch: null,
      textDerivedSkinLog: null,
      llmProvider: '',
      llmModel: '',
      upstreamMessages: null,
      profilePatchFromSession: null,
    }));
    const resolveChatTurnPipeline = jest.fn(async () => ({
      envelope: {
        assistant_message: { role: 'assistant', content: 'ok' },
        cards: [],
        events: [],
        session_patch: {},
      },
    }));
    const createChatRouteRequestShell = jest.fn(() => {
      const shell = {
        ctx: {
          request_id: 'req_1',
          trace_id: 'trace_1',
          lang: 'EN',
          trigger_source: 'chip',
        },
        templateCtx: {
          accept_language: 'en-US',
        },
        routeState: {
          profile: null,
          pendingSafetyAdvisory: null,
          requestMessage: '',
          ingredientReplayContext: null,
          skipRoutineRulesFallback: false,
          recentLogs: [],
          chatContext: null,
        },
        effectiveChatFlags: {},
        policyMeta: {},
        pushGateDecision: jest.fn(),
        summarizeChatProfileForContext: jest.fn(() => ({})),
        enqueueGateAdvisory: jest.fn(),
        buildInvalidRequestEnvelope: jest.fn(),
        applyPreparedTurn: jest.fn(),
        sendChatEnvelope: jest.fn(async () => ({ ok: true })),
      };
      return shell;
    });
    const applyTurnPipelineResult = jest.fn();

    createChatRouteRuntimeBundle.mockReturnValue({
      chatDiagnosisGateRuntime: {},
      chatRouteDeliveryShellRuntime: {
        applyTurnPipelineResult,
      },
      chatRouteRequestShellRuntime: {
        createChatRouteRequestShell,
      },
      chatRouteTurnSetupRuntime: {
        prepareChatRouteTurn,
      },
      chatSafetyRuntime: {},
      chatTurnPipelineRuntime: {
        resolveChatTurnPipeline,
      },
    });

    const app = { post: jest.fn() };
    const deps = {
      V1ChatRequestSchema: z
        .object({
          action: z.any().optional(),
          session: z.any().optional(),
          language: z.string().optional(),
        })
        .strict(),
      INTENT_ENUM: { UNKNOWN: 'unknown' },
      makeEvent: jest.fn(() => ({ event_name: 'ok' })),
      logger: { error: jest.fn() },
      requireAuroraUid: jest.fn(),
      buildEnvelope: jest.fn((ctx, payload) => ({ request_id: ctx.request_id, ...payload })),
      makeAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
      profileCompleteness: jest.fn(),
      buildDiagnosisPrompt: jest.fn(),
      buildDiagnosisChips: jest.fn(),
      stateChangeAllowed: jest.fn(),
      normalizeIngredientActionId: jest.fn(),
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH_ENABLED: true,
      AURORA_CHAT_CLARIFICATION_FLOW_V2_ENABLED: true,
      AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED: true,
      INGREDIENT_ROUTE_RULE_VERSION: 'v1',
      getPendingClarification: jest.fn(() => ({ pending: { v: 1 }, upgraded: false })),
      recordPendingClarificationAbandoned: jest.fn(),
      recordSessionPatchProfileEmitted: jest.fn(),
      buildChipsForQuestion: jest.fn(() => []),
      recordAuroraChatSkipped: jest.fn(),
      recordPendingClarificationStep: jest.fn(),
      recordPendingClarificationCompleted: jest.fn(),
    };

    mountChatRoutes(app, deps);

    const handler = app.post.mock.calls[0][1];
    const req = {
      body: {
        action: {
          action_id: 'chip.clarify.skin_type.Oily',
          kind: 'chip',
          data: {
            clarification_id: 'skin_type',
          },
        },
        session: {
          state: {
            pending_clarification: { v: 1 },
          },
        },
        language: 'EN',
      },
    };
    const res = {};

    await handler(req, res);

    expect(resolveChatTurnPipeline).toHaveBeenCalledTimes(1);
    const pipelineArgs = resolveChatTurnPipeline.mock.calls[0][0];
    expect(pipelineArgs.recordPendingClarificationAbandoned).toBe(
      deps.recordPendingClarificationAbandoned,
    );
    expect(pipelineArgs.recordSessionPatchProfileEmitted).toBe(
      deps.recordSessionPatchProfileEmitted,
    );
    expect(pipelineArgs.buildChipsForQuestion).toBe(deps.buildChipsForQuestion);
    expect(pipelineArgs.recordAuroraChatSkipped).toBe(deps.recordAuroraChatSkipped);
    expect(pipelineArgs.recordPendingClarificationStep).toBe(
      deps.recordPendingClarificationStep,
    );
    expect(pipelineArgs.recordPendingClarificationCompleted).toBe(
      deps.recordPendingClarificationCompleted,
    );
    expect(pipelineArgs.getPendingClarification).toBe(deps.getPendingClarification);
    expect(pipelineArgs.AURORA_CHAT_CLARIFICATION_HISTORY_CONTEXT_ENABLED).toBe(true);
  });
});

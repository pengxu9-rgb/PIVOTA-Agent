const { createChatDeliveryRuntime } = require('../src/auroraBff/chatDeliveryRuntime');

function buildRuntime(overrides = {}) {
  const res = {
    json: jest.fn((payload) => ({ kind: 'json', payload })),
    status: jest.fn(function setStatus(code) {
      return {
        json: jest.fn((payload) => ({ kind: 'status_json', code, payload })),
      };
    }),
  };

  const deps = {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
    chatAdvisoryRuntime: {
      applyPendingSafetyAdvisoryToEnvelope: jest.fn(({ envelope }) => ({
        ...envelope,
        meta: { ...(envelope.meta || {}), safety_advisory_applied: true },
      })),
      applyPendingGateAdvisoriesToEnvelope: jest.fn(({ envelope }) => ({
        ...envelope,
        meta: { ...(envelope.meta || {}), gate_advisory_applied: true },
      })),
    },
    chatEnvelopeMetaRuntime: {
      applyLlmMetaToEnvelope: jest.fn(({ envelope }) => ({
        ...envelope,
        meta: { ...(envelope.meta || {}), llm_meta_applied: true },
      })),
      applyPendingPregnancyPolicyEventsToEnvelope: jest.fn(({ envelope }) => ({
        ...envelope,
        meta: { ...(envelope.meta || {}), pregnancy_events_applied: true },
      })),
      applyRecommendationMetaToEnvelope: jest.fn(({ envelope }) => ({
        envelope: {
          ...envelope,
          recommendation_meta: { source_mode: 'catalog_grounded' },
        },
        recoContextMetricsEmitted: true,
      })),
    },
    chatResponseRuntime: {
      applyPolicyMetaToEnvelope: jest.fn(({ envelope }) => ({
        ...envelope,
        meta: { ...(envelope.meta || {}), policy_meta_applied: true },
      })),
      applyRolloutHeaders: jest.fn(),
      prepareEnvelopeForDelivery: jest.fn(({ envelope }) => ({
        ...envelope,
        meta: { ...(envelope.meta || {}), delivery_prepared: true },
      })),
    },
    chatContextRuntime: {
      updateChatContextFromEnvelope: jest.fn(() => ({
        chatContext: { active_thread_summary: 'updated summary' },
        threadOps: [{ op: 'thread_update' }],
      })),
      collectTelemetryEntities: jest.fn(() => [{ key: 'brand', value: 'example' }]),
      collectLegacyCardTypes: jest.fn(() => ['recommendations']),
      inferGateFromLegacyCardTypes: jest.fn(() => 'none'),
      extractNextStateFromEnvelope: jest.fn(() => 'RECO_RESULTS'),
    },
    chatIngredientReplayRuntime: {
      processIngredientReplay: jest.fn(({ ingredientReplayContext }) => ({
        ingredientReplayContext: {
          ...(ingredientReplayContext || {}),
          delivered: true,
        },
      })),
    },
    safelyApplyProductIntelGuardrailsToEnvelope: jest.fn(async ({ envelope }) => ({
      envelope: {
        ...envelope,
        cards: [...(Array.isArray(envelope.cards) ? envelope.cards : []), { type: 'guardrail_card' }],
      },
      failed: false,
      rejected: [],
      dropped: 0,
      externalized: 0,
    })),
    persistRejectedCatalogCandidates: jest.fn(),
    suppressAnalysisCardsForTravelEnvTurn: jest.fn((cards) => cards),
    executeAuroraOptionalStep: jest.fn(async ({ fn }) => fn()),
    upsertChatContextForIdentity: jest.fn(async () => {}),
    enrichIngredientReportCardsInEnvelope: jest.fn((envelope) => ({
      ...envelope,
      cards: [...(Array.isArray(envelope.cards) ? envelope.cards : []), { type: 'ingredient_report' }],
    })),
    buildChatCardsResponse: jest.fn(() => ({
      cards: [{ type: 'chat_card' }],
      ops: { experiment_events: [{ event_name: 'exp_1' }] },
    })),
    appendExperimentEventForIdentity: jest.fn(async () => {}),
    emitAudit: jest.fn(),
    makeEvent: jest.fn((ctx, event_name, event_data) => ({
      event_name,
      event_data,
      request_id: ctx && ctx.request_id ? ctx.request_id : null,
    })),
    AURORA_CHAT_LEGACY_ENVELOPE_RESPONSE: false,
    INTENT_ENUM: {
      UNKNOWN: 'unknown',
    },
    ...overrides,
  };

  return {
    deps,
    res,
    runtime: createChatDeliveryRuntime(deps),
  };
}

describe('aurora chat delivery runtime', () => {
  test('delivers chat response and returns updated runtime state', async () => {
    const { runtime, deps, res } = buildRuntime();

    const out = await runtime.deliverChatEnvelope({
      envelope: {
        assistant_message: { content: 'hello' },
        cards: [{ type: 'recommendations' }],
        events: [],
        session_patch: {},
      },
      statusCode: 200,
      res,
      req: {},
      ctx: { request_id: 'req_delivery', trace_id: 'trace_delivery', lang: 'EN' },
      templateCtx: {},
      chatSessionId: 'chat_session_1',
      requestMessage: 'recommend something',
      profile: { skinType: 'dry' },
      recentLogs: [{ id: 'log_1' }],
      policyMeta: { intent_canonical: 'reco_products' },
      canonicalIntentForResponse: { intent: 'reco_products', confidence: 0.9, entities: { brand: 'Example' } },
      skipRoutineRulesFallback: false,
      rolloutContext: { variant: 'beta' },
      shouldAttachPolicyMeta: true,
      plannerSessionStatePatch: { budget_tier: 'low' },
      latestClarificationId: 'clarify_1',
      llmRouteMetaForResponse: { llm_provider_effective: 'gemini' },
      pendingSafetyAdvisory: { reason: 'warn' },
      pendingGateAdvisories: [{ gate_id: 'diag_gate' }],
      pendingPregnancyPolicyEvents: [{ event_name: 'pregnancy_status_defaulted' }],
      recoContextMetricsEmitted: false,
      safetyDecision: { block_level: 'warn' },
      chatContext: { active_thread_summary: 'old summary' },
      resolvedIdentity: { auroraUid: 'uid_1', userId: null },
      ingredientReplayContext: { delivered: false },
      actionIdForReplay: 'chip.start.reco_products',
      clientStateForReplay: 'IDLE_CHAT',
      agentStateForReplay: 'RECO_RESULTS',
    });

    expect(res.json).toHaveBeenCalledWith({
      cards: [{ type: 'chat_card' }],
      ops: { experiment_events: [{ event_name: 'exp_1' }] },
    });
    expect(out.chatContext).toEqual({ active_thread_summary: 'updated summary' });
    expect(out.ingredientReplayContext).toEqual({ delivered: true });
    expect(out.recoContextMetricsEmitted).toBe(true);
    expect(deps.upsertChatContextForIdentity).toHaveBeenCalledWith(
      { auroraUid: 'uid_1', userId: null },
      { active_thread_summary: 'updated summary' },
    );
    expect(deps.appendExperimentEventForIdentity).toHaveBeenCalledWith(
      { auroraUid: 'uid_1', userId: null },
      { event_name: 'exp_1' },
    );
    expect(deps.buildChatCardsResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'reco_products',
        entities: [{ key: 'brand', value: 'example' }],
        threadOps: [{ op: 'thread_update' }],
      }),
    );
  });

  test('applies guardrail diagnostics and persists rejected candidates in legacy envelope mode', async () => {
    const { runtime, deps, res } = buildRuntime({
      AURORA_CHAT_LEGACY_ENVELOPE_RESPONSE: true,
      safelyApplyProductIntelGuardrailsToEnvelope: jest.fn(async ({ envelope }) => ({
        envelope: {
          ...envelope,
          cards: [{ type: 'recommendations' }],
          events: [],
        },
        failed: true,
        error_code: 'GUARDRAIL_FAILSAFE',
        rejected: [{ product_id: 'p_1' }],
        dropped: 2,
        externalized: 1,
      })),
      buildChatCardsResponse: jest.fn(() => ({ cards: [] })),
      enrichIngredientReportCardsInEnvelope: jest.fn((envelope) => envelope),
    });

    await runtime.deliverChatEnvelope({
      envelope: {
        assistant_message: { content: 'hello' },
        cards: [{ type: 'recommendations' }],
        events: [],
        session_patch: {},
      },
      statusCode: 200,
      res,
      req: {},
      ctx: { request_id: 'req_guardrail', trace_id: 'trace_guardrail', lang: 'EN' },
      templateCtx: {},
      chatSessionId: 'chat_session_2',
      requestMessage: 'recommend something',
      profile: {},
      recentLogs: [],
      policyMeta: { intent_canonical: 'reco_products' },
      canonicalIntentForResponse: { intent: 'reco_products', confidence: 0.8, entities: {} },
    });

    const deliveredEnvelope = res.json.mock.calls[0][0];
    expect(deliveredEnvelope.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_name: 'product_intel_guardrail_applied',
          event_data: expect.objectContaining({
            dropped_count: 2,
            externalized_count: 1,
          }),
        }),
      ]),
    );
    expect(deps.persistRejectedCatalogCandidates).toHaveBeenCalledWith(
      { request_id: 'req_guardrail', trace_id: 'trace_guardrail', lang: 'EN' },
      [{ product_id: 'p_1' }],
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_guardrail',
        error_code: 'GUARDRAIL_FAILSAFE',
      }),
      'aurora bff: product-intel guardrail failed, fallback envelope used',
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        dropped_count: 2,
        externalized_count: 1,
      }),
      'aurora bff: product-intel guardrail applied',
    );
  });

  test('uses status response path for error envelopes', async () => {
    const statusJson = jest.fn((payload) => ({ kind: 'status_json', payload }));
    const res = {
      json: jest.fn(),
      status: jest.fn(() => ({ json: statusJson })),
    };
    const { runtime } = buildRuntime();

    await runtime.deliverChatEnvelope({
      envelope: {
        assistant_message: { content: 'bad request' },
        cards: [],
        events: [],
        session_patch: {},
      },
      statusCode: 400,
      res,
      req: {},
      ctx: { request_id: 'req_400', trace_id: 'trace_400', lang: 'EN' },
      templateCtx: {},
      chatSessionId: 'chat_session_3',
      requestMessage: 'bad request',
      profile: {},
      recentLogs: [],
      policyMeta: { intent_canonical: 'unknown' },
      canonicalIntentForResponse: { intent: 'unknown', confidence: 0, entities: {} },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(statusJson).toHaveBeenCalledWith({
      cards: [{ type: 'chat_card' }],
      ops: { experiment_events: [{ event_name: 'exp_1' }] },
    });
  });
});

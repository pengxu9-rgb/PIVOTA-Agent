const { createChatIngredientLookupRuntime } = require('../src/auroraBff/chatIngredientLookupRuntime');

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const trimmed = String(value || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIngredientRecoContextValue(raw) {
  if (!isPlainObject(raw)) return null;
  const out = {};
  const query = pickFirstTrimmed(raw.query);
  const goal = pickFirstTrimmed(raw.goal);
  const sensitivity = pickFirstTrimmed(raw.sensitivity);
  const source = pickFirstTrimmed(raw.source);
  if (query) out.query = query;
  if (goal) out.goal = goal;
  if (sensitivity) out.sensitivity = sensitivity;
  if (source) out.source = source;
  if (Number.isFinite(Number(raw.updated_at_ms))) out.updated_at_ms = Number(raw.updated_at_ms);
  return Object.keys(out).length ? out : null;
}

function mergeIngredientRecoContextValue(base, patch) {
  const left = normalizeIngredientRecoContextValue(base) || {};
  const right = normalizeIngredientRecoContextValue(patch) || {};
  const merged = { ...left, ...right };
  return Object.keys(merged).length ? merged : null;
}

function buildHarness(overrides = {}) {
  const recordAuroraIngredientsFlowMetric = jest.fn();
  const buildEnvelope = jest.fn((_ctx, payload) => payload);
  const makeChatAssistantMessage = jest.fn((content) => ({ content }));
  const makeEvent = jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data }));

  const runtime = createChatIngredientLookupRuntime({
    logger: null,
    isPlainObject,
    pickFirstTrimmed,
    normalizeIngredientRecoContextValue,
    mergeIngredientRecoContextValue,
    ingredientEntityMatchFromText: jest.fn(() => ({
      entity_match_type: 'canonical',
      entity_confidence: 0.91,
    })),
    resolveIngredientReferenceRuntimeMatch: jest.fn(async () => null),
    resolveIngredientSignalRuntimeMatch: jest.fn(async () => null),
    shouldPreferSignalRuntimeMatch: jest.fn(() => false),
    normalizeIngredientResearchKey: jest.fn((value) => String(value || '').trim().toLowerCase()),
    checkIngredientLookupRateLimit: jest.fn(() => ({ blocked: false, reason: '' })),
    getIngredientResearchCache: jest.fn(() => ({
      status: 'ready',
      provider: 'kb',
      provider_model_tier: 'flash',
      provider_circuit_state: 'closed',
      updated_at_ms: 123,
      what_it_is: 'A barrier-supporting active.',
      kb_revision: '7',
    })),
    getIngredientResearchKbEntry: jest.fn(async () => null),
    touchIngredientResearchCache: jest.fn(),
    INGREDIENT_ROUTE_V2_ENABLED: true,
    INGREDIENT_LEGACY_PATH_ENABLED: false,
    AURORA_INGREDIENT_LLM_REPORT_ENABLED: true,
    runIngredientResearchSync: jest.fn(async () => null),
    asResearchObject: jest.fn((value) => value),
    getIngredientProviderCircuitState: jest.fn(() => 'closed'),
    INGREDIENT_KB_ONLY_MODE: false,
    enqueueIngredientResearchJob: jest.fn(() => null),
    buildIngredientReportPayload: jest.fn(({ query, meta }) => ({
      research_status: 'ready',
      ingredient: { display_name: query },
      meta,
      kb_revision: '7',
    })),
    stateChangeAllowed: jest.fn(() => true),
    buildIngredientReportQuickReplyChips: jest.fn(() => [{ chip_id: 'chip.ingredient.followup' }]),
    recordAuroraIngredientsFlowMetric,
    INGREDIENT_ROUTE_RULE_VERSION: 'ingredient_route_v1',
    ...overrides,
  });

  return {
    runtime,
    recordAuroraIngredientsFlowMetric,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
  };
}

describe('aurora chat ingredient lookup runtime', () => {
  test('attaches route metadata into session patch', () => {
    const { runtime } = buildHarness();

    const patch = runtime.attachIngredientRouteMetaToSessionPatch(
      { next_state: 'S2_DIAGNOSIS' },
      {
        queryFirstApplied: true,
        routeSource: 'text',
        normalizedQuery: 'niacinamide',
        entityMatchType: 'canonical',
        entityConfidence: 1.4,
        routeDecisionReasons: ['text_query_routed', '', 'entity_canonical_match'],
        routeRuleVersion: 'ingredient_route_v1',
      },
    );

    expect(patch).toEqual({
      next_state: 'S2_DIAGNOSIS',
      meta: {
        ingredient_query_first_applied: true,
        ingredient_route_source: 'text',
        normalized_query: 'niacinamide',
        entity_match_type: 'canonical',
        entity_confidence: 1,
        route_decision_reasons: ['text_query_routed', 'entity_canonical_match'],
        route_rule_version: 'ingredient_route_v1',
      },
    });
  });

  test('builds ingredient report envelope with session patch metadata and kb events', async () => {
    const { runtime, recordAuroraIngredientsFlowMetric, buildEnvelope, makeChatAssistantMessage, makeEvent } = buildHarness();

    const envelope = await runtime.buildIngredientLookupEnvelope({
      ctx: {
        lang: 'EN',
        request_id: 'req_ing_lookup',
        trigger_source: 'user',
        state: 'IDLE',
        aurora_uid: 'uid_1',
        trace_id: 'trace_1',
      },
      req: { ip: '127.0.0.1', headers: {} },
      identity: { auroraUid: 'uid_1' },
      profile: { skinType: 'dry', sensitivity: 'low', goals: ['barrier'] },
      ingredientRecoContext: { goal: 'barrier', sensitivity: 'low' },
      ingredientGoalRequest: { goal: '', sensitivity: '' },
      nextStateOverride: 'S2_DIAGNOSIS',
      lookupTarget: 'Niacinamide',
      routeSource: 'text',
      queryFirstApplied: true,
      reasonTag: 'ingredient_text_lookup_report',
      explicitRouteReasons: ['text_query_routed'],
      buildEnvelope,
      makeChatAssistantMessage,
      makeEvent,
    });

    expect(makeChatAssistantMessage).toHaveBeenCalledWith(
      'I generated a 1-minute ingredient report for Niacinamide.',
    );
    expect(recordAuroraIngredientsFlowMetric).toHaveBeenCalledWith({ stage: 'kb_hit', hit: true });
    expect(envelope.cards).toEqual([
      {
        card_id: 'ingredient_report_req_ing_lookup',
        type: 'aurora_ingredient_report',
        payload: expect.objectContaining({
          research_status: 'ready',
          ingredient: { display_name: 'Niacinamide' },
        }),
      },
    ]);
    expect(envelope.suggested_chips).toEqual([{ chip_id: 'chip.ingredient.followup' }]);
    expect(envelope.session_patch).toEqual({
      next_state: 'S2_DIAGNOSIS',
      meta: expect.objectContaining({
        ingredient_query_first_applied: true,
        ingredient_route_source: 'text',
        normalized_query: 'niacinamide',
        entity_match_type: 'canonical',
        route_rule_version: 'ingredient_route_v1',
        ingredient_context: expect.objectContaining({
          query: 'Niacinamide',
          goal: 'barrier',
          sensitivity: 'low',
          source: 'text_lookup',
        }),
      }),
    });
    expect(envelope.events).toEqual([
      {
        event_name: 'ingredient_kb_hit',
        data: { query: 'Niacinamide', normalized_query: 'niacinamide' },
      },
      {
        event_name: 'state_entered',
        data: { next_state: 'IDLE', reason: 'ingredient_text_lookup_report' },
      },
      {
        event_name: 'ingredient_kb_updated',
        data: { ingredient_query: 'Niacinamide', normalized_query: 'niacinamide', revision: '7' },
      },
    ]);
    expect(buildEnvelope).toHaveBeenCalledTimes(1);
    expect(makeEvent).toHaveBeenCalledTimes(3);
  });
});

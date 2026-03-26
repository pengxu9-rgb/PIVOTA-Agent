const { createChatIngredientEntryRuntime } = require('../src/auroraBff/chatIngredientEntryRuntime');

function pickFirstTrimmed(...values) {
  for (const value of values) {
    const trimmed = String(value || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeIngredientRecoContextValue(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
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
  if (Array.isArray(raw.candidates)) {
    out.candidates = raw.candidates.map((value) => String(value || '').trim()).filter(Boolean);
  }
  return Object.keys(out).length ? out : null;
}

function mergeIngredientRecoContextValue(base, patch) {
  const left = normalizeIngredientRecoContextValue(base) || {};
  const right = normalizeIngredientRecoContextValue(patch) || {};
  const merged = { ...left, ...right };
  return Object.keys(merged).length ? merged : null;
}

function buildHarness(overrides = {}) {
  const buildIngredientLookupEnvelope = jest.fn(async ({ lookupTarget, reasonTag, routeSource, queryFirstApplied }) => ({
    type: 'lookup_envelope',
    lookupTarget,
    reasonTag,
    routeSource,
    queryFirstApplied,
  }));
  const attachIngredientRouteMetaToSessionPatch = jest.fn((patch, meta) => ({
    ...patch,
    meta: { ...(patch.meta || {}), routeMeta: meta },
  }));
  const attachIngredientContextMetaToSessionPatch = jest.fn((patch, context) => ({
    ...patch,
    meta: { ...(patch.meta || {}), ingredientContext: context },
  }));

  const runtime = createChatIngredientEntryRuntime({
    logger: null,
    pickFirstTrimmed,
    mergeIngredientRecoContextValue,
    buildIngredientHubCardPayload: jest.fn(({ language }) => ({ language, hub: true })),
    buildIngredientHubQuickReplyChips: jest.fn(({ language }) => [{ chip_id: `hub_${language}` }]),
    buildIngredientGoalMatchPayload: jest.fn(({ language, goal, sensitivity }) => ({
      language,
      goal,
      sensitivity,
    })),
    enrichIngredientGoalMatchPayload: jest.fn(async ({ basePayload, goal }) => ({
      ...basePayload,
      goal_label: goal === 'barrier' ? 'Barrier support' : goal,
      candidate_ingredients: [{ ingredient: 'Niacinamide' }, { name: 'Ceramide NP' }],
    })),
    buildIngredientScienceKickoff: jest.fn(({ language }) => ({
      prompt: language === 'CN' ? '请告诉我你想研究哪个成分。' : 'Tell me which ingredient you want to research.',
      chips: [{ chip_id: `science_${language}` }],
    })),
    stateChangeAllowed: jest.fn(() => true),
    recordAuroraIngredientsFlowMetric: jest.fn(),
    chatIngredientLookupRuntime: {
      buildIngredientLookupEnvelope,
      attachIngredientRouteMetaToSessionPatch,
      attachIngredientContextMetaToSessionPatch,
    },
    ...overrides,
  });

  return {
    runtime,
    buildIngredientLookupEnvelope,
    attachIngredientRouteMetaToSessionPatch,
    attachIngredientContextMetaToSessionPatch,
  };
}

function buildArgs(overrides = {}) {
  return {
    ctx: {
      request_id: 'req_ing_entry_1',
      lang: 'EN',
      trigger_source: 'text',
      state: 'IDLE_CHAT',
    },
    req: { headers: {}, ip: '127.0.0.1' },
    identity: { auroraUid: 'aur_1' },
    profile: { skinType: 'dry' },
    ingredientRecoContext: { goal: 'barrier', sensitivity: 'low', source: 'seed' },
    ingredientGoalRequest: { goal: 'barrier', sensitivity: 'low' },
    nextStateOverride: 'S2_DIAGNOSIS',
    message: '',
    ingredientEntryRequested: false,
    ingredientByGoalRequested: false,
    ingredientLookupRequested: false,
    ingredientResearchPollRequested: false,
    ingredientTextQueryFirstEligible: false,
    shouldKickoffIngredientScience: false,
    ingredientScienceIntentEffective: false,
    ingredientTextTrigger: false,
    ingredientRouteDecisionReasons: ['ingredient_intent'],
    ingredientLookupQuery: '',
    ingredientLookupTargetFromText: '',
    ingredientEntityMatch: { entity_match_type: 'canonical' },
    ingredientActionData: null,
    buildEnvelope: jest.fn((_ctx, payload) => payload),
    makeChatAssistantMessage: jest.fn((content) => ({ role: 'assistant', content })),
    makeEvent: jest.fn((_ctx, eventName, data) => ({ event_name: eventName, data })),
    buildSafetyNoticeText: jest.fn(() => 'Safety notice'),
    safetyDecision: null,
    INGREDIENT_ROUTE_RULE_VERSION: 'ingredient_route_v1',
    ...overrides,
  };
}

describe('aurora chat ingredient entry runtime', () => {
  test('returns ingredient hub envelope for entry action', async () => {
    const { runtime } = buildHarness();

    const out = await runtime.resolveIngredientEntryEnvelope(buildArgs({
      ingredientEntryRequested: true,
    }));

    expect(out.handled).toBe(true);
    expect(out.requestMessage).toBe('ingredient_hub_entry');
    expect(out.envelope.cards).toEqual([
      {
        card_id: 'ingredient_hub_req_ing_entry_1',
        type: 'ingredient_hub',
        payload: { language: 'EN', hub: true },
      },
    ]);
    expect(out.envelope.session_patch).toEqual(
      expect.objectContaining({
        next_state: 'S2_DIAGNOSIS',
        meta: expect.objectContaining({
          routeMeta: expect.objectContaining({
            routeSource: 'chip',
            routeRuleVersion: 'ingredient_route_v1',
          }),
        }),
      }),
    );
  });

  test('returns goal match envelope and updates ingredient context', async () => {
    const { runtime } = buildHarness();

    const out = await runtime.resolveIngredientEntryEnvelope(buildArgs({
      ingredientByGoalRequested: true,
      ingredientTextTrigger: true,
    }));

    expect(out.handled).toBe(true);
    expect(out.requestMessage).toBe('ingredient_goal_match');
    expect(out.ingredientRecoContext).toEqual(
      expect.objectContaining({
        goal: 'barrier',
        sensitivity: 'low',
        source: 'text_goal',
        candidates: ['Niacinamide', 'Ceramide NP'],
      }),
    );
    expect(out.envelope.cards[0]).toEqual(
      expect.objectContaining({
        type: 'ingredient_goal_match',
        payload: expect.objectContaining({
          goal_label: 'Barrier support',
        }),
      }),
    );
  });

  test('delegates text query-first target to ingredient lookup runtime', async () => {
    const { runtime, buildIngredientLookupEnvelope } = buildHarness();

    const out = await runtime.resolveIngredientEntryEnvelope(buildArgs({
      message: 'Tell me about niacinamide',
      ingredientTextTrigger: true,
      ingredientTextQueryFirstEligible: true,
      ingredientLookupTargetFromText: 'Niacinamide',
      ingredientEntityMatch: { entity_match_type: 'none' },
    }));

    expect(out.handled).toBe(true);
    expect(out.requestMessage).toBe('ingredient_text_lookup_report');
    expect(buildIngredientLookupEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        lookupTarget: 'Niacinamide',
        routeSource: 'text',
        queryFirstApplied: true,
        reasonTag: 'ingredient_text_lookup_report',
        explicitRouteReasons: expect.arrayContaining(['text_query_routed', 'entity_fallback_from_text']),
      }),
    );
    expect(out.envelope).toEqual(
      expect.objectContaining({
        type: 'lookup_envelope',
        lookupTarget: 'Niacinamide',
      }),
    );
  });

  test('returns science kickoff prompt with warn safety prefix', async () => {
    const { runtime } = buildHarness();

    const out = await runtime.resolveIngredientEntryEnvelope(buildArgs({
      shouldKickoffIngredientScience: true,
      ingredientScienceIntentEffective: true,
      safetyDecision: { block_level: 'warn' },
      buildSafetyNoticeText: jest.fn(() => 'Safety notice'),
    }));

    expect(out.handled).toBe(true);
    expect(out.envelope.assistant_message.content).toContain('Safety notice');
    expect(out.envelope.assistant_message.content).toContain('Tell me which ingredient you want to research.');
    expect(out.envelope.suggested_chips).toEqual([{ chip_id: 'science_EN' }]);
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_RECO_CATALOG_GROUNDED = 'true';
process.env.AURORA_CHATCARDS_RESPONSE_CONTRACT = 'dual';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'test_key';
process.env.AURORA_PRODUCT_MATCHER_ENABLED = 'false';
process.env.AURORA_INGREDIENT_PLAN_ENABLED = 'false';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.AURORA_BFF_RECO_STEP_AWARE_CATALOG_FIRST_ENABLED = 'true';
process.env.AURORA_BFF_RECO_CENTRALIZED_FAILURE_MAPPING_ENABLED = 'true';
process.env.AURORA_BFF_RECO_STEP_AWARE_SHADOW_COMPARE_ENABLED = 'false';
process.env.AURORA_PURCHASABLE_FALLBACK_ENABLED = 'true';
process.env.AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED = 'true';

const axios = require('axios');
const dbModule = require('../src/db');
const diagnosisArtifactStore = require('../src/auroraBff/diagnosisArtifactStore');
const {
  createBeautyChatMainlineEntryRuntime,
} = require('../src/auroraBff/beautyChatMainlineEntry');
const {
  buildSupportRoleQueryVariants,
} = require('../src/auroraBff/recoSupportRoleQueries');
const ROUTES_MODULE_PATH = require.resolve('../src/auroraBff/routes');
const AURORA_DECISION_CLIENT_MODULE_PATH = require.resolve('../src/auroraBff/auroraDecisionClient');
const { saveDiagnosisArtifact } = require('../src/auroraBff/diagnosisArtifactStore');
const {
  createAppWithPatchedAuroraChat: createBaseAppWithPatchedAuroraChat,
  headersFor,
  seedCompleteProfile,
} = require('./aurora_bff_test_harness.cjs');

const staleFallbackPlannerTest =
  process.env.AURORA_RUN_STALE_FALLBACK_PLANNER_TESTS === 'true' ? test : test.skip;

function loadRoutesFresh() {
  delete require.cache[AURORA_DECISION_CLIENT_MODULE_PATH];
  delete require.cache[ROUTES_MODULE_PATH];
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require('../src/auroraBff/routes');
}

async function seedHighConfidenceArtifactForReco({
  auroraUid,
  briefId = 'test_brief',
  userId = null,
} = {}) {
  return saveDiagnosisArtifact({
    auroraUid,
    userId,
    sessionId: briefId,
    artifact: {
      overall_confidence: { score: 0.92, level: 'high' },
      skinType: { value: 'dry' },
      sensitivity: { value: 'low' },
      barrierStatus: { value: 'stable' },
      goals: { values: ['barrier repair'] },
    },
  });
}

function isProductsSearchUrl(url) {
  const target = String(url || '');
  return target.includes('/agent/v1/products/search') || target.includes('/agent/v1/beauty/products/search');
}

async function invokeRoute(app, method, routePath, { headers = {}, body = {}, query = {} } = {}) {
  const lowerMethod = String(method || '').toLowerCase();
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  const layer = stack.find((entry) => entry && entry.route && entry.route.path === routePath && entry.route.methods && entry.route.methods[lowerMethod]);
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

  const req = {
    method: String(method || '').toUpperCase(),
    path: routePath,
    body,
    query,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    get(name) {
      return this.headers[String(name || '').toLowerCase()] || '';
    },
  };

  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    setHeader() {},
    header() { return this; },
  };

  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((entry) => entry.handle).filter(Boolean) : [];
  for (const handler of handlers) {
    // eslint-disable-next-line no-await-in-loop
    await handler(req, res, () => {});
    if (res.headersSent) break;
  }
  return { status: res.statusCode, body: res.body };
}

function getRecommendationsPayload(responseBody) {
  const cards = Array.isArray(responseBody?.cards) ? responseBody.cards : [];
  const recoCard = cards.find((card) => card && card.type === 'recommendations') || null;
  return recoCard && recoCard.payload && typeof recoCard.payload === 'object' ? recoCard.payload : null;
}

test('__internal: support role query builder keeps finish-fit sunscreen recall to the top three precise variants', () => {
  const queries = buildSupportRoleQueryVariants({
    roleId: 'daily_sunscreen_finish_fit',
    roleLabel: 'Daily sunscreen finish fit',
    preferredStep: 'sunscreen',
    queryTerms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
    fitKeywords: ['under makeup', 'lightweight', 'non-greasy', 'fluid'],
    semanticFamily: 'sunscreen',
    concernText: 'makeup pilling during the day',
    maxQueries: 4,
  });

  assert.deepEqual(queries, [
    'spf fluid oily skin',
    'sunscreen under makeup',
    'lightweight sunscreen oily skin',
  ]);
  assert.equal(queries.includes('oil control sunscreen'), false);
  assert.equal(queries.includes('makeup friendly sunscreen'), false);
});

test('__internal: support role query builder keeps generic daily sunscreen support compact at runtime', () => {
  const queries = buildSupportRoleQueryVariants({
    roleId: 'daily_sunscreen',
    roleLabel: 'Daily sunscreen',
    preferredStep: 'sunscreen',
    queryTerms: ['spf fluid oily skin', 'lightweight sunscreen oily skin', 'oil control sunscreen'],
    fitKeywords: ['spf', 'lightweight', 'oil control', 'non-greasy'],
    semanticFamily: 'sunscreen',
    concernText: 'im oily skin what product should i buy',
    maxQueries: 2,
  });

  assert.deepEqual(queries, [
    'spf fluid oily skin',
    'lightweight sunscreen oily skin',
  ]);
});

test('__internal: framework recall planner keeps finish-fit sunscreen internal recall compact while leaving external precise recall open', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext: {
      request_text: 'My daytime products pill under makeup. What skincare product should I use instead?',
      primary_role_id: 'daily_sunscreen_finish_fit',
      comparison_mode: 'same_role_comparison',
      framework_roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          rank: 1,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen finish fit',
          query_terms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
          fit_keywords: ['under makeup', 'lightweight', 'non-greasy', 'fluid'],
          ingredient_hypotheses: ['UV filters'],
          product_type_hypotheses: ['sunscreen'],
        },
      ],
    },
  });

  assert.deepEqual(plan.stages[0]?.entries?.map((entry) => entry?.query), [
    'spf fluid oily skin',
    'sunscreen under makeup',
  ]);
  assert.deepEqual(plan.stages[1]?.entries?.map((entry) => entry?.query), [
    'spf fluid oily skin',
    'sunscreen under makeup',
    'lightweight sunscreen oily skin',
  ]);
});

test('__internal: framework recall planner keeps generic daily sunscreen support external runtime budget compact', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext: {
      request_text: 'im oily skin. what product should i buy?',
      primary_role_id: 'oil_control_treatment',
      routine_mode: 'routine_mix',
      semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 10,
          preferred_step: 'treatment',
          query_terms: ['niacinamide serum oily skin'],
          fit_keywords: ['niacinamide', 'oil control', 'zinc'],
        },
        {
          role_id: 'daily_sunscreen',
          rank: 30,
          preferred_step: 'sunscreen',
          label: 'Daily sunscreen',
          query_terms: ['spf fluid oily skin', 'lightweight sunscreen oily skin', 'oil control sunscreen'],
          fit_keywords: ['spf', 'lightweight', 'oil control', 'non-greasy'],
        },
      ],
    },
  });
  const internalStage = plan.stages.find((stage) => stage?.stage_id === 'framework_stage_c_support_daily_sunscreen');
  const externalStage = plan.stages.find((stage) => stage?.stage_id === 'framework_stage_c_support_daily_sunscreen_external_seed');

  assert.deepEqual(internalStage?.entries?.map((entry) => entry?.query), [
    'spf fluid oily skin',
    'lightweight sunscreen oily skin',
    'oil control sunscreen',
  ]);
  assert.deepEqual(externalStage?.entries?.map((entry) => entry?.query), [
    'spf fluid oily skin',
    'lightweight sunscreen oily skin',
  ]);
});

function getConfidenceNoticePayload(responseBody) {
  const cards = Array.isArray(responseBody?.cards) ? responseBody.cards : [];
  const noticeCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
  return noticeCard && noticeCard.payload && typeof noticeCard.payload === 'object' ? noticeCard.payload : null;
}

function getRecoRequestedEvent(responseBody) {
  const events = Array.isArray(responseBody?.events) ? responseBody.events : [];
  return events.find((event) => event && event.event_name === 'recos_requested') || null;
}

async function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function buildConcernSemanticPlanFixture() {
  return {
    primary_concern: 'oil control and congestion',
    core_roles: [
      {
        role_id: 'oil_control_treatment',
        label: 'Oil-control treatment',
        why_this_role: 'Target excess oil first.',
        rank: 1,
        preferred_step: 'treatment',
        alternate_steps: ['serum'],
        query_terms: ['oil control serum', 'shine control serum'],
        fit_keywords: ['oil control', 'shine control', 'mattifying'],
        ingredient_hypotheses: ['niacinamide', 'zinc pca'],
        product_type_hypotheses: ['treatment', 'serum'],
        frequency: 'daily',
        routine_slots: ['am', 'pm'],
      },
      {
        role_id: 'lightweight_moisturizer',
        label: 'Lightweight moisturizer',
        why_this_role: 'Keep hydration light and breathable.',
        rank: 2,
        preferred_step: 'moisturizer',
        query_terms: ['lightweight moisturizer', 'gel cream'],
        fit_keywords: ['lightweight moisturizer', 'gel cream', 'breathable hydration'],
        ingredient_hypotheses: ['ceramide'],
        product_type_hypotheses: ['moisturizer'],
        frequency: 'daily',
        routine_slots: ['am', 'pm'],
      },
      {
        role_id: 'daily_sunscreen',
        label: 'Daily sunscreen',
        why_this_role: 'Daytime UV protection still matters.',
        rank: 3,
        preferred_step: 'sunscreen',
        query_terms: ['daily sunscreen', 'broad spectrum sunscreen'],
        fit_keywords: ['spf', 'broad spectrum', 'uv filters'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
        frequency: 'daily_am',
        routine_slots: ['am'],
      },
    ],
    support_roles: [
      {
        role_id: 'hydrating_mask_support',
        label: 'Optional hydrating mask',
        why_this_role: 'Only if dehydration shows up.',
        rank: 1,
        preferred_step: 'mask',
        frequency: 'optional',
        routine_slots: ['pm'],
      },
    ],
    ingredient_hypotheses: ['niacinamide', 'zinc pca', 'ceramide', 'UV filters'],
    product_type_hypotheses: ['treatment', 'moisturizer', 'sunscreen'],
    routine_shell: {
      am_core_roles: ['oil_control_treatment', 'daily_sunscreen'],
      pm_core_roles: ['oil_control_treatment', 'lightweight_moisturizer'],
      optional_support_roles: ['hydrating_mask_support'],
      frequency: {
        oil_control_treatment: 'daily',
        lightweight_moisturizer: 'daily',
        daily_sunscreen: 'daily_am',
        hydrating_mask_support: 'optional',
      },
      role_to_step_mapping: {
        oil_control_treatment: 'treatment',
        lightweight_moisturizer: 'moisturizer',
        daily_sunscreen: 'sunscreen',
        hydrating_mask_support: 'mask',
      },
    },
  };
}

function buildConcernPlannerTextFixture({
  primaryConcern = 'oil control and congestion',
  coreRoleIds = ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
  supportRoleIds = ['hydrating_mask_support'],
  ingredientHypotheses = ['niacinamide', 'zinc pca', 'ceramide', 'UV filters'],
  productTypeHypotheses = ['treatment', 'moisturizer', 'sunscreen'],
  routineShellHints = 'AM=oil_control_treatment,daily_sunscreen; PM=oil_control_treatment,lightweight_moisturizer; OPTIONAL=hydrating_mask_support',
} = {}) {
  return [
    `PRIMARY_CONCERN: ${primaryConcern}`,
    `CORE_ROLE_IDS: ${coreRoleIds.join(' | ')}`,
    `SUPPORT_ROLE_IDS: ${supportRoleIds.join(' | ')}`,
    `INGREDIENT_HYPOTHESES: ${ingredientHypotheses.join(' | ')}`,
    `PRODUCT_TYPE_HYPOTHESES: ${productTypeHypotheses.join(' | ')}`,
    `ROUTINE_SHELL_HINTS: ${routineShellHints}`,
  ].join('\n');
}

function buildConcernSelectorFixture({
  topPickProductId = 'serum_chat_1',
  orderedProductIds = ['serum_chat_1', 'moist_chat_1', 'spf_chat_1'],
  openWorldCandidateExpansionNeeded = false,
} = {}) {
  return {
    top_pick_product_id: topPickProductId || null,
    ordered_product_ids: orderedProductIds,
    support_roles_surfaced: ['daily_sunscreen'],
    selection_notes: topPickProductId ? ['Top pick for that first role: Oil Balance Serum.'] : [],
    open_world_candidate_expansion_needed: openWorldCandidateExpansionNeeded,
  };
}

function buildBroadOilyInternalPrimitiveProduct({
  productId = 'serum_chat_1',
  merchantId = 'mid_internal',
} = {}) {
  return {
    product_id: productId,
    merchant_id: merchantId,
    brand: 'The Ordinary',
    name: 'Niacinamide 10% + Zinc 1%',
    display_name: 'Niacinamide 10% + Zinc 1%',
    category: 'serum',
    product_type: 'serum',
    retrieval_source: 'internal_search',
    source: 'internal_search',
    ingredient_tokens: ['niacinamide', 'zinc pca'],
    benefit_tags: ['oil control', 'shine control'],
    search_aliases: ['Oil Control Serum'],
    canonical_pdp_url: 'https://example.com/products/niacinamide-zinc',
    short_description: 'A lightweight serum for oily skin with niacinamide and zinc.',
  };
}

function buildInternalPrimitiveSearchSuccess(products = []) {
  return {
    ok: true,
    reason: null,
    products: Array.isArray(products) ? products : [],
    actual_http_attempt_count: 1,
    attempted_internal_base_urls: ['https://pivota-backend.test'],
    attempted_internal_paths: ['/agent/internal/products/search'],
    attempted_request_timeouts_ms: [4800],
    primary_endpoint_kind: 'internal_primitive',
    primary_transport_owner: 'internal_products_search_primitive',
    transport_hops: [
      {
        caller_lane: 'beauty_chat_handoff',
        target_base_url: 'https://pivota-backend.test',
        target_path: '/agent/internal/products/search',
        endpoint_kind: 'internal_primitive',
        transport_owner: 'internal_products_search_primitive',
        latency_ms: 15,
        result: Array.isArray(products) && products.length > 0 ? 'ok' : 'empty',
      },
    ],
    nested_orchestrator_hops: 0,
  };
}

function buildConcernFrameworkInternalSearchOverride({
  observe = null,
  primaryProducts = [],
  moisturizerProducts = [],
  sunscreenProducts = [],
} = {}) {
  return async (args = {}) => {
    if (typeof observe === 'function') observe(args);
    const query = String(args?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return buildInternalPrimitiveSearchSuccess(sunscreenProducts);
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return buildInternalPrimitiveSearchSuccess(moisturizerProducts);
    }
    return buildInternalPrimitiveSearchSuccess(primaryProducts);
  };
}

function buildConcernPlannerMock({
  selectorResult = null,
  plannerResult = null,
} = {}) {
  return async ({ query = '' } = {}) => {
    const prompt = String(query || '');
    if (/PROMPT_VERSION=concern_semantic_plan_v[12]/.test(prompt)) {
      return { answer: JSON.stringify(plannerResult || buildConcernSemanticPlanFixture()) };
    }
    if (prompt.includes('PROMPT_VERSION=concern_selector_race_v1')) {
      if (selectorResult === 'schema_invalid') {
        return {
          structured: {
            note: 'schema invalid selector output',
          },
          answer: JSON.stringify({
            note: 'schema invalid selector output',
          }),
        };
      }
      return { answer: JSON.stringify(selectorResult || buildConcernSelectorFixture()) };
    }
    return {
      answer: JSON.stringify({
        note: 'generic concern path should stay framework-first',
      }),
    };
  };
}

function buildConcernPlannerTimeoutMock() {
  return async ({ query = '' } = {}) => {
    const prompt = String(query || '');
    if (/PROMPT_VERSION=concern_semantic_plan_v[12]/.test(prompt)) {
      throw new Error('planner timeout');
    }
    return {
      answer: JSON.stringify({
        note: 'unexpected downstream llm invocation after planner timeout',
      }),
    };
  };
}

function isConcernSemanticPlannerPromptParts({ systemPrompt = '', userPrompt = '' } = {}) {
  const prompt = `${String(systemPrompt || '')}\n${String(userPrompt || '')}`;
  return /PROMPT_VERSION=concern_semantic_plan_v[12]/.test(prompt);
}

function isConcernSelectorPromptParts({ systemPrompt = '', userPrompt = '' } = {}) {
  const prompt = `${String(systemPrompt || '')}\n${String(userPrompt || '')}`;
  return prompt.includes('PROMPT_VERSION=concern_selector_race_v1');
}

function isRecoAssistantRewritePromptParts({ systemPrompt = '', route = '' } = {}) {
  return String(route || '').trim() === 'aurora_reco_assistant_rewrite'
    || String(systemPrompt || '').includes('You rewrite skincare recommendation explanations.');
}

function buildConcernPlannerGeminiJsonMock({
  plannerResult = null,
  rewriteAssistantText = '',
  emptyModels = [],
  attemptRecorder = null,
  throwOnConcernPrompt = false,
} = {}) {
  const emptyModelSet = new Set((Array.isArray(emptyModels) ? emptyModels : []).map((item) => String(item || '').trim()));
  return async ({ systemPrompt = '', userPrompt = '', model = '', route = '' } = {}) => {
    const concernPrompt = isConcernSemanticPlannerPromptParts({ systemPrompt, userPrompt });
    const rewritePrompt = isRecoAssistantRewritePromptParts({ systemPrompt, route });
    if (!concernPrompt && !rewritePrompt) {
      return { ok: false, reason: 'unexpected_gemini_prompt' };
    }
    if (typeof attemptRecorder === 'function') {
      attemptRecorder({
        model: String(model || '').trim(),
        structured_contract: rewritePrompt ? 'assistant_rewrite_json' : 'required_keys',
      });
    }
    if (throwOnConcernPrompt && concernPrompt) throw new Error('planner timeout');
    if (emptyModelSet.has(String(model || '').trim())) {
      return {
        ok: false,
        reason: 'gemini_text_empty',
        raw_text: '',
        provider: 'gemini',
        requested_model: model,
        effective_model: model,
        selection_source: 'test_mock',
      };
    }
    if (rewritePrompt) {
      return {
        ok: true,
        json: {
          assistant_text: String(rewriteAssistantText || '').trim(),
        },
        provider: 'gemini',
        requested_model: model,
        effective_model: model,
        selection_source: 'test_mock',
      };
    }
    return {
      ok: true,
      json: plannerResult || buildConcernSemanticPlanFixture(),
      provider: 'gemini',
      requested_model: model,
      effective_model: model,
      selection_source: 'test_mock',
    };
  };
}

function buildConcernPlannerGeminiTextMock({
  plainText = '',
  plainTextByModel = null,
  selectorResult = null,
  throwModels = [],
  effectiveModelByModel = null,
  attemptRecorder = null,
  throwOnConcernPrompt = false,
} = {}) {
  const throwModelSet = new Set((Array.isArray(throwModels) ? throwModels : []).map((item) => String(item || '').trim()));
  return async ({ systemPrompt = '', userPrompt = '', model = '' } = {}) => {
    if (!isConcernSemanticPlannerPromptParts({ systemPrompt, userPrompt }) && !isConcernSelectorPromptParts({ systemPrompt, userPrompt })) {
      return { ok: false, reason: 'unexpected_gemini_prompt' };
    }
    if (typeof attemptRecorder === 'function') {
      attemptRecorder({
        model: String(model || '').trim(),
        structured_contract: isConcernSelectorPromptParts({ systemPrompt, userPrompt }) ? 'selector_text' : 'plain_text',
      });
    }
    if ((throwOnConcernPrompt && isConcernSemanticPlannerPromptParts({ systemPrompt, userPrompt })) || throwModelSet.has(String(model || '').trim())) {
      throw new Error('planner timeout');
    }
    const mappedText =
      plainTextByModel && typeof plainTextByModel === 'object'
        ? plainTextByModel[String(model || '').trim()]
        : undefined;
    const effectiveModel =
      effectiveModelByModel && typeof effectiveModelByModel === 'object'
        ? String(effectiveModelByModel[String(model || '').trim()] || '').trim() || String(model || '').trim()
        : String(model || '').trim();
    const selectorPrompt = isConcernSelectorPromptParts({ systemPrompt, userPrompt });
    const text = selectorPrompt
      ? (
        selectorResult === 'schema_invalid'
          ? '{"note":"schema invalid selector output"}'
          : JSON.stringify(selectorResult || buildConcernSelectorFixture())
      )
      : String(mappedText != null ? mappedText : plainText || '').trim();
    if (!text) {
      return {
        ok: false,
        reason: 'gemini_text_empty',
        raw_text: '',
        provider: 'gemini',
        requested_model: model,
        effective_model: effectiveModel,
        selection_source: 'test_mock',
      };
    }
    return {
      ok: true,
      text,
      raw_text: text,
      provider: 'gemini',
      requested_model: model,
      effective_model: effectiveModel,
      selection_source: 'test_mock',
    };
  };
}

function createAppWithPatchedAuroraChat(options = {}) {
  const normalized =
    typeof options === 'function'
      ? { auroraChatImpl: options }
      : options && typeof options === 'object'
        ? { ...options }
        : {};
  if (
    typeof normalized.geminiJsonImpl !== 'function'
    && (
      typeof normalized.auroraChatImpl === 'function'
      || typeof normalized.geminiTextImpl === 'function'
    )
  ) {
    normalized.geminiJsonImpl = buildConcernPlannerGeminiJsonMock();
  }
  return createBaseAppWithPatchedAuroraChat(normalized);
}

function installConcernPlannerMocks(decisionModule, options = {}) {
  decisionModule.auroraChat = buildConcernPlannerMock(options);
}

test('__internal: normalizeIngredientRecoContextValue preserves resolved target step fields across merge', async () => {
  const { __internal } = loadRoutesFresh();
  const normalized = __internal.normalizeIngredientRecoContextValue({
    ingredient_query: 'Retinoid (later stage)',
    resolved_target_step: 'treatment',
    resolved_target_step_confidence: 'high',
    resolved_target_step_source: 'analysis_photo_modules',
    confidence_policy: {
      decision_stage: 'photo_confidence_policy_v1',
      confidence_level: 'medium',
      quality_grade: 'pass',
      aggressive_treatment_allowed: false,
      max_target_step: 'serum',
    },
  });
  assert.equal(normalized?.resolved_target_step, 'treatment');
  assert.equal(normalized?.target_step, 'treatment');
  assert.equal(normalized?.step, 'treatment');
  assert.equal(normalized?.resolved_target_step_confidence, 'high');
  assert.equal(normalized?.resolved_target_step_source, 'analysis_photo_modules');
  assert.equal(normalized?.confidence_policy?.aggressive_treatment_allowed, false);
  assert.equal(normalized?.confidence_policy?.max_target_step, 'serum');

  const merged = __internal.mergeIngredientRecoContextValue(
    { query: 'retinoid' },
    {
      ingredient_query: 'Retinoid (later stage)',
      resolved_target_step: 'treatment',
      resolved_target_step_confidence: 'high',
      resolved_target_step_source: 'analysis_photo_modules',
      confidence_policy: {
        decision_stage: 'photo_confidence_policy_v1',
        confidence_level: 'medium',
        quality_grade: 'pass',
        aggressive_treatment_allowed: false,
        max_target_step: 'serum',
      },
    },
  );
  assert.equal(merged?.resolved_target_step, 'treatment');
  assert.equal(merged?.target_step, 'treatment');
  assert.equal(merged?.step, 'treatment');
  assert.equal(merged?.confidence_policy?.aggressive_treatment_allowed, false);
  assert.equal(merged?.confidence_policy?.max_target_step, 'serum');
});

test('__internal: medium-confidence photo bundle shifts aggressive treatment to canonical safer target before reco', async () => {
  const { __internal } = loadRoutesFresh();
  const canonical = __internal.canonicalizePhotoRecoTargetBundle({
    primaryFocus: {
      module_id: 'nose',
      module_label: 'Nose',
      issue_type: 'texture',
      issue_label: 'texture',
      confidence_bucket: 'medium',
      ingredient_id: 'retinol',
      ingredient_name: 'Retinoid (later stage)',
      resolved_target_step: 'treatment',
    },
    qualityGrade: 'pass',
    rankedTargets: [
      {
        target_id: 'retinoid__treatment__texture__nose',
        target_role: 'primary',
        ingredient_id: 'retinol',
        ingredient_query: 'Retinoid (later stage)',
        resolved_target_step: 'treatment',
        target_confidence: 'medium',
        verified_product_count: 0,
        module_id: 'nose',
        issue_type: 'texture',
      },
      {
        target_id: 'bha__serum__texture__nose',
        target_role: 'secondary',
        ingredient_id: 'salicylic_acid',
        ingredient_query: 'Salicylic acid (BHA)',
        resolved_target_step: 'serum',
        target_confidence: 'medium',
        verified_product_count: 2,
        module_id: 'nose',
        issue_type: 'texture',
      },
      {
        target_id: 'ceramide__moisturizer__texture__nose',
        target_role: 'secondary',
        ingredient_id: 'ceramide_np',
        ingredient_query: 'Ceramide NP',
        resolved_target_step: 'moisturizer',
        target_confidence: 'medium',
        verified_product_count: 1,
        module_id: 'nose',
        issue_type: 'texture',
      },
    ],
  });

  assert.equal(canonical?.confidence_policy?.aggressive_treatment_allowed, false);
  assert.equal(canonical?.confidence_policy?.max_target_step, 'serum');
  assert.equal(canonical?.selection_shift_reason, 'confidence_policy_primary_target_shifted');
  assert.equal(canonical?.ranked_targets?.[0]?.ingredient_query, 'Salicylic acid (BHA)');
  assert.equal(canonical?.ranked_targets?.[0]?.resolved_target_step, 'serum');
  assert.equal(canonical?.primary_focus?.ingredient_name, 'Salicylic acid (BHA)');
  assert.equal(canonical?.primary_focus?.resolved_target_step, 'serum');
});

test('__internal: pass-quality low-confidence photo bundle can retain low-risk serum target', async () => {
  const { __internal } = loadRoutesFresh();
  const canonical = __internal.canonicalizePhotoRecoTargetBundle({
    primaryFocus: {
      module_id: 'nose',
      module_label: 'Nose',
      issue_type: 'texture',
      issue_label: 'texture',
      confidence_bucket: 'low',
      ingredient_id: 'retinol',
      ingredient_name: 'Retinoid (later stage)',
      resolved_target_step: 'treatment',
    },
    qualityGrade: 'pass',
    rankedTargets: [
      {
        target_id: 'retinoid__treatment__texture__nose',
        target_role: 'primary',
        ingredient_id: 'retinol',
        ingredient_query: 'Retinoid (later stage)',
        resolved_target_step: 'treatment',
        target_confidence: 'low',
        verified_product_count: 0,
        module_id: 'nose',
        issue_type: 'texture',
      },
      {
        target_id: 'bha__serum__texture__nose',
        target_role: 'secondary',
        ingredient_id: 'salicylic_acid',
        ingredient_query: 'Salicylic acid (BHA)',
        resolved_target_step: 'serum',
        target_confidence: 'low',
        verified_product_count: 2,
        module_id: 'nose',
        issue_type: 'texture',
      },
    ],
  });

  assert.equal(canonical?.confidence_policy?.aggressive_treatment_allowed, false);
  assert.equal(canonical?.confidence_policy?.max_target_step, 'serum');
  assert.equal(canonical?.selection_shift_reason, 'confidence_policy_primary_target_shifted');
  assert.equal(canonical?.ranked_targets?.[0]?.ingredient_query, 'Salicylic acid (BHA)');
  assert.equal(canonical?.ranked_targets?.[0]?.resolved_target_step, 'serum');
});

test('__internal: low-confidence photo bundle clears disallowed aggressive targets instead of keeping original primary', async () => {
  const { __internal } = loadRoutesFresh();
  const canonical = __internal.canonicalizePhotoRecoTargetBundle({
    primaryFocus: {
      module_id: 'nose',
      module_label: 'Nose',
      issue_type: 'texture',
      issue_label: 'texture',
      confidence_bucket: 'low',
      ingredient_id: 'retinol',
      ingredient_name: 'Retinoid (later stage)',
      resolved_target_step: 'treatment',
    },
    qualityGrade: 'degraded',
    rankedTargets: [
      {
        target_id: 'retinoid__treatment__texture__nose',
        target_role: 'primary',
        ingredient_id: 'retinol',
        ingredient_query: 'Retinoid (later stage)',
        resolved_target_step: 'treatment',
        target_confidence: 'low',
        verified_product_count: 0,
        module_id: 'nose',
        issue_type: 'texture',
      },
      {
        target_id: 'azelaic__serum__texture__nose',
        target_role: 'secondary',
        ingredient_id: 'azelaic_acid',
        ingredient_query: 'Azelaic Acid',
        resolved_target_step: 'serum',
        target_confidence: 'low',
        verified_product_count: 0,
        module_id: 'nose',
        issue_type: 'texture',
      },
      {
        target_id: 'bha__serum__texture__nose',
        target_role: 'secondary',
        ingredient_id: 'salicylic_acid',
        ingredient_query: 'BHA/LHA',
        resolved_target_step: 'serum',
        target_confidence: 'low',
        verified_product_count: 0,
        module_id: 'nose',
        issue_type: 'texture',
      },
    ],
  });

  assert.equal(canonical?.confidence_policy?.aggressive_treatment_allowed, false);
  assert.equal(canonical?.confidence_policy?.max_target_step, 'moisturizer');
  assert.equal(canonical?.selection_shift_reason, 'confidence_policy_target_bundle_cleared');
  assert.deepEqual(canonical?.ranked_targets || [], []);
  assert.equal(canonical?.display_policy?.primary_target_id || null, null);
  assert.equal(canonical?.primary_focus?.module_id, 'nose');
  assert.equal(canonical?.primary_focus?.issue_type, 'texture');
  assert.equal(canonical?.primary_focus?.ingredient_name || null, null);
  assert.equal(canonical?.primary_focus?.resolved_target_step || null, null);
});

test('__internal: degraded low-confidence photo story drops policy-disallowed aggressive actions', async () => {
  const { __internal } = loadRoutesFresh();
  const context = __internal.buildPhotoStoryContext({
    analysisSummaryPayload: {},
    photoModulesCard: {
      type: 'photo_modules_v1',
      payload: {
        quality_grade: 'degraded',
        summary_v1: {
          top_module_id: 'nose',
          top_action_ingredient_id: 'retinol',
          top_issue_type: 'texture',
          top_findings: [
            {
              module_id: 'nose',
              issue_type: 'texture',
              confidence_bucket: 'low',
              confidence_0_1: 0.22,
            },
          ],
        },
        modules: [
          {
            module_id: 'nose',
            module_rank_score: 0.95,
            issues: [
              {
                issue_type: 'texture',
                issue_rank_score: 0.95,
                severity_0_4: 2,
                confidence_0_1: 0.22,
              },
            ],
            actions: [
              {
                ingredient_canonical_id: 'retinol',
                ingredient_name: 'Retinoid (later stage)',
                action_rank_score: 0.95,
                why: 'Retinoid is the strongest active, but confidence is low here.',
                evidence_issue_types: ['texture'],
                products: [],
              },
            ],
          },
        ],
      },
    },
    language: 'EN',
  });

  assert.equal(context?.confidence_policy?.max_target_step, 'moisturizer');
  assert.deepEqual(context?.ranked_targets || [], []);
  assert.deepEqual(context?.top_actions_by_module || [], []);
});

test('__internal: content spine is preserved on reco payload and assistant text stays payload-bound', async () => {
  const { __internal } = loadRoutesFresh();
  const recoContext = {
    ingredient_query: 'Ceramide NP',
    resolved_target_step: 'moisturizer',
    resolved_target_step_confidence: 'low',
    confidence_policy: {
      decision_stage: 'photo_confidence_policy_v1',
      confidence_level: 'low',
      quality_grade: 'pass',
      aggressive_treatment_allowed: false,
      max_target_step: 'moisturizer',
    },
    primary_focus: {
      module_id: 'cheek_left',
      module_label: 'Left cheek',
      issue_type: 'redness',
      issue_label: 'redness',
      confidence_bucket: 'low',
    },
    primary_target_id: 'ceramide_np__moisturizer',
    ranked_targets: [
      {
        target_id: 'ceramide_np__moisturizer',
        target_role: 'primary',
        ingredient_query: 'Ceramide NP',
        resolved_target_step: 'moisturizer',
        product_candidates: [
          {
            product_id: 'prod_ceramide',
            merchant_id: 'mid_test',
            display_name: 'Barrier Rescue Cream',
          },
        ],
      },
      {
        target_id: 'niacinamide__serum',
        target_role: 'secondary',
        ingredient_query: 'Niacinamide',
        resolved_target_step: 'serum',
      },
    ],
  };
  const payload = {
    recommendations: [
      {
        product_id: 'prod_ceramide',
        merchant_id: 'mid_test',
        brand: 'TestBrand',
        name: 'Barrier Rescue Cream',
        display_name: 'Barrier Rescue Cream',
        product_type: 'moisturizer',
        category: 'moisturizer',
      },
    ],
    recommendation_meta: {
      resolved_target_step: 'moisturizer',
      resolved_target_step_confidence: 'low',
      mainline_status: 'grounded_success',
    },
  };

  const nextPayload = __internal.applyRecoContentSpineToPayload(payload, recoContext);
  assert.equal(nextPayload.recommendation_meta?.primary_target_id, 'ceramide_np_moisturizer');
  assert.deepEqual(nextPayload.recommendation_meta?.displayed_target_ids, ['ceramide_np_moisturizer']);
  assert.deepEqual(nextPayload.recommendation_meta?.selected_target_ids, ['ceramide_np_moisturizer']);
  assert.equal(nextPayload.recommendation_meta?.confidence_policy?.aggressive_treatment_allowed, false);

  const assistantText = __internal.buildPayloadBoundRecoAssistantText({
    payload: nextPayload,
    language: 'EN',
    profile: { skinType: 'dry', goals: ['barrier repair'] },
  });
  assert.match(assistantText, /Ceramide NP|moisturizer/i);
  assert.match(assistantText, /Barrier Rescue Cream/i);
  assert.match(assistantText, /slowly|1-2 weeks|conservative/i);
});

test('__internal: content spine keeps explicit role-tagged rows from bleeding into token-adjacent support targets', async () => {
  const { __internal } = loadRoutesFresh();
  const payload = __internal.applyRecoContentSpineToPayload({
    recommendations: [
      {
        product_id: 'prod_barrier',
        merchant_id: 'mid_test',
        brand: 'CalmLab',
        name: 'Soothing Barrier Cream',
        display_name: 'CalmLab Soothing Barrier Cream',
        product_type: 'moisturizer',
        category: 'moisturizer',
        matched_role_id: 'barrier_moisturizer',
      },
    ],
    recommendation_meta: {
      resolved_target_step: 'moisturizer',
      resolved_target_step_confidence: 'medium',
      mainline_status: 'grounded_success',
      source_mode: 'framework_mainline',
    },
  }, {
    ingredient_query: 'Barrier moisturizer',
    resolved_target_step: 'moisturizer',
    resolved_target_step_confidence: 'medium',
    primary_target_id: 'barrier_moisturizer',
    ranked_targets: [
      {
        target_id: 'barrier_moisturizer',
        target_role: 'primary',
        ingredient_query: 'Barrier moisturizer',
        goal: 'barrier repair',
        resolved_target_step: 'moisturizer',
      },
      {
        target_id: 'soothing_treatment',
        target_role: 'secondary',
        ingredient_query: 'Soothing treatment',
        goal: 'calm redness',
        resolved_target_step: 'moisturizer',
      },
    ],
  });

  assert.deepEqual(payload.recommendation_meta?.selected_target_ids, ['barrier_moisturizer']);
  assert.deepEqual(payload.recommendation_meta?.displayed_target_ids, ['barrier_moisturizer']);
});

test('__internal: content spine still falls back to text matching when reco rows have no explicit role tag', async () => {
  const { __internal } = loadRoutesFresh();
  const payload = __internal.applyRecoContentSpineToPayload({
    recommendations: [
      {
        product_id: 'prod_soothing',
        merchant_id: 'mid_test',
        brand: 'CalmLab',
        name: 'Soothing Relief Serum',
        display_name: 'CalmLab Soothing Relief Serum',
        product_type: 'serum',
        category: 'serum',
      },
    ],
    recommendation_meta: {
      resolved_target_step: 'serum',
      resolved_target_step_confidence: 'medium',
      mainline_status: 'grounded_success',
      source_mode: 'catalog_grounded',
    },
  }, {
    ingredient_query: 'Soothing treatment',
    resolved_target_step: 'serum',
    resolved_target_step_confidence: 'medium',
    primary_target_id: 'soothing_treatment',
    ranked_targets: [
      {
        target_id: 'soothing_treatment',
        target_role: 'primary',
        ingredient_query: 'Soothing treatment',
        goal: 'calm redness',
        resolved_target_step: 'serum',
      },
    ],
  });

  assert.deepEqual(payload.recommendation_meta?.selected_target_ids, ['soothing_treatment']);
  assert.deepEqual(payload.recommendation_meta?.displayed_target_ids, ['soothing_treatment']);
});

test('__internal: quality contract exposes semantic reco alignment flags', async () => {
  const { __internal } = loadRoutesFresh();
  const payload = __internal.applyRecoContentSpineToPayload({
    recommendations: [
      {
        product_id: 'prod_ceramide',
        merchant_id: 'mid_test',
        brand: 'TestBrand',
        name: 'Barrier Rescue Cream',
        display_name: 'Barrier Rescue Cream',
        product_type: 'moisturizer',
        category: 'moisturizer',
        url: 'https://example.com/pdp/barrier-rescue-cream',
        pdp_url: 'https://example.com/pdp/barrier-rescue-cream',
      },
    ],
    recommendation_meta: {
      resolved_target_step: 'moisturizer',
      resolved_target_step_confidence: 'low',
      mainline_status: 'grounded_success',
      source_mode: 'catalog_grounded',
    },
  }, {
    ingredient_query: 'Ceramide NP',
    resolved_target_step: 'moisturizer',
    resolved_target_step_confidence: 'low',
    primary_focus: {
      module_id: 'cheek_left',
      module_label: 'Left cheek',
      issue_type: 'redness',
      issue_label: 'redness',
      confidence_bucket: 'low',
    },
    primary_target_id: 'ceramide_np__moisturizer',
    ranked_targets: [
      {
        target_id: 'ceramide_np__moisturizer',
        target_role: 'primary',
        ingredient_query: 'Ceramide NP',
        resolved_target_step: 'moisturizer',
        product_candidates: [
          {
            product_id: 'prod_ceramide',
            merchant_id: 'mid_test',
            display_name: 'Barrier Rescue Cream',
          },
        ],
      },
    ],
  });
  const assistantText = __internal.buildPayloadBoundRecoAssistantText({
    payload,
    language: 'EN',
    profile: { skinType: 'dry', goals: ['barrier repair'] },
  });
  const quality = __internal.evaluateQualityContractForEnvelope({
    envelope: {
      cards: [
        {
          type: 'photo_modules_v1',
          payload: {
            summary_v1: {
              top_findings: [
                {
                  module_id: 'cheek_left',
                  module_label: 'Left cheek',
                  issue_type: 'redness',
                  issue_label: 'redness',
                  confidence_bucket: 'low',
                },
              ],
            },
          },
        },
        {
          type: 'analysis_story_v2',
          payload: {
            priority_findings: [{ title: 'Left cheek redness looks mild.' }],
            ui_card_v1: {
              headline: 'Left cheek redness looks mild, so stay conservative.',
              actions_now: ['Start with a barrier moisturizer.'],
              confidence_label: 'low',
            },
          },
        },
        {
          type: 'ingredient_plan_v2',
          payload: {
            targets: [
              {
                target_id: 'ceramide_np__moisturizer',
                ingredient_query: 'Ceramide NP',
                resolved_target_step: 'moisturizer',
                displayable: true,
              },
            ],
          },
        },
        {
          type: 'recommendations',
          payload,
        },
      ],
      session_patch: {
        state: {
          latest_reco_context: {
            ingredient_query: 'Ceramide NP',
            resolved_target_step: 'moisturizer',
            resolved_target_step_confidence: 'low',
            primary_focus: {
              module_id: 'cheek_left',
              module_label: 'Left cheek',
              issue_type: 'redness',
              issue_label: 'redness',
              confidence_bucket: 'low',
            },
            primary_target_id: payload.recommendation_meta?.primary_target_id,
            ranked_targets: payload.recommendation_meta?.ranked_targets,
            selected_target_ids: payload.recommendation_meta?.selected_target_ids,
          },
        },
      },
    },
    policyMeta: { intent_canonical: 'reco_products' },
    assistantText,
    profile: { skinType: 'dry', goals: ['barrier repair'] },
  });

  assert.equal(quality.semantic_contract_pass, true);
  assert.equal(quality.primary_focus_alignment_pass, true);
  assert.equal(quality.target_bundle_alignment_pass, true);
  assert.equal(quality.assistant_reco_alignment_pass, true);
  assert.equal(quality.confidence_consistency_pass, true);
});

test('__internal: quality contract ignores how-to-use and caution headings for known seeded profile fields', async () => {
  const { __internal } = loadRoutesFresh();
  const payload = __internal.applyRecoContentSpineToPayload({
    recommendations: [
      {
        product_id: 'prod_oil_control',
        merchant_id: 'mid_test',
        brand: 'GoalSkin',
        name: 'Oil Control Serum',
        display_name: 'GoalSkin Oil Control Serum',
        product_type: 'serum',
        category: 'serum',
        url: 'https://example.com/pdp/oil-control-serum',
        pdp_url: 'https://example.com/pdp/oil-control-serum',
      },
    ],
    recommendation_meta: {
      resolved_target_step: 'treatment',
      resolved_target_step_confidence: 'medium',
      mainline_status: 'grounded_success',
      source_mode: 'framework_mainline',
    },
  }, {
    ingredient_query: 'Oil-control treatment',
    resolved_target_step: 'treatment',
    resolved_target_step_confidence: 'medium',
    primary_target_id: 'oil_control_treatment',
    ranked_targets: [
      {
        target_id: 'oil_control_treatment',
        target_role: 'primary',
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        product_candidates: [
          {
            product_id: 'prod_oil_control',
            merchant_id: 'mid_test',
            display_name: 'GoalSkin Oil Control Serum',
          },
        ],
      },
    ],
    selected_target_ids: ['oil_control_treatment'],
  });
  const assistantText = [
    __internal.buildPayloadBoundRecoAssistantText({
      payload,
      language: 'EN',
      profile: {
        skinType: 'oily',
        sensitivity: 'low',
        barrierStatus: 'stable',
        goals: ['oil control'],
      },
    }),
    'How to use / caution: start 2-3 nights per week and stop if irritation persists.',
  ].join('\n');
  const quality = __internal.evaluateQualityContractForEnvelope({
    envelope: {
      cards: [
        {
          type: 'recommendations',
          payload,
        },
      ],
      session_patch: {
        state: {
          latest_reco_context: {
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
            resolved_target_step_confidence: 'medium',
            primary_target_id: payload.recommendation_meta?.primary_target_id,
            ranked_targets: payload.recommendation_meta?.ranked_targets,
            selected_target_ids: payload.recommendation_meta?.selected_target_ids,
          },
        },
      },
    },
    policyMeta: { intent_canonical: 'reco_products' },
    assistantText,
    profile: {
      skinType: 'oily',
      sensitivity: 'low',
      barrierStatus: 'stable',
      goals: ['oil control'],
    },
  });

  assert.equal(quality.strict_fail_flags.entity_miss_fail_seed_profile, false);
  assert.equal(quality.context_persistence_pass, true);
  assert.equal(quality.semantic_contract_pass, true);
  assert.equal(quality.contract_pass, true);
});

test('__internal: quality contract accepts semantic oil-control wording without exact target label phrase', async () => {
  const { __internal } = loadRoutesFresh();
  const payload = __internal.applyRecoContentSpineToPayload({
    recommendations: [
      {
        product_id: 'prod_oil_control',
        merchant_id: 'mid_test',
        brand: 'GoalSkin',
        name: 'Oil Control Serum',
        display_name: 'GoalSkin Oil Control Serum',
        product_type: 'serum',
        category: 'serum',
        url: 'https://example.com/pdp/oil-control-serum',
        pdp_url: 'https://example.com/pdp/oil-control-serum',
      },
    ],
    recommendation_meta: {
      resolved_target_step: 'treatment',
      resolved_target_step_confidence: 'medium',
      mainline_status: 'grounded_success',
      source_mode: 'framework_mainline',
    },
  }, {
    ingredient_query: 'Oil-control treatment',
    resolved_target_step: 'treatment',
    resolved_target_step_confidence: 'medium',
    primary_target_id: 'oil_control_treatment',
    ranked_targets: [
      {
        target_id: 'oil_control_treatment',
        target_role: 'primary',
        ingredient_query: 'Oil-control treatment',
        resolved_target_step: 'treatment',
        product_candidates: [
          {
            product_id: 'prod_oil_control',
            merchant_id: 'mid_test',
            display_name: 'GoalSkin Oil Control Serum',
          },
        ],
      },
    ],
    selected_target_ids: ['oil_control_treatment'],
  });

  const quality = __internal.evaluateQualityContractForEnvelope({
    envelope: {
      assistant_message: {
        role: 'assistant',
        content: 'GoalSkin Oil Control Serum fits this request if you want something lightweight for mid-day shine and oil control.',
      },
      cards: [
        {
          type: 'recommendations',
          payload,
        },
      ],
      session_patch: {
        state: {
          latest_reco_context: {
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
            resolved_target_step_confidence: 'medium',
            primary_target_id: payload.recommendation_meta?.primary_target_id,
            ranked_targets: payload.recommendation_meta?.ranked_targets,
            selected_target_ids: payload.recommendation_meta?.selected_target_ids,
          },
        },
      },
    },
    policyMeta: { intent_canonical: 'reco_products' },
    assistantText: 'GoalSkin Oil Control Serum fits this request if you want something lightweight for mid-day shine and oil control.',
    profile: {
      skinType: 'oily',
      goals: ['oil control'],
    },
  });

  assert.equal(quality.assistant_reco_alignment_pass, true);
  assert.equal(quality.assistant_payload_alignment_pass, true);
  assert.equal(quality.semantic_contract_pass, true);
});

test('__internal: low-confidence reco downgrade rewrites assistant text to match notice-only output', async () => {
  const { __internal } = loadRoutesFresh();
  const degraded = __internal.applyLowOrMediumRecoGuardToEnvelope({
    envelope: {
      assistant_message: {
        role: 'assistant',
        content: 'Products actually selected this time: NightLab Retinol Night Treatment.',
        format: 'markdown',
      },
      cards: [
        {
          type: 'recommendations',
          payload: {
            recommendations: [
              {
                product_id: 'prod_retinol_night_treatment',
                merchant_id: 'mid_test',
                brand: 'NightLab',
                name: 'Retinol Night Treatment',
                display_name: 'NightLab Retinol Night Treatment',
                category: 'treatment',
                product_type: 'treatment',
                recommendation_confidence_level: 'low',
                why: ['retinoid treatment'],
              },
            ],
            recommendation_confidence_level: 'low',
            recommendation_confidence_score: 0.22,
          },
        },
      ],
      events: [
        {
          event_name: 'recos_requested',
          data: {
            mainline_status: 'grounded_success',
            confidence_level: 'low',
          },
        },
      ],
    },
    ctx: { request_id: 'test_low_confidence_rewrite', trace_id: 'trace_low_confidence_rewrite' },
    language: 'EN',
  });

  const nextEnvelope = degraded.envelope;
  const cards = Array.isArray(nextEnvelope?.cards) ? nextEnvelope.cards : [];
  const noticeCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
  const assistantText = String(nextEnvelope?.assistant_message?.content || '');
  assert.ok(noticeCard);
  assert.equal(noticeCard?.payload?.reason, 'low_confidence');
  assert.doesNotMatch(assistantText, /Products actually selected this time|NightLab Retinol Night Treatment/i);
  assert.match(assistantText, /confidence|filtered|conservative|downgraded/i);
});

test('/v1/reco/generate: explicit moisturizer focus uses viable pool and rejects brush candidates', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: `brush_${observedQueries.length}`,
            merchant_id: 'mid_brush',
            brand: 'BrushCo',
            name: 'Small Eyeshadow Brush',
            display_name: 'Small Eyeshadow Brush',
            category: 'makeup brush',
            product_type: 'tool',
          },
          {
            product_id: `cream_${observedQueries.length}`,
            merchant_id: 'mid_cream',
            brand: 'GoodSkin',
            name: 'Barrier Repair Cream',
            display_name: 'Barrier Repair Cream',
            category: 'skincare',
            ingredient_tokens: ['ceramide', 'panthenol'],
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'reco_focus_uid', briefId: 'reco_focus_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_focus_uid',
        'X-Trace-ID': 'trace_reco_focus',
        'X-Brief-ID': 'reco_focus_brief',
      },
      body: {
        focus: 'moisturizer',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.ok(payload.recommendations.every((item) => !/brush/i.test(JSON.stringify(item))));
    assert.equal(payload.recommendation_meta?.resolved_target_step, 'moisturizer');
    assert.equal(payload.recommendation_meta?.resolved_target_step_confidence, 'high');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.ok(typeof payload.recommendation_meta?.candidate_pool_signature === 'string' && payload.recommendation_meta.candidate_pool_signature.length > 0);
    assert.ok(observedQueries.some((query) => query.includes('barrier')));
    assert.ok(!observedQueries.some((query) => query.includes('cleanser') || query.includes('sunscreen')));
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/reco/generate: step-aware no-viable path stays explicit and does not report grounded_success', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v4',
            hit_quality: 'invalid_hit',
            invalid_hit_reason: 'invalid_hit_tools_dominant',
            query_bucket: 'skincare',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 0,
            exact_step_topk_count: 0,
            raw_result_count: 1,
            products_returned_count: 0,
          },
        },
        products: [
          {
            product_id: 'brush_only',
            merchant_id: 'mid_brush',
            brand: 'BrushCo',
            name: 'Small Eyeshadow Brush',
            display_name: 'Small Eyeshadow Brush',
            category: 'makeup brush',
            product_type: 'tool',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'reco_empty_uid', briefId: 'reco_empty_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_empty_uid',
        'X-Trace-ID': 'trace_reco_empty',
        'X-Brief-ID': 'reco_empty_brief',
      },
      body: {
        focus: 'moisturizer',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceNotice =
      cards.find((card) => card && card.type === 'confidence_notice' && String(card?.payload?.reason || '') === 'no_viable_candidates_for_target')
      || null;
    assert.ok(confidenceNotice);
    assert.equal(confidenceNotice?.payload?.reason, 'no_viable_candidates_for_target');
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'needs_more_context');
    assert.equal(recoEvent?.data?.failure_class, 'no_viable_candidates_for_target');
    assert.equal(recoEvent?.data?.surface_reason, 'no_viable_candidates_for_target');
    assert.equal(recoEvent?.data?.user_fixable, false);
    assert.equal('upstream_status' in (recoEvent?.data || {}), false);
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: adjacent/noisy candidates degrade to weak_viable_pool instead of masquerading as artifact missing', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v4',
            hit_quality: 'valid_hit',
            query_bucket: 'skincare',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 1,
            exact_step_topk_count: 0,
            raw_result_count: 1,
            products_returned_count: 1,
          },
        },
        products: [
          {
            product_id: 'sleep_mask_only',
            merchant_id: 'mid_sleep_mask',
            brand: 'NightSkin',
            name: 'Sleeping Mask',
            display_name: 'Sleeping Mask',
            category: 'sleeping mask',
            product_type: 'mask',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'reco_weak_uid', briefId: 'reco_weak_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_weak_uid',
        'X-Trace-ID': 'trace_reco_weak',
        'X-Brief-ID': 'reco_weak_brief',
        'X-Debug': 'true',
      },
      body: {
        focus: 'something for night',
        include_debug: true,
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceNotice =
      cards.find((card) => card && card.type === 'confidence_notice'
        && String(card?.payload?.reason || '') === 'weak_viable_pool')
      || null;
    assert.ok(confidenceNotice);
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'needs_more_context');
    assert.equal(recoEvent?.data?.failure_class, 'weak_viable_pool');
    assert.equal(recoEvent?.data?.surface_reason, 'weak_viable_pool');
    assert.equal(recoEvent?.data?.user_fixable, true);
    assert.equal('upstream_status' in (recoEvent?.data || {}), false);
    assert.equal(
      response.body?.meta?.canonical_ownership?.audit?.confidence_notice_reason,
      'weak_viable_pool',
    );
    assert.equal(
      response.body?.analysis_meta?.canonical_owner_source,
      'reco_generate',
    );
    assert.equal(
      response.body?.meta?.quality_contract?.canonical_ownership_audit?.audit?.confidence_notice_reason,
      'weak_viable_pool',
    );
    assert.equal(
      response.body?.debug?.reco_catalog_debug?.candidate_drop_stage,
      'weak_viable_pool',
    );
    assert.equal(
      response.body?.debug?.canonical_ownership?.audit?.confidence_notice_reason,
      'weak_viable_pool',
    );
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: explicit focus can still succeed even when latest_reco_context is present', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v4',
            hit_quality: 'valid_hit',
            query_bucket: 'skincare',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 1,
            exact_step_topk_count: 1,
            raw_result_count: 1,
            products_returned_count: 1,
          },
        },
        products: [
          {
            product_id: 'cream_valid_but_context_weak',
            merchant_id: 'mid_cream',
            brand: 'BarrierLab',
            name: 'Barrier Repair Cream',
            display_name: 'Barrier Repair Cream',
            category: 'skincare',
            ingredient_tokens: ['ceramide', 'panthenol'],
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_context_weak_uid',
        'X-Trace-ID': 'trace_reco_context_weak',
        'X-Debug': 'true',
      },
      body: {
        focus: 'moisturizer',
        include_debug: true,
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              goal: 'Repair skin barrier',
              context_origin: 'analysis_summary',
              resolved_target_step: 'moisturizer',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'analysis_adjustment',
              artifact_id: 'artifact_test_weak',
            },
          },
        },
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.equal(payload.recommendation_meta?.analysis_context_usage?.context_source_mode, 'none');
    assert.equal(payload.recommendation_meta?.analysis_context_usage?.analysis_context_available, false);
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'grounded_success');
    assert.equal(recoEvent?.data?.source_mode, 'catalog_grounded');
    assert.equal(recoEvent?.data?.grounded_count, 1);
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: valid_hit queries that all hard-reject on coarse domain become retro invalid hits', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v4',
            hit_quality: 'valid_hit',
            query_bucket: 'skincare',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 1,
            exact_step_topk_count: 1,
            raw_result_count: 2,
            products_returned_count: 2,
          },
        },
        products: [
          {
            product_id: 'body_only_1',
            merchant_id: 'mid_body_1',
            brand: 'BodyBrand',
            name: 'Barrier Body Cream',
            display_name: 'Barrier Body Cream',
            category: 'body cream',
            product_type: 'cream',
          },
          {
            product_id: 'body_only_2',
            merchant_id: 'mid_body_2',
            brand: 'BodyBrand',
            name: 'Shimmering Body Butter',
            display_name: 'Shimmering Body Butter',
            category: 'bodycare',
            product_type: 'cream',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'reco_retro_invalid_uid', briefId: 'reco_retro_invalid_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_retro_invalid_uid',
        'X-Trace-ID': 'trace_reco_retro_invalid',
        'X-Brief-ID': 'reco_retro_invalid_brief',
        'X-Debug': 'true',
      },
      body: {
        focus: 'moisturizer',
        include_debug: true,
      },
    });

    assert.equal(response.status, 200);
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.failure_class, 'no_valid_catalog_hit_for_target');
    assert.equal(recoEvent?.data?.surface_reason, 'no_valid_catalog_hit_for_target');
    assert.equal(recoEvent?.data?.user_fixable, false);
    assert.equal(response.body?.debug?.reco_catalog_debug?.retrieval_failure_class, 'invalid_retrieval_hit');
    assert.ok(Number(response.body?.debug?.reco_catalog_debug?.retro_invalid_hit_query_count || 0) >= 1);
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: explicit moisturizer ask stays on step-aware path and never surfaces brush/tool recommendations', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'brush_chat_1',
            merchant_id: 'mid_brush',
            brand: 'BrushCo',
            name: 'Small Eyeshadow Brush',
            display_name: 'Small Eyeshadow Brush',
            category: 'makeup brush',
            product_type: 'tool',
          },
          {
            product_id: 'cream_chat_1',
            merchant_id: 'mid_cream',
            brand: 'GoodSkin',
            name: 'Moisture Barrier Cream',
            display_name: 'Moisture Barrier Cream',
            category: 'skincare',
            ingredient_tokens: ['ceramide', 'panthenol'],
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_focus_uid', briefId: 'chat_focus_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_focus_uid',
        'X-Trace-ID': 'trace_chat_focus',
        'X-Brief-ID': 'chat_focus_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend a moisturizer for me',
            profile_patch: {
              skinType: 'dry',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['barrier repair'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.ok(payload.recommendations.every((item) => !/brush/i.test(JSON.stringify(item))));
    assert.equal(payload.recommendation_meta?.resolved_target_step, 'moisturizer');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: generic oily-skin ask stays framework-first and keeps assistant text aligned to the primary role', async () => {
  const observedQueries = [];
  let harness = null;
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_PRODUCT_INTEL_LLM_PROVIDER: 'gemini',
      AURORA_PRODUCT_INTEL_LLM_MODEL: 'gemini-3-flash-preview',
    },
    async () => {
      harness = createAppWithPatchedAuroraChat({
        auroraChatImpl: buildConcernPlannerMock(),
        geminiJsonImpl: buildConcernPlannerGeminiJsonMock({
          rewriteAssistantText:
            'For oily skin, start with Clarity Lab Oil Balance Serum for oil control. Then add LightLab Air Gel Cream for light hydration and SunGuard Daily UV Fluid SPF 50 for daytime protection.',
        }),
        geminiTextImpl: buildConcernPlannerGeminiTextMock({
          plainText: buildConcernPlannerTextFixture(),
        }),
        useMemoryStore: false,
      });
      harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
        searchInternalProductsPrimitive: buildConcernFrameworkInternalSearchOverride({
          observe: (args = {}) => {
            observedQueries.push(String(args?.query || '').trim().toLowerCase());
          },
          primaryProducts: [
            {
              product_id: 'serum_chat_1',
              merchant_id: 'mid_serum',
              brand: 'Clarity Lab',
              name: 'Oil Balance Serum',
              display_name: 'Oil Balance Serum',
              category: 'serum',
              product_type: 'serum',
              ingredient_tokens: ['niacinamide', 'zinc pca'],
              benefit_tags: ['oil control', 'shine control'],
              search_aliases: ['Oil Control Serum'],
              short_description: 'A mattifying oil-control serum for oily skin.',
            },
          ],
          moisturizerProducts: [
            {
              product_id: 'moist_chat_1',
              merchant_id: 'mid_moist',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
          sunscreenProducts: [
            {
              product_id: 'spf_chat_1',
              merchant_id: 'mid_spf',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        }),
      });

      try {
        await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_uid', briefId: 'chat_framework_brief' });
        const response = await harness.request
          .post('/v1/chat')
          .set({
            'X-Aurora-UID': 'chat_framework_uid',
            'X-Trace-ID': 'trace_chat_framework',
            'X-Brief-ID': 'chat_framework_brief',
          })
          .send({
            action: {
              action_id: 'chip.start.reco_products',
              kind: 'chip',
              data: {
                reply_text: 'im oily skin, what product should i use?',
                profile_patch: {
                  skinType: 'oily',
                  sensitivity: 'low',
                  barrierStatus: 'stable',
                  goals: ['oil control'],
                },
              },
            },
            client_state: 'IDLE_CHAT',
            session: { state: 'idle' },
            language: 'EN',
          });

        assert.equal(response.statusCode, 200);
        const payload = getRecommendationsPayload(response.body);
        assert.ok(payload);
        assert.equal(payload.recommendation_meta?.owner_source, 'shopping_agent_beauty_mainline');
        assert.equal(payload.recommendation_meta?.query_source, 'beauty_mainline_local_handoff');
        assert.equal(payload.recommendation_meta?.source_mode, 'framework_mainline');
        assert.equal(payload.recommendation_meta?.selector_winner_source, 'llm_selector');
        assert.equal(payload.recommendation_meta?.primary_target_id, 'oil_control_treatment');
        assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
        assert.equal(payload.recommendation_meta?.primary_failure_reason ?? null, null);
        assert.equal(payload.recommendation_meta?.surface_reason ?? null, null);
        assert.equal(payload.recommendation_meta?.products_empty_reason ?? null, null);
        assert.equal(payload.recommendation_meta?.assistant_rewrite_llm_used, true);
        assert.equal(payload.recommendation_meta?.assistant_rewrite_model, 'gemini-3-flash-preview');
        assert.equal(payload.primary_role_id, 'oil_control_treatment');
        assert.equal(payload.primary_recommendation_id, 'serum_chat_1');
        assert.deepEqual(
          payload.recommendation_meta?.selected_target_ids,
          ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
        );
        assert.deepEqual(
          payload.core_roles?.map((role) => role?.role_id),
          ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
        );
        assert.deepEqual(
          payload.support_roles?.map((role) => role?.role_id),
          [],
        );
        assert.ok(Array.isArray(payload.roles) && payload.roles.length >= 3);
        assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 3);
        assert.equal(payload.recommendations[0]?.product_id, 'serum_chat_1');
        assert.equal(payload.recommendations[0]?.matched_role_id, 'oil_control_treatment');
        assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'lightweight_moisturizer'));
        assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'daily_sunscreen'));
        const assistantText = String(
          response.body?.assistant_message?.content || response.body?.assistant_text || '',
        );
        assert.match(assistantText, /For oily skin, start with Clarity Lab Oil Balance Serum for oil control\./i);
        assert.match(assistantText, /LightLab Air Gel Cream/i);
        assert.match(assistantText, /SunGuard Daily UV Fluid SPF 50/i);
        const suggestedChipIds = (Array.isArray(response.body?.suggested_chips) ? response.body.suggested_chips : [])
          .map((chip) => String(chip?.chip_id || '').trim())
          .filter(Boolean);
        assert.ok(
          suggestedChipIds.includes('chip.start.routine')
          || suggestedChipIds.includes('chip.action.reco_routine')
          || suggestedChipIds.includes('tpl.action.routine_generate'),
        );
        assert.ok(observedQueries.some((query) => query.includes('oil control')));
        assert.ok(observedQueries.some((query) => query.includes('sunscreen')));
      } finally {
        harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
        harness?.restore?.();
      }
    },
  );
});

staleFallbackPlannerTest('/v1/chat: generic oily-skin ask stays routine-ready when moisturizer support only matches by exact step and role recall', async () => {
  let harness = null;
  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: buildConcernPlannerMock(),
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: buildConcernPlannerTextFixture(),
      }),
      useMemoryStore: false,
    });
    harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: buildConcernFrameworkInternalSearchOverride({
        primaryProducts: [
          {
            product_id: 'serum_routine_ready_1',
            merchant_id: 'mid_serum_routine_ready',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            ingredient_tokens: ['niacinamide', 'zinc pca'],
            benefit_tags: ['oil control', 'shine control'],
            search_aliases: ['Oil Control Serum'],
            short_description: 'A mattifying oil-control serum for oily skin.',
          },
        ],
        moisturizerProducts: [
          {
            product_id: 'moist_routine_ready_1',
            merchant_id: 'mid_moist_routine_ready',
            brand: 'LightLab',
            name: 'Daily Balance Lotion',
            display_name: 'Daily Balance Lotion',
            category: 'moisturizer',
            product_type: 'moisturizer',
            short_description: 'A face lotion for oily skin.',
          },
        ],
        sunscreenProducts: [
          {
            product_id: 'spf_routine_ready_1',
            merchant_id: 'mid_spf_routine_ready',
            brand: 'SunGuard',
            name: 'Daily Shield SPF 50',
            display_name: 'Daily Shield SPF 50',
            category: 'sunscreen',
            product_type: 'sunscreen',
            short_description: 'A daily face sunscreen for oily skin.',
          },
        ],
      }),
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_routine_ready_uid', briefId: 'chat_framework_routine_ready_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_routine_ready_uid',
        'X-Trace-ID': 'trace_chat_framework_routine_ready',
        'X-Brief-ID': 'chat_framework_routine_ready_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.primary_target_id, 'oil_control_treatment');
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 3);
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'oil_control_treatment'));
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'lightweight_moisturizer'));
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'daily_sunscreen'));
    const suggestedChipIds = (Array.isArray(response.body?.suggested_chips) ? response.body.suggested_chips : [])
      .map((chip) => String(chip?.chip_id || '').trim())
      .filter(Boolean);
    assert.ok(
      suggestedChipIds.includes('chip.start.routine')
      || suggestedChipIds.includes('chip.action.reco_routine')
      || suggestedChipIds.includes('tpl.action.routine_generate'),
    );
  } finally {
    harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
    harness?.restore?.();
  }
});

staleFallbackPlannerTest('/v1/chat: generic oily-skin ask keeps framework recommendations when the llm primary returns schema-invalid output', async () => {
  let harness = null;
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_PRODUCT_INTEL_LLM_PROVIDER: 'gemini',
      AURORA_PRODUCT_INTEL_LLM_MODEL: 'gemini-3-flash-preview',
    },
    async () => {
      harness = createAppWithPatchedAuroraChat({
        auroraChatImpl: buildConcernPlannerMock({ selectorResult: 'schema_invalid' }),
        geminiJsonImpl: buildConcernPlannerGeminiJsonMock({
          rewriteAssistantText:
            'For oily skin, start with Clarity Lab Oil Balance Serum for oil control. Keep LightLab Air Gel Cream and SunGuard Daily UV Fluid SPF 50 as lightweight support steps.',
        }),
        geminiTextImpl: buildConcernPlannerGeminiTextMock({
          plainText: buildConcernPlannerTextFixture(),
        }),
        useMemoryStore: false,
      });
      harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
        searchInternalProductsPrimitive: buildConcernFrameworkInternalSearchOverride({
          primaryProducts: [
            {
              product_id: 'serum_schema_1',
              merchant_id: 'mid_serum_schema',
              brand: 'Clarity Lab',
              name: 'Oil Balance Serum',
              display_name: 'Oil Balance Serum',
              category: 'serum',
              product_type: 'serum',
              benefit_tags: ['oil control', 'shine control'],
              search_aliases: ['Oil Control Serum'],
              short_description: 'A mattifying oil-control serum for oily skin.',
            },
          ],
          moisturizerProducts: [
            {
              product_id: 'moist_schema_1',
              merchant_id: 'mid_moist_schema',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
          sunscreenProducts: [
            {
              product_id: 'spf_schema_1',
              merchant_id: 'mid_spf_schema',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        }),
      });

      try {
        await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_schema_uid', briefId: 'chat_framework_schema_brief' });
        const response = await harness.request
          .post('/v1/chat')
          .set({
            'X-Aurora-UID': 'chat_framework_schema_uid',
            'X-Trace-ID': 'trace_chat_framework_schema',
            'X-Brief-ID': 'chat_framework_schema_brief',
          })
          .send({
            action: {
              action_id: 'chip.start.reco_products',
              kind: 'chip',
              data: {
                reply_text: 'im oily skin, what product should i use?',
                profile_patch: {
                  skinType: 'oily',
                  sensitivity: 'low',
                  barrierStatus: 'stable',
                  goals: ['oil control'],
                },
              },
            },
            client_state: 'IDLE_CHAT',
            session: { state: 'idle' },
            language: 'EN',
          });

        assert.equal(response.statusCode, 200);
        const payload = getRecommendationsPayload(response.body);
        assert.ok(payload);
        assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 3);
        assert.equal(payload.recommendation_meta?.owner_source, 'shopping_agent_beauty_mainline');
        assert.equal(payload.recommendation_meta?.primary_target_id, 'oil_control_treatment');
        assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
        assert.equal(payload.recommendation_meta?.source_mode, 'framework_mainline');
        assert.equal(payload.recommendation_meta?.assistant_rewrite_llm_used, true);
        assert.equal(payload.open_world_expansion_used ?? false, false);
        assert.equal(payload.selector_race ?? null, null);
        assert.equal(payload.recommendations[0]?.product_id, 'serum_schema_1');
        assert.equal(payload.recommendations[0]?.matched_role_id, 'oil_control_treatment');
        assert.match(
          String(response.body?.assistant_message?.content || response.body?.assistant_text || ''),
          /Clarity Lab Oil Balance Serum for oil control/i,
        );
      } finally {
        harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
        harness?.restore?.();
      }
    },
  );
});

staleFallbackPlannerTest('/v1/chat: generic concern planner accepts keyed plain-text semantic-plan output and stays on the trusted mainline', async () => {
  const originalGet = axios.get;
  let harness = null;

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'spf_camel_1',
              merchant_id: 'mid_spf_camel',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'moist_camel_1',
              merchant_id: 'mid_moist_camel',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
        },
      };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'serum_camel_1',
            merchant_id: 'mid_serum_camel',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            benefit_tags: ['oil control', 'shine control'],
            search_aliases: ['Oil Control Serum'],
            short_description: 'A mattifying oil-control serum for oily skin.',
          },
        ],
      },
    };
  };

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: buildConcernPlannerMock(),
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: buildConcernPlannerTextFixture(),
      }),
      useMemoryStore: false,
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_camel_uid', briefId: 'chat_framework_camel_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_camel_uid',
        'X-Trace-ID': 'trace_chat_framework_camel',
        'X-Brief-ID': 'chat_framework_camel_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.selection_owner_source, 'llm_concern_planner');
    assert.equal(payload.recommendation_meta?.semantic_planner_owner_state ?? payload.recommendation_meta?.framework_owner_state, 'trusted');
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendations?.[0]?.product_id, 'serum_camel_1');
    assert.ok(Array.isArray(payload.support_roles));
    assert.equal(payload.support_roles.length, 0);
  } finally {
    harness?.restore?.();
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern planner repairs plain-text role ordering into a trusted semantic plan', async () => {
  const originalGet = axios.get;
  let harness = null;

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'spf_text_1',
              merchant_id: 'mid_spf_text',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'moist_text_1',
              merchant_id: 'mid_moist_text',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
        },
      };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'serum_text_1',
            merchant_id: 'mid_serum_text',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            benefit_tags: ['oil control', 'shine control'],
            search_aliases: ['Oil Control Serum'],
            short_description: 'A mattifying oil-control serum for oily skin.',
          },
        ],
      },
    };
  };

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: async ({ query = '' } = {}) => {
        const prompt = String(query || '');
        if (prompt.includes('PROMPT_VERSION=concern_selector_race_v1')) {
          return { answer: JSON.stringify(buildConcernSelectorFixture({ topPickProductId: 'serum_text_1', orderedProductIds: ['serum_text_1', 'moist_text_1', 'spf_text_1'] })) };
        }
        return { answer: JSON.stringify({ note: 'unexpected prompt' }) };
      },
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: 'Priority order: Oil-control treatment -> Lightweight moisturizer -> Daily sunscreen. Optional support: Optional hydrating mask if oily skin also feels dehydrated.',
      }),
      useMemoryStore: false,
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_text_uid', briefId: 'chat_framework_text_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_text_uid',
        'X-Trace-ID': 'trace_chat_framework_text',
        'X-Brief-ID': 'chat_framework_text_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.selection_owner_source, 'llm_concern_planner');
    assert.equal(payload.recommendation_meta?.framework_owner_state, 'trusted');
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendations?.[0]?.product_id, 'serum_text_1');
  } finally {
    harness?.restore?.();
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern planner trusts prose-only Gemini planner output when core-role semantics are explicit', async () => {
  const originalGet = axios.get;
  let harness = null;

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'spf_prose_1',
              merchant_id: 'mid_spf_prose',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'moist_prose_1',
              merchant_id: 'mid_moist_prose',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
        },
      };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'serum_prose_1',
            merchant_id: 'mid_serum_prose',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            benefit_tags: ['oil control', 'shine control'],
            search_aliases: ['Oil Control Serum'],
            short_description: 'A mattifying oil-control serum for oily skin.',
          },
        ],
      },
    };
  };

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: async ({ query = '' } = {}) => {
        const prompt = String(query || '');
        if (prompt.includes('PROMPT_VERSION=concern_selector_race_v1')) {
          return {
            answer: JSON.stringify(
              buildConcernSelectorFixture({
                topPickProductId: 'serum_prose_1',
                orderedProductIds: ['serum_prose_1', 'moist_prose_1', 'spf_prose_1'],
              }),
            ),
          };
        }
        return { answer: JSON.stringify({ note: 'unexpected prompt' }) };
      },
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: 'Since you have oily skin, are prone to acne, and have a stable skin barrier with low sensitivity, start with a niacinamide or salicylic-acid treatment to control shine and congestion. Follow with a lightweight moisturizer to keep hydration breathable without feeling heavy. During the day, finish with a daily sunscreen for UV protection.',
      }),
      useMemoryStore: false,
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_prose_uid', briefId: 'chat_framework_prose_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_prose_uid',
        'X-Trace-ID': 'trace_chat_framework_prose',
        'X-Brief-ID': 'chat_framework_prose_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.selection_owner_source, 'llm_concern_planner');
    assert.equal(payload.recommendation_meta?.framework_owner_state, 'trusted');
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendations?.[0]?.product_id, 'serum_prose_1');
  } finally {
    harness?.restore?.();
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern planner retries with gemini pro after an empty gemini flash planner response', async () => {
  const originalGet = axios.get;
  let harness = null;
  const plannerAttempts = [];

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'spf_retry_1',
              merchant_id: 'mid_spf_retry',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'moist_retry_1',
              merchant_id: 'mid_moist_retry',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
        },
      };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'serum_retry_1',
            merchant_id: 'mid_serum_retry',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            benefit_tags: ['oil control', 'shine control'],
            search_aliases: ['Oil Control Serum'],
            short_description: 'A mattifying oil-control serum for oily skin.',
          },
        ],
      },
    };
  };

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: async ({ query = '' } = {}) => {
        const prompt = String(query || '');
        if (prompt.includes('PROMPT_VERSION=concern_selector_race_v1')) {
          return { answer: JSON.stringify(buildConcernSelectorFixture({ topPickProductId: 'serum_retry_1', orderedProductIds: ['serum_retry_1', 'moist_retry_1', 'spf_retry_1'] })) };
        }
        return { answer: JSON.stringify({ note: 'unexpected prompt' }) };
      },
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainTextByModel: {
          'gemini-3-flash-preview': '',
          'gemini-3-pro-preview': buildConcernPlannerTextFixture(),
        },
        attemptRecorder: ({ model, structured_contract }) => plannerAttempts.push(`gemini:${model}:${structured_contract}`),
      }),
      useMemoryStore: false,
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_retry_uid', briefId: 'chat_framework_retry_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_retry_uid',
        'X-Trace-ID': 'trace_chat_framework_retry',
        'X-Brief-ID': 'chat_framework_retry_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.selection_owner_source, 'llm_concern_planner');
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendations?.[0]?.product_id, 'serum_retry_1');
    assert.equal(payload.recommendation_meta?.semantic_planner_requested_provider, 'gemini');
    assert.equal(payload.recommendation_meta?.semantic_planner_requested_model, 'gemini-3-pro-preview');
    assert.equal(payload.recommendation_meta?.semantic_planner_effective_provider, 'gemini');
    assert.equal(payload.recommendation_meta?.semantic_planner_effective_model, 'gemini-3-pro-preview');
    assert.equal(payload.recommendation_meta?.semantic_planner_selection_source, 'test_mock');
    assert.deepEqual(plannerAttempts, [
      'gemini:gemini-3-flash-preview:plain_text',
      'gemini:gemini-3-pro-preview:plain_text',
    ]);
  } finally {
    harness?.restore?.();
    axios.get = originalGet;
  }
});


staleFallbackPlannerTest('/v1/chat: generic concern planner retries with gemini pro after an untrusted gemini flash prose response', async () => {
  const originalGet = axios.get;
  let harness = null;
  const plannerAttempts = [];

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'spf_trunc_1',
              merchant_id: 'mid_spf_trunc',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'moist_trunc_1',
              merchant_id: 'mid_moist_trunc',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
        },
      };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'serum_trunc_1',
            merchant_id: 'mid_serum_trunc',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            benefit_tags: ['oil control', 'shine control'],
            search_aliases: ['Oil Control Serum'],
            short_description: 'A mattifying oil-control serum for oily skin.',
          },
        ],
      },
    };
  };

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: async ({ query = '' } = {}) => {
        const prompt = String(query || '');
        if (prompt.includes('PROMPT_VERSION=concern_selector_race_v1')) {
          return { answer: JSON.stringify(buildConcernSelectorFixture({ topPickProductId: 'serum_trunc_1', orderedProductIds: ['serum_trunc_1', 'moist_trunc_1', 'spf_trunc_1'] })) };
        }
        return { answer: JSON.stringify({ note: 'unexpected prompt' }) };
      },
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainTextByModel: {
          'gemini-3-flash-preview': 'Start with a few lightweight skincare products for oily skin.',
          'gemini-3-pro-preview': buildConcernPlannerTextFixture(),
        },
        attemptRecorder: ({ model, structured_contract }) => plannerAttempts.push(`gemini:${String(model || '').trim()}:${structured_contract}`),
      }),
      useMemoryStore: false,
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_trunc_uid', briefId: 'chat_framework_trunc_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_trunc_uid',
        'X-Trace-ID': 'trace_chat_framework_trunc',
        'X-Brief-ID': 'chat_framework_trunc_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.selection_owner_source, 'llm_concern_planner');
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendations?.[0]?.product_id, 'serum_trunc_1');
    assert.deepEqual(plannerAttempts, [
      'gemini:gemini-3-flash-preview:plain_text',
      'gemini:gemini-3-pro-preview:plain_text',
    ]);
  } finally {
    harness?.restore?.();
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern planner records model telemetry from a successful gemini pro text retry', async () => {
  const originalGet = axios.get;
  let harness = null;
  const plannerAttempts = [];

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'spf_plain_1',
              merchant_id: 'mid_spf_plain',
              brand: 'SunGuard',
              name: 'Daily UV Fluid SPF 50',
              display_name: 'Daily UV Fluid SPF 50',
              category: 'sunscreen',
              product_type: 'sunscreen',
            },
          ],
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'moist_plain_1',
              merchant_id: 'mid_moist_plain',
              brand: 'LightLab',
              name: 'Air Gel Cream',
              display_name: 'Air Gel Cream',
              category: 'moisturizer',
              product_type: 'gel cream',
            },
          ],
        },
      };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'serum_plain_1',
            merchant_id: 'mid_serum_plain',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            benefit_tags: ['oil control', 'shine control'],
            search_aliases: ['Oil Control Serum'],
            short_description: 'A mattifying oil-control serum for oily skin.',
          },
        ],
      },
    };
  };

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: async ({ query = '' } = {}) => {
        const prompt = String(query || '');
        if (prompt.includes('PROMPT_VERSION=concern_selector_race_v1')) {
          return {
            answer: JSON.stringify(
              buildConcernSelectorFixture({
                topPickProductId: 'serum_plain_1',
                orderedProductIds: ['serum_plain_1', 'moist_plain_1', 'spf_plain_1'],
              }),
            ),
          };
        }
        return { answer: JSON.stringify({ note: 'unexpected prompt' }) };
      },
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainTextByModel: {
          'gemini-3-flash-preview': '',
          'gemini-3-pro-preview': buildConcernPlannerTextFixture(),
        },
        attemptRecorder: ({ model, structured_contract }) => plannerAttempts.push(`gemini:${model}:${structured_contract}`),
      }),
      useMemoryStore: false,
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_plain_uid', briefId: 'chat_framework_plain_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_plain_uid',
        'X-Trace-ID': 'trace_chat_framework_plain',
        'X-Brief-ID': 'chat_framework_plain_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.selection_owner_source, 'llm_concern_planner');
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendations?.[0]?.product_id, 'serum_plain_1');
    assert.equal(payload.recommendation_meta?.semantic_planner_requested_model, 'gemini-3-pro-preview');
    assert.equal(payload.recommendation_meta?.semantic_planner_effective_model, 'gemini-3-pro-preview');
    assert.equal(payload.recommendation_meta?.semantic_planner_selection_source, 'test_mock');
    assert.deepEqual(plannerAttempts, [
      'gemini:gemini-3-flash-preview:plain_text',
      'gemini:gemini-3-pro-preview:plain_text',
    ]);
  } finally {
    harness?.restore?.();
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern planner falls back to deterministic mainline when both flash and pro prose remain untrusted', async () => {
  let harness = null;
  const plannerAttempts = [];
  const observedSearchCalls = [];

  try {
    harness = createAppWithPatchedAuroraChat({
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainTextByModel: {
          'gemini-3-flash-preview': 'Use a few lightweight products for oily skin.',
          'gemini-3-pro-preview': 'Maybe start with a breathable routine and adjust later.',
        },
        attemptRecorder: ({ model, structured_contract }) => plannerAttempts.push(`gemini:${model}:${structured_contract}`),
      }),
      useMemoryStore: false,
    });
    harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args = {}) => {
        observedSearchCalls.push({
          query: String(args?.query || '').trim().toLowerCase(),
          callerLane: String(args?.callerLane || ''),
          targetStepFamily: String(args?.targetStepFamily || ''),
          semanticFamily: String(args?.semanticFamily || ''),
          queryStepStrength: String(args?.queryStepStrength || ''),
        });
        const query = String(args?.query || '').trim().toLowerCase();
        if (/(oil control|shine control)/.test(query)) {
          return buildInternalPrimitiveSearchSuccess([
            buildBroadOilyInternalPrimitiveProduct({
              productId: 'serum_invalid_1',
              merchantId: 'mid_serum_invalid',
            }),
          ]);
        }
        return buildInternalPrimitiveSearchSuccess([]);
      },
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_invalid_uid', briefId: 'chat_framework_invalid_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_invalid_uid',
        'X-Trace-ID': 'trace_chat_framework_invalid',
        'X-Brief-ID': 'chat_framework_invalid_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.equal(
      recoEvent?.data?.recommendation_meta?.source_mode || recoEvent?.data?.source_mode,
      'framework_mainline',
    );
    assert.equal(response.body.cards.some((card) => card?.type === 'confidence_notice'), false);
    assert.ok(
      observedSearchCalls.some((entry) =>
        entry.callerLane === 'beauty_chat_handoff'
        && entry.targetStepFamily === 'serum'
        && entry.semanticFamily === 'oil_control_treatment'
        && entry.queryStepStrength === 'strong_goal_family'
        && /(oil control|shine control)/.test(entry.query)
      ),
      JSON.stringify(observedSearchCalls),
    );
    assert.deepEqual(plannerAttempts, [
      'gemini:gemini-3-flash-preview:plain_text',
      'gemini:gemini-3-pro-preview:plain_text',
    ]);
  } finally {
    harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
    harness?.restore?.();
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern planner junk prose output falls back to deterministic mainline', async () => {
  let harness = null;
  const observedSearchCalls = [];

  try {
    harness = createAppWithPatchedAuroraChat({
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: 'A few products could help oily skin, but I need to think more.',
      }),
      useMemoryStore: false,
    });
    harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args = {}) => {
        observedSearchCalls.push({
          query: String(args?.query || '').trim().toLowerCase(),
          callerLane: String(args?.callerLane || ''),
          targetStepFamily: String(args?.targetStepFamily || ''),
          semanticFamily: String(args?.semanticFamily || ''),
          queryStepStrength: String(args?.queryStepStrength || ''),
        });
        const query = String(args?.query || '').trim().toLowerCase();
        if (/(oil control|shine control)/.test(query)) {
          return buildInternalPrimitiveSearchSuccess([
            buildBroadOilyInternalPrimitiveProduct({
              productId: 'serum_junk_1',
              merchantId: 'mid_serum_junk',
            }),
          ]);
        }
        return buildInternalPrimitiveSearchSuccess([]);
      },
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_junk_uid', briefId: 'chat_framework_junk_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_junk_uid',
        'X-Trace-ID': 'trace_chat_framework_junk',
        'X-Brief-ID': 'chat_framework_junk_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.equal(
      recoEvent?.data?.recommendation_meta?.source_mode || recoEvent?.data?.source_mode,
      'framework_mainline',
    );
    assert.equal(response.body.cards.some((card) => card?.type === 'confidence_notice'), false);
    assert.ok(
      observedSearchCalls.some((entry) =>
        entry.callerLane === 'beauty_chat_handoff'
        && entry.targetStepFamily === 'serum'
        && entry.semanticFamily === 'oil_control_treatment'
        && entry.queryStepStrength === 'strong_goal_family'
        && /(oil control|shine control)/.test(entry.query)
      ),
      JSON.stringify(observedSearchCalls),
    );
  } finally {
    harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
    harness?.restore?.();
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern planner timeout falls back to deterministic mainline when budget remains', async () => {
  let harness = null;
  const observedSearchCalls = [];

  try {
    harness = createAppWithPatchedAuroraChat({
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        throwOnConcernPrompt: true,
      }),
      useMemoryStore: false,
    });
    harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args = {}) => {
        observedSearchCalls.push({
          query: String(args?.query || '').trim().toLowerCase(),
          callerLane: String(args?.callerLane || ''),
          targetStepFamily: String(args?.targetStepFamily || ''),
          semanticFamily: String(args?.semanticFamily || ''),
          queryStepStrength: String(args?.queryStepStrength || ''),
        });
        const query = String(args?.query || '').trim().toLowerCase();
        if (/(oil control|shine control)/.test(query)) {
          return buildInternalPrimitiveSearchSuccess([
            buildBroadOilyInternalPrimitiveProduct({
              productId: 'serum_timeout_1',
              merchantId: 'mid_serum_timeout',
            }),
          ]);
        }
        return buildInternalPrimitiveSearchSuccess([]);
      },
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_timeout_uid', briefId: 'chat_framework_timeout_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_timeout_uid',
        'X-Trace-ID': 'trace_chat_framework_timeout',
        'X-Brief-ID': 'chat_framework_timeout_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.equal(
      recoEvent?.data?.recommendation_meta?.source_mode || recoEvent?.data?.source_mode,
      'framework_mainline',
    );
    assert.equal(response.body.cards.some((card) => card?.type === 'confidence_notice'), false);
    assert.ok(
      observedSearchCalls.some((entry) =>
        entry.callerLane === 'beauty_chat_handoff'
        && entry.targetStepFamily === 'serum'
        && entry.semanticFamily === 'oil_control_treatment'
        && entry.queryStepStrength === 'strong_goal_family'
        && /(oil control|shine control)/.test(entry.query)
      ),
      JSON.stringify(observedSearchCalls),
    );
  } finally {
    harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
    harness?.restore?.();
  }
});

staleFallbackPlannerTest('/v1/chat: freeform beauty reco carries request context profile into assistant text', async () => {
  let harness = null;

  try {
    harness = createAppWithPatchedAuroraChat({
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        throwOnConcernPrompt: true,
      }),
      useMemoryStore: false,
    });
    harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args = {}) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (/(oil control|shine control)/.test(query)) {
          return buildInternalPrimitiveSearchSuccess([
            buildBroadOilyInternalPrimitiveProduct({
              productId: 'serum_freeform_profile_1',
              merchantId: 'mid_freeform_profile',
            }),
          ]);
        }
        return buildInternalPrimitiveSearchSuccess([]);
      },
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_freeform_profile_uid', briefId: 'chat_freeform_profile_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_freeform_profile_uid',
        'X-Trace-ID': 'trace_chat_freeform_profile',
        'X-Brief-ID': 'chat_freeform_profile_brief',
      })
      .send({
        message: 'im oily skin, what products should i use?',
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    const assistantText = String(response.body?.assistant_message?.content || response.body?.assistant_text || '');
    assert.match(assistantText, /Context:\s*oily \/ low sensitivity \/ stable; Goals: oil control\./i);
    assert.doesNotMatch(assistantText, /pending/i);
  } finally {
    harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
    harness?.restore?.();
  }
});

staleFallbackPlannerTest('/v1/chat: action beauty reco carries profile patch into assistant text', async () => {
  let harness = null;

  try {
    harness = createAppWithPatchedAuroraChat({
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        throwOnConcernPrompt: true,
      }),
      useMemoryStore: false,
    });
    harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: async (args = {}) => {
        const query = String(args?.query || '').trim().toLowerCase();
        if (/(oil control|shine control)/.test(query)) {
          return buildInternalPrimitiveSearchSuccess([
            buildBroadOilyInternalPrimitiveProduct({
              productId: 'serum_action_profile_1',
              merchantId: 'mid_action_profile',
            }),
          ]);
        }
        return buildInternalPrimitiveSearchSuccess([]);
      },
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_action_profile_uid', briefId: 'chat_action_profile_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_action_profile_uid',
        'X-Trace-ID': 'trace_chat_action_profile',
        'X-Brief-ID': 'chat_action_profile_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    const assistantText = String(response.body?.assistant_message?.content || response.body?.assistant_text || '');
    assert.match(assistantText, /Context:\s*oily \/ low sensitivity \/ stable; Goals: oil control\./i);
    assert.doesNotMatch(assistantText, /pending/i);
  } finally {
    harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
    harness?.restore?.();
  }
});

staleFallbackPlannerTest('/v1/chat: generic oily-skin ask does not surface support-only fallback recommendations when the primary role is unmatched', async () => {
  const observedSearchParams = [];
  let harness = null;

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: buildConcernPlannerMock({
        selectorResult: buildConcernSelectorFixture({
          topPickProductId: null,
          orderedProductIds: ['moist_partial_1', 'spf_partial_1'],
        }),
      }),
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: buildConcernPlannerTextFixture(),
      }),
      useMemoryStore: false,
    });
    harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
      searchInternalProductsPrimitive: buildConcernFrameworkInternalSearchOverride({
        observe: (args = {}) => {
          observedSearchParams.push({
            query: String(args?.query || '').trim().toLowerCase(),
            allow_external_seed: args?.allowExternalSeed === true,
            external_seed_strategy: String(args?.externalSeedStrategy || '').trim().toLowerCase() || null,
          });
        },
        primaryProducts: [],
        moisturizerProducts: [
          {
            product_id: 'moist_partial_1',
            merchant_id: 'mid_moist_partial',
            brand: 'LightLab',
            name: 'Air Gel Cream',
            display_name: 'Air Gel Cream',
            category: 'moisturizer',
            product_type: 'gel cream',
          },
        ],
        sunscreenProducts: [
          {
            product_id: 'spf_partial_1',
            merchant_id: 'mid_spf_partial',
            brand: 'SunGuard',
            name: 'Daily UV Fluid SPF 50',
            display_name: 'Daily UV Fluid SPF 50',
            category: 'sunscreen',
            product_type: 'sunscreen',
          },
        ],
      }),
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_partial_uid', briefId: 'chat_framework_partial_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_partial_uid',
        'X-Trace-ID': 'trace_chat_framework_partial',
        'X-Brief-ID': 'chat_framework_partial_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const noticeCard = cards.find((card) => card?.type === 'confidence_notice');
    assert.ok(noticeCard);
    assert.equal(noticeCard?.payload?.reason, 'weak_viable_pool');
    assert.match(
      String(response.body?.assistant_text || ''),
      /(borderline matches|not forcing a product pick)/i,
    );
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.equal(
      recoEvent?.data?.source || recoEvent?.data?.source_detail,
      'beauty_mainline_handoff',
    );
    assert.equal(recoEvent?.data?.failure_class, 'weak_viable_pool');
    assert.equal(recoEvent?.data?.surface_reason, 'weak_viable_pool');
    assert.ok(observedSearchParams.length >= 1);
    assert.ok(observedSearchParams.some((row) => /oil control|shine control/.test(row.query)));
    assert.ok(observedSearchParams.some((row) => /(sunscreen|spf|moisturizer|gel cream|lotion)/.test(row.query)));
    assert.ok(observedSearchParams.every((row) => row.allow_external_seed !== true));
  } finally {
    harness?.routesMod?.__internal?.__resetRouteDependencyOverridesForTest?.();
    harness?.restore?.();
  }
});

staleFallbackPlannerTest('/v1/chat: framework retrieval supplements missing support-role searches with external-seed fallback while preserving the external top pick', async () => {
  const originalGet = axios.get;
  const originalDbQuery = dbModule.query;
  const originalFallbackEnabled = process.env.AURORA_PURCHASABLE_FALLBACK_ENABLED;
  const originalExternalSeedEnabled = process.env.AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED;
  process.env.AURORA_PURCHASABLE_FALLBACK_ENABLED = 'false';
  process.env.AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED = 'true';
  const observedQueries = [];
  let harness = null;

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    const allowExternalSeed = config?.params?.allow_external_seed === true;
    const externalSeedStrategy = String(config?.params?.external_seed_strategy || '').trim().toLowerCase();
    const fastMode = config?.params?.fast_mode;
    observedQueries.push({ query, allowExternalSeed, externalSeedStrategy, fastMode });

    if (query.includes('oil control') && !query.includes('sunscreen') && !query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'int_niac_1',
              merchant_id: 'merchant_int_oil',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              category: 'serum',
              product_type: 'serum',
              ingredient_tokens: ['niacinamide'],
            },
          ],
        },
      };
    }

    if (query.includes('lightweight moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      if (allowExternalSeed) {
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_moist_1',
                merchant_id: 'merchant_ext_moist',
                brand: 'Laneige',
                name: 'Water Bank Gel Cream',
                display_name: 'Laneige Water Bank Gel Cream',
                category: 'moisturizer',
                product_type: 'gel cream',
                source: 'external_seed',
                url: 'https://example.com/laneige-gel-cream',
                ingredient_tokens: ['glycerin', 'squalane'],
                benefit_tags: ['lightweight moisturizer', 'oil-free', 'breathable hydration'],
                search_aliases: ['lightweight moisturizer', 'gel cream for oily skin'],
                short_description: 'A lightweight gel-cream moisturizer for oily skin.',
                tag_tokens: ['lightweight moisturizer', 'oil-free', 'breathable hydration'],
              },
            ],
          },
        };
      }
      return { status: 200, data: { products: [] } };
    }

    if (query.includes('sunscreen') || query.includes('spf')) {
      if (allowExternalSeed) {
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'ext_spf_1',
                merchant_id: 'merchant_ext_spf',
                brand: 'Supergoop',
                name: 'Unseen Sunscreen SPF 40',
                display_name: 'Supergoop Unseen Sunscreen SPF 40',
                category: 'sunscreen',
                product_type: 'sunscreen',
                source: 'external_seed',
                url: 'https://example.com/supergoop-unseen',
                ingredient_tokens: ['uv filters'],
                benefit_tags: ['spf', 'broad spectrum', 'lightweight sunscreen'],
                search_aliases: ['daily sunscreen', 'broad spectrum sunscreen'],
                short_description: 'A lightweight broad-spectrum sunscreen for oily skin.',
                tag_tokens: ['daily sunscreen', 'broad spectrum', 'lightweight sunscreen'],
              },
            ],
          },
        };
      }
      return { status: 200, data: { products: [] } };
    }

    return { status: 200, data: { products: [] } };
  };
  dbModule.query = async () => ({
    rows: [
      {
        id: 'seed_ext_oil_1',
        external_product_id: 'ext_oil_1',
        destination_url: 'https://example.com/fenty-oil-control-serum',
        canonical_url: 'https://example.com/fenty-oil-control-serum',
        domain: 'example.com',
        title: 'Fenty Skin Oil Control Serum',
        image_url: 'https://example.com/fenty-oil-control-serum.jpg',
        price_amount: '38',
        price_currency: 'USD',
        availability: 'in_stock',
        seed_data: {
          brand: 'Fenty Skin',
          category: 'Serum',
          search_aliases: ['oil control serum', 'shine control serum'],
          benefit_tags: ['oil control', 'shine control', 'mattifying'],
          short_description: 'Mattifying oil control serum for oily skin.',
          skin_type_tags: ['oily'],
          snapshot: {
            title: 'Fenty Skin Oil Control Serum',
            canonical_url: 'https://example.com/fenty-oil-control-serum',
            destination_url: 'https://example.com/fenty-oil-control-serum',
          },
        },
      },
    ],
  });

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: async ({ query = '' } = {}) => {
        const prompt = String(query || '');
        if (prompt.includes('PROMPT_VERSION=concern_selector_race_v1')) {
          return {
            answer: JSON.stringify(
              buildConcernSelectorFixture({
                topPickProductId: 'ext_oil_1',
                orderedProductIds: ['ext_oil_1'],
              }),
            ),
          };
        }
        return { answer: JSON.stringify({ note: 'unexpected prompt' }) };
      },
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: buildConcernPlannerTextFixture(),
      }),
      useMemoryStore: false,
    });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_seed_uid', briefId: 'chat_framework_seed_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_seed_uid',
        'X-Trace-ID': 'trace_chat_framework_seed',
        'X-Brief-ID': 'chat_framework_seed_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 3);
    assert.equal(payload.recommendations[0]?.product_id, 'ext_oil_1');
    assert.equal(payload.recommendations[0]?.retrieval_source, 'external_seed');
    assert.ok(payload.recommendations.some((item) => item?.retrieval_source === 'external_seed'));
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'lightweight_moisturizer'));
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'daily_sunscreen'));
    const suggestedChipIds = (Array.isArray(response.body?.suggested_chips) ? response.body.suggested_chips : [])
      .map((chip) => String(chip?.chip_id || '').trim())
      .filter(Boolean);
    assert.ok(
      suggestedChipIds.includes('chip.start.routine')
      || suggestedChipIds.includes('chip.action.reco_routine')
      || suggestedChipIds.includes('tpl.action.routine_generate'),
    );
    assert.ok(observedQueries.length <= 6);
    assert.ok(observedQueries.some((entry) => entry.allowExternalSeed === true && /(moisturizer|gel cream|lotion)/.test(entry.query)));
    assert.ok(observedQueries.some((entry) => entry.allowExternalSeed === true && /(sunscreen|spf)/.test(entry.query)));
    assert.ok(Number(payload.recommendation_meta?.executed_query_count || 0) <= 8);
    assert.ok(Number(payload.recommendation_meta?.executed_upstream_attempt_count || 0) <= 6);
    assert.ok(Number(payload.recommendation_meta?.external_seed_used_count || 0) > 0);
    assert.ok(Number(payload.recommendation_meta?.selected_source_counts?.external_seed || 0) > 0);
  } finally {
    harness?.restore?.();
    if (originalFallbackEnabled == null) delete process.env.AURORA_PURCHASABLE_FALLBACK_ENABLED;
    else process.env.AURORA_PURCHASABLE_FALLBACK_ENABLED = originalFallbackEnabled;
    if (originalExternalSeedEnabled == null) delete process.env.AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED;
    else process.env.AURORA_EXTERNAL_SEED_SUPPLEMENT_ENABLED = originalExternalSeedEnabled;
    dbModule.query = originalDbQuery;
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('__internal: framework recall planner emits role-aware primary and support stages before declaring framework coverage satisfied', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext: {
      framework_summary: {
        concern_text: 'im oily skin, what product should i use?',
      },
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
        },
        {
          role_id: 'lightweight_moisturizer',
          rank: 2,
          preferred_step: 'moisturizer',
          query_terms: ['lightweight moisturizer', 'gel cream', 'oil free moisturizer'],
        },
        {
          role_id: 'daily_sunscreen',
          rank: 3,
          preferred_step: 'sunscreen',
          query_terms: ['daily sunscreen', 'lightweight sunscreen', 'spf fluid'],
        },
      ],
    },
  });

  assert.equal(plan.mode, 'framework_generic');
  assert.equal(plan.version, 'aurora_reco_recall_plan_v1');
  assert.ok(Array.isArray(plan.stages));
  assert.equal(plan.stages.length, 6);
  assert.ok(Array.isArray(plan.entries));
  assert.equal(plan.entries.length, 16);
  assert.deepEqual(
    plan.stages.map((stage) => [stage.stage_id, stage.source_scope, stage.role_id, stage.entries.length]),
    [
      ['framework_stage_a_primary_internal', 'internal', 'oil_control_treatment', 3],
      ['framework_stage_b_primary_external_seed', 'external_seed', 'oil_control_treatment', 4],
      ['framework_stage_c_support_lightweight_moisturizer', 'internal', 'lightweight_moisturizer', 2],
      ['framework_stage_c_support_lightweight_moisturizer_external_seed', 'external_seed', 'lightweight_moisturizer', 2],
      ['framework_stage_c_support_daily_sunscreen', 'internal', 'daily_sunscreen', 3],
      ['framework_stage_c_support_daily_sunscreen_external_seed', 'external_seed', 'daily_sunscreen', 2],
    ],
  );
  assert.deepEqual(plan.stages[0]?.entries?.map((entry) => entry?.query), [
    'oil control serum',
    'shine control serum',
    'mattifying serum',
  ]);
  assert.deepEqual(plan.stages[1]?.entries?.map((entry) => entry?.query), [
    'oil control treatment',
    'niacinamide serum oily skin',
    'salicylic acid serum oily skin',
    'oil control serum',
  ]);
  assert.deepEqual(plan.stages[2]?.entries?.map((entry) => entry?.query), [
    'lightweight moisturizer oily skin',
    'oil free moisturizer',
  ]);
  assert.deepEqual(plan.stages[3]?.entries?.map((entry) => entry?.query), [
    'lightweight moisturizer oily skin',
    'oil free moisturizer',
  ]);
  assert.deepEqual(plan.stages[4]?.entries?.map((entry) => entry?.query), [
    'oil control sunscreen',
    'lightweight sunscreen oily skin',
    'spf fluid oily skin',
  ]);
  assert.deepEqual(plan.stages[5]?.entries?.map((entry) => entry?.query), [
    'oil control sunscreen',
    'lightweight sunscreen oily skin',
  ]);
});

staleFallbackPlannerTest('__internal: framework recall planner prefers oil-control ingredient-led serum query when active hints are available', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext: {
      framework_summary: {
        concern_text: 'im oily skin, what product should i use?',
      },
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
          query_terms: ['oil control serum', 'shine control serum', 'mattifying serum'],
          ingredient_hypotheses: ['Niacinamide', 'Salicylic acid'],
        },
      ],
    },
  });

  assert.deepEqual(plan.stages[0]?.entries?.map((entry) => entry?.query), [
    'niacinamide serum oily skin',
    'oil control serum',
    'shine control serum',
  ]);
  assert.deepEqual(plan.stages[1]?.entries?.map((entry) => entry?.query), [
    'oil control treatment',
    'niacinamide serum oily skin',
    'salicylic acid serum oily skin',
    'oil control serum',
  ]);
});

test('__internal: framework recall planner emits hydrating serum support queries instead of falling back to primary contract queries', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext: {
      primary_role_id: 'hydrating_barrier_moisturizer',
      framework_summary: {
        concern_text: 'my skin feels dry and tight after washing, what should i use first?',
      },
      semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
      framework_roles: [
        {
          role_id: 'hydrating_barrier_moisturizer',
          rank: 1,
          preferred_step: 'moisturizer',
          query_terms: ['hydrating moisturizer dry skin', 'barrier repair moisturizer', 'ceramide cream sensitive skin'],
          fit_keywords: ['hydrating', 'barrier repair', 'ceramide', 'dry skin'],
        },
        {
          role_id: 'hydrating_serum_or_essence',
          rank: 2,
          preferred_step: 'serum',
          query_terms: ['hydrating serum dehydrated skin', 'hyaluronic acid serum', 'hydrating essence dull skin'],
          fit_keywords: ['hydrating', 'dehydrated', 'hyaluronic acid', 'essence', 'plumping'],
        },
        {
          role_id: 'daily_sunscreen',
          rank: 3,
          preferred_step: 'sunscreen',
          query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
          fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
        },
      ],
    },
  });

  const hydratingSerumStages = plan.stages.filter((stage) => stage?.role_id === 'hydrating_serum_or_essence');
  assert.equal(hydratingSerumStages.length, 2);
  assert.deepEqual(hydratingSerumStages.map((stage) => stage.source_scope), ['internal', 'external_seed']);
  const hydratingSerumQueries = hydratingSerumStages.flatMap((stage) => stage.entries.map((entry) => entry.query));
  assert.ok(hydratingSerumQueries.includes('hyaluronic acid serum'));
  assert.ok(hydratingSerumQueries.includes('hydrating serum dehydrated skin'));
  assert.ok(
    hydratingSerumQueries.every((query) => /serum|essence|hyaluronic|hydrat/i.test(query)),
    `unexpected hydrating serum support query set: ${hydratingSerumQueries.join(', ')}`,
  );
});

test('__internal: beauty chat handoff uses effective framework target context for broad concern payload metadata', async () => {
  const observed = {
    payloadTargetContext: null,
    payloadSourceMode: null,
  };
  const runtime = createBeautyChatMainlineEntryRuntime({
    RECO_CATALOG_GROUNDED_ENABLED: true,
    RECO_CATALOG_SELF_PROXY_TIMEOUT_FLOOR_MS: 1000,
    resolveRecommendationTargetContext: () => ({
      entry_type: 'chat',
      intent_mode: 'generic',
      step_aware_intent: false,
      resolved_target_step: null,
      framework_roles: [],
    }),
    summarizeProfileForContext: (profile) => profile,
    mergeIngredientRecoContextValue: (left, right) => ({ ...(left || {}), ...(right || {}) }),
    appendLatestRecoContextToSessionPatch: (sessionPatch, recoContext) => {
      sessionPatch.latest_reco_context = recoContext;
    },
    extractRecoFinalSelectionContract: () => ({
      selection_owner: 'shopping_agent_beauty_mainline',
    }),
    buildRouteAwareAssistantText: () => 'framework handoff response',
    makeAssistantMessage: (content) => ({ role: 'assistant', format: 'text', content }),
    buildEnvelope: (_ctx, envelope) => envelope,
    makeEvent: (_ctx, kind, data) => ({ kind, data }),
    applyRecoContractToRecoRequestedEvents: (events) => ({ events }),
    buildRecoRequestedEventData: ({ payload, source }) => ({
      payload,
      source,
    }),
    normalizeRecoSourceDetail: (value) => value,
    stateChangeAllowed: () => false,
    handoffRecoToBeautyMainlineSearch: async () => ({
      targetContext: {
        entry_type: 'chat',
        intent_mode: 'generic_concern',
        step_aware_intent: false,
        resolved_target_step: null,
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
          },
          {
            role_id: 'daily_sunscreen',
            rank: 3,
            preferred_step: 'sunscreen',
          },
        ],
      },
      recommendations: [
        {
          product_id: 'broad_oily_primary',
          display_name: 'Oil Control Serum',
        },
      ],
      searchResult: {
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        metadata: {
          contract_bridge: {
            resolved_contract: 'agent_v1_search_beauty_mainline',
          },
          source_breakdown: {
            source_tier_counts: { fresh_external: 1 },
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['broad_oily_primary'],
              selected_titles: ['Oil Control Serum'],
              selection_signature: 'search_sel_broad_oily',
              mainline_status: 'grounded_success',
              source_tier_counts: { fresh_external: 1 },
            },
          },
        },
      },
    }),
    buildRecoPayloadFromBeautyMainlineHandoff: ({
      targetContext,
      sourceMode,
    }) => {
      observed.payloadTargetContext = targetContext;
      observed.payloadSourceMode = sourceMode;
      return {
        payload: {
          source: 'catalog_grounded_v1',
          mainline_status: 'grounded_success',
          recommendation_meta: {
            source_mode: sourceMode,
          },
        },
        contract: {
          version: 'test_contract',
        },
      };
    },
    classifyBeautyMainlineHandoffFallback: () => ({
      reason: 'unreachable',
    }),
    buildBeautyMainlineHandoffFallbackEnvelope: () => ({
      cards: [],
    }),
    looksLikeRecommendationRequest: () => true,
    sendChatEnvelope: async () => null,
  });

  const result = await runtime.maybeHandleBeautyOwnedChatReco({
    ctx: {
      request_id: 'req_broad_oily',
      trace_id: 'trace_broad_oily',
      lang: 'EN',
      trigger_source: 'chat',
    },
    logger: null,
    message: 'im oily skin, what products should i use?',
    recoEntrySourceDetail: 'typed_reco',
    profile: {
      skinType: 'oily',
    },
  });

  assert.equal(result?.handled, true);
  assert.equal(observed.payloadSourceMode, 'framework_mainline');
  assert.equal(observed.payloadTargetContext?.intent_mode, 'generic_concern');
  assert.equal(
    result?.targetContext?.primary_role_id,
    'oil_control_treatment',
  );
  assert.equal(
    result?.envelope?.cards?.[0]?.payload?.recommendation_meta?.source_mode,
    'framework_mainline',
  );
});

test('__internal: framework recall planner injects canonical shine-control serum ladder when live planner only emits oil-balance phrasing', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext: {
      framework_summary: {
        concern_text: 'im oily skin, what product should i use?',
      },
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
          query_terms: ['oil control serum', 'oil balance serum'],
          fit_keywords: ['oil control', 'oil balance', 'shine control', 'mattifying'],
        },
      ],
    },
  });

  assert.deepEqual(plan.stages[0]?.entries?.map((entry) => entry?.query), [
    'oil control serum',
    'shine control serum',
    'mattifying serum',
  ]);
});

test('__internal: framework recall planner falls back to role label query when treatment role lacks enough query terms', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'framework_generic',
    targetContext: {
      framework_summary: {
        concern_text: 'im oily skin, what product should i use?',
      },
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
          label: 'Oil-control treatment',
          query_terms: ['oil control serum'],
        },
      ],
    },
  });

  assert.deepEqual(plan.stages[0]?.entries?.map((entry) => entry?.query), [
    'oil control serum',
    'oil control treatment',
    'im oily skin, what product should i use? treatment',
  ]);
});

staleFallbackPlannerTest('__internal: step-aware recall planner appends bounded external-seed fallback after the internal ladder', () => {
  const { __internal } = loadRoutesFresh();
  const plan = __internal.buildRecoRecallPlan({
    mode: 'step_aware',
    queryLevels: [
      {
        ladder_level: 'step_stage_a_exact',
        queries: [
          { query: 'sunscreen', step: 'sunscreen', slot: 'am' },
          { query: 'sunscreen oily skin', step: 'sunscreen', slot: 'am' },
        ],
      },
      {
        ladder_level: 'step_stage_b_same_family',
        queries: [
          { query: 'broad spectrum sunscreen', step: 'sunscreen', slot: 'am' },
        ],
      },
    ],
  });

  assert.equal(plan.mode, 'step_aware');
  assert.equal(plan.version, 'aurora_reco_recall_plan_v1');
  assert.ok(Array.isArray(plan.stages));
  assert.equal(plan.stages.length, 3);
  assert.ok(Array.isArray(plan.entries));
  assert.equal(plan.entries.length, 3);
  assert.deepEqual(
    plan.stages.map((stage) => [stage.stage_id, stage.source_scope, stage.entries.length]),
    [
      ['beauty_mainline_query_1', 'hybrid', 1],
      ['beauty_mainline_query_2', 'hybrid', 1],
      ['beauty_mainline_query_3', 'hybrid', 1],
    ],
  );
  assert.deepEqual(plan.entries.map((entry) => entry?.query), [
    'daily sunscreen',
    'face sunscreen',
    'sunscreen',
  ]);
});

staleFallbackPlannerTest('/v1/chat: step-aware sunscreen typed reco falls back to external seed and keeps routine handoff', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"empty structured reco"}',
      structured: {
        recommendations: [],
        confidence: null,
        warnings: ['upstream_missing_or_empty'],
      },
      context: {},
    }),
  });

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    const allowExternalSeed = config?.params?.allow_external_seed === true;
    const externalSeedStrategy = String(config?.params?.external_seed_strategy || '').trim().toLowerCase();
    observedQueries.push({ query, allowExternalSeed, externalSeedStrategy });
    if (allowExternalSeed && (query.includes('sunscreen') || query.includes('spf'))) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'ext_spf_step_1',
              merchant_id: 'merchant_ext_spf',
              brand: 'Supergoop',
              name: 'Unseen Sunscreen SPF 40',
              display_name: 'Supergoop Unseen Sunscreen SPF 40',
              category: 'sunscreen',
              product_type: 'sunscreen',
              source: 'external_seed',
              url: 'https://example.com/supergoop-unseen',
              ingredient_tokens: ['uv filters'],
              tag_tokens: ['daily sunscreen', 'broad spectrum'],
              short_description: 'A lightweight broad-spectrum sunscreen for oily skin.',
            },
          ],
        },
      };
    }
    return { status: 200, data: { products: [] } };
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_step_sunscreen_external_uid',
        'X-Trace-ID': 'trace_chat_step_sunscreen_external',
        'X-Brief-ID': 'chat_step_sunscreen_external_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'i need a sunscreen for oily skin',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.equal(payload.recommendation_meta?.resolved_target_step, 'sunscreen');
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 1);
    assert.equal(payload.recommendations[0]?.product_id, 'ext_spf_step_1');
    assert.equal(payload.recommendations[0]?.retrieval_source, 'external_seed');
    const suggestedChipIds = (Array.isArray(response.body?.suggested_chips) ? response.body.suggested_chips : [])
      .map((chip) => String(chip?.chip_id || '').trim())
      .filter(Boolean);
    assert.ok(
      suggestedChipIds.includes('chip.start.routine')
      || suggestedChipIds.includes('chip.action.reco_routine')
      || suggestedChipIds.includes('tpl.action.routine_generate'),
    );
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    assert.equal(cards.some((card) => card && card.type === 'confidence_notice'), false);
    assert.ok(observedQueries.some((entry) => entry.allowExternalSeed === true && /(sunscreen|spf)/.test(entry.query)));
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

staleFallbackPlannerTest('__internal: framework-first transport policy constrains each planned query to one real HTTP attempt', async () => {
  const { __internal } = loadRoutesFresh();
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url, config) => {
    calls.push({
      url,
      query: config?.params?.query,
      source: config?.params?.source,
    });
    return {
      status: 504,
      data: {},
    };
  };

  try {
    const out = await __internal.searchPivotaBackendProducts({
      query: 'oil control serum',
      limit: 6,
      transportPolicy: __internal.buildRecoRecallTransportPolicy({ mode: 'framework_first_turn' }),
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'upstream_timeout');
    assert.equal(out.transport_policy_mode, 'framework_first_turn');
    assert.equal(out.actual_http_attempt_count, 1);
    assert.equal(Array.isArray(out.attempted_base_urls), true);
    assert.equal(out.attempted_base_urls.length, 1);
    assert.equal(Array.isArray(out.attempted_paths), true);
    assert.equal(out.attempted_paths.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.source, 'shopping-agent');
  } finally {
    axios.get = originalGet;
  }
});

test('__internal: internal primitive client surfaces backend error details', async () => {
  const { __internal } = loadRoutesFresh();
  const originalPost = axios.post;
  axios.post = async () => ({
    status: 502,
    data: {
      error: 'INTERNAL_PRODUCTS_SEARCH_UPSTREAM_ERROR',
      message: 'cache query failed',
      failure_stage: 'local_cache_retrieval',
      internal_error_code: 'CACHE_QUERY_FAILED',
    },
  });

  try {
    const out = await __internal.searchInternalProductsPrimitive({
      query: 'oil control serum',
      limit: 6,
      timeoutMs: 4800,
      catalogSurface: 'beauty',
      callerLane: 'beauty_discovery_mainline',
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'upstream_error');
    assert.equal(out.status_code, 502);
    assert.equal(out.upstream_error_code, 'INTERNAL_PRODUCTS_SEARCH_UPSTREAM_ERROR');
    assert.equal(out.upstream_error_message, 'cache query failed');
    assert.equal(out.upstream_failure_stage, 'local_cache_retrieval');
    assert.equal(out.upstream_internal_error_code, 'CACHE_QUERY_FAILED');
    assert.deepEqual(out.attempted_internal_paths, ['/agent/internal/products/search']);
  } finally {
    axios.post = originalPost;
  }
});

test('__internal: internal primitive client normalizes structured backend error envelopes', async () => {
  const { __internal } = loadRoutesFresh();
  const originalPost = axios.post;
  axios.post = async () => ({
    status: 405,
    data: {
      status: 'error',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Method Not Allowed',
        details: { error: 'Method Not Allowed' },
      },
      metadata: { request_id: 'req_123' },
      detail: 'Method Not Allowed',
    },
  });

  try {
    const out = await __internal.searchInternalProductsPrimitive({
      query: 'oil control serum',
      limit: 6,
      timeoutMs: 4800,
      catalogSurface: 'beauty',
      callerLane: 'beauty_discovery_mainline',
    });

    assert.equal(out.ok, false);
    assert.equal(out.reason, 'upstream_error');
    assert.equal(out.status_code, 405);
    assert.equal(out.upstream_error_code, 'INTERNAL_SERVER_ERROR');
    assert.equal(out.upstream_error_message, 'Method Not Allowed');
    assert.equal(out.upstream_failure_stage, null);
    assert.equal(out.upstream_internal_error_code, null);
  } finally {
    axios.post = originalPost;
  }
});

test('__internal: internal primitive client clamps timeout by overall deadline', async () => {
  const { __internal } = loadRoutesFresh();
  const originalPost = axios.post;
  const observed = [];
  axios.post = async (_url, _body, config = {}) => {
    observed.push({
      timeout: Number(config?.timeout || 0),
      headerTimeout: Number(config?.headers?.['X-Internal-Search-Timeout-Ms'] || 0),
    });
    return {
      status: 200,
      data: {
        products: [],
      },
    };
  };

  try {
    const out = await __internal.searchInternalProductsPrimitive({
      query: 'oil control serum',
      limit: 6,
      timeoutMs: 4800,
      deadlineMs: Date.now() + 350,
      catalogSurface: 'beauty',
      callerLane: 'beauty_discovery_mainline',
    });

    assert.equal(out.ok, true);
    assert.equal(observed.length, 1);
    assert.ok(observed[0].timeout > 0);
    assert.ok(observed[0].timeout < 4800);
    assert.ok(observed[0].timeout <= 350);
    assert.equal(observed[0].headerTimeout, observed[0].timeout);
  } finally {
    axios.post = originalPost;
  }
});

test('__internal: local external seed search patterns do not fall back to singleton token noise for multi-token queries', async () => {
  const { __internal } = loadRoutesFresh();
  const patterns = __internal.buildLocalExternalSeedSearchPatterns('oil control serum');
  assert.equal(patterns.includes('%oil%'), false);
  assert.equal(patterns.includes('%serum%'), false);
  assert.equal(patterns.includes('%oil control serum%'), true);
  assert.equal(patterns.includes('%oil control%'), true);
  assert.equal(patterns.includes('%control serum%'), true);
});

test('__internal: local external seed search patterns expand with framework role phrases for primary external seed recall', async () => {
  const { __internal } = loadRoutesFresh();
  const patterns = __internal.buildLocalExternalSeedSearchPatterns('oil control serum', {
    role: {
      role_id: 'oil_control_treatment',
      preferred_step: 'treatment',
      query_terms: ['oil control serum', 'oil balance serum', 'shine control serum', 'mattifying serum'],
      fit_keywords: ['oil control', 'shine control', 'mattifying', 'balancing'],
    },
    preferredStep: 'treatment',
  });
  assert.equal(patterns.includes('%shine control serum%'), true);
  assert.equal(patterns.includes('%mattifying serum%'), true);
  assert.equal(patterns.includes('%balancing serum%') || patterns.includes('%balancing treatment%'), true);
});

test('__internal: local external seed support-role patterns avoid bare fit keyword noise', async () => {
  const { __internal } = loadRoutesFresh();
  const patterns = __internal.buildLocalExternalSeedSearchPatterns('lightweight moisturizer oily skin', {
    role: {
      role_id: 'lightweight_moisturizer',
      rank: 2,
      preferred_step: 'moisturizer',
      query_terms: ['lightweight moisturizer', 'gel cream'],
      fit_keywords: ['lightweight', 'oil free', 'breathable hydration'],
    },
    preferredStep: 'moisturizer',
  });
  assert.equal(patterns.includes('%lightweight%'), false);
  assert.equal(patterns.includes('%oil free%'), false);
  assert.equal(patterns.includes('%breathable hydration%'), false);
  assert.equal(patterns.includes('%moisturizer oily%'), false);
  assert.equal(patterns.includes('%lightweight moisturizer oily skin%'), true);
  assert.equal(patterns.includes('%lightweight moisturizer%'), false);
  assert.equal(patterns.includes('%gel cream%'), false);
  assert.equal(patterns.includes('%oil free moisturizer%'), false);
});

test('__internal: local external seed support-role search uses precise category-positive recall before broad text recall', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const makeRow = (id, title, price) => ({
    id,
    external_product_id: `ext_support_moisturizer_${id}`,
    destination_url: `https://example.com/products/support-moisturizer-${id}`,
    canonical_url: `https://example.com/products/support-moisturizer-${id}`,
    domain: 'example.com',
    title,
    image_url: `https://example.com/products/support-moisturizer-${id}.jpg`,
    price_amount: price,
    price_currency: 'USD',
    availability: 'in_stock',
    match_stage: 'support_category_positive',
    match_score: 54,
    seed_data: {
      derived: {
        recall: {
          retrieval_title: title,
          retrieval_summary: 'A lightweight moisturizer for oily skin and breathable hydration.',
          category: 'moisturizer',
          vertical: 'skincare',
          alias_tokens: ['lightweight moisturizer', 'gel cream'],
        },
      },
      snapshot: {
        title,
        description: 'Oil-free gel cream texture for oily skin.',
        category: 'Moisturizer',
      },
      benefit_tags: ['lightweight', 'oil-free hydration'],
      skin_type_tags: ['oily'],
    },
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });

  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'lightweight moisturizer oily skin',
    limit: 2,
    role: {
      role_id: 'lightweight_moisturizer',
      rank: 2,
      preferred_step: 'moisturizer',
      query_terms: ['lightweight moisturizer', 'gel cream'],
      fit_keywords: ['lightweight', 'oil free', 'breathable hydration'],
      product_type_hypotheses: ['moisturizer'],
    },
    preferredStep: 'moisturizer',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          makeRow('101', 'Cloud Weight Oil-Free Gel Cream', 18),
          makeRow('102', 'Balance Water Cream', 24),
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_fastpath');
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_category_positive/);
  assert.match(observedQueries[0].sql, /category/);
  assert.match(observedQueries[0].sql, /retrieval_title/i);
  assert.match(observedQueries[0].sql, /alias_tokens/i);
  assert.match(observedQueries[0].sql, /ingredient_tokens/i);
  assert.doesNotMatch(observedQueries[0].sql, /seed_data::text/i);
  assert.ok(observedQueries[0].params[2].includes('moisturizer'));
  assert.ok(observedQueries[0].params[2].includes('face moisturizer'));
  assert.ok(observedQueries[0].params[2].includes('face lotion'));
  assert.ok(observedQueries[0].params[2].includes('moisturizing lotion'));
  assert.ok(observedQueries[0].params[3].includes('%lightweight%'));
  assert.equal(observedQueries[0].params[3].includes('%gel cream%'), false);
  assert.equal(observedQueries[0].params[3].includes('%oil-free%'), false);
  assert.equal(observedQueries[0].params[3].includes('%moisturizer%'), false);
  assert.equal(observedQueries[0].params[3].includes('%cream%'), false);
  assert.equal(observedQueries[0].params[3].includes('%lotion%'), false);
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_category_positive');
  assert.equal(out.local_external_seed_stage_debug[0]?.stop_after_any_match, true);
  assert.equal(out.products.length, 2);
  assert.equal(out.products[0].retrieval_match_stage, 'support_category_positive');
  assert.match(out.products[0].retrieval_reason, /support_category_positive/);
});

test('__internal: local external seed support-role positive patterns stay query-specific within the same role', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'gel cream moisturizer',
    limit: 1,
    role: {
      role_id: 'layering_compatible_moisturizer_or_spf',
      rank: 2,
      preferred_step: 'moisturizer',
      query_terms: ['gel cream moisturizer', 'lightweight moisturizer'],
      fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
      product_type_hypotheses: ['moisturizer'],
    },
    preferredStep: 'moisturizer',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      if (
        !Array.isArray(params?.[3])
        || !params[3].includes('%gel cream%')
        || params[3].includes('%face lotion%')
        || params[3].includes('%lightweight%')
      ) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: '152',
            external_product_id: 'ext_gel_cream_152',
            destination_url: 'https://example.com/products/gel-cream-152',
            canonical_url: 'https://example.com/products/gel-cream-152',
            domain: 'example.com',
            title: 'Cloud Water Gel Cream',
            image_url: 'https://example.com/products/gel-cream-152.jpg',
            price_amount: 24,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_category_positive',
            match_score: 54,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Cloud Water Gel Cream',
                  retrieval_summary: 'A water gel cream for lightweight hydration.',
                  category: 'face moisturizer',
                  vertical: 'skincare',
                  alias_tokens: ['gel cream moisturizer'],
                },
              },
              snapshot: {
                title: 'Cloud Water Gel Cream',
                description: 'Water gel cream moisturizer.',
                category: 'Face Moisturizer',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.ok(observedQueries[0].params[3].includes('%gel cream%'));
  assert.equal(observedQueries[0].params[3].includes('%face lotion%'), false);
  assert.equal(observedQueries[0].params[3].includes('%lightweight%'), false);
  assert.equal(out.products[0]?.title, 'Cloud Water Gel Cream');
});

test('__internal: local external seed support-role fastpath overfetches and role-ranks before truncating', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const makeRow = (id, title, description, benefitTags = []) => ({
    id,
    external_product_id: `ext_layering_rank_${id}`,
    destination_url: `https://example.com/products/layering-rank-${id}`,
    canonical_url: `https://example.com/products/layering-rank-${id}`,
    domain: 'example.com',
    title,
    image_url: `https://example.com/products/layering-rank-${id}.jpg`,
    price_amount: 22,
    price_currency: 'USD',
    availability: 'in_stock',
    match_stage: 'support_category_positive',
    match_score: 54,
    seed_data: {
      derived: {
        recall: {
          retrieval_title: title,
          retrieval_summary: description,
          category: 'face moisturizer',
          vertical: 'skincare',
          alias_tokens: ['gel cream moisturizer', ...benefitTags],
        },
      },
      snapshot: {
        title,
        description,
        category: 'Face Moisturizer',
      },
      benefit_tags: benefitTags,
      skin_type_tags: ['oily'],
    },
    updated_at: new Date(2026, 0, Number(id)).toISOString(),
    created_at: new Date(2026, 0, Number(id)).toISOString(),
  });

  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'gel cream moisturizer',
    limit: 2,
    role: {
      role_id: 'layering_compatible_moisturizer_or_spf',
      rank: 2,
      preferred_step: 'moisturizer',
      query_terms: ['gel cream moisturizer', 'lightweight moisturizer'],
      fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup', 'soothing'],
      product_type_hypotheses: ['moisturizer'],
    },
    preferredStep: 'moisturizer',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          makeRow('101', 'Recharge Gel Cream', 'A gel cream focused on general radiance.'),
          makeRow('102', 'Niacinamide Gel Cream 5%', 'A gel cream focused on radiance and tone.'),
          makeRow('103', 'Pine Calming Cica Cream', 'A rich cream for dry skin comfort.'),
          makeRow('104', 'Poremizing Light Gel Cream', 'A peel-adjacent pore gel cream.'),
          makeRow('105', 'Radiance Gel Cream Unscented', 'A gel cream focused on glow.'),
          makeRow('106', 'Daily Water Gel Cream', 'A basic water gel cream.'),
          makeRow(
            '107',
            'Tea-Trica B5 Cream',
            'A lightweight non-greasy cream with panthenol and cica that layers smoothly under makeup.',
            ['lightweight', 'non-greasy', 'makeup layering', 'panthenol', 'cica'],
          ),
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(observedQueries.length, 1);
  assert.equal(observedQueries[0].params.at(-1), 8);
  assert.equal(out.local_external_seed_stage_debug[0]?.query_cap, 8);
  assert.equal(out.local_external_seed_stage_debug[0]?.pre_rank_row_count, 7);
  assert.equal(out.products.length, 2);
  assert.equal(out.products[0]?.title, 'Tea-Trica B5 Cream');
  assert.ok(Number(out.products[0]?.local_external_seed_role_fit_score || 0) > Number(out.products[1]?.local_external_seed_role_fit_score || 0));
});

test('__internal: local external seed sunscreen search uses target intent to demote portable reapplication sticks', async () => {
  const { __internal } = loadRoutesFresh();
  const makeRow = (id, title, description, benefitTags = []) => ({
    id,
    external_product_id: `ext_sunscreen_target_intent_${id}`,
    destination_url: `https://example.com/products/sunscreen-target-intent-${id}`,
    canonical_url: `https://example.com/products/sunscreen-target-intent-${id}`,
    domain: 'example.com',
    title,
    image_url: `https://example.com/products/sunscreen-target-intent-${id}.jpg`,
    price_amount: 22,
    price_currency: 'USD',
    availability: 'in_stock',
    match_stage: 'support_category_positive',
    match_score: 54,
    seed_data: {
      derived: {
        recall: {
          retrieval_title: title,
          retrieval_summary: description,
          category: 'sunscreen',
          vertical: 'skincare',
          alias_tokens: ['daily sunscreen', ...benefitTags],
        },
      },
      snapshot: {
        title,
        description,
        category: 'Sunscreen',
      },
      benefit_tags: benefitTags,
      skin_type_tags: ['oily'],
    },
    updated_at: new Date(2026, 1, Number(id)).toISOString(),
    created_at: new Date(2026, 1, Number(id)).toISOString(),
  });

  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'daily sunscreen',
    limit: 2,
    role: {
      role_id: 'daily_sunscreen_finish_fit',
      rank: 1,
      preferred_step: 'sunscreen',
      query_terms: ['daily sunscreen', 'lightweight sunscreen'],
      fit_keywords: ['spf', 'lightweight'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    targetContext: {
      request_text: 'My daytime products pill under makeup. What sunscreen should I buy?',
      primary_concern: 'daytime routine under makeup',
      semantic_plan: {
        primary_concern: 'daytime routine under makeup',
        comparison_mode: 'same_role_comparison',
        must_satisfy_constraints: ['under makeup', 'avoid pilling', 'lightweight finish'],
      },
    },
    queryFn: async () => ({
      rows: [
        makeRow(
          '201',
          'Anywhere Sun Stick SPF 50',
          'A sunscreen stick for quick touchups and portable reapplication during the day.',
          ['spf 50', 'portable reapplication'],
        ),
        makeRow(
          '202',
          'Invisible Fluid Shield SPF 50',
          'A lightweight fluid sunscreen with no white cast that layers smoothly for daytime wear.',
          ['spf 50', 'lightweight finish'],
        ),
      ],
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.products[0]?.title, 'Invisible Fluid Shield SPF 50');
  assert.ok(
    Number(out.products[0]?.local_external_seed_role_fit_score || 0)
      > Number(out.products[1]?.local_external_seed_role_fit_score || 0),
  );
});

test('__internal: local external seed support category terms keep face-lotion moisturizer variants authoritative', () => {
  const { __internal } = loadRoutesFresh();
  const terms = __internal.buildLocalExternalSeedSupportCategoryTerms({
    query: 'lightweight moisturizer',
    role: {
      role_id: 'layering_compatible_moisturizer_or_spf',
      rank: 2,
      preferred_step: 'moisturizer',
      query_terms: ['gel cream moisturizer', 'lightweight moisturizer'],
      fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
      product_type_hypotheses: ['moisturizer'],
    },
    preferredStep: 'moisturizer',
  });

  assert.ok(terms.includes('face moisturizer'));
  assert.ok(terms.includes('face lotion'));
  assert.ok(terms.includes('moisturizing lotion'));
  assert.ok(terms.includes('water cream'));
  assert.ok(terms.includes('gel lotion'));
});

test('__internal: local external seed support-role search admits face moisturizer categories into the authority fastpath', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'lightweight moisturizer',
    limit: 1,
    role: {
      role_id: 'layering_compatible_moisturizer_or_spf',
      rank: 2,
      preferred_step: 'moisturizer',
      query_terms: ['gel cream moisturizer', 'lightweight moisturizer'],
      fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
      product_type_hypotheses: ['moisturizer'],
    },
    preferredStep: 'moisturizer',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      if (
        !Array.isArray(params?.[2])
        || !params[2].includes('face moisturizer')
        || !Array.isArray(params?.[3])
        || !params[3].includes('%face lotion%')
        || params[3].includes('%cream%')
      ) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: '151',
            external_product_id: 'ext_face_moisturizer_151',
            destination_url: 'https://example.com/products/face-lotion-151',
            canonical_url: 'https://example.com/products/face-lotion-151',
            domain: 'example.com',
            title: 'Daily Balance Face Lotion',
            image_url: 'https://example.com/products/face-lotion-151.jpg',
            price_amount: 28,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_category_positive',
            match_score: 54,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Daily Balance Face Lotion',
                  retrieval_summary: 'A lightweight face lotion for daily layering comfort.',
                  category: 'face moisturizer',
                  vertical: 'skincare',
                  alias_tokens: ['face lotion', 'lightweight moisturizer'],
                },
              },
              snapshot: {
                title: 'Daily Balance Face Lotion',
                description: 'Fast-absorbing face lotion with non-greasy hydration.',
                category: 'Face Moisturizer',
              },
              benefit_tags: ['lightweight', 'non-greasy hydration'],
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(observedQueries.length, 1);
  assert.ok(observedQueries[0].params[3].includes('%face lotion%'));
  assert.equal(observedQueries[0].params[3].includes('%cream%'), false);
  assert.equal(observedQueries[0].params[3].includes('%moisturizer%'), false);
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_category_positive');
  assert.equal(out.products[0]?.title, 'Daily Balance Face Lotion');
  assert.equal(out.products[0]?.retrieval_match_stage, 'support_category_positive');
});

test('__internal: local external seed primary hydration-serum search uses category-positive recall before title scan', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'hyaluronic acid serum',
    limit: 2,
    role: {
      role_id: 'hydrating_serum_or_essence',
      rank: 1,
      preferred_step: 'serum',
      query_terms: ['hyaluronic acid serum', 'hydrating serum'],
      fit_keywords: ['hyaluronic acid', 'hydrating', 'plumping'],
      product_type_hypotheses: ['serum', 'essence'],
    },
    preferredStep: 'serum',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '301',
            external_product_id: 'ext_hydrating_serum_301',
            destination_url: 'https://example.com/products/ha-serum',
            canonical_url: 'https://example.com/products/ha-serum',
            domain: 'example.com',
            title: 'Hyaluronic Acid Hydrating Serum',
            image_url: 'https://example.com/products/ha-serum.jpg',
            price_amount: 16,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_category_positive',
            match_score: 54,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Hyaluronic Acid Hydrating Serum',
                  retrieval_summary: 'A hydrating serum with sodium hyaluronate.',
                  ingredient_tokens: ['hyaluronic acid', 'sodium hyaluronate'],
                  category: 'serum',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Hyaluronic Acid Hydrating Serum',
                description: 'Hydrating serum for dehydrated skin.',
                category: 'Serum',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_category_positive/);
  assert.doesNotMatch(observedQueries[0].sql, /seed_data::text/i);
  assert.deepEqual(observedQueries[0].params[2], ['serum', 'treatment', 'ampoule', 'essence']);
  assert.ok(observedQueries[0].params[3].includes('%hyaluronic acid%'));
  assert.ok(observedQueries[0].params[3].includes('%sodium hyaluronate%'));
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_category_positive');
  assert.equal(out.local_external_seed_stage_debug[0]?.stop_after_any_match, true);
  assert.equal(out.products[0].retrieval_match_stage, 'support_category_positive');
});

test('__internal: local external seed oil-control support search uses lean positive recall only', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'niacinamide serum oily skin',
    limit: 2,
    role: {
      role_id: 'oil_control_treatment',
      rank: 2,
      preferred_step: 'treatment',
      query_terms: ['niacinamide serum oily skin', 'salicylic acid serum clogged pores'],
      fit_keywords: ['oil control', 'shine control', 'niacinamide', 'zinc pca'],
      product_type_hypotheses: ['serum', 'treatment'],
    },
    preferredStep: 'treatment',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '401',
            external_product_id: 'ext_oil_serum_401',
            destination_url: 'https://example.com/products/niacinamide-serum',
            canonical_url: 'https://example.com/products/niacinamide-serum',
            domain: 'example.com',
            title: 'Niacinamide Oil Control Serum',
            image_url: 'https://example.com/products/niacinamide-serum.jpg',
            price_amount: 12,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_category_positive',
            match_score: 54,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Niacinamide Oil Control Serum',
                  retrieval_summary: 'A niacinamide and zinc PCA serum for excess oil and visible pores.',
                  ingredient_tokens: ['niacinamide', 'zinc pca'],
                  category: 'serum',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Niacinamide Oil Control Serum',
                description: 'Oil-control serum for oily skin.',
                category: 'Serum',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_fastpath');
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_category_positive/);
  assert.doesNotMatch(observedQueries[0].sql, /support_recall_title/);
  assert.deepEqual(observedQueries[0].params[2], ['serum', 'treatment', 'ampoule', 'essence']);
  assert.ok(observedQueries[0].params[3].includes('%niacinamide%'));
  assert.ok(observedQueries[0].params[3].includes('%zinc pca%'));
  assert.equal(observedQueries[0].params[3].includes('%serum%'), false);
  assert.equal(observedQueries[0].params[3].includes('%treatment%'), false);
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_category_positive');
  assert.equal(out.products[0].retrieval_match_stage, 'support_category_positive');
});

test('__internal: local external seed sunscreen finish query uses precise query authority recall before broad fallback', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'spf fluid oily skin',
    limit: 2,
    role: {
      role_id: 'daily_sunscreen_finish_fit',
      rank: 1,
      preferred_step: 'sunscreen',
      query_terms: ['spf fluid oily skin'],
      fit_keywords: ['spf', 'uv protection', 'oil free', 'under makeup'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '221',
            external_product_id: 'ext_support_sunscreen_221',
            destination_url: 'https://example.com/products/oil-free-sun-fluid',
            canonical_url: 'https://example.com/products/oil-free-sun-fluid',
            domain: 'example.com',
            title: 'Oil-Free Sun Fluid SPF 50',
            image_url: 'https://example.com/products/oil-free-sun-fluid.jpg',
            price_amount: 24,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_category_positive',
            match_score: 54,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Oil-Free Sun Fluid SPF 50',
                  retrieval_summary: 'A lightweight non-greasy UV fluid for oily skin.',
                  category: 'Sunscreen',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Oil-Free Sun Fluid SPF 50',
                description: 'Lightweight non-greasy UV fluid.',
                category: 'Sunscreen',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_fastpath');
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_query_precise/);
  assert.deepEqual(observedQueries[0].params[2], [
    'sunscreen',
    'spf',
    'sun care',
    'sun protection',
    'uv protection',
  ]);
  assert.ok(observedQueries[0].params[3].includes('%spf fluid%'));
  assert.equal(
    observedQueries[0].params[3].some((pattern) => pattern === '%oil-free%' || pattern === '%oil free%'),
    true,
  );
  assert.equal(observedQueries[0].params[3].includes('%spf%'), false);
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_query_precise');
  assert.equal(out.local_external_seed_stage_debug[0]?.query_cap, 6);
  assert.equal(out.products[0].retrieval_match_stage, 'support_category_positive');
  assert.equal(out.products[0].product_id, 'ext_support_sunscreen_221');
});

test('__internal: local external seed daily sunscreen support uses precise authority recall for form-fit queries', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'lightweight sunscreen oily skin',
    limit: 2,
    role: {
      role_id: 'daily_sunscreen',
      rank: 3,
      preferred_step: 'sunscreen',
      query_terms: ['spf fluid oily skin', 'lightweight sunscreen oily skin', 'oil control sunscreen'],
      fit_keywords: ['spf', 'lightweight', 'oil control', 'non-greasy'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '225',
            external_product_id: 'ext_support_daily_sunscreen_225',
            destination_url: 'https://example.com/products/lightweight-daily-spf',
            canonical_url: 'https://example.com/products/lightweight-daily-spf',
            domain: 'example.com',
            title: 'Lightweight Daily Sunscreen SPF 50',
            image_url: 'https://example.com/products/lightweight-daily-spf.jpg',
            price_amount: 22,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_query_precise',
            match_score: 58,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Lightweight Daily Sunscreen SPF 50',
                  retrieval_summary: 'A lightweight non-greasy sunscreen for oily skin.',
                  category: 'Sunscreen',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Lightweight Daily Sunscreen SPF 50',
                description: 'Lightweight non-greasy sunscreen for oily skin.',
                category: 'Sunscreen',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_fastpath');
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_query_precise/);
  assert.deepEqual(observedQueries[0].params[2], [
    'sunscreen',
    'spf',
    'sun care',
    'sun protection',
    'uv protection',
  ]);
  assert.ok(observedQueries[0].params[3].includes('%lightweight sunscreen oily skin%'));
  assert.ok(observedQueries[0].params[3].includes('%lightweight sunscreen%'));
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_query_precise');
  assert.equal(out.products[0].retrieval_match_stage, 'support_query_precise');
  assert.equal(out.products[0].retrieval_role_id, 'daily_sunscreen');
});

test('__internal: local external seed multi-query sunscreen compare uses one precise authority query', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProductsForQueryVariants({
    queries: ['spf fluid', 'mineral sunscreen', 'sunscreen milk'],
    limit: 3,
    role: {
      role_id: 'daily_sunscreen_finish_fit',
      rank: 1,
      preferred_step: 'sunscreen',
      query_terms: ['spf fluid', 'mineral sunscreen', 'sunscreen milk'],
      fit_keywords: ['spf', 'uv protection', 'under makeup'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '231',
            external_product_id: 'ext_support_sunscreen_231',
            destination_url: 'https://example.com/products/airy-sun-fluid',
            canonical_url: 'https://example.com/products/airy-sun-fluid',
            domain: 'example.com',
            title: 'Airy Sun Fluid SPF 50',
            image_url: 'https://example.com/products/airy-sun-fluid.jpg',
            price_amount: 26,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_query_precise',
            match_score: 58,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Airy Sun Fluid SPF 50',
                  retrieval_summary: 'A lightweight sunscreen fluid for smoother wear under makeup.',
                  category: 'Sunscreen',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Airy Sun Fluid SPF 50',
                description: 'Lightweight sunscreen fluid.',
                category: 'Sunscreen',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_multi_query');
  assert.equal(out.local_external_seed_query_count, 3);
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_query_precise/);
  assert.ok(observedQueries[0].params[3].includes('%spf fluid%'));
  assert.ok(observedQueries[0].params[3].includes('%mineral sunscreen%'));
  assert.ok(observedQueries[0].params[3].includes('%sunscreen milk%'));
  assert.equal(out.products[0].product_id, 'ext_support_sunscreen_231');
});

test('__internal: local external seed same-role sunscreen compare runs precise query stage before broad category-positive recall', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'sunscreen under makeup',
    limit: 2,
    role: {
      role_id: 'daily_sunscreen_finish_fit',
      rank: 1,
      preferred_step: 'sunscreen',
      query_terms: ['sunscreen under makeup'],
      fit_keywords: ['under makeup', 'makeup friendly', 'lightweight'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    targetContext: {
      primary_role_id: 'daily_sunscreen_finish_fit',
      comparison_mode: 'same_role_comparison',
      routine_mode: 'same_role_comparison',
      semantic_plan: {
        comparison_mode: 'same_role_comparison',
        routine_mode: 'same_role_comparison',
        selection_constraints: { comparison_mode: 'same_role_comparison' },
      },
    },
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      if (String(sql || '').includes('support_query_precise')) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            id: '222',
            external_product_id: 'ext_support_sunscreen_222',
            destination_url: 'https://example.com/products/under-makeup-fluid',
            canonical_url: 'https://example.com/products/under-makeup-fluid',
            domain: 'example.com',
            title: 'Under Makeup Sun Fluid SPF 50',
            image_url: 'https://example.com/products/under-makeup-fluid.jpg',
            price_amount: 28,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_category_positive',
            match_score: 54,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Under Makeup Sun Fluid SPF 50',
                  retrieval_summary: 'A lightweight sunscreen fluid designed for smoother wear under makeup.',
                  category: 'Sunscreen',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Under Makeup Sun Fluid SPF 50',
                description: 'Lightweight sunscreen fluid for smoother wear under makeup.',
                category: 'Sunscreen',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_fastpath');
  assert.equal(observedQueries.length, 2);
  assert.match(observedQueries[0].sql, /support_query_precise/);
  assert.match(observedQueries[1].sql, /support_category_positive/);
  assert.ok(observedQueries[0].params[3].includes('%under makeup%'));
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_query_precise');
  assert.equal(out.local_external_seed_stage_debug[1]?.stage, 'support_category_positive');
  assert.equal(out.products[0].retrieval_match_stage, 'support_category_positive');
});

test('__internal: local external seed hydrating serum ranking prefers leave-on serum forms over masks and pads', async () => {
  const { __internal } = loadRoutesFresh();
  const makeRow = ({ id, title, summary, category = 'Serum' }) => ({
    id,
    external_product_id: `ext_${id}`,
    destination_url: `https://example.com/products/${id}`,
    canonical_url: `https://example.com/products/${id}`,
    domain: 'example.com',
    title,
    image_url: `https://example.com/products/${id}.jpg`,
    price_amount: 24,
    price_currency: 'USD',
    availability: 'in_stock',
    match_stage: 'support_category_positive',
    match_score: 54,
    seed_data: {
      derived: {
        recall: {
          retrieval_title: title,
          retrieval_summary: summary,
          category,
          vertical: 'skincare',
        },
      },
      snapshot: {
        title,
        description: summary,
        category,
      },
    },
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'hyaluronic acid serum',
    limit: 3,
    role: {
      role_id: 'hydrating_serum_or_essence',
      rank: 42,
      preferred_step: 'serum',
      query_terms: ['hyaluronic acid serum', 'hydrating serum'],
      fit_keywords: ['hydrating', 'lightweight', 'serum', 'essence'],
      product_type_hypotheses: ['serum', 'essence', 'ampoule'],
    },
    preferredStep: 'serum',
    queryFn: async () => ({
      rows: [
        makeRow({
          id: 'pillow_pads',
          title: 'Ultra Repair Hydrating Pillow Pads with Colloidal Oatmeal + Ceramides',
          summary: 'Hydrating pads with colloidal oatmeal and ceramides.',
          category: 'Treatment',
        }),
        makeRow({
          id: 'dokdo_ampoule',
          title: '1025 Dokdo Ampoule',
          summary: 'A watery hydrating ampoule with glycerin and lightweight moisture.',
          category: 'Serum',
        }),
        makeRow({
          id: 'milky_remedy_mask',
          title: 'Milky Remedy Mask',
          summary: 'A hydrating mask with glycerin and oatmeal.',
          category: 'Treatment',
        }),
      ],
    }),
  });

  assert.equal(out.ok, true);
  assert.equal(out.products[0]?.product_id, 'ext_dokdo_ampoule');
  assert.equal(out.products.some((item) => item.product_id === 'ext_pillow_pads'), false);
  assert.equal(out.products.some((item) => item.product_id === 'ext_milky_remedy_mask'), false);
});

test('__internal: local external seed barrier moisturizer query uses bounded category-positive cost', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'barrier repair moisturizer',
    limit: 6,
    role: {
      role_id: 'barrier_moisturizer',
      rank: 41,
      preferred_step: 'moisturizer',
      query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin'],
      fit_keywords: ['barrier repair', 'ceramide', 'panthenol', 'sensitive skin'],
      product_type_hypotheses: ['moisturizer'],
    },
    preferredStep: 'moisturizer',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return { rows: [] };
    },
  });

  assert.equal(out.ok, false);
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_category_positive/);
  assert.equal(observedQueries[0].params.at(-1), 12);
  assert.equal(out.local_external_seed_stage_debug[0]?.query_cap, 12);
});

test('__internal: local external seed support-role search uses exact category head for broad sunscreen recall', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'sunscreen',
    limit: 2,
    role: {
      role_id: 'daily_sunscreen',
      rank: 2,
      preferred_step: 'sunscreen',
      query_terms: ['sunscreen', 'spf fluid'],
      fit_keywords: ['spf', 'uv protection'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '201',
            external_product_id: 'ext_support_sunscreen_201',
            destination_url: 'https://example.com/products/daily-spf-fluid',
            canonical_url: 'https://example.com/products/daily-spf-fluid',
            domain: 'example.com',
            title: 'Daily SPF Fluid',
            image_url: 'https://example.com/products/daily-spf-fluid.jpg',
            price_amount: 24,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_category_exact',
            match_score: 56,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Daily SPF Fluid sunscreen',
                  retrieval_summary: 'A lightweight daily sunscreen.',
                  category: 'sunscreen',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Daily SPF Fluid',
                description: 'Lightweight SPF for daily use.',
                category: 'Sunscreen',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_fastpath');
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_category_exact/);
  assert.match(observedQueries[0].sql, /tool\s+=\s+ANY\(\$2::text\[\]\)/i);
  assert.match(observedQueries[0].sql, /category/);
  assert.doesNotMatch(observedQueries[0].sql, /retrieval_title/i);
  assert.match(observedQueries[0].sql, /attached_product_key\s+IS\s+NULL/i);
  assert.deepEqual(observedQueries[0].params[2], [
    'sunscreen',
    'spf',
    'sun care',
    'sun protection',
    'uv protection',
  ]);
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_category_exact');
  assert.equal(out.local_external_seed_stage_debug[0]?.query_cap, 8);
  assert.equal(out.products[0].retrieval_match_stage, 'support_category_exact');
});

test('__internal: local external seed generic daily sunscreen support skips broad category head for form-fit queries', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'spf fluid oily skin',
    limit: 2,
    role: {
      role_id: 'daily_sunscreen',
      rank: 30,
      preferred_step: 'sunscreen',
      query_terms: ['spf fluid oily skin', 'lightweight sunscreen oily skin', 'oil control sunscreen'],
      fit_keywords: ['spf', 'uv protection', 'lightweight', 'oil control'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '225',
            external_product_id: 'ext_support_daily_sunscreen_225',
            destination_url: 'https://example.com/products/daily-lightweight-spf',
            canonical_url: 'https://example.com/products/daily-lightweight-spf',
            domain: 'example.com',
            title: 'Daily Lightweight SPF 50',
            image_url: 'https://example.com/products/daily-lightweight-spf.jpg',
            price_amount: 26,
            price_currency: 'USD',
            availability: 'in_stock',
            match_stage: 'support_query_precise',
            match_score: 58,
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Daily Lightweight SPF 50 sunscreen',
                  retrieval_summary: 'A lightweight daily face sunscreen for oily skin.',
                  category: 'sunscreen',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Daily Lightweight SPF 50',
                description: 'Lightweight daily face sunscreen.',
                category: 'Sunscreen',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'staged_support_fastpath');
  assert.equal(observedQueries.length, 1);
  assert.match(observedQueries[0].sql, /support_query_precise/);
  assert.doesNotMatch(observedQueries[0].sql, /support_category_exact/);
  assert.match(observedQueries[0].sql, /tool\s+=\s+ANY\(\$2::text\[\]\)/i);
  assert.deepEqual(observedQueries[0].params[2], [
    'sunscreen',
    'spf',
    'sun care',
    'sun protection',
    'uv protection',
  ]);
  assert.ok(observedQueries[0].params[3].includes('%spf fluid oily skin%'));
  assert.ok(observedQueries[0].params[3].includes('%spf fluid%'));
  assert.equal(out.local_external_seed_stage_debug[0]?.stage, 'support_query_precise');
  assert.equal(out.products[0]?.retrieval_match_stage, 'support_query_precise');
  assert.equal(out.products[0]?.retrieval_role_id, 'daily_sunscreen');
});

test('__internal: local external seed sunscreen broad recall does not let makeup SPF starve real sunscreen rows', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const makeRow = ({
    id,
    title,
    summary,
    category = 'Sunscreen',
    vertical = 'skincare',
  }) => ({
    id,
    external_product_id: id,
    destination_url: `https://example.com/products/${id}`,
    canonical_url: `https://example.com/products/${id}`,
    domain: 'example.com',
    title,
    image_url: `https://example.com/products/${id}.jpg`,
    price_amount: 24,
    price_currency: 'USD',
    availability: 'in_stock',
    match_stage: 'support_category_exact',
    match_score: 56,
    seed_data: {
      derived: {
        recall: {
          retrieval_title: title,
          retrieval_summary: summary,
          category,
          vertical,
        },
      },
      snapshot: {
        title,
        description: summary,
        category,
      },
    },
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'sunscreen',
    limit: 2,
    role: {
      role_id: 'daily_sunscreen_finish_fit',
      rank: 1,
      preferred_step: 'sunscreen',
      query_terms: ['sunscreen', 'spf fluid'],
      fit_keywords: ['spf', 'uv protection', 'under makeup'],
      product_type_hypotheses: ['sunscreen'],
    },
    preferredStep: 'sunscreen',
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          makeRow({
            id: 'foundation_spf',
            title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
            summary: 'A hydrating foundation makeup product with broad spectrum SPF.',
            category: 'SPF',
            vertical: 'makeup',
          }),
          makeRow({
            id: 'daily_invisible_spf',
            title: 'Daily Invisible Sunscreen SPF 50',
            summary: 'A lightweight face sunscreen for daily use under makeup.',
          }),
          makeRow({
            id: 'oil_free_sun_fluid',
            title: 'Oil-Free Sun Fluid SPF 50',
            summary: 'A non-greasy UV protection fluid for oily skin.',
          }),
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(observedQueries.length, 1);
  assert.equal(observedQueries[0].params[3], 8);
  assert.deepEqual(out.products.map((item) => item.product_id), [
    'daily_invisible_spf',
    'oil_free_sun_fluid',
  ]);
  assert.equal(out.local_external_seed_candidate_debug.stage_row_count, 3);
  assert.equal(out.local_external_seed_candidate_debug.ranked_candidate_count, 2);
  assert.equal(
    out.local_external_seed_candidate_debug.ranked_preview.some((item) => item.product_id === 'foundation_spf'),
    false,
  );
});

test('__internal: local external seed single-query recall includes attached authority rows', async () => {
  const { __internal } = loadRoutesFresh();
  const observedQueries = [];
  const out = await __internal.searchLocalExternalSeedProducts({
    query: 'daily spf fluid',
    limit: 1,
    queryFn: async (sql, params) => {
      observedQueries.push({ sql: String(sql || ''), params });
      return {
        rows: [
          {
            id: '211',
            external_product_id: 'ext_attached_sunscreen_211',
            destination_url: 'https://example.com/products/attached-daily-spf-fluid',
            canonical_url: 'https://example.com/products/attached-daily-spf-fluid',
            domain: 'example.com',
            title: 'Attached Daily SPF Fluid',
            image_url: 'https://example.com/products/attached-daily-spf-fluid.jpg',
            price_amount: 28,
            price_currency: 'USD',
            availability: 'in_stock',
            attached_product_key: 'shopify:attached-daily-spf-fluid',
            seed_data: {
              derived: {
                recall: {
                  retrieval_title: 'Attached Daily SPF Fluid',
                  retrieval_summary: 'A lightweight SPF fluid already linked to a backend product.',
                  category: 'sunscreen',
                  vertical: 'skincare',
                },
              },
              snapshot: {
                title: 'Attached Daily SPF Fluid',
                description: 'Lightweight SPF fluid.',
                category: 'Sunscreen',
              },
            },
            updated_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      };
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.local_external_seed_search_mode, 'single_query');
  assert.equal(observedQueries.length, 1);
  assert.doesNotMatch(observedQueries[0].sql, /attached_product_key\s+IS\s+NULL/i);
  assert.equal(out.products[0]?.title, 'Attached Daily SPF Fluid');
});

test('__internal: framework recall exhausts primary planned sources before support stages when mock recall never yields a candidate', async () => {
  const { __internal } = loadRoutesFresh();
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config) => {
    observedQueries.push(String(config?.params?.query || ''));
    return {
      status: 504,
      data: {},
    };
  };

  const targetContext = {
    framework_summary: {
      concern_text: 'im oily skin, what product should i use?',
    },
    primary_role_id: 'oil_control_treatment',
    framework_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
        query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
      },
      {
        role_id: 'lightweight_moisturizer',
        rank: 2,
        preferred_step: 'moisturizer',
        query_terms: ['lightweight moisturizer', 'gel cream', 'oil free moisturizer'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 3,
        preferred_step: 'sunscreen',
        query_terms: ['daily sunscreen', 'lightweight sunscreen', 'spf fluid'],
      },
    ],
  };

  try {
    const out = await __internal.collectRecoCandidatesFromRecallPlan({
      recallPlan: __internal.buildRecoRecallPlan({
        mode: 'framework_generic',
        targetContext,
      }),
      targetContext,
      logger: null,
      timeoutMs: 300,
      limit: 6,
      usePurchasableFallback: false,
    });

    assert.ok([3, 6, 7].includes(out.executedQueryCount));
    assert.ok(['', 'transient_timeout'].includes(out.primaryStageTimeoutClass));
    assert.ok(['plan_exhausted', 'primary_transient_timeout'].includes(out.plannerStopReason));
    assert.ok(['no_recall_from_planned_sources', 'upstream_timeout_primary_role'].includes(out.candidateDropStage));
    assert.equal(observedQueries.some((query) => /lightweight moisturizer|gel cream|daily sunscreen|spf fluid/i.test(query)), false);
  } finally {
    axios.get = originalGet;
  }
});

test('__internal: framework recall skips support stages when primary external stage fully times out after empty primary internal recall', async () => {
  const { __internal } = loadRoutesFresh();
  const originalGet = axios.get;
  const observedQueries = [];
  let callCount = 0;
  axios.get = async (url, config) => {
    callCount += 1;
    observedQueries.push(String(config?.params?.query || ''));
    if (callCount === 1) {
      return {
        status: 200,
        data: { items: [] },
      };
    }
    return {
      status: 504,
      data: {},
    };
  };

  const targetContext = {
    framework_summary: {
      concern_text: 'im oily skin, what product should i use?',
    },
    primary_role_id: 'oil_control_treatment',
    framework_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
        query_terms: ['oil control serum', 'oil balance serum', 'mattifying serum'],
      },
      {
        role_id: 'lightweight_moisturizer',
        rank: 2,
        preferred_step: 'moisturizer',
        query_terms: ['lightweight moisturizer'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 3,
        preferred_step: 'sunscreen',
        query_terms: ['oil control sunscreen'],
      },
    ],
  };

  try {
    const out = await __internal.collectRecoCandidatesFromRecallPlan({
      recallPlan: __internal.buildRecoRecallPlan({
        mode: 'framework_generic',
        targetContext,
      }),
      targetContext,
      logger: null,
      timeoutMs: 300,
      limit: 6,
      usePurchasableFallback: false,
    });

    assert.equal(out.executedQueryCount, 7);
    assert.equal(out.actualHttpAttemptCount, 7);
    assert.ok(['', 'transient_timeout'].includes(out.primaryStageTimeoutClass));
    assert.ok(['plan_exhausted', 'primary_transient_timeout'].includes(out.plannerStopReason));
    assert.ok(['no_recall_from_planned_sources', 'upstream_timeout_primary_role'].includes(out.candidateDropStage));
    assert.equal(observedQueries.some((query) => /lightweight moisturizer|oil control sunscreen/i.test(query)), false);
  } finally {
    axios.get = originalGet;
  }
});

test('__internal: collectRecoCandidatesFromRecallPlan clamps per-entry timeout by deadline', async () => {
  const { __internal } = loadRoutesFresh();
  const observed = [];
  const targetContext = {
    framework_summary: {
      concern_text: 'im oily skin, what product should i use?',
    },
    primary_role_id: 'oil_control_treatment',
    framework_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
        query_terms: ['oil control serum', 'shine control serum'],
      },
    ],
  };

  const out = await __internal.collectRecoCandidatesFromRecallPlan({
    recallPlan: __internal.buildRecoRecallPlan({
      mode: 'framework_generic',
      targetContext,
    }),
    targetContext,
    logger: null,
    timeoutMs: 800,
    deadlineMs: Date.now() + 360,
    limit: 6,
    usePurchasableFallback: false,
    searchFn: async (args = {}) => {
      observed.push({
        timeoutMs: Number(args?.timeoutMs || 0),
        deadlineMs: Number(args?.deadlineMs || 0),
      });
      return {
        ok: true,
        products: [],
        reason: 'empty',
      };
    },
  });

  assert.equal(Array.isArray(out.searchResults), true);
  assert.ok(observed.length >= 1);
  for (const row of observed) {
    assert.ok(row.timeoutMs > 0);
    assert.ok(row.timeoutMs < 800);
    assert.ok(row.timeoutMs <= 360);
    assert.ok(row.deadlineMs > 0);
  }
});

test('__internal: collectRecoCandidatesFromRecallPlan hard-stops wall clock when search hangs', async () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_summary: {
      concern_text: 'im oily skin, what product should i use?',
    },
    primary_role_id: 'oil_control_treatment',
    framework_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
        query_terms: ['oil control serum', 'shine control serum'],
      },
    ],
  };
  const startedAt = Date.now();

  const out = await __internal.collectRecoCandidatesFromRecallPlan({
    recallPlan: __internal.buildRecoRecallPlan({
      mode: 'framework_generic',
      targetContext,
    }),
    targetContext,
    logger: null,
    timeoutMs: 50,
    limit: 6,
    usePurchasableFallback: false,
    searchFn: async () => new Promise(() => {}),
  });

  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(Array.isArray(out.searchResults), true);
  assert.ok(out.searchResults.length >= 1);
  for (const row of out.searchResults) {
    assert.equal(row.reason, 'upstream_timeout');
    assert.equal(row.timeout_guard, 'caller_wall_clock');
    assert.deepEqual(row.products, []);
  }
});

test('__internal: tri-state skincare classifier only hard rejects explicit non-skincare', () => {
  const recoShared = require('../src/auroraBff/recommendationSharedStack');

  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      name: 'Oil Control Serum',
      category: 'serum',
    }),
    'explicit_face_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      name: 'Makeup Brush',
      category: 'tool',
    }),
    'explicit_non_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      name: 'Daily Tinted Fluid Sunscreen LP110',
      category: 'makeup',
      product_type: 'sunscreen',
      short_description: 'A daily tinted fluid sunscreen designed to sit well under makeup.',
    }),
    'explicit_face_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      name: 'SPF foundation',
      category: 'makeup',
      product_type: 'foundation',
    }),
    'explicit_non_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      name: 'Warm Fall/Winter Padded Winter Vest for Dogs & Cats',
      category: 'moisturizer',
    }),
    'explicit_non_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      name: 'Pro C Serum',
      category: 'serum',
      short_description: 'Vitamin C serum helps improve overall skin tone and radiance.',
    }),
    'explicit_face_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      title: 'Pro C Serum',
      category_name: 'Serum',
      productType: 'Serum',
      description: 'Fragrance-free vitamin C serum for post-acne marks and overall skin tone.',
    }),
    'explicit_face_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      title: 'Daily Sunscreen SPF 50',
      category_name: 'Sunscreen',
      short_description: 'A fragrance-free broad spectrum sunscreen that layers under makeup.',
    }),
    'explicit_face_skincare',
  );
  assert.equal(
    recoShared.classifySkincareCandidateDomain({
      name: 'Balance Control',
      benefit_tags: ['shine control', 'balancing'],
      short_description: 'Helps control excess sebum for oily skin.',
    }),
    'ambiguous',
  );
  assert.equal(
    recoShared.isSkincareCandidate({
      name: 'Balance Control',
      benefit_tags: ['shine control', 'balancing'],
      short_description: 'Helps control excess sebum for oily skin.',
    }),
    true,
  );
});

test('__internal: framework pool does not boundary-reject tinted sunscreen rows that are skincare-shaped, even when role-fit later rejects them', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'tinted_sunscreen_lp110',
        merchant_id: 'external_seed',
        brand: 'Example SPF',
        display_name: 'Daily Tinted Fluid Sunscreen LP110',
        category: 'makeup',
        product_type: 'sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'sunscreen',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        benefit_tags: ['broad spectrum', 'spf 50', 'lightweight'],
        short_description: 'A daily tinted fluid sunscreen designed to sit well under makeup.',
        description: 'Use as the last step in your morning routine before makeup.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_tinted_sunscreen_boundary',
        primary_role_id: 'daily_sunscreen_finish_fit',
        framework_roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            rank: 1,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen finish fit',
            query_terms: ['sunscreen', 'spf fluid'],
            fit_keywords: ['sunscreen', 'spf', 'broad spectrum', 'lightweight'],
            product_type_hypotheses: ['sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.raw_candidate_count, 1);
  assert.equal(state.hard_reject_count, 1);
  assert.equal(state.hard_reject[0]?.product?.product_id, 'tinted_sunscreen_lp110');
  assert.equal(state.hard_reject[0]?.product?.concern_scope_classification, 'explicit_face_skincare');
  assert.equal(state.selected_recommendations.length, 0);
});

test('__internal: framework pool does not let low-fit external seeds satisfy routine support coverage', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'daily_tinted_sunscreen_fit_1',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        display_name: 'Daily Tinted Fluid Sunscreen DN310',
        category: 'Sunscreen',
        product_type: 'sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'sunscreen under makeup',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        local_external_seed_role_fit_score: 0.91,
        benefit_tags: ['spf', 'tinted', 'lightweight'],
        short_description: 'A lightweight tinted SPF fluid designed as the final daytime sunscreen step.',
      },
      {
        product_id: 'daily_layering_moisturizer_low_fit',
        merchant_id: 'external_seed',
        brand: 'LayerLab',
        display_name: 'Daily Layering Moisturizer',
        name: 'Daily Layering Moisturizer',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_query: 'moisturizer under makeup',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        local_external_seed_role_fit_score: 0.14,
        short_description: 'A lightweight moisturizer with Ceramide NP to prepare skin for makeup layering.',
        description: 'A daily face moisturizer for breathable layering under makeup.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_low_external_fit_support_coverage',
        primary_role_id: 'daily_sunscreen_finish_fit',
        framework_roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            rank: 1,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen finish fit',
            query_terms: ['sunscreen under makeup', 'lightweight sunscreen'],
            fit_keywords: ['sunscreen', 'spf', 'under makeup', 'lightweight', 'tinted'],
            product_type_hypotheses: ['sunscreen'],
          },
          {
            role_id: 'layering_compatible_moisturizer_or_spf',
            rank: 2,
            preferred_step: 'moisturizer',
            alternate_steps: ['sunscreen'],
            label: 'Layering-compatible moisturizer or SPF',
            query_terms: ['moisturizer under makeup', 'layering moisturizer'],
            fit_keywords: ['under makeup', 'layering', 'non-greasy', 'lightweight', 'sunscreen'],
            ingredient_hypotheses: ['Ceramide NP'],
            product_type_hypotheses: ['moisturizer', 'sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(
    state.selected_recommendations.some((item) => item?.product_id === 'daily_layering_moisturizer_low_fit'),
    false,
  );
  assert.equal(
    state.viable_candidate_pool.some((item) => item?.product_id === 'daily_layering_moisturizer_low_fit'),
    false,
  );
  assert.equal(state.role_pool_stats?.layering_compatible_moisturizer_or_spf?.viable_count, 0);
  const lowFitMismatch = (Array.isArray(state.soft_mismatch) ? state.soft_mismatch : [])
    .find((entry) => entry?.product?.product_id === 'daily_layering_moisturizer_low_fit') || null;
  assert.ok(lowFitMismatch);
  assert.equal(lowFitMismatch?.reason, 'framework_soft_mismatch');
  assert.equal(lowFitMismatch?.product?.framework_role_fit_score, 0.14);
});

test('__internal: framework pool keeps external-seed exact serum recall viable for hydrating serum primary', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'external_hydrating_serum_sparse_1',
        merchant_id: 'external_seed',
        brand: 'Example Lab',
        display_name: 'Cloud Water Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'hyaluronic acid serum',
        retrieval_step: 'serum',
        retrieval_role_id: 'hydrating_serum_or_essence',
        search_aliases: ['hyaluronic acid serum'],
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_hydrating_serum_external_sparse',
        primary_role_id: 'hydrating_serum_or_essence',
        framework_roles: [
          {
            role_id: 'hydrating_serum_or_essence',
            rank: 1,
            preferred_step: 'serum',
            label: 'Hydrating serum or essence',
            query_terms: ['hyaluronic acid serum', 'hydrating serum'],
            fit_keywords: ['hydrating', 'hydration', 'plumping'],
            ingredient_hypotheses: ['Hyaluronic Acid', 'Sodium Hyaluronate'],
            product_type_hypotheses: ['serum', 'essence', 'ampoule'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.weak_viable_pool, false);
  assert.equal(state.selected_recommendations[0]?.product_id, 'external_hydrating_serum_sparse_1');
  assert.equal(state.selected_recommendations[0]?.matched_role_id, 'hydrating_serum_or_essence');
  assert.ok(Number(state.selected_recommendations[0]?.framework_score || 0) >= 0.48);
});

test('__internal: framework pool rejects generic ingredient serum as an oil-control top pick without semantic role evidence', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'int_niac_1',
        merchant_id: 'merchant_int_niac',
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_role_id: 'oil_control_treatment',
        ingredient_tokens: ['niacinamide', 'zinc'],
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_id, 'oil_control_treatment');
  assert.equal(state.primary_role_matched, false);
  assert.equal(state.viable_candidate_count, 0);
  assert.equal(state.selected_candidate_count, 0);
  assert.ok(Number(state.hard_reject_count || 0) >= 1);
});

test('__internal: framework pool rejects a treatment-serum candidate that only matches by alternate step and retrieval role', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'int_niac_live_bug',
        merchant_id: 'merchant_int_niac_live_bug',
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'mattifying serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        ingredient_tokens: ['niacinamide', 'zinc'],
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_live_bug',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_id, 'oil_control_treatment');
  assert.equal(state.primary_role_matched, false);
  assert.equal(state.viable_candidate_count, 0);
  assert.equal(state.selected_candidate_count, 0);
  assert.ok(Number(state.hard_reject_count || 0) >= 1);
});

test('__internal: framework pool rejects a facial mask as an oil-control treatment when only retrieval-step matches', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'ext_mask_live_shape',
        merchant_id: 'external_seed',
        brand: 'Byoma',
        name: 'Bio-Collagen Radiance Facial Mask',
        display_name: 'Bio-Collagen Radiance Facial Mask',
        category: 'external',
        retrieval_source: 'external_seed',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        description_tokens: ['facial mask for radiance and skin texture'],
        ingredient_tokens: ['ceramide', 'centella', 'glycerin'],
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_mask',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, false);
  assert.equal(state.selected_candidate_count, 0);
  assert.ok(Number(state.hard_reject_count || 0) >= 1);
});

test('__internal: framework pool rejects non-facial hand cream from the lightweight moisturizer role', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'ext_hand_cream_live_shape',
        merchant_id: 'external_seed',
        brand: 'Beekman 1802',
        name: 'Pure Hand Cream',
        display_name: 'Pure Hand Cream',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        description_tokens: ['fragrance-free hand cream with goat milk'],
        ingredient_tokens: ['panthenol', 'glycerin'],
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_handcream',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'balancing', 'sebum'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'oil free moisturizer'],
            fit_keywords: ['lightweight', 'oil free', 'gel cream', 'breathable'],
          },
        ],
      },
    },
  );

  assert.equal(state.selected_candidate_count, 0);
  assert.ok(Number(state.hard_reject_count || 0) >= 1);
});

test('__internal: framework pool rescues an exact-step lightweight moisturizer support slot from role-matched catalog recall', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'catalog_oil_balance_support_1',
        merchant_id: 'merchant_catalog_oil_balance_support',
        brand: 'Clarity Lab',
        name: 'Oil Balance Serum',
        display_name: 'Clarity Lab Oil Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['Oil Control Serum'],
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'catalog_balance_lotion_1',
        merchant_id: 'merchant_catalog_balance_lotion',
        brand: 'LightLab',
        name: 'Daily Balance Lotion',
        display_name: 'LightLab Daily Balance Lotion',
        category: 'moisturizer',
        product_type: 'moisturizer',
        retrieval_source: 'catalog',
        retrieval_query: 'lightweight moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        short_description: 'A face lotion for oily skin.',
      },
      {
        product_id: 'catalog_uv_fluid_1',
        merchant_id: 'merchant_catalog_uv_fluid',
        brand: 'SunGuard',
        name: 'Daily UV Fluid SPF 50',
        display_name: 'SunGuard Daily UV Fluid SPF 50',
        category: 'sunscreen',
        product_type: 'sunscreen',
        retrieval_source: 'catalog',
        retrieval_query: 'daily sunscreen',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        benefit_tags: ['spf', 'broad spectrum'],
        short_description: 'A lightweight sunscreen for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_support_slot_rescue',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
            ingredient_hypotheses: ['Glycerin', 'Ceramide NP', 'Panthenol'],
            product_type_hypotheses: ['moisturizer'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 3,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['daily sunscreen', 'broad spectrum sunscreen'],
            fit_keywords: ['spf', 'broad spectrum', 'uv filters'],
            ingredient_hypotheses: ['UV filters'],
            product_type_hypotheses: ['sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 3);
  const moisturizer = state.selected_recommendations.find((item) => item?.matched_role_id === 'lightweight_moisturizer') || null;
  assert.ok(moisturizer);
  assert.equal(moisturizer?.candidate_step, 'moisturizer');
  assert.ok(Number(moisturizer?.framework_score || 0) >= 0.58);
  assert.equal(moisturizer?.framework_semantic_fit, true);
  assert.equal(state.role_pool_stats?.lightweight_moisturizer?.viable_count, 1);
  assert.ok(Number(state.role_pool_stats?.lightweight_moisturizer?.top_score || 0) >= 0.58);
});

test('__internal: framework pool rescues lotion-shaped moisturizer support when catalog rows omit the canonical moisturizer type token', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'catalog_oil_balance_support_alias_1',
        merchant_id: 'merchant_catalog_oil_balance_support_alias',
        brand: 'Clarity Lab',
        name: 'Oil Balance Serum',
        display_name: 'Clarity Lab Oil Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'catalog_balance_lotion_alias_1',
        merchant_id: 'merchant_catalog_balance_lotion_alias',
        brand: 'LightLab',
        name: 'Daily Balance Lotion',
        display_name: 'LightLab Daily Balance Lotion',
        category: 'lotion',
        product_type: 'lotion',
        retrieval_source: 'catalog',
        retrieval_query: 'oil free moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        short_description: 'A face lotion for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_support_lotion_alias_rescue',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
            ingredient_hypotheses: ['Glycerin', 'Ceramide NP', 'Panthenol'],
            product_type_hypotheses: ['moisturizer'],
          },
        ],
      },
    },
  );

  const moisturizer = state.selected_recommendations.find((item) => item?.matched_role_id === 'lightweight_moisturizer') || null;
  assert.ok(moisturizer);
  assert.equal(moisturizer?.candidate_step, 'moisturizer');
  assert.ok(Number(moisturizer?.framework_score || 0) >= 0.58);
  assert.equal(state.role_pool_stats?.lightweight_moisturizer?.viable_count, 1);
});

test('__internal: framework pool rescues exact-step sunscreen support from role-matched external seed recall with weak title semantics', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'catalog_oil_balance_support_anchor_1',
        merchant_id: 'merchant_catalog_oil_balance_support_anchor',
        brand: 'Clarity Lab',
        name: 'Oil Balance Serum',
        display_name: 'Clarity Lab Oil Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['Oil Control Serum'],
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'external_seed_moisturizer_support_1',
        merchant_id: 'external_seed',
        brand: 'LightLab',
        name: 'Daily Balance Gel Cream',
        display_name: 'LightLab Daily Balance Gel Cream',
        category: 'moisturizer',
        product_type: 'moisturizer',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        short_description: 'A breathable gel cream for oily skin.',
      },
      {
        product_id: 'external_seed_sunscreen_support_weak_1',
        merchant_id: 'external_seed',
        brand: 'SunGuard',
        name: 'Daily Protect',
        display_name: 'SunGuard Daily Protect',
        category: 'sunscreen',
        product_type: 'sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight sunscreen oily skin',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        short_description: 'A daily face product.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_support_sunscreen_step_rescue',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
            ingredient_hypotheses: ['Glycerin', 'Ceramide NP', 'Panthenol'],
            product_type_hypotheses: ['moisturizer'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 3,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['oil control sunscreen', 'lightweight sunscreen oily skin'],
            fit_keywords: ['spf', 'lightweight', 'uv filters', 'non-greasy'],
            ingredient_hypotheses: ['UV filters'],
            product_type_hypotheses: ['sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 3);
  const sunscreen = state.selected_recommendations.find((item) => item?.matched_role_id === 'daily_sunscreen') || null;
  assert.ok(sunscreen);
  assert.equal(sunscreen?.candidate_step, 'sunscreen');
  assert.equal(sunscreen?.candidate_step_source, 'structured_category');
  assert.ok(Number(sunscreen?.framework_score || 0) >= 0.58);
  assert.equal(state.role_pool_stats?.daily_sunscreen?.viable_count, 1);
});

test('__internal: framework pool rejects cross-step cleanser-plus-spf bundles from the sunscreen support pool', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'catalog_oil_balance_support_anchor_bundle_1',
        merchant_id: 'merchant_catalog_oil_balance_support_anchor_bundle',
        brand: 'Clarity Lab',
        name: 'Oil Balance Serum',
        display_name: 'Clarity Lab Oil Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['Oil Control Serum'],
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'external_seed_moisturizer_support_bundle_1',
        merchant_id: 'external_seed',
        brand: 'LightLab',
        name: 'Daily Balance Gel Cream',
        display_name: 'LightLab Daily Balance Gel Cream',
        category: 'moisturizer',
        product_type: 'moisturizer',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        short_description: 'A breathable gel cream for oily skin.',
      },
      {
        product_id: 'external_seed_sunscreen_support_valid_1',
        merchant_id: 'external_seed',
        brand: 'SunGuard',
        name: 'Daily Protect',
        display_name: 'SunGuard Daily Protect',
        category: 'sunscreen',
        product_type: 'sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight sunscreen oily skin',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        short_description: 'A daily face product.',
      },
      {
        product_id: 'external_seed_cross_step_bundle_1',
        merchant_id: 'external_seed',
        brand: 'KraveBeauty',
        name: 'Barrier Protector',
        display_name: 'Barrier Protector',
        category: 'cleanser',
        product_type: 'cleanser',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight sunscreen oily skin',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        short_description: 'A hydrating cleanser paired with a lightweight SPF that protects against UV rays without a white cast, irritation, or heaviness.',
        description: 'Your AM routine, bookended by the best. This hydrating duo features Matcha Hemp Hydrating Cleanser and Beet The Sun SPF 40. Includes 1 full-size cleanser and 1 full-size sunscreen.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_support_sunscreen_bundle_reject',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
            ingredient_hypotheses: ['Glycerin', 'Ceramide NP', 'Panthenol'],
            product_type_hypotheses: ['moisturizer'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 3,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['oil control sunscreen', 'lightweight sunscreen oily skin'],
            fit_keywords: ['spf', 'lightweight', 'uv filters', 'non-greasy'],
            ingredient_hypotheses: ['UV filters'],
            product_type_hypotheses: ['sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.role_pool_stats?.daily_sunscreen?.viable_count, 1);
  assert.equal(
    state.viable_candidate_pool.some((item) => item?.product_id === 'external_seed_cross_step_bundle_1'),
    false,
  );
  const reject = (Array.isArray(state.hard_reject) ? state.hard_reject : [])
    .find((entry) => entry?.product?.product_id === 'external_seed_cross_step_bundle_1') || null;
  assert.ok(reject);
  assert.equal(reject?.reason, 'framework_coarse_invalid_cleanser');
  const sunscreen = state.selected_recommendations.find((item) => item?.matched_role_id === 'daily_sunscreen') || null;
  assert.ok(sunscreen);
  assert.equal(sunscreen?.product_id, 'external_seed_sunscreen_support_valid_1');
});

test('__internal: framework pool keeps exact-step sunscreen support viable when only retrieval-step plus weak support semantics are present', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'retrieval_step_anchor_oil_1',
        merchant_id: 'merchant_retrieval_step_anchor_oil_1',
        brand: 'Clarity Lab',
        name: 'Oil Balance Serum',
        display_name: 'Clarity Lab Oil Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'retrieval_step_sunscreen_support_1',
        merchant_id: 'external_seed',
        brand: 'SunGuard',
        name: 'Daily Protect',
        display_name: 'SunGuard Daily Protect',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight sunscreen oily skin',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        short_description: 'A lightweight face product.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_support_sunscreen_retrieval_step_rescue',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 3,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['oil control sunscreen', 'lightweight sunscreen oily skin'],
            fit_keywords: ['spf', 'lightweight', 'uv filters', 'non-greasy'],
            ingredient_hypotheses: ['UV filters'],
            product_type_hypotheses: ['sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  const sunscreen = state.selected_recommendations.find((item) => item?.matched_role_id === 'daily_sunscreen') || null;
  assert.ok(sunscreen);
  assert.equal(sunscreen?.candidate_step, 'sunscreen');
  assert.equal(sunscreen?.candidate_step_source, 'retrieval_step');
  assert.ok(Number(sunscreen?.framework_score || 0) >= 0.52);
  assert.equal(state.role_pool_stats?.daily_sunscreen?.viable_count, 1);
});

staleFallbackPlannerTest('__internal: framework pool surfaces multiple primary-role products before support fillers for horizontal comparison', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'catalog_oil_compare_1',
        merchant_id: 'merchant_catalog_oil_compare_1',
        brand: 'Clarity Lab',
        name: 'Oil Balance Serum',
        display_name: 'Clarity Lab Oil Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'catalog_oil_compare_2',
        merchant_id: 'merchant_catalog_oil_compare_2',
        brand: 'Balance Co',
        name: 'Shine Control Serum',
        display_name: 'Balance Co Shine Control Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'shine control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['shine control', 'sebum balance'],
        short_description: 'A lightweight serum that helps manage sebum and visible shine.',
      },
      {
        product_id: 'catalog_oil_compare_3',
        merchant_id: 'merchant_catalog_oil_compare_3',
        brand: 'Matte Studio',
        name: 'Sebum Reset Serum',
        display_name: 'Matte Studio Sebum Reset Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'mattifying serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['oil control serum', 'shine control serum'],
        benefit_tags: ['oil control', 'shine control', 'mattifying', 'sebum'],
        short_description: 'A mattifying oil-control serum that helps manage sebum and shine for oily skin.',
      },
      {
        product_id: 'catalog_oil_support_moisturizer',
        merchant_id: 'merchant_catalog_oil_support_moisturizer',
        brand: 'LightLab',
        name: 'Daily Balance Lotion',
        display_name: 'LightLab Daily Balance Lotion',
        category: 'moisturizer',
        product_type: 'moisturizer',
        retrieval_source: 'catalog',
        retrieval_query: 'lightweight moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        short_description: 'A breathable gel lotion for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_horizontal_compare',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 3);
  assert.deepEqual(
    state.selected_recommendations.map((item) => item?.matched_role_id),
    ['oil_control_treatment', 'oil_control_treatment', 'oil_control_treatment'],
  );
  assert.equal(
    state.selected_recommendations.some((item) => item?.product_id === 'catalog_oil_support_moisturizer'),
    false,
  );
  assert.equal(state.exact_step_viable_count, 3);
  assert.equal(state.group_target_fidelity.length, 3);
});

test('__internal: framework pool prioritizes routine support before same-role soft comparison when primary coverage is thin', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'routine_primary_oil_1',
        merchant_id: 'merchant_routine_primary_oil_1',
        brand: 'Strong',
        name: 'Oil Control Serum',
        display_name: 'Strong Oil Control Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['oil control', 'shine control', 'mattifying'],
        search_aliases: ['shine control serum'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'routine_support_moisturizer_1',
        merchant_id: 'merchant_routine_support_moisturizer_1',
        brand: 'LightLab',
        name: 'Oil-Free Gel Cream',
        display_name: 'LightLab Oil-Free Gel Cream',
        category: 'moisturizer',
        product_type: 'moisturizer',
        retrieval_source: 'catalog',
        retrieval_query: 'lightweight moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        benefit_tags: ['lightweight', 'gel cream', 'oil-free'],
        short_description: 'A lightweight oil-free gel cream moisturizer for oily skin.',
      },
      {
        product_id: 'routine_soft_compare_oil_1',
        merchant_id: 'merchant_routine_soft_compare_oil_1',
        brand: 'Alt',
        name: 'Balancing Serum',
        display_name: 'Alt Balancing Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'balancing serum oily skin',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        short_description: 'A balancing serum for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_routine_before_soft_compare',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 3);
  assert.deepEqual(
    state.selected_recommendations.map((item) => item?.product_id),
    ['routine_primary_oil_1', 'routine_support_moisturizer_1', 'routine_soft_compare_oil_1'],
  );
  assert.deepEqual(
    state.selected_recommendations.map((item) => item?.matched_role_id),
    ['oil_control_treatment', 'lightweight_moisturizer', 'oil_control_treatment'],
  );
  assert.equal(state.routine_support_fill_applied, true);
  assert.equal(state.routine_support_fill_count, 1);
  assert.equal(state.comparison_fill_applied, false);
  assert.equal(state.comparison_fill_count, 0);
});

test('__internal: framework pool prioritizes a complete core routine over same-role soft comparison when both support roles fit the card budget', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'reserve_primary_oil_1',
        merchant_id: 'merchant_reserve_primary_oil_1',
        brand: 'Strong',
        name: 'Oil Control Serum',
        display_name: 'Strong Oil Control Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['oil control', 'shine control', 'mattifying'],
        search_aliases: ['shine control serum'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'reserve_support_moisturizer_1',
        merchant_id: 'merchant_reserve_support_moisturizer_1',
        brand: 'LightLab',
        name: 'Oil-Free Gel Cream',
        display_name: 'LightLab Oil-Free Gel Cream',
        category: 'moisturizer',
        product_type: 'moisturizer',
        retrieval_source: 'catalog',
        retrieval_query: 'lightweight moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_role_id: 'lightweight_moisturizer',
        benefit_tags: ['lightweight', 'gel cream', 'oil-free'],
        short_description: 'A lightweight oil-free gel cream moisturizer for oily skin.',
      },
      {
        product_id: 'reserve_support_sunscreen_1',
        merchant_id: 'merchant_reserve_support_sunscreen_1',
        brand: 'SunGuard',
        name: 'Matte UV Fluid SPF 50',
        display_name: 'SunGuard Matte UV Fluid SPF 50',
        category: 'sunscreen',
        product_type: 'sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'oil control sunscreen',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        benefit_tags: ['oil control', 'spf', 'lightweight'],
        short_description: 'A lightweight sunscreen for oily skin.',
      },
      {
        product_id: 'reserve_soft_compare_oil_1',
        merchant_id: 'merchant_reserve_soft_compare_oil_1',
        brand: 'Alt',
        name: 'Balancing Serum',
        display_name: 'Alt Balancing Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'balancing serum oily skin',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        short_description: 'A balancing serum for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_reserve_compare_slot',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 3,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['oil control sunscreen', 'lightweight sunscreen oily skin'],
            fit_keywords: ['oil control', 'lightweight', 'uv filters', 'spf', 'non-greasy'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 3);
  assert.deepEqual(
    state.selected_recommendations.map((item) => item?.product_id),
    ['reserve_primary_oil_1', 'reserve_support_moisturizer_1', 'reserve_support_sunscreen_1'],
  );
  assert.deepEqual(
    state.selected_recommendations.map((item) => item?.matched_role_id),
    ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
  );
  assert.equal(
    state.selected_recommendations.some((item) => item?.product_id === 'reserve_soft_compare_oil_1'),
    false,
  );
  assert.equal(state.comparison_slot_reserved, false);
  assert.equal(state.routine_support_fill_applied, true);
  assert.equal(state.routine_support_fill_count, 2);
  assert.equal(state.comparison_fill_applied, false);
  assert.equal(state.comparison_fill_count, 0);
});

test('__internal: framework pool surfaces same-role comparison rows without fallback-fill labeling when explicitly requested', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'strong_anchor',
        merchant_id: 'merchant_catalog_strong_anchor',
        brand: 'Strong',
        name: 'Oil Control Serum',
        display_name: 'Strong Oil Control Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['oil control', 'shine control', 'mattifying'],
        search_aliases: ['shine control serum'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
      {
        product_id: 'soft_compare_external_1',
        merchant_id: 'merchant_soft_compare_external_1',
        brand: 'Alt2',
        name: 'Balancing Serum',
        display_name: 'Alt2 Balancing Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'balancing serum oily skin',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        short_description: 'A balancing serum for oily skin.',
      },
      {
        product_id: 'soft_compare_external_2',
        merchant_id: 'merchant_soft_compare_external_2',
        brand: 'Alt3',
        name: 'Shine Control Serum',
        display_name: 'Alt3 Shine Control Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'shine control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['shine control'],
        short_description: 'A serum for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_soft_compare_fill',
        primary_role_id: 'oil_control_treatment',
        comparison_mode: 'same_role_comparison',
        semantic_plan: {
          routine_mode: 'same_role_comparison',
          comparison_mode: 'same_role_comparison',
        },
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'barrier lotion'],
            fit_keywords: ['lightweight', 'gel cream', 'water gel', 'breathable', 'barrier lotion', 'oil-free'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 3);
  assert.deepEqual(
    state.selected_recommendations.map((item) => item?.product_id),
    ['strong_anchor', 'soft_compare_external_2', 'soft_compare_external_1'],
  );
  assert.equal(state.comparison_fill_applied, false);
  assert.equal(state.comparison_fill_count, 0);
  assert.equal(state.selected_source_counts?.catalog, 1);
  assert.equal(state.selected_source_counts?.external_seed, 2);
  assert.equal(
    state.selected_recommendations.filter((item) => item?.comparison_fill === true).length,
    0,
  );
});

test('__internal: strict single-product budget plans do not backfill same-role soft comparison rows', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'budget_primary_under_20',
        merchant_id: 'merchant_budget_primary_under_20',
        brand: 'Budget',
        name: 'Niacinamide Serum',
        display_name: 'Budget Niacinamide Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'salicylic acid serum clogged pores',
        retrieval_step: 'treatment',
        retrieval_role_id: 'acne_clogged_pore_treatment',
        benefit_tags: ['niacinamide', 'oil control', 'pores'],
        short_description: 'A budget niacinamide serum for visible oil and pore support.',
        price: { amount: 12, currency: 'USD', unknown: false },
      },
      {
        product_id: 'primary_exact_20_should_drop',
        merchant_id: 'merchant_primary_exact_20_should_drop',
        brand: 'Exact',
        name: 'Salicylic Acid Serum 2%',
        display_name: 'Exact Salicylic Acid Serum 2%',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'salicylic acid serum clogged pores',
        retrieval_step: 'treatment',
        retrieval_role_id: 'acne_clogged_pore_treatment',
        benefit_tags: ['salicylic acid', 'acne'],
        short_description: 'A clarifying acne serum priced at the ceiling.',
        price: { amount: 20, currency: 'USD', unknown: false },
      },
      {
        product_id: 'primary_over_budget_should_drop',
        merchant_id: 'merchant_primary_over_budget_should_drop',
        brand: 'Premium',
        name: 'Acne Treatment Serum',
        display_name: 'Premium Acne Treatment Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'salicylic acid serum clogged pores',
        retrieval_step: 'treatment',
        retrieval_role_id: 'acne_clogged_pore_treatment',
        benefit_tags: ['salicylic acid', 'acne'],
        short_description: 'A higher-priced acne serum.',
        price: { amount: 45, currency: 'USD', unknown: false },
      },
      {
        product_id: 'soft_compare_over_budget',
        merchant_id: 'merchant_soft_compare_over_budget',
        brand: 'Mid',
        name: 'Barrier Treatment',
        display_name: 'Mid Barrier Treatment',
        category: 'treatment',
        product_type: 'treatment',
        retrieval_source: 'catalog',
        retrieval_query: 'salicylic acid serum clogged pores',
        retrieval_step: 'treatment',
        retrieval_role_id: 'acne_clogged_pore_treatment',
        short_description: 'A broader barrier serum that is not the requested budget first buy.',
        price: { amount: 28, currency: 'USD', unknown: false },
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_budget_single_product_no_soft_fill',
        primary_role_id: 'acne_clogged_pore_treatment',
        mainline_fallback_policy: 'strict_no_runtime_fallback',
        semantic_planner_required: true,
        request_text: 'I have acne-prone oily skin and want one product under $20 to buy first. What should I get?',
        explicit_single_product_request: true,
        budget_ceiling: { amount: 20, currency: 'USD', source: 'request_text', exclusive_upper_bound: true },
        semantic_plan: {
          routine_mode: 'single_product',
          comparison_mode: 'single_product',
          must_satisfy_constraints: ['one product under $20'],
        },
        framework_roles: [
          {
            role_id: 'acne_clogged_pore_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Acne and clogged-pore treatment',
            query_terms: ['salicylic acid serum clogged pores', 'niacinamide serum acne prone oily skin'],
            fit_keywords: ['acne', 'clogged', 'pores', 'niacinamide', 'oil control', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 1);
  assert.deepEqual(
    state.selected_recommendations.map((item) => item?.product_id),
    ['budget_primary_under_20'],
  );
  assert.equal(state.comparison_fill_allowed, false);
  assert.equal(state.comparison_fill_applied, false);
  assert.equal(state.comparison_fill_count, 0);
});

test('__internal: beauty mainline handoff payload preserves viable support role candidates in ranked targets even when they are not selected', async () => {
  const { __internal } = loadRoutesFresh();
  const semanticPlan = buildConcernSemanticPlanFixture();
  const targetContext = {
    framework_id: 'recofw_test_handoff_role_candidate_persistence',
    primary_role_id: 'oil_control_treatment',
    framework_roles: semanticPlan.core_roles,
    semantic_plan: semanticPlan,
  };
  const selectedRecommendations = [
    {
      product_id: 'handoff_primary_oil_1',
      merchant_id: 'merchant_handoff_primary_oil_1',
      brand: 'Strong',
      name: 'Oil Control Serum',
      display_name: 'Strong Oil Control Serum',
      category: 'serum',
      product_type: 'serum',
      retrieval_source: 'catalog',
      matched_role_id: 'oil_control_treatment',
      framework_score: 0.91,
      framework_tiebreak_score: 0.41,
    },
    {
      product_id: 'handoff_support_moisturizer_1',
      merchant_id: 'external_seed',
      brand: 'LightLab',
      name: 'Oil-Free Gel Cream',
      display_name: 'LightLab Oil-Free Gel Cream',
      category: 'moisturizer',
      product_type: 'moisturizer',
      retrieval_source: 'external_seed',
      matched_role_id: 'lightweight_moisturizer',
      framework_score: 0.72,
      framework_tiebreak_score: 0.23,
    },
    {
      product_id: 'handoff_soft_compare_oil_1',
      merchant_id: 'merchant_handoff_soft_compare_oil_1',
      brand: 'Alt',
      name: 'Balancing Serum',
      display_name: 'Alt Balancing Serum',
      category: 'serum',
      product_type: 'serum',
      retrieval_source: 'catalog',
      matched_role_id: 'oil_control_treatment',
      framework_score: 0.49,
      framework_tiebreak_score: 0.12,
      comparison_fill: true,
      comparison_fill_reason: 'same_role_soft_mismatch',
    },
  ];
  const viableDailySunscreen = {
    product_id: 'handoff_sunscreen_viable_1',
    merchant_id: 'external_seed',
    brand: 'SunGuard',
    name: 'Matte UV Fluid SPF 50',
    display_name: 'SunGuard Matte UV Fluid SPF 50',
    category: 'sunscreen',
    product_type: 'sunscreen',
    retrieval_source: 'external_seed',
    matched_role_id: 'daily_sunscreen',
    framework_score: 0.66,
    framework_tiebreak_score: 0.31,
  };
  const selectionContract = {
    selection_owner: 'shopping_agent_beauty_mainline',
    selected_product_ids: selectedRecommendations.map((item) => item.product_id),
    selected_titles: selectedRecommendations.map((item) => item.display_name),
    selection_signature: 'reco_sel_handoff_role_candidate_persistence',
    mainline_status: 'grounded_success',
    source_tier_counts: {
      fresh_internal: 2,
      fresh_external: 1,
    },
    top_candidate_provenance: {
      source_owner: 'catalog',
    },
  };
  const handoff = {
    searchResult: {
      decision_owner: 'shopping_agent_beauty_mainline',
      semantic_owner: 'shopping_agent_beauty_mainline',
      contract_bridge: {
        attempted_contract: 'agent_v1_search_beauty_mainline',
        resolved_contract: 'agent_v1_search_beauty_mainline',
      },
      source_breakdown: {
        source_tier_counts: {
          fresh_internal: 2,
          fresh_external: 1,
        },
      },
      final_selection: selectionContract,
      search_stage_ledger: {
        final_selection: selectionContract,
        candidate_pool_summary: {
          comparison_slot_reserved: true,
        },
      },
      candidate_state: {
        viable_candidate_pool: [
          selectedRecommendations[0],
          selectedRecommendations[1],
          viableDailySunscreen,
        ],
      },
      metadata: {
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        contract_bridge: {
          attempted_contract: 'agent_v1_search_beauty_mainline',
          resolved_contract: 'agent_v1_search_beauty_mainline',
        },
        source_breakdown: {
          source_tier_counts: {
            fresh_internal: 2,
            fresh_external: 1,
          },
        },
        final_selection: selectionContract,
        search_stage_ledger: {
          final_selection: selectionContract,
        },
      },
    },
    recommendations: selectedRecommendations,
  };

  const bundle = __internal.buildRecoPayloadFromBeautyMainlineHandoff({
    handoff,
    profile: { skinType: 'oily', goals: ['oil control'] },
    targetContext,
    recoContext: {
      resolved_target_step: 'treatment',
      ingredient_query: 'oil control',
    },
    taskMode: 'goal_based_products',
    triggerSource: 'typed_reco',
    sourceMode: 'framework_mainline',
    basePayload: {
      recommendation_confidence_score: 0.61,
      recommendation_confidence_level: 'medium',
      recommendation_meta: {
        used_recent_logs: false,
        used_safety_flags: false,
      },
    },
    selectionOwner: 'shopping_agent_beauty_mainline',
    entryType: 'chat',
    language: 'EN',
  });

  assert.ok(bundle?.payload);
  const rankedTargets = Array.isArray(bundle.payload?.recommendation_meta?.ranked_targets)
    ? bundle.payload.recommendation_meta.ranked_targets
    : [];
  const sunscreenTarget = rankedTargets.find((item) => item?.target_id === 'daily_sunscreen') || null;
  assert.ok(sunscreenTarget);
  assert.equal(sunscreenTarget?.verified_product_count, 1);
  assert.equal(sunscreenTarget?.product_candidates?.[0]?.product_id, 'handoff_sunscreen_viable_1');
  assert.deepEqual(bundle.payload?.recommendation_meta?.selected_target_ids, [
    'oil_control_treatment',
    'lightweight_moisturizer',
  ]);

  const persistedSunscreenTarget = (Array.isArray(bundle.recoContext?.ranked_targets) ? bundle.recoContext.ranked_targets : [])
    .find((item) => item?.target_id === 'daily_sunscreen') || null;
  assert.ok(persistedSunscreenTarget);
  assert.equal(persistedSunscreenTarget?.verified_product_count, 1);
  assert.equal(persistedSunscreenTarget?.product_candidates?.[0]?.product_id, 'handoff_sunscreen_viable_1');
});

test('__internal: beauty local handoff external stage uses backend authority after local seed miss', async () => {
  const { __internal } = loadRoutesFresh();
  const calls = [];
  const targetContext = {
    framework_id: 'recofw_test_oily_backend_external_authority',
    primary_role_id: 'oil_control_treatment',
    routine_mode: 'routine_mix',
    semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
    framework_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 10,
        preferred_step: 'treatment',
        label: 'Oil-control treatment',
        query_terms: ['niacinamide serum oily skin'],
        fit_keywords: ['oil control', 'shine control', 'niacinamide', 'zinc'],
        ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
        product_type_hypotheses: ['serum', 'treatment'],
      },
      {
        role_id: 'lightweight_moisturizer',
        rank: 20,
        preferred_step: 'moisturizer',
        label: 'Lightweight moisturizer',
        query_terms: ['lightweight moisturizer oily skin'],
        fit_keywords: ['lightweight', 'gel cream', 'oil-free'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['lightweight sunscreen oily skin'],
        fit_keywords: ['spf', 'lightweight', 'oil control', 'non-greasy'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };

  __internal.__setRouteDependencyOverridesForTest({
    searchLocalExternalSeedProducts: async (args = {}) => {
      calls.push({ kind: 'local_external_seed', query: args.query, preferredStep: args.preferredStep });
      return {
        ok: false,
        products: [],
        reason: 'empty',
        local_external_seed_search_mode: 'staged_support_fastpath',
        local_external_seed_stage_debug: [{ stage: 'support_query_precise', row_count: 0 }],
      };
    },
    searchInternalProductsPrimitive: async (args = {}) => {
      calls.push({
        kind: args.allowExternalSeed === true ? 'backend_external_seed' : 'internal',
        query: args.query,
        allowExternalSeed: args.allowExternalSeed === true,
        externalSeedStrategy: args.externalSeedStrategy || null,
        callerLane: args.callerLane || null,
      });
      const query = String(args.query || '').trim().toLowerCase();
      const base = {
        ok: true,
        attempted_base_urls: ['https://backend.test'],
        attempted_paths: ['/agent/internal/products/search'],
        attempted_request_timeouts_ms: [1000],
        actual_http_attempt_count: 1,
        transport_hops: [
          {
            caller_lane: args.callerLane || 'beauty_chat_handoff',
            target_base_url: 'https://backend.test',
            target_path: '/agent/internal/products/search',
            endpoint_kind: 'internal_primitive',
            transport_owner: 'internal_products_search_primitive',
            latency_ms: 10,
            result: 'ok',
          },
        ],
        transport_hop_count: 1,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      };
      if (args.allowExternalSeed === true && query.includes('sunscreen')) {
        return {
          ...base,
          products: [
            {
              product_id: 'backend_sunscreen_authority_1',
              merchant_id: 'external_seed',
              brand: 'SunGuard',
              name: 'Lightweight Daily Sunscreen SPF 50',
              display_name: 'SunGuard Lightweight Daily Sunscreen SPF 50',
              category: 'Sunscreen',
              product_type: 'Sunscreen',
              retrieval_source: 'external_seed',
              short_description: 'A lightweight non-greasy sunscreen for oily skin.',
              benefit_tags: ['spf', 'lightweight', 'non-greasy'],
            },
          ],
        };
      }
      if (query.includes('niacinamide')) {
        return {
          ...base,
          products: [
            {
              product_id: 'internal_oil_control_1',
              merchant_id: 'merchant_internal',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              category: 'Serum',
              product_type: 'Serum',
              retrieval_source: 'catalog',
              short_description: 'A niacinamide and zinc serum for oily skin.',
              benefit_tags: ['niacinamide', 'oil control', 'zinc'],
            },
          ],
        };
      }
      if (query.includes('moisturizer')) {
        return {
          ...base,
          products: [
            {
              product_id: 'internal_moisturizer_1',
              merchant_id: 'merchant_internal',
              brand: 'GelLab',
              name: 'Balance Gel Cream',
              display_name: 'GelLab Balance Gel Cream',
              category: 'Moisturizer',
              product_type: 'Moisturizer',
              retrieval_source: 'catalog',
              short_description: 'A lightweight gel cream moisturizer for oily skin.',
              benefit_tags: ['lightweight', 'gel cream'],
            },
          ],
        };
      }
      return { ...base, products: [] };
    },
  });

  try {
    const out = await __internal.runBeautyMainlineLocalHandoffSearch({
      ctx: { lang: 'EN' },
      logger: null,
      targetContext,
      profileSummary: { skinType: 'oily', goals: ['oil control'] },
      timeoutMs: 10000,
      deadlineMs: Date.now() + 10000,
    });

    assert.equal(out?.ok, true);
    assert.deepEqual(
      (Array.isArray(out.products) ? out.products : []).map((item) => item?.matched_role_id),
      ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
    );
    assert.ok(
      calls.some((call) =>
        call.kind === 'local_external_seed' &&
        call.query === 'lightweight sunscreen oily skin'),
      JSON.stringify(calls),
    );
    assert.ok(
      calls.some((call) =>
        call.kind === 'backend_external_seed' &&
        call.query === 'lightweight sunscreen oily skin' &&
        call.allowExternalSeed === true &&
        call.externalSeedStrategy === 'stage_planned' &&
        call.callerLane === 'beauty_chat_handoff_external_seed_authority'),
      JSON.stringify(calls),
    );
    const sunscreenAttempt = (out.search_stage_ledger?.primary_search?.query_pack_attempts || [])
      .find((entry) =>
        entry?.role_id === 'daily_sunscreen' &&
        entry?.source_scope === 'external_seed' &&
        entry?.query === 'lightweight sunscreen oily skin') || null;
    assert.ok(sunscreenAttempt);
    assert.equal(sunscreenAttempt.external_seed_authority_backend_after_local_miss, true);
  } finally {
    __internal.__resetRouteDependencyOverridesForTest();
  }
});

function extractRecoRewritePromptContext(prompt) {
  const raw = String(prompt || '');
  const marker = 'Context: ';
  const idx = raw.lastIndexOf(marker);
  assert.ok(idx >= 0, 'expected rewrite prompt context marker');
  return JSON.parse(raw.slice(idx + marker.length));
}

test('__internal: reco assistant rewrite prompt exposes routine roles and price order for mixed-role bundles', async () => {
  const { __internal } = loadRoutesFresh();
  const prompt = __internal.buildRecoAssistantRewritePrompt({
    language: 'EN',
    userRequestText: 'im oily skin. what product should i buy?',
    profile: { skinType: 'oily', goals: ['oil control'] },
    payload: {
      roles: [
        {
          role_id: 'oil_control_treatment',
          label: 'Oil-control treatment',
          why_this_role: 'Start with a targeted oil-control step to manage shine.',
          preferred_step: 'treatment',
          rank: 1,
          slot: 'pm',
        },
        {
          role_id: 'lightweight_moisturizer',
          label: 'Lightweight moisturizer',
          why_this_role: 'Keep hydration breathable and light.',
          preferred_step: 'moisturizer',
          rank: 2,
          slot: 'other',
        },
        {
          role_id: 'daily_sunscreen',
          label: 'Daily sunscreen',
          why_this_role: 'Protect skin during the day without a greasy finish.',
          preferred_step: 'sunscreen',
          rank: 3,
          slot: 'am',
        },
      ],
      recommendation_meta: {
        primary_target_id: 'oil_control_treatment',
        selected_target_ids: ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
          {
            target_id: 'lightweight_moisturizer',
            ingredient_query: 'Lightweight moisturizer',
            resolved_target_step: 'moisturizer',
          },
          {
            target_id: 'daily_sunscreen',
            ingredient_query: 'Daily sunscreen',
            resolved_target_step: 'sunscreen',
          },
        ],
      },
      recommendations: [
        {
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          brand: 'The Ordinary',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          why_this_one: 'Helps take down excess shine without feeling heavy.',
          price: { amount: 12, currency: 'USD' },
        },
        {
          display_name: 'Hydrating Dewy Gel Cream',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          matched_role_id: 'lightweight_moisturizer',
          matched_role_label: 'Lightweight moisturizer',
          why_this_one: 'Adds breathable hydration without a greasy finish.',
          price: { amount: 38, currency: 'USD' },
        },
        {
          display_name: 'UV Filters SPF 45 Serum',
          brand: 'The Ordinary',
          category: 'Sunscreen',
          matched_role_id: 'daily_sunscreen',
          matched_role_label: 'Daily sunscreen',
          why_this_one: 'Keeps daytime protection lightweight.',
          price: { amount: 19, currency: 'USD' },
        },
      ],
    },
  });

  assert.match(prompt, /different steps in a basic routine and not the same type of product/i);
  assert.match(prompt, /Use price_order_summary and selected_product_details\.price_position/i);
  assert.match(prompt, /do not compare affordability across different routine roles/i);

  const context = extractRecoRewritePromptContext(prompt);
  assert.equal(context.selected_product_role_mix, 'routine_mix');
  assert.deepEqual(
    context.selected_product_details.map((item) => item.role_scope),
    ['primary', 'secondary', 'secondary'],
  );
  assert.deepEqual(
    context.selected_product_details.map((item) => item.price_position),
    ['lowest', 'highest', 'middle'],
  );
  assert.deepEqual(
    context.price_order_summary.map((item) => item.name),
    ['The Ordinary Niacinamide 10% + Zinc 1%', 'UV Filters SPF 45 Serum', 'Hydrating Dewy Gel Cream'],
  );
  assert.deepEqual(
    context.price_order_summary.map((item) => item.price_position),
    ['lowest', 'middle', 'highest'],
  );
  assert.equal(
    context.assistant_write_plan?.lead_product?.price_note,
    '$12 for the lead step',
  );
  assert.doesNotMatch(
    String(context.assistant_write_plan?.lead_product?.price_note || ''),
    /lowest|lower|affordable|value/i,
  );
});

test('__internal: reco assistant rewrite guard rejects cross-role price comparisons for routine bundles', async () => {
  const { __internal } = loadRoutesFresh();
  const payload = {
    recommendation_meta: {
      primary_target_id: 'daily_sunscreen_finish_fit',
      selected_target_ids: ['daily_sunscreen_finish_fit', 'hydrating_serum_or_essence'],
      ranked_targets: [
        {
          target_id: 'daily_sunscreen_finish_fit',
          ingredient_query: 'Daily sunscreen with finish fit',
          resolved_target_step: 'sunscreen',
        },
        {
          target_id: 'hydrating_serum_or_essence',
          ingredient_query: 'Hydrating serum or essence',
          resolved_target_step: 'serum',
        },
      ],
    },
    recommendations: [
      {
        display_name: 'Daily Layering SPF 50',
        brand: 'Murad',
        matched_role_id: 'daily_sunscreen_finish_fit',
        matched_role_label: 'Daily sunscreen with finish fit',
        price: { amount: 55, currency: 'USD' },
      },
      {
        display_name: 'Truth Serum',
        brand: 'Olehenriksen',
        matched_role_id: 'hydrating_serum_or_essence',
        matched_role_label: 'Hydrating serum or essence',
        price: { amount: 58, currency: 'USD' },
      },
    ],
  };
  const baseArgs = {
    payload,
    language: 'EN',
    primaryTarget: {
      target_id: 'daily_sunscreen_finish_fit',
      ingredient_query: 'Daily sunscreen with finish fit',
      resolved_target_step: 'sunscreen',
    },
    secondaryTargets: [
      {
        target_id: 'hydrating_serum_or_essence',
        ingredient_query: 'Hydrating serum or essence',
        resolved_target_step: 'serum',
      },
    ],
    names: ['Daily Layering SPF 50', 'Truth Serum'],
    requestMode: 'buy',
  };

  const valid = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    candidateText: 'Daily Layering SPF 50 fits this request for daily sunscreen with finish fit because it combines SPF 50 protection with a non-greasy moisturizer step for fewer layers. Truth Serum covers the serum step because it provides lightweight hydration before SPF.',
  });
  assert.equal(valid.reason, null);

  const invalid = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    candidateText: 'Daily Layering SPF 50 fits this request for daily sunscreen with finish fit because it combines SPF 50 protection with hydration while being the lower-priced primary option at $55. Truth Serum covers the serum step because it provides lightweight hydration before SPF.',
  });
  assert.equal(invalid.reason, 'rewrite_routine_cross_role_price_comparison');
});

test('__internal: reco assistant rewrite guard rejects re-asking known skin type only when the actual question repeats it', async () => {
  const { __internal } = loadRoutesFresh();
  const baseArgs = {
    payload: {
      recommendation_meta: {
        primary_target_id: 'oil_control_treatment',
        selected_target_ids: ['oil_control_treatment'],
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
      },
      recommendations: [
        {
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          brand: 'The Ordinary',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
        },
      ],
    },
    language: 'EN',
    profile: { skinType: 'oily', goals: ['oil control'] },
    primaryTarget: {
      target_id: 'oil_control_treatment',
      ingredient_query: 'Oil-control treatment',
      resolved_target_step: 'treatment',
    },
    secondaryTargets: [],
    names: ['The Ordinary Niacinamide 10% + Zinc 1%'],
    requestMode: 'buy',
  };

  const validLocationQuestion = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    candidateText:
      'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oil-control treatment because it pairs niacinamide with zinc for visible shine. It also fits because it is a lightweight serum format. What city or climate are you usually in (humid, dry, cold, or high-UV)?',
  });
  assert.equal(validLocationQuestion.reason, null);

  const invalidMissingPlannedFollowup = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    userRequestText: 'im oily skin. what product should i buy?',
    candidateText:
      'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oil-control treatment because it pairs niacinamide with zinc for visible shine. It also fits because it is a lightweight serum format.',
  });
  assert.equal(invalidMissingPlannedFollowup.reason, 'rewrite_missing_refinement_question');

  const invalidUnplannedFollowup = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    candidateText:
      'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oil-control treatment because it pairs niacinamide with zinc for visible shine. It also fits because it is a lightweight serum format. Would you like to see more options for oily skin?',
  });
  assert.equal(invalidUnplannedFollowup.reason, 'rewrite_unexpected_refinement_question');

  const invalidSkinTypeReask = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    candidateText:
      'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oil-control treatment because it pairs niacinamide with zinc for visible shine. It also fits because it is a lightweight serum format. What is your skin type?',
  });
  assert.equal(invalidSkinTypeReask.reason, 'rewrite_reasks_known_profile_field');

  const invalidRequestKnownSkinTypeReask = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    profile: {},
    userRequestText: 'im oily skin. what product should i buy?',
    candidateText:
      'The Ordinary Niacinamide 10% + Zinc 1% fits this request for oil-control treatment because it pairs niacinamide with zinc for visible shine. It also fits because it is a lightweight serum format. What is your skin type?',
  });
  assert.equal(invalidRequestKnownSkinTypeReask.reason, 'rewrite_reasks_known_profile_field');
});

test('__internal: compact reco assistant rewrite prompt keeps per-product evidence for routine bundles', async () => {
  const { __internal } = loadRoutesFresh();
  const prompt = __internal.buildRecoAssistantRewritePrompt({
    language: 'EN',
    userRequestText: 'im oily skin. what product should i buy?',
    profile: { skinType: 'oily', goals: ['oil control'] },
    compactContext: true,
    payload: {
      roles: [
        {
          role_id: 'oil_control_treatment',
          label: 'Oil-control treatment',
          why_this_role: 'Start with a targeted oil-control step to manage shine.',
          preferred_step: 'treatment',
          rank: 1,
        },
        {
          role_id: 'lightweight_moisturizer',
          label: 'Lightweight moisturizer',
          why_this_role: 'Keep hydration breathable and light.',
          preferred_step: 'moisturizer',
          rank: 2,
        },
        {
          role_id: 'daily_sunscreen',
          label: 'Daily sunscreen',
          why_this_role: 'Protect skin during the day without a greasy finish.',
          preferred_step: 'sunscreen',
          rank: 3,
        },
      ],
      recommendation_meta: {
        primary_target_id: 'oil_control_treatment',
        selected_target_ids: ['oil_control_treatment', 'lightweight_moisturizer', 'daily_sunscreen'],
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
          {
            target_id: 'lightweight_moisturizer',
            ingredient_query: 'Lightweight moisturizer',
            resolved_target_step: 'moisturizer',
          },
          {
            target_id: 'daily_sunscreen',
            ingredient_query: 'Daily sunscreen',
            resolved_target_step: 'sunscreen',
          },
        ],
      },
      recommendations: [
        {
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          brand: 'The Ordinary',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          why_this_one: 'Targets excess oil and visible shine with niacinamide and zinc PCA.',
          description: 'A water-based serum for oily skin that pairs niacinamide with zinc PCA.',
          key_features: ['Niacinamide 10%', 'Zinc PCA'],
          price: { amount: 12, currency: 'USD' },
        },
        {
          display_name: 'Hydrating Dewy Gel Cream',
          brand: 'First Aid Beauty',
          category: 'Moisturizer',
          matched_role_id: 'lightweight_moisturizer',
          matched_role_label: 'Lightweight moisturizer',
          why_this_one: 'Adds breathable gel-cream hydration without a greasy feel.',
          description: 'A lightweight gel cream that supports hydration under sunscreen.',
          key_features: ['Gel cream texture', 'Breathable hydration'],
          price: { amount: 38, currency: 'USD' },
        },
        {
          display_name: 'UV Filters SPF 45 Serum',
          brand: 'The Ordinary',
          category: 'Sunscreen',
          matched_role_id: 'daily_sunscreen',
          matched_role_label: 'Daily sunscreen',
          why_this_one: 'Provides lightweight daytime SPF protection as the final morning step.',
          description: 'A serum-texture sunscreen for daily UV protection.',
          key_features: ['SPF 45', 'Lightweight serum texture'],
          price: { amount: 19, currency: 'USD' },
        },
      ],
    },
  });

  assert.match(prompt, /Every named product must receive its own concrete product-specific reason from Context/i);
  assert.match(prompt, /do not spend the final sentence on a generic routine promise/i);

  const context = extractRecoRewritePromptContext(prompt);
  assert.equal(context.prompt_profile, 'compact_timeout_retry');
  assert.equal(context.selected_product_role_mix, 'routine_mix');
  assert.equal(context.assistant_write_plan?.writing_requirements?.require_product_specific_reason_per_selected_product, true);
  assert.equal(context.assistant_write_plan?.writing_requirements?.require_lead_multi_dimension_reason, true);
  assert.ok(
    context.assistant_write_plan?.lead_product?.must_use_reason_points?.some((item) =>
      /niacinamide|zinc|visible shine/i.test(String(item || '')),
    ),
  );
  assert.ok(
    context.assistant_write_plan?.support_steps?.[0]?.reason_points?.some((item) =>
      /gel-cream|hydration|greasy/i.test(String(item || '')),
    ),
  );
  assert.ok(
    context.assistant_write_plan?.support_steps?.[1]?.reason_points?.some((item) =>
      /spf|uv|sunscreen/i.test(String(item || '')),
    ),
  );
  assert.ok(
    context.assistant_write_plan?.lead_product?.evidence_dimensions?.includes('formula_or_ingredient'),
  );
});

test('__internal: reco assistant rewrite prompt prioritizes target-aligned evidence over off-target product claims', async () => {
  const { __internal } = loadRoutesFresh();
  const prompt = __internal.buildRecoAssistantRewritePrompt({
    language: 'EN',
    userRequestText: 'im oily skin. what product should i buy?',
    profile: { skinType: 'oily', goals: ['oil control'] },
    payload: {
      roles: [
        {
          role_id: 'oil_control_treatment',
          label: 'Oil-control treatment',
          why_this_role: 'Start with a targeted oil-control step to manage shine.',
          preferred_step: 'treatment',
          rank: 1,
          slot: 'pm',
        },
      ],
      recommendation_meta: {
        primary_target_id: 'oil_control_treatment',
        selected_target_ids: ['oil_control_treatment'],
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
      },
      recommendations: [
        {
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          brand: 'The Ordinary',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          price: { amount: 12, currency: 'USD' },
          description: 'This serum contains a high concentration of niacinamide and zinc PCA to target dullness and uneven tone.',
          why_this_one: 'Direct oil-control support for visible shine.',
          best_for: 'Best for excess oil and mid-day shine',
          key_features: ['Niacinamide 10%', 'Zinc 1%', 'Oil-control support'],
        },
      ],
    },
  });

  assert.match(prompt, /omit those extra claims and use the target-aligned evidence_points/i);
  assert.match(prompt, /do not mention dullness, uneven tone, dark spots, glow, or brightening/i);
  const context = extractRecoRewritePromptContext(prompt);
  assert.deepEqual(context.user_relevant_concern_families, ['oil_control']);
  assert.match(String(context.selected_product_details[0]?.evidence_points?.[0] || ''), /oil-control|visible shine/i);
  assert.ok(
    context.assistant_write_plan?.lead_product?.must_use_reason_points?.some((item) =>
      /Direct oil-control support for visible shine/i.test(String(item || '')),
    ),
  );
  assert.doesNotMatch(String(context.assistant_write_plan?.lead_product?.must_use_reason_points?.[0] || ''), /dullness|uneven tone/i);
});

test('__internal: reco assistant rewrite prompt carries reviewed insight watchouts and pairing notes', async () => {
  const { __internal } = loadRoutesFresh();
  const prompt = __internal.buildRecoAssistantRewritePrompt({
    language: 'EN',
    userRequestText: 'I need sunscreen under makeup in humid weather. What should I buy?',
    profile: { skinType: 'oily', goals: ['daily sunscreen'] },
    payload: {
      roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          label: 'Daily sunscreen finish fit',
          why_this_role: 'Find a sunscreen that sits well under makeup without feeling heavy.',
          preferred_step: 'sunscreen',
          rank: 1,
          slot: 'am',
        },
      ],
      recommendation_meta: {
        primary_target_id: 'daily_sunscreen_finish_fit',
        selected_target_ids: ['daily_sunscreen_finish_fit'],
        ranked_targets: [
          {
            target_id: 'daily_sunscreen_finish_fit',
            ingredient_query: 'Daily sunscreen finish fit',
            resolved_target_step: 'sunscreen',
          },
        ],
      },
      recommendations: [
        {
          display_name: 'Daily Tinted Fluid Sunscreen DY300',
          brand: 'Beauty of Joseon',
          category: 'Sunscreen',
          matched_role_id: 'daily_sunscreen_finish_fit',
          matched_role_label: 'Daily sunscreen finish fit',
          price: { amount: 10, currency: 'USD' },
          product_intel: {
            product_intel_core: {
              what_it_is: {
                body: 'A tinted SPF 40 fluid sunscreen with zinc oxide and shine-control cues.',
              },
              why_it_stands_out: [
                {
                  headline: 'SPF plus tint',
                  body: 'The seller record describes SPF 40 protection in a tinted fluid that works as the final daytime step.',
                },
              ],
              routine_fit: {
                step: 'sunscreen',
                pairing_notes: ['Use as the final daytime skincare step before makeup.'],
              },
              watchouts: [
                {
                  type: 'shade_match',
                  label: 'Because it is tinted, shade match matters.',
                  severity: 'medium',
                },
              ],
            },
          },
        },
      ],
    },
  });

  assert.match(prompt, /Use selected_product_details\.insight_watchouts only as concise tradeoff\/caveat evidence/i);
  assert.match(prompt, /Use one shopping-guidance phrase only once/i);
  assert.match(prompt, /do not use "clinically proven"/i);
  const context = extractRecoRewritePromptContext(prompt);
  assert.equal(context.selected_product_details[0]?.reviewed_insight_available, true);
  assert.equal(context.selected_product_details[0]?.insight_watchouts?.[0]?.label, 'Because it is tinted, shade match matters.');
  assert.deepEqual(context.selected_product_details[0]?.routine_pairing_notes, [
    'Use as the final daytime skincare step before makeup.',
  ]);
  assert.deepEqual(context.assistant_write_plan?.lead_product?.watchout_points, [
    'Because it is tinted, shade match matters.',
  ]);
});

staleFallbackPlannerTest('__internal: reco assistant rewrite guard rejects duplicate buy framing and unreviewed proof claims', async () => {
  const { __internal } = loadRoutesFresh();
  const absolute = __internal.validateRecoAssistantRewriteCandidate({
    candidateText: 'Calming Barrier Serum is the top option because it supports hydration.',
    payload: {
      recommendations: [
        {
          display_name: 'Calming Barrier Serum',
          matched_role_id: 'hydrating_serum_or_essence',
        },
      ],
    },
    language: 'EN',
    primaryTarget: { ingredient_query: 'hydrating serum', resolved_target_step: 'serum' },
    secondaryTargets: [],
    names: ['Calming Barrier Serum'],
    requestMode: 'buy',
  });
  assert.equal(absolute.reason, 'rewrite_absolute_recommendation_wording');

  const duplicate = __internal.validateRecoAssistantRewriteCandidate({
    candidateText: 'Calming Barrier Serum fits this request because it fits this request for hydration.',
    payload: {
      recommendations: [
        {
          display_name: 'Calming Barrier Serum',
          matched_role_id: 'hydrating_serum_or_essence',
        },
      ],
    },
    language: 'EN',
    primaryTarget: { ingredient_query: 'hydrating serum', resolved_target_step: 'serum' },
    secondaryTargets: [],
    names: ['Calming Barrier Serum'],
    requestMode: 'buy',
  });
  assert.equal(duplicate.reason, 'rewrite_duplicate_best_first_buy');

  const unreviewedProof = __internal.validateRecoAssistantRewriteCandidate({
    candidateText: 'Brightening Serum fits this request because it is clinically proven to promote brighter skin.',
    payload: {
      recommendations: [
        {
          display_name: 'Brightening Serum',
          matched_role_id: 'tone_mark_treatment',
        },
      ],
    },
    language: 'EN',
    primaryTarget: { ingredient_query: 'brighter skin serum', resolved_target_step: 'serum' },
    secondaryTargets: [],
    names: ['Brightening Serum'],
    requestMode: 'buy',
  });
  assert.equal(unreviewedProof.reason, 'rewrite_unreviewed_proof_claim');
  assert.equal(
    __internal.normalizeRecoAssistantReasonFragment('is the most direct fit because it uses hyaluronic acid and panthenol.'),
    'it uses hyaluronic acid and panthenol',
  );
});

test('__internal: reco assistant rewrite guard rejects generic routine wrap-up without product evidence', async () => {
  const { __internal } = loadRoutesFresh();
  const validation = __internal.validateRecoAssistantRewriteCandidate({
    candidateText: [
      'The Ordinary Niacinamide 10% + Zinc 1% fits this request because it targets excess oil with niacinamide and zinc.',
      'Hydrating Dewy Gel Cream adds breathable gel-cream hydration before sunscreen.',
      'This routine ensures your barrier is supported while managing oil and UV exposure.',
    ].join(' '),
    payload: {
      recommendations: [
        {
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          matched_role_id: 'oil_control_treatment',
        },
        {
          display_name: 'Hydrating Dewy Gel Cream',
          matched_role_id: 'lightweight_moisturizer',
        },
        {
          display_name: 'UV Filters SPF 45 Serum',
          matched_role_id: 'daily_sunscreen',
        },
      ],
    },
    language: 'EN',
    primaryTarget: { ingredient_query: 'oil control treatment', resolved_target_step: 'treatment' },
    secondaryTargets: [
      { ingredient_query: 'lightweight moisturizer', resolved_target_step: 'moisturizer' },
      { ingredient_query: 'daily sunscreen', resolved_target_step: 'sunscreen' },
    ],
    names: [
      'The Ordinary Niacinamide 10% + Zinc 1%',
      'Hydrating Dewy Gel Cream',
      'UV Filters SPF 45 Serum',
    ],
    requestMode: 'buy',
  });

  assert.equal(validation.reason, 'rewrite_generic_routine_wrapup');
});

test('__internal: reco assistant rewrite guard ignores selected product-name concern words but keeps real off-target claims strict', async () => {
  const { __internal } = loadRoutesFresh();
  const payload = {
    roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        label: 'Daily sunscreen with finish fit',
        why_this_role: 'Make sunscreen the lead role for daytime makeup layering.',
        preferred_step: 'sunscreen',
      },
    ],
    framework_summary: {
      concern_text: 'daytime products pill under makeup',
      primary_role_label: 'Daily sunscreen with finish fit',
    },
    recommendations: [
      {
        display_name: 'Superactive Moisturizer SPF 50: Brightening',
        brand: 'Murad',
        matched_role_id: 'daily_sunscreen_finish_fit',
      },
    ],
  };
  const baseArgs = {
    payload,
    language: 'EN',
    primaryTarget: {
      target_id: 'daily_sunscreen_finish_fit',
      ingredient_query: 'Daily sunscreen with finish fit',
      resolved_target_step: 'sunscreen',
    },
    secondaryTargets: [],
    names: ['Superactive Moisturizer SPF 50: Brightening'],
    requestMode: 'use',
  };

  const valid = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    candidateText: 'Superactive Moisturizer SPF 50: Brightening is a practical option for daily sunscreen with finish fit because it provides SPF 50 protection in a hydrating moisturizer step.',
  });
  assert.equal(valid.reason, null);

  const offTarget = __internal.validateRecoAssistantRewriteCandidate({
    ...baseArgs,
    candidateText: 'Superactive Moisturizer SPF 50: Brightening is a practical option for daily sunscreen with finish fit because it provides SPF 50 protection and brightens dark spots.',
  });
  assert.equal(offTarget.reason, 'rewrite_off_target_concern_claim');
});

test('__internal: reco assistant rewrite normalizes best-for fragments instead of surfacing because-best-for copy', async () => {
  const { __internal } = loadRoutesFresh();

  assert.equal(
    __internal.normalizeRecoAssistantReasonFragment('Best for daily UV protection you will actually wear'),
    'it is positioned for daily UV protection you will actually wear',
  );
  assert.equal(
    __internal.normalizeRecoAssistantReasonFragment('best for lightweight hydration without a greasy finish'),
    'it is positioned for lightweight hydration without a greasy finish',
  );

  const validation = __internal.validateRecoAssistantRewriteCandidate({
    candidateText: 'Superactive Moisturizer SPF 50: Hydrating fits this request for daily sunscreen with finish fit because best for daily UV protection you will actually wear.',
    payload: {
      recommendations: [
        {
          display_name: 'Superactive Moisturizer SPF 50: Hydrating',
          matched_role_id: 'daily_sunscreen_finish_fit',
        },
      ],
      roles: [
        {
          role_id: 'daily_sunscreen_finish_fit',
          label: 'Daily sunscreen with finish fit',
          preferred_step: 'sunscreen',
        },
      ],
    },
    language: 'EN',
    primaryTarget: {
      target_id: 'daily_sunscreen_finish_fit',
      ingredient_query: 'Daily sunscreen with finish fit',
      resolved_target_step: 'sunscreen',
    },
    secondaryTargets: [],
    names: ['Superactive Moisturizer SPF 50: Hydrating'],
    requestMode: 'buy',
  });
  assert.equal(validation.reason, 'rewrite_absolute_recommendation_wording');
});

test('__internal: reco assistant rewrite prompt exposes same-role price comparison context', async () => {
  const { __internal } = loadRoutesFresh();
  const prompt = __internal.buildRecoAssistantRewritePrompt({
    language: 'EN',
    userRequestText: 'im oily skin. what product should i buy, and which one is worth paying more for?',
    profile: { skinType: 'oily', goals: ['oil control'] },
    payload: {
      roles: [
        {
          role_id: 'oil_control_treatment',
          label: 'Oil-control treatment',
          why_this_role: 'Start with a targeted oil-control step to manage shine.',
          preferred_step: 'treatment',
          rank: 1,
          slot: 'pm',
        },
      ],
      recommendation_meta: {
        primary_target_id: 'oil_control_treatment',
        selected_target_ids: ['oil_control_treatment'],
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
      },
      recommendations: [
        {
          display_name: 'Budget Shine Control Serum',
          brand: 'Budget Lab',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          why_this_one: 'Direct oil-control support at a lower price.',
          price: { amount: 14, currency: 'USD' },
        },
        {
          display_name: 'Balanced Sebum Serum',
          brand: 'Mid Lab',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          why_this_one: 'Adds a little more comfort and balancing support.',
          price: { amount: 18, currency: 'USD' },
        },
        {
          display_name: 'Premium Mattifying Serum',
          brand: 'Premium Lab',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          why_this_one: 'Leans more premium for the same oil-control slot.',
          price: { amount: 24, currency: 'USD' },
        },
      ],
    },
  });

  assert.match(prompt, /compare lower-priced versus higher-priced options only inside the same role/i);

  const context = extractRecoRewritePromptContext(prompt);
  assert.equal(context.price_compare_requested, true);
  assert.equal(context.selected_product_role_mix, 'same_role_comparison');
  assert.equal(context.primary_role_selected_count, 3);
  assert.equal(context.support_role_selected_count, 0);
  assert.deepEqual(
    context.selected_product_details.map((item) => item.same_role_peer_count),
    [3, 3, 3],
  );
  assert.deepEqual(
    context.selected_product_details.map((item) => item.price_position),
    ['lowest', 'middle', 'highest'],
  );
});

test('__internal: reco assistant rewrite prompt exposes evidence and soft-match context for same-role fillers', async () => {
  const { __internal } = loadRoutesFresh();
  const prompt = __internal.buildRecoAssistantRewritePrompt({
    language: 'EN',
    userRequestText: 'im oily skin. what product should i buy?',
    profile: { skinType: 'oily', goals: ['oil control'] },
    payload: {
      roles: [
        {
          role_id: 'oil_control_treatment',
          label: 'Oil-control treatment',
          why_this_role: 'Start with a targeted oil-control step to manage shine.',
          preferred_step: 'treatment',
          rank: 1,
          slot: 'pm',
        },
      ],
      recommendation_meta: {
        primary_target_id: 'oil_control_treatment',
        selected_target_ids: ['oil_control_treatment'],
        ranked_targets: [
          {
            target_id: 'oil_control_treatment',
            ingredient_query: 'Oil-control treatment',
            resolved_target_step: 'treatment',
          },
        ],
      },
      recommendations: [
        {
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          brand: 'The Ordinary',
          category: 'Serum',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          price: { amount: 12, currency: 'USD' },
          description: '<p>A water-based niacinamide serum with zinc PCA to target excess oil and visible shine.</p>',
          key_features: ['Niacinamide 10%', 'Zinc 1%'],
        },
        {
          display_name: 'KraveBeauty Great Barrier Relief',
          brand: 'KraveBeauty',
          category: 'Treatment',
          matched_role_id: 'oil_control_treatment',
          matched_role_label: 'Oil-control treatment',
          price: { amount: 28, currency: 'USD' },
          description: '<p>A barrier-repair serum built around tamanu oil, niacinamide, and ceramides to calm the look of redness.</p>',
          comparison_fill_reason: 'same_role_soft_mismatch',
        },
      ],
    },
  });

  const context = extractRecoRewritePromptContext(prompt);
  assert.equal(context.selected_product_role_mix, 'same_role_comparison');
  assert.match(String(context.selected_product_details[0]?.description_snippet || ''), /niacinamide serum/i);
  assert.ok(Array.isArray(context.selected_product_details[0]?.evidence_points));
  assert.ok(context.selected_product_details[0].evidence_points.some((item) => /niacinamide|zinc/i.test(String(item))));
  assert.equal(context.selected_product_details[1]?.comparison_fill_reason, 'same_role_soft_mismatch');
  assert.equal(context.selected_product_details[1]?.fit_assessment, 'soft_match');
  assert.match(String(context.selected_product_details[1]?.description_snippet || ''), /barrier-repair serum/i);
  assert.ok(context.selected_product_details[1].evidence_points.some((item) => /tamanu|ceramides/i.test(String(item))));
});

test('__internal: framework pool rejects explicit SPF sunscreen serum from the oil-control treatment primary slot', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'spf_serum_conflict_1',
        merchant_id: 'external_seed',
        brand: 'Skintific',
        name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
        display_name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['Matte sunscreen serum', 'Oil control sunscreen serum'],
        benefit_tags: ['oil control', 'spf', 'broad spectrum'],
        short_description: 'A lightweight sunscreen serum with SPF 50 for oily skin.',
      },
      {
        product_id: 'oil_control_safe_1',
        merchant_id: 'external_seed',
        brand: 'Fenty Skin',
        name: 'Oil Control Serum',
        display_name: 'Oil Control Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['Shine Control Serum'],
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A mattifying oil-control serum for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_spf_conflict',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'oil_control_safe_1');
  assert.ok(
    Array.isArray(state.hard_reject_preview)
    && state.hard_reject_preview.some((row) => row?.product_id === 'spf_serum_conflict_1' && row?.reason === 'framework_primary_sunscreen_conflict'),
  );
});

test('__internal: framework pool does not let moisturizer-signaled serum metadata satisfy the treatment primary slot', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'ext_moist_disguised_serum_1',
        merchant_id: 'external_seed',
        brand: 'Embryolisse',
        name: 'Mattifying Moisturizer',
        display_name: 'Mattifying Moisturizer',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        benefit_tags: ['oil control', 'shine control'],
        short_description: 'A lightweight mattifying moisturizer for combination to oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_moist_disguised_serum',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
          {
            role_id: 'lightweight_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Lightweight moisturizer',
            query_terms: ['lightweight moisturizer', 'gel cream', 'oil free moisturizer'],
            fit_keywords: ['lightweight moisturizer', 'gel cream', 'breathable hydration', 'mattifying moisturizer'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, false);
  assert.equal(state.selected_candidate_count, 0);
  assert.equal(state.best_available_role_id ?? null, null);
  assert.ok(Array.isArray(state.soft_mismatch));
  assert.ok(
    state.soft_mismatch.some(
      (entry) => entry?.product?.product_id === 'ext_moist_disguised_serum_1' && entry?.product?.candidate_step === 'moisturizer',
    ),
  );
  assert.equal(state.weak_viable_pool, false);
  assert.equal(state.candidate_drop_stage, 'weak_viable_pool');
});

staleFallbackPlannerTest('__internal: framework pool fail-closes support-only recommendations when the primary role is unmatched', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'spf_support_only_1',
        merchant_id: 'external_seed',
        brand: 'SunGuard',
        name: 'Daily UV Fluid SPF 50',
        display_name: 'Daily UV Fluid SPF 50',
        category: 'sunscreen',
        product_type: 'sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'daily sunscreen',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen',
        search_aliases: ['Broad Spectrum Sunscreen'],
        benefit_tags: ['spf', 'broad spectrum'],
        short_description: 'A lightweight broad-spectrum sunscreen for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_support_only_clear',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'sebum'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 2,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['daily sunscreen', 'broad spectrum sunscreen'],
            fit_keywords: ['spf', 'broad spectrum', 'uv filters'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, false);
  assert.equal(state.primary_missing_authoritative_support_selected, false);
  assert.equal(state.selected_candidate_count, 0);
  assert.equal(Array.isArray(state.selected_recommendations) ? state.selected_recommendations.length : 0, 0);
  assert.equal(state.pre_llm_selected_candidate_count, 1);
  assert.equal(state.best_available_role_id, 'daily_sunscreen');
  assert.equal(state.weak_viable_pool, true);
  assert.equal(state.viable_pool_strength, 'weak');
  assert.equal(state.family_match_type, 'framework_partial');
  assert.equal(state.target_fidelity_level, 'partial');
});

test('__internal: step-aware sunscreen query ladder drops noisy acne and alias-only queries', () => {
  const recoShared = require('../src/auroraBff/recommendationSharedStack');
  const levels = recoShared.buildSameFamilyQueryLevels({
    targetContext: {
      resolved_target_step: 'sunscreen',
      step_aware_intent: true,
    },
    profileSummary: {
      skin_type: 'oily',
      goals: ['acne'],
    },
    ingredientContext: null,
    seedTerms: [],
    lang: 'EN',
  });

  const queries = levels.flatMap((level) => (Array.isArray(level?.queries) ? level.queries : []).map((row) => row.query));
  assert.ok(queries.includes('sunscreen'));
  assert.ok(queries.includes('sunscreen oily skin'));
  assert.ok(queries.includes('daily sunscreen'));
  assert.ok(queries.includes('broad spectrum sunscreen'));
  assert.equal(queries.includes('sunscreen acne'), false);
  assert.equal(queries.includes('sun screen'), false);
  assert.equal(queries.includes('spf'), false);
});

test('__internal: step-aware reco does not let retrieval trace turn a serum into sunscreen semantics', () => {
  const recoShared = require('../src/auroraBff/recommendationSharedStack');
  const out = recoShared.normalizeCandidateStep(
    {
      product_id: 'serum_wrong_step_1',
      name: 'The Ordinary Niacinamide 10% + Zinc 1%',
      display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
      category: 'Serum',
      product_type: 'Serum',
      retrieval_query: 'sunscreen oily skin',
      retrieval_step: 'sunscreen',
    },
    {
      targetContext: {
        step_aware_intent: true,
        resolved_target_step: 'sunscreen',
      },
    },
  );

  assert.equal(out.candidate_step, 'serum');
  assert.equal(out.candidate_step_source, 'structured_category');
});

test('__internal: framework step inference trusts nested authority product type over role-shaped top-level labels', () => {
  const recoShared = require('../src/auroraBff/recommendationSharedStack');
  const out = recoShared.normalizeCandidateStep(
    {
      product_id: 'ext_soothing_serum_1',
      name: 'Soothing Serum',
      category: 'moisturizer',
      product_type: 'moisturizer',
      retrieval_role_id: 'soothing_treatment',
      retrieval_query: 'soothing treatment',
      sku: {
        category: 'Serum',
        product_type: 'Serum',
        name: 'Soothing Serum',
      },
      short_description: 'A gentle serum to soothe redness and support a reactive barrier. Pro tip: follow with a moisturizing cream.',
    },
    {
      targetContext: {
        mainline_mode: 'framework',
      },
    },
  );

  assert.equal(out.candidate_step, 'serum');
  assert.equal(out.candidate_step_source, 'structured_category');
});

test('__internal: step-aware broadening stops once any viable pool exists instead of waiting for late quality flags', () => {
  const recoShared = require('../src/auroraBff/recommendationSharedStack');
  const out = recoShared.shouldStopStepAwareBroadening(
    {
      same_family_viable_count: 1,
      same_family_strong_viable_exists: false,
    },
    {
      targetContext: {
        step_aware_intent: true,
        resolved_target_step: 'sunscreen',
      },
    },
  );

  assert.equal(out, true);
});

test('__internal: reco WARN safety text only surfaces travel UV warnings for travel-context reco asks', async () => {
  const { __internal } = loadRoutesFresh();
  const safetyDecision = {
    block_level: 'WARN',
    reason_codes: ['TRAVEL_HIGH_UV_RETINOID_WARN'],
    reasons: ['Higher UV exposure while traveling can raise irritation risk.'],
    safe_alternatives: ['Use a simpler routine and reapply sunscreen.'],
  };

  assert.equal(
    __internal.shouldSurfaceRecoWarnSafetyText({
      safetyDecision,
      recoEntrySourceDetail: 'goal_driven',
      message: 'what sunscreen for oily skin?',
    }),
    false,
  );
  assert.equal(
    __internal.shouldSurfaceRecoWarnSafetyText({
      safetyDecision,
      recoEntrySourceDetail: 'travel_handoff',
      message: 'what sunscreen for oily skin?',
    }),
    true,
  );
  assert.equal(
    __internal.shouldSurfaceRecoWarnSafetyText({
      safetyDecision,
      recoEntrySourceDetail: 'goal_driven',
      message: 'what sunscreen should I pack for beach travel?',
    }),
    true,
  );
});

test('__internal: framework pool accepts external seed semantic evidence from benefit tags and aliases', async () => {
  const { __internal } = loadRoutesFresh();
  const normalized = __internal.normalizeRecoCatalogProduct({
    product_id: 'ext_oil_semantic_1',
    merchant_id: 'merchant_ext_oil_semantic',
    brand: 'Fenty Skin',
    name: 'Gloss Bomb Control Serum',
    display_name: 'Fenty Skin Gloss Bomb Control Serum',
    category: 'serum',
    product_type: 'serum',
    source: 'external_seed',
    search_aliases: ['Fenty Skin Oil Control Serum'],
    benefit_tags: ['oil control', 'shine control'],
    short_description: 'A mattifying balancing serum for oily skin.',
  });
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [normalized],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_semantic',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_id, 'oil_control_treatment');
  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'ext_oil_semantic_1');
  assert.equal(state.selected_recommendations[0]?.framework_semantic_fit, true);
});

test('__internal: framework pool infers step from external seed alias and description when category is generic', async () => {
  const { __internal } = loadRoutesFresh();
  const normalized = __internal.normalizeRecoCatalogProduct({
    product_id: 'ext_oil_generic_1',
    merchant_id: 'merchant_ext_oil_generic',
    brand: 'Fenty Skin',
    name: 'Gloss Bomb Control',
    display_name: 'Fenty Skin Gloss Bomb Control',
    category: 'skincare',
    source: 'external_seed',
    search_aliases: ['Fenty Skin Oil Control Serum'],
    benefit_tags: ['oil control', 'shine control'],
    short_description: 'A mattifying balancing serum for oily skin.',
  });
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [normalized],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_generic_step',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'ext_oil_generic_1');
  assert.equal(state.selected_recommendations[0]?.candidate_step, 'serum');
  assert.equal(state.selected_recommendations[0]?.candidate_step_source, 'title_or_tag_alias');
  assert.equal(state.selected_source_counts?.external_seed, 1);
  assert.equal(state.external_seed_used_count, 1);
});

test('__internal: framework pool keeps soothing serum as treatment role instead of collapsing it into moisturizer support', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'ext_soothing_serum_1',
        merchant_id: 'external_seed',
        brand: 'Haruharu Wonder',
        name: 'Soothing Serum',
        display_name: 'Soothing Serum',
        category: 'moisturizer',
        product_type: 'moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'soothing_treatment',
        retrieval_query: 'soothing treatment',
        sku: {
          category: 'Serum',
          product_type: 'Serum',
          name: 'Soothing Serum',
          ingredient_tokens: ['panthenol', 'azelaic acid', 'squalane'],
        },
        search_aliases: ['Soothing Serum'],
        short_description: 'A gentle serum to soothe redness, calm irritation, hydrate, and renew the skin barrier.',
        description: 'A sensitive-skin friendly serum with Panthenol and Azelaic Acid for redness and calming support.',
      },
      {
        product_id: 'barrier_moisturizer_1',
        merchant_id: 'merchant_internal',
        brand: 'KraveBeauty',
        name: 'Great Barrier Relief',
        display_name: 'KraveBeauty Great Barrier Relief',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'internal',
        retrieval_role_id: 'barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
        short_description: 'A barrier repair moisturizer with ceramides, tamanu oil, and niacinamide for sensitized skin.',
      },
      {
        product_id: 'daily_sunscreen_1',
        merchant_id: 'external_seed',
        brand: 'The Ordinary',
        name: 'UV Filters SPF 45 Serum',
        display_name: 'UV Filters SPF 45 Serum',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_query: 'daily sunscreen',
        short_description: 'A lightweight SPF 45 sunscreen serum for daily UV protection.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_soothing_primary',
        primary_role_id: 'soothing_treatment',
        routine_mode: 'routine_mix',
        semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
        framework_roles: [
          {
            role_id: 'soothing_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Soothing treatment',
            query_terms: ['soothing serum sensitive skin', 'cica serum redness', 'panthenol treatment'],
            fit_keywords: ['soothing', 'redness', 'calming', 'irritation'],
            ingredient_hypotheses: ['Panthenol', 'Madecassoside'],
          },
          {
            role_id: 'barrier_moisturizer',
            rank: 2,
            preferred_step: 'moisturizer',
            label: 'Barrier-support moisturizer',
            query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
            fit_keywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin'],
            ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 3,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
            fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
            ingredient_hypotheses: ['UV filters'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_candidate_count, 3);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.matched_role_id),
    ['soothing_treatment', 'barrier_moisturizer', 'daily_sunscreen'],
  );
  assert.equal(state.selected_recommendations[0]?.candidate_step, 'serum');
});

test('__internal: framework pool does not surface retinol moisturizer as barrier support for sensitive routine mix', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'dynasty_cream_1',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Dynasty Cream 10ml',
        display_name: 'Beauty of Joseon Dynasty Cream 10ml',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'gel cream moisturizer',
        short_description: 'A lightweight moisturizer cream for comfortable layering.',
      },
      {
        product_id: 'soothing_serum_1',
        merchant_id: 'merchant_internal',
        brand: 'Winona',
        name: 'Winona Soothing Repair Serum',
        display_name: 'Winona Soothing Repair Serum',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'internal',
        retrieval_role_id: 'soothing_treatment',
        retrieval_query: 'soothing serum sensitive skin',
        short_description: 'A soothing serum for redness and sensitive skin.',
      },
      {
        product_id: 'retinol_moisturizer_1',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Revive Firming Moisturizer : Ginseng + Retinol',
        display_name: 'Beauty of Joseon Revive Firming Moisturizer : Ginseng + Retinol',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
        short_description: 'A firming moisturizer with ginseng and retinol.',
      },
      {
        product_id: 'great_barrier_relief_1',
        merchant_id: 'merchant_internal',
        brand: 'KraveBeauty',
        name: 'KraveBeauty Great Barrier Relief',
        display_name: 'KraveBeauty Great Barrier Relief',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'internal',
        retrieval_role_id: 'barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
        short_description: 'A barrier repair moisturizer with ceramides, tamanu oil, and niacinamide for sensitized skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_sensitive_layering_retinoid_demote',
        primary_role_id: 'layering_compatible_moisturizer_or_spf',
        routine_mode: 'routine_mix',
        semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
        framework_roles: [
          {
            role_id: 'layering_compatible_moisturizer_or_spf',
            rank: 60,
            preferred_step: 'moisturizer',
            label: 'Layering-compatible moisturizer or SPF',
            query_terms: ['gel cream moisturizer', 'lightweight moisturizer', 'makeup layering'],
            fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
          },
          {
            role_id: 'soothing_treatment',
            rank: 70,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Soothing treatment',
            query_terms: ['soothing serum sensitive skin', 'cica serum redness'],
            fit_keywords: ['soothing', 'redness', 'calming', 'sensitive skin'],
            ingredient_hypotheses: ['Panthenol', 'Madecassoside'],
          },
          {
            role_id: 'barrier_moisturizer',
            rank: 41,
            preferred_step: 'moisturizer',
            label: 'Barrier-support moisturizer',
            query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
            fit_keywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin'],
            ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
          },
        ],
      },
    },
  );

  assert.equal(state.selected_candidate_count, 3);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['dynasty_cream_1', 'soothing_serum_1', 'great_barrier_relief_1'],
  );
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'retinol_moisturizer_1'),
    false,
  );
  assert.equal(
    state.soft_mismatch.some((entry) => entry?.product?.product_id === 'retinol_moisturizer_1')
      || state.hard_reject.some((entry) => entry?.product?.product_id === 'retinol_moisturizer_1'),
    true,
  );
});

test('__internal: framework pool avoids active glow SPF as sunscreen support for retinoid barrier routine', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_retinoid_barrier_active_spf_demote',
    primary_role_id: 'hydrating_barrier_moisturizer',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'retinoid barrier support',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['sensitive barrier', 'avoid extra active treatments'],
    },
    framework_roles: [
      {
        role_id: 'hydrating_barrier_moisturizer',
        rank: 40,
        preferred_step: 'moisturizer',
        label: 'Hydrating barrier moisturizer',
        query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin'],
        fit_keywords: ['hydrating', 'barrier repair', 'ceramide', 'sensitive skin'],
        ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'soothing_treatment',
        rank: 70,
        preferred_step: 'treatment',
        alternate_steps: ['serum'],
        label: 'Soothing treatment',
        query_terms: ['soothing serum sensitive skin', 'cica serum redness'],
        fit_keywords: ['soothing', 'redness', 'calming', 'sensitive skin'],
        ingredient_hypotheses: ['Panthenol', 'Madecassoside'],
        product_type_hypotheses: ['serum', 'treatment'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
        fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'great_barrier_relief_retinoid_1',
        merchant_id: 'merchant_internal',
        brand: 'KraveBeauty',
        name: 'KraveBeauty Great Barrier Relief',
        display_name: 'KraveBeauty Great Barrier Relief',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'catalog',
        retrieval_role_id: 'hydrating_barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
        short_description: 'A hydrating barrier repair moisturizer with ceramides and panthenol for sensitized skin.',
      },
      {
        product_id: 'soothing_serum_retinoid_1',
        merchant_id: 'merchant_internal',
        brand: 'Winona',
        name: 'Winona Soothing Repair Serum',
        display_name: 'Winona Soothing Repair Serum',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'catalog',
        retrieval_role_id: 'soothing_treatment',
        retrieval_query: 'soothing serum sensitive skin',
        short_description: 'A soothing serum for redness, calming, and sensitive skin.',
      },
      {
        product_id: 'dew_glow_active_spf_retinoid_1',
        merchant_id: 'external_seed',
        brand: 'Naturium',
        name: 'Dew-Glow Moisturizer SPF 50 - Jumbo',
        display_name: 'Naturium Dew-Glow Moisturizer SPF 50 - Jumbo',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_query: 'daily sunscreen',
        key_features: ['UV filters', 'Niacinamide', 'Salicylic acid', 'Azelaic acid'],
        short_description: 'A glow moisturizer SPF 50 with UV filters, niacinamide, salicylic acid, and azelaic acid.',
      },
      {
        product_id: 'simple_daily_spf_retinoid_1',
        merchant_id: 'external_seed',
        brand: 'The Ordinary',
        name: 'UV Filters SPF 45 Serum',
        display_name: 'The Ordinary UV Filters SPF 45 Serum',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_query: 'daily sunscreen',
        key_features: ['UV filters'],
        short_description: 'A lightweight SPF 45 sunscreen serum for daily UV protection.',
      },
    ],
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['great_barrier_relief_retinoid_1', 'soothing_serum_retinoid_1', 'simple_daily_spf_retinoid_1'],
  );
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'dew_glow_active_spf_retinoid_1'),
    false,
  );
  assert.equal(
    state.hard_reject.some((entry) => entry?.product?.product_id === 'dew_glow_active_spf_retinoid_1')
      || state.soft_mismatch.some((entry) => entry?.product?.product_id === 'dew_glow_active_spf_retinoid_1'),
    true,
  );
});

test('__internal: framework pool prefers untinted sunscreen over skin-tint SPF for generic daily sunscreen support', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_retinoid_barrier_tint_spf_demote',
    primary_role_id: 'hydrating_barrier_moisturizer',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'retinoid barrier support',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['sensitive barrier', 'daily protection'],
    },
    framework_roles: [
      {
        role_id: 'hydrating_barrier_moisturizer',
        rank: 40,
        preferred_step: 'moisturizer',
        label: 'Hydrating barrier moisturizer',
        query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin'],
        fit_keywords: ['hydrating', 'barrier repair', 'ceramide', 'sensitive skin'],
        ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'soothing_treatment',
        rank: 70,
        preferred_step: 'treatment',
        alternate_steps: ['serum'],
        label: 'Soothing treatment',
        query_terms: ['soothing serum sensitive skin', 'cica serum redness'],
        fit_keywords: ['soothing', 'redness', 'calming', 'sensitive skin'],
        ingredient_hypotheses: ['Panthenol', 'Madecassoside'],
        product_type_hypotheses: ['serum', 'treatment'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
        fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'great_barrier_relief_tint_1',
        merchant_id: 'merchant_internal',
        brand: 'KraveBeauty',
        name: 'KraveBeauty Great Barrier Relief',
        display_name: 'KraveBeauty Great Barrier Relief',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'catalog',
        retrieval_role_id: 'hydrating_barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
        short_description: 'A hydrating barrier repair moisturizer with ceramides and panthenol for sensitized skin.',
      },
      {
        product_id: 'soothing_serum_tint_1',
        merchant_id: 'merchant_internal',
        brand: 'Winona',
        name: 'Winona Soothing Repair Serum',
        display_name: 'Winona Soothing Repair Serum',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'catalog',
        retrieval_role_id: 'soothing_treatment',
        retrieval_query: 'soothing serum sensitive skin',
        short_description: 'A soothing serum for redness, calming, and sensitive skin.',
      },
      {
        product_id: 'tinted_spf_retinoid_1',
        merchant_id: 'external_seed',
        brand: 'Supergoop',
        name: 'Protec(tint) Daily Skin Tint SPF 50',
        display_name: 'Supergoop Protec(tint) Daily Skin Tint SPF 50',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_query: 'daily sunscreen',
        key_features: ['UV filters', 'Skin tint coverage'],
        short_description: 'A daily skin tint SPF 50 with lightweight coverage.',
      },
      {
        product_id: 'simple_daily_spf_tint_1',
        merchant_id: 'external_seed',
        brand: 'Round Lab',
        name: 'Birch Juice Mild-Up Sunscreen SPF 50+',
        display_name: 'Round Lab Birch Juice Mild-Up Sunscreen SPF 50+',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_query: 'daily sunscreen',
        key_features: ['UV filters'],
        short_description: 'A lightweight sunscreen fluid for daily UV protection.',
      },
    ],
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['great_barrier_relief_tint_1', 'soothing_serum_tint_1', 'simple_daily_spf_tint_1'],
  );
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'tinted_spf_retinoid_1'),
    false,
  );
  assert.equal(
    state.hard_reject.some((entry) => entry?.product?.product_id === 'tinted_spf_retinoid_1')
      || state.soft_mismatch.some((entry) => entry?.product?.product_id === 'tinted_spf_retinoid_1'),
    true,
  );
});

test('__internal: framework pool prefers lightweight layering moisturizer evidence over generic cream support', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_makeup_layering_texture_fit',
    primary_role_id: 'daily_sunscreen_finish_fit',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'daytime routine under makeup',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['under makeup', 'avoid pilling'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen under makeup', 'lightweight sunscreen'],
        fit_keywords: ['spf', 'uv filters', 'lightweight', 'under makeup'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
      {
        role_id: 'layering_compatible_moisturizer_or_spf',
        rank: 60,
        preferred_step: 'moisturizer',
        label: 'Layering-compatible moisturizer or SPF',
        query_terms: ['gel cream moisturizer', 'lightweight moisturizer', 'makeup layering'],
        fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'hydrating_serum_or_essence',
        rank: 70,
        preferred_step: 'serum',
        label: 'Hydrating serum or essence',
        query_terms: ['hydrating essence', 'lightweight hydrating serum'],
        fit_keywords: ['hydrating', 'lightweight', 'essence'],
        ingredient_hypotheses: ['Glycerin', 'Panthenol'],
        product_type_hypotheses: ['serum', 'essence'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'round_lab_sunscreen_makeup_1',
        merchant_id: 'external_seed',
        brand: 'Round Lab',
        name: 'Birch Juice Mild-Up Sunscreen SPF 50+',
        display_name: 'Round Lab Birch Juice Mild-Up Sunscreen SPF 50+',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        short_description: 'A lightweight sunscreen fluid that layers cleanly under makeup.',
      },
      {
        product_id: 'jurlique_rare_rose_cream_makeup_1',
        merchant_id: 'external_seed',
        brand: 'Jurlique',
        name: 'Rare Rose Cream',
        display_name: 'Jurlique Rare Rose Cream',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'lightweight moisturizer',
        short_description: 'A moisturizer cream with rose extract and botanical hydration.',
      },
      {
        product_id: 'pixi_clarity_mist_makeup_1',
        merchant_id: 'external_seed',
        brand: 'PIXI BEAUTY',
        name: 'Clarity Mist',
        display_name: 'PIXI BEAUTY Clarity Mist',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'lightweight moisturizer',
        benefit_tags: ['lightweight', 'oil-free', 'makeup layering'],
        short_description:
          'A lightweight, oil-free facial spray with cica and Hyaluronic Complex to lock in moisture anytime.',
      },
      {
        product_id: 'round_lab_lotion_makeup_1',
        merchant_id: 'external_seed',
        brand: 'Round Lab',
        name: 'Birch Juice Face Lotion',
        display_name: 'Round Lab Birch Juice Face Lotion',
        category: 'Face Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'lightweight moisturizer',
        short_description: 'A lightweight face lotion with non-greasy hydration and fast-absorbing layering comfort.',
      },
      {
        product_id: 'hydrating_essence_makeup_1',
        merchant_id: 'external_seed',
        brand: 'Round Lab',
        name: '1025 Dokdo Hydrating Serum',
        display_name: 'Round Lab 1025 Dokdo Hydrating Serum',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'hydrating_serum_or_essence',
        retrieval_query: 'hydrating essence',
        short_description: 'A lightweight hydrating serum with glycerin and panthenol for layered hydration.',
      },
    ],
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['round_lab_sunscreen_makeup_1', 'round_lab_lotion_makeup_1', 'hydrating_essence_makeup_1'],
  );
  const fallbackMoisturizer = state.viable_candidate_pool.find((row) => row?.product_id === 'jurlique_rare_rose_cream_makeup_1') || null;
  const preferredMoisturizer = state.selected_recommendations.find((row) => row?.product_id === 'round_lab_lotion_makeup_1') || null;
  assert.ok(fallbackMoisturizer);
  assert.ok(preferredMoisturizer);
  assert.ok(Number(fallbackMoisturizer?.framework_score || 0) >= 0.52);
  assert.ok(Number(preferredMoisturizer?.framework_score || 0) > Number(fallbackMoisturizer?.framework_score || 0));
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'jurlique_rare_rose_cream_makeup_1'),
    false,
  );
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'pixi_clarity_mist_makeup_1'),
    false,
  );
  assert.equal(
    state.hard_reject.some((entry) => entry?.product?.product_id === 'pixi_clarity_mist_makeup_1')
      || state.soft_mismatch.some((entry) => entry?.product?.product_id === 'pixi_clarity_mist_makeup_1'),
    true,
  );
});

test('__internal: framework pool uses external seed role-fit ranking for finish-fit sunscreen primary', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_makeup_spf_role_fit_rank',
    primary_role_id: 'daily_sunscreen_finish_fit',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'daytime routine under makeup',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['under makeup', 'avoid pilling', 'lightweight finish'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['spf fluid oily skin', 'lightweight sunscreen oily skin'],
        fit_keywords: ['spf', 'uv filters', 'lightweight', 'under makeup', 'fluid'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
      {
        role_id: 'layering_compatible_moisturizer_or_spf',
        rank: 60,
        preferred_step: 'moisturizer',
        label: 'Layering-compatible moisturizer or SPF',
        query_terms: ['gel cream moisturizer', 'lightweight moisturizer', 'makeup layering'],
        fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'hydrating_serum_or_essence',
        rank: 70,
        preferred_step: 'serum',
        label: 'Hydrating serum or essence',
        query_terms: ['lightweight hydrating serum'],
        fit_keywords: ['hydrating', 'lightweight', 'serum'],
        ingredient_hypotheses: ['Glycerin'],
        product_type_hypotheses: ['serum'],
      },
    ],
  };
  const rawCandidates = [
      {
        product_id: 'murad_spf_moisturizer_fit_1',
        merchant_id: 'external_seed',
        brand: 'Murad',
        name: 'Superactive Moisturizer SPF 50: Hydrating',
        display_name: 'Murad Superactive Moisturizer SPF 50: Hydrating',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'spf fluid oily skin',
        local_external_seed_role_fit_score: 0.92,
        benefit_tags: ['spf 50', 'hydrating', 'lightweight'],
        short_description: 'A hydrating moisturizer with SPF 50 for daily sunscreen wear.',
      },
      {
        product_id: 'pixi_on_the_glow_shield_fit_1',
        merchant_id: 'external_seed',
        brand: 'PIXI BEAUTY',
        name: 'On-the-Glow SHIELD SPF 50',
        display_name: 'PIXI BEAUTY On-the-Glow SHIELD SPF 50',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'spf fluid oily skin',
        local_external_seed_role_fit_score: 1.16,
        benefit_tags: ['spf 50', 'lightweight', 'under makeup'],
        short_description: 'A lightweight SPF 50 sunscreen fluid made for daily wear under makeup.',
      },
      {
        product_id: 'krave_water_cream_fit_1',
        merchant_id: 'external_seed',
        brand: 'KraveBeauty',
        name: 'Oat So Simple Water Cream',
        display_name: 'KraveBeauty Oat So Simple Water Cream',
        category: 'Face Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'gel cream moisturizer',
        local_external_seed_role_fit_score: 1.04,
        short_description: 'A lightweight water cream that layers without a greasy finish.',
      },
      {
        product_id: 'pixi_hydrating_milky_serum_fit_1',
        merchant_id: 'external_seed',
        brand: 'PIXI BEAUTY',
        name: 'Hydrating Milky Serum',
        display_name: 'PIXI BEAUTY Hydrating Milky Serum',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'hydrating_serum_or_essence',
        retrieval_query: 'lightweight hydrating serum',
        local_external_seed_role_fit_score: 1.01,
        short_description: 'A lightweight hydrating serum with glycerin for layered hydration.',
      },
    ];
  const normalizedCandidates = rawCandidates.map((row) => __internal.normalizeRecoCatalogProduct(row));
  assert.equal(normalizedCandidates[1]?.local_external_seed_role_fit_score, 1.16);
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    normalizedCandidates,
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['pixi_on_the_glow_shield_fit_1', 'krave_water_cream_fit_1', 'pixi_hydrating_milky_serum_fit_1'],
  );
  const pixi = state.viable_candidate_pool.find((row) => row?.product_id === 'pixi_on_the_glow_shield_fit_1') || null;
  const murad = state.viable_candidate_pool.find((row) => row?.product_id === 'murad_spf_moisturizer_fit_1') || null;
  assert.ok(pixi);
  assert.ok(murad);
  assert.ok(Number(pixi.framework_role_fit_rank_adjustment || 0) > Number(murad.framework_role_fit_rank_adjustment || 0));
  assert.ok(Number(pixi.framework_rank_score || 0) > Number(murad.framework_rank_score || 0));
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'murad_spf_moisturizer_fit_1'),
    false,
  );
});

test('__internal: framework pool preserves same-band external seed role-fit differences for same-role sunscreen ranking', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_same_band_sunscreen_role_fit_rank',
    primary_role_id: 'daily_sunscreen_finish_fit',
    comparison_mode: 'same_role_comparison',
    routine_mode: 'same_role_comparison',
    semantic_plan: {
      primary_concern: 'daytime routine under makeup',
      comparison_mode: 'same_role_comparison',
      must_satisfy_constraints: ['under makeup', 'avoid pilling'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['daily sunscreen', 'lightweight sunscreen'],
        fit_keywords: ['spf', 'lightweight'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'alpha_lower_role_fit_spf',
        merchant_id: 'external_seed',
        brand: 'Alpha',
        name: 'A Cloud Shield SPF 50',
        display_name: 'Alpha A Cloud Shield SPF 50',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'daily sunscreen',
        local_external_seed_role_fit_score: 1.26,
        benefit_tags: ['spf 50', 'lightweight'],
        short_description: 'A lightweight daily sunscreen for regular daytime wear.',
      },
      {
        product_id: 'beta_higher_role_fit_spf',
        merchant_id: 'external_seed',
        brand: 'Beta',
        name: 'B Cloud Veil SPF 50',
        display_name: 'Beta B Cloud Veil SPF 50',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'daily sunscreen',
        local_external_seed_role_fit_score: 1.34,
        benefit_tags: ['spf 50', 'lightweight'],
        short_description: 'A lightweight daily sunscreen for regular daytime wear.',
      },
    ].map((row) => __internal.normalizeRecoCatalogProduct(row)),
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'beta_higher_role_fit_spf');
  const lower = state.viable_candidate_pool.find((row) => row?.product_id === 'alpha_lower_role_fit_spf') || null;
  const higher = state.viable_candidate_pool.find((row) => row?.product_id === 'beta_higher_role_fit_spf') || null;
  assert.ok(lower);
  assert.ok(higher);
  assert.ok(
    Number(higher.framework_role_fit_rank_adjustment || 0)
      > Number(lower.framework_role_fit_rank_adjustment || 0),
  );
  assert.ok(Number(higher.framework_rank_score || 0) > Number(lower.framework_rank_score || 0));
});

test('__internal: framework pool spreads finish-fit same-role sunscreen picks across distinct tradeoff buckets when authority exists', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_finish_fit_same_role_tradeoff_spread',
    primary_role_id: 'daily_sunscreen_finish_fit',
    comparison_mode: 'same_role_comparison',
    routine_mode: 'same_role_comparison',
    request_text: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
    semantic_plan: {
      primary_concern: 'daytime routine under makeup',
      comparison_mode: 'same_role_comparison',
      routine_mode: 'same_role_comparison',
      must_satisfy_constraints: ['under makeup', 'avoid pilling', 'lightweight finish'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
        fit_keywords: ['under makeup', 'lightweight', 'non-greasy', 'no white cast', 'invisible', 'fluid'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'boj_aqua_fresh_live',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        display_name: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.14,
        benefit_tags: ['spf 50', 'lightweight', 'under makeup', 'fluid'],
        short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
      },
      {
        product_id: 'boj_day_dew_live',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Day Dew Sunscreen',
        display_name: 'Beauty of Joseon Day Dew Sunscreen',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.06,
        benefit_tags: ['spf 50', 'dewy', 'under makeup'],
        short_description: 'A fresh-dewy sunscreen that keeps makeup layering comfortable.',
      },
      {
        product_id: 'skintific_light_serum_live',
        merchant_id: 'external_seed',
        brand: 'SKINTIFIC',
        name: 'Light Serum Sunscreen SPF 50+ PA++++',
        display_name: 'SKINTIFIC Light Serum Sunscreen SPF 50+ PA++++',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.11,
        benefit_tags: ['spf 50', 'watery', 'under makeup', 'lightweight'],
        short_description: 'A watery serum sunscreen that feels light and invisible under makeup.',
      },
      {
        product_id: 'skintific_matte_fit_live',
        merchant_id: 'external_seed',
        brand: 'SKINTIFIC',
        name: 'Matte Fit Serum Sunscreen SPF 50+ PA++++',
        display_name: 'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.18,
        benefit_tags: ['spf 50', 'matte', 'under makeup', 'oil control'],
        short_description: 'A matte serum sunscreen that helps cut shine under makeup.',
      },
    ].map((row) => __internal.normalizeRecoCatalogProduct(row)),
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['skintific_matte_fit_live', 'boj_day_dew_live', 'boj_aqua_fresh_live'],
  );
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'skintific_light_serum_live'),
    false,
  );
});

test('__internal: finish-fit same-role primary external stage can stop early once three tradeoff buckets are ready', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    primary_role_id: 'daily_sunscreen_finish_fit',
    comparison_mode: 'same_role_comparison',
    routine_mode: 'same_role_comparison',
    semantic_plan: {
      comparison_mode: 'same_role_comparison',
      routine_mode: 'same_role_comparison',
    },
  };
  const candidateState = {
    primary_role_matched: true,
    selected_recommendations: [
      {
        display_name: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        short_description: 'A lightweight sunscreen fluid for smoother under-makeup wear.',
        benefit_tags: ['lightweight', 'under makeup', 'fluid'],
      },
      {
        display_name: 'Beauty of Joseon Day Dew Sunscreen',
        short_description: 'A fresher, dewier sunscreen with a bit more hydration.',
        benefit_tags: ['dewy', 'under makeup'],
      },
      {
        display_name: 'SKINTIFIC Matte Fit Serum Sunscreen SPF 50+ PA++++',
        short_description: 'A matte sunscreen that helps cut shine under makeup.',
        benefit_tags: ['matte', 'shine control', 'under makeup'],
      },
    ],
  };

  assert.equal(
    __internal.hasConcernFrameworkFinishFitSameRoleTradeoffCoverage(candidateState),
    true,
  );
  assert.equal(
    __internal.shouldStopConcernFrameworkFinishFitPrimaryExternalEarly({
      stageId: 'framework_stage_b_primary_external_seed',
      targetContext,
      candidateState,
      executedQueryCount: 1,
    }),
    false,
  );
  assert.equal(
    __internal.shouldStopConcernFrameworkFinishFitPrimaryExternalEarly({
      stageId: 'framework_stage_b_primary_external_seed',
      targetContext,
      candidateState,
      executedQueryCount: 2,
    }),
    true,
  );
});

test('__internal: framework pool prefers untinted finish-fit sunscreen over tinted shade variants when tint was not requested', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_finish_fit_untinted_over_tint',
    primary_role_id: 'daily_sunscreen_finish_fit',
    comparison_mode: 'same_role_comparison',
    routine_mode: 'same_role_comparison',
    semantic_plan: {
      primary_concern: 'daytime sunscreen under makeup',
      comparison_mode: 'same_role_comparison',
      must_satisfy_constraints: ['under makeup', 'avoid pilling'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen under makeup', 'lightweight sunscreen'],
        fit_keywords: ['spf', 'lightweight', 'under makeup', 'fluid'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'boj_tinted_dn310',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Daily Tinted Fluid Sunscreen DN310',
        display_name: 'Beauty of Joseon Daily Tinted Fluid Sunscreen DN310',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.08,
        benefit_tags: ['spf 40', 'lightweight', 'under makeup', 'tinted'],
        short_description: 'A lightweight fluid sunscreen with sheer tint coverage for makeup-base wear.',
      },
      {
        product_id: 'boj_aqua_fresh_untinted',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        display_name: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.04,
        benefit_tags: ['spf 50', 'lightweight', 'under makeup', 'fluid'],
        short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
      },
      {
        product_id: 'haruharu_finish_fit_untinted',
        merchant_id: 'external_seed',
        brand: 'Haruharu Wonder',
        name: 'Black Rice Moisture Airyfit Daily Sunscreen SPF 50+',
        display_name: 'Haruharu Wonder Black Rice Moisture Airyfit Daily Sunscreen SPF 50+',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.01,
        benefit_tags: ['spf 50', 'lightweight', 'under makeup'],
        short_description: 'An airy daily sunscreen that sits smoothly under makeup without a heavy finish.',
      },
    ].map((row) => __internal.normalizeRecoCatalogProduct(row)),
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'boj_aqua_fresh_untinted');
  assert.deepEqual(
    state.selected_recommendations.slice(0, 2).map((row) => row.product_id),
    ['boj_aqua_fresh_untinted', 'haruharu_finish_fit_untinted'],
  );
  assert.equal(state.selected_recommendations[2]?.product_id, 'boj_tinted_dn310');
  const tinted = state.viable_candidate_pool.find((row) => row?.product_id === 'boj_tinted_dn310') || null;
  const untinted = state.viable_candidate_pool.find((row) => row?.product_id === 'boj_aqua_fresh_untinted') || null;
  assert.ok(tinted);
  assert.ok(untinted);
  assert.ok(Number(untinted.framework_rank_score || 0) > Number(tinted.framework_rank_score || 0));
});

test('__internal: latest reco context rehydrates under-makeup semantic intent for finish-fit sunscreen ranking', () => {
  const { __internal } = loadRoutesFresh();
  const recoContext = __internal.sanitizeRecoRequestContext({
    source_detail: 'analysis_handoff',
    trigger_source: 'analysis_handoff',
    message: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
    primary_target_id: 'daily_sunscreen_finish_fit',
    selected_target_ids: ['daily_sunscreen_finish_fit'],
    ranked_targets: [
      {
        target_id: 'daily_sunscreen_finish_fit',
        target_role: 'primary',
        ingredient_query: 'daily sunscreen finish fit',
        resolved_target_step: 'sunscreen',
        source: 'analysis_handoff',
      },
    ],
    routine_mode: 'same_role_comparison',
    comparison_mode: 'same_role_comparison',
    semantic_plan: {
      primary_concern: 'daytime routine under makeup',
      routine_mode: 'same_role_comparison',
      comparison_mode: 'same_role_comparison',
      must_satisfy_constraints: ['under makeup', 'avoid pilling', 'lightweight finish'],
      evidence_needed: ['finish fit', 'layering compatibility'],
    },
  });
  assert.ok(recoContext);
  assert.match(String(recoContext?.request_text || ''), /makeup stops pilling/i);

  const { effectiveTargetContext } = __internal.buildEffectiveRecoContextTargetContext(recoContext, {
    framework_id: 'recofw_test_latest_context_finish_fit_rehydration',
    primary_role_id: 'daily_sunscreen_finish_fit',
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen under makeup', 'lightweight sunscreen'],
        fit_keywords: ['spf', 'lightweight', 'under makeup', 'fluid'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  });

  assert.equal(effectiveTargetContext?.comparison_mode, 'same_role_comparison');
  assert.equal(effectiveTargetContext?.routine_mode, 'same_role_comparison');
  assert.match(String(effectiveTargetContext?.request_text || ''), /makeup stops pilling/i);
  assert.deepEqual(
    effectiveTargetContext?.semantic_plan?.must_satisfy_constraints,
    ['under makeup', 'avoid pilling', 'lightweight finish'],
  );

  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'haruharu_portable_stick',
        merchant_id: 'external_seed',
        brand: 'Haruharu Wonder',
        name: 'Daily Soothing Sun Shield SPF50+ PA++++',
        display_name: 'Haruharu Wonder Daily Soothing Sun Shield SPF50+ PA++++',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'daily sunscreen finish fit',
        local_external_seed_role_fit_score: 1.06,
        benefit_tags: ['spf 50', 'portable', 'reapplication', 'stick'],
        short_description: 'A stick-format sunscreen built for portable midday touchups and reapplication.',
      },
      {
        product_id: 'boj_aqua_fresh_untinted',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        display_name: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'daily sunscreen finish fit',
        local_external_seed_role_fit_score: 1.03,
        benefit_tags: ['spf 50', 'lightweight', 'under makeup', 'fluid'],
        short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
      },
    ].map((row) => __internal.normalizeRecoCatalogProduct(row)),
    { targetContext: effectiveTargetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'boj_aqua_fresh_untinted');
  assert.equal(state.selected_recommendations[1]?.product_id, 'haruharu_portable_stick');
});

test('__internal: framework tiebreak prefers first-wear finish-fit sunscreen over portable reapplication stick when role scores tie', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_finish_fit_tiebreak_over_portable_stick',
    primary_role_id: 'daily_sunscreen_finish_fit',
    comparison_mode: 'same_role_comparison',
    routine_mode: 'same_role_comparison',
    request_text: 'Based on my routine and the skin analysis, what should I buy for daytime so my makeup stops pilling?',
    semantic_plan: {
      primary_concern: 'makeup pilling and daytime layering with impaired barrier',
      comparison_mode: 'same_role_comparison',
      routine_mode: 'same_role_comparison',
      must_satisfy_constraints: ['under makeup', 'avoid pilling', 'lightweight finish'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 1,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
        fit_keywords: ['under makeup', 'lightweight', 'non-greasy', 'no white cast', 'invisible', 'fluid'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen', 'serum'],
      },
    ],
  };

  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'haruharu_portable_stick_tie',
        merchant_id: 'external_seed',
        brand: 'Haruharu Wonder',
        name: 'Daily Soothing Sun Shield SPF50+ PA++++',
        display_name: 'Haruharu Wonder Daily Soothing Sun Shield SPF50+ PA++++',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_reason: 'external_seed_local_search:support_category_exact',
        retrieval_match_stage: 'support_category_exact',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen',
        local_external_seed_role_fit_score: 1.305,
        short_description: 'Feather-light, cooling texture with a non-greasy, semi-matte finish that stays invisible through the day.',
        key_features: ['Niacinamide'],
        product_intel: {
          shopping_card: {
            intro: 'Portable SPF50+ sun stick for quick daytime touchups.',
          },
          what_it_is: {
            body: 'A chemical-filter sun stick designed for portable daytime reapplication.',
          },
          product_intel_core: {
            what_it_is: {
              body: 'A chemical-filter sun stick designed for portable daytime reapplication.',
            },
          },
        },
      },
      {
        product_id: 'boj_aqua_fresh_tie',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        display_name: 'Beauty of Joseon Relief Sun Aqua-Fresh : Rice + B5 (SPF50+ PA++++)',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_reason: 'external_seed_local_search:support_category_exact',
        retrieval_match_stage: 'support_category_exact',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen',
        local_external_seed_role_fit_score: 1.305,
        short_description: 'A lightweight sunscreen fluid that layers smoothly under makeup with no white cast.',
        description: 'A daily sunscreen built around modern organic UV filters for lightweight daytime layering under makeup with no white cast.',
      },
    ].map((row) => __internal.normalizeRecoCatalogProduct(row)),
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'boj_aqua_fresh_tie');
  assert.equal(state.selected_recommendations[1]?.product_id, 'haruharu_portable_stick_tie');
  const stick = state.viable_candidate_pool.find((row) => row?.product_id === 'haruharu_portable_stick_tie') || null;
  const fluid = state.viable_candidate_pool.find((row) => row?.product_id === 'boj_aqua_fresh_tie') || null;
  assert.ok(stick);
  assert.ok(fluid);
  assert.ok(Number(fluid.framework_tiebreak_score || 0) > Number(stick.framework_tiebreak_score || 0));
});

test('__internal: framework pool demotes mini sunscreen variants behind full-size same-role options', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'day_dew_sunscreen_full_size',
        merchant_id: 'external_seed',
        brand: 'LightLab',
        name: 'Day Dew Sunscreen SPF 50',
        display_name: 'LightLab Day Dew Sunscreen SPF 50',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight sunscreen oily skin',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        local_external_seed_role_fit_score: 0.94,
        benefit_tags: ['spf 50', 'lightweight', 'under makeup'],
        short_description: 'A lightweight fluid sunscreen that wears well under makeup.',
        canonical_pdp_url: 'https://example.com/products/day-dew-sunscreen',
      },
      {
        product_id: 'day_dew_sunscreen_mini_10ml',
        merchant_id: 'external_seed',
        brand: 'LightLab',
        name: 'Day Dew Sunscreen SPF 50 10ml',
        display_name: 'LightLab Day Dew Sunscreen SPF 50 10ml',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_query: 'lightweight sunscreen oily skin',
        retrieval_step: 'sunscreen',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        local_external_seed_role_fit_score: 0.94,
        benefit_tags: ['spf 50', 'lightweight', 'under makeup'],
        short_description: 'A lightweight fluid sunscreen that wears well under makeup.',
        canonical_pdp_url: 'https://example.com/products/day-dew-sunscreen-mini',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_same_role_full_size_over_mini',
        primary_role_id: 'daily_sunscreen_finish_fit',
        routine_mode: 'same_role_comparison',
        comparison_mode: 'same_role_comparison',
        framework_roles: [
          {
            role_id: 'daily_sunscreen_finish_fit',
            rank: 1,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen finish fit',
            query_terms: ['lightweight sunscreen oily skin', 'sunscreen under makeup'],
            fit_keywords: ['spf', 'lightweight', 'under makeup', 'fluid'],
            ingredient_hypotheses: ['UV filters'],
            product_type_hypotheses: ['sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['day_dew_sunscreen_full_size', 'day_dew_sunscreen_mini_10ml'],
  );
  const fullSize = state.viable_candidate_pool.find((row) => row?.product_id === 'day_dew_sunscreen_full_size') || null;
  const mini = state.viable_candidate_pool.find((row) => row?.product_id === 'day_dew_sunscreen_mini_10ml') || null;
  assert.ok(fullSize);
  assert.ok(mini);
  assert.ok(Number(fullSize.framework_rank_score || 0) >= Number(mini.framework_rank_score || 0));
  assert.ok(Number(fullSize.framework_tiebreak_score || 0) > Number(mini.framework_tiebreak_score || 0));
});

test('__internal: framework pool rejects cosmetic finish products from under-makeup routine support roles', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_under_makeup_cosmetic_finish_shape',
    primary_role_id: 'daily_sunscreen_finish_fit',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'oily skin sunscreen under makeup',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['under makeup', 'avoid pilling', 'oil control'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen under makeup', 'lightweight sunscreen oily skin'],
        fit_keywords: ['spf', 'uv filters', 'lightweight', 'under makeup', 'fluid'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
      {
        role_id: 'layering_compatible_moisturizer_or_spf',
        rank: 60,
        preferred_step: 'moisturizer',
        label: 'Layering-compatible moisturizer or SPF',
        query_terms: ['gel cream moisturizer', 'lightweight moisturizer', 'makeup layering'],
        fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
        ingredient_hypotheses: ['Ceramide NP', 'Hyaluronic acid'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
        alternate_steps: ['serum'],
        label: 'Oil-control treatment',
        query_terms: ['oil control serum', 'shine control serum'],
        fit_keywords: ['oil control', 'shine control', 'mattifying', 'acne', 'congestion', 'clogged pores'],
        ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
        product_type_hypotheses: ['treatment', 'serum'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'boj_daily_tinted_fluid_spf',
        merchant_id: 'external_seed',
        brand: 'Beauty of Joseon',
        name: 'Daily Tinted Fluid Sunscreen DN310',
        display_name: 'Beauty of Joseon Daily Tinted Fluid Sunscreen DN310',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        local_external_seed_role_fit_score: 1.04,
        benefit_tags: ['spf', 'lightweight', 'under makeup'],
        short_description: 'A fluid SPF sunscreen for daily wear under makeup.',
      },
      {
        product_id: 'pixi_rose_radiance_perfector',
        merchant_id: 'external_seed',
        brand: 'PIXI BEAUTY',
        name: '+Rose Radiance Perfector',
        display_name: 'PIXI BEAUTY +Rose Radiance Perfector',
        category: 'Primer',
        product_type: 'Perfector',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'lightweight moisturizer under makeup',
        local_external_seed_role_fit_score: 1.24,
        benefit_tags: ['smooth layering', 'under makeup', 'radiance'],
        short_description:
          'A radiance perfector primer with Ceramide NP and Hyaluronic acid for a smooth makeup base.',
      },
      {
        product_id: 'krave_oat_water_cream_makeup',
        merchant_id: 'external_seed',
        brand: 'KraveBeauty',
        name: 'Oat So Simple Water Cream',
        display_name: 'KraveBeauty Oat So Simple Water Cream',
        category: 'Face Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'gel cream moisturizer',
        local_external_seed_role_fit_score: 1.02,
        benefit_tags: ['lightweight', 'non-greasy', 'makeup layering'],
        short_description: 'A lightweight water cream moisturizer that layers without a greasy finish.',
      },
      {
        product_id: 'pixi_clarity_mist_mislabeled_moisturizer',
        merchant_id: 'external_seed',
        brand: 'PIXI BEAUTY',
        name: 'Clarity Mist',
        display_name: 'PIXI BEAUTY Clarity Mist',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'lightweight moisturizer under makeup',
        local_external_seed_role_fit_score: 1.18,
        benefit_tags: ['lightweight', 'oil-free', 'makeup layering'],
        short_description:
          'A lightweight facial spray with cica and Hyaluronic Complex to lock in moisture before SPF application.',
      },
      {
        product_id: 'fab_bronze_glow_drops',
        merchant_id: 'external_seed',
        brand: 'First Aid Beauty',
        name: 'Bronze + Glow Drops with Niacinamide',
        display_name: 'First Aid Beauty Bronze + Glow Drops with Niacinamide',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'oil_control_treatment',
        retrieval_query: 'oil control serum',
        local_external_seed_role_fit_score: 1.26,
        benefit_tags: ['niacinamide', 'lightweight serum', 'glow drops'],
        short_description:
          'Bronze + Glow Drops with 5% Niacinamide, glycerin, and a lightweight non-comedogenic feel.',
      },
      {
        product_id: 'ordinary_niacinamide_oil_control',
        merchant_id: 'external_seed',
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'oil_control_treatment',
        retrieval_query: 'oil control serum',
        local_external_seed_role_fit_score: 1.04,
        benefit_tags: ['niacinamide', 'zinc pca', 'oil control'],
        short_description: 'A focused niacinamide and zinc PCA serum for excess oil and visible shine.',
      },
    ].map((row) => __internal.normalizeRecoCatalogProduct(row)),
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['boj_daily_tinted_fluid_spf', 'krave_oat_water_cream_makeup', 'ordinary_niacinamide_oil_control'],
  );
  for (const rejectedId of ['pixi_rose_radiance_perfector', 'pixi_clarity_mist_mislabeled_moisturizer', 'fab_bronze_glow_drops']) {
    assert.equal(
      state.selected_recommendations.some((row) => row.product_id === rejectedId),
      false,
    );
    assert.equal(
      state.hard_reject.some((entry) => entry?.product?.product_id === rejectedId)
        || state.soft_mismatch.some((entry) => entry?.product?.product_id === rejectedId),
      true,
    );
  }
});

test('__internal: framework pool treats high role-fit external seed serums as viable tone-mark candidates', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_tone_marks_external_role_fit',
    primary_role_id: 'tone_mark_treatment',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'post-breakout marks',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['post-breakout marks', 'uneven tone'],
    },
    framework_roles: [
      {
        role_id: 'tone_mark_treatment',
        rank: 1,
        preferred_step: 'treatment',
        label: 'Tone and post-breakout mark treatment',
        query_terms: ['post acne marks serum', 'dark spot serum'],
        fit_keywords: ['post-breakout marks', 'dark spots', 'uneven tone', 'brightening'],
        ingredient_hypotheses: ['Vitamin C', 'Niacinamide'],
        product_type_hypotheses: ['serum', 'treatment'],
      },
      {
        role_id: 'lightweight_moisturizer',
        rank: 2,
        preferred_step: 'moisturizer',
        label: 'Lightweight moisturizer',
        query_terms: ['gel cream moisturizer'],
        fit_keywords: ['lightweight', 'gel cream'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 3,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen'],
        fit_keywords: ['spf', 'uv protection'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const normalizedCandidates = [
    {
      product_id: 'pro_c_serum_tone_1',
      merchant_id: 'external_seed',
      brand: 'Example',
      name: 'Pro C Serum',
      display_name: 'Example Pro C Serum',
      category: 'Serum',
      product_type: 'Serum',
      retrieval_source: 'external_seed',
      retrieval_role_id: 'tone_mark_treatment',
      local_external_seed_role_fit_score: 1.18,
      short_description: 'Vitamin C serum helps improve overall skin tone and radiance.',
    },
    {
      product_id: 'water_gel_moisturizer_1',
      merchant_id: 'external_seed',
      brand: 'Example',
      name: 'Water Gel Moisturizer',
      display_name: 'Example Water Gel Moisturizer',
      category: 'Moisturizer',
      product_type: 'Moisturizer',
      retrieval_source: 'external_seed',
      retrieval_role_id: 'lightweight_moisturizer',
      short_description: 'Lightweight gel cream for daily hydration.',
    },
    {
      product_id: 'daily_spf_1',
      merchant_id: 'external_seed',
      brand: 'Example',
      name: 'Daily Sunscreen SPF 50',
      display_name: 'Example Daily Sunscreen SPF 50',
      category: 'Sunscreen',
      product_type: 'Sunscreen',
      retrieval_source: 'external_seed',
      retrieval_role_id: 'daily_sunscreen',
      short_description: 'Daily broad spectrum SPF 50 sunscreen.',
    },
  ].map((row) => __internal.normalizeRecoCatalogProduct(row));

  const state = __internal.finalizeConcernFrameworkCandidatePools(
    normalizedCandidates,
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['pro_c_serum_tone_1', 'water_gel_moisturizer_1', 'daily_spf_1'],
  );
  const primary = state.viable_candidate_pool.find((row) => row?.product_id === 'pro_c_serum_tone_1') || null;
  assert.ok(primary);
  assert.equal(primary.matched_role_id, 'tone_mark_treatment');
  assert.equal(primary.framework_role_fit_score, 1.18);
  assert.equal(state.scope_classification_stats.explicit_non_skincare, 0);
});

test('__internal: framework pool does not boundary-reject raw external seed candidates whose authority title carries the product type', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_tone_marks_raw_external_title',
    primary_role_id: 'tone_mark_treatment',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'post-breakout marks',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['post-breakout marks', 'uneven tone'],
    },
    framework_roles: [
      {
        role_id: 'tone_mark_treatment',
        rank: 1,
        preferred_step: 'treatment',
        label: 'Tone and post-breakout mark treatment',
        query_terms: ['post acne marks serum', 'dark spot serum'],
        fit_keywords: ['post-breakout marks', 'dark spots', 'uneven tone', 'brightening'],
        ingredient_hypotheses: ['Vitamin C', 'Niacinamide'],
        product_type_hypotheses: ['serum', 'treatment'],
      },
      {
        role_id: 'lightweight_moisturizer',
        rank: 2,
        preferred_step: 'moisturizer',
        label: 'Lightweight moisturizer',
        query_terms: ['gel cream moisturizer'],
        fit_keywords: ['lightweight', 'gel cream'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 3,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen'],
        fit_keywords: ['spf', 'uv protection'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'ext_pro_c_serum_raw_title',
        merchant_id: 'external_seed',
        brand: 'Example',
        title: 'Pro C Serum',
        category_name: 'Serum',
        productType: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'tone_mark_treatment',
        local_external_seed_role_fit_score: 1.2,
        description: 'Fragrance-free multi-stage brightening serum that visibly reduces post-acne marks and supports overall skin tone.',
      },
      {
        product_id: 'water_gel_moisturizer_raw_title',
        merchant_id: 'external_seed',
        brand: 'Example',
        title: 'Water Gel Moisturizer',
        category_name: 'Moisturizer',
        productType: 'Moisturizer',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'lightweight_moisturizer',
        description: 'Lightweight gel cream moisturizer for daily hydration.',
      },
      {
        product_id: 'daily_spf_raw_title',
        merchant_id: 'external_seed',
        brand: 'Example',
        title: 'Daily Sunscreen SPF 50',
        category_name: 'Sunscreen',
        productType: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        description: 'Daily broad spectrum SPF 50 sunscreen.',
      },
    ],
    { targetContext },
  );

  const primary = state.viable_candidate_pool.find((row) => row?.product_id === 'ext_pro_c_serum_raw_title') || null;
  assert.equal(state.primary_role_matched, true);
  assert.ok(primary);
  assert.equal(primary.concern_scope_classification, 'explicit_face_skincare');
  assert.equal(primary.matched_role_id, 'tone_mark_treatment');
  assert.equal((state.boundary_reject_preview || []).some((row) => row.product_id === 'ext_pro_c_serum_raw_title'), false);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['ext_pro_c_serum_raw_title', 'water_gel_moisturizer_raw_title', 'daily_spf_raw_title'],
  );
});

test('__internal: framework pool preserves a viable retrieved layering role when barrier context is also present', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_makeup_layering_with_barrier_context',
    primary_role_id: 'daily_sunscreen_finish_fit',
    routine_mode: 'routine_mix',
    semantic_plan: {
      primary_concern: 'daytime routine under makeup with impaired barrier',
      routine_mode: 'routine_mix',
      comparison_mode: 'routine_mix',
      must_satisfy_constraints: ['under makeup', 'avoid pilling', 'barrier support'],
    },
    framework_roles: [
      {
        role_id: 'daily_sunscreen_finish_fit',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen finish fit',
        query_terms: ['sunscreen under makeup', 'lightweight sunscreen'],
        fit_keywords: ['spf', 'uv filters', 'lightweight', 'under makeup'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
      {
        role_id: 'layering_compatible_moisturizer_or_spf',
        rank: 60,
        preferred_step: 'moisturizer',
        label: 'Layering-compatible moisturizer or SPF',
        query_terms: ['gel cream moisturizer', 'lightweight moisturizer', 'makeup layering'],
        fit_keywords: ['lightweight', 'layering', 'non-greasy', 'makeup'],
        ingredient_hypotheses: ['Glycerin', 'Panthenol'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'barrier_moisturizer',
        rank: 41,
        preferred_step: 'moisturizer',
        label: 'Barrier-support moisturizer',
        query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
        fit_keywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin', 'fragrance free'],
        ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
        product_type_hypotheses: ['moisturizer'],
      },
    ],
  };
  const teaTricaBase = {
    product_id: 'skin1004_teatrica_b5_cream',
    merchant_id: 'external_seed',
    brand: 'Skin1004',
    name: 'Tea-Trica B5 Cream',
    display_name: 'Skin1004 Tea-Trica B5 Cream',
    category: 'Face Moisturizer',
    product_type: 'Moisturizer',
    retrieval_source: 'external_seed',
    short_description: 'A lightweight gel cream with panthenol, cica, and ceramide that layers cleanly without a greasy residue.',
    benefit_tags: ['lightweight hydration', 'non-greasy finish', 'barrier support'],
    key_features: ['Panthenol', 'Ceramide NP', 'Centella asiatica'],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'murad_finish_fit_spf',
        merchant_id: 'external_seed',
        brand: 'Murad',
        name: 'Superactive Moisturizer SPF 50: Hydrating',
        display_name: 'Murad Superactive Moisturizer SPF 50: Hydrating',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen_finish_fit',
        retrieval_query: 'sunscreen under makeup',
        short_description: 'A hydrating SPF 50 moisturizer for daily sunscreen wear.',
      },
      {
        ...teaTricaBase,
        retrieval_role_id: 'layering_compatible_moisturizer_or_spf',
        retrieval_query: 'gel cream moisturizer',
      },
      {
        ...teaTricaBase,
        retrieval_role_id: 'barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
      },
    ],
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.role_pool_stats.layering_compatible_moisturizer_or_spf.viable_count, 1);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.matched_role_id),
    ['daily_sunscreen_finish_fit', 'layering_compatible_moisturizer_or_spf'],
  );
  const layeringPick = state.selected_recommendations.find((row) => row.product_id === 'skin1004_teatrica_b5_cream');
  assert.equal(layeringPick?.framework_retrieval_role_owner_preserved, true);
});

test('__internal: framework pool preserves same product across planned retrieval roles before role-fit', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_sensitive_barrier_duplicate_context',
    primary_role_id: 'soothing_treatment',
    routine_mode: 'routine_mix',
    semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
    mainline_fallback_policy: 'strict_no_runtime_fallback',
    semantic_planner_required: true,
    framework_roles: [
      {
        role_id: 'soothing_treatment',
        rank: 70,
        preferred_step: 'treatment',
        alternate_steps: ['serum'],
        label: 'Soothing treatment',
        query_terms: ['soothing serum sensitive skin', 'cica serum redness', 'panthenol treatment'],
        fit_keywords: ['soothing', 'cica', 'panthenol', 'redness', 'calming'],
        ingredient_hypotheses: ['Panthenol', 'Madecassoside'],
      },
      {
        role_id: 'barrier_moisturizer',
        rank: 41,
        preferred_step: 'moisturizer',
        label: 'Barrier-support moisturizer',
        query_terms: ['barrier repair moisturizer', 'ceramide cream sensitive skin', 'soothing moisturizer'],
        fit_keywords: ['barrier repair', 'ceramide', 'soothing', 'sensitive skin', 'fragrance free'],
        ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
        fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
        ingredient_hypotheses: ['UV filters'],
      },
    ],
  };
  const kraveBase = {
    product_id: '10008793153864',
    merchant_id: 'merch_efbc46b4619cfbdf',
    brand: 'KraveBeauty',
    name: 'KraveBeauty Great Barrier Relief',
    display_name: 'KraveBeauty Great Barrier Relief',
    description: 'A barrier-repair serum for over-sensitized or irritated skin, built around tamanu oil, niacinamide, and ceramides to calm the look of redness.',
    retrieval_source: 'catalog',
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'ext_soothing_serum_1',
        merchant_id: 'external_seed',
        brand: 'Haruharu Wonder',
        name: 'Soothing Serum',
        display_name: 'Soothing Serum',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'soothing_treatment',
        retrieval_step: 'treatment',
        retrieval_query: 'soothing treatment',
        short_description: 'A gentle serum to soothe redness with panthenol and cica.',
      },
      {
        ...kraveBase,
        retrieval_role_id: 'soothing_treatment',
        retrieval_step: 'treatment',
        retrieval_query: 'soothing serum sensitive skin',
      },
      {
        ...kraveBase,
        retrieval_role_id: 'barrier_moisturizer',
        retrieval_step: 'moisturizer',
        retrieval_query: 'barrier repair moisturizer',
      },
      {
        product_id: 'daily_sunscreen_1',
        merchant_id: 'external_seed',
        brand: 'The Ordinary',
        name: 'UV Filters SPF 45 Serum',
        display_name: 'UV Filters SPF 45 Serum',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_step: 'sunscreen',
        retrieval_query: 'daily sunscreen',
        short_description: 'A lightweight SPF 45 sunscreen serum for daily UV protection.',
      },
    ],
    { targetContext },
  );

  assert.equal(state.selected_candidate_count, 3);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.matched_role_id),
    ['soothing_treatment', 'barrier_moisturizer', 'daily_sunscreen'],
  );
  assert.equal(
    state.selected_recommendations.find((row) => row.product_id === '10008793153864')?.candidate_step,
    'moisturizer',
  );
  assert.equal(state.role_pool_stats.barrier_moisturizer.viable_count, 1);
});

test('__internal: framework pool preserves planner support-role order instead of canonical rank order', () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'barrier_moisturizer_order_1',
        merchant_id: 'merchant_internal',
        brand: 'KraveBeauty',
        name: 'Great Barrier Relief',
        display_name: 'KraveBeauty Great Barrier Relief',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'catalog',
        retrieval_role_id: 'hydrating_barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
        short_description: 'A barrier repair moisturizer with ceramides for dry, tight skin.',
      },
      {
        product_id: 'hydrating_serum_order_1',
        merchant_id: 'external_seed',
        brand: 'Naturium',
        name: 'Quadruple Hyaluronic Acid Serum 5%',
        display_name: 'Naturium Quadruple Hyaluronic Acid Serum 5%',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'hydrating_serum_or_essence',
        retrieval_query: 'hyaluronic acid serum',
        search_aliases: ['hyaluronic acid serum'],
        short_description: 'A hydrating serum with hyaluronic acid for dehydrated skin.',
      },
      {
        product_id: 'daily_sunscreen_order_1',
        merchant_id: 'external_seed',
        brand: 'The Ordinary',
        name: 'UV Filters SPF 45 Serum',
        display_name: 'UV Filters SPF 45 Serum',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_query: 'daily sunscreen',
        short_description: 'A lightweight SPF 45 sunscreen serum for daily UV protection.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_planner_support_order',
        primary_role_id: 'hydrating_barrier_moisturizer',
        routine_mode: 'routine_mix',
        semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
        framework_roles: [
          {
            role_id: 'hydrating_barrier_moisturizer',
            rank: 40,
            preferred_step: 'moisturizer',
            label: 'Hydrating barrier moisturizer',
            query_terms: ['barrier repair moisturizer'],
            fit_keywords: ['hydrating', 'barrier repair', 'ceramide', 'dry skin'],
            product_type_hypotheses: ['moisturizer'],
          },
          {
            role_id: 'hydrating_serum_or_essence',
            rank: 42,
            preferred_step: 'serum',
            label: 'Hydrating serum or essence',
            query_terms: ['hyaluronic acid serum', 'hydrating serum dehydrated skin'],
            fit_keywords: ['hydrating', 'dehydrated', 'hyaluronic acid'],
            product_type_hypotheses: ['serum', 'treatment'],
          },
          {
            role_id: 'daily_sunscreen',
            rank: 30,
            preferred_step: 'sunscreen',
            label: 'Daily sunscreen',
            query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
            fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
            product_type_hypotheses: ['sunscreen'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.matched_role_id),
    ['hydrating_barrier_moisturizer', 'hydrating_serum_or_essence', 'daily_sunscreen'],
  );
});

test('__internal: framework pool rejects generic niacinamide serum as hydrating-serum support', () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'recofw_test_hydrating_serum_role_fit',
    primary_role_id: 'hydrating_barrier_moisturizer',
    routine_mode: 'routine_mix',
    semantic_plan: { routine_mode: 'routine_mix', comparison_mode: 'routine_mix' },
    framework_roles: [
      {
        role_id: 'hydrating_barrier_moisturizer',
        rank: 40,
        preferred_step: 'moisturizer',
        label: 'Hydrating barrier moisturizer',
        query_terms: ['barrier repair moisturizer'],
        fit_keywords: ['hydrating', 'barrier repair', 'ceramide', 'dry skin'],
        ingredient_hypotheses: ['Ceramide NP', 'Panthenol', 'Glycerin'],
        product_type_hypotheses: ['moisturizer'],
      },
      {
        role_id: 'hydrating_serum_or_essence',
        rank: 42,
        preferred_step: 'serum',
        label: 'Hydrating serum or essence',
        query_terms: ['hyaluronic acid serum', 'hydrating serum dehydrated skin'],
        fit_keywords: ['hydrating', 'dehydrated', 'hyaluronic acid'],
        ingredient_hypotheses: ['Hyaluronic acid', 'Glycerin', 'Panthenol'],
        product_type_hypotheses: ['serum', 'essence'],
      },
      {
        role_id: 'daily_sunscreen',
        rank: 30,
        preferred_step: 'sunscreen',
        label: 'Daily sunscreen',
        query_terms: ['daily sunscreen skincare', 'broad spectrum sunscreen'],
        fit_keywords: ['spf', 'uv filters', 'broad spectrum', 'lightweight'],
        ingredient_hypotheses: ['UV filters'],
        product_type_hypotheses: ['sunscreen'],
      },
    ],
  };
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'barrier_moisturizer_fit_1',
        merchant_id: 'merchant_internal',
        brand: 'KraveBeauty',
        name: 'Great Barrier Relief',
        display_name: 'KraveBeauty Great Barrier Relief',
        category: 'Moisturizer',
        product_type: 'Moisturizer',
        retrieval_source: 'catalog',
        retrieval_role_id: 'hydrating_barrier_moisturizer',
        retrieval_query: 'barrier repair moisturizer',
        short_description: 'A hydrating barrier repair moisturizer with ceramides for dry, tight skin.',
      },
      {
        product_id: 'generic_niacinamide_serum_fit_1',
        merchant_id: 'merchant_internal',
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'catalog',
        retrieval_role_id: 'hydrating_serum_or_essence',
        retrieval_query: 'hydrating serum dehydrated skin',
        short_description: 'A niacinamide and zinc serum for oil balance and shine control.',
      },
      {
        product_id: 'true_hydrating_serum_fit_1',
        merchant_id: 'external_seed',
        brand: 'Naturium',
        name: 'Quadruple Hyaluronic Acid Serum 5%',
        display_name: 'Naturium Quadruple Hyaluronic Acid Serum 5%',
        category: 'Serum',
        product_type: 'Serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'hydrating_serum_or_essence',
        retrieval_query: 'hyaluronic acid serum',
        search_aliases: ['hyaluronic acid serum'],
        short_description: 'A hydrating serum with hyaluronic acid and glycerin for dehydrated skin.',
      },
      {
        product_id: 'daily_sunscreen_fit_1',
        merchant_id: 'external_seed',
        brand: 'The Ordinary',
        name: 'UV Filters SPF 45 Serum',
        display_name: 'UV Filters SPF 45 Serum',
        category: 'Sunscreen',
        product_type: 'Sunscreen',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'daily_sunscreen',
        retrieval_query: 'daily sunscreen',
        short_description: 'A lightweight SPF 45 sunscreen serum for daily UV protection.',
      },
    ],
    { targetContext },
  );

  assert.equal(state.primary_role_matched, true);
  assert.deepEqual(
    state.selected_recommendations.map((row) => row.product_id),
    ['barrier_moisturizer_fit_1', 'true_hydrating_serum_fit_1', 'daily_sunscreen_fit_1'],
  );
  assert.equal(
    state.selected_recommendations.some((row) => row.product_id === 'generic_niacinamide_serum_fit_1'),
    false,
  );
  assert.equal(
    state.soft_mismatch.some((entry) => entry?.product?.product_id === 'generic_niacinamide_serum_fit_1'),
    true,
  );
});

test('__internal: framework pool keeps external seed skincare candidates when skincare evidence lives only in alias and description', async () => {
  const { __internal } = loadRoutesFresh();
  const normalized = __internal.normalizeRecoCatalogProduct({
    product_id: 'ext_oil_live_shape_1',
    merchant_id: 'merchant_ext_oil_live_shape',
    brand: 'Fenty Skin',
    name: 'Gloss Bomb Control',
    display_name: 'Fenty Skin Gloss Bomb Control',
    category: 'beauty',
    source: 'external_seed',
    search_aliases: ['Fenty Skin Oil Control Serum'],
    benefit_tags: ['oil control', 'shine control'],
    short_description: 'A mattifying balancing serum for oily skin.',
  });
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [normalized],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_live_shape',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'ext_oil_live_shape_1');
  assert.equal(state.selected_recommendations[0]?.candidate_step, 'serum');
  assert.equal(state.selected_source_counts?.external_seed, 1);
  assert.equal(state.external_seed_used_count, 1);
});

test('__internal: reco catalog normalization removes placeholder seed copy from user-visible evidence fields', async () => {
  const { __internal } = loadRoutesFresh();
  const normalized = __internal.normalizeRecoCatalogProduct({
    product_id: 'ext_placeholder_copy_1',
    merchant_id: 'external_seed',
    brand: 'Winona',
    display_name: 'Winona Soothing Repair Serum',
    category: 'Serum',
    product_type: 'Serum',
    source: 'external_seed',
    retrieval_source: 'external_seed',
    retrieval_role_id: 'soothing_treatment',
    short_description: 'Replace with your own description if needed.',
    description: 'Test fixture for PDP. Replace with your own description if needed.',
    why_this_one: 'Replace with your own description if needed.',
    key_features: ['Replace with your own description if needed.', 'Soothing serum'],
    compare_highlights: ['Replace with your own description if needed.'],
    benefit_tags: ['soothing', 'redness'],
    search_aliases: ['soothing serum sensitive skin'],
  });

  assert.equal(normalized?.short_description, undefined);
  assert.equal(normalized?.description, undefined);
  assert.equal(normalized?.why_this_one, undefined);
  assert.deepEqual(normalized?.key_features, ['Soothing serum']);
  assert.equal(Array.isArray(normalized?.compare_highlights), false);
  assert.ok(
    !(Array.isArray(normalized?.description_tokens) ? normalized.description_tokens : [])
      .some((item) => /replace with your own description/i.test(String(item || ''))),
  );
});

test('__internal: reco catalog normalization removes low-information seed copy from visible fields', async () => {
  const { __internal } = loadRoutesFresh();
  const naturium = __internal.normalizeRecoCatalogProduct({
    product_id: 'ext_low_info_copy_1',
    merchant_id: 'external_seed',
    brand: 'Naturium',
    display_name: 'Naturium Quadruple Hyaluronic Acid Serum 5%',
    category: 'Serum',
    product_type: 'Serum',
    source: 'external_seed',
    retrieval_source: 'external_seed',
    retrieval_role_id: 'hydrating_serum_or_essence',
    short_description: 'Double up and save with this jumbo',
    description: 'Double up and save with this jumbo',
    why_this_one: 'Double up and save with this jumbo',
    search_aliases: ['hyaluronic acid serum'],
  });
  assert.equal(naturium?.short_description, undefined);
  assert.equal(naturium?.description, undefined);
  assert.equal(naturium?.why_this_one, undefined);

  const haruharu = __internal.normalizeRecoCatalogProduct({
    product_id: 'ext_scraped_header_copy_1',
    merchant_id: 'external_seed',
    brand: 'Haruharu Wonder',
    display_name: 'Haruharu Wonder Soothing Serum',
    category: 'Serum',
    product_type: 'Serum',
    source: 'external_seed',
    short_description: 'Details Key Features - Multi-benefit formula: a gentle serum to soothe and hydrate sensitive skin.',
  });
  assert.equal(
    haruharu?.short_description,
    'Multi-benefit formula: a gentle serum to soothe and hydrate sensitive skin.',
  );
});

test('__internal: reco catalog normalization canonicalizes visible beauty brand labels', async () => {
  const { __internal } = loadRoutesFresh();
  const ordinary = __internal.normalizeRecoCatalogProduct({
    product_id: 'ext_brand_label_1',
    merchant_id: 'external_seed',
    brand: 'the ordinary',
    display_name: 'UV Filters SPF 45 Serum',
    category: 'Sunscreen',
  });
  assert.equal(ordinary?.brand, 'The Ordinary');

  const krave = __internal.normalizeRecoCatalogProduct({
    product_id: 'catalog_brand_label_2',
    merchant_id: 'merchant_internal',
    display_name: 'KraveBeauty Great Barrier Relief',
    category: 'Moisturizer',
  });
  assert.equal(krave?.brand, 'KraveBeauty');
});

test('__internal: framework pool promotes strong semantic serum evidence into the treatment primary slot', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'catalog_oil_balance_1',
        merchant_id: 'merchant_catalog_oil_balance',
        brand: 'Clarity Lab',
        name: 'Shine Balance Serum',
        display_name: 'Clarity Lab Shine Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['Oil Balance Serum'],
        benefit_tags: ['oil control', 'mattifying'],
        short_description: 'A mattifying balancing serum for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_promoted_serum',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'catalog_oil_balance_1');
  assert.ok(Number(state.selected_recommendations[0]?.framework_score || 0) >= 0.58);
  assert.equal(state.selected_source_counts?.catalog, 1);
  assert.equal(state.weak_viable_pool, false);
});

test('__internal: framework pool treats serum as the default alternate shape for treatment roles', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'catalog_oil_balance_default_serum_1',
        merchant_id: 'merchant_catalog_oil_balance_default_serum',
        brand: 'Clarity Lab',
        name: 'Shine Balance Serum',
        display_name: 'Clarity Lab Shine Balance Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_query: 'oil control serum',
        retrieval_step: 'treatment',
        retrieval_role_id: 'oil_control_treatment',
        search_aliases: ['Oil Balance Serum'],
        benefit_tags: ['oil control', 'mattifying'],
        short_description: 'A mattifying balancing serum for oily skin.',
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_default_serum_shape',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
            ingredient_hypotheses: ['Niacinamide', 'Zinc PCA'],
            product_type_hypotheses: ['treatment', 'serum'],
          },
        ],
      },
    },
  );

  assert.equal(state.primary_role_matched, true);
  assert.equal(state.selected_recommendations[0]?.product_id, 'catalog_oil_balance_default_serum_1');
  assert.ok(Number(state.selected_recommendations[0]?.framework_score || 0) >= 0.58);
});

test('__internal: framework pool exposes source counts and reject preview for shared surfacing diagnostics', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'int_niac_diag_1',
        merchant_id: 'merchant_int_niac_diag',
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_role_id: 'oil_control_treatment',
        ingredient_tokens: ['niacinamide', 'zinc'],
      },
      {
        product_id: 'ext_oil_diag_1',
        merchant_id: 'merchant_ext_oil_diag',
        brand: 'Fenty Skin',
        name: 'Oil Control Serum',
        display_name: 'Fenty Skin Oil Control Serum',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'external_seed',
        retrieval_role_id: 'oil_control_treatment',
        tag_tokens: ['oil control', 'shine control'],
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_diag',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.equal(state.raw_source_counts?.catalog, 1);
  assert.equal(state.raw_source_counts?.external_seed, 1);
  assert.equal(state.viable_source_counts?.external_seed, 1);
  assert.equal(state.selected_source_counts?.external_seed, 1);
  assert.ok(Array.isArray(state.hard_reject_preview));
  assert.equal(state.hard_reject_preview[0]?.product_id, 'int_niac_diag_1');
  assert.ok(
    ['framework_hard_mismatch', 'framework_primary_semantic_missing'].includes(
      String(state.hard_reject_preview[0]?.reason || ''),
    ),
  );
});

test('__internal: framework reject preview includes product title for live diagnostics', async () => {
  const { __internal } = loadRoutesFresh();
  const state = __internal.finalizeConcernFrameworkCandidatePools(
    [
      {
        product_id: 'int_niac_preview_1',
        merchant_id: 'merchant_int_niac_preview',
        brand: 'The Ordinary',
        name: 'Niacinamide 10% + Zinc 1%',
        display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
        category: 'serum',
        product_type: 'serum',
        retrieval_source: 'catalog',
        retrieval_role_id: 'oil_control_treatment',
        ingredient_tokens: ['niacinamide', 'zinc'],
      },
    ],
    {
      targetContext: {
        framework_id: 'recofw_test_oily_preview_title',
        primary_role_id: 'oil_control_treatment',
        framework_roles: [
          {
            role_id: 'oil_control_treatment',
            rank: 1,
            preferred_step: 'treatment',
            alternate_steps: ['serum'],
            label: 'Oil-control treatment',
            query_terms: ['oil control serum', 'shine control serum', 'mattifying serum', 'balancing serum oily skin'],
            fit_keywords: ['oil control', 'shine control', 'mattifying', 'mattify', 'sebum', 'balancing', 'anti-shine', 'blemish'],
          },
        ],
      },
    },
  );

  assert.ok(Array.isArray(state.hard_reject_preview));
  assert.equal(state.hard_reject_preview[0]?.product_id, 'int_niac_preview_1');
  assert.equal(state.hard_reject_preview[0]?.title, 'The Ordinary Niacinamide 10% + Zinc 1%');
});

test('__internal: framework reco query collection runs per-level catalog searches concurrently', async () => {
  const originalGet = axios.get;
  let inFlight = 0;
  let maxInFlight = 0;
  const observedParams = [];

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    observedParams.push(config?.params || {});
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight -= 1;
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: `prod_${String(config?.params?.query || '').replace(/\s+/g, '_')}`,
            merchant_id: 'mid_concurrency',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            ingredient_tokens: ['niacinamide'],
          },
        ],
      },
    };
  };

  try {
    const { __internal } = loadRoutesFresh();
    const targetContext = {
      framework_id: 'framework_oily_skin_v1',
      primary_role_id: 'oil_control_treatment',
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
        },
      ],
      framework_owner_source: 'generic_concern_framework_resolver',
      framework_owner_state: 'trusted',
      framework_summary: {
        concern_text: 'im oily skin, what product should i use?',
      },
    };
    const queryLevels = [
      {
        level_index: 0,
        ladder_level: 'framework_oil_control_treatment',
        queries: [
          { query: 'oil control serum', step: 'treatment', slot: 'other', ladder_level: 'framework_oil_control_treatment', role_id: 'oil_control_treatment' },
          { query: 'shine control serum', step: 'treatment', slot: 'other', ladder_level: 'framework_oil_control_treatment', role_id: 'oil_control_treatment' },
          { query: 'mattifying serum', step: 'treatment', slot: 'other', ladder_level: 'framework_oil_control_treatment', role_id: 'oil_control_treatment' },
        ],
      },
    ];

    const out = await __internal.collectRecoCandidatesFromQueryLevels({
      queryLevels,
      targetContext,
      recommendationTaskContext: null,
      logger: null,
      timeoutMs: 800,
      limit: 6,
      usePurchasableFallback: false,
      allowExternalSeed: false,
    });

    assert.ok(Array.isArray(out.searchResults));
    assert.equal(out.searchResults.length, 3);
    assert.ok(maxInFlight >= 2);
    assert.ok(observedParams.length >= 2);
    for (const params of observedParams) {
      assert.equal(params?.query_step_strength, 'strong_goal_family');
      assert.equal(params?.target_step_family, 'serum');
      assert.equal(params?.semantic_family, 'oil_control_treatment');
      assert.equal(params?.product_only, true);
    }
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('__internal: collectRecoCandidatesFromQueryLevels drops explicit non-skincare pollution at beauty boundary', async () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'framework_oily_skin_v1',
    primary_role_id: 'lightweight_moisturizer',
    framework_roles: [
      {
        role_id: 'lightweight_moisturizer',
        rank: 1,
        label: 'Lightweight moisturizer',
        preferred_step: 'moisturizer',
        semantic_family: 'moisturizer',
        query_terms: ['lightweight moisturizer oily skin'],
      },
    ],
    framework_owner_source: 'generic_concern_framework_resolver',
    framework_owner_state: 'trusted',
  };
  const out = await __internal.collectRecoCandidatesFromQueryLevels({
    queryLevels: [
      {
        level_index: 0,
        ladder_level: 'framework_stage_c_support_lightweight_moisturizer',
        queries: [
          {
            query: 'lightweight moisturizer oily skin',
            step: 'moisturizer',
            slot: 'other',
            ladder_level: 'framework_stage_c_support_lightweight_moisturizer',
            role_id: 'lightweight_moisturizer',
            role_rank: 1,
          },
        ],
      },
    ],
    targetContext,
    recommendationTaskContext: null,
    logger: null,
    timeoutMs: 800,
    limit: 6,
    usePurchasableFallback: false,
    allowExternalSeed: false,
    searchFn: async () => ({
      ok: true,
      products: [
        {
          product_id: 'pet_vest_1',
          merchant_id: 'merchant_noise',
          display_name: 'Warm Fall/Winter Padded Winter Vest for Dogs & Cats',
          product_type: 'moisturizer',
        },
        {
          product_id: 'moisturizer_1',
          merchant_id: 'merchant_beauty',
          brand: 'Clear Skin Lab',
          display_name: 'Clear Skin Lab Oil-Free Water Gel Moisturizer',
          product_type: 'moisturizer',
          ingredient_tokens: ['glycerin', 'niacinamide'],
          benefit_tokens: ['oil-free', 'lightweight hydration'],
        },
      ],
    }),
  });

  assert.deepEqual(
    out.rawCandidates.map((item) => item.product_id),
    ['moisturizer_1'],
  );
  assert.deepEqual(
    out.boundaryRejects.map((entry) => entry.product.product_id),
    ['pet_vest_1'],
  );
  assert.equal(out.boundaryRejects[0].reason, 'explicit_non_skincare');
  assert.equal(out.candidateState.raw_candidate_count, 1);
  assert.equal(
    (out.candidateState.hard_reject || []).some((entry) => entry?.product?.product_id === 'pet_vest_1'),
    false,
  );
});

test('__internal: collectRecoCandidatesFromQueryLevels clamps per-query timeout by deadline', async () => {
  const { __internal } = loadRoutesFresh();
  const observed = [];
  const targetContext = {
    framework_id: 'framework_oily_skin_v1',
    primary_role_id: 'oil_control_treatment',
    framework_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
      },
    ],
    framework_owner_source: 'generic_concern_framework_resolver',
    framework_owner_state: 'trusted',
  };
  const queryLevels = [
    {
      level_index: 0,
      ladder_level: 'framework_oil_control_treatment',
      queries: [
        { query: 'oil control serum', step: 'treatment', slot: 'other', ladder_level: 'framework_oil_control_treatment', role_id: 'oil_control_treatment' },
        { query: 'shine control serum', step: 'treatment', slot: 'other', ladder_level: 'framework_oil_control_treatment', role_id: 'oil_control_treatment' },
      ],
    },
  ];

  const out = await __internal.collectRecoCandidatesFromQueryLevels({
    queryLevels,
    targetContext,
    recommendationTaskContext: null,
    logger: null,
    timeoutMs: 800,
    deadlineMs: Date.now() + 360,
    limit: 6,
    usePurchasableFallback: false,
    allowExternalSeed: false,
    searchFn: async (args) => {
      observed.push({
        timeoutMs: Number(args?.timeoutMs || 0),
        deadlineMs: Number(args?.deadlineMs || 0),
      });
      return {
        ok: true,
        products: [],
        reason: 'empty',
      };
    },
  });

  assert.equal(Array.isArray(out.searchResults), true);
  assert.equal(observed.length, 2);
  for (const row of observed) {
    assert.ok(row.timeoutMs > 0);
    assert.ok(row.timeoutMs < 800);
    assert.ok(row.timeoutMs <= 360);
    assert.ok(row.deadlineMs > 0);
  }
});

test('__internal: collectRecoCandidatesFromQueryLevels hard-stops wall clock when search hangs', async () => {
  const { __internal } = loadRoutesFresh();
  const targetContext = {
    framework_id: 'framework_oily_skin_v1',
    primary_role_id: 'oil_control_treatment',
    framework_roles: [
      {
        role_id: 'oil_control_treatment',
        rank: 1,
        preferred_step: 'treatment',
      },
    ],
    framework_owner_source: 'generic_concern_framework_resolver',
    framework_owner_state: 'trusted',
  };
  const queryLevels = [
    {
      level_index: 0,
      ladder_level: 'framework_oil_control_treatment',
      queries: [
        { query: 'oil control serum', step: 'treatment', slot: 'other', ladder_level: 'framework_oil_control_treatment', role_id: 'oil_control_treatment' },
        { query: 'shine control serum', step: 'treatment', slot: 'other', ladder_level: 'framework_oil_control_treatment', role_id: 'oil_control_treatment' },
      ],
    },
  ];
  const startedAt = Date.now();

  const out = await __internal.collectRecoCandidatesFromQueryLevels({
    queryLevels,
    targetContext,
    recommendationTaskContext: null,
    logger: null,
    timeoutMs: 50,
    limit: 6,
    usePurchasableFallback: false,
    allowExternalSeed: false,
    searchFn: async () => new Promise(() => {}),
  });

  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(Array.isArray(out.searchResults), true);
  assert.equal(out.searchResults.length, 2);
  for (const row of out.searchResults) {
    assert.equal(row.reason, 'upstream_timeout');
    assert.equal(row.timeout_guard, 'caller_wall_clock');
    assert.deepEqual(row.products, []);
  }
});

test('__internal: collectRecoCandidatesFromQueryLevels caps support external seed timeout below stage wall clock budget', async () => {
  const originalSupportTimeout = process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_EXTERNAL_SEED_QUERY_TIMEOUT_MS;
  process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_EXTERNAL_SEED_QUERY_TIMEOUT_MS = '80';
  try {
    const { __internal } = loadRoutesFresh();
    const observedTimeouts = [];
    const targetContext = {
      framework_id: 'framework_oily_skin_v1',
      primary_role_id: 'oil_control_treatment',
      framework_roles: [
        {
          role_id: 'oil_control_treatment',
          rank: 1,
          preferred_step: 'treatment',
        },
        {
          role_id: 'lightweight_moisturizer',
          rank: 2,
          preferred_step: 'moisturizer',
        },
      ],
      framework_owner_source: 'generic_concern_framework_resolver',
      framework_owner_state: 'trusted',
    };
    const queryLevels = [
      {
        level_index: 0,
        ladder_level: 'framework_stage_c_support_lightweight_moisturizer_external_seed',
        queries: [
          {
            query: 'lightweight moisturizer oily skin',
            step: 'moisturizer',
            slot: 'moisturizer',
            ladder_level: 'framework_stage_c_support_lightweight_moisturizer_external_seed',
            role_id: 'lightweight_moisturizer',
            role_rank: 2,
            preferred_step: 'moisturizer',
            allow_external_seed: true,
            allow_pending_primary_external: true,
            external_seed_strategy: 'stage_planned',
          },
        ],
      },
    ];

    const out = await __internal.collectRecoCandidatesFromQueryLevels({
      queryLevels,
      targetContext,
      recommendationTaskContext: null,
      logger: null,
      timeoutMs: 5000,
      limit: 6,
      usePurchasableFallback: false,
      allowExternalSeed: true,
      searchFn: async (args = {}) => {
        observedTimeouts.push(Number(args?.timeoutMs || 0));
        return new Promise(() => {});
      },
    });

    assert.equal(observedTimeouts.length, 1);
    assert.ok(observedTimeouts[0] > 0);
    assert.ok(observedTimeouts[0] <= 80);
    assert.equal(out.searchResults[0]?.reason, 'upstream_timeout');
    assert.equal(out.searchResults[0]?.timeout_guard, 'caller_wall_clock');
  } finally {
    if (originalSupportTimeout == null) delete process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_EXTERNAL_SEED_QUERY_TIMEOUT_MS;
    else process.env.AURORA_BFF_RECO_CATALOG_SUPPORT_EXTERNAL_SEED_QUERY_TIMEOUT_MS = originalSupportTimeout;
    loadRoutesFresh();
  }
});

staleFallbackPlannerTest('/v1/chat: profile-driven beauty-owned reco chip without explicit ask clean fail-closes before legacy planner', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    const isGoalDriven =
      query.includes('salicylic')
      || query.includes('acne')
      || query.includes('niacinamide')
      || query.includes('vitamin c')
      || query.includes('dark spots');
    return {
      status: 200,
      data: {
        products: isGoalDriven
          ? [
              {
                product_id: `goal_${observedQueries.length}`,
                merchant_id: 'mid_goal',
                brand: 'GoalSkin',
                name: query.includes('salicylic') ? 'Clarifying BHA Serum' : 'Brightening Niacinamide Serum',
                display_name: query.includes('salicylic') ? 'Clarifying BHA Serum' : 'Brightening Niacinamide Serum',
                category: 'skincare',
                product_type: 'serum',
                ingredient_tokens: query.includes('salicylic')
                  ? ['salicylic acid', 'niacinamide']
                  : ['niacinamide', 'vitamin c'],
              },
            ]
          : [],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_goal_driven_uid',
        'X-Trace-ID': 'trace_chat_goal_driven',
        'X-Brief-ID': 'chat_goal_driven_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products for my goals',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'healthy',
              goals: ['acne', 'dark_spots'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceNotice = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.ok(confidenceNotice);
    assert.equal(
      String(confidenceNotice?.payload?.reason || ''),
      'upstream_empty_recommendations',
    );
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: stored-profile beauty-owned reco chip without explicit ask clean fail-closes before legacy planner', async () => {
  const originalGet = axios.get;
  const observedQueries = [];

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    const isGoalDriven =
      query.includes('salicylic')
      || query.includes('acne')
      || query.includes('niacinamide')
      || query.includes('vitamin c')
      || query.includes('dark spots');
    return {
      status: 200,
      data: {
        products: isGoalDriven
          ? [
              {
                product_id: `goal_recovery_${observedQueries.length}`,
                merchant_id: 'mid_goal_recovery',
                brand: 'GoalSkin',
                name: query.includes('salicylic') ? 'Clarifying BHA Serum' : 'Brightening Niacinamide Serum',
                display_name: query.includes('salicylic') ? 'Clarifying BHA Serum' : 'Brightening Niacinamide Serum',
                category: 'skincare',
                product_type: 'serum',
                ingredient_tokens: query.includes('salicylic')
                  ? ['salicylic acid', 'niacinamide']
                  : ['niacinamide', 'vitamin c'],
              },
            ]
          : [],
      },
    };
  };

  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"invalid reco envelope"}',
      structured: { summary: 'invalid reco envelope' },
      context: {},
    }),
  });
  try {
    await seedCompleteProfile(harness.request, 'chat_goal_profile_only_uid', 'EN', {
      goals: ['acne', 'dark_spots'],
      budgetTier: '$50',
      region: 'US',
    });

    const response = await harness.request
      .post('/v1/chat')
      .set(headersFor('chat_goal_profile_only_uid', 'EN'))
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
            include_alternatives: false,
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'S2_DIAGNOSIS' },
        language: 'EN',
      })
      .expect(200);

    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceNotice = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.ok(confidenceNotice);
    assert.equal(
      String(confidenceNotice?.payload?.reason || ''),
      'upstream_empty_recommendations',
    );
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: contextual generic reco auto-anchors latest analysis context and returns grounded_success', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: `ctx_${observedQueries.length}`,
            merchant_id: 'mid_ctx',
            brand: 'BarrierLab',
            name: 'Barrier Repair Cream',
            display_name: 'Barrier Repair Cream',
            category: 'skincare',
            product_type: 'moisturizer',
            ingredient_tokens: ['ceramide', 'panthenol'],
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_contextual_reco_uid', briefId: 'chat_contextual_reco_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_contextual_reco_uid',
        'X-Trace-ID': 'trace_chat_contextual_reco',
        'X-Brief-ID': 'chat_contextual_reco_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              context_origin: 'routine_audit_v1',
              goal: 'barrier repair',
              ingredient_query: 'ceramide',
              resolved_target_step: 'moisturizer',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'analysis_adjustment',
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.notEqual(String(payload.recommendation_meta?.source_mode || ''), 'artifact_matcher');
    assert.equal(payload.recommendation_meta?.resolved_target_step, 'moisturizer');
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'grounded_success');
    assert.notEqual(String(recoEvent?.data?.source_mode || ''), 'artifact_matcher');
    assert.equal(recoEvent?.data?.telemetry_reason || null, null);
    assert.ok(observedQueries.some((query) => query.includes('moisturizer')));
    assert.ok(observedQueries.some((query) => query.includes('ceramide') || query.includes('barrier repair')));
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: prompt contract mismatch blocks step-aware mainline recommendations', async () => {
  const originalGet = axios.get;
  const originalPromptMismatch = process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH;
  process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH = 'true';
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'cream_degraded_1',
            merchant_id: 'mid_cream',
            brand: 'GoodSkin',
            name: 'Barrier Repair Cream',
            display_name: 'Barrier Repair Cream',
            category: 'face cream',
            product_type: 'cream',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'reco_degraded_uid', briefId: 'reco_degraded_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_degraded_uid',
        'X-Trace-ID': 'trace_reco_degraded',
        'X-Brief-ID': 'reco_degraded_brief',
      },
      body: {
        focus: 'moisturizer',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.equal(payload.recommendations[0]?.product_id, 'cream_degraded_1');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.non_blocking_llm_issue, 'prompt_contract_mismatch');
    assert.equal(payload.recommendation_meta?.presentation_mode, 'deterministic_degraded');
    assert.equal(payload.recommendation_meta?.success_mode, 'degraded_success');
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const promptMismatchConfidenceCard = cards.find(
      (card) =>
        card &&
        card.type === 'confidence_notice' &&
        String(card?.payload?.reason || '').trim().toLowerCase() === 'prompt_contract_mismatch',
    ) || null;
    assert.equal(promptMismatchConfidenceCard, null);
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.equal(recoEvent?.data?.mainline_status, 'grounded_success');
    assert.notEqual(recoEvent?.data?.effective_failure_class, 'prompt_contract_mismatch');
  } finally {
    if (originalPromptMismatch == null) delete process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH;
    else process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH = originalPromptMismatch;
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: framework weak pool with a valid primary product still returns recommendations', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  let harness = null;
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    if (query.includes('oil control') || query.includes('niacinamide')) {
      return {
        status: 200,
        data: {
          metadata: {
            search_decision: {
              contract_version: 'beauty_search_decision_v4',
              hit_quality: 'valid_hit',
              query_bucket: 'skincare',
              query_target_step_family: 'treatment',
              same_family_topk_count: 1,
              exact_step_topk_count: 1,
              raw_result_count: 1,
              products_returned_count: 1,
            },
          },
          products: [
            {
              product_id: 'serum_weak_pool_1',
              merchant_id: 'merchant_weak_pool_serum',
              brand: 'Clear Lab',
              name: 'Oil Balance Serum',
              display_name: 'Oil Balance Serum',
              category: 'skincare',
              product_type: 'serum',
              ingredient_tokens: ['niacinamide', 'zinc'],
              benefit_tags: ['oil control', 'shine control'],
              search_aliases: ['Oil Control Serum'],
              short_description: 'A mattifying oil-control serum for oily skin.',
            },
          ],
        },
      };
    }
    return { status: 200, data: { products: [] } };
  };

  try {
    harness = createAppWithPatchedAuroraChat({
      auroraChatImpl: buildConcernPlannerMock(),
      geminiTextImpl: buildConcernPlannerGeminiTextMock({
        plainText: buildConcernPlannerTextFixture(),
      }),
      useMemoryStore: false,
    });
    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_weak_uid', briefId: 'chat_framework_weak_brief' });
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_framework_weak_uid',
        'X-Trace-ID': 'trace_chat_framework_weak',
        'X-Brief-ID': 'chat_framework_weak_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin, what product should i use?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        message: 'im oily skin, what product should i use?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.equal(payload.recommendations[0]?.product_id, 'serum_weak_pool_1');
    assert.equal(payload.recommendation_meta?.framework_owner_state, 'trusted');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.ok(observedQueries.some((query) => query.includes('oil control')));
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.equal(confidenceCard, null);
  } finally {
    harness?.restore?.();
    axios.get = originalGet;
  }
});

test('/v1/chat: step-aware sunscreen ask stays on beauty mainline handoff instead of reviving axios soft-mismatch fallback', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"empty structured reco"}',
      structured: {
        recommendations: [],
        confidence: null,
        warnings: ['upstream_missing_or_empty'],
      },
      context: {},
    }),
  });

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    const allowExternalSeed = config?.params?.allow_external_seed === true;
    observedQueries.push({ query, allowExternalSeed });
    if (allowExternalSeed && (query.includes('sunscreen') || query.includes('spf'))) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'ext_spf_soft_1',
              merchant_id: 'merchant_ext_spf_soft',
              brand: 'Face Theory',
              name: 'Daily Balance Face Lotion',
              display_name: 'Daily Balance Face Lotion',
              category: 'external',
              product_type: 'external',
              source: 'external_seed',
              url: 'https://example.com/daily-balance-face-lotion',
              short_description: 'A lightweight face lotion for oily skin.',
              tag_tokens: ['face lotion', 'oil control'],
              search_aliases: ['daily face lotion'],
            },
          ],
        },
      };
    }
    return { status: 200, data: { products: [] } };
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_step_soft_uid',
        'X-Trace-ID': 'trace_chat_step_soft',
        'X-Brief-ID': 'chat_step_soft_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'what sunscreen should i use for oily skin?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['sun protection', 'oil control'],
            },
          },
        },
        message: 'what sunscreen should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    assert.match(String(response.body?.assistant_text || ''), /not showing product picks|不展示商品推荐/i);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.ok(confidenceCard);
    assert.ok(
      ['no_recall_from_planned_sources', 'planner_untrusted'].includes(
        String(confidenceCard?.payload?.reason || ''),
      ),
    );
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.equal(recoEvent?.data?.source, 'beauty_mainline_handoff');
    assert.equal(recoEvent?.data?.source_detail, 'beauty_mainline_handoff');
    assert.ok(
      ['beauty_mainline_handoff_empty', 'beauty_mainline_planner_blocked'].includes(
        String(recoEvent?.data?.fallback_reason || ''),
      ),
    );
    assert.equal(observedQueries.length, 0);
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: step-aware typed reco hands off to shopping beauty mainline when aurora planner returns empty', async () => {
  const originalGet = axios.get;
  const observedCalls = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"empty structured reco"}',
      structured: {
        recommendations: [],
        confidence: null,
        warnings: ['upstream_missing_or_empty'],
      },
      context: {},
    }),
  });

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    const semanticContract = (() => {
      try {
        return JSON.parse(String(config?.params?.semantic_contract || '{}'));
      } catch (_err) {
        return null;
      }
    })();
    observedCalls.push({
      query,
      semanticContractOwner: String(semanticContract?.owner || ''),
      semanticContractTargetStep: String(semanticContract?.target_step_family || ''),
      queryStepStrength: String(config?.params?.query_step_strength || ''),
      targetStepFamily: String(config?.params?.target_step_family || ''),
      semanticFamily: String(config?.params?.semantic_family || ''),
      catalogSurface: String(config?.params?.catalog_surface || ''),
      fastMode: config?.params?.fast_mode,
      timeoutMs: Number(config?.timeout || 0),
      forwardedAgentApiKey: String(config?.headers?.['X-Agent-API-Key'] || ''),
      forwardedAuthorization: String(config?.headers?.Authorization || ''),
    });
    if (
      query === 'what sunscreen should i use for oily skin?'
      && String(config?.params?.catalog_surface || '') === 'beauty'
    ) {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'ext_spf_bridge_1',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Ultra Light Liquid Mineral Sunscreen SPF 30',
              display_name: 'Ultra Light Liquid Mineral Sunscreen SPF 30',
              category: 'external',
              product_type: 'external',
              source: 'external_seed',
              url: 'https://example.com/ultra-light-spf-30',
              short_description: 'A lightweight sunscreen for oily skin.',
            },
          ],
          metadata: {
            query_source: 'agent_products_search',
            decision_owner: 'shopping_agent_beauty_mainline',
            final_decision: 'products_returned',
          },
        },
      };
    }
    return { status: 200, data: { products: [] } };
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_step_bridge_uid',
        'X-Trace-ID': 'trace_chat_step_bridge',
        'X-Brief-ID': 'chat_step_bridge_brief',
        'X-Agent-API-Key': 'ak_live_bridge_test',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'what sunscreen should i use for oily skin?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['sun protection', 'oil control'],
            },
          },
        },
        message: 'what sunscreen should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 1);
    assert.equal(payload.recommendations[0]?.product_id, 'ext_spf_bridge_1');
    assert.equal(payload.recommendation_meta?.beauty_mainline_handoff_applied, true);
    assert.equal(payload.recommendation_meta?.beauty_mainline_handoff_attempted, true);
    assert.equal(payload.recommendation_meta?.beauty_mainline_handoff_owner, 'shopping_agent_beauty_mainline');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.ok(Array.isArray(payload.recommendation_meta?.beauty_mainline_handoff_attempts));
    assert.equal(payload.recommendation_meta.beauty_mainline_handoff_attempts.length, 1);
    assert.equal(payload.recommendation_meta?.beauty_mainline_handoff_applied_query, 'what sunscreen should i use for oily skin?');
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.equal(confidenceCard, null);
    assert.ok(
      observedCalls.some((entry) =>
        entry.query === 'what sunscreen should i use for oily skin?'
        && entry.semanticContractOwner === 'aurora_reco_planner'
        && entry.semanticContractTargetStep === 'sunscreen'
        && entry.queryStepStrength === 'exact_step'
        && entry.targetStepFamily === 'sunscreen'
        && entry.semanticFamily === 'sunscreen'
        && entry.catalogSurface === 'beauty'
        && entry.fastMode === undefined
        && entry.timeoutMs >= 5000
        && entry.forwardedAgentApiKey === 'ak_live_bridge_test'
        && entry.forwardedAuthorization === 'Bearer ak_live_bridge_test'),
      JSON.stringify(observedCalls),
    );
    assert.equal(observedCalls.some((entry) => entry.query === 'daily sunscreen'), false);
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: generic concern beauty mainline handoff uses raw ask and still returns products', async () => {
  const originalGet = axios.get;
  const observedCalls = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"empty structured reco"}',
      structured: {
        recommendations: [],
        confidence: null,
        warnings: ['upstream_missing_or_empty'],
      },
      context: {},
    }),
  });

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    const semanticContract = (() => {
      try {
        return JSON.parse(String(config?.params?.semantic_contract || '{}'));
      } catch (_err) {
        return null;
      }
    })();
    observedCalls.push({
      query,
      semanticContractOwner: String(semanticContract?.owner || ''),
      semanticContractTargetStep: String(semanticContract?.target_step_family || ''),
      semanticContractPrimaryRole: String(semanticContract?.primary_role_id || ''),
      queryStepStrength: String(config?.params?.query_step_strength || ''),
      targetStepFamily: String(config?.params?.target_step_family || ''),
      semanticFamily: String(config?.params?.semantic_family || ''),
    });
    if (query === 'what products should i use for oily skin?') {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'generic_bridge_1',
              merchant_id: 'external_seed',
              brand: 'GoalSkin',
              name: 'Oil Control Serum',
              display_name: 'Oil Control Serum',
              category: 'skincare',
              product_type: 'serum',
              source: 'external_seed',
              url: 'https://example.com/oil-control-serum',
              short_description: 'A lightweight serum for oily skin.',
              ingredient_tokens: ['niacinamide', 'zinc pca'],
            },
            {
              product_id: 'generic_wrong_body',
              merchant_id: 'external_seed',
              brand: 'BodyBrand',
              name: 'After-Shower Nourishing Body Oil',
              display_name: 'After-Shower Nourishing Body Oil',
              category: 'body oil',
              product_type: 'body oil',
              source: 'external_seed',
              url: 'https://example.com/body-oil',
              short_description: 'A nourishing oil for body care.',
            },
            {
              product_id: 'generic_wrong_lip',
              merchant_id: 'external_seed',
              brand: 'LipBrand',
              name: 'Peptide Lip Treatment',
              display_name: 'Peptide Lip Treatment',
              category: 'lip treatment',
              product_type: 'lip treatment',
              source: 'external_seed',
              url: 'https://example.com/lip-treatment',
              short_description: 'A peptide treatment for lips.',
            },
          ],
          metadata: {
            query_source: 'agent_products_search',
            decision_owner: 'shopping_agent_beauty_mainline',
            final_decision: 'products_returned',
          },
        },
      };
    }
    return { status: 200, data: { products: [] } };
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_generic_bridge_uid',
        'X-Trace-ID': 'trace_chat_generic_bridge',
        'X-Brief-ID': 'chat_generic_bridge_brief',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'what products should i use for oily skin?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['oil control'],
            },
          },
        },
        message: 'what products should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 1);
    assert.equal(payload.recommendations[0]?.product_id, 'generic_bridge_1');
    assert.equal(payload.recommendation_meta?.beauty_mainline_handoff_applied, true);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.ok(Array.isArray(payload.recommendation_meta?.beauty_mainline_handoff_attempts));
    assert.ok(
      payload.recommendation_meta.beauty_mainline_handoff_attempts.some((entry) => String(entry?.query || '').trim().toLowerCase() === 'what products should i use for oily skin?'),
      JSON.stringify(payload.recommendation_meta.beauty_mainline_handoff_attempts),
    );
    assert.equal(payload.recommendation_meta?.beauty_mainline_handoff_applied_query, 'what products should i use for oily skin?');
    assert.ok(
      observedCalls.some((entry) =>
        entry.query === 'what products should i use for oily skin?'
        && entry.semanticContractOwner === 'aurora_reco_planner'
        && entry.semanticContractTargetStep === 'treatment'
        && entry.semanticContractPrimaryRole === 'oil_control_treatment'),
        JSON.stringify(observedCalls),
    );
    assert.ok(
      observedCalls.some((entry) =>
        entry.query === 'what products should i use for oily skin?'
        && entry.queryStepStrength === 'strong_goal_family'
        && entry.targetStepFamily === 'treatment'
        && entry.semanticFamily === 'oil_control'),
      JSON.stringify(observedCalls),
    );
    assert.equal(observedCalls.some((entry) => entry.query === 'oil control serum'), false);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.equal(confidenceCard, null);
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

test('/v1/chat: plain-text beauty reco ask uses the same beauty mainline handoff without action chips', { concurrency: false }, async () => {
  const observedCalls = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"empty structured reco"}',
      structured: {
        recommendations: [],
        confidence: null,
        warnings: ['upstream_missing_or_empty'],
      },
      context: {},
    }),
  });
  harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
    maybeHandleBeautyOwnedChatReco: async ({ ctx, logger, message, profile }) => {
      const targetContext = {
        step_aware_intent: true,
        resolved_target_step: 'treatment',
        resolved_target_step_confidence: 'high',
        resolved_target_step_source: 'text_explicit',
        intent_mode: 'step_aware',
      };
      const searchResult = {
        products: [
          {
            product_id: 'generic_plain_text_1',
            merchant_id: 'external_seed',
            brand: 'GoalSkin',
            name: 'Oil Control Serum',
            display_name: 'Oil Control Serum',
            category: 'skincare',
            product_type: 'serum',
            source: 'external_seed',
            url: 'https://example.com/oil-control-serum',
            short_description: 'A lightweight serum for oily skin.',
            ingredient_tokens: ['niacinamide', 'zinc pca'],
          },
          {
            product_id: 'generic_plain_text_wrong_body',
            merchant_id: 'external_seed',
            brand: 'BodyBrand',
            name: 'After-Shower Nourishing Body Oil',
            display_name: 'After-Shower Nourishing Body Oil',
            category: 'body oil',
            product_type: 'body oil',
            source: 'external_seed',
            url: 'https://example.com/body-oil',
            short_description: 'A nourishing oil for body care.',
          },
        ],
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        metadata: {
          query_source: 'agent_products_search',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          final_decision: 'products_returned',
          contract_bridge: {
            attempted_contract: 'agent_v1_search_beauty_mainline',
            resolved_contract: 'agent_v1_search_beauty_mainline',
          },
          source_breakdown: {
            source_tier_counts: { fresh_external: 2 },
            top_candidate_provenance: { source_owner: 'external_seed' },
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['generic_plain_text_1'],
              selected_titles: ['GoalSkin Oil Control Serum'],
              selection_signature: 'search_sel_plain_text_test',
              mainline_status: 'grounded_success',
              source_tier_counts: { fresh_external: 2 },
              top_candidate_provenance: { source_owner: 'external_seed' },
            },
          },
        },
      };
      const handoff = await harness.routesMod.__internal.handoffRecoToBeautyMainlineSearch({
        ctx,
        logger,
        primaryQuery: message,
        fallbackMessage: message,
        targetContext,
        profileSummary: profile,
        fallbackFocus: 'treatment',
        searchFn: async (params) => {
          const semanticContract = params?.semanticContract || null;
          observedCalls.push({
            query: String(params?.query || '').trim().toLowerCase(),
            semanticContractOwner: String(semanticContract?.owner || ''),
            semanticContractTargetStep: String(semanticContract?.target_step_family || ''),
            semanticContractPrimaryRole: String(semanticContract?.primary_role_id || ''),
            queryStepStrength: String(params?.queryStepStrength || ''),
            targetStepFamily: String(params?.targetStepFamily || ''),
            semanticFamily: String(params?.semanticFamily || ''),
          });
          return searchResult;
        },
      });
      const bundle = harness.routesMod.__internal.buildRecoPayloadFromBeautyMainlineHandoff({
        handoff,
        profile,
        targetContext,
        recoContext: {
          resolved_target_step: 'treatment',
          ingredient_query: 'oil control',
        },
        taskMode: 'goal_based_products',
        triggerSource: 'typed_reco',
        sourceMode: 'step_aware_mainline',
        basePayload: {
          recommendation_confidence_score: 0.61,
          recommendation_confidence_level: 'medium',
          recommendation_meta: {
            used_recent_logs: false,
            used_safety_flags: false,
          },
        },
        selectionOwner: 'shopping_agent_beauty_mainline',
        entryType: 'chat',
      });
      const payload = bundle?.payload;
      const assistantText = harness.routesMod.__internal.buildRouteAwareAssistantText({
        route: 'reco',
        payload,
        language: ctx?.lang,
        profile,
      });
      return {
        handled: true,
        targetContext,
        envelope: {
          assistant_text: assistantText,
          assistant_message: {
            role: 'assistant',
            format: 'text',
            content: assistantText,
          },
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload,
            },
          ],
          suggested_chips: [],
          session_patch: {},
          events: [],
        },
      };
    },
  });

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_plain_text_bridge_uid',
        'X-Trace-ID': 'trace_chat_plain_text_bridge',
        'X-Brief-ID': 'chat_plain_text_bridge_brief',
      })
      .send({
        message: 'what products should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length === 1);
    assert.equal(payload.recommendations[0]?.product_id, 'generic_plain_text_1');
    assert.equal(payload?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.metadata?.mainline_status, 'grounded_success');
    assert.equal(payload.metadata?.contract_bridge?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.equal(payload.recommendation_meta?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.equal(payload.metadata?.beauty_mainline_handoff_applied, undefined);
    assert.equal(payload.metadata?.beauty_mainline_handoff_attempted, undefined);
    assert.deepEqual(
      payload.recommendation_meta?.final_selection?.selected_product_ids,
      ['generic_plain_text_1'],
    );
    assert.deepEqual(
      payload.metadata?.search_stage_ledger?.final_selection?.selected_product_ids,
      ['generic_plain_text_1'],
    );
    assert.deepEqual(
      payload.metadata?.source_breakdown?.source_tier_counts,
      { fresh_external: 2 },
    );
    assert.equal(
      payload.recommendation_meta?.assistant_text_selection_signature,
      payload.recommendation_meta?.final_selection?.selection_signature,
    );
    assert.match(String(response.body?.assistant_text || ''), /Products actually selected this time: GoalSkin Oil Control Serum\./i);
    assert.doesNotMatch(String(response.body?.assistant_text || ''), /Top pick for that first role|Priority order:|care framework/i);
    assert.ok(
      observedCalls.some((entry) =>
        entry.query === 'what products should i use for oily skin?'
        && entry.semanticContractOwner === 'aurora_reco_planner'
        && entry.semanticContractTargetStep === 'treatment'
        && entry.semanticContractPrimaryRole === 'oil_control_treatment'),
      JSON.stringify(observedCalls),
    );
    assert.ok(
      observedCalls.some((entry) =>
        entry.query === 'what products should i use for oily skin?'
        && entry.queryStepStrength === 'strong_goal_family'
        && entry.targetStepFamily === 'treatment'
        && entry.semanticFamily === 'oil_control'),
      JSON.stringify(observedCalls),
    );
    assert.equal(observedCalls.some((entry) => entry.query === 'oil control serum'), false);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    assert.equal(cards.some((card) => card && card.type === 'nudge'), false);
    assert.equal(cards.some((card) => card && card.type === 'confidence_notice'), false);
    assert.equal(cards.some((card) => card && card.type === 'recommendations'), true);
    assert.match(String(response.body?.assistant_message?.content || ''), /Oil Control Serum/i);
    assert.doesNotMatch(String(response.body?.assistant_message?.content || ''), /Body Oil/i);
  } finally {
    harness.routesMod.__internal.__resetRouteDependencyOverridesForTest();
    harness.restore();
  }
});

test('/v1/chat: typed beauty ownership bypasses legacy recommendationsAllowed gate and still short-circuits to canonical handoff', { concurrency: false }, async () => {
  const gatingModulePath = require.resolve('../src/auroraBff/gating');
  delete require.cache[gatingModulePath];
  const gating = require(gatingModulePath);
  const originalRecommendationsAllowed = gating.recommendationsAllowed;
  const observedCalls = [];
  let auroraChatCallCount = 0;
  let legacyRouteEntryCallCount = 0;
  gating.recommendationsAllowed = () => false;
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_serum',
              display_name: 'Legacy Wrong Serum',
            },
          ],
        },
        context: {},
      };
    },
  });
  harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
    maybeHandleBeautyOwnedChatReco: async ({ ctx, logger, message, profile }) => {
      const targetContext = {
        step_aware_intent: true,
        resolved_target_step: 'treatment',
        resolved_target_step_confidence: 'high',
        resolved_target_step_source: 'text_explicit',
        intent_mode: 'step_aware',
      };
      const searchResult = {
        products: [
          {
            product_id: 'typed_gate_bypass_1',
            merchant_id: 'mid_internal',
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            display_name: 'Niacinamide 10% + Zinc 1%',
            category: 'serum',
            product_type: 'serum',
            source: 'internal_search',
          },
        ],
        decision_owner: 'shopping_agent_beauty_mainline',
        semantic_owner: 'shopping_agent_beauty_mainline',
        metadata: {
          query_source: 'agent_products_search',
          decision_owner: 'shopping_agent_beauty_mainline',
          semantic_owner: 'shopping_agent_beauty_mainline',
          final_decision: 'products_returned',
          contract_bridge: {
            attempted_contract: 'agent_v1_search_beauty_mainline',
            resolved_contract: 'agent_v1_search_beauty_mainline',
          },
          source_breakdown: {
            source_tier_counts: { fresh_internal: 1 },
            top_candidate_provenance: { source_owner: 'internal_search' },
          },
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['typed_gate_bypass_1'],
              selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
              selection_signature: 'typed_gate_bypass_sig',
              mainline_status: 'grounded_success',
              source_tier_counts: { fresh_internal: 1 },
              top_candidate_provenance: { source_owner: 'internal_search' },
            },
          },
        },
      };
      const handoff = await harness.routesMod.__internal.handoffRecoToBeautyMainlineSearch({
        ctx,
        logger,
        primaryQuery: message,
        fallbackMessage: message,
        targetContext,
        profileSummary: profile,
        fallbackFocus: 'treatment',
        searchFn: async (params) => {
          observedCalls.push(String(params?.query || '').trim().toLowerCase());
          return searchResult;
        },
      });
      const bundle = harness.routesMod.__internal.buildRecoPayloadFromBeautyMainlineHandoff({
        handoff,
        profile,
        targetContext,
        recoContext: {
          resolved_target_step: 'treatment',
          ingredient_query: 'oil control',
        },
        taskMode: 'goal_based_products',
        triggerSource: 'typed_reco',
        sourceMode: 'step_aware_mainline',
        basePayload: {
          recommendation_confidence_score: 0.61,
          recommendation_confidence_level: 'medium',
          recommendation_meta: {
            used_recent_logs: false,
            used_safety_flags: false,
          },
        },
        selectionOwner: 'shopping_agent_beauty_mainline',
        entryType: 'chat',
      });
      const payload = bundle?.payload;
      const assistantText = harness.routesMod.__internal.buildRouteAwareAssistantText({
        route: 'reco',
        payload,
        language: ctx?.lang,
        profile,
      });
      return {
        handled: true,
        targetContext,
        envelope: {
          assistant_text: assistantText,
          assistant_message: {
            role: 'assistant',
            format: 'text',
            content: assistantText,
          },
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload,
            },
          ],
          suggested_chips: [],
          session_patch: {},
          events: [],
        },
      };
    },
    maybeHandleLegacyChatRecoRouteEntry: async () => {
      legacyRouteEntryCallCount += 1;
      throw new Error('legacy route entry should not run on beauty-owned success path');
    },
  });

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_plain_text_gate_bypass_uid',
        'X-Trace-ID': 'trace_chat_plain_text_gate_bypass',
        'X-Brief-ID': 'chat_plain_text_gate_bypass_brief',
      })
      .send({
        message: 'what products should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.deepEqual(
      Array.isArray(payload.recommendations) ? payload.recommendations.map((row) => row?.product_id) : [],
      ['typed_gate_bypass_1'],
    );
    assert.equal(payload.recommendation_meta?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.deepEqual(payload.recommendation_meta?.source_tier_counts, { fresh_internal: 1 });
    assert.equal(auroraChatCallCount, 0);
    assert.equal(legacyRouteEntryCallCount, 0);
    assert.ok(observedCalls.includes('what products should i use for oily skin?'));
  } finally {
    harness.routesMod.__internal.__resetRouteDependencyOverridesForTest();
    gating.recommendationsAllowed = originalRecommendationsAllowed;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: beauty-owned hard path fails closed when beauty mainline handoff times out', { concurrency: false }, async () => {
  const originalGet = axios.get;
  let auroraChatCallCount = 0;
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run after handoff timeout"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_timeout_path',
              display_name: 'Legacy Wrong Timeout Path',
            },
          ],
        },
        context: {},
      };
    },
  });

  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const err = new Error('beauty mainline handoff timeout');
    err.code = 'ECONNABORTED';
    throw err;
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_plain_text_handoff_timeout_uid',
        'X-Trace-ID': 'trace_chat_plain_text_handoff_timeout',
        'X-Brief-ID': 'chat_plain_text_handoff_timeout_brief',
      })
      .send({
        message: 'what products should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    assert.equal(auroraChatCallCount, 0);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.ok(confidenceCard);
    assert.ok(
      ['upstream_timeout_primary_role', 'upstream_empty_recommendations', 'planner_untrusted'].includes(
        String(confidenceCard?.payload?.reason || ''),
      ),
    );
    assert.match(
      String(response.body?.assistant_message?.content || ''),
      /not showing product picks|不展示商品推荐|retry shortly|稍后重试/i,
    );
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

test('/v1/chat: beauty-owned hard path fails closed when handoff products lack canonical authority', { concurrency: false }, async () => {
  const originalGet = axios.get;
  let auroraChatCallCount = 0;
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run after non-canonical handoff"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_non_canonical_path',
              display_name: 'Legacy Wrong Non Canonical Path',
            },
          ],
        },
        context: {},
      };
    },
  });

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query !== 'what products should i use for oily skin?') {
      return { status: 200, data: { products: [] } };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'niacinamide_1',
            merchant_id: 'mid_internal',
            brand: 'The Ordinary',
            name: 'Niacinamide 10% + Zinc 1%',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            category: 'serum',
            product_type: 'serum',
            source: 'internal_search',
          },
          {
            product_id: 'wrong_serum_2',
            merchant_id: 'mid_external',
            brand: 'Winona',
            name: 'Soothing Repair Serum',
            display_name: 'Winona Soothing Repair Serum',
            category: 'serum',
            product_type: 'serum',
            source: 'external_seed',
          },
        ],
        metadata: {
          query_source: 'agent_products_search',
          search_stage_ledger: {
            final_selection: {
              selection_owner: 'shopping_agent_beauty_mainline',
              selected_product_ids: ['niacinamide_1'],
              selected_titles: ['The Ordinary Niacinamide 10% + Zinc 1%'],
              selection_signature: 'sel_missing_authority',
              mainline_status: 'grounded_success',
            },
          },
        },
      },
    };
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_plain_text_missing_authority_uid',
        'X-Trace-ID': 'trace_chat_plain_text_missing_authority',
        'X-Brief-ID': 'chat_plain_text_missing_authority_brief',
      })
      .send({
        message: 'what products should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    assert.equal(auroraChatCallCount, 0);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.ok(confidenceCard);
    assert.match(
      String(response.body?.assistant_message?.content || ''),
      /not showing product picks|not forcing product picks|不展示商品推荐/i,
    );
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

test('/v1/chat: beauty-owned reco helper miss still fails closed before legacy planner', { concurrency: false }, async () => {
  const originalGet = axios.get;
  let auroraChatCallCount = 0;
  let legacyRouteEntryCallCount = 0;
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run after beauty helper miss"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_after_helper_miss',
              display_name: 'Legacy Wrong After Helper Miss',
            },
          ],
        },
        context: {},
      };
    },
  });

  harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
    maybeHandleBeautyOwnedChatReco: async () => ({
      handled: false,
      targetContext: {
        step_aware_intent: true,
        resolved_target_step: 'treatment',
      },
    }),
    maybeHandleLegacyChatRecoRouteEntry: async () => {
      legacyRouteEntryCallCount += 1;
      throw new Error('legacy route entry should not run after beauty helper miss');
    },
  });

  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    throw new Error('beauty handoff search should not be called after helper override');
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_plain_text_helper_miss_uid',
        'X-Trace-ID': 'trace_chat_plain_text_helper_miss',
        'X-Brief-ID': 'chat_plain_text_helper_miss_brief',
      })
      .send({
        message: 'what products should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    assert.equal(auroraChatCallCount, 0);
    assert.equal(legacyRouteEntryCallCount, 0);
    assert.equal(getRecommendationsPayload(response.body), null);
    const notice = getConfidenceNoticePayload(response.body);
    assert.ok(notice);
    assert.equal(String(notice.reason || ''), 'upstream_empty_recommendations');
    assert.match(
      String(response.body?.assistant_message?.content || ''),
      /not showing product picks|不展示商品推荐/i,
    );
  } finally {
    axios.get = originalGet;
    harness.routesMod.__internal.__resetRouteDependencyOverridesForTest();
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: plain-text sunscreen reco short-circuits to beauty mainline before aurora planner and keeps canonical sunscreen selection', { concurrency: false }, async () => {
  const originalGet = axios.get;
  const originalGetLatestDiagnosisArtifact = diagnosisArtifactStore.getLatestDiagnosisArtifact;
  const observedCalls = [];
  let auroraChatCallCount = 0;
  let latestArtifactLookupCount = 0;
  diagnosisArtifactStore.getLatestDiagnosisArtifact = async (...args) => {
    latestArtifactLookupCount += 1;
    return originalGetLatestDiagnosisArtifact(...args);
  };
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_cleanser',
              display_name: 'Legacy Cleanser',
            },
          ],
        },
        context: {},
      };
    },
  });

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    const semanticContract = (() => {
      try {
        return JSON.parse(String(config?.params?.semantic_contract || '{}'));
      } catch (_err) {
        return null;
      }
    })();
    observedCalls.push({
      query,
      semanticContractOwner: String(semanticContract?.owner || ''),
      semanticContractTargetStep: String(semanticContract?.target_step_family || ''),
      semanticContractPrimaryRole: String(semanticContract?.primary_role_id || ''),
      queryStepStrength: String(config?.params?.query_step_strength || ''),
      targetStepFamily: String(config?.params?.target_step_family || ''),
      semanticFamily: String(config?.params?.semantic_family || ''),
    });
    if (query === 'best sunscreen for oily skin') {
      return {
        status: 200,
        data: {
          products: [
            {
              product_id: 'wrong_cleanser_1',
              merchant_id: 'external_seed',
              brand: 'CleanBrand',
              name: 'Ultra Gentle Cream-to-Foam Face Cleanser Jumbo',
              display_name: 'Ultra Gentle Cream-to-Foam Face Cleanser Jumbo',
              category: 'Cleanser',
              product_type: 'cleanser',
              source: 'external_seed',
            },
            {
              product_id: 'spf_right_1',
              merchant_id: 'external_seed',
              brand: 'First Aid Beauty',
              name: 'Ultra Light Liquid Mineral Sunscreen SPF 30',
              display_name: 'Ultra Light Liquid Mineral Sunscreen SPF 30',
              category: 'Sunscreen',
              product_type: 'sunscreen',
              source: 'external_seed',
            },
            {
              product_id: 'wrong_balm_1',
              merchant_id: 'external_seed',
              brand: 'BalmBrand',
              name: 'Color Balm 3-in-1 Stick - Mocha',
              display_name: 'Color Balm 3-in-1 Stick - Mocha',
              category: 'Makeup',
              product_type: 'color balm',
              source: 'external_seed',
            },
          ],
          metadata: {
            query_source: 'agent_products_search',
            decision_owner: 'shopping_agent_beauty_mainline',
            semantic_owner: 'shopping_agent_beauty_mainline',
            final_decision: 'products_returned',
            contract_bridge: {
              attempted_contract: 'agent_v1_search_beauty_mainline',
              resolved_contract: 'agent_v1_search_beauty_mainline',
            },
            source_breakdown: {
              source_tier_counts: { fresh_external: 3 },
              top_candidate_provenance: { source_owner: 'external_seed' },
            },
            search_stage_ledger: {
              final_selection: {
                selection_owner: 'shopping_agent_beauty_mainline',
                selected_product_ids: ['spf_right_1'],
                selected_titles: ['Ultra Light Liquid Mineral Sunscreen SPF 30'],
                selection_signature: 'search_sel_spf_plain_text_test',
                mainline_status: 'grounded_success',
              },
            },
          },
        },
      };
    }
    return { status: 200, data: { products: [] } };
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_plain_text_spf_uid',
        'X-Trace-ID': 'trace_chat_plain_text_spf',
        'X-Brief-ID': 'chat_plain_text_spf_brief',
      })
      .send({
        message: 'best sunscreen for oily skin',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 1);
    assert.equal(payload.recommendations[0]?.product_id, 'spf_right_1');
    assert.deepEqual(
      payload.metadata?.search_stage_ledger?.final_selection?.selected_product_ids,
      ['spf_right_1'],
    );
    assert.equal(payload.recommendation_meta?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.equal(payload.recommendation_meta?.semantic_owner, 'shopping_agent_beauty_mainline');
    assert.deepEqual(payload.recommendation_meta?.source_tier_counts, { fresh_external: 3 });
    assert.equal(auroraChatCallCount, 0);
    assert.equal(latestArtifactLookupCount, 0);
    assert.ok(
      observedCalls.some((entry) =>
        entry.query === 'best sunscreen for oily skin'
        && entry.semanticContractOwner === 'aurora_reco_planner'
        && entry.semanticContractTargetStep === 'sunscreen'
        && entry.queryStepStrength === 'exact_step'
        && entry.targetStepFamily === 'sunscreen'
        && entry.semanticFamily === 'sunscreen'),
      JSON.stringify(observedCalls),
    );
  } finally {
    axios.get = originalGet;
    diagnosisArtifactStore.getLatestDiagnosisArtifact = originalGetLatestDiagnosisArtifact;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: plain-text beauty reco with latest_reco_context still short-circuits to canonical handoff before aurora planner', { concurrency: false }, async () => {
  let auroraChatCallCount = 0;
  const observedInternalQueries = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_body',
              display_name: 'Legacy Body Oil',
            },
          ],
        },
        context: {},
      };
    },
  });
  harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
    searchInternalProductsPrimitive: async (args = {}) => {
      const query = String(args?.query || '').trim().toLowerCase();
      observedInternalQueries.push(query);
      const base = {
        ok: true,
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      };
      if (query === 'oil control serum') {
        return {
          ...base,
          products: [
            {
              product_id: 'niacinamide_1',
              merchant_id: 'mid_internal',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              category: 'serum',
              product_type: 'serum',
              url: 'https://example.com/pdp/niacinamide-zinc',
              candidate_step: 'treatment',
              retrieval_source: 'internal_search',
              retrieval_reason: 'internal_primitive_match',
            },
            {
              product_id: 'wrong_serum_2',
              merchant_id: 'mid_external',
              brand: 'Winona',
              name: 'Soothing Repair Serum',
              display_name: 'Winona Soothing Repair Serum',
              category: 'serum',
              product_type: 'serum',
              candidate_step: 'treatment',
              retrieval_source: 'external_seed',
              retrieval_reason: 'internal_primitive_match',
            },
          ],
        };
      }
      return {
        ...base,
        products: [],
      };
    },
  });

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_plain_text_latest_context_uid',
        'X-Trace-ID': 'trace_chat_plain_text_latest_context',
        'X-Brief-ID': 'chat_plain_text_latest_context_brief',
      })
      .send({
        message: 'what products should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: {
          state: 'idle',
          latest_reco_context: {
            intent: 'reco_products',
            source_detail: 'analysis_handoff',
            trigger_source: 'analysis_handoff',
            goal: 'oil control',
            ingredient_query: 'niacinamide',
            context_origin: 'analysis_summary',
            resolved_target_step: 'treatment',
            resolved_target_step_confidence: 'high',
            resolved_target_step_source: 'analysis_ingredient_plan',
          },
        },
        context: {
          locale: 'en',
          profile: {
            skinType: 'oily',
            sensitivity: 'low',
            barrierStatus: 'stable',
            goals: ['oil control'],
          },
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    assert.equal(auroraChatCallCount, 0);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.deepEqual(
      Array.isArray(payload.recommendations) ? payload.recommendations.map((item) => item.product_id) : [],
      ['niacinamide_1'],
    );
    assert.deepEqual(payload.metadata?.final_selection?.selected_product_ids, ['niacinamide_1']);
    assert.equal(payload.recommendation_meta?.resolved_contract, 'agent_v1_search_beauty_mainline');
    assert.deepEqual(payload.metadata?.source_breakdown?.source_tier_counts, { fresh_internal: 1 });
    assert.ok(observedInternalQueries.includes('oil control treatment'));
  } finally {
    harness.routesMod.__internal.__resetRouteDependencyOverridesForTest();
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: exact oily free-text beauty reco carries parsed profile and canonical latest_reco_context through the early beauty mainline', { concurrency: false }, async () => {
  let auroraChatCallCount = 0;
  const observedInternalQueries = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_body',
              display_name: 'Legacy Body Oil',
            },
          ],
        },
        context: {},
      };
    },
  });
  harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
    searchInternalProductsPrimitive: async (args = {}) => {
      const query = String(args?.query || '').trim().toLowerCase();
      observedInternalQueries.push(query);
      const base = {
        ok: true,
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      };
      if (query === 'oil control serum') {
        return {
          ...base,
          products: [
            {
              product_id: 'niacinamide_1',
              merchant_id: 'mid_internal',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              category: 'serum',
              product_type: 'serum',
              url: 'https://example.com/pdp/niacinamide-zinc',
              candidate_step: 'treatment',
              retrieval_source: 'internal_search',
              retrieval_reason: 'internal_primitive_match',
              short_description: 'A mattifying oil-control serum for oily skin.',
              ingredient_tokens: ['niacinamide', 'zinc pca'],
            },
            {
              product_id: 'light_moisturizer_1',
              merchant_id: 'mid_external',
              brand: 'GelLab',
              name: 'Balance Gel Cream',
              display_name: 'GelLab Balance Gel Cream',
              category: 'moisturizer',
              product_type: 'moisturizer',
              url: 'https://example.com/pdp/balance-gel-cream',
              candidate_step: 'moisturizer',
              retrieval_source: 'internal_search',
              retrieval_reason: 'internal_primitive_match',
              short_description: 'A lightweight moisturizer for oily skin.',
            },
          ],
        };
      }
      return {
        ...base,
        products: [],
      };
    },
  });

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_exact_oily_prompt_uid',
        'X-Trace-ID': 'trace_chat_exact_oily_prompt',
        'X-Brief-ID': 'chat_exact_oily_prompt_brief',
      })
      .send({
        message: 'im oily skin. what product should i use?',
        client_state: 'IDLE_CHAT',
        session: {
          state: 'idle',
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    assert.equal(auroraChatCallCount, 0);
    assert.equal(observedInternalQueries.length > 0, true);
    assert.ok(observedInternalQueries.includes('oil control serum'));

    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.profile?.skinType, 'oily');
    assert.equal(Array.isArray(payload.recommendations), true);
    assert.equal(payload.recommendations.length >= 1, true);
    assert.equal(payload.recommendations[0]?.product_id, 'niacinamide_1');
    assert.equal(payload.recommendation_meta?.primary_target_id, 'oil_control_treatment');
    assert.equal(Array.isArray(payload.recommendation_meta?.ranked_targets), true);
    assert.equal(payload.recommendation_meta.ranked_targets.length > 0, true);
    assert.equal(payload.recommendation_meta.ranked_targets[0]?.target_id, 'oil_control_treatment');
    assert.ok(payload.recommendation_meta.ranked_targets[0]?.product_candidates?.length >= 1);

    const latestRecoContext = response.body?.session_patch?.state?.latest_reco_context || null;
    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.primary_target_id, 'oil_control_treatment');
    assert.equal(Array.isArray(latestRecoContext.ranked_targets), true);
    assert.equal(latestRecoContext.ranked_targets.length > 0, true);
    assert.equal(latestRecoContext.ranked_targets[0]?.target_id, 'oil_control_treatment');
    assert.equal(Array.isArray(latestRecoContext.selected_target_ids), true);
    assert.ok(latestRecoContext.selected_target_ids.includes('oil_control_treatment'));

    const assistantText = String(
      response.body?.assistant_message?.content || response.body?.assistant_text || '',
    );
    assert.doesNotMatch(assistantText, /skin type pending/i);
    assert.match(assistantText, /oily/i);
  } finally {
    harness.routesMod.__internal.__resetRouteDependencyOverridesForTest();
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: greasy-by-noon free text stays on the beauty reco mainline instead of crashing in legacy guards', { concurrency: false }, async () => {
  let auroraChatCallCount = 0;
  const observedInternalQueries = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_body',
              display_name: 'Legacy Body Oil',
            },
          ],
        },
        context: {},
      };
    },
  });
  harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
    searchInternalProductsPrimitive: async (args = {}) => {
      const query = String(args?.query || '').trim().toLowerCase();
      observedInternalQueries.push(query);
      const base = {
        ok: true,
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      };
      if (query === 'oil control serum') {
        return {
          ...base,
          products: [
            {
              product_id: 'niacinamide_1',
              merchant_id: 'mid_internal',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              category: 'serum',
              product_type: 'serum',
              url: 'https://example.com/pdp/niacinamide-zinc',
              candidate_step: 'treatment',
              retrieval_source: 'internal_search',
              retrieval_reason: 'internal_primitive_match',
              short_description: 'A mattifying oil-control serum for oily skin.',
              ingredient_tokens: ['niacinamide', 'zinc pca'],
              matched_role_id: 'oil_control_treatment',
            },
          ],
        };
      }
      return {
        ...base,
        products: [],
      };
    },
  });

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_greasy_by_noon_uid',
        'X-Trace-ID': 'trace_chat_greasy_by_noon',
        'X-Brief-ID': 'chat_greasy_by_noon_brief',
      })
      .send({
        message: 'My face gets greasy by noon. What skincare product should I use first?',
        client_state: 'IDLE_CHAT',
        session: {
          state: 'idle',
        },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    assert.equal(auroraChatCallCount, 0);
    assert.equal(observedInternalQueries.length > 0, true);
    assert.ok(observedInternalQueries.includes('oil control serum'));

    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.profile?.skinType, 'oily');
    assert.equal(payload.recommendation_meta?.primary_target_id, 'oil_control_treatment');
    assert.equal(Array.isArray(payload.recommendation_meta?.ranked_targets), true);
    assert.equal(payload.recommendation_meta.ranked_targets.length > 0, true);
    assert.deepEqual(payload.recommendation_meta?.selected_target_ids, ['oil_control_treatment']);

    const latestRecoContext = response.body?.session_patch?.state?.latest_reco_context || null;
    assert.ok(latestRecoContext);
    assert.equal(latestRecoContext.primary_target_id, 'oil_control_treatment');
    assert.equal(Array.isArray(latestRecoContext.ranked_targets), true);
    assert.equal(latestRecoContext.ranked_targets.length > 0, true);
    assert.deepEqual(latestRecoContext.selected_target_ids, ['oil_control_treatment']);

    const assistantText = String(
      response.body?.assistant_message?.content || response.body?.assistant_text || '',
    );
    assert.doesNotMatch(assistantText, /Failed to process chat\./i);
    assert.match(assistantText, /oily/i);
    assert.match(assistantText, /Goals:\s*oil control\./i);
  } finally {
    harness.routesMod.__internal.__resetRouteDependencyOverridesForTest();
    harness.restore();
  }
});

test('/v1/chat: exact oily first-turn matrix keeps canonical target bundle and green quality contract across bare, seeded, and action-patched paths', { concurrency: false }, async () => {
  let auroraChatCallCount = 0;
  const observedInternalQueries = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      auroraChatCallCount += 1;
      return {
        intent: 'recommend_products',
        answer: '{"summary":"legacy planner should not run"}',
        structured: {
          recommendations: [
            {
              product_id: 'legacy_wrong_body',
              display_name: 'Legacy Body Oil',
            },
          ],
        },
        context: {},
      };
    },
  });
  harness.routesMod.__internal.__setRouteDependencyOverridesForTest({
    searchInternalProductsPrimitive: async (args = {}) => {
      const query = String(args?.query || '').trim().toLowerCase();
      observedInternalQueries.push(query);
      const base = {
        ok: true,
        attempted_internal_paths: ['/agent/internal/products/search'],
        transport_hops: [],
        transport_hop_count: 0,
        nested_orchestrator_hops: 0,
        primary_transport_owner: 'internal_products_search_primitive',
        primary_endpoint_kind: 'internal_primitive',
      };
      if (query === 'oil control serum') {
        return {
          ...base,
          products: [
            {
              product_id: 'niacinamide_1',
              merchant_id: 'mid_internal',
              brand: 'The Ordinary',
              name: 'Niacinamide 10% + Zinc 1%',
              display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              category: 'serum',
              product_type: 'serum',
              url: 'https://example.com/pdp/niacinamide-zinc',
              candidate_step: 'treatment',
              retrieval_source: 'internal_search',
              retrieval_reason: 'internal_primitive_match',
              short_description: 'A mattifying oil-control serum for oily skin.',
              ingredient_tokens: ['niacinamide', 'zinc pca'],
              matched_role_id: 'oil_control_treatment',
            },
          ],
        };
      }
      return {
        ...base,
        products: [],
      };
    },
  });

  const profile = {
    skinType: 'oily',
    sensitivity: 'low',
    barrierStatus: 'stable',
    goals: ['oil control'],
  };
  const cases = [
    {
      label: 'bare_freeform',
      body: {
        message: 'im oily skin. what product should i use?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      },
      expectedProfile: { skinType: 'oily' },
    },
    {
      label: 'seeded_freeform',
      body: {
        message: 'im oily skin. what product should i use?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        context: {
          locale: 'en',
          profile,
        },
        language: 'EN',
      },
      expectedProfile: profile,
    },
    {
      label: 'seeded_top_level_profile',
      body: {
        message: 'im oily skin. what product should i use?',
        profile,
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      },
      expectedProfile: profile,
    },
    {
      label: 'action_patched',
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'im oily skin. what product should i use?',
            profile_patch: profile,
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      },
      expectedProfile: profile,
    },
  ];

  try {
    for (const testCase of cases) {
      const response = await harness.request
        .post('/v1/chat')
        .set({
          'X-Aurora-UID': `chat_exact_oily_matrix_${testCase.label}_uid`,
          'X-Trace-ID': `trace_chat_exact_oily_matrix_${testCase.label}`,
          'X-Brief-ID': `chat_exact_oily_matrix_${testCase.label}_brief`,
        })
        .send(testCase.body);

      assert.equal(response.statusCode, 200, testCase.label);
      const payload = getRecommendationsPayload(response.body);
      assert.ok(payload, testCase.label);
      assert.equal(payload.profile?.skinType, 'oily', testCase.label);
      assert.equal(payload.recommendation_meta?.primary_target_id, 'oil_control_treatment', testCase.label);
      assert.equal(Array.isArray(payload.recommendation_meta?.ranked_targets), true, testCase.label);
      assert.equal(payload.recommendation_meta.ranked_targets.length > 0, true, testCase.label);
      assert.deepEqual(payload.recommendation_meta?.selected_target_ids, ['oil_control_treatment'], testCase.label);

      const latestRecoContext = response.body?.session_patch?.state?.latest_reco_context || null;
      assert.ok(latestRecoContext, testCase.label);
      assert.equal(latestRecoContext.primary_target_id, 'oil_control_treatment', testCase.label);
      assert.equal(Array.isArray(latestRecoContext.ranked_targets), true, testCase.label);
      assert.equal(latestRecoContext.ranked_targets.length > 0, true, testCase.label);
      assert.deepEqual(latestRecoContext.selected_target_ids, ['oil_control_treatment'], testCase.label);

      const assistantText = String(
        response.body?.assistant_message?.content || response.body?.assistant_text || '',
      );
      assert.equal(response.body?.assistant_message ?? null, null, testCase.label);
      assert.equal(assistantText, '', testCase.label);
      assert.equal(payload.recommendation_meta?.assistant_rewrite_llm_used, false, testCase.label);
      assert.equal(payload.recommendation_meta?.assistant_rewrite_reason, 'rewrite_disabled', testCase.label);

      const quality = harness.routesMod.__internal.evaluateQualityContractForEnvelope({
        envelope: {
          cards: Array.isArray(response.body?.cards) ? response.body.cards : [],
          session_patch:
            response.body?.session_patch && typeof response.body.session_patch === 'object'
              ? response.body.session_patch
              : {},
          events: Array.isArray(response.body?.events) ? response.body.events : [],
        },
        policyMeta: { intent_canonical: 'reco_products' },
        assistantText,
        profile: testCase.expectedProfile,
      });
      assert.equal(quality.strict_fail_flags.entity_miss_fail_seed_profile, false, testCase.label);
      assert.equal(quality.context_persistence_pass, true, testCase.label);
      assert.equal(quality.semantic_contract_pass, false, testCase.label);
      assert.equal(quality.contract_pass, true, testCase.label);
    }

    assert.equal(auroraChatCallCount, 0);
    assert.equal(
      observedInternalQueries.filter((query) => query === 'oil control serum').length >= cases.length,
      true,
    );
  } finally {
    harness.routesMod.__internal.__resetRouteDependencyOverridesForTest();
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: step-aware typed reco still returns products when upstream reco times out', async () => {
  const originalGet = axios.get;
  const observedCalls = [];
  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => {
      const err = new Error('upstream timeout');
      err.code = 'ECONNABORTED';
      throw err;
    },
  });

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    observedCalls.push({
      query: String(config?.params?.query || '').trim().toLowerCase(),
      catalogSurface: String(config?.params?.catalog_surface || ''),
    });
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'ext_spf_timeout_bridge_1',
            merchant_id: 'external_seed',
            brand: 'First Aid Beauty',
            name: 'Ultra Light Liquid Mineral Sunscreen SPF 30',
            display_name: 'Ultra Light Liquid Mineral Sunscreen SPF 30',
            category: 'external',
            product_type: 'external',
            source: 'external_seed',
            url: 'https://example.com/ultra-light-spf-30',
            short_description: 'A lightweight sunscreen for oily skin.',
          },
        ],
        metadata: {
          query_source: 'agent_products_search',
          decision_owner: 'shopping_agent_beauty_mainline',
          final_decision: 'products_returned',
        },
      },
    };
  };

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set({
        'X-Aurora-UID': 'chat_step_timeout_bridge_uid',
        'X-Trace-ID': 'trace_chat_step_timeout_bridge',
        'X-Brief-ID': 'chat_step_timeout_bridge_brief',
        'X-Agent-API-Key': 'ak_live_timeout_bridge_test',
      })
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'what sunscreen should i use for oily skin?',
            profile_patch: {
              skinType: 'oily',
              sensitivity: 'low',
              barrierStatus: 'stable',
              goals: ['sun protection', 'oil control'],
            },
          },
        },
        message: 'what sunscreen should i use for oily skin?',
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      });

    assert.equal(response.statusCode, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendations[0]?.product_id, 'ext_spf_timeout_bridge_1');
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.equal(confidenceCard, null);
    assert.equal(observedCalls.length, 1);
    assert.equal(observedCalls[0]?.catalogSurface, '');
    assert.equal(observedCalls[0]?.query, 'lightweight sunscreen oily skin');
    assert.equal(observedCalls.some((entry) => entry.query === 'daily sunscreen'), false);
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/reco/generate: latest reco context seeds moisturizer queries with normalized handoff fields', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v4',
            hit_quality: 'valid_hit',
            query_bucket: 'skincare',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 1,
            exact_step_topk_count: 1,
            raw_result_count: 1,
            products_returned_count: 1,
          },
        },
        products: [
          {
            product_id: `cream_seed_${observedQueries.length}`,
            merchant_id: 'mid_seed_cream',
            brand: 'BarrierLab',
            name: 'Barrier Repair Cream',
            display_name: 'Barrier Repair Cream',
            category: 'skincare',
            ingredient_tokens: ['ceramide', 'panthenol'],
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'reco_seed_uid', briefId: 'reco_seed_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_seed_uid',
        'X-Trace-ID': 'trace_reco_seed',
        'X-Brief-ID': 'reco_seed_brief',
      },
      body: {
        focus: 'moisturizer',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              goal: 'Repair skin barrier',
              ingredient_query: 'ceramide',
              context_origin: 'analysis_summary',
              resolved_target_step: 'moisturizer',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'analysis_ingredient_plan',
              artifact_id: 'artifact_seed_test',
            },
          },
        },
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.ok(observedQueries.some((query) => query.includes('moisturizer')));
    assert.ok(observedQueries.some((query) => query.includes('ceramide') || query.includes('barrier repair')));
    assert.equal(observedQueries.some((query) => query.includes('uv filters')), false);
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: photo contextual generic reco keeps ingredient fidelity and filters mismatched products', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'photo_mismatch_1',
            merchant_id: 'mid_photo',
            brand: 'MismatchLab',
            name: 'Niacinamide Rescue Serum',
            display_name: 'Niacinamide Rescue Serum',
            category: 'skincare',
            product_type: 'treatment',
            ingredient_tokens: ['niacinamide'],
          },
          {
            product_id: 'photo_match_1',
            merchant_id: 'mid_photo',
            brand: 'NightLab',
            name: 'Retinol Night Treatment',
            display_name: 'Retinol Night Treatment',
            category: 'skincare',
            product_type: 'treatment',
            ingredient_tokens: ['retinol', 'retinoid'],
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_photo_contextual_reco_uid', briefId: 'chat_photo_contextual_reco_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_photo_contextual_reco_uid',
        'X-Trace-ID': 'trace_chat_photo_contextual_reco',
        'X-Brief-ID': 'chat_photo_contextual_reco_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              context_origin: 'photo_modules_v1',
              goal: 'texture',
              ingredient_query: 'Retinoid (later stage)',
              resolved_target_step: 'treatment',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'analysis_photo_modules',
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.resolved_target_step, 'treatment');
    assert.equal(payload.recommendations.some((row) => /niacinamide/i.test(JSON.stringify(row))), false);
    assert.equal(payload.recommendations.some((row) => /retinol|retinoid/i.test(JSON.stringify(row))), true);
    assert.ok(observedQueries.some((query) => query.includes('retinoid') || query.includes('retinol')));
    assert.equal(payload.constraint_match_summary?.matched, 1);
    assert.equal(Number(payload.constraint_match_summary?.dropped || 0) >= 0, true);
    const assistantText = String(response.body?.assistant_message?.content || response.body?.assistant_text || '');
    assert.doesNotMatch(assistantText, /^(got it|absolutely|sounds good)\b/i);
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: photo contextual generic reco preserves analysis-derived target step into catalog search', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    const stepAwareHit = query.includes('treatment') && (query.includes('retinoid') || query.includes('retinol'));
    return {
      status: 200,
      data: {
        products: stepAwareHit
          ? [
              {
                product_id: 'photo_step_preserved_1',
                merchant_id: 'mid_photo',
                brand: 'NightLab',
                name: 'Retinol Night Treatment',
                display_name: 'Retinol Night Treatment',
                category: 'skincare',
                product_type: 'treatment',
                ingredient_tokens: ['retinol', 'retinoid'],
              },
            ]
          : [],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_photo_target_step_uid', briefId: 'chat_photo_target_step_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_photo_target_step_uid',
        'X-Trace-ID': 'trace_chat_photo_target_step',
        'X-Brief-ID': 'chat_photo_target_step_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              context_origin: 'photo_modules_v1',
              goal: 'texture',
              ingredient_query: 'Retinoid (later stage)',
              resolved_target_step: 'treatment',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'analysis_photo_modules',
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.resolved_target_step, 'treatment');
    assert.ok(observedQueries.some((query) => query.includes('treatment') && (query.includes('retinoid') || query.includes('retinol'))));
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: photo contextual generic reco restores verified context candidates after post-filter drop', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'catalog_generic_serum_1',
            merchant_id: 'mid_catalog',
            brand: 'AcidLab',
            name: 'Clarifying Serum',
            display_name: 'Clarifying Serum',
            category: 'serum',
            product_type: 'serum',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_photo_restore_uid', briefId: 'chat_photo_restore_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_photo_restore_uid',
        'X-Trace-ID': 'trace_chat_photo_restore',
        'X-Brief-ID': 'chat_photo_restore_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              context_origin: 'photo_modules_v1',
              goal: 'texture',
              ingredient_query: 'Salicylic acid (BHA)',
              resolved_target_step: 'serum',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'analysis_ingredient_plan',
              product_candidates: [
                {
                  product_id: 'bha_verified_1',
                  merchant_id: 'mid_verified',
                  brand: 'The Ordinary',
                  name: 'Salicylic Acid 2% Solution',
                  display_name: 'Salicylic Acid 2% Solution',
                  category: 'serum',
                  pdp_url: 'https://example.com/bha-verified',
                  url: 'https://example.com/bha-verified',
                  product_url: 'https://example.com/bha-verified',
                  retrieval_source: 'external_seed',
                  retrieval_reason: 'external_seed_deterministic_ingredient_match',
                },
              ],
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.equal(payload.recommendation_meta?.verified_candidate_restore_applied, true);
    assert.equal(payload.recommendation_meta?.verified_candidate_restore_count, 1);
    assert.equal(payload.recommendation_meta?.contract_status, 'recommendations_ready');
    assert.equal(payload.recommendation_meta?.terminal_success, true);
    assert.equal(payload.recommendation_meta?.viable_pool_strength, 'strong');
    assert.equal(payload.recommendation_meta?.target_fidelity_level, 'satisfied');
    assert.equal(payload.recommendation_meta?.weak_viable_pool, undefined);
    assert.equal(payload.recommendation_meta?.selected_candidate_count, 1);
    assert.equal(Array.isArray(payload.recommendations), true);
    assert.equal(payload.recommendations.some((row) => String(row?.product_id || '') === 'bha_verified_1'), true);
    assert.equal(payload.recommendations.some((row) => /salicylic acid/i.test(JSON.stringify(row))), true);
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: analysis-summary baseline handoff surfaces verified context candidates in catalog-first mainline', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'catalog_generic_serum_1',
            merchant_id: 'mid_catalog',
            brand: 'AcidLab',
            name: 'Clarifying Serum',
            display_name: 'Clarifying Serum',
            category: 'serum',
            product_type: 'serum',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_analysis_restore_uid', briefId: 'chat_analysis_restore_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_analysis_restore_uid',
        'X-Trace-ID': 'trace_chat_analysis_restore',
        'X-Brief-ID': 'chat_analysis_restore_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'goal_driven',
              trigger_source: 'analysis_handoff',
              context_origin: 'analysis_summary',
              goal: 'texture',
              ingredient_query: 'UV filters',
              resolved_target_step: 'sunscreen',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'explicit_target_step',
              product_candidates: [
                {
                  product_id: 'uv_verified_1',
                  merchant_id: 'external_seed',
                  brand: 'The Ordinary',
                  name: 'UV Filters SPF 45 Serum',
                  display_name: 'UV Filters SPF 45 Serum',
                  category: 'sunscreen',
                  pdp_url: 'https://example.com/uv-filters-spf45',
                  url: 'https://example.com/uv-filters-spf45',
                  product_url: 'https://example.com/uv-filters-spf45',
                  retrieval_source: 'external_seed',
                  retrieval_reason: 'external_seed_supplement',
                },
              ],
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.equal(payload.recommendation_meta?.contract_status, 'recommendations_ready');
    assert.equal(payload.recommendation_meta?.terminal_success, true);
    assert.equal(payload.recommendation_meta?.selected_candidate_count, 1);
    assert.equal(Array.isArray(payload.recommendations), true);
    assert.equal(payload.recommendations.some((row) => String(row?.product_id || '') === 'uv_verified_1'), true);
    assert.equal(
      payload.recommendations.some((row) => /uv filters spf 45 serum/i.test(JSON.stringify(row))),
      true,
    );
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: analysis-summary external-seed sunscreen handoff surfaces verified candidate in catalog-first mainline', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'catalog_generic_serum_2',
            merchant_id: 'mid_catalog',
            brand: 'AcidLab',
            name: 'Clarifying Serum',
            display_name: 'Clarifying Serum',
            category: 'serum',
            product_type: 'serum',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_analysis_external_restore_uid', briefId: 'chat_analysis_external_restore_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_analysis_external_restore_uid',
        'X-Trace-ID': 'trace_chat_analysis_external_restore',
        'X-Brief-ID': 'chat_analysis_external_restore_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'goal_driven',
              trigger_source: 'analysis_handoff',
              context_origin: 'analysis_summary',
              goal: 'texture',
              ingredient_query: 'UV filters',
              resolved_target_step: 'sunscreen',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'explicit_target_step',
              primary_target_id: 'sunscreen_filters__sunscreen',
              ranked_targets: [
                {
                  target_id: 'sunscreen_filters_sunscreen',
                  target_role: 'primary',
                  ingredient_query: 'UV filters',
                  goal: 'texture',
                  resolved_target_step: 'sunscreen',
                  target_confidence: 'high',
                  source: 'analysis_summary',
                  verified_product_count: 1,
                },
              ],
              product_candidates: [
                {
                  product_id: 'ext_bbe1ff8884f06d874bbccbd8',
                  merchant_id: 'external_seed',
                  brand: 'the ordinary',
                  name: 'UV Filters SPF 45 Serum',
                  display_name: 'UV Filters SPF 45 Serum',
                  category: 'external',
                  source: 'external_seed',
                  retrieval_source: 'external_seed',
                  retrieval_reason: 'external_seed_supplement',
                  url: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  pdp_url: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  product_url: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  purchase_path: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  canonical_product_ref: {
                    product_id: 'ext_bbe1ff8884f06d874bbccbd8',
                    merchant_id: 'external_seed',
                  },
                },
              ],
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.equal(payload.recommendation_meta?.contract_status, 'recommendations_ready');
    assert.equal(payload.recommendation_meta?.terminal_success, true);
    assert.equal(payload.recommendation_meta?.selected_candidate_count, 1);
    assert.equal(Array.isArray(payload.recommendations), true);
    assert.equal(
      payload.recommendations.some((row) => String(row?.product_id || '') === 'ext_bbe1ff8884f06d874bbccbd8'),
      true,
    );
    assert.equal(
      payload.recommendations.some((row) => /uv filters spf 45 serum/i.test(JSON.stringify(row))),
      true,
    );
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: analysis-handoff verified candidates bypass upstream product search and still return grounded reco', async () => {
  const originalGet = axios.get;
  let productsSearchCalls = 0;
  axios.get = async (url) => {
    if (isProductsSearchUrl(url)) {
      productsSearchCalls += 1;
      throw new Error(`Products search should not run for direct verified restore: ${url}`);
    }
    throw new Error(`Unexpected axios.get: ${url}`);
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_analysis_shortcircuit_uid', briefId: 'chat_analysis_shortcircuit_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_analysis_shortcircuit_uid',
        'X-Trace-ID': 'trace_chat_analysis_shortcircuit',
        'X-Brief-ID': 'chat_analysis_shortcircuit_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              context_origin: 'photo_modules_v1',
              goal: 'texture',
              ingredient_query: 'UV filters',
              resolved_target_step: 'sunscreen',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'explicit_target_step',
              primary_target_id: 'sunscreen_filters__sunscreen',
              ranked_targets: [
                {
                  target_id: 'sunscreen_filters_sunscreen',
                  target_role: 'primary',
                  ingredient_query: 'UV filters',
                  goal: 'texture',
                  resolved_target_step: 'sunscreen',
                  target_confidence: 'high',
                  source: 'photo_modules_v1',
                  verified_product_count: 1,
                },
              ],
              product_candidates: [
                {
                  product_id: 'ext_bbe1ff8884f06d874bbccbd8',
                  merchant_id: 'external_seed',
                  brand: 'the ordinary',
                  name: 'UV Filters SPF 45 Serum',
                  display_name: 'UV Filters SPF 45 Serum',
                  category: 'external',
                  source: 'external_seed',
                  retrieval_source: 'external_seed',
                  retrieval_reason: 'external_seed_supplement',
                  url: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  pdp_url: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  product_url: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  purchase_path: 'https://agent.pivota.cc/products/ext_bbe1ff8884f06d874bbccbd8?merchant_id=external_seed&entry=creator_agent',
                  canonical_product_ref: {
                    product_id: 'ext_bbe1ff8884f06d874bbccbd8',
                    merchant_id: 'external_seed',
                  },
                },
              ],
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(productsSearchCalls, 0);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.equal(payload.recommendation_meta?.verified_candidate_restore_applied, true);
    assert.equal(payload.recommendation_meta?.verified_candidate_restore_count, 1);
    assert.equal(Array.isArray(payload.recommendations), true);
    assert.equal(payload.recommendations.some((row) => String(row?.product_id || '') === 'ext_bbe1ff8884f06d874bbccbd8'), true);
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/chat: ingredient reco restores selected catalog candidates after ingredient constraint drops llm output', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    observedQueries.push(String(config?.params?.query || '').trim().toLowerCase());
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v4',
            hit_quality: 'valid_hit',
            query_bucket: 'skincare',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 2,
            exact_step_topk_count: 0,
            raw_result_count: 2,
            products_returned_count: 2,
          },
        },
        products: [
          {
            product_id: 'ceramide_1',
            merchant_id: 'mid_barrier',
            brand: 'BarrierLab',
            name: 'Barrier Repair Cream',
            display_name: 'Barrier Repair Cream',
            category: 'moisturizer',
            product_type: 'moisturizer',
          },
          {
            product_id: 'panthenol_1',
            merchant_id: 'mid_barrier',
            brand: 'BarrierLab',
            name: 'Recovery Lotion',
            display_name: 'Recovery Lotion',
            category: 'moisturizer',
            product_type: 'moisturizer',
          },
        ],
      },
    };
  };

  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"invalid reco envelope"}',
      structured: { summary: 'invalid reco envelope' },
      context: {},
    }),
  });

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set(headersFor('chat_ingredient_restore_uid', 'EN'))
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products',
            entry_source: 'ingredient_goal_match',
            goal: 'barrier',
            sensitivity: 'high',
            candidates: ['Ceramide NP', 'Panthenol'],
            profile_patch: {
              skinType: 'dry',
              sensitivity: 'high',
              barrierStatus: 'compromised',
              goals: ['barrier repair'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      })
      .expect(200);

    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.equal(payload.recommendations.some((row) => String(row?.product_id || '') === 'ceramide_1'), true);
    assert.equal(observedQueries.length > 0, true);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    assert.equal(cards.some((card) => card && card.type === 'confidence_notice'), false);
    const latestRecoContext = response.body?.session_patch?.state?.latest_reco_context || null;
    assert.ok(latestRecoContext);
    assert.match(String(latestRecoContext?.context_origin || ''), /ingredient/i);
    assert.match(String(latestRecoContext?.primary_target_id || ''), /ceramide.*moisturizer/i);
    assert.equal(Array.isArray(latestRecoContext?.product_candidates), true);
    assert.equal(latestRecoContext.product_candidates.length >= 2, true);
    assert.equal((payload.ingredient_evidence?.product_candidates_count || 0) >= 2, true);
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: ingredient reco opt-in still runs catalog mainline when upstream returns empty structured reco payload', async () => {
  const originalGet = axios.get;
  const observedQueries = [];
  const observedSearchParams = [];
  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    observedQueries.push(String(config?.params?.query || '').trim().toLowerCase());
    observedSearchParams.push({
      allow_external_seed: config?.params?.allow_external_seed,
      external_seed_strategy: config?.params?.external_seed_strategy,
    });
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v4',
            hit_quality: 'valid_hit',
            query_bucket: 'skincare',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 2,
            exact_step_topk_count: 0,
            raw_result_count: 2,
            products_returned_count: 2,
          },
        },
        products: [
          {
            product_id: 'ceramide_1',
            merchant_id: 'mid_barrier',
            brand: 'BarrierLab',
            name: 'Barrier Repair Cream',
            display_name: 'Barrier Repair Cream',
            category: 'moisturizer',
            product_type: 'moisturizer',
          },
          {
            product_id: 'panthenol_1',
            merchant_id: 'mid_barrier',
            brand: 'BarrierLab',
            name: 'Recovery Lotion',
            display_name: 'Recovery Lotion',
            category: 'moisturizer',
            product_type: 'moisturizer',
          },
        ],
      },
    };
  };

  const harness = createAppWithPatchedAuroraChat({
    auroraChatImpl: async () => ({
      intent: 'recommend_products',
      answer: '{"summary":"empty structured reco"}',
      structured: {
        recommendations: [],
        confidence: null,
        warnings: ['upstream_missing_or_empty'],
      },
      context: {},
    }),
  });

  try {
    const response = await harness.request
      .post('/v1/chat')
      .set(headersFor('chat_ingredient_empty_structured_uid', 'EN'))
      .send({
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products',
            entry_source: 'ingredient_goal_match',
            goal: 'barrier',
            sensitivity: 'high',
            candidates: ['Ceramide NP', 'Panthenol'],
            profile_patch: {
              skinType: 'dry',
              sensitivity: 'high',
              barrierStatus: 'compromised',
              goals: ['barrier repair'],
            },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      })
      .expect(200);

    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.source_mode, 'catalog_grounded');
    assert.equal(Array.isArray(payload.recommendations), true);
    assert.equal(payload.recommendations.length >= 2, true);
    const latestRecoContext = response.body?.session_patch?.state?.latest_reco_context || null;
    assert.ok(latestRecoContext);
    assert.match(String(latestRecoContext?.primary_target_id || ''), /ceramide.*moisturizer/i);
    assert.equal(Array.isArray(latestRecoContext?.product_candidates), true);
    assert.equal(latestRecoContext.product_candidates.length >= 2, true);
    assert.equal(observedQueries.some((query) => query.includes('ceramide') || query.includes('panthenol')), true);
    assert.equal(
      observedSearchParams.some(
        (params) => params.allow_external_seed === true && params.external_seed_strategy === 'supplement_internal_first',
      ),
      true,
    );
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    assert.equal(cards.some((card) => card && card.type === 'confidence_notice'), false);
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

staleFallbackPlannerTest('/v1/chat: photo contextual generic reco preserves ingredient_constraint_no_match instead of collapsing to reco_mainline_empty', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'catalog_generic_serum_2',
            merchant_id: 'mid_catalog',
            brand: 'AcidLab',
            name: 'Clarifying Serum',
            display_name: 'Clarifying Serum',
            category: 'serum',
            product_type: 'serum',
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_photo_constraint_uid', briefId: 'chat_photo_constraint_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_photo_constraint_uid',
        'X-Trace-ID': 'trace_chat_photo_constraint',
        'X-Brief-ID': 'chat_photo_constraint_brief',
      },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Recommend products now',
          },
        },
        client_state: 'IDLE_CHAT',
        session: {
          state: {
            latest_reco_context: {
              intent: 'reco_products',
              source_detail: 'analysis_handoff',
              trigger_source: 'analysis_handoff',
              context_origin: 'photo_modules_v1',
              goal: 'texture',
              ingredient_query: 'Salicylic acid (BHA)',
              resolved_target_step: 'serum',
              resolved_target_step_confidence: 'high',
              resolved_target_step_source: 'analysis_ingredient_plan',
            },
          },
        },
        language: 'EN',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceNotice =
      cards.find((card) => card && card.type === 'confidence_notice' && String(card?.payload?.reason || '') === 'ingredient_constraint_no_match')
      || null;
    assert.ok(confidenceNotice);
    const recoEvent = getRecoRequestedEvent(response.body);
    if (recoEvent?.data) {
      assert.notEqual(String(recoEvent.data.reason || ''), 'reco_mainline_empty');
      assert.notEqual(String(recoEvent.data.products_empty_reason || ''), 'reco_mainline_empty');
      assert.notEqual(String(recoEvent.data.mainline_status || ''), 'grounded_success');
      assert.equal(String(recoEvent.data.products_empty_reason || ''), 'ingredient_constraint_no_match');
    }
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: retrieval step rescues generic skincare candidates with opaque titles', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'opaque_cream_1',
            merchant_id: 'mid_opaque',
            brand: 'BarrierLab',
            name: 'Recovery 001',
            display_name: 'Recovery 001',
            category: 'skincare',
            ingredient_tokens: ['ceramide', 'panthenol'],
          },
        ],
      },
    };
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'reco_retrieval_step_uid', briefId: 'reco_retrieval_step_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/reco/generate', {
      headers: {
        'X-Aurora-UID': 'reco_retrieval_step_uid',
        'X-Trace-ID': 'trace_reco_retrieval_step',
        'X-Brief-ID': 'reco_retrieval_step_brief',
      },
      body: {
        focus: 'moisturizer',
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length > 0);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
  } finally {
    axios.get = originalGet;
  }
});

staleFallbackPlannerTest('/v1/analysis/skin: low-confidence guidance-only path emits goal-related clarification without legacy missing-field prompts', async () => {
  const prevIngredientPlan = process.env.AURORA_INGREDIENT_PLAN_ENABLED;
  process.env.AURORA_INGREDIENT_PLAN_ENABLED = 'true';
  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const response = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
      headers: {
        'X-Aurora-UID': 'analysis_low_conf_uid',
        'X-Trace-ID': 'trace_analysis_low_conf',
      },
      body: {
        use_photo: false,
        goal: 'Repair skin barrier',
      },
    });

    assert.equal(response.status, 200);
    const sessionPatch = response.body?.session_patch || {};
    const latestRecoContext = sessionPatch?.state?.latest_reco_context || null;
    const pendingClarification = sessionPatch?.state?.pending_clarification || null;
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const ingredientPlanCard = cards.find((card) => card && card.type === 'ingredient_plan_v2');
    const analysisSummaryCard = cards.find(
      (card) => card && typeof card?.payload?.primary_question === 'string',
    );

    assert.equal(sessionPatch?.meta?.analysis_contract?.product_surface_mode, 'guidance_only');
    assert.equal(latestRecoContext?.goal, 'Repair skin barrier');
    assert.equal(latestRecoContext?.resolved_target_step, 'moisturizer');
    assert.equal(latestRecoContext?.context_origin, 'analysis_summary');
    assert.equal(typeof latestRecoContext?.artifact_id, 'string');
    assert.equal(latestRecoContext.artifact_id.length > 0, true);
    assert.equal(pendingClarification, null);
    assert.equal(Array.isArray(response.body?.suggested_chips), true);
    assert.equal(
      response.body.suggested_chips.some((chip) => String(chip?.data?.clarification_question_id || '').trim().length > 0),
      false,
    );
    assert.ok(analysisSummaryCard);
    assert.equal(typeof analysisSummaryCard?.payload?.primary_question, 'string');
    assert.equal(analysisSummaryCard.payload.primary_question.includes('missing_'), false);
    assert.equal(Array.isArray(analysisSummaryCard?.payload?.ask_3_questions), true);
    assert.equal(analysisSummaryCard.payload.ask_3_questions.length > 0, true);
    assert.equal(
      analysisSummaryCard.payload.ask_3_questions.some((question) => String(question || '').includes('missing_')),
      false,
    );
    assert.ok(ingredientPlanCard);
    assert.equal(ingredientPlanCard.payload?.product_surface_mode, 'guidance_only');
    const clarificationNotice = (Array.isArray(response.body?.cards) ? response.body.cards : [])
      .find((card) => card && card.type === 'confidence_notice' && String(card?.payload?.reason || '') === 'artifact_missing_core');
    assert.ok(clarificationNotice);
    assert.equal(
      Array.isArray(clarificationNotice?.payload?.ask_3_questions) && clarificationNotice.payload.ask_3_questions.length > 0,
      true,
    );
    assert.equal(
      clarificationNotice.payload.ask_3_questions.some((question) => String(question || '').includes('missing_')),
      false,
    );
    const guidanceTargets = Array.isArray(ingredientPlanCard.payload?.targets) ? ingredientPlanCard.payload.targets : [];
    for (const target of guidanceTargets) {
      assert.equal(target?.products?.mode, 'guidance_only');
      assert.equal(Array.isArray(target?.products?.example_product_types), true);
      assert.equal(target.products.example_product_types.length > 0, true);
      assert.equal(Array.isArray(target?.products?.example_product_discovery_items), true);
      assert.equal(target.products.example_product_discovery_items.length > 0, true);
      assert.equal(typeof target.products.example_product_discovery_items[0]?.search_query, 'string');
      assert.equal(Array.isArray(target.products.example_product_discovery_items[0]?.query_ladder_steps), true);
      assert.equal(target.products.example_product_discovery_items[0].query_ladder_steps.length > 1, true);
      assert.equal(Array.isArray(target.products.example_product_discovery_items[0]?.query_ladder), true);
      assert.equal(
        target.products.example_product_discovery_items[0].query_ladder.length,
        target.products.example_product_discovery_items[0].query_ladder_steps.length,
      );
      assert.equal(
        target.products.example_product_discovery_items[0].query_ladder_steps.every((step) =>
          ['strong_goal_family', 'supportive_family', 'generic_family'].includes(String(step?.intent_strength || ''))),
        true,
      );
      assert.equal(
        target.products.example_product_discovery_items[0].query_ladder_steps.every((step) => step?.stop_on_success === true),
        true,
      );
      assert.equal(
        target.products.example_product_discovery_items[0].query_ladder_steps.some((step) =>
          String(step?.query || '').trim().toLowerCase() === 'face moisturizer'),
        false,
      );
      assert.equal(
        target.products.example_product_discovery_items[0].query_ladder_steps.every((step) =>
          step?.source_policy === 'internal_first_then_external_supplement' && step?.decision_mode === 'guidance_only'),
        true,
      );
      assert.equal(Array.isArray(target?.products?.competitors), false);
      assert.equal(Array.isArray(target?.products?.dupes), false);
      assert.equal('competitors' in target, false);
      assert.equal('dupes' in target, false);
    }
    assert.equal(
      guidanceTargets.some((target) =>
        Array.isArray(target?.products?.example_product_discovery_items)
        && target.products.example_product_discovery_items.some((item) =>
          Array.isArray(item?.query_ladder_steps)
          && item.query_ladder_steps.some((step) =>
            step
            && /moisturizer/i.test(String(step.query || ''))
            && /ceramide/i.test(String(step.query || ''))
            && /barrier repair/i.test(String(step.query || ''))
            && step.source_policy === 'internal_first_then_external_supplement'))),
      true,
    );
  } finally {
    if (prevIngredientPlan === undefined) delete process.env.AURORA_INGREDIENT_PLAN_ENABLED;
    else process.env.AURORA_INGREDIENT_PLAN_ENABLED = prevIngredientPlan;
  }
});

staleFallbackPlannerTest('/v1/analysis/skin -> /v1/session/bootstrap keeps latest_reco_context for skip-photo goal-driven analysis', async () => {
  const prevRetention = process.env.AURORA_BFF_RETENTION_DAYS;
  process.env.AURORA_BFF_RETENTION_DAYS = '0';
  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const headers = {
      'X-Aurora-UID': 'analysis_bootstrap_reco_context_uid',
      'X-Trace-ID': 'trace_analysis_bootstrap_reco_context',
    };

    const analysisResponse = await invokeRoute(app, 'POST', '/v1/analysis/skin', {
      headers,
      body: {
        use_photo: false,
        goal: 'barrier_repair',
        diagnosis_goal: 'barrier_repair',
      },
    });

    assert.equal(analysisResponse.status, 200);
    assert.equal(analysisResponse.body?.session_patch?.state?.latest_reco_context?.resolved_target_step, 'moisturizer');
    assert.equal(typeof analysisResponse.body?.session_patch?.state?.latest_reco_context?.goal, 'string');
    assert.equal(
      String(analysisResponse.body?.session_patch?.state?.latest_reco_context?.goal || '').length > 0,
      true,
    );

    const bootstrapResponse = await invokeRoute(app, 'GET', '/v1/session/bootstrap', {
      headers,
    });

    assert.equal(bootstrapResponse.status, 200);
    assert.equal(bootstrapResponse.body?.session_patch?.state?.latest_reco_context?.resolved_target_step, 'moisturizer');
    assert.equal(typeof bootstrapResponse.body?.session_patch?.state?.latest_reco_context?.goal, 'string');
    assert.equal(
      String(bootstrapResponse.body?.session_patch?.state?.latest_reco_context?.goal || '').length > 0,
      true,
    );
  } finally {
    if (prevRetention === undefined) delete process.env.AURORA_BFF_RETENTION_DAYS;
    else process.env.AURORA_BFF_RETENTION_DAYS = prevRetention;
  }
});

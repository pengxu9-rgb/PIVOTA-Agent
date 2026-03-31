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
const ROUTES_MODULE_PATH = require.resolve('../src/auroraBff/routes');
const AURORA_DECISION_CLIENT_MODULE_PATH = require.resolve('../src/auroraBff/auroraDecisionClient');
const { saveDiagnosisArtifact } = require('../src/auroraBff/diagnosisArtifactStore');
const {
  createAppWithPatchedAuroraChat,
  headersFor,
  seedCompleteProfile,
} = require('./aurora_bff_test_harness.cjs');

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

function getRecoRequestedEvent(responseBody) {
  const events = Array.isArray(responseBody?.events) ? responseBody.events : [];
  return events.find((event) => event && event.event_name === 'recos_requested') || null;
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
              },
            ],
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

test('/v1/reco/generate: step-aware no-viable path stays explicit and does not report grounded_success', async () => {
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
    assert.ok(response.body?.debug);
    assert.equal(
      response.body?.debug?.effective_failure_class || response.body?.debug?.contract?.effective_failure_class,
      'weak_viable_pool',
    );
    assert.equal(response.body?.debug?.contract?.surface_reason, 'weak_viable_pool');
    assert.equal(typeof response.body?.debug?.raw_candidate_count, 'number');
    assert.ok(response.body?.debug?.reco_catalog_debug?.hard_reject_debug);
    assert.ok(response.body?.debug?.reco_catalog_debug?.soft_mismatch_debug);
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

test('/v1/chat: explicit moisturizer ask stays on step-aware path and never surfaces brush/tool recommendations', async () => {
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

test('/v1/chat: generic oily-skin ask stays framework-first and keeps assistant text aligned to the primary role', async () => {
  const originalGet = axios.get;
  delete require.cache[AURORA_DECISION_CLIENT_MODULE_PATH];
  const decisionModule = require('../src/auroraBff/auroraDecisionClient');
  const originalAuroraChat = decisionModule.auroraChat;
  const observedQueries = [];

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    observedQueries.push(query);
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
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
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
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
        },
      };
    }
    return {
      status: 200,
      data: {
        products: [
          {
            product_id: 'serum_chat_1',
            merchant_id: 'mid_serum',
            brand: 'Clarity Lab',
            name: 'Oil Balance Serum',
            display_name: 'Oil Balance Serum',
            category: 'serum',
            product_type: 'serum',
            ingredient_tokens: ['niacinamide', 'zinc pca'],
          },
          {
            product_id: 'brush_chat_2',
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
  decisionModule.auroraChat = async () => ({
    answer: JSON.stringify({
      recommendations: [
        {
          step: 'sunscreen',
          reasons: ['This fallback answer should not override the framework-first mainline.'],
          sku: { brand: 'SunGuard', display_name: 'Daily UV Fluid SPF 50' },
        },
      ],
    }),
  });

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_uid', briefId: 'chat_framework_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_framework_uid',
        'X-Trace-ID': 'trace_chat_framework',
        'X-Brief-ID': 'chat_framework_brief',
      },
      body: {
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
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.framework_owner_source, 'generic_concern_framework_resolver');
    assert.equal(payload.recommendation_meta?.framework_owner_state, 'trusted');
    assert.equal(payload.recommendation_meta?.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.primary_failure_reason ?? null, null);
    assert.equal(payload.recommendation_meta?.surface_reason ?? null, null);
    assert.equal(payload.recommendation_meta?.products_empty_reason ?? null, null);
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.primary_recommendation_id, 'serum_chat_1');
    assert.ok(Array.isArray(payload.roles) && payload.roles.length >= 3);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 3);
    assert.equal(payload.recommendations[0]?.product_id, 'serum_chat_1');
    assert.equal(payload.recommendations[0]?.matched_role_id, 'oil_control_treatment');
    assert.match(String(payload.recommendations[0]?.notes?.[0] || ''), /targeted oil-control step/i);
    assert.match(String(payload.recommendations[1]?.notes?.[0] || ''), /Keep hydration light and breathable/i);
    assert.match(String(payload.recommendations[2]?.notes?.[0] || ''), /Daytime UV protection still matters/i);
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'lightweight_moisturizer'));
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'daily_sunscreen'));
    assert.match(String(response.body?.assistant_text || ''), /Priority order: Oil-control treatment -> Lightweight moisturizer -> Daily sunscreen\./i);
    assert.match(String(response.body?.assistant_text || ''), /Top pick for that first role: Oil Balance Serum\./i);
    assert.ok(observedQueries.some((query) => query.includes('oil control')));
    assert.ok(observedQueries.some((query) => query.includes('sunscreen')));
  } finally {
    decisionModule.auroraChat = originalAuroraChat;
    axios.get = originalGet;
  }
});

test('/v1/chat: generic oily-skin ask preserves framework recommendations when the primary role is unmatched', async () => {
  const originalGet = axios.get;
  delete require.cache[AURORA_DECISION_CLIENT_MODULE_PATH];
  const decisionModule = require('../src/auroraBff/auroraDecisionClient');
  const originalAuroraChat = decisionModule.auroraChat;

  axios.get = async (url, config = {}) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    const query = String(config?.params?.query || '').trim().toLowerCase();
    if (query.includes('sunscreen') || query.includes('spf')) {
      return {
        status: 200,
        data: {
          products: [
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
        },
      };
    }
    if (query.includes('moisturizer') || query.includes('gel cream') || query.includes('lotion')) {
      return {
        status: 200,
        data: {
          products: [
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
        },
      };
    }
    return {
      status: 200,
      data: { products: [] },
    };
  };
  decisionModule.auroraChat = async () => ({
    answer: JSON.stringify({
      recommendations: [
        {
          step: 'sunscreen',
          reasons: ['This fallback answer should not override the framework-first mainline.'],
          sku: { brand: 'SunGuard', display_name: 'Daily UV Fluid SPF 50' },
        },
      ],
    }),
  });

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = loadRoutesFresh();
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    await seedHighConfidenceArtifactForReco({ auroraUid: 'chat_framework_partial_uid', briefId: 'chat_framework_partial_brief' });
    const response = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: {
        'X-Aurora-UID': 'chat_framework_partial_uid',
        'X-Trace-ID': 'trace_chat_framework_partial',
        'X-Brief-ID': 'chat_framework_partial_brief',
      },
      body: {
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
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.ok(Array.isArray(payload.recommendations) && payload.recommendations.length >= 2);
    assert.equal(payload.recommendation_meta?.framework_owner_source, 'generic_concern_framework_resolver');
    assert.equal(payload.recommendation_meta?.framework_owner_state, 'trusted');
    assert.equal(payload.recommendation_meta?.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.recommendation_meta?.primary_role_matched, false);
    assert.equal(payload.recommendation_meta?.late_conflict_without_override, true);
    assert.equal(payload.recommendation_meta?.mainline_status, 'partially_grounded');
    assert.equal(payload.recommendation_meta?.products_empty_reason ?? null, null);
    assert.equal(payload.primary_role_id, 'oil_control_treatment');
    assert.equal(payload.primary_role_matched, false);
    assert.equal(payload.late_conflict_without_override, true);
    assert.equal(payload.recommendations[0]?.product_id, 'moist_partial_1');
    assert.equal(payload.recommendations[0]?.matched_role_id, 'lightweight_moisturizer');
    assert.ok(payload.recommendations.some((item) => item?.matched_role_id === 'daily_sunscreen'));
    assert.match(String(response.body?.assistant_text || ''), /I do not have a strong mainline match for the first role yet\./i);
    assert.match(String(response.body?.assistant_text || ''), /Best available inside the same framework right now: Air Gel Cream for Lightweight moisturizer\./i);
  } finally {
    decisionModule.auroraChat = originalAuroraChat;
    axios.get = originalGet;
  }
});

test('/v1/chat: profile-driven generic reco without explicit focus returns needs_more_context and skips catalog search', async () => {
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
    assert.equal(confidenceNotice?.payload?.reason, 'needs_more_context');
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'needs_more_context');
    assert.equal(recoEvent?.data?.reason, 'needs_more_context');
    assert.equal(recoEvent?.data?.telemetry_reason, 'minimum_recommendation_context_unsatisfied');
    assert.equal(observedQueries.length, 0);
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/chat: stored-profile generic reco returns needs_more_context before upstream schema-invalid path', async () => {
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
    const confidenceNotice =
      cards.find((card) => card && card.type === 'confidence_notice' && String(card?.payload?.reason || '') === 'needs_more_context')
      || null;
    assert.ok(confidenceNotice);
    const recoEvent = getRecoRequestedEvent(response.body);
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'needs_more_context');
    assert.equal(recoEvent?.data?.reason, 'needs_more_context');
    assert.equal(recoEvent?.data?.telemetry_reason, 'minimum_recommendation_context_unsatisfied');
    assert.equal(recoEvent?.data?.products_empty_reason, 'needs_more_context');
    assert.equal(recoEvent?.data?.surface_reason, 'needs_more_context');
    assert.equal(observedQueries.length, 0);
  } finally {
    axios.get = originalGet;
    harness.restore();
  }
});

test('/v1/chat: contextual generic reco auto-anchors latest analysis context and returns grounded_success', async () => {
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
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceCard = cards.find((card) => card && card.type === 'confidence_notice') || null;
    assert.ok(confidenceCard);
    assert.equal(confidenceCard?.payload?.reason, 'prompt_contract_mismatch');
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.equal(recoEvent?.data?.mainline_status, 'severe_parse_or_prompt_failure');
    assert.equal(recoEvent?.data?.effective_failure_class, 'prompt_contract_mismatch');
  } finally {
    if (originalPromptMismatch == null) delete process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH;
    else process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH = originalPromptMismatch;
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: latest reco context seeds moisturizer queries with normalized handoff fields', async () => {
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

test('/v1/chat: photo contextual generic reco keeps ingredient fidelity and filters mismatched products', async () => {
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

test('/v1/chat: photo contextual generic reco preserves analysis-derived target step into catalog search', async () => {
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

test('/v1/chat: photo contextual generic reco restores verified context candidates after post-filter drop', async () => {
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

test('/v1/chat: analysis-summary baseline handoff surfaces verified context candidates in catalog-first mainline', async () => {
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

test('/v1/chat: analysis-summary external-seed sunscreen handoff surfaces verified candidate in catalog-first mainline', async () => {
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

test('/v1/chat: analysis-handoff verified candidates bypass upstream product search and still return grounded reco', async () => {
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

test('/v1/chat: ingredient reco restores selected catalog candidates after ingredient constraint drops llm output', async () => {
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

test('/v1/chat: ingredient reco opt-in still runs catalog mainline when upstream returns empty structured reco payload', async () => {
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

test('/v1/chat: photo contextual generic reco preserves ingredient_constraint_no_match instead of collapsing to reco_mainline_empty', async () => {
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

test('/v1/analysis/skin: low-confidence guidance-only path emits goal-related clarification without legacy missing-field prompts', async () => {
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

test('/v1/analysis/skin -> /v1/session/bootstrap keeps latest_reco_context for skip-photo goal-driven analysis', async () => {
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

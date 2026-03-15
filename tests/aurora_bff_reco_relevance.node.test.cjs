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
const { saveDiagnosisArtifact } = require('../src/auroraBff/diagnosisArtifactStore');

function loadRoutesFresh() {
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

test('/v1/reco/generate: step-aware no-viable path does not report grounded_success', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v3',
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
      cards.find((card) => card && card.type === 'confidence_notice' && String(card?.payload?.reason || '') === 'no_valid_catalog_hit_for_target')
      || null;
    assert.ok(confidenceNotice);
    assert.equal(confidenceNotice?.payload?.reason, 'no_valid_catalog_hit_for_target');
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'needs_more_context');
    assert.equal(recoEvent?.data?.failure_class, 'no_valid_catalog_hit_for_target');
    assert.equal(recoEvent?.data?.surface_reason, 'no_valid_catalog_hit_for_target');
    assert.equal(recoEvent?.data?.user_fixable, false);
    assert.equal('upstream_status' in (recoEvent?.data || {}), false);
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: weak viable pool stays user-fixable and does not masquerade as artifact missing', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v3',
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
      cards.find((card) => card && card.type === 'confidence_notice' && String(card?.payload?.reason || '') === 'weak_viable_pool')
      || null;
    assert.ok(confidenceNotice);
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'needs_more_context');
    assert.equal(recoEvent?.data?.failure_class, 'weak_viable_pool');
    assert.equal(recoEvent?.data?.surface_reason, 'weak_viable_pool');
    assert.equal('upstream_status' in (recoEvent?.data || {}), false);
    assert.ok(response.body?.debug);
    assert.equal(response.body?.debug?.effective_failure_class || response.body?.debug?.contract?.effective_failure_class, 'weak_viable_pool');
    assert.equal(response.body?.debug?.contract?.surface_reason, 'weak_viable_pool');
    assert.equal(typeof response.body?.debug?.raw_candidate_count, 'number');
    assert.ok(response.body?.debug?.reco_catalog_debug?.hard_reject_debug);
    assert.ok(response.body?.debug?.reco_catalog_debug?.soft_mismatch_debug);
  } finally {
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: valid hit with ineligible weak analysis context returns analysis_context_too_weak_for_step_reco', async () => {
  const originalGet = axios.get;
  axios.get = async (url) => {
    if (!isProductsSearchUrl(url)) throw new Error(`Unexpected axios.get: ${url}`);
    return {
      status: 200,
      data: {
        metadata: {
          search_decision: {
            contract_version: 'beauty_search_decision_v3',
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
              reco_context_version: 'aurora.reco_context.v2',
              reco_context_source: 'analysis_skin',
              reco_context_updated_at: new Date().toISOString(),
              diagnosis_goal: 'Repair skin barrier',
              target_step: 'moisturizer',
              analysis_mode: 'analysis_summary',
              artifact_gate_tier: 'ineligible',
              reco_artifact_eligible: false,
              seed_terms: ['barrier repair'],
            },
          },
        },
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.equal(payload, null);
    const cards = Array.isArray(response.body?.cards) ? response.body.cards : [];
    const confidenceNotice =
      cards.find((card) => card && card.type === 'confidence_notice'
        && String(card?.payload?.reason || '') === 'analysis_context_too_weak_for_step_reco')
      || null;
    assert.ok(confidenceNotice);
    const recoEvent = Array.isArray(response.body?.events)
      ? response.body.events.find((event) => event && event.event_name === 'recos_requested')
      : null;
    assert.ok(recoEvent);
    assert.equal(recoEvent?.data?.mainline_status, 'needs_more_context');
    assert.equal(recoEvent?.data?.failure_class, 'analysis_context_too_weak_for_step_reco');
    assert.equal(recoEvent?.data?.surface_reason, 'analysis_context_too_weak_for_step_reco');
    assert.equal(recoEvent?.data?.user_fixable, true);
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
            contract_version: 'beauty_search_decision_v3',
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

test('/v1/reco/generate: deterministic selection can succeed in degraded mode when LLM prompt contract fails', async () => {
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
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.equal(payload.recommendation_meta?.effective_failure_class, 'none');
    assert.equal(payload.recommendation_meta?.success_mode, 'degraded_success');
    assert.equal(payload.recommendation_meta?.presentation_mode, 'deterministic_degraded');
    assert.equal(payload.recommendation_meta?.initial_llm_outcome, 'prompt_contract_mismatch');
    assert.equal(payload.recommendation_meta?.llm_invoked, false);
  } finally {
    if (originalPromptMismatch == null) delete process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH;
    else process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH = originalPromptMismatch;
    axios.get = originalGet;
  }
});

test('/v1/reco/generate: latest reco context seeds moisturizer queries with prior diagnosis goal', async () => {
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
            contract_version: 'beauty_search_decision_v3',
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
              reco_context_version: 'aurora.reco_context.v2',
              reco_context_source: 'analysis_skin',
              reco_context_updated_at: new Date().toISOString(),
              diagnosis_goal: 'Repair skin barrier',
              target_step: 'moisturizer',
              seed_terms: ['barrier repair', 'ceramide', 'panthenol', 'uv filters'],
              analysis_mode: 'analysis_summary',
              artifact_gate_tier: 'eligible_minimal',
              reco_artifact_eligible: true,
            },
          },
        },
      },
    });

    assert.equal(response.status, 200);
    const payload = getRecommendationsPayload(response.body);
    assert.ok(payload);
    assert.equal(payload.recommendation_meta?.mainline_status, 'grounded_success');
    assert.ok(observedQueries.some((query) => query.includes('barrier repair moisturizer')));
    assert.ok(observedQueries.some((query) => query.includes('ceramide moisturizer')));
    assert.equal(observedQueries.some((query) => query.includes('uv filters')), false);
    assert.equal(observedQueries.some((query) => query === 'barrier repair' || query === 'ceramide'), false);
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

test('/v1/analysis/skin: low-confidence guidance-only path does not synthesize artifact-missing clarification flow', async () => {
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
    const ingredientPlanCard = (Array.isArray(response.body?.cards) ? response.body.cards : [])
      .find((card) => card && card.type === 'ingredient_plan_v2');

    assert.equal(sessionPatch?.meta?.analysis_contract?.product_surface_mode, 'guidance_only');
    assert.equal(latestRecoContext?.diagnosis_goal, 'Repair skin barrier');
    assert.equal(latestRecoContext?.target_step, 'moisturizer');
    assert.equal(Array.isArray(latestRecoContext?.seed_terms), true);
    assert.equal(latestRecoContext.seed_terms.includes('uv filters'), false);
    assert.equal(pendingClarification, null);
    assert.equal(Array.isArray(response.body?.suggested_chips), true);
    assert.equal(
      response.body.suggested_chips.some((chip) => String(chip?.data?.clarification_question_id || '').trim().length > 0),
      false,
    );
    assert.ok(ingredientPlanCard);
    assert.equal(ingredientPlanCard.payload?.product_surface_mode, 'guidance_only');
    const clarificationNotice = (Array.isArray(response.body?.cards) ? response.body.cards : [])
      .find((card) => card && card.type === 'confidence_notice' && String(card?.payload?.reason || '') === 'artifact_missing_core');
    assert.equal(clarificationNotice, undefined);
    for (const target of Array.isArray(ingredientPlanCard.payload?.targets) ? ingredientPlanCard.payload.targets : []) {
      assert.equal(target?.products?.mode, 'guidance_only');
      assert.equal(Array.isArray(target?.products?.example_product_types), true);
      assert.equal(target.products.example_product_types.length > 0, true);
      assert.equal(Array.isArray(target?.products?.example_product_discovery_items), true);
      assert.equal(typeof target.products.example_product_discovery_items.length, 'number');
      assert.equal(Array.isArray(target?.products?.competitors), false);
      assert.equal(Array.isArray(target?.products?.dupes), false);
      assert.equal('competitors' in target, false);
      assert.equal('dupes' in target, false);
    }
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
    assert.equal(analysisResponse.body?.session_patch?.state?.latest_reco_context?.diagnosis_goal, 'barrier_repair');
    assert.equal(analysisResponse.body?.session_patch?.state?.latest_reco_context?.target_step, 'moisturizer');

    const bootstrapResponse = await invokeRoute(app, 'GET', '/v1/session/bootstrap', {
      headers,
    });

    assert.equal(bootstrapResponse.status, 200);
    assert.equal(bootstrapResponse.body?.session_patch?.state?.latest_reco_context?.diagnosis_goal, 'barrier_repair');
    assert.equal(bootstrapResponse.body?.session_patch?.state?.latest_reco_context?.target_step, 'moisturizer');
    assert.equal(Array.isArray(bootstrapResponse.body?.session_patch?.state?.latest_reco_context?.seed_terms), true);
  } finally {
    if (prevRetention === undefined) delete process.env.AURORA_BFF_RETENTION_DAYS;
    else process.env.AURORA_BFF_RETENTION_DAYS = prevRetention;
  }
});

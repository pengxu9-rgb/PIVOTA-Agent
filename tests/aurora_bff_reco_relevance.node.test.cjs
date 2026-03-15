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
      cards.find((card) => card && card.type === 'confidence_notice' && /viable|artifact|candidate/i.test(String(card?.payload?.reason || '')))
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
      },
      body: {
        focus: 'something for night',
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

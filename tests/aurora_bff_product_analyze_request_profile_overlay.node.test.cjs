const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

async function invokeRoute(app, method, routePath, { headers = {}, body = {}, query = {} } = {}) {
  const normalizedMethod = String(method || '').toLowerCase();
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  const layer = stack.find(
    (entry) => entry && entry.route && entry.route.path === routePath && entry.route.methods && entry.route.methods[normalizedMethod],
  );
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
    headers: {},
    body: undefined,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name || '').toLowerCase()] = value;
    },
    header(name, value) {
      this.setHeader(name, value);
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
  };

  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((entry) => entry && entry.handle).filter(Boolean) : [];
  for (const handler of handlers) {
    // eslint-disable-next-line no-await-in-loop
    await handler(req, res, () => {});
    if (res.headersSent) break;
  }

  return { status: res.statusCode, body: res.body };
}

test('/v1/product/analyze: request/session profile overlay feeds analysis context and response meta', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  mountAuroraBffRoutes(app, { logger });

  const resp = await invokeRoute(app, 'POST', '/v1/product/analyze', {
    headers: { 'X-Aurora-UID': 'test_uid_pa_overlay', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: {
      name: 'Mock Parsed Product',
      skinType: 'oily',
      session: {
        profile: {
          sensitivity: 'medium',
          barrierStatus: 'impaired',
          goals: ['acne', 'pores'],
        },
      },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  assert.equal(cards.some((card) => card && card.type === 'product_analysis'), true);

  const sessionPatch = resp.body && resp.body.session_patch && typeof resp.body.session_patch === 'object'
    ? resp.body.session_patch
    : {};
  const sessionProfile = sessionPatch.profile && typeof sessionPatch.profile === 'object'
    ? sessionPatch.profile
    : {};
  assert.equal(sessionProfile.skinType, 'oily');
  assert.equal(sessionProfile.sensitivity, 'medium');
  assert.equal(sessionProfile.barrierStatus, 'impaired');
  assert.deepEqual(sessionProfile.goals, ['acne', 'pores']);

  const meta = sessionPatch.meta && typeof sessionPatch.meta === 'object' ? sessionPatch.meta : {};
  assert.equal(meta.profile_context_source, 'request_overlay_applied');
  assert.equal(meta.request_profile_overlay_applied, true);
  assert.deepEqual(meta.request_profile_overlay_keys, ['barrierStatus', 'goals', 'sensitivity', 'skinType']);
});

test('/v1/product/analyze: main-path exception returns diagnosable degraded product analysis card', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  mountAuroraBffRoutes(app, { logger });

  const resp = await invokeRoute(app, 'POST', '/v1/product/analyze', {
    headers: { 'X-Aurora-UID': 'test_uid_pa_degraded', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'EN' },
    body: {
      product: {
        name: '15% L-AA Brightening Serum',
        ingredients: ['L-Ascorbic Acid 15%', 'Alcohol Denat.', 'Fragrance'],
        toJSON() {
          throw new Error('forced product serialize failure');
        },
      },
      session: {
        profile: {
          skinType: 'dry',
          sensitivity: 'high',
        },
      },
    },
  });

  assert.equal(resp.status, 200);
  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((item) => item && item.type === 'product_analysis');
  assert.ok(card);
  assert.equal(resp.body?.session_patch?.meta?.product_analyze_degraded, true);
  assert.equal(card.payload?.provenance?.retrieval_degradation?.degraded, true);
  assert.equal(card.payload?.assessment?.verdict_level, 'high_risk');
  assert.ok((card.payload?.evidence?.science?.risk_notes || []).includes('sensitive_vitamin_c_irritation_risk'));
});

test('/v1/product/analyze: dry_sensitive vitamin C payload returns explicit high-risk fit verdict', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  mountAuroraBffRoutes(app, { logger });

  const resp = await invokeRoute(app, 'POST', '/v1/product/analyze', {
    headers: { 'X-Aurora-UID': 'test_uid_pa_vitc_sensitive', 'X-Trace-ID': 't', 'X-Brief-ID': 'b', 'X-Lang': 'CN' },
    body: {
      name: '15% L-AA Vitamin C Serum with Alcohol and Fragrance',
      product: {
        name: '15% L-AA Vitamin C Serum with Alcohol and Fragrance',
        category: 'serum',
        ingredients: ['L-Ascorbic Acid 15%', 'Alcohol Denat.', 'Fragrance'],
      },
      session: {
        profile: {
          skinType: 'dry_sensitive',
          sensitivity: 'high',
          barrierStatus: 'fragile',
        },
      },
      profile_context: {
        skinType: 'dry_sensitive',
        sensitivity: 'high',
        barrierStatus: 'fragile',
      },
    },
  });

  assert.equal(resp.status, 200);
  const assistant = String(resp.body?.assistant_message?.content || '');
  assert.match(assistant, /15% L-AA|酒精|香精/);
  assert.match(assistant, /刺激|刺痛|泛红/);
  assert.match(assistant, /低浓度|温和|局部测试/);

  const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
  const card = cards.find((item) => item && item.type === 'product_analysis');
  assert.ok(card);
  assert.equal(card.payload?.assessment?.verdict_level, 'high_risk');
  assert.ok((card.payload?.evidence?.science?.risk_notes || []).includes('sensitive_vitamin_c_irritation_risk'));
  assert.ok((resp.body?.session_patch?.meta?.pivot_product_fit_context?.safety_flags || []).includes('sensitive_vitamin_c_irritation'));
});

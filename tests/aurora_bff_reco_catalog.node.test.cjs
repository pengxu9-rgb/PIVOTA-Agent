const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_RECO_CATALOG_GROUNDED = 'true';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'test_key';

const axios = require('axios');

const invokeRoute = async (app, method, routePath, { headers = {}, body = {}, query = {} } = {}) => {
  const m = String(method || '').toLowerCase();
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

  const req = {
    method: String(method || '').toUpperCase(),
    path: routePath,
    body,
    query,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
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

  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
  for (const fn of handlers) {
    // eslint-disable-next-line no-await-in-loop
    await fn(req, res, () => {});
    if (res.headersSent) break;
  }

  return { status: res.statusCode, body: res.body };
};

test('/v1/chat: reco_products uses catalog grounded PDP-ready items when enabled', async () => {
  const originalGet = axios.get;
  const queries = [];
  axios.get = async (url, config = {}) => {
    if (String(url).includes('/agent/v1/products/search')) {
      const q = String(config?.params?.query || '').trim().toLowerCase();
      queries.push(q);
      const mk = (suffix) => ({
        product_id: `pid_${suffix}`,
        merchant_id: `mid_${suffix}`,
        brand: 'TestBrand',
        name: `Test ${suffix}`,
        display_name: `Test ${suffix}`,
      });
      if (q.includes('cleanser')) return { data: { products: [mk('cleanser')] } };
      if (q.includes('moisturizer')) return { data: { products: [mk('moisturizer')] } };
      if (q.includes('sunscreen')) return { data: { products: [mk('sunscreen')] } };
      return { data: { products: [mk('fallback')] } };
    }
    throw new Error(`Unexpected axios.get: ${url}`);
  };

  try {
    const express = require('express');
    const { mountAuroraBffRoutes } = require('../src/auroraBff/routes');

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRoute(app, 'POST', '/v1/chat', {
      headers: { 'X-Aurora-UID': 'test_uid', 'X-Trace-ID': 'test_trace', 'X-Brief-ID': 'test_brief' },
      body: {
        action: {
          action_id: 'chip.start.reco_products',
          kind: 'chip',
          data: {
            reply_text: 'Get product recommendations',
            profile_patch: { skinType: 'oily', sensitivity: 'low', barrierStatus: 'healthy', goals: ['acne'] },
          },
        },
        client_state: 'IDLE_CHAT',
        session: { state: 'idle' },
        language: 'EN',
      },
    });

    assert.equal(resp.status, 200);
    const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
    const recoCard = cards.find((c) => c && c.type === 'recommendations');
    assert.ok(recoCard);

    const recos = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
    assert.ok(recos.length > 0);
    assert.ok(recos.every((r) => r && r.sku && typeof r.sku.product_id === 'string' && r.sku.product_id));
    assert.ok(queries.length > 0);
  } finally {
    axios.get = originalGet;
  }
});

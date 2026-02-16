const test = require('node:test');
const assert = require('node:assert/strict');

const axios = require('axios');
const ROUTES_MODULE_PATH = require.resolve('../src/auroraBff/routes');

async function withEnv(overrides, fn) {
  const prev = {};
  for (const key of Object.keys(overrides || {})) {
    prev[key] = process.env[key];
    const next = overrides[key];
    if (next === undefined || next === null) delete process.env[key];
    else process.env[key] = String(next);
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides || {})) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function loadRoutesFresh() {
  delete require.cache[ROUTES_MODULE_PATH];
  return require('../src/auroraBff/routes');
}

const invokeRoute = async (app, method, routePath, { headers = {}, body = {} } = {}) => {
  const m = String(method || '').toLowerCase();
  const stack = app && app._router && Array.isArray(app._router.stack) ? app._router.stack : [];
  const layer = stack.find((l) => l && l.route && l.route.path === routePath && l.route.methods && l.route.methods[m]);
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);

  const req = {
    method: String(method || '').toUpperCase(),
    path: routePath,
    body,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    get(name) {
      return this.headers[String(name || '').toLowerCase()] || '';
    },
  };

  const res = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
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
  };

  const handlers = Array.isArray(layer.route.stack) ? layer.route.stack.map((s) => s && s.handle).filter(Boolean) : [];
  for (const fn of handlers) {
    await fn(req, res, () => {});
    if (res.headersSent) break;
  }

  return { status: res.statusCode, body: res.body };
};

test('/v1/ops/pdp-prefetch/*: admin-gated state and manual run work', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      AURORA_BFF_PDP_HOTSET_PREWARM_ADMIN_KEY: 'secret_key',
      AURORA_BFF_PDP_HOTSET_PREWARM_JSON:
        '[{"product_ref":{"merchant_id":"merch_efbc46b4619cfbdf","product_id":"9886500749640"}}]',
      AURORA_BFF_PDP_CORE_PREFETCH_INCLUDE: 'offers,reviews_preview,similar',
    },
    async () => {
      const originalPost = axios.post;
      axios.post = async () => ({ status: 200, data: { ok: true } });

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const forbiddenState = await invokeRoute(app, 'GET', '/v1/ops/pdp-prefetch/state', {
          headers: { 'X-Aurora-Admin-Key': 'wrong_key' },
        });
        assert.equal(forbiddenState.status, 403);

        const manualRun = await invokeRoute(app, 'POST', '/v1/ops/pdp-prefetch/run', {
          headers: { 'X-Aurora-Admin-Key': 'secret_key' },
          body: { reason: 'manual_test_reason' },
        });
        assert.equal(manualRun.status, 200);
        assert.equal(Boolean(manualRun.body?.ok), true);
        assert.equal(Boolean(manualRun.body?.result?.ok), true);

        const state = await invokeRoute(app, 'GET', '/v1/ops/pdp-prefetch/state', {
          headers: { 'X-Aurora-Admin-Key': 'secret_key' },
        });
        assert.equal(state.status, 200);
        assert.equal(Boolean(state.body?.ok), true);
        assert.ok(Array.isArray(state.body?.data?.config?.prefetch_include));
        assert.ok(state.body.data.config.prefetch_include.includes('reviews_preview'));
        assert.ok(Number(state.body?.data?.runtime?.totals?.total || 0) >= 1);
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_RECO_CATALOG_GROUNDED = 'true';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';
process.env.PIVOTA_BACKEND_AGENT_API_KEY = 'test_key';

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
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require('../src/auroraBff/routes');
}

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

function buildRecoChatBody() {
  return {
    action: {
      action_id: 'chip.start.reco_products',
      kind: 'chip',
      data: {
        reply_text: 'Get product recommendations',
        profile_patch: {
          skinType: 'oily',
          sensitivity: 'low',
          barrierStatus: 'healthy',
          goals: ['acne'],
        },
      },
    },
    client_state: 'IDLE_CHAT',
    session: { state: 'idle' },
    language: 'EN',
  };
}

async function invokeRecoChat(app, headers = {}) {
  return invokeRoute(app, 'POST', '/v1/chat', {
    headers: {
      'X-Aurora-UID': 'test_uid',
      'X-Trace-ID': 'test_trace',
      'X-Brief-ID': 'test_brief',
      ...headers,
    },
    body: buildRecoChatBody(),
  });
}

function getRecoCard(responseBody) {
  const cards = Array.isArray(responseBody?.cards) ? responseBody.cards : [];
  return cards.find((c) => c && c.type === 'recommendations') || null;
}

function getRecoItems(responseBody) {
  const recoCard = getRecoCard(responseBody);
  return Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
}

function getRecoPathStats(responseBody) {
  const recoCard = getRecoCard(responseBody);
  const stats = recoCard?.payload?.metadata?.pdp_open_path_stats;
  return stats && typeof stats === 'object' ? stats : null;
}

function getAuroraDebugPayload(responseBody) {
  const cards = Array.isArray(responseBody?.cards) ? responseBody.cards : [];
  const debugCard = cards.find((c) => c && c.type === 'aurora_debug');
  return debugCard && debugCard.payload && typeof debugCard.payload === 'object' ? debugCard.payload : null;
}

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
    const { mountAuroraBffRoutes } = loadRoutesFresh();

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    mountAuroraBffRoutes(app, { logger: null });

    const resp = await invokeRecoChat(app);

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

test('The Ordinary recommendation: pdp_open path is direct internal (group), no fallback', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_QUERIES: 'the ordinary niacinamide 10% + zinc 1%',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let resolveCalls = 0;
      axios.get = async (url, config = {}) => {
        if (!String(url).includes('/agent/v1/products/search')) throw new Error(`Unexpected axios.get: ${url}`);
        const q = String(config?.params?.query || '').toLowerCase();
        if (!q.includes('ordinary')) throw new Error(`Unexpected query: ${q}`);
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_to_niacinamide',
                merchant_id: 'mid_to',
                product_group_id: 'pg_to_niacinamide',
                brand: 'The Ordinary',
                name: 'Niacinamide 10% + Zinc 1%',
                display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              },
            ],
          },
        };
      };
      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) resolveCalls += 1;
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRecoChat(app, { 'X-Aurora-UID': 'test_uid_to' });
        assert.equal(resp.status, 200);

        const recos = getRecoItems(resp.body);
        assert.ok(recos.length > 0);
        const first = recos[0];
        const stats = getRecoPathStats(resp.body);

        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'group');
        assert.equal(first?.pdp_open?.path, 'group');
        assert.equal(first?.pdp_open?.subject?.product_group_id, 'pg_to_niacinamide');
        assert.ok(first?.pdp_open?.get_pdp_v2_payload?.subject?.id);
        assert.equal(Boolean(first?.pdp_open?.external), false);
        assert.ok(first?.pdp_open?.subject?.product_group_id || first?.pdp_open?.product_ref);
        assert.equal(typeof first?.metadata?.time_to_pdp_ms, 'number');
        assert.ok(first?.metadata?.time_to_pdp_ms >= 0);
        assert.equal(stats?.group, 1);
        assert.equal(stats?.external, 0);
        assert.equal(resolveCalls, 0);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('Winona recommendation: pdp_open path is direct internal (ref), no fallback', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_QUERIES: 'winona soothing repair serum',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let resolveCalls = 0;
      axios.get = async (url, config = {}) => {
        if (!String(url).includes('/agent/v1/products/search')) throw new Error(`Unexpected axios.get: ${url}`);
        const q = String(config?.params?.query || '').toLowerCase();
        if (!q.includes('winona')) throw new Error(`Unexpected query: ${q}`);
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_winona_repair',
                merchant_id: 'mid_winona',
                brand: 'Winona',
                name: 'Soothing Repair Serum',
                display_name: 'Winona Soothing Repair Serum',
              },
            ],
          },
        };
      };
      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) resolveCalls += 1;
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRecoChat(app, { 'X-Aurora-UID': 'test_uid_winona' });
        assert.equal(resp.status, 200);

        const recos = getRecoItems(resp.body);
        assert.ok(recos.length > 0);
        const first = recos[0];
        const stats = getRecoPathStats(resp.body);

        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
        assert.equal(first?.pdp_open?.path, 'ref');
        assert.equal(first?.pdp_open?.product_ref?.merchant_id, 'mid_winona');
        assert.equal(first?.pdp_open?.product_ref?.product_id, 'prod_winona_repair');
        assert.ok(first?.pdp_open?.get_pdp_v2_payload?.product_ref?.product_id);
        assert.equal(Boolean(first?.pdp_open?.external), false);
        assert.ok(first?.pdp_open?.subject?.product_group_id || first?.pdp_open?.product_ref);
        assert.equal(typeof first?.metadata?.time_to_pdp_ms, 'number');
        assert.ok(first?.metadata?.time_to_pdp_ms >= 0);
        assert.equal(stats?.ref, 1);
        assert.equal(stats?.external, 0);
        assert.equal(resolveCalls, 0);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('Unresolved recommendation: external fallback only after one resolve attempt (new tab + reason code)', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'false',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_FAILURE: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let resolveCalls = 0;
      let stableResolveCalls = 0;
      let lastResolveBody = null;
      axios.get = async (url) => {
        throw new Error(`Unexpected axios.get: ${url}`);
      };
      axios.post = async (url, body) => {
        if (String(url).includes('/agent/shop/v1/invoke')) {
          stableResolveCalls += 1;
          return {
            status: 200,
            data: {
              status: 'error',
              reason: 'no_candidates',
              reason_code: 'no_candidates',
              metadata: { request_id: 'rid_stable_no_candidates' },
            },
          };
        }
        if (!String(url).includes('/agent/v1/products/resolve')) {
          throw new Error(`Unexpected axios.post: ${url}`);
        }
        resolveCalls += 1;
        lastResolveBody = body;
        return {
          status: 200,
          data: {
            resolved: false,
            product_ref: null,
            reason: 'no_candidates',
            reason_code: 'no_candidates',
            candidates: [],
            metadata: { resolve_reason_code: 'no_candidates', sources: [{ source: 'agent_search_global', ok: false, reason: 'no_results' }] },
          },
        };
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRecoChat(app, { 'X-Aurora-UID': 'test_uid_unresolved' });
        assert.equal(resp.status, 200);

        const recos = getRecoItems(resp.body);
        assert.ok(recos.length > 0);
        const first = recos[0];
        const stats = getRecoPathStats(resp.body);
        const serialized = JSON.stringify(first).toLowerCase();

        assert.equal(resolveCalls, 1);
        assert.ok(stableResolveCalls <= 1);
        assert.ok(lastResolveBody && typeof lastResolveBody.query === 'string' && lastResolveBody.query.length > 0);
        assert.equal(first?.metadata?.pdp_open_path, 'external');
        assert.equal(first?.metadata?.pdp_open_mode, 'external');
        assert.equal(first?.metadata?.resolve_reason_code, 'no_candidates');
        assert.equal(first?.metadata?.pdp_open_fail_reason, 'no_candidates');
        assert.equal(first?.metadata?.resolve_fail_reason, 'no_candidates');
        assert.equal(typeof first?.metadata?.time_to_pdp_ms, 'number');
        assert.ok(first?.metadata?.time_to_pdp_ms >= 0);
        assert.equal(first?.pdp_open?.path, 'external');
        assert.equal(first?.pdp_open?.external?.provider, 'google');
        assert.equal(first?.pdp_open?.external?.target, '_blank');
        assert.ok(String(first?.pdp_open?.external?.url || '').startsWith('https://www.google.com/search?q='));
        assert.notEqual(String(first?.pdp_open?.external?.url || ''), 'about:blank');
        assert.equal(serialized.includes('reply_text'), false);
        assert.equal(serialized.includes('shopping-agent'), false);
        assert.equal(serialized.includes('browse'), false);
        assert.equal(stats?.external, 1);
        assert.equal(stats?.group, 0);
        assert.equal(stats?.ref, 0);
        const cardMeta = getRecoCard(resp.body)?.payload?.metadata || {};
        assert.equal(cardMeta?.resolve_fail_reason_counts?.no_candidates, 1);
        assert.equal(cardMeta?.time_to_pdp_ms_stats?.count, 1);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('Stable-id offers.resolve no_candidates attempts local invoke fallback', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_NO_CANDIDATES: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
    },
    async () => {
      const originalPost = axios.post;
      let primaryCalls = 0;
      let localCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/shop/v1/invoke') {
          primaryCalls += 1;
          return {
            status: 200,
            data: {
              status: 'error',
              reason_code: 'no_candidates',
              reason: 'no_candidates',
              metadata: { request_id: 'rid_primary_no_candidates' },
            },
          };
        }
        if (target === 'http://127.0.0.1:3000/agent/shop/v1/invoke') {
          localCalls += 1;
          return {
            status: 200,
            data: {
              status: 'success',
              mapping: {
                canonical_product_ref: {
                  product_id: 'prod_123',
                  merchant_id: 'merch_123',
                },
              },
              metadata: { request_id: 'rid_local_called' },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.resolveRecoPdpByStableIds({
          productId: 'prod_123',
          skuId: 'prod_123',
          logger: null,
        });

        assert.equal(primaryCalls, 1);
        assert.equal(localCalls, 1);
        assert.equal(out?.ok, true);
        assert.equal(out?.canonicalProductRef?.product_id, 'prod_123');
        assert.equal(out?.canonicalProductRef?.merchant_id, 'merch_123');
        assert.equal(out?.localFallbackAttempted, true);
        assert.deepEqual(out?.requestIds, { primary: 'rid_primary_no_candidates', local: 'rid_local_called' });
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Stable-id offers.resolve upstream_timeout does not attempt local invoke fallback by default', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_UPSTREAM_TIMEOUT: 'false',
    },
    async () => {
      const originalPost = axios.post;
      let primaryCalls = 0;
      let localCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/shop/v1/invoke') {
          primaryCalls += 1;
          return {
            status: 504,
            data: {
              status: 'error',
              reason_code: 'upstream_timeout',
              reason: 'upstream_timeout',
              metadata: { request_id: 'rid_primary_timeout' },
            },
          };
        }
        if (target === 'http://127.0.0.1:3000/agent/shop/v1/invoke') {
          localCalls += 1;
          return {
            status: 200,
            data: {
              status: 'success',
              mapping: {
                canonical_product_ref: {
                  product_id: 'prod_local_should_not_be_used',
                  merchant_id: 'mid_local_should_not_be_used',
                },
              },
              metadata: { request_id: 'rid_local_should_not_be_called' },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.resolveRecoPdpByStableIds({
          productId: 'prod_timeout',
          skuId: 'prod_timeout',
          logger: null,
        });

        assert.equal(primaryCalls, 1);
        assert.equal(localCalls, 0);
        assert.equal(out?.ok, false);
        assert.equal(out?.reasonCode, 'upstream_timeout');
        assert.equal(out?.localFallbackAttempted, false);
        assert.deepEqual(out?.requestIds, { primary: 'rid_primary_timeout' });
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat reco PDP: local double-hop fallback disabled by default', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_UPSTREAM_TIMEOUT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
      AURORA_BFF_RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP: undefined,
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let primaryStableCalls = 0;
      let localStableCalls = 0;
      let queryResolveCalls = 0;

      axios.get = async (url, config = {}) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        const q = String(config?.params?.query || '').trim().toLowerCase();
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: `prod_chat_${q.replace(/[^a-z0-9]+/g, '_').slice(0, 18) || 'x'}`,
                brand: 'UnknownBrand',
                name: `Unknown ${q}`,
                display_name: `Unknown ${q}`,
              },
            ],
          },
        };
      };
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/shop/v1/invoke') {
          primaryStableCalls += 1;
          return {
            status: 504,
            data: {
              status: 'error',
              reason: 'upstream_timeout',
              reason_code: 'upstream_timeout',
              metadata: { request_id: `rid_primary_${primaryStableCalls}` },
            },
          };
        }
        if (target === 'http://127.0.0.1:3000/agent/shop/v1/invoke') {
          localStableCalls += 1;
          return {
            status: 200,
            data: {
              status: 'success',
              mapping: {
                canonical_product_ref: {
                  product_id: 'prod_local_should_not_be_called',
                  merchant_id: 'mid_local_should_not_be_called',
                },
              },
              metadata: { request_id: `rid_local_${localStableCalls}` },
            },
          };
        }
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          throw new Error(`Unexpected axios.post resolve call: ${target}`);
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();

        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRecoChat(app, {
          'X-Aurora-UID': 'test_uid_no_double_hop',
          'X-Aurora-Debug': '1',
        });
        assert.equal(resp.status, 200);

        const recos = getRecoItems(resp.body);
        assert.ok(recos.length > 0);
        assert.ok(primaryStableCalls > 0);
        assert.equal(localStableCalls, 0);
        assert.ok(queryResolveCalls > 0);

        const withStableReqId = recos.find(
          (item) => item && item.metadata && item.metadata.stable_resolve_request_ids,
        );
        assert.ok(withStableReqId);
        assert.ok(withStableReqId.metadata.stable_resolve_request_ids.primary);
        assert.equal(withStableReqId.metadata.stable_resolve_request_ids.local, undefined);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('Reco PDP enrichment caps network resolves by max items budget', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_ENRICH_MAX_NETWORK_ITEMS: '1',
      AURORA_BFF_RECO_PDP_CHAT_DISABLE_LOCAL_DOUBLE_HOP: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let stableResolveCalls = 0;
      axios.post = async (url, body = {}) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/shop/v1/invoke') {
          stableResolveCalls += 1;
          const productId =
            body && body.payload && body.payload.product && typeof body.payload.product.product_id === 'string'
              ? body.payload.product.product_id
              : `prod_${stableResolveCalls}`;
          return {
            status: 200,
            data: {
              status: 'success',
              mapping: {
                canonical_product_ref: {
                  product_id: productId,
                  merchant_id: 'mid_test',
                },
              },
              metadata: { request_id: `rid_${stableResolveCalls}` },
            },
          };
        }
        if (target.includes('/agent/v1/products/resolve')) {
          throw new Error(`Unexpected axios.post resolve call: ${target}`);
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.enrichRecommendationsWithPdpOpenContract({
          recommendations: [
            { sku: { product_id: 'prod_a', sku_id: 'prod_a', brand: 'Brand A', display_name: 'Brand A Serum' } },
            { sku: { product_id: 'prod_b', sku_id: 'prod_b', brand: 'Brand B', display_name: 'Brand B Serum' } },
            { sku: { product_id: 'prod_c', sku_id: 'prod_c', brand: 'Brand C', display_name: 'Brand C Serum' } },
          ],
          logger: null,
        });

        assert.equal(stableResolveCalls, 1);
        assert.equal(Array.isArray(out?.recommendations), true);
        assert.equal(out.recommendations.length, 3);
        assert.equal(out.recommendations[0]?.metadata?.pdp_open_path, 'internal');
        assert.equal(out.recommendations[1]?.metadata?.pdp_open_path, 'external');
        assert.equal(out.recommendations[2]?.metadata?.pdp_open_path, 'external');
        assert.equal(out.recommendations[1]?.metadata?.stable_resolve_request_ids, undefined);
        assert.equal(out.recommendations[2]?.metadata?.stable_resolve_request_ids, undefined);
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Stable-id resolves from local stable-alias map without upstream offers.resolve', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let postCalls = 0;
      axios.post = async (url) => {
        postCalls += 1;
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.resolveRecoPdpByStableIds({
          skuId: 'f16c11ec-ccfa-41d6-a43b-4fcfa4e706cb',
          brand: 'Winona',
          displayName: 'Soothing Repair Serum',
          logger: null,
        });

        assert.equal(postCalls, 0);
        assert.equal(out?.ok, true);
        assert.equal(out?.resolveAttempted, false);
        assert.equal(out?.reasonCode, 'stable_alias_ref');
        assert.equal(out?.canonicalProductRef?.product_id, '9886500749640');
        assert.equal(out?.canonicalProductRef?.merchant_id, 'merch_efbc46b4619cfbdf');
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('UUID-only sku does not send product_ref hint and avoids duplicated brand in resolve query', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_FAILURE: 'false',
      AURORA_BFF_RECO_PDP_SKIP_OPAQUE_STABLE_IDS: 'true',
    },
    async () => {
      const originalPost = axios.post;
      let capturedBody = null;
      let stableInvokeCalls = 0;
      let queryResolveCalls = 0;
      axios.post = async (url, body) => {
        if (String(url).includes('/agent/shop/v1/invoke')) {
          stableInvokeCalls += 1;
          throw new Error(`Unexpected axios.post: ${url}`);
        }
        if (!String(url).includes('/agent/v1/products/resolve')) throw new Error(`Unexpected axios.post: ${url}`);
        queryResolveCalls += 1;
        capturedBody = body;
        return {
          status: 200,
          data: {
            resolved: false,
            product_ref: null,
            reason: 'no_candidates',
            reason_code: 'no_candidates',
            candidates: [],
          },
        };
      };

      try {
        const { __internal } = loadRoutesFresh();
        const enriched = await __internal.enrichRecoItemWithPdpOpenContract({
          sku: {
            brand: 'BrandX',
            display_name: 'BrandX Barrier Serum',
            product_id: '11111111-2222-4333-8444-555555555555',
            sku_id: '11111111-2222-4333-8444-555555555555',
          },
        }, { logger: null });

        assert.ok(capturedBody);
        assert.equal(capturedBody.query, 'BrandX Barrier Serum');
        assert.equal(capturedBody?.hints?.product_ref, undefined);
        const aliases = Array.isArray(capturedBody?.hints?.aliases) ? capturedBody.hints.aliases : [];
        assert.equal(aliases.some((v) => String(v).toLowerCase().includes('brandx brandx')), false);
        assert.equal(stableInvokeCalls, 0);
        assert.ok(queryResolveCalls >= 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'external');
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Stable-id upstream timeout skips query products.resolve when configured', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_FAILURE: 'true',
      AURORA_BFF_RECO_PDP_FAST_EXTERNAL_FALLBACK: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let stableInvokeCalls = 0;
      let queryResolveCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/shop/v1/invoke') {
          stableInvokeCalls += 1;
          return {
            status: 504,
            data: {
              status: 'error',
              reason: 'upstream_timeout',
              reason_code: 'upstream_timeout',
              metadata: { request_id: 'rid_stable_timeout' },
            },
          };
        }
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: true,
              reason: 'resolved',
              reason_code: 'resolved',
              product_ref: { product_id: 'prod_should_not_be_used', merchant_id: 'mid_should_not_be_used' },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
          {
            sku: {
              brand: 'TimeoutBrand',
              name: 'Timeout Serum',
              product_id: 'prod_timeout_123',
              sku_id: 'prod_timeout_123',
            },
          },
          { logger: null },
        );

        assert.equal(stableInvokeCalls, 1);
        assert.equal(queryResolveCalls, 0);
        assert.equal(enriched?.metadata?.pdp_open_path, 'external');
        assert.equal(enriched?.metadata?.resolve_reason_code, 'upstream_timeout');
        assert.equal(enriched?.metadata?.pdp_open_resolve_attempted, true);
        assert.deepEqual(enriched?.metadata?.stable_resolve_request_ids, { primary: 'rid_stable_timeout' });
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Stable-id no_candidates skips query products.resolve when configured', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_FAILURE: 'true',
      AURORA_BFF_RECO_PDP_SKIP_QUERY_RESOLVE_ON_STABLE_NO_CANDIDATES: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let stableInvokeCalls = 0;
      let queryResolveCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/shop/v1/invoke') {
          stableInvokeCalls += 1;
          return {
            status: 200,
            data: {
              status: 'error',
              reason: 'no_candidates',
              reason_code: 'no_candidates',
              metadata: { request_id: 'rid_stable_no_candidates' },
            },
          };
        }
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: true,
              reason: 'resolved',
              reason_code: 'resolved',
              product_ref: { product_id: 'prod_should_not_be_used', merchant_id: 'mid_should_not_be_used' },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
          {
            sku: {
              brand: 'NoCandidateBrand',
              name: 'NoCandidate Serum',
              product_id: 'prod_no_candidate_123',
              sku_id: 'prod_no_candidate_123',
            },
          },
          { logger: null },
        );

        assert.equal(stableInvokeCalls, 1);
        assert.equal(queryResolveCalls, 0);
        assert.equal(enriched?.metadata?.pdp_open_path, 'external');
        assert.equal(enriched?.metadata?.resolve_reason_code, 'no_candidates');
        assert.equal(enriched?.metadata?.pdp_open_resolve_attempted, true);
        assert.deepEqual(enriched?.metadata?.stable_resolve_request_ids, { primary: 'rid_stable_no_candidates' });
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Query resolve no_candidates uses local products.resolve fallback', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_NO_CANDIDATES: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
    },
    async () => {
      const originalPost = axios.post;
      let primaryResolveCalls = 0;
      let localResolveCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          primaryResolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: false,
              reason: 'no_candidates',
              reason_code: 'no_candidates',
              product_ref: null,
            },
          };
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/resolve') {
          localResolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: true,
              reason: 'stable_alias_match',
              reason_code: 'stable_alias_match',
              product_ref: {
                product_id: 'prod_winona_repair',
                merchant_id: 'mid_winona',
              },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const enriched = await __internal.enrichRecoItemWithPdpOpenContract({
          sku: {
            brand: 'BrandX',
            display_name: 'BrandX Repair Serum',
          },
        }, { logger: null });

        assert.equal(primaryResolveCalls, 1);
        assert.equal(localResolveCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'resolve');
        assert.equal(enriched?.pdp_open?.path, 'resolve');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_winona_repair');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_winona');
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Query resolve upstream_timeout uses deterministic local resolver fallback in strict internal mode', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let queryResolveCalls = 0;
      let localResolverCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          const timeoutErr = new Error('resolve timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      let internal = null;
      try {
        const { __internal } = loadRoutesFresh();
        internal = __internal;
        __internal.__setResolveProductRefForTest(async () => {
          localResolverCalls += 1;
          return {
            resolved: true,
            reason: 'stable_alias_match',
            reason_code: 'stable_alias_match',
            product_ref: {
              product_id: 'prod_local_resolve',
              merchant_id: 'mid_local_resolve',
            },
            candidates: [{ title: 'FallbackBrand Repair Essence' }],
          };
        });

        const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
          {
            sku: {
              brand: 'FallbackBrand',
              display_name: 'FallbackBrand Repair Essence',
            },
          },
          { logger: null, allowLocalInvokeFallback: false },
        );

        assert.equal(queryResolveCalls, 1);
        assert.equal(localResolverCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'resolve');
        assert.equal(enriched?.pdp_open?.path, 'resolve');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_local_resolve');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_local_resolve');
      } finally {
        if (internal && typeof internal.__resetResolveProductRefForTest === 'function') {
          internal.__resetResolveProductRefForTest();
        }
        axios.post = originalPost;
      }
    },
  );
});

test('Query resolve upstream_timeout uses local HTTP resolver fallback when direct resolver is unavailable', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
      AURORA_BFF_RECO_PDP_RESOLVE_TIMEOUT_MS: '900',
      AURORA_BFF_RECO_PDP_RESOLVE_TIMEOUT_STRICT_MIN_MS: '2200',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let primaryResolveCalls = 0;
      let localHttpResolveCalls = 0;

      axios.post = async (url, body, config) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          primaryResolveCalls += 1;
          assert.equal(body?.options?.timeout_ms, 2200);
          assert.equal(Number(config?.timeout || 0), 2200);
          const timeoutErr = new Error('resolve timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/resolve') {
          localHttpResolveCalls += 1;
          assert.equal(body?.options?.timeout_ms, 2200);
          assert.equal(Number(config?.timeout || 0), 2200);
          return {
            status: 200,
            data: {
              resolved: true,
              reason: 'stable_alias_match',
              reason_code: 'stable_alias_match',
              product_ref: {
                product_id: 'prod_local_http_fallback',
                merchant_id: 'mid_local_http_fallback',
              },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      let internal = null;
      try {
        const { __internal } = loadRoutesFresh();
        internal = __internal;
        __internal.__setResolveProductRefForTest(null);

        const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
          {
            sku: {
              brand: 'FallbackBrand',
              display_name: 'FallbackBrand Repair Essence',
            },
          },
          { logger: null, allowLocalInvokeFallback: false },
        );

        assert.equal(primaryResolveCalls, 1);
        assert.equal(localHttpResolveCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'resolve');
        assert.equal(enriched?.pdp_open?.path, 'resolve');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_local_http_fallback');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_local_http_fallback');
      } finally {
        if (internal && typeof internal.__resetResolveProductRefForTest === 'function') {
          internal.__resetResolveProductRefForTest();
        }
        axios.post = originalPost;
      }
    },
  );
});

test('Query resolve upstream_timeout retries local HTTP resolver after direct local resolver transient failure', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
      AURORA_BFF_RECO_PDP_RESOLVE_TIMEOUT_MS: '900',
      AURORA_BFF_RECO_PDP_RESOLVE_TIMEOUT_STRICT_MIN_MS: '2200',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let primaryResolveCalls = 0;
      let localHttpResolveCalls = 0;

      axios.post = async (url, body, config) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          primaryResolveCalls += 1;
          assert.equal(body?.options?.timeout_ms, 2200);
          assert.equal(Number(config?.timeout || 0), 2200);
          const timeoutErr = new Error('resolve timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/resolve') {
          localHttpResolveCalls += 1;
          assert.equal(body?.options?.timeout_ms, 2200);
          assert.equal(Number(config?.timeout || 0), 2200);
          return {
            status: 200,
            data: {
              resolved: true,
              reason: 'stable_alias_match',
              reason_code: 'stable_alias_match',
              product_ref: {
                product_id: 'prod_local_http_after_direct',
                merchant_id: 'mid_local_http_after_direct',
              },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      let internal = null;
      try {
        const { __internal } = loadRoutesFresh();
        internal = __internal;
        __internal.__setResolveProductRefForTest(async () => ({
          resolved: false,
          reason: 'upstream_timeout',
          reason_code: 'upstream_timeout',
          product_ref: null,
        }));

        const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
          {
            sku: {
              brand: 'FallbackBrand',
              display_name: 'FallbackBrand Recovery Gel',
            },
          },
          { logger: null, allowLocalInvokeFallback: false },
        );

        assert.equal(primaryResolveCalls, 1);
        assert.equal(localHttpResolveCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'resolve');
        assert.equal(enriched?.pdp_open?.path, 'resolve');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_local_http_after_direct');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_local_http_after_direct');
      } finally {
        if (internal && typeof internal.__resetResolveProductRefForTest === 'function') {
          internal.__resetResolveProductRefForTest();
        }
        axios.post = originalPost;
      }
    },
  );
});
test('Query resolve upstream_timeout uses catalog search fallback in strict internal mode for named products', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'false',
      AURORA_BFF_RECO_PDP_SKIP_OPAQUE_STABLE_IDS: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      const originalGet = axios.get;
      let queryResolveCalls = 0;
      let catalogSearchCalls = 0;

      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          return {
            status: 504,
            data: {
              resolved: false,
              reason: 'upstream_timeout',
              reason_code: 'upstream_timeout',
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };
      axios.get = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/search') {
          catalogSearchCalls += 1;
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'prod_catalog_timeout_recover',
                  merchant_id: 'mid_catalog_timeout_recover',
                  brand: 'Dr. Wu',
                  name: 'Daily Renewal Serum',
                  display_name: 'Dr. Wu Daily Renewal Serum (8% total acids)',
                  category: 'treatment',
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected axios.get: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const enriched = await __internal.enrichRecoItemWithPdpOpenContract({
          sku: {
            brand: 'Dr. Wu',
            display_name: 'Dr. Wu Daily Renewal Serum (8% total acids)',
            product_id: '6f747804-4f8d-4ad7-a0f6-19b9672247c1',
            sku_id: '6f747804-4f8d-4ad7-a0f6-19b9672247c1',
            category: 'treatment',
          },
        }, { logger: null });

        assert.equal(queryResolveCalls, 1);
        assert.equal(catalogSearchCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'ref');
        assert.equal(enriched?.pdp_open?.path, 'ref');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_catalog_timeout_recover');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_catalog_timeout_recover');
      } finally {
        axios.post = originalPost;
        axios.get = originalGet;
      }
    },
  );
});

test('Query resolve upstream_timeout forces local catalog search fallback when primary search times out', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
      AURORA_BFF_RECO_PDP_SKIP_OPAQUE_STABLE_IDS: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      const originalGet = axios.get;
      let queryResolveCalls = 0;
      let localResolveCalls = 0;
      let primarySearchCalls = 0;
      let localSearchCalls = 0;

      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          return {
            status: 504,
            data: {
              resolved: false,
              reason: 'upstream_timeout',
              reason_code: 'upstream_timeout',
            },
          };
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/resolve') {
          localResolveCalls += 1;
          return {
            status: 504,
            data: {
              resolved: false,
              reason: 'upstream_timeout',
              reason_code: 'upstream_timeout',
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };
      axios.get = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/search') {
          primarySearchCalls += 1;
          const err = new Error('upstream timeout');
          err.code = 'ECONNABORTED';
          throw err;
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/search') {
          localSearchCalls += 1;
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'prod_local_timeout_recover',
                  merchant_id: 'mid_local_timeout_recover',
                  brand: 'The Ordinary',
                  name: 'Glycolic Acid 7% Toning Solution',
                  display_name: 'The Ordinary Glycolic Acid 7% Toning Solution',
                  category: 'treatment',
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected axios.get: ${target}`);
      };

      let internal = null;
      try {
        const { __internal } = loadRoutesFresh();
        internal = __internal;
        __internal.__setResolveProductRefForTest(null);
        const enriched = await __internal.enrichRecoItemWithPdpOpenContract({
          sku: {
            brand: 'The Ordinary',
            display_name: 'The Ordinary Glycolic Acid 7% Toning Solution',
            product_id: '9b07d4ae-b1b4-42d5-bd6d-391a83f800c8',
            sku_id: '9b07d4ae-b1b4-42d5-bd6d-391a83f800c8',
            category: 'treatment',
          },
        }, { logger: null });

        assert.equal(queryResolveCalls, 1);
        assert.equal(localResolveCalls, 1);
        assert.equal(primarySearchCalls, 1);
        assert.equal(localSearchCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'ref');
        assert.equal(enriched?.pdp_open?.path, 'ref');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_local_timeout_recover');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_local_timeout_recover');
      } finally {
        if (internal && typeof internal.__resetResolveProductRefForTest === 'function') {
          internal.__resetResolveProductRefForTest();
        }
        axios.post = originalPost;
        axios.get = originalGet;
      }
    },
  );
});

test('Query resolve no_candidates with opaque UUID ids uses deterministic local resolver fallback in strict internal mode', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let queryResolveCalls = 0;
      let localResolverCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: false,
              reason: 'no_candidates',
              reason_code: 'no_candidates',
              product_ref: null,
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      let internal = null;
      try {
        const { __internal } = loadRoutesFresh();
        internal = __internal;
        __internal.__setResolveProductRefForTest(async () => {
          localResolverCalls += 1;
          return {
            resolved: true,
            reason: 'stable_alias_match',
            reason_code: 'stable_alias_match',
            product_ref: {
              product_id: 'prod_local_uuid_no_candidates',
              merchant_id: 'mid_local_uuid_no_candidates',
            },
            candidates: [{ title: "Paula's Choice 2% BHA Liquid" }],
          };
        });

        const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
          {
            sku: {
              brand: "Paula's Choice",
              display_name: "Paula's Choice 2% BHA Liquid",
              product_id: '6cc87c1c-cf3c-4c0f-a3f4-ef28fc3f47e7',
              sku_id: '6cc87c1c-cf3c-4c0f-a3f4-ef28fc3f47e7',
            },
          },
          { logger: null, allowLocalInvokeFallback: false },
        );

        assert.equal(queryResolveCalls, 1);
        assert.equal(localResolverCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'resolve');
        assert.equal(enriched?.pdp_open?.path, 'resolve');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_local_uuid_no_candidates');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_local_uuid_no_candidates');
      } finally {
        if (internal && typeof internal.__resetResolveProductRefForTest === 'function') {
          internal.__resetResolveProductRefForTest();
        }
        axios.post = originalPost;
      }
    },
  );
});

test('Opaque UUID no_candidates falls back to catalog search in strict internal mode', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      const originalGet = axios.get;
      let queryResolveCalls = 0;
      let localResolverCalls = 0;
      let catalogSearchCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          queryResolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: false,
              reason: 'no_candidates',
              reason_code: 'no_candidates',
              product_ref: null,
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };
      axios.get = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/search') {
          catalogSearchCalls += 1;
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'prod_from_catalog_search',
                  merchant_id: 'mid_from_catalog_search',
                  brand: "Paula's Choice",
                  name: '2% BHA Liquid',
                  display_name: "Paula's Choice 2% BHA Liquid",
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected axios.get: ${target}`);
      };

      let internal = null;
      try {
        const { __internal } = loadRoutesFresh();
        internal = __internal;
        __internal.__setResolveProductRefForTest(async () => {
          localResolverCalls += 1;
          return {
            resolved: false,
            reason: 'no_candidates',
            reason_code: 'no_candidates',
            product_ref: null,
          };
        });

        const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
          {
            sku: {
              brand: "Paula's Choice",
              display_name: "Paula's Choice 2% BHA Liquid",
              product_id: '6cc87c1c-cf3c-4c0f-a3f4-ef28fc3f47e7',
              sku_id: '6cc87c1c-cf3c-4c0f-a3f4-ef28fc3f47e7',
            },
          },
          { logger: null, allowLocalInvokeFallback: false },
        );

        assert.equal(queryResolveCalls, 1);
        assert.equal(localResolverCalls, 1);
        assert.equal(catalogSearchCalls, 1);
        assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
        assert.equal(enriched?.metadata?.pdp_open_mode, 'ref');
        assert.equal(enriched?.pdp_open?.path, 'ref');
        assert.equal(enriched?.pdp_open?.product_ref?.product_id, 'prod_from_catalog_search');
        assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'mid_from_catalog_search');
      } finally {
        if (internal && typeof internal.__resetResolveProductRefForTest === 'function') {
          internal.__resetResolveProductRefForTest();
        }
        axios.post = originalPost;
        axios.get = originalGet;
      }
    },
  );
});

test('Availability resolve: primary timeout falls back to local products.resolve', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ON_UPSTREAM_TIMEOUT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
    },
    async () => {
      const originalPost = axios.post;
      let primaryResolveCalls = 0;
      let localResolveCalls = 0;
      axios.post = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/resolve') {
          primaryResolveCalls += 1;
          const timeoutErr = new Error('timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/resolve') {
          localResolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: true,
              reason: 'stable_alias_match',
              reason_code: 'stable_alias_match',
              product_ref: {
                product_id: 'prod_winona_repair',
                merchant_id: 'mid_winona',
              },
              candidates: [
                {
                  name: 'Winona Soothing Repair Serum',
                  brand: 'Winona',
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.resolveAvailabilityProductByQuery({
          query: 'Winona Soothing Repair Serum',
          lang: 'en',
          hints: { brand: 'Winona', aliases: ['Winona Soothing Repair Serum'] },
          logger: null,
        });

        assert.equal(primaryResolveCalls, 1);
        assert.equal(localResolveCalls, 1);
        assert.equal(out?.ok, true);
        assert.equal(out?.product?.canonical_product_ref?.product_id, 'prod_winona_repair');
        assert.equal(out?.product?.canonical_product_ref?.merchant_id, 'mid_winona');
        assert.equal(out?.product?.display_name, 'Winona Soothing Repair Serum');
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Availability resolve: passes zh locale and hints payload to resolver', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalPost = axios.post;
      let capturedBody = null;
      axios.post = async (url, body) => {
        if (!String(url).includes('/agent/v1/products/resolve')) {
          throw new Error(`Unexpected axios.post: ${url}`);
        }
        capturedBody = body;
        return {
          status: 200,
          data: {
            resolved: false,
            reason: 'no_candidates',
            reason_code: 'no_candidates',
            product_ref: null,
            candidates: [],
          },
        };
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.resolveAvailabilityProductByQuery({
          query: 'Winona Soothing Repair Serum',
          lang: 'CN',
          hints: { brand: '薇诺娜', aliases: ['Winona Soothing Repair Serum'] },
          logger: null,
        });

        assert.ok(capturedBody);
        assert.equal(capturedBody.lang, 'zh');
        assert.equal(capturedBody?.hints?.brand, '薇诺娜');
        assert.deepEqual(capturedBody?.hints?.aliases, ['Winona Soothing Repair Serum']);
        assert.equal(out?.ok, false);
        assert.equal(out?.resolve_reason_code, 'no_candidates');
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('Catalog search: primary timeout uses local search fallback', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
    },
    async () => {
      const originalGet = axios.get;
      let primaryCalls = 0;
      let localCalls = 0;
      axios.get = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/search') {
          primaryCalls += 1;
          const timeoutErr = new Error('primary timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/search') {
          localCalls += 1;
          return {
            status: 200,
            data: {
              products: [
                {
                  product_id: 'prod_winona_repair',
                  merchant_id: 'mid_winona',
                  brand: 'Winona',
                  name: 'Soothing Repair Serum',
                  display_name: 'Winona Soothing Repair Serum',
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected axios.get: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.searchPivotaBackendProducts({
          query: 'winona soothing repair serum',
          limit: 6,
          logger: null,
        });

        assert.equal(primaryCalls, 1);
        assert.equal(localCalls, 1);
        assert.equal(out?.ok, true);
        assert.equal(Array.isArray(out?.products), true);
        assert.equal(out.products.length, 1);
        assert.equal(out.products[0]?.product_id, 'prod_winona_repair');
        assert.equal(out.products[0]?.merchant_id, 'mid_winona');
      } finally {
        axios.get = originalGet;
      }
    },
  );
});

test('/v1/chat availability: specific query uses catalog hit directly without resolve fallback', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let resolveCalls = 0;

      axios.get = async (url) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        searchCalls += 1;
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_winona_repair',
                merchant_id: 'mid_winona',
                brand: 'Winona',
                name: 'Soothing Repair Serum',
                display_name: 'Winona Soothing Repair Serum',
              },
            ],
          },
        };
      };

      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) resolveCalls += 1;
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'test_uid_availability_resolve_first',
            'X-Trace-ID': 'test_trace_availability_resolve_first',
            'X-Brief-ID': 'test_brief_availability_resolve_first',
            'X-Lang': 'EN',
          },
          body: {
            message: 'Do you have Winona Soothing Repair Serum?',
            session: {
              state: 'idle',
              profile: {
                skinType: 'sensitive',
                sensitivity: 'high',
                barrierStatus: 'impaired',
                goals: ['reduce redness'],
              },
            },
            language: 'EN',
          },
        });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const offers = cards.find((card) => card && card.type === 'offers_resolved');
        const items = Array.isArray(offers?.payload?.items) ? offers.payload.items : [];
        const first = items[0] || null;

        assert.equal(resolveCalls, 0);
        assert.equal(searchCalls, 1);
        assert.ok(first);
        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat availability: generic non-whitelist product query short-circuits to catalog search', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let resolveCalls = 0;

      axios.get = async (url) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        searchCalls += 1;
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: 'prod_to_niacinamide',
                merchant_id: 'mid_to',
                brand: 'The Ordinary',
                name: 'Niacinamide 10% + Zinc 1%',
                display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              },
            ],
          },
        };
      };

      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) {
          resolveCalls += 1;
          throw new Error(`Unexpected resolve fallback for generic availability path: ${url}`);
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'test_uid_availability_generic_non_whitelist',
            'X-Trace-ID': 'test_trace_availability_generic_non_whitelist',
            'X-Brief-ID': 'test_brief_availability_generic_non_whitelist',
            'X-Lang': 'EN',
          },
          body: {
            message: 'Do you have The Ordinary Niacinamide 10% + Zinc 1%?',
            session: {
              state: 'idle',
              profile: {
                skinType: 'oily',
                sensitivity: 'low',
                barrierStatus: 'healthy',
                goals: ['acne'],
              },
            },
            language: 'EN',
          },
        });

        assert.equal(resp.status, 200);
        assert.equal(searchCalls, 1);
        assert.equal(resolveCalls, 0);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const offers = cards.find((card) => card && card.type === 'offers_resolved');
        const items = Array.isArray(offers?.payload?.items) ? offers.payload.items : [];
        const first = items[0] || null;
        assert.ok(first);
        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat availability: generic brand query skips resolve fallback on transient search failure by default', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_ON_TRANSIENT: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let resolveCalls = 0;

      axios.get = async (url) => {
        if (String(url).includes('/agent/v1/products/search')) {
          searchCalls += 1;
          const timeoutErr = new Error('search timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      };

      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) {
          resolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: true,
              product_ref: {
                product_id: 'prod_should_not_be_used',
                merchant_id: 'mid_should_not_be_used',
              },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'test_uid_availability_generic_transient',
            'X-Trace-ID': 'test_trace_availability_generic_transient',
            'X-Brief-ID': 'test_brief_availability_generic_transient',
            'X-Lang': 'CN',
          },
          body: {
            message: '有没有薇诺娜的产品？',
            session: {
              state: 'idle',
              profile: {
                skinType: 'sensitive',
                sensitivity: 'high',
                barrierStatus: 'impaired',
                goals: ['reduce redness'],
              },
            },
            language: 'CN',
          },
        });

        assert.equal(resp.status, 200);
        assert.equal(searchCalls, 1);
        assert.equal(resolveCalls, 0);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const offers = cards.find((card) => card && card.type === 'offers_resolved');
        const items = Array.isArray(offers?.payload?.items) ? offers.payload.items : [];
        const first = items[0] || null;
        assert.ok(first);
        assert.equal(first?.metadata?.pdp_open_path, 'external');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat availability: generic concrete query uses local resolver on soft-timeout (no external fallback)', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_ON_TRANSIENT: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let resolveCalls = 0;
      let localResolverCalls = 0;
      let internal = null;

      axios.get = async (url) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        searchCalls += 1;
        return {
          status: 200,
          data: {
            status: 'success',
            success: true,
            products: [],
            total: 0,
            metadata: {
              query_source: 'agent_products_error_fallback',
              proxy_search_fallback: {
                applied: true,
                reason: 'primary_timeout',
                upstream_status: 504,
                upstream_error_code: 'ECONNABORTED',
              },
            },
          },
        };
      };

      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) resolveCalls += 1;
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const loaded = loadRoutesFresh();
        internal = loaded.__internal;
        internal.__setResolveProductRefForTest(async () => {
          localResolverCalls += 1;
          return {
            resolved: true,
            reason: 'stable_alias_match',
            reason_code: 'stable_alias_match',
            product_ref: {
              product_id: 'prod_generic_local_fallback',
              merchant_id: 'mid_generic_local_fallback',
            },
            candidates: [{ title: 'The Ordinary Niacinamide 10% + Zinc 1%' }],
          };
        });
        const { mountAuroraBffRoutes } = loaded;
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'test_uid_availability_generic_soft_timeout',
            'X-Trace-ID': 'test_trace_availability_generic_soft_timeout',
            'X-Brief-ID': 'test_brief_availability_generic_soft_timeout',
            'X-Lang': 'EN',
          },
          body: {
            message: 'Do you have The Ordinary Niacinamide 10% + Zinc 1%?',
            session: {
              state: 'idle',
              profile: {
                skinType: 'oily',
                sensitivity: 'low',
                barrierStatus: 'healthy',
                goals: ['acne'],
              },
            },
            language: 'EN',
          },
        });

        assert.equal(resp.status, 200);
        assert.equal(searchCalls, 1);
        assert.equal(resolveCalls, 0);
        assert.equal(localResolverCalls, 1);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const offers = cards.find((card) => card && card.type === 'offers_resolved');
        const items = Array.isArray(offers?.payload?.items) ? offers.payload.items : [];
        const first = items[0] || null;
        assert.ok(first);
        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
        assert.equal(first?.pdp_open?.product_ref?.product_id, 'prod_generic_local_fallback');
        assert.equal(first?.pdp_open?.product_ref?.merchant_id, 'mid_generic_local_fallback');

        const events = Array.isArray(resp.body?.events) ? resp.body.events : [];
        const availabilityEvent = events.find((event) => event && event.event_name === 'catalog_availability_shortcircuit');
        assert.ok(availabilityEvent);
        assert.equal(availabilityEvent?.data?.specific_query, true);
        assert.equal(availabilityEvent?.data?.catalog_reason, 'upstream_timeout');
        assert.equal(availabilityEvent?.data?.resolved_via, 'local_resolver');
        assert.equal(availabilityEvent?.data?.local_resolve_attempted, true);
      } finally {
        if (internal && typeof internal.__resetResolveProductRefForTest === 'function') {
          internal.__resetResolveProductRefForTest();
        }
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat availability: specific query runs resolve fallback on transient search timeout when enabled', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_ON_TRANSIENT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let resolveCalls = 0;

      axios.get = async (url) => {
        if (String(url).includes('/agent/v1/products/search')) {
          searchCalls += 1;
          const timeoutErr = new Error('search timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      };

      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) {
          resolveCalls += 1;
          return {
            status: 200,
            data: {
              resolved: true,
              product_ref: {
                product_id: 'prod_should_not_be_used',
                merchant_id: 'mid_should_not_be_used',
              },
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'test_uid_availability_specific_transient',
            'X-Trace-ID': 'test_trace_availability_specific_transient',
            'X-Brief-ID': 'test_brief_availability_specific_transient',
            'X-Lang': 'CN',
          },
          body: {
            message: '有没有薇诺娜舒敏修护精华',
            session: {
              state: 'idle',
              profile: {
                skinType: 'sensitive',
                sensitivity: 'high',
                barrierStatus: 'impaired',
                goals: ['reduce redness'],
              },
            },
            language: 'CN',
          },
        });

        assert.equal(resp.status, 200);
        assert.equal(searchCalls, 1);
        assert.equal(resolveCalls, 1);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const offers = cards.find((card) => card && card.type === 'offers_resolved');
        const items = Array.isArray(offers?.payload?.items) ? offers.payload.items : [];
        const first = items[0] || null;
        assert.ok(first);
        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
        assert.equal(first?.pdp_open?.product_ref?.product_id, 'prod_should_not_be_used');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('Internal canonical product ref rewrites sku identifiers for PDP compatibility', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
    },
    async () => {
      const { __internal } = loadRoutesFresh();
      const enriched = await __internal.enrichRecoItemWithPdpOpenContract({
        sku: {
          brand: 'The Ordinary',
          display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
          product_id: 'c231aaaa-8b00-4145-a704-684931049303',
          sku_id: 'c231aaaa-8b00-4145-a704-684931049303',
          canonical_product_ref: {
            product_id: '9886499864904',
            merchant_id: 'merch_efbc46b4619cfbdf',
          },
        },
      }, { logger: null });

      assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
      assert.equal(enriched?.metadata?.pdp_open_mode, 'ref');
      assert.equal(enriched?.pdp_open?.path, 'ref');
      assert.equal(enriched?.pdp_open?.product_ref?.product_id, '9886499864904');
      assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'merch_efbc46b4619cfbdf');
      assert.equal(enriched?.sku?.product_id, '9886499864904');
      assert.equal(enriched?.sku?.sku_id, '9886499864904');
      assert.equal(enriched?.sku?.merchant_id, 'merch_efbc46b4619cfbdf');
    },
  );
});

test('Stable alias fallback keeps internal PDP ref when resolve is disabled', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_STRICT_INTERNAL_FIRST: 'true',
      PIVOTA_BACKEND_BASE_URL: '',
    },
    async () => {
      const { __internal } = loadRoutesFresh();
      const enriched = await __internal.enrichRecoItemWithPdpOpenContract(
        {
          sku: {
            brand: 'IPSA',
            display_name: 'IPSA Time Reset Aqua',
            product_id: 'e7c90e06-8673-4c97-835d-074a26ab2162',
            sku_id: 'e7c90e06-8673-4c97-835d-074a26ab2162',
          },
        },
        { logger: null },
      );

      assert.equal(enriched?.metadata?.pdp_open_path, 'internal');
      assert.equal(enriched?.metadata?.pdp_open_mode, 'ref');
      assert.equal(enriched?.pdp_open?.path, 'ref');
      assert.equal(enriched?.pdp_open?.product_ref?.product_id, '9886500127048');
      assert.equal(enriched?.pdp_open?.product_ref?.merchant_id, 'merch_efbc46b4619cfbdf');
      assert.equal(enriched?.sku?.product_id, '9886500127048');
      assert.equal(enriched?.sku?.sku_id, '9886500127048');
      assert.equal(enriched?.sku?.merchant_id, 'merch_efbc46b4619cfbdf');
      assert.notEqual(enriched?.metadata?.pdp_open_resolve_attempted, true);
    },
  );
});

test('Reco seed limiter caps known seed products and keeps non-seed diversity', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_TEST_SEED_MAX_PER_RESPONSE: '1',
      AURORA_BFF_RECO_TEST_SEED_MIN_TOTAL: '3',
    },
    async () => {
      const { __internal } = loadRoutesFresh();
      const input = [
        { sku: { brand: 'Winona', display_name: 'Winona Soothing Repair Serum', product_id: 'a39dd7a3-5d80-4cb3-82e1-3bf2707f65fc' } },
        { sku: { brand: 'IPSA', display_name: 'IPSA Time Reset Aqua', product_id: 'e7c90e06-8673-4c97-835d-074a26ab2162' } },
        { sku: { brand: 'CeraVe', display_name: 'CeraVe Hydrating Cleanser', product_id: 'pid_cerave_cleanser' } },
        { sku: { brand: 'The Ordinary', display_name: 'The Ordinary Buffet + Copper Peptides 1%', product_id: 'to_copper_peptides' } },
        { sku: { brand: 'La Roche-Posay', display_name: 'Cicaplast Baume B5', product_id: 'pid_cicaplast' } },
      ];

      const out = __internal.limitRecoKnownTestSeedRecommendations(input);
      assert.equal(out.applied, true);
      assert.equal(out.seed_count_before, 3);
      assert.equal(out.seed_count_after, 1);
      assert.equal(out.filtered_count, 2);
      assert.equal(out.recommendations.length, 3);

      const keptSeedCount = out.recommendations.filter((item) => __internal.isRecoKnownTestSeedItem(item)).length;
      assert.equal(keptSeedCount, 1);
      assert.ok(out.recommendations.some((item) => String(item?.sku?.display_name || '').includes('CeraVe')));
      assert.ok(out.recommendations.some((item) => String(item?.sku?.display_name || '').includes('Cicaplast')));
    },
  );
});

test('Reco diversity guard suppresses repeated recent exposures while keeping minimum list size', async () => {
  await withEnv({}, async () => {
    const { __internal } = loadRoutesFresh();
    const input = [
      { sku: { brand: 'Winona', display_name: 'Winona Soothing Repair Serum', product_id: 'a39dd7a3-5d80-4cb3-82e1-3bf2707f65fc' } },
      { sku: { brand: 'IPSA', display_name: 'IPSA Time Reset Aqua', product_id: 'e7c90e06-8673-4c97-835d-074a26ab2162' } },
      { sku: { brand: 'CeraVe', display_name: 'CeraVe Hydrating Cleanser', product_id: 'pid_cerave_cleanser' } },
      { sku: { brand: 'La Roche-Posay', display_name: 'Cicaplast Baume B5', product_id: 'pid_cicaplast' } },
    ];
    const historyTokens = [
      __internal.buildRecoDiversityToken(input[0]),
      __internal.buildRecoDiversityToken(input[1]),
    ].filter(Boolean);

    const out = __internal.applyRecoRecentDiversityGuard(input, {
      historyTokens,
      maxRepeatPerResponse: 1,
      minTotal: 3,
    });

    assert.equal(out.applied, true);
    assert.equal(out.repeated_before, 2);
    assert.equal(out.repeated_after, 1);
    assert.equal(out.filtered_count, 1);
    assert.equal(Array.isArray(out.recommendations), true);
    assert.equal(out.recommendations.length, 3);

    const repeatedAfter = out.recommendations
      .map((item) => __internal.buildRecoDiversityToken(item))
      .filter((token) => historyTokens.includes(token)).length;
    assert.equal(repeatedAfter, 1);
  });
});

test('Offers resolve db_error: canonical ref still keeps internal PDP open contract', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      axios.post = async (url) => {
        if (!String(url).includes('/api/offers/external/resolve')) {
          throw new Error(`Unexpected axios.post: ${url}`);
        }
        return {
          status: 503,
          data: {
            ok: false,
            reason_code: 'db_error',
            reason: 'products_cache_missing',
          },
        };
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/offers/resolve', {
          headers: { 'X-Aurora-UID': 'test_uid_offer_resolve_db_error' },
          body: {
            market: 'US',
            items: [
              {
                product: {
                  product_id: 'prod_to_niacinamide',
                  merchant_id: 'mid_to',
                  canonical_product_ref: {
                    product_id: 'prod_to_niacinamide',
                    merchant_id: 'mid_to',
                  },
                  name: 'Niacinamide 10% + Zinc 1%',
                  brand: 'The Ordinary',
                },
                offer: {
                  affiliate_url: 'https://example.com/p/ordinary-niacinamide',
                  price: 10.9,
                  currency: 'USD',
                },
              },
            ],
          },
        });

        assert.equal(resp.status, 200);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const card = cards.find((c) => c && c.type === 'offers_resolved');
        assert.ok(card);
        const items = Array.isArray(card?.payload?.items) ? card.payload.items : [];
        assert.equal(items.length, 1);
        const first = items[0];

        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
        assert.equal(first?.metadata?.pdp_open_fail_reason, 'db_error');
        assert.equal(first?.metadata?.resolve_fail_reason, 'db_error');
        assert.equal(typeof first?.metadata?.time_to_pdp_ms, 'number');
        assert.ok(first?.metadata?.time_to_pdp_ms >= 0);
        assert.equal(first?.pdp_open?.path, 'ref');
        assert.equal(first?.pdp_open?.product_ref?.product_id, 'prod_to_niacinamide');
        assert.equal(first?.pdp_open?.product_ref?.merchant_id, 'mid_to');
        assert.equal(first?.pdp_open?.external, undefined);

        const pdpStats = card?.payload?.metadata?.pdp_open_path_stats || {};
        const failStats = card?.payload?.metadata?.fail_reason_counts || {};
        const pdpLatencyStats = card?.payload?.metadata?.time_to_pdp_ms_stats || {};
        assert.equal(pdpStats.internal, 1);
        assert.equal(pdpStats.external, 0);
        assert.equal(failStats.db_error, 1);
        assert.equal(pdpLatencyStats.count, 1);
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat availability: specific query falls back to local resolver when remote resolve fails transiently', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_ON_TRANSIENT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let resolveCalls = 0;

      axios.get = async (url) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        searchCalls += 1;
        const timeoutErr = new Error('search timeout');
        timeoutErr.code = 'ECONNABORTED';
        throw timeoutErr;
      };

      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) {
          resolveCalls += 1;
          const timeoutErr = new Error('resolve timeout');
          timeoutErr.code = 'ECONNABORTED';
          throw timeoutErr;
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'test_uid_availability_specific_transient',
            'X-Trace-ID': 'test_trace_availability_specific_transient',
            'X-Brief-ID': 'test_brief_availability_specific_transient',
            'X-Lang': 'EN',
          },
          body: {
            message: 'Do you have Winona Soothing Repair Serum?',
            session: {
              state: 'idle',
              profile: {
                skinType: 'sensitive',
                sensitivity: 'high',
                barrierStatus: 'impaired',
                goals: ['reduce redness'],
              },
            },
            language: 'EN',
          },
        });

        assert.equal(resp.status, 200);
        assert.equal(searchCalls, 1);
        assert.equal(resolveCalls, 1);
        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const offers = cards.find((card) => card && card.type === 'offers_resolved');
        const items = Array.isArray(offers?.payload?.items) ? offers.payload.items : [];
        const first = items[0] || null;
        assert.ok(first);
        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
        assert.equal(first?.pdp_open?.product_ref?.product_id, '9886500749640');
        assert.equal(first?.pdp_open?.product_ref?.merchant_id, 'merch_efbc46b4619cfbdf');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat availability: 200 soft-timeout search still resolves via local resolver (no remote resolve)', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_CHAT_CATALOG_AVAIL_FAST_PATH: 'true',
      AURORA_CHAT_CATALOG_AVAIL_RESOLVE_FALLBACK: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let resolveCalls = 0;

      axios.get = async (url) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        searchCalls += 1;
        return {
          status: 200,
          data: {
            status: 'success',
            success: true,
            products: [],
            total: 0,
            metadata: {
              query_source: 'agent_products_error_fallback',
              proxy_search_fallback: {
                applied: true,
                reason: 'primary_timeout',
                upstream_status: 504,
                upstream_error_code: 'ECONNABORTED',
              },
            },
          },
        };
      };

      axios.post = async (url) => {
        if (String(url).includes('/agent/v1/products/resolve')) resolveCalls += 1;
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRoute(app, 'POST', '/v1/chat', {
          headers: {
            'X-Aurora-UID': 'test_uid_availability_soft_timeout',
            'X-Trace-ID': 'test_trace_availability_soft_timeout',
            'X-Brief-ID': 'test_brief_availability_soft_timeout',
            'X-Lang': 'EN',
          },
          body: {
            message: 'Do you have Winona Soothing Repair Serum?',
            session: {
              state: 'idle',
              profile: {
                skinType: 'sensitive',
                sensitivity: 'high',
                barrierStatus: 'impaired',
                goals: ['reduce redness'],
              },
            },
            language: 'EN',
          },
        });

        assert.equal(resp.status, 200);
        assert.equal(searchCalls, 1);
        assert.equal(resolveCalls, 0);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        const offersCard = cards.find((c) => c && c.type === 'offers_resolved');
        const items = Array.isArray(offersCard?.payload?.items) ? offersCard.payload.items : [];
        const first = items[0] || null;
        assert.ok(first);
        assert.equal(first?.metadata?.pdp_open_path, 'internal');
        assert.equal(first?.metadata?.pdp_open_mode, 'ref');
        assert.equal(first?.pdp_open?.product_ref?.product_id, '9886500749640');
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('Availability query normalization drops duplicated brand markers', async () => {
  await withEnv(
    {},
    async () => {
      const { __internal } = loadRoutesFresh();
      const query = __internal.buildAvailabilityCatalogQuery('薇诺娜 薇诺娜（品牌）有货吗', {
        brand_id: 'brand_winona',
        brand_name: '薇诺娜',
        matched_alias: '薇诺娜',
      });
      assert.equal(query, '薇诺娜');
    },
  );
});

test('/v1/chat reco fail-fast: open state skips until probe interval, then probes and recovers', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_QUERIES: 'winona soothing repair serum',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST: 'true',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST_THRESHOLD: '1',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST_COOLDOWN_MS: '90000',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS: '15000',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalNow = Date.now;
      const originalGet = axios.get;
      let nowMs = 1_000_000;
      let phase = 'timeout';
      let searchCalls = 0;
      const searchTimeouts = [];

      Date.now = () => nowMs;
      axios.get = async (url, config = {}) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        searchCalls += 1;
        searchTimeouts.push(Number(config?.timeout));
        if (phase === 'timeout') {
          const err = new Error('upstream timeout');
          err.code = 'ECONNABORTED';
          throw err;
        }
        const q = String(config?.params?.query || '').trim() || 'winona';
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: `prod_winona_${searchCalls}`,
                merchant_id: 'mid_winona',
                brand: 'Winona',
                name: q,
                display_name: `Winona ${q}`,
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

        const first = await invokeRecoChat(app, { 'X-Debug': 'true' });
        assert.equal(first.status, 200);
        assert.equal(searchCalls, 1);
        const firstDebug = getAuroraDebugPayload(first.body);
        const firstCatalogDebug = firstDebug?.reco_catalog_debug;
        assert.equal(firstCatalogDebug?.fail_fast_after?.open, true);
        assert.equal(firstCatalogDebug?.search_timeout_effective_ms, 1800);
        assert.equal(searchTimeouts[0], 1800);

        phase = 'success';
        nowMs += 1000;
        const second = await invokeRecoChat(app, { 'X-Debug': 'true' });
        assert.equal(second.status, 200);
        assert.equal(searchCalls, 1);
        const secondDebug = getAuroraDebugPayload(second.body);
        const secondCatalogDebug = secondDebug?.reco_catalog_debug;
        assert.equal(secondCatalogDebug?.skipped_reason, 'fail_fast_open');
        assert.equal(secondCatalogDebug?.fail_fast?.open, true);
        assert.equal(secondCatalogDebug?.fail_fast?.can_probe_while_open, false);
        assert.ok(Number(secondCatalogDebug?.fail_fast?.next_probe_in_ms) > 0);

        nowMs += 16000;
        const third = await invokeRecoChat(app, { 'X-Debug': 'true' });
        assert.equal(third.status, 200);
        assert.equal(searchCalls, 2);
        const thirdDebug = getAuroraDebugPayload(third.body);
        const thirdCatalogDebug = thirdDebug?.reco_catalog_debug;
        assert.equal(thirdCatalogDebug?.probe_while_open, true);
        assert.equal(thirdCatalogDebug?.fail_fast_after?.open, true);
        assert.equal(thirdCatalogDebug?.search_timeout_effective_ms, 1200);
        assert.equal(searchTimeouts[1], 1200);
      } finally {
        Date.now = originalNow;
        axios.get = originalGet;
      }
    },
  );
});

test('/v1/chat reco fail-fast open: skips PDP resolve calls via fast external fallback', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'true',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_QUERIES: 'winona soothing repair serum',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST: 'true',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST_THRESHOLD: '1',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST_COOLDOWN_MS: '90000',
      AURORA_BFF_RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS: '30000',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_FAST_EXTERNAL_FALLBACK: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalNow = Date.now;
      const originalGet = axios.get;
      const originalPost = axios.post;
      let nowMs = 2_000_000;
      let searchPhase = 'timeout';
      let resolveCalls = 0;

      Date.now = () => nowMs;
      axios.get = async (url, config = {}) => {
        if (!String(url).includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${url}`);
        }
        if (searchPhase === 'timeout') {
          const err = new Error('upstream timeout');
          err.code = 'ECONNABORTED';
          throw err;
        }
        const q = String(config?.params?.query || '').trim() || 'winona';
        return {
          status: 200,
          data: {
            products: [
              {
                product_id: `prod_winona_${q.replace(/\s+/g, '_')}`,
                merchant_id: 'mid_winona',
                brand: 'Winona',
                name: q,
                display_name: `Winona ${q}`,
              },
            ],
          },
        };
      };
      axios.post = async (url) => {
        resolveCalls += 1;
        if (
          String(url).includes('/agent/shop/v1/invoke') ||
          String(url).includes('/agent/v1/products/resolve')
        ) {
          return {
            status: 504,
            data: {
              status: 'error',
              reason: 'upstream_timeout',
              reason_code: 'upstream_timeout',
            },
          };
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const first = await invokeRecoChat(app, { 'X-Debug': 'true' });
        assert.equal(first.status, 200);
        assert.equal(resolveCalls, 0);
        const firstDebug = getAuroraDebugPayload(first.body);
        assert.equal(firstDebug?.reco_pdp_fast_fallback_reason, 'upstream_timeout');

        const callsAfterFirst = resolveCalls;
        searchPhase = 'success';
        nowMs += 1000;
        const second = await invokeRecoChat(app, { 'X-Debug': 'true' });
        assert.equal(second.status, 200);
        assert.equal(resolveCalls, callsAfterFirst);

        const secondDebug = getAuroraDebugPayload(second.body);
        assert.equal(secondDebug?.reco_pdp_fast_fallback_reason, 'upstream_timeout');

        const secondRecos = getRecoItems(second.body);
        assert.ok(secondRecos.length > 0);
        const firstRecoMeta = secondRecos[0]?.metadata || {};
        assert.equal(firstRecoMeta?.pdp_open_path, 'external');
        assert.equal(firstRecoMeta?.resolve_reason_code, 'upstream_timeout');
        assert.notEqual(firstRecoMeta?.pdp_open_resolve_attempted, true);
      } finally {
        Date.now = originalNow;
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat reco transient catalog failure: returns stable internal fallback without aurora upstream wait', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_QUERIES: 'winona soothing repair serum,the ordinary niacinamide 10% + zinc 1%',
      AURORA_BFF_RECO_CATALOG_TRANSIENT_FALLBACK: 'true',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let postCalls = 0;

      axios.get = async (url) => {
        const target = String(url || '');
        if (!target.includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${target}`);
        }
        searchCalls += 1;
        const err = new Error('upstream timeout');
        err.code = 'ECONNABORTED';
        throw err;
      };

      axios.post = async (url) => {
        postCalls += 1;
        throw new Error(`Unexpected axios.post: ${String(url || '')}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRecoChat(app, { 'X-Debug': 'true' });
        assert.equal(resp.status, 200);
        assert.ok(searchCalls >= 1);
        assert.equal(postCalls, 0);

        const recos = getRecoItems(resp.body);
        assert.ok(recos.length > 0);
        assert.ok(recos.every((r) => (r?.metadata || {}).pdp_open_path === 'internal'));
        assert.ok(recos.some((r) => (r?.metadata || {}).pdp_open_mode === 'ref'));

        const stats = getRecoPathStats(resp.body);
        assert.ok(Number(stats?.ref || 0) >= 1);
        assert.equal(Number(stats?.external || 0), 0);

        const debug = getAuroraDebugPayload(resp.body);
        assert.equal(debug?.structured_source, 'catalog_transient_fallback');
        assert.equal(debug?.reco_catalog_transient_fallback_applied, true);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('/v1/chat reco: 200 soft-fallback timeout search response uses transient catalog fallback', async () => {
  await withEnv(
    {
      AURORA_BFF_USE_MOCK: 'false',
      AURORA_DECISION_BASE_URL: '',
      AURORA_BFF_RECO_CATALOG_GROUNDED: 'true',
      AURORA_BFF_RECO_CATALOG_QUERIES: 'winona soothing repair serum,the ordinary niacinamide 10% + zinc 1%',
      AURORA_BFF_RECO_CATALOG_TRANSIENT_FALLBACK: 'true',
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let searchCalls = 0;
      let postCalls = 0;

      axios.get = async (url) => {
        const target = String(url || '');
        if (!target.includes('/agent/v1/products/search')) {
          throw new Error(`Unexpected axios.get: ${target}`);
        }
        searchCalls += 1;
        return {
          status: 200,
          data: {
            status: 'success',
            success: true,
            products: [],
            total: 0,
            metadata: {
              query_source: 'agent_products_error_fallback',
              proxy_search_fallback: {
                applied: true,
                reason: 'primary_timeout',
                upstream_status: 504,
                upstream_error_code: 'ECONNABORTED',
              },
            },
          },
        };
      };

      axios.post = async (url) => {
        postCalls += 1;
        throw new Error(`Unexpected axios.post: ${String(url || '')}`);
      };

      try {
        const express = require('express');
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const resp = await invokeRecoChat(app, { 'X-Debug': 'true' });
        assert.equal(resp.status, 200);
        assert.ok(searchCalls >= 1);
        assert.equal(postCalls, 0);

        const recos = getRecoItems(resp.body);
        assert.ok(recos.length > 0);
        assert.ok(recos.some((r) => (r?.metadata || {}).pdp_open_path === 'internal'));

        const debug = getAuroraDebugPayload(resp.body);
        assert.equal(debug?.structured_source, 'catalog_transient_fallback');
        assert.equal(debug?.reco_catalog_transient_fallback_applied, true);
      } finally {
        axios.get = originalGet;
        axios.post = originalPost;
      }
    },
  );
});

test('Catalog search transient failure does not invoke local search fallback by default', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_CHAT: 'true',
      AURORA_BFF_RECO_PDP_LOCAL_SEARCH_FALLBACK_ON_TRANSIENT: 'false',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_BASE_URL: 'http://127.0.0.1:3000',
    },
    async () => {
      const originalGet = axios.get;
      let primaryCalls = 0;
      let localCalls = 0;
      axios.get = async (url) => {
        const target = String(url || '');
        if (target === 'https://pivota-backend.test/agent/v1/products/search') {
          primaryCalls += 1;
          const err = new Error('upstream timeout');
          err.code = 'ECONNABORTED';
          throw err;
        }
        if (target === 'http://127.0.0.1:3000/agent/v1/products/search') {
          localCalls += 1;
          return { status: 200, data: { products: [{ product_id: 'prod_local', merchant_id: 'mid_local' }] } };
        }
        throw new Error(`Unexpected axios.get: ${target}`);
      };

      try {
        const { __internal } = loadRoutesFresh();
        const out = await __internal.searchPivotaBackendProducts({
          query: 'winona',
          timeoutMs: 1200,
          logger: null,
        });

        assert.equal(primaryCalls, 1);
        assert.equal(localCalls, 0);
        assert.equal(out?.ok, false);
        assert.equal(out?.reason, 'upstream_timeout');
      } finally {
        axios.get = originalGet;
      }
    },
  );
});

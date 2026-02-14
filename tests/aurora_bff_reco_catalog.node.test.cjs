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
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'false',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalGet = axios.get;
      const originalPost = axios.post;
      let resolveCalls = 0;
      let lastResolveBody = null;
      axios.get = async (url) => {
        throw new Error(`Unexpected axios.get: ${url}`);
      };
      axios.post = async (url, body) => {
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

test('UUID-only sku does not send product_ref hint and avoids duplicated brand in resolve query', async () => {
  await withEnv(
    {
      AURORA_BFF_RECO_PDP_RESOLVE_ENABLED: 'true',
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
    },
    async () => {
      const originalPost = axios.post;
      let capturedBody = null;
      axios.post = async (url, body) => {
        if (!String(url).includes('/agent/v1/products/resolve')) throw new Error(`Unexpected axios.post: ${url}`);
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
            brand: 'The Ordinary',
            display_name: 'The Ordinary Niacinamide 10% + Zinc 1%',
            product_id: 'c231aaaa-8b00-4145-a704-684931049303',
            sku_id: 'c231aaaa-8b00-4145-a704-684931049303',
          },
        }, { logger: null });

        assert.ok(capturedBody);
        assert.equal(capturedBody.query, 'The Ordinary Niacinamide 10% + Zinc 1%');
        assert.equal(capturedBody?.hints?.product_ref, undefined);
        const aliases = Array.isArray(capturedBody?.hints?.aliases) ? capturedBody.hints.aliases : [];
        assert.equal(aliases.some((v) => String(v).toLowerCase().includes('the ordinary the ordinary')), false);
        assert.equal(enriched?.metadata?.pdp_open_path, 'external');
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
            brand: 'Winona',
            display_name: 'Winona Soothing Repair Serum',
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

test('Availability resolve: primary timeout falls back to local products.resolve', async () => {
  await withEnv(
    {
      PIVOTA_BACKEND_BASE_URL: 'https://pivota-backend.test',
      PIVOTA_BACKEND_AGENT_API_KEY: 'test_key',
      AURORA_BFF_RECO_PDP_LOCAL_INVOKE_FALLBACK_ENABLED: 'true',
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

const nock = require('nock');
const request = require('supertest');

/*
 * product_search_proxy_route — REWRITTEN 2026-07-11 against the CURRENT mainline
 * search contract (branch fix/product-search-proxy-route-rewrite).
 *
 * The original suite (…/product_search_proxy_route.test.js.quarantined_20260711)
 * asserted the retired GET /agent/v1/products/search proxy topology (upstream
 * GET bridge, resolver-first/resolver-fallback flag matrix, invoke-secondary
 * fallback chains). Those cases are re-expressed here against the surviving
 * contract, driven through POST /agent/shop/v1/invoke {operation:find_products_multi}
 * — the same entry the public GET route now delegates into
 * (handleAgentProductsSearchViaInvoke → handleInvokeRequest, src/server.js ~34608).
 *
 * The load-bearing invariant preserved from every original case is ANTI-BRIDGE:
 * the mainline must NOT reach back to the legacy GET /agent/v1(/v2)/products/search
 * routes. Each test nocks those legacy GET routes and asserts isDone()===false.
 *
 * Three live serving lanes are exercised:
 *  - authoritative_shopping (non-beauty)  → POST /agent/v2/products/search transport
 *      (metadata.query_source='agent_products_search', invoke_search_rail='authoritative_shopping')
 *  - beauty_external_seed_mainline (beauty, non-ingredient) → DB external_product_seeds recall
 *      (metadata.query_source='agent_products_beauty_external_seed_mainline')
 *  - ingredient_recall_direct (beauty ingredient-intent) → DB canonical-chain + seed recall
 *      (metadata.query_source='agent_products_ingredient_recall_direct')
 */

function localHost(h) {
  const s = String(h || '');
  return s.includes('127.0.0.1') || s.includes('localhost') || s === '::1';
}

// A canonical-chain row as loadCatalog/fetchCanonicalChainRows returns it (the
// `WITH candidate_products` CTE) — buildCanonicalChainMainlineProduct consumes it.
function canonicalChainRow(i, over = {}) {
  return {
    merchant_id: 'external_seed',
    product_key: `prod::external_seed::external_seed::nia_${i}`,
    platform: 'external_seed',
    source_product_id: `nia_${i}`,
    pivota_signature_id: `sig_nia_${i}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_nia_${i}`,
    product_title: `Niacinamide 10% Serum ${i}`,
    product_description: 'niacinamide serum for oily skin barrier support',
    brand: 'The Ordinary',
    product_type: 'Serum',
    category: 'Serum',
    category_path: 'beauty/skincare/serum',
    canonical_url: `https://brand.example/products/nia-${i}`,
    product_image_url: `https://cdn.example.com/nia-${i}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    product_payload: {
      seed_data: { price_amount: '12.00', price_currency: 'USD', availability: 'in stock' },
    },
    rank_score: 90,
    ...over,
  };
}

// An external_product_seeds row as queryBeautyExternalSeedRowsFast returns it.
function externalSeedRow(over = {}) {
  return {
    id: 'seed-1',
    external_product_id: 'ext_1',
    market: 'US',
    tool: 'shopping_agents',
    destination_url: 'https://shop.example.com/products/p',
    canonical_url: 'https://shop.example.com/products/p',
    domain: 'shop.example.com',
    title: 'Night Bloom Perfume',
    image_url: 'https://cdn.example.com/p.jpg',
    price_amount: '68.00',
    price_currency: 'USD',
    availability: 'in stock',
    seed_data: { brand: 'Night Bloom', category: 'fragrance', description: 'eau de parfum for date night' },
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe('product search proxy route — mainline contract', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect(localHost);

    // Snapshot the whole env; each test restores it in afterEach. Mirrors the
    // save/restore discipline of invoke.find_products_multi_shopping_mainline.test.js.
    prevEnv = { ...process.env };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    delete process.env.DATABASE_URL;
    process.env.STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED = 'false';
    process.env.FIND_PRODUCTS_MULTI_EXPANSION_MODE = 'off';
    process.env.FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE = 'off';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    process.env = prevEnv;
  });

  // Nock both retired GET bridges. Returning products from them lets a test prove
  // the mainline never adopts them (isDone stays false).
  function armLegacyGetBridges(baitTitle = 'Legacy Bridge Should Not Run') {
    const legacyV1 = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'legacy_v1', merchant_id: 'legacy_merch', title: baitTitle }],
        total: 1,
      });
    const legacyV2Get = nock('http://pivota.test')
      .get('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'legacy_v2_get', merchant_id: 'legacy_merch', title: baitTitle }],
        total: 1,
      });
    return { legacyV1, legacyV2Get };
  }

  // ---- Lane 1: authoritative_shopping (non-beauty, POST /agent/v2/products/search) ----

  // Descends from quarantined L523 "shopping-agent source forces strict main path
  // on public search route". Route ownership: a shopping_agent search is owned by
  // the authoritative shopping mainline (POST /agent/v2/products/search), never the
  // legacy GET bridge. Pins the shoppingFreshMainlineSearch v2 transport
  // (handleInvokeRequest, src/server.js ~46300).
  test('shopping-agent source owns the main path via the authoritative v2 transport', async () => {
    const queryText = 'running shoes';
    let capturedBody = null;
    const upstreamV2 = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            { product_id: 'shoe_1', merchant_id: 'merch_1', title: 'Trail Running Shoe', in_stock: true },
          ],
          total: 1,
          metadata: { query_source: 'agent_products_search' },
        };
      });
    const { legacyV1, legacyV2Get } = armLegacyGetBridges();

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: queryText, limit: 10, page: 1, in_stock_only: true, allow_external_seed: true } },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(upstreamV2.isDone()).toBe(true);
    expect(legacyV1.isDone()).toBe(false);
    expect(legacyV2Get.isDone()).toBe(false);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        query: queryText,
        search_all_merchants: true,
        request_context: expect.objectContaining({ channel: 'shopping_agent' }),
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        query_source: 'agent_products_search',
      }),
    );
  });

  // Descends from quarantined L703 "v2 primary contract mismatch does not fall back
  // to legacy public search bridge". A 422 contract mismatch on the v2 transport
  // must NOT bridge to the legacy GET route — it returns strict_empty. Pins the
  // no-fallback authoritative shopping contract (normalizeAuthoritativeSearchNoFallbackResponse).
  test('v2 contract mismatch (422) does not bridge to the legacy GET search route', async () => {
    const queryText = 'sunscreen oily skin';
    const upstreamV2 = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(422, { detail: [{ loc: ['body', 'search'], msg: 'Field required', type: 'missing' }] });
    const { legacyV1, legacyV2Get } = armLegacyGetBridges();

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: queryText, limit: 10, page: 1, in_stock_only: true, allow_external_seed: true } },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(upstreamV2.isDone()).toBe(true);
    expect(legacyV1.isDone()).toBe(false);
    expect(legacyV2Get.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        strict_empty: true,
        strict_empty_reason: 'shopping_mainline_exception',
      }),
    );
    expect(String(resp.body.metadata?.contract_bridge?.resolved_contract || '')).not.toBe('agent_v1');
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  // Descends from quarantined L1189 "aurora source returns strict_empty with
  // fallback_strategy when primary and secondary both fail". Terminal failure
  // contract: an upstream 5xx yields a strict_empty response with no legacy/cache
  // fallback adopted. Pins route_health.fallback_triggered=false on the 5xx path.
  test('upstream 5xx returns strict_empty without adopting any legacy fallback', async () => {
    const queryText = 'wireless headphones';
    const upstreamV2 = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(500, { error: 'UPSTREAM_FAILURE', message: 'backend failed' });
    const { legacyV1, legacyV2Get } = armLegacyGetBridges('Fallback Should Not Run');

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: queryText, limit: 10, page: 1, in_stock_only: true, allow_external_seed: true } },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(upstreamV2.isDone()).toBe(true);
    expect(legacyV1.isDone()).toBe(false);
    expect(legacyV2Get.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        strict_empty: true,
        strict_empty_reason: expect.stringMatching(/^shopping_mainline_(exception|upstream_5xx)$/),
        route_health: expect.objectContaining({ fallback_triggered: false }),
      }),
    );
    expect(resp.body.metadata?.proxy_search_fallback?.applied).not.toBe(true);
  });

  // ---- Lane 2: beauty_external_seed_mainline (beauty non-ingredient, DB seeds) ----

  // Descends from quarantined L778 "public beauty second-stage supplement stays on
  // v2 transport instead of old GET search routes". A beauty query is served by the
  // DB external-seed mainline (searchBeautyExternalSeedProductsMainline,
  // src/server.js ~20622); the supplement/recall leg must not touch the legacy GET
  // search routes.
  test('beauty query serves from the external-seed mainline and never the legacy GET routes', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const { legacyV1, legacyV2Get } = armLegacyGetBridges();
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds')) {
          return { rows: [externalSeedRow()] };
        }
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: '香水', page: 1, limit: 10, in_stock_only: true } },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(legacyV1.isDone()).toBe(false);
    expect(legacyV2Get.isDone()).toBe(false);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata?.query_source).toBe('agent_products_beauty_external_seed_mainline');
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        decision_authority: 'agent_products_beauty_external_seed_mainline',
        query_target_domain: 'beauty',
      }),
    );
  });

  // Descends from quarantined L2941 "external_seed_only search returns direct seed
  // products for guidance discovery". External seeds are served directly from the
  // DB with merchant_id='external_seed', no upstream/legacy call. (The route-level
  // external_seed_only/merchant_id params are retired; a merchant_id scope now
  // routes AROUND the beauty mainline — the "direct seed products" guarantee is
  // preserved by the unscoped external-seed mainline recall itself.)
  test('external-seed recall returns direct seed products carrying merchant_id=external_seed', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const { legacyV1, legacyV2Get } = armLegacyGetBridges();
    let seedQueried = false;
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds')) {
          seedQueried = true;
          return {
            rows: [
              externalSeedRow({
                id: 'seed_bloom_1',
                external_product_id: 'ext_bloom_1',
                title: 'Night Bloom Eau de Parfum',
                seed_data: { brand: 'Night Bloom', category: 'fragrance', description: 'eau de parfum for guidance discovery' },
              }),
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: '香水', // "perfume/fragrance" — beauty, non-ingredient → external-seed mainline
            page: 1,
            limit: 10,
            in_stock_only: true,
            external_seed_only: true,
          },
        },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(seedQueried).toBe(true);
    expect(legacyV1.isDone()).toBe(false);
    expect(legacyV2Get.isDone()).toBe(false);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products[0]).toEqual(expect.objectContaining({ merchant_id: 'external_seed' }));
    expect(resp.body.metadata?.query_source).toBe('agent_products_beauty_external_seed_mainline');
  });

  // ---- Lane 3: ingredient_recall_direct (beauty ingredient-intent, DB direct) ----

  // Descends from quarantined L476 "generic beauty ingredient queries bypass legacy
  // aurora GET bridge and resolve on the local direct path". An ingredient-intent
  // query resolves on the ingredient_recall_direct lane (src/server.js ~43248),
  // never the legacy aurora GET bridge; an empty catalog yields an honest
  // strict_empty stamped strict_constraint_query=true.
  test('ingredient-intent query resolves on the direct lane and bypasses the legacy aurora GET bridge', async () => {
    // Deliberately NO DATABASE_URL: the direct lane still owns the decision and
    // returns strict_empty rather than bridging to the legacy GET route.
    const { legacyV1, legacyV2Get } = armLegacyGetBridges();
    // The aurora upstream base, if ever consulted, would be this GET route too.
    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'niacinamide serum', page: 1, limit: 10, in_stock_only: true } },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(legacyV1.isDone()).toBe(false);
    expect(legacyV2Get.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct',
        invoke_search_rail: 'authoritative_shopping',
        legacy_contract: false,
        strict_empty: true,
        strict_constraint_query: true,
      }),
    );
  });

  // Descends from quarantined L3160 "ingredient-intent search uses direct KB and
  // attached-seed recall before invoke fallback". When the direct canonical-chain
  // recall (fetchCanonicalChainRows, `WITH candidate_products`) returns rows, the
  // lane serves them as a direct hit and never triggers an upstream/legacy fallback.
  test('ingredient-intent direct recall serves canonical-chain rows without any invoke fallback', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const upstreamV2 = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, { status: 'success', success: true, products: [], total: 0 });
    const { legacyV1, legacyV2Get } = armLegacyGetBridges();
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('WITH candidate_products')) {
          return { rows: [canonicalChainRow(1), canonicalChainRow(2), canonicalChainRow(3)] };
        }
        return { rows: [] };
      },
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'niacinamide serum', page: 1, limit: 10, in_stock_only: true } },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products.length).toBeGreaterThan(0);
    // Direct recall owned the result — no upstream and no legacy bridge consulted.
    expect(upstreamV2.isDone()).toBe(false);
    expect(legacyV1.isDone()).toBe(false);
    expect(legacyV2Get.isDone()).toBe(false);
    expect(resp.body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata?.ingredient_direct_resolution_variant).toBe('direct_hit');
    expect(resp.body.metadata?.route_health).toEqual(
      expect.objectContaining({ primary_path_used: 'ingredient_recall_direct', fallback_triggered: false }),
    );
    expect(resp.body.products[0]).toEqual(expect.objectContaining({ merchant_id: 'external_seed' }));
  });

  // Descends from quarantined L3743 "ingredient-intent search returns direct-empty
  // with explicit miss reason before generic clarify". An exhausted ingredient
  // recall returns strict_empty with an explicit miss reason and NO clarification —
  // honest miss over generic clarify (buildIngredientIntentDirectEmptyResponse,
  // src/findProductsIngredientIntentDirectResponse.js:278).
  test('ingredient-intent empty recall returns direct-empty with explicit miss reason, not a clarify', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    jest.doMock('../../src/db', () => ({ query: async () => ({ rows: [] }) }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'panthenol repair serum', page: 1, limit: 10, in_stock_only: true } },
        metadata: { source: 'shopping_agent' },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.clarification).toBeUndefined();
    expect(resp.body.metadata?.query_source).toBe('agent_products_ingredient_recall_direct');
    expect(resp.body.metadata?.strict_empty).toBe(true);
    expect(resp.body.metadata?.ingredient_direct_resolution_variant).toBe('direct_empty');
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        ingredient_direct_miss_reason: expect.any(String),
        clarify_applied_after_kb_exhausted: false,
      }),
    );
    expect(String(resp.body.metadata?.search_decision?.ingredient_direct_miss_reason || '').length).toBeGreaterThan(0);
  });
});

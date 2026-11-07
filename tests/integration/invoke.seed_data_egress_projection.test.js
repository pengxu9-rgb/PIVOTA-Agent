// The stored external-seed `seed_data` blob rides on every product buildExternalSeedProduct builds
// (`seed_data: runtimeSeedData`), and three /invoke exits serialize the product whole:
//   - get_discovery_feed, default response_detail 'full' (formatDiscoveryResponseProduct spreads raw);
//   - find_products_multi's public beauty discovery bridge (calls getDiscoveryFeed without a detail, so
//     it gets the 'full' shape, and returns before projectFindProductsMultiTransportResponse);
//   - find_products_multi's creator human-apparel direct lane (res.json before the transport projection).
// Each test drives the REAL route with products built by the REAL producer, and asserts that only the
// allowlisted seed_data fields reach the response.
const nock = require('nock');
const request = require('supertest');

const INTERNAL_SEED_KEYS = ['price_read', 'variant_refresh', 'review_summary', 'authority_source', 'harvest_meta'];

function seedRow(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'seed-row-1',
    external_product_id: 'ext_seed_egress_1',
    market: 'US',
    tool: 'creator_agents',
    destination_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
    canonical_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
    domain: 'shop.example.com',
    title: "Velvet Plus Size women's sleepwear set",
    image_url: 'https://cdn.example.com/sleepwear.jpg',
    price_amount: '39.90',
    price_currency: 'USD',
    availability: 'in stock',
    status: 'active',
    seed_data: {
      brand: 'Velvet',
      category: 'sleepwear',
      description: 'Plus size sleepwear lounge set with matching bottoms.',
      image_urls: ['https://cdn.example.com/sleepwear.jpg', 'https://cdn.example.com/sleepwear-2.jpg'],
      // Internal bookkeeping the backend keeps in seed_data. None of it is a partner field.
      price_read: { source: 'refresh_job', read_at: '2026-11-01T00:00:00Z', outcome: 'stale_kept' },
      variant_refresh: { attempts: 3, last_error: 'http_423' },
      review_summary: { rating: 4.2, count: 17, source_host: 'reviews.example.com' },
      authority_source: { source_role: 'primary', source_url: 'https://internal.example.com/x' },
      harvest_meta: { run_id: 'run_123', worker: 'w-7' },
      derived: {
        recall: {
          retrieval_summary: 'Plus size sleepwear set.',
          alias_tokens: 'velvet sleepwear lounge',
          quality_signals: { score: 0.71 },
        },
      },
      snapshot: {
        title: "Velvet Plus Size women's sleepwear set",
        brand: 'Velvet',
        category: 'sleepwear',
        description: 'Plus size sleepwear lounge set with matching bottoms.',
        destination_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
        canonical_url: 'https://shop.example.com/products/plus-size-sleepwear-set',
        image_urls: ['https://cdn.example.com/sleepwear.jpg'],
        price_read: { source: 'crawl', read_at: '2026-10-30T00:00:00Z' },
        variants: [
          {
            variant_id: '4410001',
            option_name: 'Size',
            option_value: 'XL',
            price: '39.90',
            compare_at_price: '59.90',
            stock: 'in stock',
            cost_basis: '11.00',
          },
        ],
      },
    },
    updated_at: now,
    created_at: now,
    ...overrides,
  };
}

function expectSeedDataProjected(product) {
  const seed = product.seed_data;
  if (seed === undefined) return;
  expect(seed && typeof seed === 'object').toBe(true);
  for (const key of INTERNAL_SEED_KEYS) {
    expect(seed).not.toHaveProperty(key);
    if (seed.snapshot) expect(seed.snapshot).not.toHaveProperty(key);
  }
  const allowedTop = ['image_url', 'imageUrl', 'image', 'images', 'image_urls', 'variants', 'snapshot', 'derived'];
  expect(Object.keys(seed).filter((key) => !allowedTop.includes(key))).toEqual([]);
  if (seed.derived) expect(Object.keys(seed.derived)).toEqual(['recall']);
  if (seed.derived?.recall) expect(Object.keys(seed.derived.recall)).toEqual(['retrieval_summary']);
  for (const variant of [...(seed.variants || []), ...(seed.snapshot?.variants || [])]) {
    for (const key of ['price', 'pricing', 'currency', 'compare_at_price', 'inventory_quantity', 'cost_basis']) {
      expect(variant).not.toHaveProperty(key);
    }
  }
}

// find_products_multi mints attributed links for external-seed cards on the way out; answer it so the
// route takes its normal path instead of logging a mint failure.
function stubAttributionMint() {
  nock('http://pivota.test')
    .post('/agent/shop/v1/attribution/external-seed-links')
    .reply(200, { links: [] })
    .persist();
}

describe('/agent/shop/v1/invoke never serializes internal seed_data fields', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/auroraBff/routes', () => ({
      mountAuroraBffRoutes: () => {},
      __internal: {},
    }));
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });
    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED: process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED,
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: process.env.PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
      DEFAULT_CREATOR_ID: process.env.DEFAULT_CREATOR_ID,
      CREATOR_CATALOG_MERCHANT_IDS: process.env.CREATOR_CATALOG_MERCHANT_IDS,
    };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_BACKEND_BASE_URL = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    process.env.PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED = 'false';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
    delete process.env.DATABASE_URL;
    delete process.env.DEFAULT_CREATOR_ID;
    delete process.env.CREATOR_CATALOG_MERCHANT_IDS;
  });

  afterEach(() => {
    jest.dontMock('../../src/db');
    jest.dontMock('../../src/services/discoveryFeed');
    jest.dontMock('../../src/auroraBff/routes');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    for (const [key, value] of Object.entries(prevEnv || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('the producer really does attach the internal keys (so the assertions below can fail)', () => {
    const { buildExternalSeedProduct } = require('../../src/services/externalSeedProducts');
    const product = buildExternalSeedProduct(seedRow());
    expect(product.seed_data).toEqual(expect.objectContaining({ price_read: expect.any(Object) }));
    expect(product.seed_data.snapshot).toEqual(expect.objectContaining({ price_read: expect.any(Object) }));
    expect(product.seed_data).toEqual(expect.objectContaining({ variant_refresh: expect.any(Object) }));
  });

  test('get_discovery_feed (default full detail) projects seed_data', async () => {
    const { buildExternalSeedProduct } = require('../../src/services/externalSeedProducts');
    const upstreamProduct = {
      ...buildExternalSeedProduct(seedRow()),
      merchant_id: 'm_seed_egress',
      inventory_quantity: 5,
      status: 'active',
    };
    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .times(4)
      .reply(200, { products: [upstreamProduct] });

    const app = require('../../src/server');
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_discovery_feed',
        payload: {
          surface: 'browse_products',
          page: 1,
          limit: 4,
          query: { text: 'sleepwear' },
          context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] },
        },
      })
      .expect(200);

    const hit = (res.body.products || []).find((p) => p.product_id === 'ext_seed_egress_1');
    expect(hit).toBeDefined();
    expect(hit.seed_data).toBeDefined();
    expectSeedDataProjected(hit);
    // Fields agent-ui still reads off seed_data survive.
    expect(hit.seed_data.image_urls).toEqual([
      'https://cdn.example.com/sleepwear.jpg',
      'https://cdn.example.com/sleepwear-2.jpg',
    ]);
    expect(hit.seed_data.derived.recall.retrieval_summary).toBe('Plus size sleepwear set.');
    // Variant ids, option name and stock wording survive (agent-ui's variant badge; the warm-handoff
    // lane's variant-id fallback); price, pricing, currency and inventory do not.
    const variant0 = hit.seed_data.snapshot.variants[0];
    expect(variant0).toEqual(expect.objectContaining({ variant_id: '4410001', option_name: 'Size' }));
    const { SEED_VARIANT_FIELDS } = require('../../src/services/seedDataEgressProjection');
    expect(Object.keys(variant0).filter((key) => !SEED_VARIANT_FIELDS.includes(key))).toEqual([]);
  });

  test('find_products_multi public beauty discovery bridge projects seed_data', async () => {
    const { buildExternalSeedProduct } = require('../../src/services/externalSeedProducts');
    const bridged = buildExternalSeedProduct(
      seedRow({
        external_product_id: 'ext_lip_balm_1',
        title: 'Barrier Repair Lip Balm',
        destination_url: 'https://shop.example.com/products/lip-balm',
        canonical_url: 'https://shop.example.com/products/lip-balm',
      }),
    );
    jest.doMock('../../src/services/discoveryFeed', () => {
      const actual = jest.requireActual('../../src/services/discoveryFeed');
      return {
        ...actual,
        getDiscoveryFeed: jest.fn(async () => ({
          products: [bridged],
          total: 1,
          metadata: { route_health: { primary_quality_gate_passed: true } },
        })),
      };
    });

    stubAttributionMint();
    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: { search: { query: 'lip balm', limit: 1, in_stock_only: true } },
        metadata: { source: 'search' },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.public_search_discovery_bridge).toBe(true);
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0].seed_data).toBeDefined();
    expectSeedDataProjected(resp.body.products[0]);
  });

  test('find_products_multi creator human-apparel direct lane projects seed_data', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) return { rows: [{ total: 0 }] };
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) return { rows: [seedRow()] };
        return { rows: [] };
      },
    }));
    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, { status: 'success', success: true, products: [], total: 0 });

    stubAttributionMint();
    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'plus size sleepwear',
            page: 1,
            limit: 10,
            in_stock_only: true,
            allow_external_seed: true,
            external_seed_strategy: 'unified_relevance',
            search_all_merchants: true,
          },
        },
        metadata: { source: 'creator-agent-ui' },
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_source).toBe('agent_products_creator_external_seed_direct');
    const hit = resp.body.products.find((p) => p.product_id === 'ext_seed_egress_1');
    expect(hit).toBeDefined();
    expect(hit.seed_data).toBeDefined();
    expectSeedDataProjected(hit);
  });
});

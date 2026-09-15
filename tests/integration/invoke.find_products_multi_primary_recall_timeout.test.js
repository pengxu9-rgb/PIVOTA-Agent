const nock = require('nock');
const request = require('supertest');

// #2204 made every recall arm error fatal: one slow seed tool scope, or a slow canonical query,
// turned the whole beauty request into HTTP 503. A TIMEOUT now degrades only its own arm (with
// telemetry); the request still fails when the whole seed lane is down or on a non-timeout
// defect. None of these paths may reach an upstream/proxy route (asserted in afterEach).

function canonicalMacLipstickRows(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    merchant_id: 'mac_official',
    product_key: `prod::mac::lipstick_${index}`,
    platform: 'catalog_enrichment',
    source_product_id: `mac_lipstick_${index}`,
    pivota_signature_id: `sig_mac_lipstick_${index}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_mac_lipstick_${index}`,
    product_title: `MAC Matte Lipstick Shade ${index}`,
    product_description: 'A canonical MAC lipstick row.',
    brand: 'MAC',
    product_type: 'Lipstick',
    category: 'Lipstick',
    category_path: 'beauty/makeup/lip/lipstick',
    canonical_url: `https://www.maccosmetics.com/product/lipstick-${index}`,
    product_image_url: `https://cdn.example.com/mac-lipstick-${index}.jpg`,
    catalog_track: 'external_referral',
    truth_tier: 'observed',
    readiness_tier: 'referral_only',
    pdp_scope: 'unverified',
    merchant_effective_price: '24.00',
    currency: 'USD',
    inventory_quantity: null,
    market: 'US',
    product_payload: { seed_data: { price_amount: '24.00', price_currency: 'USD', availability: 'in stock' } },
    rank_score: 90,
  }));
}

const timeoutError = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('a slow beauty recall arm degrades that arm, not the request', () => {
  let previous;
  let calls;
  let fallbackCalls;
  let failSeedTools;
  let seedError;
  let canonicalError;
  let app;

  const load = (env = {}) => {
    Object.assign(process.env, env);
    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql, params) => {
        const text = String(sql);
        calls.push({ sql: text, params });
        const isSeed = text.includes('FROM external_product_seeds') && !text.includes('FROM candidate_products c');
        if (isSeed) {
          if (failSeedTools === 'all' || (Array.isArray(failSeedTools) && failSeedTools.includes(params?.[1]))) {
            throw seedError();
          }
          return { rows: [] };
        }
        if (text.includes('FROM catalog_products p')) {
          if (canonicalError) throw canonicalError();
          return { rows: canonicalMacLipstickRows() };
        }
        return { rows: [] };
      }),
    }));
    app = require('../../src/server');
  };

  beforeEach(() => {
    previous = { ...process.env };
    jest.resetModules();
    calls = [];
    fallbackCalls = [];
    failSeedTools = [];
    seedError = timeoutError;
    canonicalError = null;
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://fixture',
      PIVOTA_API_BASE: 'http://primary.test',
      API_MODE: 'REAL',
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true',
      PIVOT_BEAUTY_LEGACY_TOOL_SCOPE_RECALL_ENABLED: 'false',
      PIVOT_BEAUTY_PARALLEL_SCOPE_RECALL_ENABLED: 'true',
      STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED: 'false',
      FIND_PRODUCTS_MULTI_EXPANSION_MODE: 'off',
      FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE: 'off',
      FIND_PRODUCTS_MULTI_ROUTE_DEBUG: '1',
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
    });
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    for (const method of ['get', 'post']) {
      nock('http://primary.test').persist()[method](/\/(?:products\/search|invoke)$/).query(true).reply((uri) => {
        fallbackCalls.push(uri);
        return [200, { status: 'success', products: [{ product_id: 'forbidden_rescue', title: 'MAC Matte Lipstick', price: 20, currency: 'USD' }], total: 1 }];
      });
    }
  });

  afterEach(() => {
    const unexpected = [...fallbackCalls];
    process.env = previous;
    jest.dontMock('../../src/db');
    jest.resetModules();
    nock.cleanAll();
    nock.enableNetConnect();
    expect(unexpected).toEqual([]);
  });

  const invoke = () => request(app).post('/agent/shop/v1/invoke').send({
    operation: 'find_products_multi',
    payload: { search: { query: 'MAC lipstick', domain: 'beauty', market: 'US', limit: 10 } },
    metadata: { source: 'shopping_agent' },
  });
  const seedTools = () => calls
    .filter((call) => call.sql.includes('FROM external_product_seeds') && !call.sql.includes('FROM candidate_products c'))
    .map((call) => call.params?.[1]);

  test('control: with no timeouts the request answers from the canonical rows', async () => {
    load();
    const resp = await invoke();
    expect(resp.status).toBe(200);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata.primary_recall_degraded).toBe(false);
  });

  test.each(['true', 'false'])('one timed-out seed tool scope still answers (parallel=%s)', async (parallel) => {
    failSeedTools = ['shopping_agents'];
    load({ PIVOT_BEAUTY_PARALLEL_SCOPE_RECALL_ENABLED: parallel });
    const resp = await invoke();
    expect(seedTools()).toEqual(expect.arrayContaining(['shopping_agents', 'creator_agents', '*']));
    expect(resp.status).toBe(200);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata).toEqual(expect.objectContaining({
      primary_recall_degraded: true,
      external_seed_timed_out_tool_scopes: ['shopping_agents'],
    }));
  });

  test('every seed tool scope timing out is a primary failure, not an empty answer', async () => {
    failSeedTools = 'all';
    load();
    const resp = await invoke();
    expect(resp.status).toBe(503);
    expect(resp.body).toMatchObject({ status: 'failed', success: false, products: [], error: { code: 'BEAUTY_PRIMARY_RECALL_FAILED' } });
  });

  test('a timed-out canonical query degrades to the seed lane instead of 503', async () => {
    canonicalError = timeoutError;
    load();
    const resp = await invoke();
    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(expect.objectContaining({
      primary_recall_degraded: true,
      canonical_timeout: true,
      canonical_error: '57014',
    }));
  });

  test('a non-timeout seed query error in ONE scope still fails loudly', async () => {
    failSeedTools = ['shopping_agents'];
    seedError = () => Object.assign(new Error('column "tool" does not exist'), { code: '42703' });
    load();
    const resp = await invoke();
    expect(resp.status).toBe(503);
    expect(resp.body.error.code).toBe('BEAUTY_PRIMARY_RECALL_FAILED');
  });

  test('a non-timeout canonical error still fails loudly', async () => {
    canonicalError = () => Object.assign(new Error('relation "catalog_products" does not exist'), { code: '42P01' });
    load();
    const resp = await invoke();
    expect(resp.status).toBe(503);
  });
});

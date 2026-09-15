const nock = require('nock');
const request = require('supertest');

// #2204 made every recall arm error fatal: one slow seed tool scope, or a slow canonical query,
// turned the whole beauty request into HTTP 503. A TIMEOUT now degrades only its own arm (with
// telemetry). The request still fails (503) when the whole seed lane is down, when a degraded
// recall found NOTHING (an empty answer would claim "no products" when we could not look), and on
// any non-timeout defect. None of these paths may reach an upstream/proxy route (afterEach).

function canonicalRows({ count = 12, brand, titleStem, categoryPath, productType, url }) {
  return Array.from({ length: count }, (_, index) => ({
    merchant_id: `${brand.toLowerCase()}_official`,
    product_key: `prod::${brand.toLowerCase()}::${productType.toLowerCase()}_${index}`,
    platform: 'catalog_enrichment',
    source_product_id: `${brand.toLowerCase()}_${index}`,
    pivota_signature_id: `sig_${brand.toLowerCase()}_${productType.toLowerCase()}_${index}`,
    pivota_canonical_url: `https://agent.pivota.cc/products/sig_${brand.toLowerCase()}_${index}`,
    product_title: `${titleStem} ${index}`,
    product_description: `A canonical ${productType.toLowerCase()} row.`,
    brand,
    product_type: productType,
    category: productType,
    category_path: categoryPath,
    canonical_url: `${url}/${index}`,
    product_image_url: `https://cdn.example.com/${brand.toLowerCase()}-${index}.jpg`,
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
const macLipsticks = () => canonicalRows({
  brand: 'MAC', titleStem: 'MAC Matte Lipstick Shade', categoryPath: 'beauty/makeup/lip/lipstick',
  productType: 'Lipstick', url: 'https://www.maccosmetics.com/product/lipstick',
});
const moisturizers = () => canonicalRows({
  brand: 'Acme', titleStem: 'Acme Daily Hydrating Moisturizer Cream', categoryPath: 'beauty/skincare/moisturize/cream',
  productType: 'Moisturizer', url: 'https://acme.example/products/moisturizer',
});
const moisturizerSeedRow = () => {
  const now = new Date().toISOString();
  return {
    id: 'seed_acme_moisturizer',
    external_product_id: 'ext_acme_moisturizer',
    market: 'US',
    tool: '*',
    title: 'Acme Daily Hydrating Moisturizer Cream',
    canonical_url: 'https://acme.example/products/daily-moisturizer',
    destination_url: 'https://acme.example/products/daily-moisturizer',
    image_url: 'https://cdn.example.com/acme-moisturizer.jpg',
    price_amount: '22.00',
    price_currency: 'USD',
    availability: 'in stock',
    seed_data: { brand: 'Acme', category: 'moisturizer' },
    updated_at: now,
    created_at: now,
  };
};

const statementTimeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('a slow beauty recall arm degrades that arm, not the request', () => {
  let previous;
  let calls;
  let fallbackCalls;
  let failSeedTools;
  let seedError;
  let seedRowsByTool;
  let canonical;
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
          const tool = params?.[1];
          if (failSeedTools === 'all' || (Array.isArray(failSeedTools) && failSeedTools.includes(tool))) {
            throw seedError();
          }
          return { rows: seedRowsByTool[tool] || [] };
        }
        if (text.includes('FROM catalog_products p')) {
          if (canonicalError) throw canonicalError();
          return { rows: canonical() };
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
    seedError = statementTimeout;
    seedRowsByTool = {};
    canonical = macLipsticks;
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

  const invoke = (query = 'MAC lipstick') => request(app).post('/agent/shop/v1/invoke').send({
    operation: 'find_products_multi',
    payload: { search: { query, domain: 'beauty', market: 'US', limit: 10 } },
    metadata: { source: 'shopping_agent' },
  });
  const seedCalls = () => calls
    .filter((call) => call.sql.includes('FROM external_product_seeds') && !call.sql.includes('FROM candidate_products c'));
  const expectPrimaryFailure = (resp) => {
    expect(resp.status).toBe(503);
    expect(resp.body).toMatchObject({ status: 'failed', success: false, products: [], error: { code: 'BEAUTY_PRIMARY_RECALL_FAILED' } });
  };

  test('control: with no timeouts the request answers from the canonical rows', async () => {
    load();
    const resp = await invoke();
    expect(resp.status).toBe(200);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata.primary_recall_degraded).toBe(false);
  });

  test.each(['true', 'false'])('text-recall lane: one timed-out seed tool scope still answers (parallel=%s)', async (parallel) => {
    failSeedTools = ['shopping_agents'];
    load({ PIVOT_BEAUTY_PARALLEL_SCOPE_RECALL_ENABLED: parallel });
    const resp = await invoke();
    expect(seedCalls().map((call) => call.params[1])).toEqual(expect.arrayContaining(['shopping_agents', 'creator_agents', '*']));
    expect(resp.status).toBe(200);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.metadata).toEqual(expect.objectContaining({
      primary_recall_degraded: true,
      external_seed_timed_out_tool_scopes: ['shopping_agents'],
    }));
  });

  test('family-query lane (runScopeQuery): two timed-out scopes of three still answer', async () => {
    canonical = moisturizers;
    failSeedTools = ['shopping_agents', 'creator_agents'];
    load();
    const resp = await invoke('moisturizer');
    // Prove this went through the category-scoped query, not the text-recall LIKE query the
    // lipstick cases use -- otherwise a regression confined to runScopeQuery stays green.
    expect(seedCalls().length).toBeGreaterThan(0);
    expect(seedCalls().every((call) => !/LIKE \$\d/.test(call.sql))).toBe(true);
    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(expect.objectContaining({
      primary_recall_degraded: true,
      external_seed_timed_out_tool_scopes: ['shopping_agents', 'creator_agents'],
    }));
    expect(resp.body.metadata.canonical_raw_count).toBeGreaterThan(0);
  });

  test('every seed tool scope timing out is a primary failure, not an empty answer', async () => {
    failSeedTools = 'all';
    load();
    expectPrimaryFailure(await invoke());
  });

  test('a timed-out canonical query with no seed rows is a primary failure, not "no products"', async () => {
    canonicalError = statementTimeout;
    load();
    expectPrimaryFailure(await invoke());
  });

  test('a timed-out canonical query still answers from the seed rows it did get', async () => {
    canonical = moisturizers;
    canonicalError = statementTimeout;
    seedRowsByTool = { '*': [moisturizerSeedRow()] };
    load();
    const resp = await invoke('moisturizer');
    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(expect.objectContaining({
      primary_recall_degraded: true,
      canonical_timeout: true,
      canonical_error: '57014',
    }));
  });

  test('one timed-out scope plus an otherwise empty recall is a primary failure', async () => {
    canonical = () => [];
    failSeedTools = ['shopping_agents'];
    load();
    expectPrimaryFailure(await invoke());
  });

  test.each([
    ['57014 with an arbitrary message', () => Object.assign(new Error('boom'), { code: '57014' }), 200],
    ['pg-pool acquire timeout (no SQLSTATE)', () => new Error('timeout exceeded when trying to connect'), 200],
    ['pg connection timeout (no SQLSTATE)', () => new Error('Connection terminated due to connection timeout'), 200],
    ['a defect whose message says cancel/timeout', () => Object.assign(new Error('column "cancel_timeout" does not exist'), { code: '42703' }), 503],
    ['a ReferenceError from a refactor', () => new ReferenceError('queryBeautyExternalSeedRowsWithTimeout is not defined'), 503],
    ['an uncoded error that merely mentions a timeout', () => new Error('upstream timeout while hydrating'), 503],
  ])('seed scope error classification: %s -> %i', async (_label, makeError, status) => {
    failSeedTools = ['shopping_agents'];
    seedError = makeError;
    load();
    const resp = await invoke();
    expect(resp.status).toBe(status);
    if (status === 503) expect(resp.body.error.code).toBe('BEAUTY_PRIMARY_RECALL_FAILED');
    else expect(resp.body.metadata.external_seed_timed_out_tool_scopes).toEqual(['shopping_agents']);
  });

  test.each([
    ['a missing relation', () => Object.assign(new Error('relation "catalog_products" does not exist'), { code: '42P01' })],
    ['a defect whose message says timeout', () => Object.assign(new Error('column "statement_timeout" does not exist'), { code: '42703' })],
  ])('a non-timeout canonical error still fails loudly: %s', async (_label, makeError) => {
    canonicalError = makeError;
    load();
    expectPrimaryFailure(await invoke());
  });
});

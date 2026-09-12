const nock = require('nock');
const request = require('supertest');

// Citation evidence is not a second product-search route. Even with its old
// rollout flag enabled and matching citation rows available, the primary route
// alone owns products, failure status and pagination on every request.
const ENV_KEYS = [
  'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'API_MODE', 'DATABASE_URL', 'INDEX_ELIGIBLE_RECALL',
  'CITABLE_SUPPLEMENT_CACHE_TTL_MS', 'STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED',
  'FIND_PRODUCTS_MULTI_EXPANSION_MODE', 'FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE',
  'PROXY_SEARCH_RESOLVER_FIRST_ENABLED', 'PROXY_SEARCH_INVOKE_FALLBACK_ENABLED',
  'PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED',
];
// SQL comments mention both surfaces; only the executable predicate identifies the lane.
const isSupplementSql = sql => /\bindex_eligible\b/.test(String(sql || '').replace(/--[^\n]*/g, ''));
function citationRow() {
  return {
    merchant_id: 'external_seed', product_key: 'prod::external_seed::external_seed::ext_cit_1',
    source_product_id: 'ext_cit_1', product_title: 'MAC Matte Lipstick', brand: 'MAC Cosmetics',
    content_key: 'ck_cit_1', pivota_signature_id: 'sig_cit_1',
    product_payload: { seed_data: { snapshot: { price_amount: 26, price_currency: 'USD' } } },
  };
}
function primaryRow() {
  const now = new Date().toISOString();
  return {
    id: 'seed_mac_1', external_product_id: 'ext_mac_1', market: 'US', tool: '*',
    title: 'MAC Matte Lipstick', image_url: 'https://cdn.example.com/mac.jpg',
    price_amount: '24.00', price_currency: 'USD',
    canonical_url: 'https://example.com/products/mac-matte-lipstick',
    destination_url: 'https://example.com/products/mac-matte-lipstick', availability: 'in stock',
    seed_data: { brand: 'MAC Cosmetics', category: 'lipstick', category_path: 'beauty/makeup/lip/lipstick' },
    updated_at: now, created_at: now,
  };
}
function invokeBody({ source = 'public_api', page = 1, query = 'MAC lipstick', domain = 'beauty' } = {}) {
  return { operation: 'find_products_multi', payload: { search: {
    query, ...(domain ? { domain } : {}), limit: 10, page, market: 'US', in_stock_only: true,
    allow_external_seed: true, allow_stale_cache: false, external_seed_strategy: 'unified_relevance',
  } }, metadata: { source } };
}
function installDatabase({ hit = false, fail = false } = {}) {
  const calls = [];
  jest.doMock('../../src/db', () => ({ query: jest.fn(async sql => {
    const text = String(sql || '');
    calls.push(text);
    // An accidental supplement call would find a perfectly matching citation;
    // tests must reject the call itself, not merely filter the returned card.
    if (isSupplementSql(text)) return { rows: [citationRow()] };
    if (fail) throw new Error('primary catalog unavailable');
    if (hit && text.includes('FROM external_product_seeds') && !text.includes('FROM external_product_seeds eps')) {
      return { rows: [primaryRow()] };
    }
    return { rows: [] };
  }) }));
  return calls;
}
function expectNoSupplement(body, calls) {
  expect(calls.filter(isSupplementSql)).toEqual([]);
  expect((body.products || []).some(p => p.source === 'canonical_citation' || p.content_key === 'ck_cit_1')).toBe(false);
  expect(Object.keys(body.metadata || {}).filter(k => k.startsWith('citable_supplement'))).toEqual([]);
  expect(body.metadata?.mainline_failure_class).toBeUndefined();
}

describe('/agent/shop/v1/invoke uses the primary search route without citation supplementation', () => {
  let prevEnv, fallbackHttpCalls;
  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll(); nock.disableNetConnect();
    nock.enableNetConnect(host => /127\.0\.0\.1|localhost|^::1$/.test(String(host || '')));
    fallbackHttpCalls = [];
    // A fallback would have a usable hit, so accidental continuation cannot
    // pass merely because a blocked/unmatched mock happened to return empty.
    for (const method of ['get', 'post']) {
      nock('http://pivota.test').persist()[method](/\/(?:products\/search|invoke)$/).query(true)
        .reply(uri => {
          fallbackHttpCalls.push(uri);
          return [200, { status: 'success', success: true, total: 1, products: [{
            product_id: 'forbidden_fallback_hit', merchant_id: 'merchant_fallback',
            title: 'MAC Matte Lipstick', brand: 'MAC Cosmetics', price: 24, currency: 'USD',
          }] }];
        });
    }
    prevEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
      PIVOTA_API_BASE: 'http://pivota.test', PIVOTA_API_KEY: 'test_key', API_MODE: 'REAL',
      DATABASE_URL: 'postgres://mock:mock@127.0.0.1/mock', INDEX_ELIGIBLE_RECALL: 'true',
      CITABLE_SUPPLEMENT_CACHE_TTL_MS: '60000', STRICT_FIND_PRODUCTS_MULTI_AUTO_CONSTRAINT_ENABLED: 'false',
      FIND_PRODUCTS_MULTI_EXPANSION_MODE: 'off', FIND_PRODUCTS_MULTI_SECOND_STAGE_EXPANSION_MODE: 'off',
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: 'false', PROXY_SEARCH_INVOKE_FALLBACK_ENABLED: 'true',
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED: 'true',
    });
  });
  afterEach(() => {
    const unexpectedFallbackCalls = [...fallbackHttpCalls];
    jest.dontMock('../../src/db'); jest.resetModules();
    nock.cleanAll(); nock.enableNetConnect();
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key]; else process.env[key] = prevEnv[key];
    }
    expect(unexpectedFallbackCalls).toEqual([]);
  });

  test('a primary hit returns without querying citation-only rows', async () => {
    const calls = installDatabase({ hit: true });
    const app = require('../../src/server');
    const resp = await request(app).post('/agent/shop/v1/invoke').send(invokeBody());
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('success');
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0].title).toBe('MAC Matte Lipstick');
    expect(calls.length).toBeGreaterThan(0);
    expectNoSupplement(resp.body, calls);
  });

  test.each(['public_api', 'shopping_agent'])('matching citation rows cannot rescue an empty primary route for %s', async source => {
    const calls = installDatabase();
    const app = require('../../src/server');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resp = await request(app).post('/agent/shop/v1/invoke').send(invokeBody({ source }));
      expect(resp.status).toBe(200);
      expect(resp.body).toMatchObject({ status: 'failed', success: false, products: [], total: 0 });
      expect(resp.body.metadata.failure_class).toBe('beauty_mainline_empty');
      expectNoSupplement(resp.body, calls);
    }
    expect(calls.length).toBeGreaterThan(0);
  });

  test('a failed primary route stays terminal despite matching citation rows', async () => {
    const calls = installDatabase({ fail: true });
    const app = require('../../src/server');
    const resp = await request(app).post('/agent/shop/v1/invoke').send(invokeBody());
    expect(resp.status).toBe(503);
    expect(resp.body).toMatchObject({ status: 'failed', success: false, products: [],
      error: { code: 'BEAUTY_PRIMARY_RECALL_FAILED' }, metadata: { failure_class: 'beauty_primary_recall_failed' } });
    expectNoSupplement(resp.body, calls);
  });

  test.each([false, true])('ordinary shopping-agent brand query keeps primary empty/failure terminal, failure=%s', async fail => {
    const calls = installDatabase({ fail });
    const app = require('../../src/server');
    const resp = await request(app).post('/agent/shop/v1/invoke').send(invokeBody({
      query: 'MAC Cosmetics', source: 'shopping_agent', domain: null,
    }));
    expect(resp.status).toBe(fail ? 503 : 200);
    expect(resp.body).toMatchObject({ status: 'failed', success: false, products: [], total: 0 });
    expect(resp.body.metadata.failure_class).toBe(fail ? 'beauty_primary_recall_failed' : 'beauty_mainline_empty');
    expect(calls.length).toBeGreaterThan(0);
    expectNoSupplement(resp.body, calls);
  });

  test.each(['beauty', null])('unconfigured primary route cannot fall through to a usable alternate source, domain=%s', async domain => {
    delete process.env.DATABASE_URL;
    const calls = installDatabase({ hit: true });
    const app = require('../../src/server');
    const resp = await request(app).post('/agent/shop/v1/invoke').send(invokeBody({
      query: 'MAC Cosmetics', source: 'shopping_agent', domain,
    }));
    expect(resp.status).toBe(503);
    expect(resp.body).toMatchObject({ status: 'failed', success: false, products: [],
      error: { code: 'BEAUTY_PRIMARY_RECALL_FAILED' }, metadata: { failure_class: 'beauty_primary_recall_failed' } });
    expectNoSupplement(resp.body, calls);
  });

  test('repeated queries and later pages cannot warm or append citation results', async () => {
    const calls = installDatabase({ hit: true });
    const app = require('../../src/server');
    const bodies = [];
    for (const page of [1, 1, 2]) {
      const resp = await request(app).post('/agent/shop/v1/invoke').send(invokeBody({ page }));
      expect(resp.status).toBe(200);
      expectNoSupplement(resp.body, calls);
      bodies.push(resp.body);
    }
    expect(bodies[0].products.map(p => p.product_id)).toEqual(bodies[1].products.map(p => p.product_id));
    expect(bodies[0].products).toHaveLength(1);
    expect(bodies[2].products).toHaveLength(0);
    expect(bodies[2].page).toBe(2);
  });
});

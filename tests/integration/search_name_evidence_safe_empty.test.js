const nock = require('nock');
const request = require('supertest');

// THE EMPTY-PAGE RESPONSE SHAPE. find_products_multi has three places that build
// search_quality_tier_counts, and all three must add category_waived_by_name_evidence_count only
// when SEARCH_NAME_EVIDENCE_ADMISSION is on. Review of #2230 v3: only the populated one was
// pinned, so making either safe-empty shape carry the key unconditionally survived every test.
//
// The two shapes are reached differently, and one of them cannot be reached over HTTP at all:
//   * "return policy" is not a beauty query -- handleInvokeRequest answers it (server.js ~41800)
//     before the beauty mainline runs, and that answer IS the response;
//   * "makeup" IS beauty-like with an ambiguous_or_non_shopping contract, so the beauty mainline
//     answers it (searchBeautyExternalSeedProductsMainline, server.js ~22150) -- but its caller
//     turns an empty page into 503 BEAUTY_PRIMARY_RECALL_FAILED and drops the metadata (measured:
//     every source and recall-flag combination tried returns 503). So that shape is asserted on
//     the function's own return value, which is why it is exported on _debug.
// A mutation in either place fails exactly one of these cases.

const FLAG = 'SEARCH_NAME_EVIDENCE_ADMISSION';
const KEY = 'category_waived_by_name_evidence_count';

describe('name-evidence: the safe-empty responses carry the tier count only with the flag on', () => {
  let priorEnv;
  beforeEach(() => {
    priorEnv = { ...process.env };
    jest.resetModules();
    Object.assign(process.env, {
      PIVOTA_API_BASE: 'http://upstream-disabled.test', PIVOTA_API_KEY: 'test', API_MODE: 'REAL',
      SEARCH_QUALITY_CONTRACT_V1_ENABLED: 'true', SEARCH_QUALITY_CONTRACT_V1_MODE: 'enforce',
      GATEWAY_RATE_LIMIT_ENABLED: 'false', AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: 'false',
      // The beauty mainline returns null without these two, before it can answer anything.
      PIVOT_BEAUTY_DIRECT_INDEXED_RECALL_ENABLED: 'true', DATABASE_URL: 'postgres://unused.test/db',
    });
    delete process.env[FLAG];
    nock.disableNetConnect();
    nock.enableNetConnect((host) => host.includes('127.0.0.1'));
    jest.doMock('../../src/db', () => ({ query: async () => ({ rows: [] }) }));
  });
  afterEach(() => {
    process.env = priorEnv; jest.dontMock('../../src/db'); jest.resetModules();
    nock.cleanAll(); nock.enableNetConnect();
  });

  const serve = async (query) => {
    const app = require('../../src/server');
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi',
      payload: { search: { query, domain: 'beauty', market: 'US', limit: 10 } },
      metadata: { source: 'public_api', market: 'US' },
    });
    expect(res.status).toBe(200);
    // The premise of the whole test: this really is a safe-empty answer, not an ordinary one.
    expect({ query, source: res.body.metadata?.query_source }).toEqual({ query, source: 'search_quality_contract_v1_safe_empty' });
    expect(res.body.products).toHaveLength(0);
    return res.body.metadata.search_quality_tier_counts;
  };

  test('non-beauty query (handleInvokeRequest): no key with the flag off, a zero with it on', async () => {
    expect(await serve('return policy')).not.toHaveProperty(KEY);
    process.env[FLAG] = 'on';
    jest.resetModules();
    expect(await serve('return policy')).toHaveProperty(KEY, 0);
  });

  const mainlineSafeEmpty = async () => {
    const { searchBeautyExternalSeedProductsMainline } = require('../../src/server')._debug;
    const res = await searchBeautyExternalSeedProductsMainline({
      search: { query: 'makeup', domain: 'beauty', market: 'US', limit: 10 },
      metadata: { source: 'public_api', market: 'US' },
    });
    expect(res.metadata.query_source).toBe('search_quality_contract_v1_safe_empty');
    expect(res.products).toHaveLength(0);
    return res.metadata.search_quality_tier_counts;
  };

  test('beauty-like ambiguous query (beauty mainline): no key with the flag off, a zero with it on', async () => {
    expect(await mainlineSafeEmpty()).not.toHaveProperty(KEY);
    process.env[FLAG] = 'on';
    jest.resetModules();
    expect(await mainlineSafeEmpty()).toHaveProperty(KEY, 0);
  });
});

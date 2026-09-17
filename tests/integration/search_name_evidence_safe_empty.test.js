const nock = require('nock');
const request = require('supertest');

// THE EMPTY-PAGE RESPONSE SHAPE. find_products_multi has three places that build
// search_quality_tier_counts, and all three must add category_waived_by_name_evidence_count only
// when SEARCH_NAME_EVIDENCE_ADMISSION is on. Review of #2230 v3: only the populated one was
// pinned, so making either safe-empty shape carry the key unconditionally survived every test.
//
// Both shapes are served over HTTP, and the query is what selects them:
//   * "return policy" is not beauty at all -- handleInvokeRequest answers it (server.js ~41833);
//   * "makeup" IS beauty-like with an ambiguous_or_non_shopping contract, so the beauty mainline
//     answers it (searchBeautyExternalSeedProductsMainline, server.js ~22150) and the early
//     indexed lane returns that answer verbatim (server.js ~41586).
// The two are told apart by a field only the mainline shape carries, so neither case can
// silently become the other: an assertion that ran twice against the same builder would pin one
// of them twice and leave the other free.

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
      // Without these the beauty mainline returns null before it can answer, the request falls
      // through to a 503, and the mainline case below would silently test nothing.
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

  const serve = async (query, wantMainlineShape) => {
    const app = require('../../src/server');
    const res = await request(app).post('/agent/shop/v1/invoke').send({
      operation: 'find_products_multi',
      payload: { search: { query, domain: 'beauty', market: 'US', limit: 10 } },
      metadata: { source: 'public_api', market: 'US' },
    });
    expect(res.status).toBe(200);
    // The premises: a safe-empty answer, and the shape this case is meant to be covering.
    expect({ query, source: res.body.metadata?.query_source }).toEqual({ query, source: 'search_quality_contract_v1_safe_empty' });
    expect(res.body.products).toHaveLength(0);
    expect({ query, mainlineShape: Boolean(res.body.metadata?.route_debug?.beauty_external_seed_mainline) })
      .toEqual({ query, mainlineShape: wantMainlineShape });
    return res.body.metadata.search_quality_tier_counts;
  };

  for (const [shape, query, isMainline] of [
    ['non-beauty query (handleInvokeRequest)', 'return policy', false],
    ['beauty-like ambiguous query (beauty mainline)', 'makeup', true],
  ]) {
    test(`${shape}: no key with the flag off, a zero with it on`, async () => {
      expect(await serve(query, isMainline)).not.toHaveProperty(KEY);
      process.env[FLAG] = 'on';
      jest.resetModules();
      expect(await serve(query, isMainline)).toHaveProperty(KEY, 0);
    });
  }
});

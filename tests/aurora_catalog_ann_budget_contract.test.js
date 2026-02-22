const ROUTES_PATH = '../src/auroraBff/routes';

describe('aurora catalog_ann budget contract', () => {
  const prevEnv = {
    AURORA_BFF_RECO_BLOCKS_DAG_ENABLED: process.env.AURORA_BFF_RECO_BLOCKS_DAG_ENABLED,
    AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_RESOLVE_FALLBACK:
      process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_RESOLVE_FALLBACK,
    AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP:
      process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP,
    AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_MIN_BUDGET_MS:
      process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_MIN_BUDGET_MS,
    AURORA_BFF_RECO_COMPETITOR_MAIN_TIMEOUT_FLOOR_MS:
      process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_TIMEOUT_FLOOR_MS,
    PIVOTA_BACKEND_BASE_URL: process.env.PIVOTA_BACKEND_BASE_URL,
    AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS: process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS,
  };

  beforeEach(() => {
    jest.resetModules();
    process.env.AURORA_BFF_RECO_BLOCKS_DAG_ENABLED = 'true';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_MAIN_RESOLVE_FALLBACK = 'false';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP = '1';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_MIN_BUDGET_MS = '150';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_TIMEOUT_FLOOR_MS = '150';
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://web-production-fedb.up.railway.app';
    delete process.env.AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS;
  });

  afterEach(() => {
    jest.resetModules();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('main_path executes at least one real search under tight remaining budget', async () => {
    const { __internal } = require(ROUTES_PATH);
    const searchFn = jest.fn(async () => ({
      ok: true,
      products: [],
      reason: 'empty',
      latency_ms: 12,
    }));

    const out = await __internal.buildRealtimeCompetitorCandidates({
      productUrl: 'https://example.com/products/copper-serum',
      parsedProduct: {
        brand: 'Example Brand',
        name: 'Copper Serum',
        display_name: 'Example Brand Copper Serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
      profileSummary: { skinType: 'oily', sensitivity: 'high', barrierStatus: 'impaired' },
      lang: 'EN',
      mode: 'main_path',
      timeoutMs: 260,
      deadlineMs: Date.now() + 170,
      maxQueries: 1,
      maxCandidates: 4,
      searchFn,
      logger: { debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
    });

    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(out).toBeTruthy();
    expect(out.meta).toBeTruthy();
    expect(Number(out.meta.query_attempted || 0)).toBeGreaterThanOrEqual(1);
    expect(out.reason).toBe('catalog_search_no_candidates');
  });
});

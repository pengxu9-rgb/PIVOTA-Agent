const {
  createRecoCatalogSearchSupportRuntime,
} = require('../src/auroraBff/recoCatalogSearchSupportRuntime');

describe('createRecoCatalogSearchSupportRuntime', () => {
  function buildRuntime(overrides = {}) {
    return createRecoCatalogSearchSupportRuntime({
      PRODUCT_INTEL_HTTP_URL_RE: /^https?:\/\//i,
      collectCandidateIngredientTokens: jest.fn(() => ['peptide', 'niacinamide']),
      collectCandidateSkinTypeTags: jest.fn(() => ['oily']),
      extractCandidateSocialReference: jest.fn(() => ({
        score: 0.63,
        support_count: 4,
        social_raw: { channels: ['reddit'] },
      })),
      extractCatalogCandidatePrice: jest.fn(() => ({
        amount: 19.5,
        currency: 'USD',
      })),
      normalizeCanonicalProductRef: jest.fn(({ merchant_id, product_id }) => (
        merchant_id && product_id ? `${merchant_id}:${product_id}` : ''
      )),
      RECO_CATALOG_SEARCH_PREFER_CONFIGURED_BASE_URLS: true,
      RECO_CATALOG_SEARCH_SELF_PROXY_ENABLED: true,
      RECO_CATALOG_SEARCH_AURORA_SELF_PROXY_FIRST: false,
      RECO_CATALOG_SEARCH_BASE_URLS: 'https://catalog-a.test https://catalog-b.test',
      PIVOTA_BACKEND_BASE_URL: 'https://primary.test/',
      RECO_CATALOG_SEARCH_SELF_PROXY_BASE_URL: 'https://self-proxy.test/',
      RECO_PDP_LOCAL_INVOKE_BASE_URL: 'https://local-fallback.test/',
      RECO_CATALOG_SEARCH_PATHS: '',
      RECO_CATALOG_BEAUTY_ROUTE_FIRST_ENABLED: true,
      RECO_CATALOG_BEAUTY_PATH_FALLBACK_ENABLED: true,
      RECO_CATALOG_SOURCE_EMPTY_FAIL_THRESHOLD: 2,
      RECO_CATALOG_SOURCE_EMPTY_COOLDOWN_MS: 5000,
      RECO_CATALOG_SOURCE_TRANSIENT_FAIL_THRESHOLD: 2,
      RECO_CATALOG_SOURCE_TRANSIENT_COOLDOWN_MS: 7000,
      RECO_CATALOG_FAIL_FAST_ENABLED: true,
      RECO_CATALOG_FAIL_FAST_COOLDOWN_MS: 1000,
      RECO_CATALOG_FAIL_FAST_THRESHOLD: 2,
      RECO_CATALOG_FAIL_FAST_PROBE_INTERVAL_MS: 200,
      ...overrides,
    });
  }

  test('normalizes reco catalog candidates into contract-safe product objects', () => {
    const runtime = buildRuntime();

    expect(runtime.normalizeRecoCatalogProduct({
      id: 'prod_1',
      merchantId: 'merch_1',
      brand_name: 'IPSA',
      title: 'Time Reset Aqua',
      displayName: 'IPSA Time Reset Aqua',
      skuId: 'sku_1',
      canonicalPdpUrl: 'https://shop.test/p/ipsa-time-reset-aqua',
      purchasePath: 'https://shop.test/checkout/123',
      source: { type: 'external_seed' },
      retrievalReason: 'cache_hit',
      imageUrl: 'https://cdn.test/image.jpg',
      productType: 'lotion',
    })).toEqual(expect.objectContaining({
      product_id: 'prod_1',
      merchant_id: 'merch_1',
      brand: 'IPSA',
      name: 'Time Reset Aqua',
      display_name: 'IPSA Time Reset Aqua',
      sku_id: 'sku_1',
      source: 'external_seed',
      retrieval_source: 'external_seed',
      retrieval_reason: 'cache_hit',
      pdp_url: 'https://shop.test/p/ipsa-time-reset-aqua',
      purchase_path: 'https://shop.test/checkout/123',
      canonical_product_ref: 'merch_1:prod_1',
      ingredient_tokens: ['peptide', 'niacinamide'],
      skin_type_tags: ['oily'],
      social_ref_support_count: 4,
      price: { amount: 19.5, currency: 'USD' },
    }));
  });

  test('builds base-url and path candidates with configured precedence', () => {
    const runtime = buildRuntime();

    expect(runtime.buildRecoCatalogSearchBaseUrlCandidates({ includeLocalFallback: true })).toEqual([
      'https://catalog-a.test',
      'https://catalog-b.test',
      'https://self-proxy.test',
      'https://primary.test',
      'https://local-fallback.test',
    ]);

    expect(runtime.buildRecoCatalogSearchPathCandidates()).toEqual([
      '/agent/v1/beauty/products/search',
      '/agent/v1/products/search',
    ]);
  });

  test('tracks source health and deprioritizes repeated empty sources', () => {
    const runtime = buildRuntime();
    const nowMs = 1_000;

    runtime.markRecoCatalogSearchSourceFailure('https://catalog-a.test', 'empty', nowMs);
    runtime.markRecoCatalogSearchSourceFailure('https://catalog-a.test', 'empty', nowMs + 1);
    runtime.markRecoCatalogSearchSourceSuccess('https://catalog-b.test', nowMs + 2);

    expect(runtime.rankRecoCatalogSearchBaseUrls([
      'https://catalog-a.test',
      'https://catalog-b.test',
    ], nowMs + 3)).toEqual([
      'https://catalog-b.test',
      'https://catalog-a.test',
    ]);

    expect(runtime.getRecoCatalogSearchSourceHealthSnapshot(nowMs + 3)).toEqual([
      expect.objectContaining({
        base_url: 'https://catalog-a.test',
        consecutive_empty: 2,
        consecutive_failures: 0,
        deprioritized: true,
        last_reason: 'empty',
      }),
      expect.objectContaining({
        base_url: 'https://catalog-b.test',
        consecutive_empty: 0,
        consecutive_failures: 0,
        deprioritized: false,
        last_reason: null,
      }),
    ]);
  });

  test('opens fail-fast after threshold and allows bounded probe windows', () => {
    const runtime = buildRuntime();

    runtime.markRecoCatalogFailFastFailure('upstream_error', 1_000);
    runtime.markRecoCatalogFailFastFailure('upstream_error', 1_010);

    expect(runtime.getRecoCatalogFailFastSnapshot(1_020)).toEqual(expect.objectContaining({
      open: true,
      consecutive_failures: 2,
      can_probe_while_open: false,
      last_reason: 'upstream_error',
    }));

    expect(runtime.beginRecoCatalogFailFastProbe(1_250)).toBe(true);
    expect(runtime.getRecoCatalogFailFastSnapshot(1_251)).toEqual(expect.objectContaining({
      open: true,
      can_probe_while_open: false,
      last_probe_started_at: 1_250,
    }));

    runtime.markRecoCatalogFailFastSuccess();
    expect(runtime.getRecoCatalogFailFastSnapshot(1_260)).toEqual(expect.objectContaining({
      open: false,
      consecutive_failures: 0,
      last_reason: null,
    }));
  });
});

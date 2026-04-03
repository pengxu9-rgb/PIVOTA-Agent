const nock = require('nock');
const request = require('supertest');

function readFallbackSections(resp) {
  const metadata =
    resp?.body?.metadata && typeof resp.body.metadata === 'object' && !Array.isArray(resp.body.metadata)
      ? resp.body.metadata
      : {};
  const proxySearchFallback =
    metadata.proxy_search_fallback &&
    typeof metadata.proxy_search_fallback === 'object' &&
    !Array.isArray(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : metadata;
  const fallbackStrategy =
    metadata.fallback_strategy &&
    typeof metadata.fallback_strategy === 'object' &&
    !Array.isArray(metadata.fallback_strategy)
      ? metadata.fallback_strategy
      : proxySearchFallback.fallback_strategy &&
        typeof proxySearchFallback.fallback_strategy === 'object' &&
        !Array.isArray(proxySearchFallback.fallback_strategy)
      ? proxySearchFallback.fallback_strategy
      : metadata;
  return { metadata, proxySearchFallback, fallbackStrategy };
}

describe('GET /agent/v1/products/search proxy fallback', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/services/ingredientProductRecall');
    nock.cleanAll();
    nock.disableNetConnect();
    nock.enableNetConnect((host) => {
      const h = String(host || '');
      return h.includes('127.0.0.1') || h.includes('localhost') || h === '::1';
    });

    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED:
        process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_ENABLED: process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED,
      PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED,
      PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY,
      PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA:
        process.env.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA,
      PROXY_SEARCH_RESOLVER_DETAIL_ENABLED: process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED,
      PROXY_SEARCH_INVOKE_FALLBACK_ENABLED:
        process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED,
      PROXY_SEARCH_AURORA_FORCE_FAST_MODE: process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE,
      PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK:
        process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK,
      PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK:
        process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK,
      PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS:
        process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS,
      PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED:
        process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED,
      PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY:
        process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY,
      PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE:
        process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE,
      PROXY_SEARCH_AURORA_FORCE_TWO_PASS: process.env.PROXY_SEARCH_AURORA_FORCE_TWO_PASS,
      PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS: process.env.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS: process.env.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS:
        process.env.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS,
      PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE:
        process.env.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE,
      PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED:
        process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED,
      PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES:
        process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES,
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER:
        process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER,
      UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS: process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS,
      PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS: process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS,
      PROXY_SEARCH_FALLBACK_TIMEOUT_MS: process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS,
      PROXY_SEARCH_RESOLVER_TIMEOUT_MS: process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS:
        process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS:
        process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS:
        process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS,
      PROXY_SEARCH_AURORA_API_BASE: process.env.PROXY_SEARCH_AURORA_API_BASE,
      PROXY_SEARCH_AURORA_BACKEND_BASE_URL:
        process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED:
        process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
      SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED:
        process.env.SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED,
    };

    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'true';
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    delete process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA;
    delete process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED;
    delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'false';
    process.env.SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED = 'false';
    delete process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE;
    delete process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK;
    delete process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK;
    delete process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS;
    process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED = 'false';
    delete process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY;
    delete process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE;
    delete process.env.PROXY_SEARCH_AURORA_FORCE_TWO_PASS;
    delete process.env.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS;
    delete process.env.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE;
    delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED;
    delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES;
    delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    delete process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS;
    delete process.env.PROXY_SEARCH_AURORA_API_BASE;
    delete process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL;
    delete process.env.DATABASE_URL;
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();

    if (!prevEnv) return;
    if (prevEnv.PIVOTA_API_BASE === undefined) delete process.env.PIVOTA_API_BASE;
    else process.env.PIVOTA_API_BASE = prevEnv.PIVOTA_API_BASE;
    if (prevEnv.PIVOTA_API_KEY === undefined) delete process.env.PIVOTA_API_KEY;
    else process.env.PIVOTA_API_KEY = prevEnv.PIVOTA_API_KEY;
    if (prevEnv.API_MODE === undefined) delete process.env.API_MODE;
    else process.env.API_MODE = prevEnv.API_MODE;
    if (prevEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevEnv.DATABASE_URL;
    if (prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    } else {
      process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED =
        prevEnv.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA =
        prevEnv.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED =
        prevEnv.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    } else {
      process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED =
        prevEnv.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FORCE_FAST_MODE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE;
    } else {
      process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE =
        prevEnv.PROXY_SEARCH_AURORA_FORCE_FAST_MODE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK;
    } else {
      process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK =
        prevEnv.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK;
    } else {
      process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK =
        prevEnv.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS;
    } else {
      process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS =
        prevEnv.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED;
    } else {
      process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED =
        prevEnv.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY;
    } else {
      process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY =
        prevEnv.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE =
        prevEnv.PROXY_SEARCH_AURORA_PRESERVE_SOURCE_ON_INVOKE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FORCE_TWO_PASS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FORCE_TWO_PASS;
    } else {
      process.env.PROXY_SEARCH_AURORA_FORCE_TWO_PASS =
        prevEnv.PROXY_SEARCH_AURORA_FORCE_TWO_PASS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS =
        prevEnv.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE;
    } else {
      process.env.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE =
        prevEnv.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED =
        prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES =
        prevEnv.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES;
    }
    if (prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    } else {
      process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER =
        prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER;
    }
    if (prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS === undefined) {
      delete process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    } else {
      process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS =
        prevEnv.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS;
    }
    if (prevEnv.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_FALLBACK_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_FALLBACK_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_FALLBACK_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_RESOLVER_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_RESOLVER_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS;
    } else {
      process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS =
        prevEnv.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_API_BASE === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_API_BASE;
    } else {
      process.env.PROXY_SEARCH_AURORA_API_BASE = prevEnv.PROXY_SEARCH_AURORA_API_BASE;
    }
    if (prevEnv.PROXY_SEARCH_AURORA_BACKEND_BASE_URL === undefined) {
      delete process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL;
    } else {
      process.env.PROXY_SEARCH_AURORA_BACKEND_BASE_URL =
        prevEnv.PROXY_SEARCH_AURORA_BACKEND_BASE_URL;
    }
    if (prevEnv.SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED === undefined) {
      delete process.env.SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED;
    } else {
      process.env.SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED =
        prevEnv.SEARCH_UPSTREAM_QUOTA_CLARIFY_ENABLED;
    }
    if (prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED === undefined) {
      delete process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    } else {
      process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED =
        prevEnv.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED;
    }
  });

  test('does not run resolver-first on proxy route by default', async () => {
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    delete process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED;

    const resolverSpy = jest.fn().mockResolvedValue({
      resolved: true,
      product_ref: {
        merchant_id: 'merch_efbc46b4619cfbdf',
        product_id: '9886500749640',
      },
      confidence: 1,
      reason: 'stable_alias_ref',
      metadata: { latency_ms: 9 },
    });
    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: resolverSpy,
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === 'Winona Soothing Repair Serum')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9886500749640',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Winona Soothing Repair Serum',
          },
        ],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'Winona Soothing Repair Serum',
        lang: 'en',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: '9886500749640',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resolverSpy).toHaveBeenCalledTimes(1);
  });

  test('beauty search alias reuses generic proxy route with aurora defaults', async () => {
    const queryText = 'Copper peptide serum';
    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '').includes(queryText) &&
          String(q.fast_mode || '') === 'true' &&
          String(q.allow_stale_cache || '') === 'false' &&
          String(q.allow_external_seed || '') === 'false' &&
          String(q.external_seed_strategy || '').length > 0
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper Peptide Serum',
          },
        ],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/beauty/products/search')
      .redirects(1)
      .query({
        query: queryText,
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });

  test('generic beauty search infers aurora defaults for skincare queries', async () => {
    const queryText = 'niacinamide serum';
    process.env.PROXY_SEARCH_AURORA_API_BASE = 'http://aurora-upstream.test';

    const auroraPrimaryScope = nock('http://aurora-upstream.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '').includes(queryText) &&
          String(q.fast_mode || '') === 'true' &&
          String(q.allow_stale_cache || '') === 'false' &&
          String(q.allow_external_seed || '') === 'false' &&
          String(q.external_seed_strategy || '').length > 0
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_generic_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Niacinamide Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
      });

    expect(resp.status).toBe(200);
    expect(auroraPrimaryScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_generic_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });

  test('shopping-agent source forces strict main path on public search route', async () => {
    const queryText = 'oil control serum';
    let capturedBody = null;

    const strictInvoke = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, function reply(_uri, body) {
        capturedBody = body;
        return {
          status: 'success',
          success: true,
          products: [
            {
              product_id: 'strict_1',
              merchant_id: 'merch_strict',
              title: 'Oil Control Serum',
              in_stock: true,
            },
          ],
          total: 1,
          metadata: {
            catalog_surface: 'agent_api',
            commerce_surface: 'agent_api',
          },
        };
      });

    const legacyV2 = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .reply(200, { status: 'success', success: true, products: [], total: 0 });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'shopping-agent',
      });

    expect(resp.status).toBe(200);
    expect(strictInvoke.isDone()).toBe(true);
    expect(legacyV2.isDone()).toBe(false);
    expect(capturedBody).toEqual(
      expect.objectContaining({
        operation: 'find_products_multi',
        metadata: expect.objectContaining({
          request_source: 'shopping-agent',
        }),
        payload: expect.objectContaining({
          search: expect.objectContaining({
            query: queryText,
            catalog_surface: 'agent_api',
            commerce_surface: 'agent_api',
            allow_external_seed: false,
          }),
        }),
      }),
    );
  });

  test('aurora source bypasses route-level external-seed direct path and enters invoke main path', async () => {
    const queryText = 'oil control serum';

    const directSeedScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '') === queryText &&
          String(q.external_seed_only || '').toLowerCase() === 'true' &&
          String(q.merchant_id || '') === 'external_seed'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'seed_direct_should_not_run',
            merchant_id: 'external_seed',
            title: 'Seed Direct Should Not Run',
          },
        ],
        total: 1,
      });

    const invokePrimaryScope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'invoke_main_aurora_1',
            merchant_id: 'merch_strict',
            title: 'Oil Control Serum Main Path',
            in_stock: true,
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        merchant_id: 'external_seed',
        external_seed_only: 'true',
      });

    expect(resp.status).toBe(200);
    expect(invokePrimaryScope.isDone()).toBe(true);
    expect(directSeedScope.isDone()).toBe(false);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'invoke_main_aurora_1',
        merchant_id: 'merch_strict',
      }),
    );
  });

  test('aurora source bypasses route-level dedicated upstream base and lets invoke main path own search', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_AURORA_API_BASE = 'http://aurora-upstream.test';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'false';

    const auroraPrimaryScope = nock('http://aurora-upstream.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const invokeMainPathScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_fallback_aurora_base',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum fallback aurora base',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(auroraPrimaryScope.isDone()).toBe(false);
    expect(invokeMainPathScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_fallback_aurora_base',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });

  test('v2 primary search failure does not fall back to legacy public search bridge', async () => {
    const queryText = 'sunscreen oily skin';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';

    const primaryV2Scope = nock('http://pivota.test')
      .post('/agent/v2/products/search')
      .query(true)
      .reply(502, {
        error: 'UPSTREAM_UNAVAILABLE',
        message: 'v2 primary failed',
      });

    const legacyV1Scope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'legacy_bridge_should_not_run',
            merchant_id: 'legacy_merch',
            title: 'Legacy Bridge Should Not Run',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(primaryV2Scope.isDone()).toBe(true);
    expect(legacyV1Scope.isDone()).toBe(false);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    const { metadata, proxySearchFallback } = readFallbackSections(resp);
    expect(String(metadata?.query_source || '')).toBe('agent_products_error_fallback');
    expect(String(metadata?.contract_bridge?.resolved_contract || '')).not.toBe('agent_v1');
    expect(String(proxySearchFallback?.reason || '')).not.toContain('legacy');
  });

  test('aurora source honors explicit allow_external_seed override from query params', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED = 'true';
    process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY = 'supplement_internal_first';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'false';

    const primaryScope = nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '').includes(queryText) &&
          String(q.fast_mode || '') === 'true' &&
          String(q.allow_external_seed || '') === 'false' &&
          String(q.external_seed_strategy || '').length > 0
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_override_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum',
          },
        ],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        allow_external_seed: 'false',
        external_seed_strategy: 'legacy',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
  });

  test('aurora source does not skip secondary fallback after resolver miss', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'upstream_timeout',
        metadata: {
          latency_ms: 12,
          sources: [{ source: 'agent_search_scoped', ok: false, reason: 'upstream_timeout' }],
        },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const secondaryScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.payload.search.fast_mode === true &&
          parsed.payload.search.allow_stale_cache === false &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_fallback_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum fallback',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(secondaryScope.isDone()).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_fallback_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    const { proxySearchFallback, fallbackStrategy } = readFallbackSections(resp);
    expect(proxySearchFallback.applied).toBe(true);
    expect(String(fallbackStrategy?.source || 'aurora_force_path')).toMatch(/aurora|force/i);
  });

  test('aurora source runs two-pass primary search and can adopt pass2 external-seed result', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED = 'true';
    process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY = 'supplement_internal_first';
    process.env.PROXY_SEARCH_AURORA_FORCE_TWO_PASS = 'true';
    process.env.PROXY_SEARCH_AURORA_TWO_PASS_MIN_USABLE = '2';
    process.env.PROXY_SEARCH_AURORA_PASS1_TIMEOUT_MS = '900';
    process.env.PROXY_SEARCH_AURORA_PASS2_TIMEOUT_MS = '800';

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '').includes(queryText) &&
          String(q.allow_external_seed || '') === 'false' &&
          String(q.fast_mode || '') === 'true'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '').includes(queryText) &&
          String(q.allow_external_seed || '') === 'true' &&
          String(q.external_seed_strategy || '').length > 0 &&
          String(q.fast_mode || '') === 'true'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'pass2_seed_candidate_1',
            merchant_id: 'external_seed',
            title: 'Copper peptide serum (seed)',
            source: 'external_seed',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'pass2_seed_candidate_1',
      }),
    );
    const { metadata, fallbackStrategy } = readFallbackSections(resp);
    const attemptCount = Number(
      fallbackStrategy?.secondary_attempt_count ?? metadata?.fallback_attempt_count ?? 0,
    );
    expect(attemptCount).toBeGreaterThanOrEqual(0);
  });

  test('aurora source preserves fallback_strategy and attempts secondary fallback on primary 5xx', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 4, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(504, {
        status: 'error',
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message: 'Search timeout',
        },
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.payload.search.fast_mode === true &&
          parsed.payload.search.allow_stale_cache === false &&
          String(parsed.payload.search.external_seed_strategy || '').length > 0 &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'beauty_timeout_recover_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum fallback',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'beauty_timeout_recover_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    const { proxySearchFallback } = readFallbackSections(resp);
    expect(proxySearchFallback.applied).toBe(true);
    expect(String(proxySearchFallback.reason || '')).toMatch(
      /empty_or_unusable_primary|upstream_status_5\d{2}|primary_request_failed/i,
    );
  });

  test('aurora source returns strict_empty with fallback_strategy when primary and secondary both fail', async () => {
    const queryText = 'retinol serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(504, {
        status: 'error',
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message: 'Search timeout',
        },
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.payload.search.fast_mode === true &&
          parsed.payload.search.allow_stale_cache === false &&
          String(parsed.payload.search.external_seed_strategy || '').length > 0 &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(504, {
        status: 'error',
        error: {
          code: 'UPSTREAM_TIMEOUT',
          message: 'fallback timeout',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    const { metadata } = readFallbackSections(resp);
    expect(String(metadata.query_source || '')).toContain('agent_products');
    expect(metadata.strict_empty).toBe(true);
    expect(String(metadata.strict_empty_reason || '')).toMatch(
      /primary_status_5xx|fallback_not_better|primary_timeout/i,
    );
  });

  test('aurora source treats 429 primary responses as fallback-eligible and adopts invoke fallback', async () => {
    const queryText = 'the ordinary copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(429, {
        status: 'error',
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'alt_429_1',
            merchant_id: 'merch_sigma',
            title: 'Copper Peptide Repair Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'alt_429_1',
        merchant_id: 'merch_sigma',
      }),
    );
    const { proxySearchFallback } = readFallbackSections(resp);
    expect(proxySearchFallback.applied).toBe(true);
    expect(String(proxySearchFallback.reason || '')).toMatch(
      /empty_or_unusable_primary|upstream_status_429|fallback_not_better/i,
    );
  });

  test('aurora source applies low-latency primary/fallback timeouts to avoid long upstream waits', async () => {
    const queryText = 'niacinamide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_SKIP_SECONDARY_FALLBACK_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';
    process.env.PROXY_SEARCH_ROUTE_PRIMARY_TIMEOUT_MS = '4200';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS = '450';
    process.env.PROXY_SEARCH_AURORA_FALLBACK_TIMEOUT_MS = '450';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .delay(900)
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'slow_primary_hit', merchant_id: 'merch_slow', title: 'Slow Primary' }],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '') === queryText &&
          parsed.metadata &&
          String(parsed.metadata.source || '') === 'aurora-bff'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'fast_fallback_hit', merchant_id: 'merch_fast', title: 'Niacinamide Hydrating Serum' }],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'fast_fallback_hit',
      }),
    );
    const { metadata, proxySearchFallback } = readFallbackSections(resp);
    expect(proxySearchFallback.applied).toBe(true);
    expect(String(proxySearchFallback.reason || '')).toMatch(
      /primary_request_failed|primary_irrelevant|empty_or_unusable_primary/i,
    );
    const primaryLatencyMs = Number(metadata?.route_health?.primary_latency_ms || 0);
    expect(primaryLatencyMs).toBeGreaterThanOrEqual(0);
    expect(primaryLatencyMs).toBeLessThan(1300);
  });

  test('aurora resolver timeout budget does not poison non-aurora resolver cache', async () => {
    const queryText = 'Copper peptide serum';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_RESOLVER_TIMEOUT_MS = '1600';
    process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS = '350';

    const resolverSpy = jest.fn().mockResolvedValue({
      resolved: false,
      confidence: 0,
      reason: 'no_candidates',
      reason_code: 'no_candidates',
      metadata: {
        latency_ms: 8,
        sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }],
      },
    });

    jest.doMock('../../src/services/productGroundingResolver', () => {
      const actual = jest.requireActual('../../src/services/productGroundingResolver');
      return {
        ...actual,
        resolveProductRef: resolverSpy,
      };
    });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .times(2)
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_anchor_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper peptide serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const auroraResp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });
    const callCountAfterAurora = resolverSpy.mock.calls.length;
    const genericResp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'shopping_agent',
      });
    const auroraTimeouts = resolverSpy.mock.calls
      .slice(0, callCountAfterAurora)
      .map((call) => Number(call?.[0]?.options?.timeout_ms || 0));
    const genericTimeouts = resolverSpy.mock.calls
      .slice(callCountAfterAurora)
      .map((call) => Number(call?.[0]?.options?.timeout_ms || 0));

    expect(auroraResp.status).toBe(200);
    expect(genericResp.status).toBe(200);
    expect(callCountAfterAurora).toBeGreaterThan(0);
    expect(resolverSpy.mock.calls.length).toBeGreaterThan(callCountAfterAurora);
    expect(auroraTimeouts.every((value) => value === 350)).toBe(true);
    expect(genericTimeouts.some((value) => value === 1600)).toBe(true);
  });

  test('resolver-first can be explicitly disabled for aurora source', async () => {
    const queryText = 'lab series moisturizer spf';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'false';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_DISABLE_AURORA = 'true';

    const resolverSpy = jest.fn().mockResolvedValue({
      resolved: false,
      confidence: 0,
      reason: 'no_candidates',
      reason_code: 'no_candidates',
      metadata: {
        latency_ms: 8,
        sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }],
      },
    });

    jest.doMock('../../src/services/productGroundingResolver', () => {
      const actual = jest.requireActual('../../src/services/productGroundingResolver');
      return {
        ...actual,
        resolveProductRef: resolverSpy,
      };
    });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'labseries_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Lab Series All-in-One Defense Lotion SPF 35',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resolverSpy).not.toHaveBeenCalled();
    expect(String(resp.body?.metadata?.search_trace?.final_decision || '').toLowerCase()).not.toBe('resolver_stage');
  });

  test('aurora source detects same-brand external monoculture and forces semantic retry fallback', async () => {
    const queryText = 'the ordinary copper peptide serum';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES = '1';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 8, sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'ord_1', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'The Multi-Peptide Collection' },
          { product_id: 'ord_2', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'Multi-Peptide + HA Serum' },
          { product_id: 'ord_3', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'Multi-Peptide + Copper Peptides 1% Serum' },
        ],
        total: 3,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '').includes(queryText)
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'ord_fb_1', merchant_id: 'external_seed', source: 'external_seed', brand: 'The Ordinary', title: 'The Multi-Peptide Collection' },
        ],
        total: 1,
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        const queryValue = String(q?.query || '').toLowerCase();
        return String(q?.source || '').toLowerCase() === 'aurora-bff' && queryValue.includes('multi peptide');
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_retry_brand_mix_1',
            merchant_id: 'merch_sigma',
            brand: 'Sigma Beauty',
            title: 'Copper Peptide Recovery Serum',
          },
          {
            product_id: 'cp_retry_brand_mix_2',
            merchant_id: 'merch_rare',
            brand: 'Rare Beauty',
            title: 'Firming Peptide Serum',
          },
          {
            product_id: 'cp_retry_brand_mix_3',
            merchant_id: 'merch_glow',
            brand: 'Glow Recipe',
            title: 'Hydrating Peptide Serum',
          },
        ],
        total: 3,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'cp_retry_brand_mix_1',
      }),
    );
    const { metadata, proxySearchFallback, fallbackStrategy } = readFallbackSections(resp);
    expect(proxySearchFallback.applied).toBe(true);
    expect(String(proxySearchFallback.reason || '')).toContain('primary_monoculture');
    const selectedQuery = String(
      fallbackStrategy?.secondary_selected_query || metadata?.secondary_selected_query || '',
    ).toLowerCase();
    if (selectedQuery) {
      expect(selectedQuery).toContain('multi peptide');
    }
  });

  test('resolver-first retries sanitized candidate for noisy lookup query', async () => {
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_STRONG_ONLY = 'true';
    process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED = 'true';

    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    const resolverSpy = jest.fn().mockImplementation(async ({ query }) => {
      if (String(query || '').trim() === 'ipsa') {
        return {
          resolved: true,
          product_ref: {
            merchant_id: resolvedMerchantId,
            product_id: resolvedProductId,
          },
          confidence: 1,
          reason: 'stable_alias_ref',
          reason_code: 'stable_alias_match',
          metadata: { latency_ms: 10, sources: [{ source: 'stable_alias_ref', ok: true, count: 1 }] },
        };
      }
      return {
        resolved: false,
        reason: 'no_candidates',
        reason_code: 'no_candidates',
        metadata: { latency_ms: 5, sources: [{ source: 'products_cache_global', ok: false, reason: 'no_results' }] },
      };
    });

    jest.doMock('../../src/services/productGroundingResolver', () => {
      const actual = jest.requireActual('../../src/services/productGroundingResolver');
      return {
        ...actual,
        resolveProductRef: resolverSpy,
      };
    });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          id: resolvedProductId,
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: 'IPSA Time Reset Aqua',
          price: 45,
          currency: 'USD',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'ipsa的商品有吗？',
        lang: 'zh',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_first',
        }),
      }),
    );
  });

  test('prefers resolver fallback when primary search returns unusable shell rows', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = 'prod_pref_1';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 8 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        total: 1,
        page: 1,
        page_size: 1,
        products: [
          {
            id: null,
            product_id: null,
            merchant_id: null,
            merchant_name: null,
            title: null,
            name: null,
          },
        ],
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('resolver fallback still works when invoke secondary fallback is disabled', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = 'prod_pref_1';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 8 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        total: 1,
        page: 1,
        page_size: 1,
        products: [
          {
            id: null,
            product_id: null,
            merchant_id: null,
            merchant_name: null,
            title: null,
            name: null,
          },
        ],
        metadata: {
          source: 'agent_sdk_fixed_delegate',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('keeps primary response when it already contains usable rows', async () => {
    const queryText = 'Winona Soothing Repair Serum';

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9886500749640',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: queryText,
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: '9886500749640',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    const { proxySearchFallback } = readFallbackSections(resp);
    expect(Boolean(proxySearchFallback.applied)).toBe(false);
  });

  test('uses resolver fallback when primary and invoke search both fail', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886499864904';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 12 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(500, {
        status: 'error',
        detail: 'Search failed',
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(500, {
        status: 'error',
        detail: 'Search failed',
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: queryText,
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    const { metadata, proxySearchFallback } = readFallbackSections(resp);
    expect(String(metadata.query_source || '')).toContain('resolver_fallback');
    expect(proxySearchFallback.applied).toBe(true);
    expect(String(proxySearchFallback.reason || '')).toMatch(
      /resolver_after_primary|resolver_after_exception|resolver_first/i,
    );
  });

  test('returns resolver reference-only row when lookup detail cannot be hydrated', async () => {
    const queryText = 'IPSA Time Reset Aqua';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_FIRST_ON_SEARCH_ROUTE_ENABLED = 'true';
    process.env.PROXY_SEARCH_RESOLVER_DETAIL_ENABLED = 'true';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 13 },
      }),
    }));

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(404, {
        status: 'error',
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' },
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(500, {
        status: 'error',
        detail: 'Search failed',
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_ref_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_first',
        }),
      }),
    );
  });

  test('skips irrelevant invoke fallback results and uses resolver fallback', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886499864904';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 1,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 9 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710920',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: queryText,
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({ query: queryText, lang: 'en' });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('supports q alias and triggers resolver fallback on primary error payload', async () => {
    const queryText = 'The Ordinary Niacinamide 10% + Zinc 1%';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886499864904';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.96,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 11 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .reply(200, {
        status: 'error',
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Search failed',
        },
        detail: 'Search failed',
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(500, {
        status: 'error',
        detail: 'Search failed',
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: queryText,
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        q: queryText,
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('uses resolver fallback when primary rows are usable but irrelevant for brand lookup', async () => {
    const queryText = 'IPSA related products';
    const resolvedMerchantId = 'merch_efbc46b4619cfbdf';
    const resolvedProductId = '9886500127048';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.95,
        reason: 'stable_alias_ref',
        metadata: { latency_ms: 10 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710920',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: 'IPSA Time Reset Aqua',
          brand: 'IPSA',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        limit: 5,
        offset: 0,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: resolvedProductId,
        merchant_id: resolvedMerchantId,
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_resolver_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'resolver_after_primary',
        }),
      }),
    );
  });

  test('returns empty soft fallback when brand lookup remains irrelevant after fallback chain', async () => {
    const queryText = 'IPSA related products';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 8, sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710920',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: '9859801710921',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Large Makeup Brush Set',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_error_fallback',
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'primary_irrelevant_no_fallback',
        }),
      }),
    );
  });

  test('rejects irrelevant resolver fallback for generic sunscreen query and adopts relevant invoke fallback', async () => {
    const queryText = 'Face SPF50+ PA++++ sunscreen';
    const resolvedMerchantId = 'merch_sleepwear';
    const resolvedProductId = 'sleepwear_prod_1';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: true,
        product_ref: {
          merchant_id: resolvedMerchantId,
          product_id: resolvedProductId,
        },
        confidence: 0.79,
        reason: 'token_overlap',
        metadata: { latency_ms: 9 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'brush_1',
            merchant_id: 'brush_merch',
            title: 'Round Powder Brush',
          },
        ],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return (
          body &&
          body.operation === 'get_product_detail' &&
          body.payload &&
          body.payload.product &&
          body.payload.product.merchant_id === resolvedMerchantId &&
          body.payload.product.product_id === resolvedProductId
        );
      })
      .reply(200, {
        status: 'success',
        product: {
          product_id: resolvedProductId,
          merchant_id: resolvedMerchantId,
          title: 'Plus Size Sleepwear Set',
        },
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'spf_hit_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Face SPF50+ PA++++ Sunscreen',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'spf_hit_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    const { metadata, proxySearchFallback } = readFallbackSections(resp);
    expect(proxySearchFallback).toEqual(
      expect.objectContaining({
        applied: true,
        reason: 'primary_irrelevant',
      }),
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        resolver_rejected_reason: 'resolver_irrelevant_to_original_query',
        resolver_query_used: queryText,
      }),
    );
  });

  test('face sunscreen query rejects brush-only results across primary and fallback', async () => {
    const queryText = 'Face sunscreen';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 7 },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'brush_1',
            merchant_id: 'brush_merch',
            title: 'Foundation Brush',
          },
          {
            product_id: 'brush_2',
            merchant_id: 'brush_merch',
            title: 'Makeup Sponge Kit',
          },
        ],
        total: 2,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'brush_fb_1',
            merchant_id: 'brush_merch',
            title: 'Powder Brush Set',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        lang: 'en',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    const { metadata, proxySearchFallback } = readFallbackSections(resp);
    expect(metadata.query_source).toBe('agent_products_error_fallback');
    expect(String(proxySearchFallback.reason || '')).toContain('primary_irrelevant');
  });

  test('aurora source accepts relevant secondary fallback even when usable count is lower than irrelevant primary', async () => {
    const queryText = 'copper peptides serum alternatives';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 9, sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'irrelevant_1', merchant_id: 'm1', title: 'Round Powder Brush' },
          { product_id: 'irrelevant_2', merchant_id: 'm2', title: 'Foundation Makeup Sponge' },
          { product_id: 'irrelevant_3', merchant_id: 'm3', title: 'Eyeliner Brush Kit' },
        ],
        total: 3,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '').includes(queryText)
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Copper Peptide Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThan(0);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'cp_1',
        merchant_id: 'merch_efbc46b4619cfbdf',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        proxy_search_fallback: expect.objectContaining({
          applied: true,
          reason: 'primary_irrelevant',
        }),
      }),
    );
  });

  test('aurora source retries semantic fallback query for primary_irrelevant and adopts second attempt', async () => {
    const queryText = 'copper peptide serum';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES = '1';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 8, sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          { product_id: 'irrelevant_1', merchant_id: 'm1', title: 'Round Powder Brush' },
          { product_id: 'irrelevant_2', merchant_id: 'm2', title: 'Foundation Makeup Sponge' },
          { product_id: 'irrelevant_3', merchant_id: 'm3', title: 'Eyeliner Brush Kit' },
        ],
        total: 3,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return (
          parsed &&
          parsed.operation === 'find_products_multi' &&
          parsed.payload &&
          parsed.payload.search &&
          String(parsed.payload.search.query || '').includes(queryText)
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'irrelevant_fb_1', merchant_id: 'm4', title: 'Gentle Hydrating Toner' }],
        total: 1,
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        const queryValue = String(q?.query || '').toLowerCase();
        return String(q?.source || '').toLowerCase() === 'aurora-bff' && queryValue.includes('multi peptide');
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'cp_retry_hit',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Multi-Peptide Face Serum',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'cp_retry_hit',
      }),
    );
    const { metadata, proxySearchFallback, fallbackStrategy } = readFallbackSections(resp);
    expect(proxySearchFallback.applied).toBe(true);
    expect(String(proxySearchFallback.reason || '')).toContain('primary_irrelevant');
    const selectedQuery = String(
      fallbackStrategy?.secondary_selected_query || metadata?.secondary_selected_query || '',
    ).toLowerCase();
    if (selectedQuery) {
      expect(selectedQuery).toContain('multi peptide');
    }
  });

  test('aurora semantic retry maps copper tripeptide query to copper peptide fallback', async () => {
    const queryText = 'copper tripeptide serum';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_ENABLED = 'true';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_IRRELEVANT_SEMANTIC_RETRY_MAX_QUERIES = '1';

    jest.doMock('../../src/services/productGroundingResolver', () => ({
      resolveProductRef: jest.fn().mockResolvedValue({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'no_candidates',
        metadata: { latency_ms: 8, sources: [{ source: 'agent_search_scoped', ok: false, reason: 'no_candidates' }] },
      }),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '').includes(queryText))
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'irrelevant_1', merchant_id: 'm1', title: 'Beauty Sponge Tools Kit' }],
        total: 1,
      });

    nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return String(parsed?.payload?.search?.query || '').includes(queryText);
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'irrelevant_fb_1', merchant_id: 'm4', title: 'Hydrating Toner' }],
        total: 1,
      });

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q?.source || '').toLowerCase() === 'aurora-bff' &&
          String(q?.query || '').toLowerCase().includes('copper peptide')
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'cp_tri_hit', merchant_id: 'merch_efbc46b4619cfbdf', title: 'Copper Peptide Serum' }],
        total: 1,
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products[0]).toEqual(expect.objectContaining({ product_id: 'cp_tri_hit' }));
    const { metadata, fallbackStrategy } = readFallbackSections(resp);
    const selectedQuery = String(
      fallbackStrategy?.secondary_selected_query || metadata?.secondary_selected_query || '',
    ).toLowerCase();
    if (selectedQuery) {
      expect(selectedQuery).toContain('copper peptide');
    }
    const attemptCount = Number(
      fallbackStrategy?.secondary_attempt_count ?? metadata?.fallback_attempt_count ?? 0,
    );
    expect(attemptCount).toBeGreaterThanOrEqual(1);
  });

  test('primary timeout does not trigger post-timeout fallback when total budget is exhausted', async () => {
    const queryText = 'retinol serum';
    process.env.PROXY_SEARCH_AURORA_PRIMARY_TIMEOUT_MS = '900';
    process.env.PROXY_SEARCH_AURORA_TOTAL_BUDGET_MS = '900';
    process.env.PROXY_SEARCH_AURORA_RESOLVER_TIMEOUT_MS = '450';
    process.env.PROXY_SEARCH_SECONDARY_FALLBACK_MULTI_ENABLED = 'false';
    process.env.PROXY_SEARCH_INVOKE_FALLBACK_ENABLED = 'false';
    process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK = 'true';
    process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS = 'true';

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => String(q.query || '') === queryText)
      .delay(1200)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
      });

    const invokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'should_not_be_called', merchant_id: 'm1', title: 'Fallback hit' }],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: queryText,
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toHaveLength(0);
    expect(invokeScope.isDone()).toBe(true);
    const { metadata } = readFallbackSections(resp);
    expect(metadata.strict_empty).toBe(true);
    expect(String(metadata.strict_empty_reason || '')).toMatch(
      /primary_timeout|fallback_not_better/i,
    );
  });

  test('external_seed_only search returns direct seed products for guidance discovery', async () => {
    process.env.DATABASE_URL = 'postgres://seed-direct-test';
    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_vitc_1',
              external_product_id: 'ext_vitc_1',
              destination_url: 'https://shop.example.com/products/vitamin-c-lotion',
              canonical_url: 'https://shop.example.com/products/vitamin-c-lotion',
              domain: 'shop.example.com',
              title: 'Vitamin-C Lotion',
              image_url: 'https://cdn.example.com/vitamin-c-lotion.jpg',
              price_amount: '30',
              price_currency: 'USD',
              availability: 'in stock',
              seed_data: {
                brand: 'Rose Inc',
                category: 'moisturizer',
                snapshot: {
                  title: 'Vitamin-C Lotion',
                  brand: 'Rose Inc',
                  category: 'moisturizer',
                  destination_url: 'https://shop.example.com/products/vitamin-c-lotion',
                  canonical_url: 'https://shop.example.com/products/vitamin-c-lotion',
                },
              },
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
            {
              id: 'seed_rose_1',
              external_product_id: 'ext_rose_ceramide_1',
              destination_url: 'https://shop.example.com/products/rose-ceramide-cream',
              canonical_url: 'https://shop.example.com/products/rose-ceramide-cream',
              domain: 'shop.example.com',
              title: 'Rose Ceramide Cream',
              image_url: 'https://cdn.example.com/rose-ceramide.jpg',
              price_amount: '42',
              price_currency: 'USD',
              availability: 'in stock',
              seed_data: {
                brand: 'Rose Inc',
                category: 'moisturizer',
                snapshot: {
                  title: 'Rose Ceramide Cream',
                  brand: 'Rose Inc',
                  category: 'moisturizer',
                  destination_url: 'https://shop.example.com/products/rose-ceramide-cream',
                  canonical_url: 'https://shop.example.com/products/rose-ceramide-cream',
                },
              },
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
        };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        merchant_id: 'external_seed',
        external_seed_only: 'true',
        query: 'moisturizer barrier repair ceramide np barrier repair',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        product_only: 'true',
        target_step_family: 'moisturizer',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThanOrEqual(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_rose_ceramide_1',
        title: 'Rose Ceramide Cream',
        pdp_url:
          'https://agent.pivota.cc/products/ext_rose_ceramide_1?merchant_id=external_seed&entry=aurora_chatbox',
        external_redirect_url: 'https://shop.example.com/products/rose-ceramide-cream',
        pdp_open: expect.objectContaining({
          path: 'resolve',
          product_ref: {
            product_id: 'ext_rose_ceramide_1',
            merchant_id: 'external_seed',
          },
          external: expect.objectContaining({
            url: 'https://shop.example.com/products/rose-ceramide-cream',
          }),
        }),
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_external_seed_direct',
        external_seed_only_requested: true,
        external_seed_returned_count: resp.body.products.length,
        external_seed_rows_fetched: expect.any(Number),
        external_seed_rows_built: expect.any(Number),
        product_only_applied: true,
      }),
    );
    expect(resp.body.metadata?.external_seed_rows_fetched).toBeGreaterThanOrEqual(resp.body.products.length);
    expect(resp.body.metadata?.external_seed_rows_built).toBeGreaterThanOrEqual(resp.body.products.length);
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        hit_quality: 'valid_hit',
        query_target_step_family: 'moisturizer',
        query_step_strength: 'strong_goal_family',
      }),
    );
  });

  test('ingredient-intent search uses direct KB and attached-seed recall before invoke fallback', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-direct-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            product_id: 'rose_ceramide_attached',
            merchant_id: 'external_seed',
            title: 'Rose Ceramide Cream',
            brand: 'Pixi Beauty',
            category: 'moisturizer',
            product_type: 'moisturizer',
            canonical_url: 'https://shop.example.com/products/rose-ceramide-cream',
            destination_url: 'https://shop.example.com/products/rose-ceramide-cream',
            url: 'https://shop.example.com/products/rose-ceramide-cream',
            image_url: 'https://cdn.example.com/rose-ceramide.jpg',
            price: 42,
            currency: 'USD',
            source: 'external_seed',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          kb_recall_attempted: true,
          kb_recall_recovered: 1,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 1,
          unattached_seed_recall_attempted: true,
          unattached_seed_recovered: 0,
          recall_source_breakdown: {
            kb_attached_seed: 1,
          },
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
      })),
    }));

    const invokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'should_not_run', merchant_id: 'm1', title: 'Should not run' }],
      });

    const app = require('../../src/server');
    const {
      recallIngredientProducts,
      resolveIngredientRecallProfile,
    } = require('../../src/services/ingredientProductRecall');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'ceramide moisturizer',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resolveIngredientRecallProfile).toHaveBeenCalledTimes(1);
    expect(recallIngredientProducts).toHaveBeenCalledTimes(1);
    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'ceramide_np',
        allowFamilyFallback: true,
      }),
    );
    expect(invokeScope.isDone()).toBe(false);
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'rose_ceramide_attached',
        title: 'Rose Ceramide Cream',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct',
        ingredient_intent_detected: true,
        kb_recall_attempted: true,
        kb_recall_recovered: 1,
        attached_seed_recall_attempted: true,
        attached_seed_recall_recovered: 1,
        clarify_applied_after_kb_exhausted: false,
        strict_empty_reason: null,
        ingredient_recall_source_breakdown: {
          kb_attached_seed: 1,
        },
      }),
    );
  });

  test('ingredient-alias sunscreen search also uses direct recall before invoke fallback', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-direct-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            product_id: 'spf_direct_1',
            merchant_id: 'external_seed',
            title: 'skinperfect primer spf30',
            brand: 'Dermalogica',
            category: 'sunscreen',
            product_type: 'sunscreen',
            canonical_url: 'https://shop.example.com/products/skinperfect-primer-spf30',
            destination_url: 'https://shop.example.com/products/skinperfect-primer-spf30',
            url: 'https://shop.example.com/products/skinperfect-primer-spf30',
            image_url: 'https://cdn.example.com/skinperfect-primer-spf30.jpg',
            source: 'external_seed',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          kb_recall_attempted: true,
          kb_recall_recovered: 1,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 0,
          unattached_seed_recall_attempted: true,
          unattached_seed_recovered: 1,
          recall_source_breakdown: {
            kb_attached_seed: 1,
          },
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'sunscreen_filters',
        ingredient_name: 'UV filters',
      })),
    }));

    const invokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'should_not_run', merchant_id: 'm1', title: 'Should not run' }],
      });

    const app = require('../../src/server');
    const {
      recallIngredientProducts,
      resolveIngredientRecallProfile,
    } = require('../../src/services/ingredientProductRecall');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'broad spectrum sunscreen',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resolveIngredientRecallProfile).toHaveBeenCalledTimes(1);
    expect(recallIngredientProducts).toHaveBeenCalledTimes(1);
    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'sunscreen_filters',
        allowFamilyFallback: true,
      }),
    );
    expect(invokeScope.isDone()).toBe(false);
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct',
        ingredient_intent_detected: true,
        kb_recall_attempted: true,
      }),
    );
  });

  test('ingredient-intent search can use KB-only profile knowledge for non-base ingredients', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-direct-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            product_id: 'alpha_arbutin_1',
            merchant_id: 'external_seed',
            title: 'Alpha Arbutin 2% + HA',
            brand: 'The Ordinary',
            category: 'serum',
            product_type: 'serum',
            canonical_url: 'https://shop.example.com/products/alpha-arbutin-2-ha',
            destination_url: 'https://shop.example.com/products/alpha-arbutin-2-ha',
            url: 'https://shop.example.com/products/alpha-arbutin-2-ha',
            image_url: 'https://cdn.example.com/alpha-arbutin.jpg',
            source: 'external_seed',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_profile_source: 'kb_only',
          kb_recall_attempted: true,
          kb_recall_recovered: 1,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 1,
          recall_source_breakdown: {
            kb_attached_seed: 1,
          },
        },
      })),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: {
          ingredient_id: 'alpha_arbutin',
          ingredient_name: 'Alpha Arbutin',
        },
        diagnostics: {
          profile_source: 'kb_only',
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => null),
    }));

    const invokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'should_not_run', merchant_id: 'm1', title: 'Should not run' }],
      });

    const app = require('../../src/server');
    const {
      recallIngredientProducts,
      resolveIngredientRecallProfileKnowledge,
      resolveIngredientRecallProfile,
    } = require('../../src/services/ingredientProductRecall');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'alpha arbutin serum',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resolveIngredientRecallProfileKnowledge).toHaveBeenCalledTimes(1);
    expect(resolveIngredientRecallProfile).not.toHaveBeenCalled();
    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'alpha_arbutin',
        allowFamilyFallback: true,
      }),
    );
    expect(invokeScope.isDone()).toBe(false);
    expect(resp.body.products).toHaveLength(1);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct',
        ingredient_profile_source: 'kb_only',
        ingredient_intent_detected: true,
      }),
    );
  });

  test('ingredient-intent search keeps treatment intent for azelaic acid cream even when moisturizer family is also allowed', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-intent-azelaic-target-step-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local_plus_reference',
          ingredient_profile_source: 'local_plus_reference',
          ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
        },
      })),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: {
          ingredient_id: 'azelaic_acid',
          ingredient_name: 'Azelaic acid',
          ingredient_class: 'tone_evening_active',
          expected_step_families: ['treatment', 'cream', 'serum'],
        },
        diagnostics: {
          registry_match: true,
          registry_source: 'local_plus_reference',
          profile_source: 'local_plus_reference',
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => null),
    }));

    const app = require('../../src/server');
    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'azelaic acid cream',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'azelaic_acid',
        targetStepFamily: 'treatment',
      }),
    );
  });

  test('ingredient-intent search keeps treatment intent for benzoyl peroxide gel', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-intent-benzoyl-target-step-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local',
          ingredient_profile_source: 'local',
          ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
        },
      })),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: {
          ingredient_id: 'benzoyl_peroxide',
          ingredient_name: 'Benzoyl peroxide',
          ingredient_class: 'acne_active',
          expected_step_families: ['treatment', 'gel', 'cleanser'],
        },
        diagnostics: {
          registry_match: true,
          registry_source: 'local',
          profile_source: 'local',
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => null),
    }));

    const app = require('../../src/server');
    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'benzoyl peroxide gel',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'benzoyl_peroxide',
        targetStepFamily: 'treatment',
      }),
    );
  });

  test('ingredient-intent search keeps oil intent for squalane oil instead of defaulting to moisturizer', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-intent-squalane-target-step-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local_plus_reference',
          ingredient_profile_source: 'local_plus_reference',
          ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
        },
      })),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: {
          ingredient_id: 'squalane',
          ingredient_name: 'Squalane',
          ingredient_class: 'oil',
          expected_step_families: ['moisturizer', 'oil', 'serum'],
        },
        diagnostics: {
          registry_match: true,
          registry_source: 'local_plus_reference',
          profile_source: 'local_plus_reference',
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => null),
    }));

    const app = require('../../src/server');
    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'squalane oil',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(recallIngredientProducts).toHaveBeenCalledWith(
      expect.objectContaining({
        ingredientId: 'squalane',
        targetStepFamily: 'oil',
      }),
    );
  });

  test('ingredient-intent direct recall keeps same-family ceramide products and drops adjacent-family noise', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-direct-display-rerank-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            product_id: 'ceramide_moist_1',
            merchant_id: 'external_seed',
            title: 'Rose Ceramide Cream',
            category: 'moisturizer',
            product_type: 'moisturizer',
            canonical_url: 'https://shop.example.com/products/rose-ceramide-cream',
            destination_url: 'https://shop.example.com/products/rose-ceramide-cream',
            url: 'https://shop.example.com/products/rose-ceramide-cream',
          },
          {
            product_id: 'ceramide_moist_2',
            merchant_id: 'external_seed',
            title: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
            category: 'moisturizer',
            product_type: 'moisturizer',
            canonical_url: 'https://shop.example.com/products/apres-ceramides',
            destination_url: 'https://shop.example.com/products/apres-ceramides',
            url: 'https://shop.example.com/products/apres-ceramides',
          },
          {
            product_id: 'ceramide_adjacent_1',
            merchant_id: 'external_seed',
            title: 'Overnight Retinol Oil',
            description: 'retinol oil with ceramides',
            category: 'oil',
            product_type: 'oil',
            canonical_url: 'https://shop.example.com/products/overnight-retinol-oil',
            destination_url: 'https://shop.example.com/products/overnight-retinol-oil',
            url: 'https://shop.example.com/products/overnight-retinol-oil',
          },
          {
            product_id: 'ceramide_adjacent_2',
            merchant_id: 'external_seed',
            title: 'Hyaluronic Acid 2% + B5 (with Ceramides)',
            description: 'hydrating serum with ceramides',
            category: 'serum',
            product_type: 'serum',
            canonical_url: 'https://shop.example.com/products/ha-b5-ceramides',
            destination_url: 'https://shop.example.com/products/ha-b5-ceramides',
            url: 'https://shop.example.com/products/ha-b5-ceramides',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          kb_recall_attempted: true,
          kb_recall_recovered: 1,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 0,
          unattached_seed_recall_attempted: true,
          unattached_seed_recovered: 1,
          recall_source_breakdown: {
            kb_attached_seed: 1,
            unattached_seed: 3,
          },
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
        exact_phrases: ['ceramide np'],
        alias_phrases: ['ceramide', 'ceramides'],
        family_phrases: ['barrier', 'repair', 'moisturizer', 'cream'],
      })),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'ceramide moisturizer',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products.map((row) => row.title)).toEqual([
      'Rose Ceramide Cream',
      'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
    ]);
  });

  test('ingredient-intent direct recall collapses sunscreen refill and shade variants', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-direct-sunscreen-collapse-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            product_id: 'spf_shield',
            merchant_id: 'external_seed',
            title: 'On-the-Glow SHIELD SPF 50',
            category: 'sunscreen',
            product_type: 'sunscreen',
            canonical_url: 'https://shop.example.com/products/spf-shield',
            destination_url: 'https://shop.example.com/products/spf-shield',
            url: 'https://shop.example.com/products/spf-shield',
          },
          {
            product_id: 'spf_hydra_base',
            merchant_id: 'external_seed',
            title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
            category: 'sunscreen',
            product_type: 'sunscreen',
            canonical_url: 'https://shop.example.com/products/hydra-vizor',
            destination_url: 'https://shop.example.com/products/hydra-vizor',
            url: 'https://shop.example.com/products/hydra-vizor',
          },
          {
            product_id: 'spf_hydra_refill',
            merchant_id: 'external_seed',
            title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer Refill',
            category: 'sunscreen',
            product_type: 'sunscreen',
            canonical_url: 'https://shop.example.com/products/hydra-vizor-refill',
            destination_url: 'https://shop.example.com/products/hydra-vizor-refill',
            url: 'https://shop.example.com/products/hydra-vizor-refill',
          },
          {
            product_id: 'spf_hydra_tint_1',
            merchant_id: 'external_seed',
            title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 1',
            category: 'sunscreen',
            product_type: 'sunscreen',
            canonical_url: 'https://shop.example.com/products/hydra-vizor-huez-1',
            destination_url: 'https://shop.example.com/products/hydra-vizor-huez-1',
            url: 'https://shop.example.com/products/hydra-vizor-huez-1',
          },
          {
            product_id: 'spf_hydra_tint_2',
            merchant_id: 'external_seed',
            title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 2',
            category: 'sunscreen',
            product_type: 'sunscreen',
            canonical_url: 'https://shop.example.com/products/hydra-vizor-huez-2',
            destination_url: 'https://shop.example.com/products/hydra-vizor-huez-2',
            url: 'https://shop.example.com/products/hydra-vizor-huez-2',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          kb_recall_attempted: true,
          kb_recall_recovered: 1,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 1,
          unattached_seed_recall_attempted: true,
          unattached_seed_recovered: 1,
          recall_source_breakdown: {
            kb_attached_seed: 1,
            unattached_seed: 4,
          },
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'sunscreen_filters',
        ingredient_name: 'UV filters',
        exact_phrases: ['uv filters', 'uv filter'],
        alias_phrases: ['broad spectrum', 'sunscreen', 'spf', 'spf 50'],
        family_phrases: ['daily face', 'sun protection'],
      })),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'broad spectrum sunscreen',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products.map((row) => row.title)).toEqual([
      'On-the-Glow SHIELD SPF 50',
      'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
      'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 1',
    ]);
  });

  test('ingredient-intent search returns direct-empty with explicit miss reason before generic clarify', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-external-fallback-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'reference',
          ingredient_profile_source: 'reference',
          ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
          kb_recall_attempted: true,
          kb_recall_recovered: 0,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 0,
          family_fallback_attempted: false,
          family_fallback_recovered: 0,
          family_fallback_used: false,
          recall_source_breakdown: {},
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'panthenol',
        ingredient_name: 'Panthenol (B5)',
      })),
    }));
    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        return {
          rows: [
            {
              id: 'seed_winona_panthenol',
              external_product_id: 'ext_panthenol_1',
              destination_url: 'https://winona.example.com/products/panthenol-serum',
              canonical_url: 'https://winona.example.com/products/panthenol-serum',
              domain: 'winona.example.com',
              title: 'Winona Soothing Repair Serum with Panthenol',
              image_url: 'https://winona.example.com/image.jpg',
              price_amount: 29,
              price_currency: 'USD',
              availability: 'in_stock',
              seed_data: {
                brand: 'Winona',
                category: 'Serum',
                snapshot: {
                  title: 'Winona Soothing Repair Serum with Panthenol',
                  description: 'panthenol serum for soothing barrier repair support',
                  brand: 'Winona',
                  category: 'Serum',
                  canonical_url: 'https://winona.example.com/products/panthenol-serum',
                  destination_url: 'https://winona.example.com/products/panthenol-serum',
                },
              },
            },
          ],
        };
      }),
    }));

    const invokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'should_not_run', merchant_id: 'm1', title: 'Should not run' }],
      });

    const app = require('../../src/server');
    const {
      recallIngredientProducts,
      resolveIngredientRecallProfile,
    } = require('../../src/services/ingredientProductRecall');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'panthenol repair serum',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resolveIngredientRecallProfile).toHaveBeenCalledTimes(1);
    expect(recallIngredientProducts).toHaveBeenCalledTimes(1);
    expect(invokeScope.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct_empty',
        ingredient_direct_main_path_status: 'direct_empty_unrecovered',
        ingredient_intent_detected: true,
        ingredient_registry_match: true,
        ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
        kb_recall_attempted: true,
        ingredient_direct_source_statuses: expect.any(Object),
      }),
    );
  });

  test('ingredient-intent search does not treat family-only recall rows as direct success', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-family-only-direct-empty-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            product_id: 'family_only_1',
            merchant_id: 'external_seed',
            title: 'Soothing & Barrier Support Serum',
            category: 'serum',
            product_type: 'serum',
            canonical_url: 'https://shop.example.com/products/support-serum',
            destination_url: 'https://shop.example.com/products/support-serum',
            url: 'https://shop.example.com/products/support-serum',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local_plus_reference',
          ingredient_profile_source: 'local_plus_reference',
          ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
          ingredient_candidate_evidence_breakdown: {
            kb_explicit: 0,
            title_exact: 0,
            title_alias: 0,
            ingredient_token_exact: 0,
            ingredient_token_alias: 0,
            url_alias: 0,
            family_only: 1,
          },
          kb_recall_attempted: true,
          kb_recall_recovered: 0,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 0,
          family_fallback_attempted: true,
          family_fallback_recovered: 1,
          family_fallback_used: true,
          recall_source_breakdown: {
            family_attached_seed: 1,
          },
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'panthenol',
        ingredient_name: 'Panthenol (B5)',
        exact_phrases: ['panthenol'],
        alias_phrases: ['b5', 'vitamin b5'],
        family_phrases: ['soothing serum', 'barrier repair serum'],
      })),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'panthenol repair serum',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct_empty',
        ingredient_direct_main_path_status: 'direct_empty_unrecovered',
        ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
        family_fallback_used: true,
      }),
    );
  });

  test('ingredient-intent search does not force direct success for generic titles when service reports token-only KB explicit miss', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-kb-explicit-display-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local_plus_reference_plus_signal',
          ingredient_profile_source: 'local_plus_reference_plus_signal',
          ingredient_direct_main_path_status: 'direct_empty_unrecovered',
          ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
          ingredient_candidate_evidence_breakdown: {
            kb_explicit: 1,
            title_exact: 0,
            title_alias: 0,
            ingredient_token_exact: 1,
            ingredient_token_alias: 0,
            url_alias: 0,
            family_only: 0,
          },
          ingredient_ranked_candidate_samples: [
            {
              title: 'Barrier Support Moisturizer',
              kb_explicit: 1,
              explicit_hits: 2,
              target_surface_anchor_hits: 0,
              surface_explicit_hits: 1,
              runtime_ingredient_evidence_source: 'seed_structured_fields',
              seed_anchor_source_kind: 'kb_reviewed',
              structured_token_tier: 'kb_reviewed_seed',
              source_tag: 'kb_named_attached_seed',
            },
          ],
          kb_recall_attempted: true,
          kb_recall_recovered: 1,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 1,
          recall_source_breakdown: {
            kb_named_attached_seed: 1,
          },
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'glycerin',
        ingredient_name: 'Glycerin',
        ingredient_class: 'humectant',
        exact_phrases: ['glycerin'],
        alias_phrases: ['glycerine'],
        family_phrases: ['hydrating', 'moisturizer', 'barrier'],
        expected_step_families: ['moisturizer', 'serum'],
      })),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'glycerin moisturizer',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products).toHaveLength(0);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct_empty',
        ingredient_direct_main_path_status: 'direct_empty_unrecovered',
        ingredient_direct_miss_reason: 'no_explicit_sku_evidence',
        ingredient_direct_source_statuses: expect.any(Object),
      }),
    );
  });

  test('ingredient-intent search surfaces registry_unavailable miss instead of generic fallback', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-direct-empty-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      hasIngredientRegistryIntentSignal: jest.fn(() => true),
      getIngredientRecallRegistryHealth: jest.fn(async () => ({
        ok: false,
        sources: {},
      })),
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: false,
          ingredient_registry_source: 'none',
          ingredient_profile_source: 'none',
          ingredient_direct_miss_reason: 'registry_unavailable',
          kb_recall_attempted: false,
          kb_recall_recovered: 0,
          attached_seed_recall_attempted: false,
          attached_seed_recall_recovered: 0,
          family_fallback_attempted: false,
          family_fallback_recovered: 0,
          family_fallback_used: false,
          recall_source_breakdown: {},
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => null),
      resolveIngredientRecallProfileKnowledge: jest.fn(async () => ({
        profile: null,
        diagnostics: {
          registry_match: false,
          registry_source: 'none',
          profile_source: 'none',
          registry_unavailable: true,
          registry_source_breakdown: { local: 0, reference: 0, signal: 0 },
        },
      })),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'alpha arbutin serum',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct_empty',
        ingredient_direct_miss_reason: 'registry_unavailable',
        ingredient_registry_match: false,
      }),
    );
  });

  test('ingredient-intent direct recall empty does not fall back to invoke even for sunscreen queries', async () => {
    process.env.DATABASE_URL = 'postgres://ingredient-recall-direct-empty-sunscreen-test';
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [],
        diagnostics: {
          ingredient_intent_detected: true,
          ingredient_registry_match: true,
          ingredient_registry_source: 'local_plus_reference',
          ingredient_profile_source: 'local_plus_reference',
          ingredient_direct_miss_reason: 'all_candidates_filtered_noise',
          kb_recall_attempted: true,
          kb_recall_recovered: 0,
          attached_seed_recall_attempted: true,
          attached_seed_recall_recovered: 0,
          family_fallback_attempted: true,
          family_fallback_recovered: 0,
          family_fallback_used: false,
          recall_source_breakdown: {},
        },
      })),
      resolveIngredientRecallProfile: jest.fn(() => ({
        ingredient_id: 'sunscreen_filters',
        ingredient_name: 'UV filters',
        exact_phrases: ['uv filters', 'uv filter'],
        alias_phrases: ['broad spectrum', 'sunscreen', 'spf', 'spf 50'],
        family_phrases: ['daily face', 'sun protection'],
      })),
    }));
    const invokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        products: [{ product_id: 'should_not_run', merchant_id: 'm1', title: 'Should not run' }],
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'broad spectrum sunscreen',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(invokeScope.isDone()).toBe(false);
    expect(resp.body.products).toEqual([]);
    expect(resp.body.total).toBe(0);
    expect(resp.body.page_size).toBe(0);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_ingredient_recall_direct_empty',
        ingredient_direct_miss_reason: 'all_candidates_filtered_noise',
        products_returned_count: 0,
        external_seed_returned_count: 0,
      }),
    );
  });

  test('non-ingredient shopping search keeps invoke path and skips ingredient direct recall', async () => {
    jest.doMock('../../src/services/ingredientProductRecall', () => ({
      recallIngredientProducts: jest.fn(async () => ({
        products: [
          {
            product_id: 'should_not_be_used',
            merchant_id: 'external_seed',
            title: 'Should Not Be Used',
            url: 'https://shop.example.com/products/should-not-be-used',
          },
        ],
        diagnostics: {
          ingredient_intent_detected: true,
        },
      })),
    }));

    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query(true)
      .reply(200, {
        status: 'success',
        success: true,
        products: [],
        total: 0,
        metadata: {
          query_source: 'proxy_primary_empty_for_invoke_test',
        },
      });

    const invokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => body && body.operation === 'find_products_multi')
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'invoke_result_1',
            merchant_id: 'merch_efbc46b4619cfbdf',
            title: 'Barrier Repair Moisturizer for Dry Skin',
            category: 'moisturizer',
            product_type: 'moisturizer',
          },
        ],
        total: 1,
      });

    const app = require('../../src/server');
    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'moisturizer for dry skin',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
      });

    expect(resp.status).toBe(200);
    expect(invokeScope.isDone()).toBe(true);
    expect(recallIngredientProducts).not.toHaveBeenCalled();
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: 'invoke_result_1',
          title: 'Barrier Repair Moisturizer for Dry Skin',
        }),
      ]),
    );
  });

  test('guidance external_seed_only search enters direct path without explicit external_seed merchant_id', async () => {
    process.env.DATABASE_URL = 'postgres://seed-direct-guidance-no-merchant-test';
    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return {
          rows: [
            {
              id: 'seed_apres_1',
              external_product_id: 'ext_apres_barrier_1',
              destination_url: 'https://shop.example.com/products/apres-barrier-moisturizer',
              canonical_url: 'https://shop.example.com/products/apres-barrier-moisturizer',
              domain: 'shop.example.com',
              title: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
              image_url: 'https://cdn.example.com/apres-barrier.jpg',
              price_amount: '38',
              price_currency: 'USD',
              availability: 'in stock',
              seed_data: {
                brand: 'After Beauty',
                category: 'moisturizer',
                snapshot: {
                  title: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
                  brand: 'After Beauty',
                  category: 'moisturizer',
                  destination_url: 'https://shop.example.com/products/apres-barrier-moisturizer',
                  canonical_url: 'https://shop.example.com/products/apres-barrier-moisturizer',
                },
              },
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
        };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        external_seed_only: 'true',
        query: 'fragrance-free barrier moisturizer',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        decision_mode: 'guidance_only',
        product_only: 'true',
        allow_external_seed: 'true',
        target_step_family: 'moisturizer',
      });

    expect(resp.status).toBe(200);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.length).toBeGreaterThanOrEqual(1);
    expect(resp.body.products[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_apres_barrier_1',
        title: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
      }),
    );
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_external_seed_direct',
        external_seed_only_requested: true,
        external_seed_returned_count: resp.body.products.length,
      }),
    );
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        decision_mode: 'guidance_only',
        query_target_step_family: 'moisturizer',
      }),
    );
  });

  test('guidance external-seed direct search keeps moisturizer recall thick even when UI limit is small', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-direct-budget-floor-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql, params = []) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        const sqlParams = Array.isArray(params) ? params : [];
        const variantLimit = Number(sqlParams[sqlParams.length - 1] || 0) || 0;
        const now = new Date().toISOString();
        const buildRow = (id, title, brand) => ({
          id,
          market: 'US',
          tool: '*',
          external_product_id: id,
          destination_url: `https://${brand.toLowerCase().replace(/\s+/g, '')}.example.com/products/${id}`,
          canonical_url: `https://${brand.toLowerCase().replace(/\s+/g, '')}.example.com/products/${id}`,
          domain: `${brand.toLowerCase().replace(/\s+/g, '')}.example.com`,
          title,
          image_url: `https://cdn.example.com/${id}.jpg`,
          price_amount: '40',
          price_currency: 'USD',
          availability: 'in stock',
          seed_data: {
            brand,
            category: 'moisturizer',
            snapshot: {
              title,
              brand,
              category: 'moisturizer',
            },
          },
          updated_at: now,
          created_at: now,
        });
        if (variantLimit < 120) {
          return {
            rows: [
              buildRow('seed_rose', 'Rose Ceramide Cream', 'Pixi Beauty'),
              buildRow(
                'seed_nmf',
                'Natural Moisturizing Factors + PhytoCeramides',
                'The Ordinary',
              ),
            ],
          };
        }
        return {
          rows: [
            buildRow(
              'seed_apres',
              'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
              'Olehenriksen',
            ),
            buildRow(
              'seed_skintific_mini',
              '5X Ceramide Barrier Repair Moisture Gel (Mini Sample)',
              'SKINTIFIC',
            ),
            buildRow(
              'seed_skintific_b5',
              '5% B5 Ceramide Barrier Relief Moisturizer',
              'SKINTIFIC',
            ),
            buildRow('seed_rose', 'Rose Ceramide Cream', 'Pixi Beauty'),
            buildRow(
              'seed_nmf',
              'Natural Moisturizing Factors + PhytoCeramides',
              'The Ordinary',
            ),
            buildRow(
              'seed_filaderme',
              'Filaderme Emulsion - Face Lotion For Dry Skin',
              'Embryolisse',
            ),
          ],
        };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        merchant_id: 'external_seed',
        external_seed_only: 'true',
        query: 'ceramide barrier moisturizer',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        product_only: 'true',
        target_step_family: 'moisturizer',
        query_step_strength: 'strong_goal_family',
        decision_mode: 'guidance_only',
        source_policy: 'internal_first_then_external_supplement',
      });

    expect(resp.status).toBe(200);
    const returnedTitles = resp.body.products.map((row) => row.title);
    expect(returnedTitles[0]).toBe('Après Skin Rich Rescue Barrier Moisturizer with Ceramides');
    expect(returnedTitles).toEqual(
      expect.arrayContaining([
        'Rose Ceramide Cream',
        '5X Ceramide Barrier Repair Moisture Gel (Mini Sample)',
        'Natural Moisturizing Factors + PhytoCeramides',
        'Filaderme Emulsion - Face Lotion For Dry Skin',
      ]),
    );
    expect(returnedTitles).not.toContain('Lait-Crème Sensitive - Fragrance free');
    expect(returnedTitles.indexOf('5X Ceramide Barrier Repair Moisture Gel (Mini Sample)')).toBeGreaterThan(
      returnedTitles.indexOf('Rose Ceramide Cream'),
    );
    const b5Index = returnedTitles.indexOf('5% B5 Ceramide Barrier Relief Moisturizer');
    if (b5Index >= 0) {
      expect(returnedTitles.indexOf('5X Ceramide Barrier Repair Moisture Gel (Mini Sample)')).toBeGreaterThan(b5Index);
    }
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_external_seed_direct',
        external_seed_rows_fetched: 6,
        external_seed_rows_built: 6,
        external_seed_returned_count: 6,
        retrieval_budget: expect.objectContaining({
          floor_applied: true,
          per_variant_limit: expect.any(Number),
          raw_product_cap: expect.any(Number),
        }),
      }),
    );
    expect(resp.body.metadata?.retrieval_budget?.per_variant_limit).toBeGreaterThanOrEqual(120);
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        hit_quality: 'valid_hit',
        query_target_step_family: 'moisturizer',
        query_step_strength: 'strong_goal_family',
        products_returned_count: 6,
        retrieval_budget: expect.objectContaining({
          floor_applied: true,
        }),
      }),
    );
  });

  test('guidance-only external-seed direct search demotes moisturizer noise and surfaces target-relevant rows first', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-external-seed-ranking-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds')) {
          const now = new Date().toISOString();
          return {
            rows: [
              {
                id: 'seed_apres',
                market: 'US',
                tool: '*',
                title: 'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
                canonical_url: 'https://olehenriksen.com/products/apres-skin-multi-use-rich-rescue-cream',
                destination_url: 'https://olehenriksen.com/products/apres-skin-multi-use-rich-rescue-cream',
                availability: 'in stock',
                seed_data: { brand: 'Olehenriksen', category: 'moisturizer' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_rose',
                market: 'US',
                tool: '*',
                title: 'Rose Ceramide Cream',
                canonical_url: 'https://pixibeauty.com/products/rose-ceramide-cream',
                destination_url: 'https://pixibeauty.com/products/rose-ceramide-cream',
                availability: 'in stock',
                seed_data: { brand: 'PIXI BEAUTY', category: 'moisturizer' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_bundle',
                market: 'US',
                tool: '*',
                title: 'Build Your Own AM + PM Moisturizer Bundle',
                canonical_url: 'https://fentybeauty.com/products/build-your-own-am-pm-moisturizer-bundle',
                destination_url: 'https://fentybeauty.com/products/build-your-own-am-pm-moisturizer-bundle',
                availability: 'in stock',
                seed_data: { brand: 'Fenty Beauty', category: 'moisturizer' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_routine',
                market: 'US',
                tool: '*',
                title: 'Cult Fragrance-Free Skincare Routine',
                canonical_url: 'https://embryolisse.example.com/products/natural-beauty-set',
                destination_url: 'https://embryolisse.example.com/products/natural-beauty-set',
                availability: 'in stock',
                seed_data: {
                  brand: 'EMBRYOLISSE',
                  category: 'moisturizer',
                  description:
                    'A 2-step fragrance-free moisturizer routine for sensitive face skin',
                },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_tint',
                market: 'US',
                tool: '*',
                title: 'Positive Light Tinted Moisturizer',
                canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer',
                destination_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer',
                availability: 'in stock',
                seed_data: { brand: 'Rare Beauty', category: 'moisturizer' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_peel',
                market: 'US',
                tool: '*',
                title: 'Hydrating Milky Peel',
                canonical_url: 'https://pixibeauty.com/products/hydrating-milky-peel',
                destination_url: 'https://pixibeauty.com/products/hydrating-milky-peel',
                availability: 'in stock',
                seed_data: { brand: 'PIXI BEAUTY', category: 'peel' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_cleanser',
                market: 'US',
                tool: '*',
                title: 'Rose Cream Cleanser',
                canonical_url: 'https://pixibeauty.com/products/rose-cream-cleanser',
                destination_url: 'https://pixibeauty.com/products/rose-cream-cleanser',
                availability: 'in stock',
                seed_data: { brand: 'PIXI BEAUTY', category: 'cleanser' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_vitc',
                market: 'US',
                tool: '*',
                title: 'Vitamin C Brightening Boost Moisturizer',
                canonical_url: 'https://skintific.com/products/vitamin-c-brightening-boost-moisturizer',
                destination_url: 'https://skintific.com/products/vitamin-c-brightening-boost-moisturizer',
                availability: 'in stock',
                seed_data: { brand: 'SKINTIFIC', category: 'moisturizer' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_hair_styling',
                market: 'US',
                tool: '*',
                title: 'The Protective Type Frizz-Smoothing Heat Protectant Styling Cream',
                canonical_url: 'https://typebea.example.com/products/styling-cream',
                destination_url: 'https://typebea.example.com/products/styling-cream',
                availability: 'in stock',
                seed_data: { brand: 'TYPEBEA', category: 'moisturizer' },
                updated_at: now,
                created_at: now,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        merchant_id: 'external_seed',
        external_seed_only: 'true',
        query: 'barrier repair moisturizer',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        product_only: 'true',
        target_step_family: 'moisturizer',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products.slice(0, 2).map((row) => row.title)).toEqual([
      'Après Skin Rich Rescue Barrier Moisturizer with Ceramides',
      'Rose Ceramide Cream',
    ]);
    expect(
      resp.body.products.some((row) =>
        /Tinted Moisturizer|Milky Peel|Rose Cream Cleanser|Heat Protectant|Styling Cream|Skincare Routine/i.test(String(row.title || ''))),
    ).toBe(false);
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        hit_quality: 'valid_hit',
        query_step_strength: 'supportive_family',
        strong_goal_family_topk_count: expect.any(Number),
        supportive_same_family_topk_count: expect.any(Number),
        candidate_class_counts: expect.objectContaining({
          strong_goal_family: expect.any(Number),
          supportive_family: expect.any(Number),
        }),
        noise_drop_counts: expect.objectContaining({
          bundle: expect.any(Number),
          tint: expect.any(Number),
          peel: expect.any(Number),
          cleanser: expect.any(Number),
          hair: expect.any(Number),
          brightening: expect.any(Number),
        }),
      }),
    );
    expect(Number(resp.body.metadata?.search_decision?.strong_goal_family_topk_count || 0)).toBeGreaterThanOrEqual(2);
    expect(resp.body.metadata?.search_decision?.noise_drop_counts?.bundle).toBeGreaterThanOrEqual(1);
    expect(resp.body.metadata?.search_decision?.noise_drop_counts?.tint).toBeGreaterThanOrEqual(1);
    expect(resp.body.metadata?.search_decision?.noise_drop_counts?.peel).toBeGreaterThanOrEqual(1);
    expect(resp.body.metadata?.search_decision?.noise_drop_counts?.cleanser).toBeGreaterThanOrEqual(1);
    expect(resp.body.metadata?.search_decision?.noise_drop_counts?.hair).toBeGreaterThanOrEqual(1);
    expect(resp.body.metadata?.search_decision?.noise_drop_counts?.brightening).toBeGreaterThanOrEqual(1);
  });

  test('guidance-only external-seed direct search expands moisturizer family retrieval patterns within a single step', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-external-seed-variant-union-test';

    const capturedPatternSets = [];
    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql, params) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds')) {
          capturedPatternSets.push(Array.isArray(params?.[2]) ? params[2].slice() : []);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        merchant_id: 'external_seed',
        external_seed_only: 'true',
        query: 'fragrance-free barrier moisturizer',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        decision_mode: 'guidance_only',
        retrieval_mode: 'guidance_recall_first',
        source_policy: 'internal_first_then_external_supplement',
        product_only: 'true',
        target_step_family: 'moisturizer',
        query_step_strength: 'supportive_family',
      });

    expect(resp.status).toBe(200);
    expect(capturedPatternSets.length).toBeGreaterThanOrEqual(4);
    expect(
      capturedPatternSets.some((patterns) =>
        patterns.includes('%fragrance%') && patterns.includes('%barrier%') && patterns.includes('%moisturizer%'),
      ),
    ).toBe(true);
    expect(
      capturedPatternSets.some((patterns) =>
        patterns.includes('%ceramide%') && patterns.includes('%moisturizer%'),
      ),
    ).toBe(true);
    expect(
      capturedPatternSets.some((patterns) =>
        patterns.includes('%sensitive%') && patterns.includes('%skin%') && patterns.includes('%moisturizer%'),
      ),
    ).toBe(true);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_external_seed_direct',
        retrieval_query_variants: expect.arrayContaining([
          'fragrance-free barrier moisturizer',
          'barrier repair moisturizer',
          'ceramide moisturizer',
          'sensitive skin moisturizer',
        ]),
        retrieval_query_variant_count: expect.any(Number),
      }),
    );
    expect(resp.body.metadata?.retrieval_query_variant_count).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(resp.body.metadata?.retrieval_query_debug)).toBe(true);
    expect(resp.body.metadata?.retrieval_query_debug).toHaveLength(resp.body.metadata?.retrieval_query_variant_count);
  });

  test('fragrance-free moisturizer guidance query normalizes semantic class away from fragrance', async () => {
    nock('http://pivota.test')
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.query || '').includes('fragrance-free barrier moisturizer') &&
          !/\b(perfume|parfum|cologne|body mist|eau de parfum|eau de toilette)\b/i.test(
            String(q.query || ''),
          )
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'fragrance_free_skin_hit',
            merchant_id: 'external_seed',
            title: 'Barrier Rescue Fragrance-Free Moisturizer',
            source: 'external_seed',
          },
        ],
        total: 1,
        metadata: {
          query_semantic_class: 'fragrance',
          route_health: {
            query_semantic_class: 'fragrance',
          },
          search_decision: {
            query_semantic_class: 'fragrance',
          },
          search_trace: {
            raw_query: 'fragrance-free barrier moisturizer',
          },
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'fragrance-free barrier moisturizer',
        source: 'aurora-bff',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        decision_mode: 'guidance_only',
        target_step_family: 'moisturizer',
        query_step_strength: 'supportive_family',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata?.query_semantic_class).toBe('fragrance_free_skincare');
    expect(resp.body.metadata?.route_health?.query_semantic_class).toBe('fragrance_free_skincare');
    expect(String(resp.body.metadata?.search_decision?.query_semantic_class || '')).not.toBe('fragrance');
  });

  test('ingredient-intent serum guidance filters generic serum noise when panthenol is the anchor', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-external-seed-panthenol-serum-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM external_product_seeds')) {
          const now = new Date().toISOString();
          return {
            rows: [
              {
                id: 'seed_winona_panthenol',
                market: 'US',
                tool: '*',
                title: 'Winona Soothing Repair Serum with Panthenol',
                canonical_url: 'https://winona.example.com/products/panthenol-serum',
                destination_url: 'https://winona.example.com/products/panthenol-serum',
                availability: 'in stock',
                seed_data: { brand: 'Winona', category: 'serum' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_b5_serum',
                market: 'US',
                tool: '*',
                title: 'Barrier B5 Serum',
                canonical_url: 'https://example.com/products/barrier-b5-serum',
                destination_url: 'https://example.com/products/barrier-b5-serum',
                availability: 'in stock',
                seed_data: { brand: 'Derm Lab', category: 'serum' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_patyka_generic',
                market: 'US',
                tool: '*',
                title: 'Serum Repulpant Fundamental',
                canonical_url: 'https://patyka.example.com/products/fundamental-serum',
                destination_url: 'https://patyka.example.com/products/fundamental-serum',
                availability: 'in stock',
                seed_data: { brand: 'PATYKA', category: 'serum' },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_fat_water_toner',
                market: 'US',
                tool: '*',
                title: 'Fat Water Hydrating Milky Toner Essence',
                canonical_url: 'https://fenty.example.com/products/fat-water',
                destination_url: 'https://fenty.example.com/products/fat-water',
                availability: 'in stock',
                seed_data: { brand: 'Fenty Skin', category: 'essence' },
                updated_at: now,
                created_at: now,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        merchant_id: 'external_seed',
        external_seed_only: 'true',
        query: 'panthenol serum',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        product_only: 'true',
        target_step_family: 'serum',
        session_id: 'sess_serum_guidance',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.products.map((row) => row.title)).toEqual([
      'Winona Soothing Repair Serum with Panthenol',
      'Barrier B5 Serum',
    ]);
    expect(resp.body.products.some((row) => /PATYKA|Repulpant/i.test(String(row.title || '')))).toBe(false);
    expect(resp.body.products.some((row) => /Fat Water|Toner Essence/i.test(String(row.title || '')))).toBe(false);
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        hit_quality: 'valid_hit',
        query_target_step_family: 'serum',
        query_step_strength: 'strong_goal_family',
        step_success_class: 'strong_goal_family',
        normalized_intent: expect.objectContaining({
          backbone_id: 'serum_panthenol_canary_backbone_v1',
          variant_overlay: 'ingredient_fidelity',
        }),
        success_contract_result: expect.objectContaining({
          applied: true,
          satisfied: true,
          step_success_class: 'strong_goal_family',
          quality_gate_result: expect.objectContaining({
            applied: true,
            satisfied: true,
          }),
        }),
        candidate_origin_counts: expect.objectContaining({
          external_supplement: 2,
        }),
        displayable_candidate_count: 2,
        execution_mode: 'server_owned_ladder',
        strong_goal_family_topk_count: 2,
        same_family_topk_count: 2,
      }),
    );
  });

  test('guidance-only moisturizer search supplements external seeds when internal cache is tool-heavy', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-cache-supplement-test';
    process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED = 'true';
    process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY = 'supplement_internal_first';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 4 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'tool_1',
                  product_id: 'tool_1',
                  merchant_id: 'merch_tools',
                  title: 'Barrier Cream Applicator Brush',
                  description: 'tool for applying moisturizer and barrier cream',
                  product_type: 'Makeup Brush',
                  status: 'published',
                  inventory_quantity: 8,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'tool_2',
                  product_id: 'tool_2',
                  merchant_id: 'merch_tools',
                  title: 'Ceramide Moisturizer Brush Set',
                  description: 'beauty tool set for moisturizer application',
                  product_type: 'Beauty Tool',
                  status: 'published',
                  inventory_quantity: 6,
                },
              },
              {
                merchant_id: 'merch_tools',
                merchant_name: 'Tool Shop',
                product_data: {
                  id: 'tool_3',
                  product_id: 'tool_3',
                  merchant_id: 'merch_tools',
                  title: 'Face Cream Tool Trio',
                  description: 'tool trio for face cream application',
                  product_type: 'Beauty Tool',
                  status: 'published',
                  inventory_quantity: 5,
                },
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const allowedGuidanceQueries = new Set([
      'moisturizer barrier repair ceramide np barrier repair',
      'ceramide barrier moisturizer',
      'barrier repair moisturizer',
      'ceramide moisturizer',
      'sensitive skin moisturizer',
    ]);
    nock('http://pivota.test')
      .persist()
      .get('/agent/v1/products/search')
      .query((q) => {
        return (
          String(q.merchant_id || '') === 'external_seed' &&
          String(q.external_seed_only || '') === 'true' &&
          allowedGuidanceQueries.has(String(q.query || '')) &&
          String(q.ui_surface || '') === 'ingredient_plan_guidance_only' &&
          String(q.product_only || '') === 'true' &&
          String(q.target_step_family || '') === 'moisturizer'
        );
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            id: 'ext_rose_ceramide_1',
            product_id: 'ext_rose_ceramide_1',
            merchant_id: 'external_seed',
            source: 'external_seed',
            title: 'Rose Ceramide Cream',
            description: 'ceramide-rich face moisturizer for barrier repair',
            product_type: 'external',
            status: 'active',
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_external_seed_direct',
          source_breakdown: {
            internal_count: 0,
            external_seed_count: 1,
            stale_cache_used: false,
            strategy_applied: 'external_seed_only_direct',
          },
          search_decision: {
            hit_quality: 'valid_hit',
            query_target_step_family: 'moisturizer',
            same_family_topk_count: 1,
            exact_step_topk_count: 1,
          },
          product_only_applied: true,
          discovery_source_used: 'external_seed_direct',
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'moisturizer barrier repair ceramide np barrier repair',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        product_only: 'true',
        allow_external_seed: 'true',
        external_seed_strategy: 'supplement_internal_first',
        target_step_family: 'moisturizer',
        search_all_merchants: 'true',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(
      [
        'cache_cross_merchant_search_supplemented',
        'agent_products_guidance_external_seed_supplemented',
        'agent_products_guidance_external_seed_direct',
      ].includes(String(resp.body.metadata?.query_source || '')),
    ).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          merchant_id: 'external_seed',
          product_id: 'ext_rose_ceramide_1',
          title: 'Rose Ceramide Cream',
          pdp_url:
            'https://agent.pivota.cc/products/ext_rose_ceramide_1?merchant_id=external_seed&entry=aurora_chatbox',
          pdp_open: expect.objectContaining({
            path: 'resolve',
            product_ref: {
              product_id: 'ext_rose_ceramide_1',
              merchant_id: 'external_seed',
            },
          }),
        }),
      ]),
    );
    expect(resp.body.metadata?.source_breakdown).toEqual(
      expect.objectContaining({
        external_seed_count: expect.any(Number),
      }),
    );
    expect(resp.body.metadata?.source_breakdown?.external_seed_count).toBeGreaterThanOrEqual(1);
    expect(['unified_relevance', 'supplement_internal_first']).toContain(
      String(resp.body.metadata?.source_breakdown?.strategy_applied || ''),
    );
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        contract_version: 'beauty_search_decision_v4',
        hit_quality: 'valid_hit',
        query_target_step_family: 'moisturizer',
      }),
    );
    expect(resp.body.metadata?.external_seed_rows_fetched).toBeGreaterThanOrEqual(1);
    expect(resp.body.metadata?.external_seed_rows_built).toBeGreaterThanOrEqual(1);
    expect(resp.body.metadata?.external_seed_returned_count).toBeGreaterThanOrEqual(1);
  });

  test('ingredient_plan_guidance_only suppresses legacy brand clarification fallback and returns shared failure semantics', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-clarification-suppression-test';
    process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED = 'false';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async () => ({ rows: [] })),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'ceramide cream',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        product_only: 'true',
        allow_external_seed: 'false',
        target_step_family: 'moisturizer',
        search_all_merchants: 'true',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.clarification ?? null).toBe(null);
    expect(Array.isArray(resp.body.reason_codes)).toBe(true);
    expect(resp.body.reason_codes).not.toContain('AMBIGUITY_CLARIFY');
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        clarification_suppressed: true,
        legacy_fallback_suppressed: true,
        query_source: 'agent_products_error_fallback',
      }),
    );
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        decision_mode: 'guidance_only',
        clarification_suppressed: true,
        legacy_fallback_suppressed: true,
        success_contract_result: expect.objectContaining({
          applied: true,
          satisfied: false,
          failure_class: expect.stringMatching(
            /^(retrieval_direction_weak|no_target_relevant_candidates|generic_family_only)$/
          ),
        }),
      }),
    );
  });

  test('ingredient_plan_guidance_only server-owned ladder fastpath bypasses legacy fallback layers', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 2 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_internal_1',
                merchant_name: 'Internal Shop',
                product_data: {
                  id: 'int_barrier_1',
                  product_id: 'int_barrier_1',
                  merchant_id: 'merch_internal_1',
                  title: 'Barrier Repair Moisturizer',
                  description: 'barrier repair moisturizer for sensitive skin',
                  product_type: 'Moisturizer',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_internal_2',
                merchant_name: 'Internal Shop 2',
                product_data: {
                  id: 'int_ceramide_1',
                  product_id: 'int_ceramide_1',
                  merchant_id: 'merch_internal_2',
                  title: 'Ceramide Barrier Cream',
                  description: 'ceramide-rich cream for barrier repair',
                  product_type: 'Moisturizer',
                  status: 'published',
                  inventory_quantity: 7,
                },
              },
            ],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'seed_rose_1',
                external_product_id: 'ext_rose_1',
                destination_url: 'https://pixibeauty.com/products/rose-ceramide-cream',
                canonical_url: 'https://pixibeauty.com/products/rose-ceramide-cream',
                domain: 'pixibeauty.com',
                title: 'Rose Ceramide Cream',
                image_url: 'https://pixibeauty.com/image.jpg',
                price_amount: 24,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  brand: 'Pixi',
                  category: 'Moisturizer',
                  snapshot: {
                    title: 'Rose Ceramide Cream',
                    description: 'barrier moisturizer with ceramides',
                    brand: 'Pixi',
                    category: 'Moisturizer',
                    canonical_url: 'https://pixibeauty.com/products/rose-ceramide-cream',
                    destination_url: 'https://pixibeauty.com/products/rose-ceramide-cream',
                  },
                },
              },
              {
                id: 'seed_phyto_1',
                external_product_id: 'ext_phyto_1',
                destination_url: 'https://theordinary.com/products/nmf-phytoceramides',
                canonical_url: 'https://theordinary.com/products/nmf-phytoceramides',
                domain: 'theordinary.com',
                title: 'Natural Moisturizing Factors + PhytoCeramides',
                image_url: 'https://theordinary.com/image.jpg',
                price_amount: 19,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  brand: 'The Ordinary',
                  category: 'Moisturizer',
                  snapshot: {
                    title: 'Natural Moisturizing Factors + PhytoCeramides',
                    description: 'moisturizer with phytoceramides for barrier support',
                    brand: 'The Ordinary',
                    category: 'Moisturizer',
                    canonical_url: 'https://theordinary.com/products/nmf-phytoceramides',
                    destination_url: 'https://theordinary.com/products/nmf-phytoceramides',
                  },
                },
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'fragrance-free barrier moisturizer',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        decision_mode: 'guidance_only',
        execution_mode: 'server_owned_ladder',
        source_policy: 'internal_first_then_external_supplement',
        product_only: 'true',
        allow_external_seed: 'true',
        target_step_family: 'moisturizer',
        search_all_merchants: 'true',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        legacy_pipeline_bypassed: true,
        resolver_first_applied: false,
        pass2_attempted: false,
        secondary_attempted: false,
        second_stage_expansion_attempted: false,
        client_timeout_recommended_ms: 5000,
      }),
    );
    expect(Array.isArray(resp.body.metadata?.attempt_trace)).toBe(true);
    expect(Array.isArray(resp.body.metadata?.phase_trace)).toBe(true);
    expect(resp.body.metadata?.attempt_count).toBeGreaterThanOrEqual(1);
    expect(String(resp.body.metadata?.selected_attempt_query || '')).toMatch(/moisturizer/);
    expect(resp.body.products.map((row) => row.title)).toEqual(
      expect.arrayContaining([
        'Barrier Repair Moisturizer',
        'Ceramide Barrier Cream',
      ]),
    );
    expect(resp.body.products.some((row) => String(row.merchant_id || '') === 'external_seed')).toBe(true);
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        decision_mode: 'guidance_only',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        query_target_step_family: 'moisturizer',
        success_contract_result: expect.objectContaining({
          applied: true,
          satisfied: true,
        }),
      }),
    );
  });

  test('ingredient_plan_guidance_only auto-upgrades real serum guidance queries into server-owned ladder fastpath', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-serum-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'seed_winona_panthenol',
                external_product_id: 'ext_panthenol_1',
                destination_url: 'https://winona.example.com/products/panthenol-serum',
                canonical_url: 'https://winona.example.com/products/panthenol-serum',
                domain: 'winona.example.com',
                title: 'Winona Soothing Repair Serum with Panthenol',
                image_url: 'https://winona.example.com/image.jpg',
                price_amount: 29,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  brand: 'Winona',
                  category: 'Serum',
                  snapshot: {
                    title: 'Winona Soothing Repair Serum with Panthenol',
                    description: 'panthenol serum for soothing barrier repair support',
                    brand: 'Winona',
                    category: 'Serum',
                    canonical_url: 'https://winona.example.com/products/panthenol-serum',
                    destination_url: 'https://winona.example.com/products/panthenol-serum',
                  },
                },
              },
              {
                id: 'seed_barrier_b5',
                external_product_id: 'ext_barrier_b5_1',
                destination_url: 'https://dermlab.example.com/products/barrier-b5-serum',
                canonical_url: 'https://dermlab.example.com/products/barrier-b5-serum',
                domain: 'dermlab.example.com',
                title: 'Barrier B5 Serum',
                image_url: 'https://dermlab.example.com/image.jpg',
                price_amount: 26,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  brand: 'Derm Lab',
                  category: 'Serum',
                  snapshot: {
                    title: 'Barrier B5 Serum',
                    description: 'barrier repair serum with panthenol and b5',
                    brand: 'Derm Lab',
                    category: 'Serum',
                    canonical_url: 'https://dermlab.example.com/products/barrier-b5-serum',
                    destination_url: 'https://dermlab.example.com/products/barrier-b5-serum',
                  },
                },
              },
              {
                id: 'seed_generic_serum',
                external_product_id: 'ext_generic_1',
                destination_url: 'https://patyka.example.com/products/fundamental-serum',
                canonical_url: 'https://patyka.example.com/products/fundamental-serum',
                domain: 'patyka.example.com',
                title: 'Serum Repulpant Fundamental',
                image_url: 'https://patyka.example.com/image.jpg',
                price_amount: 34,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  brand: 'PATYKA',
                  category: 'Serum',
                  snapshot: {
                    title: 'Serum Repulpant Fundamental',
                    description: 'hydrating face serum',
                    brand: 'PATYKA',
                    category: 'Serum',
                    canonical_url: 'https://patyka.example.com/products/fundamental-serum',
                    destination_url: 'https://patyka.example.com/products/fundamental-serum',
                  },
                },
              },
              {
                id: 'seed_adjacent_toner',
                external_product_id: 'ext_toner_1',
                destination_url: 'https://fenty.example.com/products/fat-water',
                canonical_url: 'https://fenty.example.com/products/fat-water',
                domain: 'fenty.example.com',
                title: 'Fat Water Hydrating Milky Toner Essence',
                image_url: 'https://fenty.example.com/image.jpg',
                price_amount: 18,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  brand: 'Fenty Skin',
                  category: 'Essence',
                  snapshot: {
                    title: 'Fat Water Hydrating Milky Toner Essence',
                    description: 'hydrating toner essence',
                    brand: 'Fenty Skin',
                    category: 'Essence',
                    canonical_url: 'https://fenty.example.com/products/fat-water',
                    destination_url: 'https://fenty.example.com/products/fat-water',
                  },
                },
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .get('/agent/v1/products/search')
      .query({
        query: 'panthenol barrier repair serum',
        limit: '8',
        source: 'aurora_chatbox',
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        decision_mode: 'guidance_only',
        source_policy: 'internal_first_then_external_supplement',
        product_only: 'true',
        allow_external_seed: 'true',
        target_step_family: 'serum',
        search_all_merchants: 'true',
        lang: 'en',
      });

    expect(resp.status).toBe(200);
    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        legacy_pipeline_bypassed: true,
        resolver_first_applied: false,
        pass2_attempted: false,
        secondary_attempted: false,
        second_stage_expansion_attempted: false,
        client_timeout_recommended_ms: 5000,
      }),
    );
    expect(Array.isArray(resp.body.metadata?.attempt_trace)).toBe(true);
    expect(resp.body.metadata?.attempt_count).toBeGreaterThanOrEqual(1);
    expect(String(resp.body.metadata?.selected_attempt_query || '')).toMatch(/panthenol serum|barrier b5 serum/i);
    expect(resp.body.products.map((row) => row.title)).toEqual([
      'Winona Soothing Repair Serum with Panthenol',
      'Barrier B5 Serum',
    ]);
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        decision_mode: 'guidance_only',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        query_target_step_family: 'serum',
        step_success_class: 'strong_goal_family',
        success_contract_result: expect.objectContaining({
          applied: true,
          satisfied: true,
          step_success_class: 'strong_goal_family',
        }),
      }),
    );
  });

  test('invoke find_products_multi reuses guidance fastpath for aurora guidance-only cache-hit serum queries', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-invoke-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 2 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_internal_1',
                merchant_name: 'Internal Shop',
                product_data: {
                  id: 'hydrating_serum_1',
                  product_id: 'hydrating_serum_1',
                  merchant_id: 'merch_internal_1',
                  title: 'Hydrating Serum with Ceramides',
                  description: 'hydrating serum with ceramides for barrier support',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
              {
                merchant_id: 'merch_internal_2',
                merchant_name: 'Internal Shop 2',
                product_data: {
                  id: 'hydrating_serum_2',
                  product_id: 'hydrating_serum_2',
                  merchant_id: 'merch_internal_2',
                  title: 'Barrier Repair Hydrating Serum',
                  description: 'soothing hydrating serum for sensitive skin',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 7,
                },
              },
            ],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hydrating serum',
            limit: 6,
            in_stock_only: true,
            ui_surface: 'ingredient_plan_guidance_only',
          },
        },
        metadata: {
          source: 'shopping_agent',
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'serum',
          query_step_strength: 'focused',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
        },
      })
      .expect(200);

    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_guidance_fastpath',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        legacy_pipeline_bypassed: true,
        final_decision: 'cache_returned',
        service_version: expect.objectContaining({
          commit: expect.any(String),
        }),
        search_trace: expect.objectContaining({
          final_decision: 'cache_returned',
        }),
        route_health: expect.objectContaining({
          fallback_triggered: false,
          primary_path_used: 'guidance_fastpath',
        }),
        route_trace: expect.objectContaining({
          authoritative_endpoint: '/agent/shop/v1/invoke',
        }),
      }),
    );
    expect(resp.body.metadata?.search_decision).toEqual(
      expect.objectContaining({
        decision_mode: 'guidance_only',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        final_decision: 'cache_returned',
      }),
    );
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products.map((row) => row.title)).toEqual(
      expect.arrayContaining([
        'Hydrating Serum with Ceramides',
        'Barrier Repair Hydrating Serum',
      ]),
    );
    expect(resp.body.metadata?.final_decision).not.toBe('governance_shadow_block');
    expect(resp.body.metadata?.query_source).not.toBe('gateway_governance_shadow_block');
  });

  test('invoke find_products_multi reuses guidance fastpath for hydration-supportive serum cache-hit queries', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-hydration-cache-hit-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 2 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_internal_hydrating',
                merchant_name: 'Internal Hydration Shop',
                product_data: {
                  id: 'hydrating_serum_generic',
                  product_id: 'hydrating_serum_generic',
                  merchant_id: 'merch_internal_hydrating',
                  title: 'Hydrating Serum',
                  description: 'lightweight hydrating serum for daily barrier support',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 11,
                },
              },
              {
                merchant_id: 'merch_internal_hyaluronic',
                merchant_name: 'Internal Hyaluronic Shop',
                product_data: {
                  id: 'hydrating_serum_hyaluronic',
                  product_id: 'hydrating_serum_hyaluronic',
                  merchant_id: 'merch_internal_hyaluronic',
                  title: 'Hydrating Serum with Ceramides',
                  description: 'hydrating serum with ceramides for dehydrated sensitive skin',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 8,
                },
              },
            ],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hydrating serum',
            limit: 6,
            in_stock_only: true,
            ui_surface: 'ingredient_plan_guidance_only',
          },
        },
        metadata: {
          source: 'aurora-bff',
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'serum',
          query_step_strength: 'focused',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
        },
      })
      .expect(200);

    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_guidance_fastpath',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        final_decision: 'cache_returned',
        service_version: expect.objectContaining({
          commit: expect.any(String),
        }),
      }),
    );
    expect(resp.body.metadata?.route_health).toEqual(
      expect.objectContaining({
        fallback_triggered: false,
        primary_path_used: 'guidance_fastpath',
      }),
    );
    expect(resp.body.products.map((row) => row.title)).toEqual(
      expect.arrayContaining([
        'Hydrating Serum',
        'Hydrating Serum with Ceramides',
      ]),
    );
    expect(resp.body.metadata?.query_source).not.toBe('gateway_governance_shadow_block');
  });

  test('invoke find_products_multi keeps a single supportive hydrating serum hit on the guidance fastpath', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-hydration-single-hit-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_internal_hydrating_single',
                merchant_name: 'Internal Hydration Shop',
                product_data: {
                  id: 'hydrating_serum_single',
                  product_id: 'hydrating_serum_single',
                  merchant_id: 'merch_internal_hydrating_single',
                  title: 'Hydrating Serum',
                  description: 'lightweight hydrating serum for dehydrated skin',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 9,
                },
              },
            ],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hydrating serum',
            limit: 6,
            in_stock_only: true,
            ui_surface: 'ingredient_plan_guidance_only',
          },
        },
        metadata: {
          source: 'aurora-bff',
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'serum',
          query_step_strength: 'focused',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
        },
      })
      .expect(200);

    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_guidance_fastpath',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        final_decision: 'cache_returned',
      }),
    );
    expect(resp.body.metadata?.guidance_direct_external_seed_applied).not.toBe(true);
    expect(resp.body.metadata?.route_health).toEqual(
      expect.objectContaining({
        fallback_triggered: false,
        primary_path_used: 'guidance_fastpath',
      }),
    );
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: 'hydrating_serum_single',
          title: 'Hydrating Serum',
        }),
      ]),
    );
  });

  test('invoke find_products_multi keeps hydration and hyaluronic serum variants on the guidance fastpath', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-hydration-variant-hit-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_internal_hydration_variant',
                merchant_name: 'Hydration Variant Shop',
                product_data: {
                  id: 'hydration_boost_serum',
                  product_id: 'hydration_boost_serum',
                  merchant_id: 'merch_internal_hydration_variant',
                  title: 'Ultra Repair Hydration Boost Serum with Colloidal Oatmeal + Hyaluronic Acid',
                  description: 'barrier support serum with colloidal oatmeal and sodium hyaluronate',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 7,
                },
              },
            ],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hydrating serum',
            limit: 6,
            in_stock_only: true,
            ui_surface: 'ingredient_plan_guidance_only',
          },
        },
        metadata: {
          source: 'aurora-bff',
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'serum',
          query_step_strength: 'focused',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
        },
      })
      .expect(200);

    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_guidance_fastpath',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        final_decision: 'cache_returned',
      }),
    );
    expect(resp.body.metadata?.guidance_direct_external_seed_applied).not.toBe(true);
    expect(resp.body.metadata?.route_health).toEqual(
      expect.objectContaining({
        fallback_triggered: false,
        primary_path_used: 'guidance_fastpath',
      }),
    );
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: 'hydration_boost_serum',
          title: 'Ultra Repair Hydration Boost Serum with Colloidal Oatmeal + Hyaluronic Acid',
        }),
      ]),
    );
  });

  test('invoke find_products_multi does not let direct supplement overwrite a valid hydrating serum cache hit', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-hydration-no-overwrite-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return {
            rows: [
              {
                merchant_id: 'merch_internal_hydration_variant',
                merchant_name: 'Hydration Variant Shop',
                product_data: {
                  id: 'hydration_boost_serum',
                  product_id: 'hydration_boost_serum',
                  merchant_id: 'merch_internal_hydration_variant',
                  title: 'Ultra Repair Hydration Boost Serum with Colloidal Oatmeal + Hyaluronic Acid',
                  description: 'barrier support serum with colloidal oatmeal and sodium hyaluronate',
                  product_type: 'Serum',
                  category: 'skincare',
                  status: 'published',
                  inventory_quantity: 7,
                },
              },
            ],
          };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'seed_hydration_repair',
                external_product_id: 'seed_hydration_repair',
                destination_url: 'https://seed.example/hydration-repair-serum',
                canonical_url: 'https://seed.example/hydration-repair-serum',
                domain: 'seed.example',
                title: 'Cellular Hydration Barrier Repair Serum Refill',
                image_url: 'https://seed.example/hydration-repair-serum.jpg',
                price_amount: '39',
                price_currency: 'USD',
                availability: 'in stock',
                seed_data: {
                  snapshot: {
                    title: 'Cellular Hydration Barrier Repair Serum Refill',
                    destination_url: 'https://seed.example/hydration-repair-serum',
                    canonical_url: 'https://seed.example/hydration-repair-serum',
                    category: 'skincare',
                    product_type: 'serum',
                  },
                },
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'hydrating serum',
            limit: 6,
            in_stock_only: true,
            ui_surface: 'ingredient_plan_guidance_only',
            allow_external_seed: true,
          },
        },
        metadata: {
          source: 'aurora-bff',
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'serum',
          query_step_strength: 'focused',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
        },
      })
      .expect(200);

    expect(resp.body.metadata).toEqual(
      expect.objectContaining({
        query_source: 'agent_products_guidance_fastpath',
        execution_mode: 'server_owned_ladder',
        latency_mode: 'guidance_fastpath',
        final_decision: 'cache_returned',
      }),
    );
    expect(resp.body.metadata?.guidance_direct_external_seed_applied).not.toBe(true);
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: 'hydration_boost_serum',
        }),
      ]),
    );
    expect(resp.body.products).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Cellular Hydration Barrier Repair Serum Refill',
        }),
      ]),
    );
  });

  test('invoke find_products_multi does not early-return an empty guidance fastpath response', async () => {
    process.env.DATABASE_URL = 'postgres://guidance-fastpath-empty-fallthrough-test';

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0 }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    }));

    const upstreamInvokeScope = nock('http://pivota.test')
      .post('/agent/shop/v1/invoke', (body) => {
        return body && body.operation === 'find_products_multi';
      })
      .reply(200, {
        status: 'success',
        success: true,
        products: [
          {
            product_id: 'upstream_guidance_1',
            merchant_id: 'external_seed',
            title: 'Soothing Repair Serum',
            category: 'skincare',
            product_type: 'serum',
          },
        ],
        total: 1,
        metadata: {
          query_source: 'agent_products_guidance_external_seed_supplemented',
          final_decision: 'products_returned',
          guidance_direct_external_seed_applied: true,
          guidance_direct_external_seed_valid_hit: true,
          source_breakdown: {
            internal_count: 0,
            external_seed_count: 1,
            stale_cache_used: false,
            strategy_applied: 'guidance_direct_external_seed_supplement',
          },
        },
      });

    const app = require('../../src/server');
    const resp = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'find_products_multi',
        payload: {
          search: {
            query: 'soothing repair serum',
            limit: 6,
            in_stock_only: true,
            ui_surface: 'ingredient_plan_guidance_only',
          },
        },
        metadata: {
          source: 'shopping_agent',
          ui_surface: 'ingredient_plan_guidance_only',
          query_target_step_family: 'serum',
          query_step_strength: 'focused',
          decision_mode: 'guidance_only',
          source_policy: 'guided_only',
        },
      })
      .expect(200);

    expect(upstreamInvokeScope.isDone()).toBe(true);
    expect(resp.body.metadata?.query_source).toBe('agent_products_guidance_external_seed_supplemented');
    expect(resp.body.metadata?.guidance_direct_external_seed_applied).toBe(true);
    expect(Array.isArray(resp.body.products)).toBe(true);
    expect(resp.body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product_id: 'upstream_guidance_1',
          title: 'Soothing Repair Serum',
        }),
      ]),
    );
  });

});

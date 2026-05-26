function hasRuntimeDeps() {
  for (const dep of ['dotenv', 'express', 'axios']) {
    try {
      require.resolve(dep);
    } catch {
      return false;
    }
  }
  return true;
}

const describeIfRuntimeDeps = hasRuntimeDeps() ? describe : describe.skip;

describeIfRuntimeDeps('PDP similar first-paint budget', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('returns a deferred similar envelope when the recommendation promise exceeds budget', async () => {
    jest.resetModules();
    const app = require('../../src/server');
    const startedAt = Date.now();

    const envelope = await app._debug.resolvePdpSimilarWithBudget(
      new Promise(() => {}),
      20,
    );

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(envelope).toEqual(
      expect.objectContaining({
        status: 'deferred',
        strategy: 'related_products',
        reason_code: 'SIMILAR_DEFERRED_FIRST_PAINT',
        items: [],
        metadata: expect.objectContaining({
          similar_status: 'deferred',
          reason_code: 'SIMILAR_DEFERRED_FIRST_PAINT',
          sync_budget_ms: 20,
        }),
      }),
    );
  });

  test('marks post-core similar timeouts separately from first-paint timeouts', async () => {
    jest.resetModules();
    const app = require('../../src/server');

    const envelope = await app._debug.resolvePdpSimilarWithBudget(
      new Promise(() => {}),
      20,
      {
        requestMode: 'background',
        reasonCode: 'SIMILAR_DEFERRED_BACKGROUND_LOAD',
      },
    );

    expect(envelope).toEqual(
      expect.objectContaining({
        status: 'deferred',
        reason_code: 'SIMILAR_DEFERRED_BACKGROUND_LOAD',
        metadata: expect.objectContaining({
          request_mode: 'background',
          reason_code: 'SIMILAR_DEFERRED_BACKGROUND_LOAD',
          sync_budget_ms: 20,
        }),
      }),
    );
  });

  test('builds a direct first-paint deferred envelope without consuming sync budget', () => {
    jest.resetModules();
    const app = require('../../src/server');

    const envelope = app._debug.buildPdpSimilarDeferredEnvelope({
      reasonCode: 'SIMILAR_DEFERRED_FIRST_PAINT',
      requestMode: 'first_paint',
      syncBudgetMs: 0,
      timeoutReasonCode: 'SIMILAR_FIRST_PAINT_DIRECT_DEFERRED',
      directDeferred: true,
    });

    expect(envelope).toEqual(
      expect.objectContaining({
        status: 'deferred',
        reason_code: 'SIMILAR_DEFERRED_FIRST_PAINT',
        items: [],
        metadata: expect.objectContaining({
          similar_status: 'deferred',
          request_mode: 'first_paint',
          sync_budget_ms: 0,
          timeout_reason_code: 'SIMILAR_FIRST_PAINT_DIRECT_DEFERRED',
          direct_deferred: true,
        }),
      }),
    );
  });

  test('uses background mode for standalone/post-core similar requests only', () => {
    jest.resetModules();
    const app = require('../../src/server');

    expect(
      app._debug.resolvePdpSimilarRequestMode({
        options: { similar_mode: 'post_core' },
        includeList: ['similar'],
      }),
    ).toBe('background');
    expect(
      app._debug.resolvePdpSimilarRequestMode({
        includeList: ['similar'],
      }),
    ).toBe('background');
    expect(
      app._debug.resolvePdpSimilarRequestMode({
        includeList: ['offers', 'variant_selector', 'product_overview', 'similar'],
      }),
    ).toBe('first_paint');
  });

  test('passes generic PDP cache-bypass flags through to similar recall', () => {
    jest.resetModules();
    const app = require('../../src/server');

    expect(
      app._debug.resolvePdpSimilarCacheBypass({
        options: { cache_bypass: true },
      }),
    ).toBe(true);
    expect(
      app._debug.resolvePdpSimilarCacheBypass({
        options: { bypass_cache: 'true' },
      }),
    ).toBe(true);
    expect(
      app._debug.resolvePdpSimilarCacheBypass({
        options: { similar_cache_bypass: true },
      }),
    ).toBe(true);
  });

  test('keeps catalog-only similar recall scoped to the PDP candidate window', () => {
    jest.resetModules();
    const app = require('../../src/server');

    const { displayLimit, candidateLimit, fetchArgs } = app._debug.buildPdpSimilarFetchArgs({
      payload: {
        similar: { limit: 6 },
      },
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_demo_1',
      },
      canonicalProductForPdp: {
        external_product_id: 'ext_demo_1',
        currency: 'USD',
      },
      requestMode: 'background',
    });

    expect(displayLimit).toBe(6);
    expect(candidateLimit).toBe(18);
    expect(fetchArgs.k).toBe(18);
    expect(fetchArgs.options.catalog_fetch_limit).toBe(18);
    expect(fetchArgs.options.catalog_fetch_overfetch_multiplier).toBe(1);
    expect(fetchArgs.options.identity_dedupe_timeout_ms).toBeLessThanOrEqual(500);
  });
});

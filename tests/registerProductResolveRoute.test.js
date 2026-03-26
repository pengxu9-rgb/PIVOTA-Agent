const {
  registerProductResolveRoute,
  normalizeResolveLang,
  pickResolveOptions,
} = require('../src/registerProductResolveRoute');

function createApp() {
  return {
    post: jest.fn(),
  };
}

function createRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

function getRouteHandler(app, path) {
  const routeCall = app.post.mock.calls.find((call) => call[0] === path);
  if (!routeCall) {
    throw new Error(`Route not found: POST ${path}`);
  }
  return routeCall[routeCall.length - 1];
}

describe('registerProductResolveRoute', () => {
  test('normalizeResolveLang and pickResolveOptions keep legacy aliases compatible', () => {
    expect(normalizeResolveLang('zh-cn')).toBe('cn');
    expect(normalizeResolveLang('')).toBe('en');
    expect(
      pickResolveOptions({
        preferMerchantIds: ['m_1'],
        searchAllMerchants: true,
        allowExternalSeed: false,
        timeoutMs: 1200,
        upstreamRetries: 1,
        stableAliasShortCircuit: true,
      }),
    ).toEqual({
      prefer_merchants: ['m_1'],
      search_all_merchants: true,
      allow_external_seed: false,
      timeout_ms: 1200,
      upstream_retries: 1,
      stable_alias_short_circuit: true,
    });
  });

  test('registers route and rejects missing query', async () => {
    const app = createApp();

    registerProductResolveRoute({
      app,
      logger: { info: jest.fn(), warn: jest.fn() },
      resolveProductRef: jest.fn(),
      parseQueryNumber: jest.fn((value) => Number(value)),
      firstQueryParamValue: jest.fn((value) => value),
      resolveCatalogSyncMerchantIds: jest.fn(),
      upsertMissingCatalogProduct: jest.fn(),
      pivotaApiBase: 'http://pivota.test',
      pivotaApiKey: 'test_key',
      proxySearchAuroraViewDetailsExternalSeedEnabled: true,
      proxySearchAuroraViewDetailsExternalSeedStrategy: 'supplement_internal_first',
      proxySearchAuroraViewDetailsMinTimeoutMs: 1800,
    });

    expect(app.post).toHaveBeenCalledWith(
      '/agent/v1/products/resolve',
      expect.any(Function),
    );

    const res = createRes();
    await getRouteHandler(app, '/agent/v1/products/resolve')(
      {
        body: { lang: 'en' },
        headers: {},
        header: jest.fn(() => ''),
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'MISSING_PARAMETERS',
      message: 'query is required',
    });
  });

  test('aurora caller defaults stable alias, merchant scope, and view-details external seed overrides', async () => {
    const app = createApp();
    const resolveProductRef = jest.fn().mockResolvedValue({
      resolved: false,
      reason: 'no_candidates',
      metadata: {},
    });
    const resolveCatalogSyncMerchantIds = jest.fn().mockResolvedValue({
      merchantIds: ['merch_sync_1'],
    });
    const upsertMissingCatalogProduct = jest.fn().mockResolvedValue(undefined);

    registerProductResolveRoute({
      app,
      logger: { info: jest.fn(), warn: jest.fn() },
      resolveProductRef,
      parseQueryNumber: (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      },
      firstQueryParamValue: (value) => {
        if (Array.isArray(value)) return value[0] ?? '';
        return value;
      },
      resolveCatalogSyncMerchantIds,
      upsertMissingCatalogProduct,
      pivotaApiBase: 'http://pivota.test',
      pivotaApiKey: 'test_key',
      proxySearchAuroraViewDetailsExternalSeedEnabled: true,
      proxySearchAuroraViewDetailsExternalSeedStrategy: 'supplement_internal_first',
      proxySearchAuroraViewDetailsMinTimeoutMs: 1800,
    });

    const res = createRes();
    await getRouteHandler(app, '/agent/v1/products/resolve')(
      {
        body: {
          query: 'rare essence',
          caller: 'aurora_chatbox',
          options: {
            search_all_merchants: true,
            timeout_ms: 1200,
          },
        },
        headers: { origin: '' },
        header(name) {
          if (String(name).toLowerCase() === 'x-aurora-uid') return '';
          return '';
        },
      },
      res,
    );

    expect(resolveCatalogSyncMerchantIds).toHaveBeenCalled();
    expect(resolveProductRef).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'rare essence',
        lang: 'en',
        options: expect.objectContaining({
          stable_alias_short_circuit: true,
          allow_stable_alias_for_uuid: true,
          prefer_merchants: ['merch_sync_1'],
          upstream_retries: 0,
          allow_external_seed: true,
          external_seed_strategy: 'supplement_internal_first',
          timeout_ms: 1800,
          search_all_merchants: true,
        }),
        pivotaApiBase: 'http://pivota.test',
        pivotaApiKey: 'test_key',
      }),
    );
    expect(upsertMissingCatalogProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'rare essence',
        reason: 'no_candidates',
        reason_code: 'no_candidates',
      }),
    );
    expect(res.body.metadata).toEqual(
      expect.objectContaining({
        view_details_external_seed_enabled: true,
        view_details_external_seed_strategy: 'supplement_internal_first',
        view_details_timeout_ms: 1800,
        resolve_reason_code: 'no_candidates',
      }),
    );
  });
});

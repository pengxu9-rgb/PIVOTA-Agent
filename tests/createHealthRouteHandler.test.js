const { createHealthRouteHandler } = require('../src/createHealthRouteHandler');

function createMockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('createHealthRouteHandler', () => {
  test('returns cache-aware health payload when cache stats are enabled', async () => {
    const res = createMockRes();
    const probeCreatorCacheDbStats = jest.fn().mockResolvedValue({
      products_cache_sellable_total: 12,
    });

    const handler = createHealthRouteHandler({
      env: {
        DATABASE_URL: 'postgres://example.test/db',
        HEALTHZ_INCLUDE_CACHE_STATS: 'true',
        HEALTHZ_MIN_SELLABLE_PRODUCTS: '20',
        HEALTHZ_CACHE_STATS_CREATOR_ID: 'creator_1',
        TAXONOMY_ENABLED: 'true',
        TAXONOMY_VIEW_ID: 'GLOBAL_FASHION',
      },
      logger: { warn: jest.fn() },
      getCreatorConfig: () => ({ merchantIds: ['m1', 'm2', 'm1'] }),
      uniqueStrings: (values) => Array.from(new Set(values)),
      probeCreatorCacheDbStats,
      getAuroraRequiredRouteContractsHealth: () => ({ ok: true, missing_routes: [] }),
      auroraRoutesFailClosed: false,
      auroraRoutesReady: true,
      useMock: false,
      port: 8080,
      apiMode: 'REAL',
      useHybrid: false,
      realApiEnabled: true,
      serviceName: 'pivota-agent',
      serviceGitShaShort: 'abc123',
      serviceBuildId: 'build_1',
      serviceStartedAt: '2026-03-22T00:00:00.000Z',
      pivotaApiBase: 'http://localhost:8080',
      pivotaApiKey: 'key_1',
      snapshotResolveProductCandidatesCacheStats: () => ({ hit_rate: 0.5 }),
      snapshotResolveProductGroupCacheStats: () => ({ hit_rate: 0.4 }),
      snapshotProductDetailCacheStats: () => ({ hit_rate: 0.3 }),
      snapshotPdpV2CoreHotCacheStats: () => ({ entries: 2 }),
      getPdpRecsCacheStats: () => ({ entries: 1 }),
      buildCatalogSyncSnapshot: () => ({ ok: true }),
    });

    await handler({}, res);

    expect(probeCreatorCacheDbStats).toHaveBeenCalledWith(['m1', 'm2'], 'unknown', { force: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        api_mode: 'REAL',
        version: expect.objectContaining({
          service: 'pivota-agent',
          commit: 'abc123',
          build_id: 'build_1',
        }),
        catalog_cache: expect.objectContaining({
          creator_id: 'creator_1',
          merchant_ids: ['m1', 'm2'],
          min_sellable_products: 20,
          warning: true,
          stats: expect.objectContaining({
            products_cache_sellable_total: 12,
          }),
        }),
      }),
    );
  });

  test('returns degraded health payload when cache probe fails under fail-closed startup', async () => {
    const res = createMockRes();
    const logger = { warn: jest.fn() };
    const handler = createHealthRouteHandler({
      env: {
        DATABASE_URL: 'postgres://example.test/db',
        HEALTHZ_INCLUDE_CACHE_STATS: 'true',
      },
      logger,
      getCreatorConfig: () => ({ merchantIds: ['m1'] }),
      uniqueStrings: (values) => Array.from(new Set(values)),
      probeCreatorCacheDbStats: jest.fn().mockRejectedValue(new Error('probe_failed')),
      getAuroraRequiredRouteContractsHealth: () => ({ ok: false, missing_routes: ['route_1'] }),
      auroraRoutesFailClosed: true,
      auroraRoutesReady: false,
      auroraRoutesLoadError: 'aurora_load_failed',
      apiMode: 'REAL',
      pivotaApiBase: 'http://localhost:8080',
      snapshotResolveProductCandidatesCacheStats: () => ({}),
      snapshotResolveProductGroupCacheStats: () => ({}),
      snapshotProductDetailCacheStats: () => ({}),
      snapshotPdpV2CoreHotCacheStats: () => ({}),
      getPdpRecsCacheStats: () => ({}),
    });

    await handler({}, res);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'probe_failed' }),
      'healthz cache stats probe failed',
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        aurora_routes_ready: false,
        aurora_routes_fail_closed: true,
        aurora_routes_error: 'aurora_load_failed',
        missing_routes: ['route_1'],
        warning: 'healthz_cache_stats_failed',
      }),
    );
  });
});

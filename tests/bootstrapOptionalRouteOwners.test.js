const {
  buildAuroraDegradedPathMatcher,
  bootstrapOptionalRouteOwners,
  noopMountRoute,
  resolveAuroraRoutesFailClosed,
} = require('../src/bootstrapOptionalRouteOwners');

describe('bootstrapOptionalRouteOwners', () => {
  test('resolveAuroraRoutesFailClosed parses truthy env values', () => {
    expect(resolveAuroraRoutesFailClosed({ AURORA_ROUTES_FAIL_CLOSED: 'true' })).toBe(true);
    expect(resolveAuroraRoutesFailClosed({ AURORA_BFF_FAIL_CLOSED: '1' })).toBe(true);
    expect(resolveAuroraRoutesFailClosed({ AURORA_ROUTES_FAIL_CLOSED: 'false' })).toBe(false);
    expect(resolveAuroraRoutesFailClosed({})).toBe(false);
  });

  test('buildAuroraDegradedPathMatcher matches exact and nested degraded paths', () => {
    const isAuroraDegradedPath = buildAuroraDegradedPathMatcher([
      '/v1/chat',
      '/v1/session/',
    ]);

    expect(isAuroraDegradedPath('/v1/chat')).toBe(true);
    expect(isAuroraDegradedPath('/v1/chat/turn')).toBe(true);
    expect(isAuroraDegradedPath('/v1/session/abc')).toBe(true);
    expect(isAuroraDegradedPath('/v1/product')).toBe(false);
  });

  test('falls back to noop routes and logs when optional route modules fail to load', () => {
    const logger = { error: jest.fn() };

    const result = bootstrapOptionalRouteOwners({
      logger,
      env: { AURORA_ROUTES_FAIL_CLOSED: 'true' },
      requireLookReplicator: () => {
        throw new Error('look failed');
      },
      requireAuroraRoutes: () => {
        throw new Error('aurora failed');
      },
    });

    expect(result.mountLookReplicatorRoutes).toBe(noopMountRoute);
    expect(result.mountAuroraBffRoutes).toBe(noopMountRoute);
    expect(result.auroraRoutesReady).toBe(false);
    expect(result.auroraRoutesFailClosed).toBe(true);
    expect(result.auroraRoutesLoadError).toContain('aurora failed');
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  test('returns aurora internals when route owner exports are present', () => {
    const logger = { error: jest.fn() };
    const mountAuroraBffRoutes = jest.fn();
    const getPdpPrefetchStateSnapshot = jest.fn(() => ({ hot: true }));
    const getRequiredRouteContractsHealth = jest.fn(() => ({ ok: true }));

    const result = bootstrapOptionalRouteOwners({
      logger,
      requireLookReplicator: () => ({ mountLookReplicatorRoutes: jest.fn() }),
      requireAuroraRoutes: () => ({
        mountAuroraBffRoutes,
        __internal: {
          getPdpPrefetchStateSnapshot,
          getRequiredRouteContractsHealth,
        },
      }),
    });

    expect(result.mountAuroraBffRoutes).toBe(mountAuroraBffRoutes);
    expect(result.auroraRoutesReady).toBe(true);
    expect(result.getAuroraPdpPrefetchStateSnapshot).toBe(getPdpPrefetchStateSnapshot);
    expect(result.getAuroraRequiredRouteContractsHealth).toBe(getRequiredRouteContractsHealth);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

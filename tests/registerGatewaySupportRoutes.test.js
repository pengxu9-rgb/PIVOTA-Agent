const { registerGatewaySupportRoutes } = require('../src/registerGatewaySupportRoutes');

function createJsonRes() {
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

describe('registerGatewaySupportRoutes', () => {
  test('registers mounts and support handlers', async () => {
    const app = {
      get: jest.fn(),
      use: jest.fn(),
    };
    const logger = {
      error: jest.fn(),
    };
    const deps = {
      app,
      logger,
      env: {
        DATABASE_URL: 'postgres://test',
        PROMOTIONS_MODE: 'remote',
        PIVOTA_API_BASE: 'http://pivota.test',
        ADMIN_API_KEY: 'admin',
      },
      healthRouteHandler: jest.fn(),
      queryDb: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
      serviceName: 'svc',
      serviceGitShaShort: 'abc123',
      serviceGitSha: 'abc123full',
      serviceBuildId: 'build1',
      serviceGitBranch: 'main',
      serviceDeploymentId: 'dep1',
      serviceStartedAt: '2026-03-22T00:00:00.000Z',
      mountLookReplicatorRoutes: jest.fn(),
      lookReplicatorCommerceClient: { kind: 'commerce-client' },
      mountOutcomeTelemetryRoutes: jest.fn(),
      mountLookReplicatorEventRoutes: jest.fn(),
      mountUiEventRoutes: jest.fn(),
      mountExternalOfferRoutes: jest.fn(),
      mountRecommendationRoutes: jest.fn(),
      mountAuroraBffRoutes: jest.fn(),
      auroraRoutesReady: false,
      auroraRoutesLoadError: 'aurora_unavailable',
      isAuroraDegradedPath: jest.fn((value) => value.startsWith('/aurora')),
      createRequestId: jest.fn(() => 'req_123'),
      mountLayer1CompatibilityRoutes: jest.fn(),
      mountLayer1BundleRoutes: jest.fn(),
      buildCreatorCategoryTree: jest.fn().mockResolvedValue({ categories: [] }),
      getCreatorCategoryProducts: jest.fn().mockResolvedValue({ products: [] }),
      requireAdmin: jest.fn((req, res, next) => next()),
      getAllPromotions: jest.fn().mockResolvedValue([{ id: 'promo_1' }]),
    };

    registerGatewaySupportRoutes(deps);

    expect(deps.mountLookReplicatorRoutes).toHaveBeenCalledWith(app, {
      logger,
      commerceClient: deps.lookReplicatorCommerceClient,
    });
    expect(deps.mountOutcomeTelemetryRoutes).toHaveBeenCalledWith(app, { logger });
    expect(deps.mountAuroraBffRoutes).toHaveBeenCalledWith(app, { logger });
    expect(deps.mountLayer1CompatibilityRoutes).toHaveBeenCalledWith(app, { logger });
    expect(deps.mountLayer1BundleRoutes).toHaveBeenCalledWith(app, { logger });

    const getHandlerByPath = (path, index = 0) =>
      app.get.mock.calls.filter((call) => call[0] === path)[index][1];

    const versionRes = createJsonRes();
    getHandlerByPath('/version')({}, versionRes);
    expect(versionRes.body).toEqual({
      ok: true,
      service: 'svc',
      commit: 'abc123',
      full_sha: 'abc123full',
      build_id: 'build1',
      branch: 'main',
      deployment_id: 'dep1',
      started_at: '2026-03-22T00:00:00.000Z',
    });

    const dbRes = createJsonRes();
    await getHandlerByPath('/healthz/db')({}, dbRes);
    expect(dbRes.body).toEqual({ ok: true, db_ready: true });
    expect(deps.queryDb).toHaveBeenCalledWith('SELECT 1');

    const creatorRes = createJsonRes();
    await getHandlerByPath('/creator/:creatorId/categories')(
      {
        params: { creatorId: 'creator_1' },
        query: { includeCounts: 'false', includeEmpty: 'true', dealsOnly: 'true', locale: 'zh' },
      },
      creatorRes,
    );
    expect(deps.buildCreatorCategoryTree).toHaveBeenCalledWith('creator_1', {
      includeCounts: false,
      includeEmpty: true,
      dealsOnly: true,
      locale: 'zh',
    });
    expect(creatorRes.body).toEqual({ categories: [] });

    const promoConfigRes = createJsonRes();
    getHandlerByPath('/debug/promotions-config')({}, promoConfigRes);
    expect(promoConfigRes.body).toEqual({
      promoMode: 'remote',
      promoBackendBase: 'http://pivota.test',
      useRemotePromo: true,
      promoAdminKeyPresent: true,
    });

    const degradedMiddleware = app.use.mock.calls[0][0];
    const degradedRes = createJsonRes();
    const degradedReq = {
      path: '/aurora/chat',
      query: {},
      get: jest.fn(() => ''),
    };
    const next = jest.fn();
    degradedMiddleware(degradedReq, degradedRes, next);
    expect(next).not.toHaveBeenCalled();
    expect(degradedRes.statusCode).toBe(503);
    expect(degradedRes.body.cards[0].payload.error_code).toBe('AURORA_ROUTES_UNAVAILABLE');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'req_123',
        trace_id: 'req_123',
        path: '/aurora/chat',
        aurora_routes_error: 'aurora_unavailable',
      }),
      'aurora_routes_degraded',
    );
  });
});

const {
  bootstrapGatewaySupportSurface,
} = require('../src/bootstrapGatewaySupportSurface');

describe('bootstrapGatewaySupportSurface', () => {
  test('wires health and support/admin route owners through one bootstrap call', () => {
    const app = { get: jest.fn(), post: jest.fn(), use: jest.fn() };
    const healthRouteHandler = jest.fn();
    const registerGatewayBaseMiddleware = jest.fn();
    const createHealthRouteHandler = jest.fn(() => healthRouteHandler);
    const registerGatewaySupportRoutes = jest.fn();
    const registerMerchantOpsRoutes = jest.fn();
    const registerProductResolveRoute = jest.fn();
    const registerAdminCatalogOpsRoutes = jest.fn();
    const registerAdminDiagnosticsRoutes = jest.fn();

    const result = bootstrapGatewaySupportSurface({
      registerGatewayBaseMiddleware,
      createHealthRouteHandler,
      registerGatewaySupportRoutes,
      registerMerchantOpsRoutes,
      registerProductResolveRoute,
      registerAdminCatalogOpsRoutes,
      registerAdminDiagnosticsRoutes,
      app,
      expressModule: { json: jest.fn() },
      publicDir: '/tmp/public',
      env: { NODE_ENV: 'test' },
      logger: { info: jest.fn() },
      serviceName: 'svc',
      serviceGitShaShort: 'sha_short',
      serviceBuildId: 'build_1',
      serviceGitBranch: 'main',
      serviceDeploymentId: 'dep_1',
      health: {
        port: 8080,
        apiMode: 'REAL',
      },
      supportRoutes: {
        queryDb: jest.fn(),
      },
      merchantOps: {
        requireAdmin: jest.fn(),
      },
      productResolve: {
        resolveProductRef: jest.fn(),
      },
      adminCatalogOps: {
        requireAdmin: jest.fn(),
      },
      adminDiagnostics: {
        requireAdmin: jest.fn(),
      },
    });

    expect(registerGatewayBaseMiddleware).toHaveBeenCalledWith({
      app,
      expressModule: { json: expect.any(Function) },
      publicDir: '/tmp/public',
      env: { NODE_ENV: 'test' },
      logger: { info: expect.any(Function) },
      serviceGitShaShort: 'sha_short',
      serviceBuildId: 'build_1',
      serviceGitBranch: 'main',
      serviceDeploymentId: 'dep_1',
      serviceName: 'svc',
    });

    expect(createHealthRouteHandler).toHaveBeenCalledWith({
      env: { NODE_ENV: 'test' },
      logger: { info: expect.any(Function) },
      serviceName: 'svc',
      serviceGitShaShort: 'sha_short',
      serviceBuildId: 'build_1',
      serviceGitBranch: 'main',
      serviceDeploymentId: 'dep_1',
      port: 8080,
      apiMode: 'REAL',
    });

    expect(registerGatewaySupportRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        env: { NODE_ENV: 'test' },
        healthRouteHandler,
        serviceName: 'svc',
        queryDb: expect.any(Function),
      }),
    );
    expect(registerMerchantOpsRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        logger: { info: expect.any(Function) },
        requireAdmin: expect.any(Function),
      }),
    );
    expect(registerProductResolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        logger: { info: expect.any(Function) },
        resolveProductRef: expect.any(Function),
      }),
    );
    expect(registerAdminCatalogOpsRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        requireAdmin: expect.any(Function),
      }),
    );
    expect(registerAdminDiagnosticsRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        requireAdmin: expect.any(Function),
      }),
    );

    expect(result).toEqual({ healthRouteHandler });
  });
});

const {
  registerGatewayBaseMiddleware: registerGatewayBaseMiddlewareDefault,
} = require('./registerGatewayBaseMiddleware');
const {
  createHealthRouteHandler: createHealthRouteHandlerDefault,
} = require('./createHealthRouteHandler');
const {
  registerGatewaySupportRoutes: registerGatewaySupportRoutesDefault,
} = require('./registerGatewaySupportRoutes');
const {
  registerMerchantOpsRoutes: registerMerchantOpsRoutesDefault,
} = require('./registerMerchantOpsRoutes');
const {
  registerProductResolveRoute: registerProductResolveRouteDefault,
} = require('./registerProductResolveRoute');
const {
  registerAdminCatalogOpsRoutes: registerAdminCatalogOpsRoutesDefault,
} = require('./registerAdminCatalogOpsRoutes');
const {
  registerAdminDiagnosticsRoutes: registerAdminDiagnosticsRoutesDefault,
} = require('./registerAdminDiagnosticsRoutes');

function bootstrapGatewaySupportSurface(options) {
  const {
    registerGatewayBaseMiddleware = registerGatewayBaseMiddlewareDefault,
    createHealthRouteHandler = createHealthRouteHandlerDefault,
    registerGatewaySupportRoutes = registerGatewaySupportRoutesDefault,
    registerMerchantOpsRoutes = registerMerchantOpsRoutesDefault,
    registerProductResolveRoute = registerProductResolveRouteDefault,
    registerAdminCatalogOpsRoutes = registerAdminCatalogOpsRoutesDefault,
    registerAdminDiagnosticsRoutes = registerAdminDiagnosticsRoutesDefault,
    app,
    expressModule,
    publicDir,
    env,
    logger,
    serviceName,
    serviceGitShaShort,
    serviceBuildId,
    serviceGitBranch,
    serviceDeploymentId,
    health = {},
    supportRoutes = {},
    merchantOps = {},
    productResolve = {},
    adminCatalogOps = {},
    adminDiagnostics = {},
  } = options;

  registerGatewayBaseMiddleware({
    app,
    expressModule,
    publicDir,
    env,
    logger,
    serviceGitShaShort,
    serviceBuildId,
    serviceGitBranch,
    serviceDeploymentId,
    serviceName,
  });

  const healthRouteHandler = createHealthRouteHandler({
    env,
    logger,
    serviceName,
    serviceGitShaShort,
    serviceBuildId,
    serviceGitBranch,
    serviceDeploymentId,
    ...health,
  });

  registerGatewaySupportRoutes({
    app,
    logger,
    env,
    healthRouteHandler,
    serviceName,
    serviceGitShaShort,
    serviceBuildId,
    serviceGitBranch,
    serviceDeploymentId,
    ...supportRoutes,
  });

  registerMerchantOpsRoutes({
    app,
    logger,
    ...merchantOps,
  });

  registerProductResolveRoute({
    app,
    logger,
    ...productResolve,
  });

  registerAdminCatalogOpsRoutes({
    app,
    ...adminCatalogOps,
  });

  registerAdminDiagnosticsRoutes({
    app,
    ...adminDiagnostics,
  });

  return {
    healthRouteHandler,
  };
}

module.exports = {
  bootstrapGatewaySupportSurface,
};

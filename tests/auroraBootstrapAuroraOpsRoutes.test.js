const {
  bootstrapAuroraOpsRoutes,
} = require('../src/auroraBff/bootstrapAuroraOpsRoutes');

describe('bootstrapAuroraOpsRoutes', () => {
  test('delegates app and runtime deps to aurora ops route owner', () => {
    const app = { get: jest.fn(), post: jest.fn() };
    const registerAuroraOpsRoutes = jest.fn();
    const logger = { info: jest.fn() };
    const buildRequestContext = jest.fn();
    const renderVisionMetricsPrometheus = jest.fn();
    const recoDogfoodConfig = { dogfood_mode: true };

    bootstrapAuroraOpsRoutes({
      registerAuroraOpsRoutes,
      app,
      logger,
      buildRequestContext,
      renderVisionMetricsPrometheus,
      recoDogfoodConfig,
    });

    expect(registerAuroraOpsRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        logger,
        buildRequestContext,
        renderVisionMetricsPrometheus,
        recoDogfoodConfig,
      }),
    );
  });
});

const {
  bootstrapProductIntelRoutes,
} = require('../src/auroraBff/bootstrapProductIntelRoutes');

describe('bootstrapProductIntelRoutes', () => {
  test('delegates app and runtime deps to product-intel route owner', () => {
    const app = { post: jest.fn() };
    const mountProductIntelRoutes = jest.fn();
    const logger = { info: jest.fn() };
    const buildEnvelope = jest.fn();
    const ProductParseRequestSchema = { safeParse: jest.fn() };
    const ProductAnalyzeRequestSchema = { safeParse: jest.fn() };
    const resolveProductIntelLlmRoute = jest.fn();

    bootstrapProductIntelRoutes({
      mountProductIntelRoutes,
      app,
      logger,
      buildEnvelope,
      ProductParseRequestSchema,
      ProductAnalyzeRequestSchema,
      resolveProductIntelLlmRoute,
    });

    expect(mountProductIntelRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildEnvelope,
        ProductParseRequestSchema,
        ProductAnalyzeRequestSchema,
        resolveProductIntelLlmRoute,
      }),
    );
  });
});

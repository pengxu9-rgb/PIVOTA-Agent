const {
  bootstrapRecoRoutes,
} = require('../src/auroraBff/bootstrapRecoRoutes');

describe('bootstrapRecoRoutes', () => {
  test('delegates dogfood and recommendation route families through one owner', () => {
    const app = { post: jest.fn(), get: jest.fn() };
    const mountRecoDogfoodRoutes = jest.fn();
    const mountRecoRecommendationRoutes = jest.fn();
    const logger = { info: jest.fn() };
    const buildRequestContext = jest.fn();
    const recoDogfoodConfig = { dogfood_mode: true };
    const RecoEmployeeFeedbackRequestSchema = { safeParse: jest.fn() };
    const RecoGenerateRequestSchema = { safeParse: jest.fn() };
    const generateProductRecommendations = jest.fn();

    bootstrapRecoRoutes({
      mountRecoDogfoodRoutes,
      mountRecoRecommendationRoutes,
      app,
      logger,
      buildRequestContext,
      recoDogfoodConfig,
      RecoEmployeeFeedbackRequestSchema,
      RecoGenerateRequestSchema,
      generateProductRecommendations,
    });

    expect(mountRecoDogfoodRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildRequestContext,
        recoDogfoodConfig,
        RecoEmployeeFeedbackRequestSchema,
      }),
    );
    expect(mountRecoRecommendationRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildRequestContext,
        RecoGenerateRequestSchema,
        generateProductRecommendations,
      }),
    );
  });
});

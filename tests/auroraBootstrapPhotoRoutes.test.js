const {
  bootstrapPhotoRoutes,
} = require('../src/auroraBff/bootstrapPhotoRoutes');

describe('bootstrapPhotoRoutes', () => {
  test('delegates photo route runtime deps through one owner', () => {
    const app = { post: jest.fn() };
    const mountPhotoRoutes = jest.fn();
    const logger = { info: jest.fn() };
    const buildRequestContext = jest.fn();
    const PhotosPresignRequestSchema = { safeParse: jest.fn() };
    const PhotosConfirmRequestSchema = { safeParse: jest.fn() };
    const safeBuildAutoAnalysisFromConfirmedPhoto = jest.fn();

    bootstrapPhotoRoutes({
      mountPhotoRoutes,
      app,
      logger,
      buildRequestContext,
      PhotosPresignRequestSchema,
      PhotosConfirmRequestSchema,
      safeBuildAutoAnalysisFromConfirmedPhoto,
    });

    expect(mountPhotoRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildRequestContext,
        PhotosPresignRequestSchema,
        PhotosConfirmRequestSchema,
        safeBuildAutoAnalysisFromConfirmedPhoto,
      }),
    );
  });
});

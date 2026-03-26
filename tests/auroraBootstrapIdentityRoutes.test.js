const {
  bootstrapIdentityRoutes,
} = require('../src/auroraBff/bootstrapIdentityRoutes');

describe('bootstrapIdentityRoutes', () => {
  test('delegates auth, session bootstrap, and profile route families through one owner', () => {
    const app = { get: jest.fn(), post: jest.fn() };
    const mountAuthRoutes = jest.fn();
    const mountSessionBootstrapRoutes = jest.fn();
    const mountProfileRoutes = jest.fn();
    const logger = { info: jest.fn() };
    const buildRequestContext = jest.fn();
    const requireAuroraUid = jest.fn();
    const AuthStartRequestSchema = { safeParse: jest.fn() };
    const UserProfilePatchSchema = { safeParse: jest.fn() };
    const resolveIdentity = jest.fn();

    bootstrapIdentityRoutes({
      mountAuthRoutes,
      mountSessionBootstrapRoutes,
      mountProfileRoutes,
      app,
      logger,
      buildRequestContext,
      requireAuroraUid,
      AuthStartRequestSchema,
      UserProfilePatchSchema,
      resolveIdentity,
    });

    expect(mountAuthRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildRequestContext,
        requireAuroraUid,
        AuthStartRequestSchema,
      }),
    );
    expect(mountSessionBootstrapRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildRequestContext,
        requireAuroraUid,
        resolveIdentity,
      }),
    );
    expect(mountProfileRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildRequestContext,
        requireAuroraUid,
        UserProfilePatchSchema,
      }),
    );
  });
});

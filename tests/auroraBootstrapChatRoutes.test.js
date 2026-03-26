const {
  bootstrapChatRoutes,
} = require('../src/auroraBff/bootstrapChatRoutes');

describe('bootstrapChatRoutes', () => {
  test('delegates chat route runtime deps through one owner', () => {
    const app = { post: jest.fn(), get: jest.fn() };
    const mountChatRoutes = jest.fn();
    const logger = { info: jest.fn() };
    const buildRequestContext = jest.fn();
    const V1ChatRequestSchema = { safeParse: jest.fn() };
    const resolveIdentity = jest.fn();
    const auroraChat = jest.fn();

    bootstrapChatRoutes({
      mountChatRoutes,
      app,
      logger,
      buildRequestContext,
      V1ChatRequestSchema,
      resolveIdentity,
      auroraChat,
    });

    expect(mountChatRoutes).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        logger,
        buildRequestContext,
        V1ChatRequestSchema,
        resolveIdentity,
        auroraChat,
      }),
    );
  });
});

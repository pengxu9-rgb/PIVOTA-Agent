const {
  FALLBACK_UI_CHAT_SYSTEM_PROMPT,
  loadUiChatSystemPrompt,
  createUiChatRouteHandler,
  registerUiChatRoute,
} = require('../src/uiChatRoute');

describe('uiChatRoute', () => {
  test('loadUiChatSystemPrompt falls back and normalizes today token', () => {
    const logger = { warn: jest.fn() };

    const prompt = loadUiChatSystemPrompt({
      env: {},
      logger,
      fsModule: {
        readFileSync: jest.fn(() => {
          throw new Error('missing');
        }),
      },
      today: () => '2026-03-22',
    });

    expect(prompt).toBe(FALLBACK_UI_CHAT_SYSTEM_PROMPT);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        promptPath: expect.stringContaining('shopping_agent_system_prompt_v1_5.txt'),
      }),
      'Failed to load system prompt file; using fallback prompt',
    );
  });

  test('loadUiChatSystemPrompt replaces baked now token in file prompt', () => {
    const logger = { warn: jest.fn() };

    const prompt = loadUiChatSystemPrompt({
      env: {
        PIVOTA_UI_CHAT_SYSTEM_PROMPT_PATH: '/tmp/custom-prompt.txt',
      },
      logger,
      fsModule: {
        readFileSync: jest.fn(() => 'header now=2020-01-01 footer'),
      },
      today: () => '2026-03-22',
    });

    expect(prompt).toBe('header now=2026-03-22 footer');
  });

  test('createUiChatRouteHandler validates request body and returns assistant message', async () => {
    const handler = createUiChatRouteHandler({
      runAgentWithTools: jest.fn(async () => ({ role: 'assistant', content: 'done' })),
      logger: { error: jest.fn(), warn: jest.fn() },
      loadSystemPrompt: jest.fn(() => 'system prompt'),
    });
    const invalidRes = {
      status: jest.fn(function status(code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn(function json(body) {
        this.body = body;
        return body;
      }),
    };

    await expect(handler({ body: {} }, invalidRes)).resolves.toEqual({
      error: 'INVALID_REQUEST',
      message: 'Body must have a messages array',
    });
    expect(invalidRes.status).toHaveBeenCalledWith(400);

    const validRes = {
      json: jest.fn(function json(body) {
        this.body = body;
        return body;
      }),
      status: jest.fn(function status(code) {
        this.statusCode = code;
        return this;
      }),
    };
    const runAgentWithTools = jest.fn(async (messages) => ({
      role: 'assistant',
      content: messages[1].content,
    }));
    const validHandler = createUiChatRouteHandler({
      runAgentWithTools,
      logger: { error: jest.fn(), warn: jest.fn() },
      loadSystemPrompt: jest.fn(() => 'system prompt'),
    });

    await expect(
      validHandler(
        { body: { messages: [{ role: 'user', content: 'hello' }] } },
        validRes,
      ),
    ).resolves.toEqual({
      assistantMessage: { role: 'assistant', content: 'hello' },
    });

    expect(runAgentWithTools).toHaveBeenCalledWith([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ]);
  });

  test('createUiChatRouteHandler converts failures into internal error envelope', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const handler = createUiChatRouteHandler({
      runAgentWithTools: jest.fn(async () => {
        throw new Error('boom');
      }),
      logger,
      loadSystemPrompt: jest.fn(() => 'system prompt'),
    });
    const res = {
      status: jest.fn(function status(code) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn(function json(body) {
        this.body = body;
        return body;
      }),
    };

    await expect(
      handler({ body: { messages: [{ role: 'user', content: 'hello' }] } }, res),
    ).resolves.toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Failed to run agent',
    });

    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Error in /ui/chat',
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('registerUiChatRoute binds /ui/chat route', () => {
    const app = { post: jest.fn() };

    registerUiChatRoute({
      app,
      runAgentWithTools: jest.fn(),
      logger: { error: jest.fn(), warn: jest.fn() },
    });

    expect(app.post).toHaveBeenCalledWith('/ui/chat', expect.any(Function));
  });
});

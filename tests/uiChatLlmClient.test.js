const {
  resolveUiChatProvider,
  resolveGeminiApiKey,
  resolveGeminiBaseUrl,
  resolveUiChatModel,
  createGetUiChatLlmClient,
} = require('../src/uiChatLlmClient');

describe('uiChatLlmClient', () => {
  test('resolve helpers prefer configured env values', () => {
    const env = {
      OPENAI_API_KEY: 'openai-key',
      GEMINI_API_KEY: 'gemini-key',
      PIVOTA_UI_CHAT_GEMINI_BASE_URL: 'https://example.test/base///',
      PIVOTA_UI_CHAT_LLM_MODEL_OPENAI: 'gpt-test',
    };

    expect(resolveUiChatProvider(env)).toBe('openai');
    expect(resolveGeminiApiKey(env)).toBe('gemini-key');
    expect(resolveGeminiBaseUrl(env)).toBe('https://example.test/base');
    expect(resolveUiChatModel('openai', { env })).toBe('gpt-test');
  });

  test('createGetUiChatLlmClient builds gemini-backed client once and caches it', () => {
    const OpenAIClient = jest.fn((options) => ({ kind: 'client', options }));
    const logger = { info: jest.fn() };
    const env = {
      PIVOTA_UI_CHAT_LLM_PROVIDER: 'gemini',
      PIVOTA_UI_CHAT_LLM_MODEL_GEMINI: 'gemini-test',
      GOOGLE_API_KEY: 'google-key',
      GEMINI_BASE_URL: 'https://gemini.test/openai/',
    };
    const getUiChatLlmClient = createGetUiChatLlmClient({
      env,
      logger,
      OpenAIClient,
      resolveGeminiModel: jest.fn(() => ({ effectiveModel: 'gemini-effective' })),
    });

    const first = getUiChatLlmClient();
    const second = getUiChatLlmClient();

    expect(first).toEqual({
      client: {
        kind: 'client',
        options: {
          apiKey: 'google-key',
          baseURL: 'https://gemini.test/openai',
        },
      },
      provider: 'gemini',
      model: 'gemini-effective',
    });
    expect(second).toEqual(first);
    expect(OpenAIClient).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        provider: 'gemini',
        model: 'gemini-effective',
      },
      'Configured /ui/chat LLM provider',
    );
  });

  test('createGetUiChatLlmClient throws for missing openai credentials', () => {
    const getUiChatLlmClient = createGetUiChatLlmClient({
      env: { PIVOTA_UI_CHAT_LLM_PROVIDER: 'openai' },
      logger: { info: jest.fn() },
      OpenAIClient: jest.fn(),
    });

    expect(() => getUiChatLlmClient()).toThrow(
      'OPENAI_API_KEY is required for /ui/chat provider=openai',
    );
  });
});

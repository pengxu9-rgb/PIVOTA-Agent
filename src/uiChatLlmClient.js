const OpenAI = require('openai');
const { resolveNonImageGeminiModel } = require('./lib/geminiModelFloor');

function resolveUiChatProvider(env = process.env) {
  const explicit = String(env.PIVOTA_UI_CHAT_LLM_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'openai' || explicit === 'gemini') return explicit;

  const hasOpenAI = Boolean(String(env.OPENAI_API_KEY || '').trim());
  const hasGemini = Boolean(
    String(
      env.GEMINI_API_KEY ||
        env.PIVOTA_GEMINI_API_KEY ||
        env.GOOGLE_API_KEY ||
        '',
    ).trim(),
  );

  if (hasGemini && !hasOpenAI) return 'gemini';
  if (hasOpenAI) return 'openai';
  if (hasGemini) return 'gemini';
  return 'openai';
}

function resolveGeminiApiKey(env = process.env) {
  return String(
    env.GEMINI_API_KEY ||
      env.PIVOTA_GEMINI_API_KEY ||
      env.GOOGLE_API_KEY ||
      '',
  ).trim();
}

function resolveGeminiBaseUrl(env = process.env) {
  const raw = String(
    env.PIVOTA_UI_CHAT_GEMINI_BASE_URL ||
      env.GEMINI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai',
  ).trim();
  return raw.replace(/\/+$/, '');
}

function resolveUiChatModel(
  provider,
  {
    env = process.env,
    resolveGeminiModel = resolveNonImageGeminiModel,
  } = {},
) {
  if (provider === 'gemini') {
    return resolveGeminiModel({
      model: env.PIVOTA_UI_CHAT_LLM_MODEL_GEMINI || env.PIVOTA_UI_CHAT_LLM_MODEL,
      fallbackModel: 'gemini-3-flash-preview',
      envSource: env.PIVOTA_UI_CHAT_LLM_MODEL_GEMINI
        ? 'PIVOTA_UI_CHAT_LLM_MODEL_GEMINI'
        : 'PIVOTA_UI_CHAT_LLM_MODEL',
      callPath: 'ui_chat',
    }).effectiveModel;
  }

  return String(
    env.PIVOTA_UI_CHAT_LLM_MODEL_OPENAI ||
      env.PIVOTA_UI_CHAT_LLM_MODEL ||
      'gpt-5.1',
  ).trim();
}

function createGetUiChatLlmClient({
  logger,
  env = process.env,
  OpenAIClient = OpenAI,
  resolveGeminiModel = resolveNonImageGeminiModel,
} = {}) {
  let uiChatLlmClient;
  let uiChatLlmModel;
  let uiChatLlmProvider;

  return function getUiChatLlmClient() {
    if (!uiChatLlmClient) {
      const provider = resolveUiChatProvider(env);
      uiChatLlmProvider = provider;
      uiChatLlmModel = resolveUiChatModel(provider, { env, resolveGeminiModel });

      if (provider === 'gemini') {
        const geminiApiKey = resolveGeminiApiKey(env);
        if (!geminiApiKey) {
          throw new Error(
            'GEMINI_API_KEY (or PIVOTA_GEMINI_API_KEY/GOOGLE_API_KEY) is required for /ui/chat provider=gemini',
          );
        }
        uiChatLlmClient = new OpenAIClient({
          apiKey: geminiApiKey,
          baseURL: resolveGeminiBaseUrl(env),
        });
      } else {
        if (!env.OPENAI_API_KEY) {
          throw new Error('OPENAI_API_KEY is required for /ui/chat provider=openai');
        }
        uiChatLlmClient = new OpenAIClient({
          apiKey: env.OPENAI_API_KEY,
        });
      }

      logger.info(
        {
          provider: uiChatLlmProvider,
          model: uiChatLlmModel,
        },
        'Configured /ui/chat LLM provider',
      );
    }

    return {
      client: uiChatLlmClient,
      provider: uiChatLlmProvider,
      model: uiChatLlmModel,
    };
  };
}

module.exports = {
  resolveUiChatProvider,
  resolveGeminiApiKey,
  resolveGeminiBaseUrl,
  resolveUiChatModel,
  createGetUiChatLlmClient,
};

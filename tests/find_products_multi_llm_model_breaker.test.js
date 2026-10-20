// The model-unavailable breaker for the find_products_multi LLM passes (src/findProductsMulti/llmModelBreaker.js).
//
// A provider that answers "no such model" answers it again on every later call until a redeploy, so the
// first such answer must stop the pass from dialling that (provider, model) pair for the rest of the process,
// log ONCE, and leave the search exactly as the deterministic path would have produced it. Transient failures
// must NOT open it, and a failing rerank must never cost more than its one deadline.

const ENV_KEYS = [
  'FIND_PRODUCTS_MULTI_LLM_ENABLED',
  'FIND_PRODUCTS_MULTI_LLM_PROVIDER',
  'FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER',
  'PIVOTA_RERANK_LLM_PROVIDER',
  'PIVOTA_RERANK_LLM_FALLBACK_PROVIDER',
  'PIVOTA_RERANK_LLM_TIMEOUT_MS',
  'PIVOTA_RERANK_MODEL',
  'PIVOTA_RERANK_MODEL_OPENAI',
  'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER',
  'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_FALLBACK_PROVIDER',
  'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_OPENAI',
  'OPENAI_API_KEY',
  'LLM_API_KEY',
  'OPENAI_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'AURORA_RECO_GEMINI_API_KEY',
  'PIVOTA_GEMINI_API_KEY',
  'AURORA_SKIN_GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'VERTEX_AI_ENABLED',
];

let prevEnv;

beforeEach(() => {
  jest.resetModules();
  prevEnv = {};
  for (const key of ENV_KEYS) {
    prevEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.FIND_PRODUCTS_MULTI_LLM_ENABLED = 'true';
});

afterEach(() => {
  jest.dontMock('openai');
  jest.dontMock('axios');
  jest.dontMock('../src/logger');
  jest.resetModules();
  for (const key of ENV_KEYS) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
});

function openAiNotFound(model = 'gpt-5.1-mini') {
  // The shape the openai SDK's NotFoundError carries.
  const err = new Error(`404 The model \`${model}\` does not exist or you do not have access to it.`);
  err.status = 404;
  err.code = 'model_not_found';
  err.error = { message: err.message, type: 'invalid_request_error', code: 'model_not_found' };
  return err;
}

function axiosError(status, data = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.code = status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
  err.response = { status, data };
  return err;
}

function rerankJson() {
  return {
    items: [
      { product_id: 'ext-1', source: 'external', rationale: 'exact match' },
      { product_id: 'int-1', source: 'internal', rationale: 'close' },
    ],
  };
}

function load({ openaiCreate, axiosPost } = {}) {
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  jest.doMock('../src/logger', () => logger);
  const create = openaiCreate || jest.fn();
  jest.doMock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create } } })));
  const post = axiosPost || jest.fn();
  jest.doMock('axios', () => ({ post }));
  return {
    rerank: require('../src/findProductsMulti/rerankLlm'),
    breaker: require('../src/findProductsMulti/llmModelBreaker'),
    logger,
    create,
    post,
  };
}

function rerankable() {
  return {
    products: [
      { product_id: 'int-1', title: 'Internal', merchant_id: 'm1' },
      { product_id: 'ext-1', title: 'External', merchant_id: 'external_seed' },
      { product_id: 'int-2', title: 'Internal 2', merchant_id: 'm1' },
    ],
  };
}

function breakerWarns(logger) {
  return logger.warn.mock.calls.filter(([, msg]) => /model unavailable/.test(String(msg)));
}

describe('isModelUnavailableError', () => {
  test('classifies model-not-found answers, and nothing transient', () => {
    const { isModelUnavailableError } = require('../src/findProductsMulti/llmModelBreaker');
    expect(isModelUnavailableError(openAiNotFound())).toBe(true);
    expect(isModelUnavailableError({ code: 'model_not_found' })).toBe(true);
    expect(isModelUnavailableError(axiosError(404, { error: { status: 'NOT_FOUND', message: 'Publisher Model was not found' } }))).toBe(true);
    expect(isModelUnavailableError(axiosError(400, { error: { message: 'Invalid model: x-model' } }))).toBe(true);
    expect(isModelUnavailableError(axiosError(400, { error: { message: 'max_tokens is too large' } }))).toBe(false);
    expect(isModelUnavailableError(axiosError(429))).toBe(false);
    expect(isModelUnavailableError(axiosError(500))).toBe(false);
    expect(isModelUnavailableError(Object.assign(new Error('timeout of 2500ms exceeded'), { code: 'ECONNABORTED' }))).toBe(false);
    expect(isModelUnavailableError(new Error('Unexpected token in JSON'))).toBe(false);
    expect(isModelUnavailableError(null)).toBe(false);
  });
});

describe('recordModelFailure', () => {
  test('logs once per (provider, model) even when in-flight calls report the same 404 after it opened', () => {
    const { breaker, logger } = load();
    for (let i = 0; i < 3; i += 1) {
      expect(breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm-a', err: openAiNotFound('m-a') })).toBe(true);
    }
    expect(breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm-b', err: openAiNotFound('m-b') })).toBe(true);
    expect(breakerWarns(logger)).toHaveLength(2);
    expect(breaker.isModelBreakerOpen('openai', 'm-a')).toBe(true);
    expect(breaker.isModelBreakerOpen('gemini', 'm-a')).toBe(false);
  });
});

describe('rerank breaker', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-breaker-test';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'openai';
  });

  test('model-not-found opens the breaker: one WARN, later searches skip the provider and keep their order', async () => {
    const create = jest.fn().mockRejectedValue(openAiNotFound());
    const { rerank, logger } = load({ openaiCreate: create });

    await expect(
      rerank.maybeRerankFindProductsMultiResponse({ response: rerankable(), userQuery: 'lipstick', limit: 3 }),
    ).rejects.toThrow(/rerank_llm_failed/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(breakerWarns(logger)).toHaveLength(1);
    expect(breakerWarns(logger)[0][0]).toMatchObject({
      feature: 'rerank', provider: 'openai', model: 'gpt-5.1-mini', upstream_status: 404, env_hint: 'PIVOTA_RERANK_MODEL_OPENAI',
    });

    for (let i = 0; i < 3; i += 1) {
      const response = rerankable();
      const out = await rerank.maybeRerankFindProductsMultiResponse({ response, userQuery: 'lipstick', limit: 3 });
      expect(out).toEqual({ response, applied: false, skipped_reason: 'model_unavailable' });
      expect(out.response).toBe(response);
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(breakerWarns(logger)).toHaveLength(1);
  });

  test('the breaker is keyed by model: a configured model that exists is unaffected by another one failing', async () => {
    process.env.PIVOTA_RERANK_MODEL_OPENAI = 'model-that-exists';
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(rerankJson()) } }] });
    const { rerank, breaker } = load({ openaiCreate: create });
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'gpt-5.1-mini', err: openAiNotFound() });

    const out = await rerank.maybeRerankFindProductsMultiResponse({ response: rerankable(), userQuery: 'lipstick', limit: 3 });
    expect(out.applied).toBe(true);
    expect(create.mock.calls[0][0].model).toBe('model-that-exists');
  });

  test('a transient failure does not open the breaker', async () => {
    const create = jest.fn().mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
    const { rerank, logger } = load({ openaiCreate: create });
    for (let i = 0; i < 2; i += 1) {
      await expect(
        rerank.maybeRerankFindProductsMultiResponse({ response: rerankable(), userQuery: 'lipstick', limit: 3 }),
      ).rejects.toThrow(/rerank_llm_failed/);
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(breakerWarns(logger)).toHaveLength(0);
  });

  test('a dead primary is skipped and the fallback still reranks, without dialling the primary again', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'gemini';
    process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER = 'openai';
    const post = jest.fn().mockRejectedValue(axiosError(404, { error: { status: 'NOT_FOUND', message: 'Publisher Model not found' } }));
    const create = jest.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify(rerankJson()) } }] });
    const { rerank, logger } = load({ openaiCreate: create, axiosPost: post });

    const first = await rerank.maybeRerankFindProductsMultiResponse({ response: rerankable(), userQuery: 'lipstick', limit: 3 });
    expect(first).toMatchObject({ applied: true, provider: 'openai' });
    const second = await rerank.maybeRerankFindProductsMultiResponse({ response: rerankable(), userQuery: 'lipstick', limit: 3 });
    expect(second).toMatchObject({ applied: true, provider: 'openai' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(breakerWarns(logger)).toHaveLength(1);
    // Reordered, never shortened.
    expect(second.response.products.map((p) => p.product_id).sort()).toEqual(['ext-1', 'int-1', 'int-2']);
  });

  test('one deadline bounds the WHOLE provider chain, not each provider', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'gemini';
    process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER = 'openai';
    process.env.PIVOTA_RERANK_LLM_TIMEOUT_MS = '600';
    // Each provider eats almost the whole budget and then fails: per-provider deadlines alone would add up.
    const slowFail = () => new Promise((_, reject) => setTimeout(() => reject(axiosError(503)), 550));
    const post = jest.fn().mockImplementation(slowFail);
    const create = jest.fn().mockImplementation(slowFail);
    const { rerank } = load({ openaiCreate: create, axiosPost: post });

    const started = Date.now();
    await expect(
      rerank.maybeRerankFindProductsMultiResponse({ response: rerankable(), userQuery: 'lipstick', limit: 3 }),
    ).rejects.toThrow(/deadline 600ms exceeded/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('semantic rewrite shares the breaker', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-breaker-test';
    process.env.FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER = 'openai';
  });

  test('model-not-found falls back to the rule-based intent, then stops dialling the provider', async () => {
    const create = jest.fn().mockRejectedValue(openAiNotFound());
    const { logger } = load({ openaiCreate: create });
    const { extractIntentWithMeta } = require('../src/findProductsMulti/intentLlm');

    const first = await extractIntentWithMeta('hydrating serum for dry skin');
    expect(first.intent).toBeTruthy();
    expect(first.meta.mode).not.toBe('llm');
    expect(create).toHaveBeenCalledTimes(1);

    const second = await extractIntentWithMeta('hydrating serum for dry skin');
    expect(second.intent).toBeTruthy();
    expect(second.meta.llm_error_class).toBe('model_unavailable');
    expect(create).toHaveBeenCalledTimes(1);
    expect(breakerWarns(logger)).toHaveLength(1);
    expect(breakerWarns(logger)[0][0]).toMatchObject({
      feature: 'semantic_rewrite', provider: 'openai', env_hint: 'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_OPENAI',
    });
  });
});

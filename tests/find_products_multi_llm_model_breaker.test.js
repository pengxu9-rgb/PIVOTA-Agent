// The model-unavailable breaker for the find_products_multi LLM passes (src/findProductsMulti/llmModelBreaker.js).
//
// A provider that answers "no such model" answers it again until the env or the account changes, so that answer
// must stop the pass from dialling that (feature, provider, model) until a cooldown probe, log once per opening,
// and leave the search exactly as the deterministic path would have produced it. It must open on NOTHING else
// (a request-shape 400, a bare 404, a transient error), must not let one feature switch off another, and a
// failing rerank must never cost more than its one deadline nor keep dialling after it.
//
// Error fixtures are built with the real openai SDK's APIError.generate, the shapes the SDK actually throws.

const ENV_KEYS = [
  'FIND_PRODUCTS_MULTI_LLM_ENABLED',
  'FIND_PRODUCTS_MULTI_LLM_PROVIDER',
  'FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER',
  'PIVOTA_RERANK_LLM_PROVIDER',
  'PIVOTA_RERANK_LLM_FALLBACK_PROVIDER',
  'PIVOTA_RERANK_LLM_TIMEOUT_MS',
  'PIVOTA_RERANK_MODEL',
  'PIVOTA_RERANK_MODEL_OPENAI',
  'PIVOTA_LLM_MODEL_BREAKER_COOLDOWN_MS',
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

const MIN = 60 * 1000;
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

// ---- real error shapes ----

const RealOpenAI = jest.requireActual('openai');

function openAiError(status, body, message) {
  return RealOpenAI.APIError.generate(status, body, message, new Headers());
}

function openAiModelNotFound(model = 'gpt-5.1-mini') {
  return openAiError(404, {
    error: {
      message: `The model \`${model}\` does not exist or you do not have access to it.`,
      type: 'invalid_request_error', param: null, code: 'model_not_found',
    },
  });
}

const OPENAI_TEMPERATURE_400 = () => openAiError(400, {
  error: {
    message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
    type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value',
  },
});
const OPENAI_RESPONSE_FORMAT_400 = () => openAiError(400, {
  error: {
    message: "'response_format' of type 'json_object' is not supported with this model.",
    type: 'invalid_request_error', param: 'response_format', code: null,
  },
});
const OPENAI_BARE_404 = () => openAiError(404, undefined, '404 page not found');
const OPENAI_BAD_URL_404 = () => openAiError(404, {
  error: { message: 'Invalid URL (POST /v1/chat/completionz)', type: 'invalid_request_error', code: null },
});

function axiosError(status, data = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.code = status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
  err.response = { status, data };
  return err;
}

const VERTEX_MODEL_404 = () => axiosError(404, {
  error: {
    code: 404,
    status: 'NOT_FOUND',
    message: 'Publisher Model `projects/p/locations/global/publishers/google/models/gemini-x` was not found or your project does not have access to it.',
  },
});
const AI_STUDIO_MODEL_404 = () => axiosError(404, {
  error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-x is not found for API version v1beta, or is not supported for generateContent.' },
});
// A token-endpoint / metadata-server 404 during ADC: a 404, but nothing about a model.
const TOKEN_FETCH_404 = () => axiosError(404, 'Not Found');
const VERTEX_OTHER_NOT_FOUND = () => axiosError(404, {
  error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' },
});

// ---- harness ----

function rerankJson() {
  return {
    items: [
      { product_id: 'ext-1', source: 'external', rationale: 'exact match' },
      { product_id: 'int-1', source: 'internal', rationale: 'close' },
    ],
  };
}
const openAiOk = () => ({ choices: [{ message: { content: JSON.stringify(rerankJson()) } }] });
const geminiOk = () => ({ data: { candidates: [{ content: { parts: [{ text: JSON.stringify(rerankJson()) }] } }] } });

function load({ openaiCreate, axiosPost } = {}) {
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  jest.doMock('../src/logger', () => logger);
  const create = openaiCreate || jest.fn();
  jest.doMock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create } } })));
  const post = axiosPost || jest.fn();
  jest.doMock('axios', () => ({ post }));
  const breaker = require('../src/findProductsMulti/llmModelBreaker');
  let now = 1_000_000;
  breaker.__setClockForTests(() => now);
  return {
    rerank: require('../src/findProductsMulti/rerankLlm'),
    breaker,
    logger,
    create,
    post,
    advance: (ms) => { now += ms; },
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

const rerankOnce = (rerank, response = rerankable()) =>
  rerank.maybeRerankFindProductsMultiResponse({ response, userQuery: 'lipstick', limit: 3 });

function breakerWarns(logger) {
  return logger.warn.mock.calls.filter(([fields]) => fields && fields.event === 'llm_model_breaker_open');
}

// ---- classification ----

describe('isModelUnavailableError', () => {
  test('opens only on a 404 that says the model does not exist', () => {
    const { isModelUnavailableError } = require('../src/findProductsMulti/llmModelBreaker');
    expect(isModelUnavailableError(openAiModelNotFound())).toBe(true);
    expect(isModelUnavailableError(VERTEX_MODEL_404())).toBe(true);
    expect(isModelUnavailableError(AI_STUDIO_MODEL_404())).toBe(true);
    // An OpenAI-compatible endpoint that says it without the code.
    expect(isModelUnavailableError(openAiError(404, { error: { message: 'The model `m` does not exist' } }))).toBe(true);
  });

  test('never on a request-shape 400, a bare or unrelated 404, or anything transient', () => {
    const { isModelUnavailableError } = require('../src/findProductsMulti/llmModelBreaker');
    expect(isModelUnavailableError(OPENAI_TEMPERATURE_400())).toBe(false);
    expect(isModelUnavailableError(OPENAI_RESPONSE_FORMAT_400())).toBe(false);
    expect(isModelUnavailableError(OPENAI_BARE_404())).toBe(false);
    expect(isModelUnavailableError(OPENAI_BAD_URL_404())).toBe(false);
    expect(isModelUnavailableError(TOKEN_FETCH_404())).toBe(false);
    expect(isModelUnavailableError(VERTEX_OTHER_NOT_FOUND())).toBe(false);
    // model_not_found must arrive WITH a 404 — a compatible endpoint answering 400 with OpenAI's words does not
    // count either: a 400 is a refusal of this request, not a statement that the model is missing.
    expect(isModelUnavailableError({ code: 'model_not_found' })).toBe(false);
    expect(isModelUnavailableError(openAiError(400, { error: { message: 'The model `m` does not exist', code: 'model_not_found' } }))).toBe(false);
    expect(isModelUnavailableError(axiosError(429))).toBe(false);
    expect(isModelUnavailableError(axiosError(500))).toBe(false);
    expect(isModelUnavailableError(openAiError(429, { error: { message: 'Rate limit' } }))).toBe(false);
    expect(isModelUnavailableError(Object.assign(new Error('timeout of 2500ms exceeded'), { code: 'ECONNABORTED' }))).toBe(false);
    expect(isModelUnavailableError(new Error('Unexpected token in JSON'))).toBe(false);
    expect(isModelUnavailableError(null)).toBe(false);
  });
});

// ---- the state machine ----

describe('breaker state', () => {
  test('logs once per opening even when in-flight calls report the same 404 after it opened', () => {
    const { breaker, logger } = load();
    for (let i = 0; i < 3; i += 1) {
      expect(breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm-a', err: openAiModelNotFound('m-a') })).toBe(true);
    }
    expect(breakerWarns(logger)).toHaveLength(1);
    expect(breakerWarns(logger)[0][0]).toMatchObject({ feature: 'rerank', provider: 'openai', model: 'm-a', reopened: false });
  });

  test('is keyed by feature AND provider AND model', () => {
    const { breaker } = load();
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm-a', err: openAiModelNotFound('m-a') });
    expect(breaker.isModelBreakerOpen('rerank', 'openai', 'm-a')).toBe(true);
    expect(breaker.isModelBreakerOpen('semantic_rewrite', 'openai', 'm-a')).toBe(false);
    expect(breaker.isModelBreakerOpen('rerank', 'openai', 'm-b')).toBe(false);
    expect(breaker.isModelBreakerOpen('rerank', 'gemini', 'm-a')).toBe(false);
  });

  test('half-open: after the cooldown exactly one probe is let through; success closes it', () => {
    const { breaker, advance } = load();
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false);
    advance(15 * MIN - 1);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false);
    advance(1);
    expect(breaker.isModelBreakerOpen('rerank', 'openai', 'm')).toBe(false);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true); // the probe
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false); // only one
    breaker.recordModelSuccess('rerank', 'openai', 'm');
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
  });

  test('a probe answering model-not-found re-opens it and logs the re-opening', () => {
    const { breaker, logger, advance } = load();
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    advance(15 * MIN);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false);
    expect(breakerWarns(logger)).toHaveLength(2);
    expect(breakerWarns(logger)[1][0]).toMatchObject({ reopened: true });
    advance(15 * MIN);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
  });

  test('an inconclusive probe (transient failure) keeps it open for another cooldown, silently', () => {
    const { breaker, logger, advance } = load();
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    advance(15 * MIN);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
    expect(breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: axiosError(503) })).toBe(true);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false);
    advance(15 * MIN);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
    expect(breakerWarns(logger)).toHaveLength(1);
  });

  test('after an inconclusive probe, a late model-not-found from an older in-flight call does not log again', () => {
    const { breaker, logger, advance } = load();
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    advance(15 * MIN);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: axiosError(503) });
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    expect(breakerWarns(logger)).toHaveLength(1);
  });

  test('a transient failure on a closed breaker leaves it closed', () => {
    const { breaker } = load();
    expect(breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: axiosError(503) })).toBe(false);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
  });

  test('a probe that never settles is replaced after one cooldown', () => {
    const { breaker, advance } = load();
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    advance(15 * MIN);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
    advance(15 * MIN - 1);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false);
    advance(1);
    expect(breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
  });

  test('the cooldown env is clamped to 10-30 minutes', () => {
    process.env.PIVOTA_LLM_MODEL_BREAKER_COOLDOWN_MS = '1000';
    let h = load();
    h.breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    h.advance(10 * MIN - 1);
    expect(h.breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false);
    h.advance(1);
    expect(h.breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);

    jest.resetModules();
    process.env.PIVOTA_LLM_MODEL_BREAKER_COOLDOWN_MS = String(60 * MIN);
    h = load();
    h.breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'm', err: openAiModelNotFound('m') });
    h.advance(30 * MIN - 1);
    expect(h.breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(false);
    h.advance(1);
    expect(h.breaker.acquireModelCall('rerank', 'openai', 'm')).toBe(true);
  });
});

// ---- rerank ----

describe('rerank breaker', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-breaker-probe';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'openai';
  });

  test('model-not-found opens it: one WARN, later searches skip the provider, keep their order, and say why', async () => {
    const create = jest.fn().mockRejectedValue(openAiModelNotFound());
    const { rerank, logger } = load({ openaiCreate: create });

    await expect(rerankOnce(rerank)).rejects.toThrow(/rerank_llm_failed/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(breakerWarns(logger)).toHaveLength(1);
    expect(breakerWarns(logger)[0][0]).toMatchObject({
      feature: 'rerank', provider: 'openai', model: 'gpt-5.1-mini', upstream_status: 404,
      upstream_code: 'model_not_found', env_hint: 'PIVOTA_RERANK_MODEL_OPENAI',
    });

    for (let i = 0; i < 3; i += 1) {
      const response = rerankable();
      const out = await rerankOnce(rerank, response);
      expect(out).toEqual({ response, applied: false, skipped_reason: 'model_unavailable', breaker_open: true });
      expect(out.response).toBe(response);
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(breakerWarns(logger)).toHaveLength(1);
  });

  test('after the cooldown the next search probes; a model that now exists turns the pass back on', async () => {
    const create = jest.fn().mockRejectedValueOnce(openAiModelNotFound()).mockResolvedValue(openAiOk());
    const { rerank, advance } = load({ openaiCreate: create });
    await expect(rerankOnce(rerank)).rejects.toThrow(/rerank_llm_failed/);
    expect((await rerankOnce(rerank)).breaker_open).toBe(true);
    advance(15 * MIN);
    expect(await rerankOnce(rerank)).toMatchObject({ applied: true, provider: 'openai' });
    expect(await rerankOnce(rerank)).toMatchObject({ applied: true, provider: 'openai' });
    expect(create).toHaveBeenCalledTimes(3);
  });

  test('a request-shape 400 or a bare 404 never opens it', async () => {
    for (const makeErr of [OPENAI_TEMPERATURE_400, OPENAI_RESPONSE_FORMAT_400, OPENAI_BARE_404]) {
      jest.resetModules();
      const create = jest.fn().mockRejectedValue(makeErr());
      const { rerank, logger } = load({ openaiCreate: create });
      await expect(rerankOnce(rerank)).rejects.toThrow(/rerank_llm_failed/);
      await expect(rerankOnce(rerank)).rejects.toThrow(/rerank_llm_failed/);
      expect(create).toHaveBeenCalledTimes(2);
      expect(breakerWarns(logger)).toHaveLength(0);
    }
  });

  test('a rerank breaker does not switch off semantic rewrite on the same provider and model', async () => {
    process.env.FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER = 'openai';
    const create = jest.fn().mockRejectedValue(openAiModelNotFound());
    const { rerank } = load({ openaiCreate: create });
    await expect(rerankOnce(rerank)).rejects.toThrow(/rerank_llm_failed/);
    expect(create).toHaveBeenCalledTimes(1);
    const { extractIntentWithMeta } = require('../src/findProductsMulti/intentLlm');
    await extractIntentWithMeta('hydrating serum for dry skin');
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('a model that exists is unaffected by another model failing', async () => {
    process.env.PIVOTA_RERANK_MODEL_OPENAI = 'model-that-exists';
    const create = jest.fn().mockResolvedValue(openAiOk());
    const { rerank, breaker } = load({ openaiCreate: create });
    breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'gpt-5.1-mini', err: openAiModelNotFound() });
    expect(await rerankOnce(rerank)).toMatchObject({ applied: true });
    expect(create.mock.calls[0][0].model).toBe('model-that-exists');
  });

  test('a transient failure does not open it', async () => {
    const create = jest.fn().mockRejectedValue(openAiError(429, { error: { message: 'Rate limit reached' } }));
    const { rerank, logger } = load({ openaiCreate: create });
    for (let i = 0; i < 2; i += 1) await expect(rerankOnce(rerank)).rejects.toThrow(/rerank_llm_failed/);
    expect(create).toHaveBeenCalledTimes(2);
    expect(breakerWarns(logger)).toHaveLength(0);
  });

  test('a dead primary is skipped and the fallback still reranks, never shortening the list', async () => {
    process.env.GEMINI_API_KEY = 'gemini-breaker-probe';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'gemini';
    process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER = 'openai';
    const post = jest.fn().mockRejectedValue(VERTEX_MODEL_404());
    const create = jest.fn().mockResolvedValue(openAiOk());
    const { rerank, logger } = load({ openaiCreate: create, axiosPost: post });
    expect(await rerankOnce(rerank)).toMatchObject({ applied: true, provider: 'openai' });
    const second = await rerankOnce(rerank);
    expect(second).toMatchObject({ applied: true, provider: 'openai' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(breakerWarns(logger)).toHaveLength(1);
    expect(second.response.products.map((p) => p.product_id).sort()).toEqual(['ext-1', 'int-1', 'int-2']);
  });

  test('a breaker opened while the primary is in flight is honoured for the next provider', async () => {
    process.env.GEMINI_API_KEY = 'gemini-breaker-probe';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'openai';
    process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER = 'gemini';
    const post = jest.fn().mockResolvedValue(geminiOk());
    let breakerRef = null;
    const create = jest.fn().mockImplementation(async () => {
      // Another request learns, meanwhile, that the fallback's model does not exist.
      breakerRef.recordModelFailure({ feature: 'rerank', provider: 'gemini', model: 'gemini-3-flash-preview', err: VERTEX_MODEL_404() });
      throw openAiError(503, { error: { message: 'overloaded' } });
    });
    const h = load({ openaiCreate: create, axiosPost: post });
    breakerRef = h.breaker;
    await expect(rerankOnce(h.rerank)).rejects.toThrow(/rerank_llm_failed/);
    expect(post).not.toHaveBeenCalled();
  });

  test('one deadline bounds the whole chain, and the fallback is not handed a spent budget', async () => {
    process.env.GEMINI_API_KEY = 'gemini-breaker-probe';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'gemini';
    process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER = 'openai';
    process.env.PIVOTA_RERANK_LLM_TIMEOUT_MS = '1000';
    const post = jest.fn().mockImplementation((url, body, config) =>
      new Promise((_, reject) => setTimeout(() => reject(axiosError(503)), config.timeout)));
    const create = jest.fn().mockResolvedValue(openAiOk());
    const { rerank } = load({ openaiCreate: create, axiosPost: post });
    const started = Date.now();
    expect(await rerankOnce(rerank)).toMatchObject({ applied: true, provider: 'openai' });
    expect(post.mock.calls[0][2].timeout).toBeLessThanOrEqual(600);
    expect(post.mock.calls[0][2].timeout).toBeGreaterThan(500);
    expect(create.mock.calls[0][1].timeout).toBe(1000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('when the deadline fires the chain is cancelled: the in-flight call is aborted, no further provider dialled', async () => {
    process.env.GEMINI_API_KEY = 'gemini-breaker-probe';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'gemini';
    process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER = 'openai';
    process.env.PIVOTA_RERANK_LLM_TIMEOUT_MS = '600';
    let primarySignal = null;
    // A primary that ignores its own transport timeout and fails only after the deadline.
    const post = jest.fn().mockImplementation((url, body, config) => {
      primarySignal = config.signal;
      return new Promise((_, reject) => setTimeout(() => reject(axiosError(503)), 900));
    });
    const create = jest.fn().mockResolvedValue(openAiOk());
    const { rerank } = load({ openaiCreate: create, axiosPost: post });
    const started = Date.now();
    await expect(rerankOnce(rerank)).rejects.toThrow(/deadline 600ms exceeded/);
    expect(Date.now() - started).toBeLessThan(850);
    expect(primarySignal && primarySignal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(create).not.toHaveBeenCalled();
  });
});

// ---- semantic rewrite ----

describe('semantic rewrite breaker', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-breaker-probe';
    process.env.FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER = 'openai';
  });

  test('model-not-found falls back to the rule-based intent, then stops dialling the provider', async () => {
    const create = jest.fn().mockRejectedValue(openAiModelNotFound());
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

  test('a probe the model answers successfully closes the breaker', async () => {
    const { extractIntentRuleBased } = jest.requireActual('../src/findProductsMulti/intent');
    const valid = extractIntentRuleBased('hydrating serum for dry skin', [], []);
    const create = jest.fn()
      .mockRejectedValueOnce(openAiModelNotFound())
      .mockResolvedValue({ choices: [{ message: { content: JSON.stringify(valid) } }] });
    const { breaker, advance } = load({ openaiCreate: create });
    const { extractIntentWithMeta } = require('../src/findProductsMulti/intentLlm');
    await extractIntentWithMeta('hydrating serum for dry skin');
    advance(15 * MIN);
    const probed = await extractIntentWithMeta('hydrating serum for dry skin');
    expect(probed.meta.mode).toBe('llm');
    expect(breaker.isModelBreakerOpen('semantic_rewrite', 'openai', 'gpt-5.1-mini')).toBe(false);
    await extractIntentWithMeta('hydrating serum for dry skin');
    expect(create).toHaveBeenCalledTimes(3);
  });

  test('a probe the model answers with unusable JSON still proves the model exists and closes the breaker', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(openAiModelNotFound())
      .mockResolvedValueOnce({ choices: [{ message: { content: 'not json at all' } }] })
      .mockRejectedValue(openAiError(503, { error: { message: 'overloaded' } }));
    const { breaker, advance } = load({ openaiCreate: create });
    const { extractIntentWithMeta } = require('../src/findProductsMulti/intentLlm');
    await extractIntentWithMeta('hydrating serum for dry skin');
    advance(15 * MIN);
    await extractIntentWithMeta('hydrating serum for dry skin');
    expect(create).toHaveBeenCalledTimes(2);
    expect(breaker.isModelBreakerOpen('semantic_rewrite', 'openai', 'gpt-5.1-mini')).toBe(false);
    await extractIntentWithMeta('hydrating serum for dry skin');
    expect(create).toHaveBeenCalledTimes(3);
  });
});

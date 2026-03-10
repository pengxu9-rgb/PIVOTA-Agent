jest.mock('sharp', () => {
  const makePipeline = () => {
    const pipeline = {
      rotate: jest.fn(() => pipeline),
      resize: jest.fn(() => pipeline),
      extract: jest.fn(() => pipeline),
      raw: jest.fn(() => pipeline),
      png: jest.fn(() => pipeline),
      jpeg: jest.fn(() => pipeline),
      webp: jest.fn(() => pipeline),
      avif: jest.fn(() => pipeline),
      ensureAlpha: jest.fn(() => pipeline),
      removeAlpha: jest.fn(() => pipeline),
      flatten: jest.fn(() => pipeline),
      toBuffer: jest.fn(async () => Buffer.alloc(0)),
      metadata: jest.fn(async () => ({ width: 1, height: 1, format: 'png' })),
    };
    return pipeline;
  };

  const sharp = jest.fn(() => makePipeline());
  sharp.cache = jest.fn();
  sharp.concurrency = jest.fn();
  sharp.simd = jest.fn();
  sharp.format = {};
  sharp.fit = {};
  sharp.kernel = {};
  sharp.strategy = {};
  return sharp;
});

jest.mock('axios', () => {
  const rejected = (method) => jest.fn(async () => {
    throw new Error(`unexpected axios.${method} call in aurora_bff_chat_resilience.test.js`);
  });

  const instance = {
    get: rejected('get'),
    post: rejected('post'),
    put: rejected('put'),
    delete: rejected('delete'),
    request: rejected('request'),
    defaults: {},
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() },
    },
  };

  const axios = Object.assign(jest.fn(instance.request), instance, {
    create: jest.fn(() => instance),
    isAxiosError: () => false,
    AxiosError: Error,
  });
  axios.default = axios;
  return axios;
});

jest.mock('openai', () => {
  class MockOpenAI {
    constructor() {
      this.responses = { create: jest.fn() };
      this.chat = { completions: { create: jest.fn() } };
      this.embeddings = { create: jest.fn() };
    }
  }

  MockOpenAI.default = MockOpenAI;
  return MockOpenAI;
});

jest.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor() {
      this.models = { generateContent: jest.fn() };
    }
  },
}));

jest.mock('ioredis', () =>
  class MockRedis {
    on() {
      return this;
    }

    get() {
      return Promise.resolve(null);
    }

    set() {
      return Promise.resolve('OK');
    }

    del() {
      return Promise.resolve(1);
    }

    quit() {
      return Promise.resolve();
    }

    disconnect() {}
  });

jest.mock('pg', () => ({
  Pool: class MockPool {
    query() {
      return Promise.resolve({ rows: [] });
    }

    connect() {
      return Promise.resolve({
        query: this.query.bind(this),
        release() {},
      });
    }

    end() {
      return Promise.resolve();
    }
  },
}));

jest.mock('onnxruntime-node', () => ({}));

const { buildChatCardsResponse } = require('../src/auroraBff/chatCardsAssembler');

function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function buildCtx(suffix) {
  return {
    request_id: `req_${suffix}`,
    trace_id: `trace_${suffix}`,
    lang: 'EN',
    state: 'S2_DIAGNOSIS',
    trigger_source: 'chip',
  };
}

function buildProfile() {
  return {
    skinType: 'oily',
    sensitivity: 'low',
    barrierStatus: 'healthy',
    goals: ['pores'],
    budgetTier: '$50',
  };
}

function makeRoutineUpstream() {
  return {
    answer: '{}',
    intent: 'chat',
    context: {
      routine: {
        am: [
          {
            step: 'Gentle Cleanser',
            category: 'cleanser',
            sku: { sku_id: 'sku_am_cleanser', name: 'Gentle Cleanser', brand: 'Acme' },
            notes: ['Barrier-friendly cleanse'],
          },
        ],
        pm: [
          {
            step: 'Barrier Cream',
            category: 'moisturizer',
            sku: { sku_id: 'sku_pm_cream', name: 'Barrier Cream', brand: 'Acme' },
            notes: ['Support overnight recovery'],
          },
        ],
      },
    },
    next_actions: [],
  };
}

function loadRoutesWithPatchedAuroraChat(auroraChatImpl) {
  const clientModuleId = require.resolve('../src/auroraBff/auroraDecisionClient');
  const routesModuleId = require.resolve('../src/auroraBff/routes');

  delete require.cache[clientModuleId];
  delete require.cache[routesModuleId];

  const clientMod = require(clientModuleId);
  const originalAuroraChat = clientMod.auroraChat;
  if (typeof auroraChatImpl === 'function') clientMod.auroraChat = auroraChatImpl;

  const routesMod = require(routesModuleId);
  return {
    routesMod,
    restore() {
      clientMod.auroraChat = originalAuroraChat;
      delete require.cache[routesModuleId];
      delete require.cache[clientModuleId];
    },
  };
}

describe('aurora chat resilience regressions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('buildChatCardsResponse preserves error cards instead of mapping them to nudge', () => {
    const out = buildChatCardsResponse({
      envelope: {
        request_id: 'req_error',
        trace_id: 'trace_error',
        assistant_message: { role: 'assistant', content: 'Failed to process chat.' },
        suggested_chips: [],
        cards: [{ card_id: 'err_req_error', type: 'error', payload: { error: 'CHAT_FAILED' } }],
        session_patch: {},
        events: [],
      },
      ctx: {
        request_id: 'req_error',
        trace_id: 'trace_error',
        lang: 'EN',
        ui_lang: 'EN',
        match_lang: 'EN',
        language_resolution_source: 'header',
      },
    });

    expect(Array.isArray(out.cards)).toBe(true);
    expect(out.cards[0]).toEqual(
      expect.objectContaining({
        type: 'error',
        title: 'Error',
        payload: expect.objectContaining({ error: 'CHAT_FAILED' }),
      }),
    );
  });

  test('generateRoutineReco survives alternatives enrichment failure and still returns recommendations', async () => {
    await withEnv(
      {
        AURORA_BFF_USE_MOCK: 'false',
        AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      },
      async () => {
        const harness = loadRoutesWithPatchedAuroraChat(async () => makeRoutineUpstream());
        const logger = { warn: jest.fn() };
        harness.routesMod.__internal.__setEnrichRecommendationsWithAlternativesForTest(async () => {
          const err = new Error('alternatives exploded');
          err.code = 'ALT_FAIL';
          throw err;
        });

        try {
          const out = await harness.routesMod.__internal.generateRoutineReco({
            ctx: buildCtx('routine_alt_fail'),
            profile: buildProfile(),
            recentLogs: [],
            focus: 'Build an AM/PM routine',
            constraints: {},
            includeAlternatives: true,
            logger,
          });

          expect(out.norm.payload.recommendations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sku: expect.objectContaining({ sku_id: 'sku_am_cleanser' }),
              }),
            ]),
          );
          expect(out.norm.field_missing || []).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                field: 'recommendations[].alternatives',
                reason: 'alternatives_unavailable',
              }),
            ]),
          );
        } finally {
          harness.routesMod.__internal.__resetEnrichRecommendationsWithAlternativesForTest();
          harness.restore();
        }
      },
    );
  });

  test('generateRoutineReco survives pdp enrichment failure and marks enrichment as skipped', async () => {
    await withEnv(
      {
        AURORA_BFF_USE_MOCK: 'false',
        AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      },
      async () => {
        const harness = loadRoutesWithPatchedAuroraChat(async () => makeRoutineUpstream());
        const logger = { warn: jest.fn() };
        harness.routesMod.__internal.__setEnrichRecommendationsWithPdpOpenContractForTest(async () => {
          const err = new Error('pdp exploded');
          err.code = 'PDP_FAIL';
          throw err;
        });

        try {
          const out = await harness.routesMod.__internal.generateRoutineReco({
            ctx: buildCtx('routine_pdp_fail'),
            profile: buildProfile(),
            recentLogs: [],
            focus: 'Build an AM/PM routine',
            constraints: {},
            includeAlternatives: false,
            logger,
          });

          expect(out.norm.payload.recommendations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sku: expect.objectContaining({ sku_id: 'sku_am_cleanser' }),
              }),
            ]),
          );
          expect(out.norm.payload.metadata).toEqual(
            expect.objectContaining({
              pdp_open_enrichment_skipped: true,
              pdp_open_path_stats: expect.any(Object),
              resolve_fail_reason_counts: expect.any(Object),
              time_to_pdp_ms_stats: expect.any(Object),
            }),
          );
        } finally {
          harness.routesMod.__internal.__resetEnrichRecommendationsWithPdpOpenContractForTest();
          harness.restore();
        }
      },
    );
  });

  test('generateProductRecommendations survives includeAlternatives runtime failure without throwing', async () => {
    await withEnv(
      {
        AURORA_BFF_USE_MOCK: 'false',
        AURORA_DECISION_BASE_URL: 'https://aurora-decision.test',
      },
      async () => {
        const harness = loadRoutesWithPatchedAuroraChat(async () => makeRoutineUpstream());
        const logger = { warn: jest.fn() };
        harness.routesMod.__internal.__setEnrichRecommendationsWithAlternativesForTest(async () => {
          const err = new Error('alternatives exploded');
          err.code = 'ALT_FAIL';
          throw err;
        });

        try {
          const out = await harness.routesMod.__internal.generateProductRecommendations({
            ctx: buildCtx('product_alt_fail'),
            profile: buildProfile(),
            recentLogs: [],
            message: 'Recommend a simple routine',
            includeAlternatives: true,
            debug: false,
            logger,
          });

          expect(out.norm.payload.recommendations.length).toBeGreaterThan(0);
          expect(out.norm.field_missing || []).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                field: 'recommendations[].alternatives',
                reason: 'alternatives_unavailable',
              }),
            ]),
          );
        } finally {
          harness.routesMod.__internal.__resetEnrichRecommendationsWithAlternativesForTest();
          harness.restore();
        }
      },
    );
  });

  test('routine fallback helper swallows builder errors and preserves envelope', () => {
    const harness = loadRoutesWithPatchedAuroraChat(async () => makeRoutineUpstream());
    const logger = { warn: jest.fn() };
    harness.routesMod.__internal.__setBuildRoutineRulesOnlyFallbackCardsForChatForTest(() => {
      throw new Error('fallback exploded');
    });

    try {
      const cards = harness.routesMod.__internal.safelyBuildRoutineRulesOnlyFallbackCardsForChat({
        ctx: buildCtx('fallback'),
        message: 'Build an AM/PM routine',
        profile: buildProfile(),
        recentLogs: [],
        language: 'EN',
        reason: 'default',
        logger,
        flow: 'test',
      });

      expect(cards).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      harness.routesMod.__internal.__resetBuildRoutineRulesOnlyFallbackCardsForChatForTest();
      harness.restore();
    }
  });
});

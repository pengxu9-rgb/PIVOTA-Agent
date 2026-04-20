const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('auroraGeminiGlobalClient exports callAuroraGeminiGenerateContentWithMeta with timing metadata', async () => {
  const clientModuleId = require.resolve('../src/auroraBff/auroraGeminiGlobalClient');
  const keyModuleId = require.resolve('../src/auroraBff/auroraGeminiKeys');
  const gateModuleId = require.resolve('../src/lib/geminiGlobalGate');
  const originalKeyModule = require.cache[keyModuleId];
  const originalGateModule = require.cache[gateModuleId];
  const originalClientModule = require.cache[clientModuleId];
  const originalLoad = Module._load;
  let generateCalls = 0;

  require.cache[keyModuleId] = {
    id: keyModuleId,
    filename: keyModuleId,
    loaded: true,
    exports: {
      resolveAuroraGeminiKey() {
        return 'test-gemini-key';
      },
    },
  };
  require.cache[gateModuleId] = {
    id: gateModuleId,
    filename: gateModuleId,
    loaded: true,
    exports: {
      getGeminiGlobalGate() {
        return {
          withGate: async (_route, fn) => fn(),
          getApiKey: () => 'test-gemini-key',
          snapshot: () => ({ gate: { keyCount: 1 } }),
        };
      },
    },
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@google/genai') {
      return {
        GoogleGenAI: class MockGoogleGenAI {
          constructor() {
            this.models = {
              generateContent: async (requestPayload) => {
                generateCalls += 1;
                return { ok: true, requestPayload };
              },
            };
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[clientModuleId];

  try {
    const geminiClient = require(clientModuleId);
    assert.equal(typeof geminiClient.callAuroraGeminiGenerateContentWithMeta, 'function');

    const result = await geminiClient.callAuroraGeminiGenerateContentWithMeta({
      featureEnvVar: 'AURORA_VISION_GEMINI_API_KEY',
      route: 'aurora_test_route',
      request: { model: 'gemini-test-model' },
    });

    assert.equal(generateCalls, 1);
    assert.equal(result.response.ok, true);
    assert.equal(typeof result.meta, 'object');
    assert.equal(typeof result.meta.total_ms, 'number');
    assert.equal(typeof result.meta.upstream_ms, 'number');
    assert.equal(typeof result.meta.gate_wait_ms, 'number');
  } finally {
    Module._load = originalLoad;
    if (originalKeyModule) require.cache[keyModuleId] = originalKeyModule;
    else delete require.cache[keyModuleId];
    if (originalGateModule) require.cache[gateModuleId] = originalGateModule;
    else delete require.cache[gateModuleId];
    if (originalClientModule) require.cache[clientModuleId] = originalClientModule;
    else delete require.cache[clientModuleId];
  }
});

test('auroraGeminiGlobalClient classifies gate stalls as queue timeouts when total timeout is exhausted', async () => {
  const clientModuleId = require.resolve('../src/auroraBff/auroraGeminiGlobalClient');
  const keyModuleId = require.resolve('../src/auroraBff/auroraGeminiKeys');
  const gateModuleId = require.resolve('../src/lib/geminiGlobalGate');
  const originalKeyModule = require.cache[keyModuleId];
  const originalGateModule = require.cache[gateModuleId];
  const originalClientModule = require.cache[clientModuleId];
  const originalLoad = Module._load;

  require.cache[keyModuleId] = {
    id: keyModuleId,
    filename: keyModuleId,
    loaded: true,
    exports: {
      resolveAuroraGeminiKey() {
        return 'test-gemini-key';
      },
    },
  };
  require.cache[gateModuleId] = {
    id: gateModuleId,
    filename: gateModuleId,
    loaded: true,
    exports: {
      getGeminiGlobalGate() {
        return {
          withGate: async () => await new Promise(() => {}),
          getApiKey: () => 'test-gemini-key',
          snapshot: () => ({ gate: { keyCount: 1 } }),
        };
      },
    },
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@google/genai') {
      return {
        GoogleGenAI: class MockGoogleGenAI {
          constructor() {
            this.models = {
              generateContent: async () => ({ ok: true }),
            };
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[clientModuleId];

  try {
    const geminiClient = require(clientModuleId);
    await assert.rejects(
      async () => {
        await geminiClient.callAuroraGeminiGenerateContentWithMeta({
          featureEnvVar: 'AURORA_VISION_GEMINI_API_KEY',
          route: 'aurora_test_queue_timeout',
          request: { model: 'gemini-test-model' },
          upstreamTimeoutMs: 25,
        });
      },
      (error) => {
        assert.equal(error?.code, 'GEMINI_QUEUE_TIMEOUT');
        assert.equal(error?.timeout_stage, 'queue');
        assert.equal(Number.isFinite(error?.meta?.total_ms), true);
        return true;
      },
    );
  } finally {
    Module._load = originalLoad;
    if (originalKeyModule) require.cache[keyModuleId] = originalKeyModule;
    else delete require.cache[keyModuleId];
    if (originalGateModule) require.cache[gateModuleId] = originalGateModule;
    else delete require.cache[gateModuleId];
    if (originalClientModule) require.cache[clientModuleId] = originalClientModule;
    else delete require.cache[clientModuleId];
  }
});

test('auroraGeminiGlobalClient passes upstream timeout to Gemini SDK http options', async () => {
  const clientModuleId = require.resolve('../src/auroraBff/auroraGeminiGlobalClient');
  const keyModuleId = require.resolve('../src/auroraBff/auroraGeminiKeys');
  const gateModuleId = require.resolve('../src/lib/geminiGlobalGate');
  const originalKeyModule = require.cache[keyModuleId];
  const originalGateModule = require.cache[gateModuleId];
  const originalClientModule = require.cache[clientModuleId];
  const originalLoad = Module._load;
  let capturedRequest = null;

  require.cache[keyModuleId] = {
    id: keyModuleId,
    filename: keyModuleId,
    loaded: true,
    exports: {
      resolveAuroraGeminiKey() {
        return 'test-gemini-key';
      },
    },
  };
  require.cache[gateModuleId] = {
    id: gateModuleId,
    filename: gateModuleId,
    loaded: true,
    exports: {
      getGeminiGlobalGate() {
        return {
          withGate: async (_route, fn) => fn(),
          getApiKey: () => 'test-gemini-key',
          snapshot: () => ({ gate: { keyCount: 1 } }),
        };
      },
    },
  };
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@google/genai') {
      return {
        GoogleGenAI: class MockGoogleGenAI {
          constructor() {
            this.models = {
              generateContent: async (requestPayload) => {
                capturedRequest = requestPayload;
                return { ok: true };
              },
            };
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[clientModuleId];

  try {
    const geminiClient = require(clientModuleId);

    await geminiClient.callAuroraGeminiGenerateContentWithMeta({
      featureEnvVar: 'AURORA_VISION_GEMINI_API_KEY',
      route: 'aurora_test_sdk_timeout',
      request: {
        model: 'gemini-test-model',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        config: {
          responseMimeType: 'application/json',
          httpOptions: {
            apiVersion: 'v1beta',
          },
        },
      },
      upstreamTimeoutMs: 25,
    });

    assert.equal(capturedRequest?.model, 'gemini-test-model');
    assert.equal(capturedRequest?.config?.responseMimeType, 'application/json');
    assert.equal(capturedRequest?.config?.httpOptions?.apiVersion, 'v1beta');
    assert.equal(capturedRequest?.config?.httpOptions?.timeout, 25);
  } finally {
    Module._load = originalLoad;
    if (originalKeyModule) require.cache[keyModuleId] = originalKeyModule;
    else delete require.cache[keyModuleId];
    if (originalGateModule) require.cache[gateModuleId] = originalGateModule;
    else delete require.cache[gateModuleId];
    if (originalClientModule) require.cache[clientModuleId] = originalClientModule;
    else delete require.cache[clientModuleId];
  }
});

test('auroraGeminiGlobalClient direct REST transport preserves JSON config and strips SDK httpOptions', async () => {
  const clientModuleId = require.resolve('../src/auroraBff/auroraGeminiGlobalClient');
  const keyModuleId = require.resolve('../src/auroraBff/auroraGeminiKeys');
  const gateModuleId = require.resolve('../src/lib/geminiGlobalGate');
  const originalKeyModule = require.cache[keyModuleId];
  const originalGateModule = require.cache[gateModuleId];
  const originalClientModule = require.cache[clientModuleId];
  const originalFetch = global.fetch;
  let capturedUrl = '';
  let capturedOptions = null;

  require.cache[keyModuleId] = {
    id: keyModuleId,
    filename: keyModuleId,
    loaded: true,
    exports: {
      resolveAuroraGeminiKey() {
        return 'test-gemini-key';
      },
    },
  };
  require.cache[gateModuleId] = {
    id: gateModuleId,
    filename: gateModuleId,
    loaded: true,
    exports: {
      getGeminiGlobalGate() {
        return {
          withGate: async (_route, fn) => fn(),
          getApiKey: () => 'test-gemini-key',
          snapshot: () => ({ gate: { keyCount: 1 } }),
        };
      },
    },
  };
  global.fetch = async (url, options) => {
    capturedUrl = String(url || '');
    capturedOptions = options || {};
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [{ text: '{"travel_readiness_patch":{"confidence":{"level":"high"}}}' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 12,
          totalTokenCount: 22,
        },
      }),
    };
  };

  delete require.cache[clientModuleId];

  try {
    const geminiClient = require(clientModuleId);

    const result = await geminiClient.callAuroraGeminiGenerateContentRestWithMeta({
      featureEnvVar: 'AURORA_TRAVEL_GEMINI_API_KEY',
      route: 'aurora_test_rest_transport',
      request: {
        model: 'models/gemini-3-flash-preview',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        config: {
          responseMimeType: 'application/json',
          maxOutputTokens: 1000,
          thinkingConfig: { includeThoughts: false, thinkingBudget: 64 },
          httpOptions: { timeout: 1 },
        },
      },
      upstreamTimeoutMs: 1000,
    });

    const body = JSON.parse(capturedOptions.body);
    assert.match(capturedUrl, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3-flash-preview:generateContent$/);
    assert.equal(capturedOptions.headers['x-goog-api-key'], 'test-gemini-key');
    assert.equal(capturedUrl.includes('test-gemini-key'), false);
    assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.maxOutputTokens, 1000);
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 64);
    assert.equal(body.generationConfig.httpOptions, undefined);
    assert.equal(result.response.candidates[0].finishReason, 'STOP');
    assert.equal(result.meta.transport, 'rest');
  } finally {
    global.fetch = originalFetch;
    if (originalKeyModule) require.cache[keyModuleId] = originalKeyModule;
    else delete require.cache[keyModuleId];
    if (originalGateModule) require.cache[gateModuleId] = originalGateModule;
    else delete require.cache[gateModuleId];
    if (originalClientModule) require.cache[clientModuleId] = originalClientModule;
    else delete require.cache[clientModuleId];
  }
});

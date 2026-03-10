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

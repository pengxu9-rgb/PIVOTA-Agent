const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

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

test('diagnosis v2 Gemini provider uses the temporary unified Gemini production model', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'test_gemini_key',
      DIAGNOSIS_V2_GEMINI_MODEL: 'gemini-2.0-flash',
      PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED: 'true',
      OPENAI_API_KEY: undefined,
    },
    async () => {
      const originalLoad = Module._load;
      let capturedModel = null;
      Module._load = function patched(request, parent, isMain) {
        if (request === '@google/genai') {
          return {
            GoogleGenAI: class FakeGoogleGenAI {
              constructor() {
                this.models = {
                  generateContent: async (args = {}) => {
                    capturedModel = args.model;
                    return { text: () => '{"ok":true}' };
                  },
                };
              }
            },
          };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      const moduleId = require.resolve('../src/auroraBff/diagnosisV2LlmProvider');
      delete require.cache[moduleId];
      try {
        const { createDiagnosisV2LlmProvider } = require('../src/auroraBff/diagnosisV2LlmProvider');
        const provider = createDiagnosisV2LlmProvider();
        const out = await provider.generate({ system: 'Return JSON only.', user: 'Test', maxTokens: 128 });
        assert.equal(out.provider, 'gemini');
        assert.equal(capturedModel, 'gemini-2.5-flash');
      } finally {
        delete require.cache[moduleId];
        Module._load = originalLoad;
      }
    },
  );
});

test('diagnosis v2 selects Gemini on Vertex with NO GEMINI_API_KEY', async () => {
  // The switch: on Vertex the credential is ADC, so provider selection must not
  // hinge on GEMINI_API_KEY. Old code gated hasGemini on the raw key and would
  // have dropped Gemini from the failover once the key is retired.
  await withEnv(
    {
      VERTEX_AI_ENABLED: 'true',
      GOOGLE_CLOUD_PROJECT: 'proj-vertex-test',
      GOOGLE_CLOUD_LOCATION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({
        type: 'service_account',
        project_id: 'proj-vertex-test',
      }),
      GEMINI_API_KEY: undefined,
      PIVOTA_GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    async () => {
      const originalLoad = Module._load;
      Module._load = function patched(request, parent, isMain) {
        if (request === '@google/genai') {
          return {
            GoogleGenAI: class FakeGoogleGenAI {
              constructor() {
                this.models = {
                  generateContent: async () => ({ text: () => '{"ok":true}' }),
                };
              }
            },
          };
        }
        return originalLoad.call(this, request, parent, isMain);
      };

      const moduleId = require.resolve('../src/auroraBff/diagnosisV2LlmProvider');
      delete require.cache[moduleId];
      try {
        const { createDiagnosisV2LlmProvider } = require('../src/auroraBff/diagnosisV2LlmProvider');
        const provider = createDiagnosisV2LlmProvider();
        const out = await provider.generate({ system: 'Return JSON only.', user: 'Test', maxTokens: 128 });
        assert.equal(out.provider, 'gemini');
      } finally {
        delete require.cache[moduleId];
        Module._load = originalLoad;
      }
    },
  );
});

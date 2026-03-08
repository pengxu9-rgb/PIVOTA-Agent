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

test('diagnosis v2 Gemini provider auto-upgrades legacy Gemini env to the 3.x floor', async () => {
  await withEnv(
    {
      GEMINI_API_KEY: 'test_gemini_key',
      DIAGNOSIS_V2_GEMINI_MODEL: 'gemini-2.0-flash',
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
        assert.equal(capturedModel, 'gemini-3-flash-preview');
      } finally {
        delete require.cache[moduleId];
        Module._load = originalLoad;
      }
    },
  );
});

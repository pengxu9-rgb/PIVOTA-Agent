const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(patch, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(patch || {})) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
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

test('Aurora chat v2 llm_gateway uses configured Gemini 3 model instead of legacy hardcoded Gemini 2', async () => {
  await withEnv(
    {
      PIVOTA_UI_CHAT_LLM_MODEL_GEMINI: 'gemini-3-flash-preview',
      AURORA_QA_MODEL_GEMINI: undefined,
      AURORA_ANALYSIS_STORY_MODEL_GEMINI: undefined,
      GEMINI_MODEL: undefined,
    },
    async () => {
      const moduleId = require.resolve('../src/auroraBff/services/llm_gateway');
      delete require.cache[moduleId];
      const LlmGateway = require(moduleId);
      const gateway = new LlmGateway({
        geminiGate: {
          getApiKey: () => 'test_key',
          withGate: async (_route, fn) => fn(),
        },
      });
      const originalFetch = global.fetch;
      let capturedUrl = null;
      global.fetch = async (url) => {
        capturedUrl = String(url || '');
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          }),
        };
      };
      try {
        const result = await gateway._callGemini([{ role: 'user', content: 'hello' }], { mode: 'structured' });
        assert.equal(result.text, '{"ok":true}');
        assert.match(String(capturedUrl || ''), /models\/gemini-3-flash-preview:generateContent/);
        assert.doesNotMatch(String(capturedUrl || ''), /gemini-2\.0-flash/);
      } finally {
        global.fetch = originalFetch;
        delete require.cache[moduleId];
      }
    },
  );
});

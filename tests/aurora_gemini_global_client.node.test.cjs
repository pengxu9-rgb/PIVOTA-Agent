const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch || {})) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
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

function loadHelperFresh() {
  const helperId = require.resolve('../src/auroraBff/auroraGeminiGlobalClient');
  const gateId = require.resolve('../src/lib/geminiGlobalGate');
  const keyId = require.resolve('../src/auroraBff/auroraGeminiKeys');
  delete require.cache[helperId];
  delete require.cache[gateId];
  delete require.cache[keyId];
  return require('../src/auroraBff/auroraGeminiGlobalClient');
}

test('auroraGeminiGlobalClient prefers pooled global gate keys', async () => {
  await withEnv(
    {
      GEMINI_API_KEY_1: 'pool_a',
      GEMINI_API_KEY_2: 'pool_b',
      AURORA_DIAG_GEMINI_API_KEY: 'feature_diag_key',
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    async () => {
      const helper = loadHelperFresh();
      assert.equal(helper.hasAuroraGeminiApiKey('AURORA_DIAG_GEMINI_API_KEY'), true);
      const first = helper.pickAuroraGeminiApiKey('AURORA_DIAG_GEMINI_API_KEY');
      const second = helper.pickAuroraGeminiApiKey('AURORA_DIAG_GEMINI_API_KEY');
      assert.equal(first, 'pool_a');
      assert.equal(second, 'pool_b');
    },
  );
});

test('auroraGeminiGlobalClient falls back to feature-specific key when pool is empty', async () => {
  await withEnv(
    {
      GEMINI_API_KEY_1: undefined,
      GEMINI_API_KEY_2: undefined,
      AURORA_RECO_GEMINI_API_KEY: 'feature_reco_key',
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    async () => {
      const helper = loadHelperFresh();
      assert.equal(helper.hasAuroraGeminiApiKey('AURORA_RECO_GEMINI_API_KEY'), true);
      assert.equal(helper.pickAuroraGeminiApiKey('AURORA_RECO_GEMINI_API_KEY'), 'feature_reco_key');
    },
  );
});

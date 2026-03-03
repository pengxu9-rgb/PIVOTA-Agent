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

function loadResolverFresh() {
  const moduleId = require.resolve('../src/auroraBff/auroraGeminiKeys');
  delete require.cache[moduleId];
  return require('../src/auroraBff/auroraGeminiKeys');
}

test('resolveAuroraGeminiKey: feature key wins over all fallbacks', async () => {
  await withEnv(
    {
      AURORA_DIAG_GEMINI_API_KEY: 'feature_diag_key',
      AURORA_SKIN_GEMINI_API_KEY: 'skin_key',
      GEMINI_API_KEY: 'gemini_key',
      GOOGLE_API_KEY: 'google_key',
    },
    async () => {
      const { resolveAuroraGeminiKey } = loadResolverFresh();
      const resolved = resolveAuroraGeminiKey('AURORA_DIAG_GEMINI_API_KEY');
      assert.equal(resolved, 'feature_diag_key');
    },
  );
});

test('resolveAuroraGeminiKey: falls back to AURORA_SKIN_GEMINI_API_KEY', async () => {
  await withEnv(
    {
      AURORA_DIAG_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: 'skin_key',
      GEMINI_API_KEY: 'gemini_key',
      GOOGLE_API_KEY: 'google_key',
    },
    async () => {
      const { resolveAuroraGeminiKey } = loadResolverFresh();
      const resolved = resolveAuroraGeminiKey('AURORA_DIAG_GEMINI_API_KEY');
      assert.equal(resolved, 'skin_key');
    },
  );
});

test('resolveAuroraGeminiKey: falls back to GEMINI_API_KEY then GOOGLE_API_KEY', async () => {
  await withEnv(
    {
      AURORA_RECO_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: 'gemini_key',
      GOOGLE_API_KEY: 'google_key',
    },
    async () => {
      const { resolveAuroraGeminiKey } = loadResolverFresh();
      const resolved = resolveAuroraGeminiKey('AURORA_RECO_GEMINI_API_KEY');
      assert.equal(resolved, 'gemini_key');
    },
  );

  await withEnv(
    {
      AURORA_RECO_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: 'google_key',
    },
    async () => {
      const { resolveAuroraGeminiKey } = loadResolverFresh();
      const resolved = resolveAuroraGeminiKey('AURORA_RECO_GEMINI_API_KEY');
      assert.equal(resolved, 'google_key');
    },
  );
});

test('resolveAuroraGeminiKey: trims values and returns empty string when unavailable', async () => {
  await withEnv(
    {
      AURORA_VISION_GEMINI_API_KEY: '   ',
      AURORA_SKIN_GEMINI_API_KEY: '   ',
      GEMINI_API_KEY: '   ',
      GOOGLE_API_KEY: '  google_trimmed  ',
    },
    async () => {
      const { resolveAuroraGeminiKey } = loadResolverFresh();
      const resolved = resolveAuroraGeminiKey('AURORA_VISION_GEMINI_API_KEY');
      assert.equal(resolved, 'google_trimmed');
    },
  );

  await withEnv(
    {
      AURORA_VISION_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    async () => {
      const { resolveAuroraGeminiKey } = loadResolverFresh();
      const resolved = resolveAuroraGeminiKey('AURORA_VISION_GEMINI_API_KEY');
      assert.equal(resolved, '');
    },
  );
});

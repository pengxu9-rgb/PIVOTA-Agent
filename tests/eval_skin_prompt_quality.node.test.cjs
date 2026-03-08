const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'eval_skin_prompt_quality.cjs');
const ROUTES_PATH = path.join(__dirname, '..', 'src', 'auroraBff', 'routes.js');
const GEMINI_CLIENT_PATH = path.join(__dirname, '..', 'src', 'auroraBff', 'auroraGeminiGlobalClient.js');

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides || {});
  const prev = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    if (overrides[key] == null) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (prev[key] == null) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function loadScriptWithEnv(overrides) {
  return withEnv(overrides, () => {
    delete require.cache[require.resolve(SCRIPT_PATH)];
    delete require.cache[require.resolve(ROUTES_PATH)];
    delete require.cache[require.resolve(GEMINI_CLIENT_PATH)];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(SCRIPT_PATH);
  });
}

test('eval skin prompt quality: dual judge provider selection ignores runtime force-gemini override', () => {
  const mod = loadScriptWithEnv({
    AURORA_DIAG_FORCE_GEMINI: 'true',
    OPENAI_API_KEY: 'test_openai_key',
    GEMINI_API_KEY: 'test_gemini_key',
  });
  assert.deepEqual(
    mod.pickJudgeProviders({
      mode: 'dual',
      singleProvider: 'gemini',
      availability: { gemini: true, openai: true },
    }),
    ['gemini', 'openai'],
  );
  assert.deepEqual(
    mod.pickJudgeProviders({
      mode: 'single',
      singleProvider: 'openai',
      availability: { gemini: true, openai: true },
    }),
    ['openai'],
  );
});

test('eval skin prompt quality: single judge can add fallback provider when enabled', () => {
  const mod = loadScriptWithEnv({
    AURORA_DIAG_FORCE_GEMINI: 'true',
  });
  assert.deepEqual(
    mod.pickJudgeProviders({
      mode: 'single',
      singleProvider: 'gemini',
      allowOpenAiFallback: true,
      availability: { gemini: true, openai: true },
    }),
    ['gemini', 'openai'],
  );
});

test('eval skin prompt quality: judge normalization preserves provider failure reason', () => {
  const mod = loadScriptWithEnv({});
  const normalized = mod.normalizeJudgeResult(
    {
      ok: false,
      reason: 'invalid_api_key',
      detail: '401 Incorrect API key provided',
    },
    'openai',
  );
  assert.equal(normalized.ok, false);
  assert.equal(normalized.provider, 'openai');
  assert.equal(normalized.failure_reason, 'invalid_api_key');
  assert.equal(normalized.failure_detail, '401 Incorrect API key provided');
  assert.match(String(normalized.weaknesses[0] || ''), /judge_failed:invalid_api_key/);
});

test('eval skin prompt quality: bucket summary counts secondary judge infrastructure failures', () => {
  const mod = loadScriptWithEnv({});
  const summary = mod.summarizeBuckets(
    [
      {
        stage: 'report',
        locale: 'zh-CN',
        case_id: 'case_1',
        repeat_index: 0,
        ok: true,
        useful_output: true,
        semantic_code: null,
        signature: 'sig',
      },
    ],
    [
      {
        stage: 'report',
        locale: 'zh-CN',
        judge_average_score: 9,
        judge_hard_fail: false,
        primary_judge: { ok: true, provider: 'gemini' },
        secondary_judge: { ok: false, provider: 'openai', failure_reason: 'invalid_api_key' },
      },
    ],
    { skipJudge: false },
  );
  assert.equal(summary.length, 1);
  assert.equal(summary[0].judge_failed_rate, 0);
  assert.equal(summary[0].shadow_failed_rate, 1);
});

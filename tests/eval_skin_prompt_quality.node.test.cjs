const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'eval_skin_prompt_quality.cjs');
const ROUTES_PATH = path.join(__dirname, '..', 'src', 'auroraBff', 'routes.js');
const GEMINI_CLIENT_PATH = path.join(__dirname, '..', 'src', 'auroraBff', 'auroraGeminiGlobalClient.js');
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'skin', 'skin_prompt_eval_cases.jsonl');

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

function readJsonl(filePath) {
  return String(fs.readFileSync(filePath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

test('eval skin prompt quality: parseArgs defaults to gemini-only judge mode', () => {
  const mod = loadScriptWithEnv({});
  const parsed = mod.parseArgs(['node', 'eval_skin_prompt_quality.cjs']);
  assert.equal(parsed.qaMode, 'single');
  assert.equal(parsed.singleProvider, 'gemini');
  assert.equal(parsed.allowOpenAiFallback, false);
  assert.equal(parsed.debugRawOutput, false);
  assert.equal(parsed.judgeMaxOutputTokens, 1800);
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

test('eval skin prompt quality: bucket summary keeps shadow failure separate from decision judge failure', () => {
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
        primary_judge: { provider: 'gemini', ok: true },
        secondary_judge: { provider: 'openai', ok: false, failure_reason: 'invalid_api_key' },
      },
    ],
    { skipJudge: false },
  );
  assert.equal(summary.length, 1);
  assert.equal(summary[0].judge_failed_rate, 0);
  assert.equal(summary[0].shadow_failed_rate, 1);
});

test('eval skin prompt quality: judge prompt omits raw model output unless debug flag is enabled', () => {
  const mod = loadScriptWithEnv({});
  const base = mod.buildJudgeUserPrompt({
    rubric: {
      version: 'v1',
      global_principles: ['grounded'],
      hard_fail_rules: ['fabricated_observation'],
      stage_rubrics: { report: { dimensions: ['cue_consistency'] } },
    },
    row: {
      case_id: 'report_case',
      stage: 'report',
      locale: 'en-US',
      expectations: { expected_priority: 'barrier' },
      judge_notes: '',
    },
    result: {
      ok: true,
      reason: null,
      canonical: {
        summary_focus: { priority: 'barrier' },
        insights: [{ cue: 'redness', region: 'cheeks', severity: 'moderate', evidence: 'Visible redness.' }],
        routine_steps: [{ time: 'am', step_type: 'cleanse', target: 'barrier', cadence: 'daily' }],
        follow_up: { intent: 'reaction_check' },
      },
      public_output: {
        strategy: 'Barrier support first.',
        primary_question: 'What reaction has been most noticeable?',
      },
      raw_response_text: '{"very":"long"}',
    },
    localChecks: [{ check: 'model_ok', ok: true, detail: 'ok' }],
    debugRawOutput: false,
  });
  assert.equal(base.includes('raw_model_output_digest'), false);

  const debug = mod.buildJudgeUserPrompt({
    rubric: {
      version: 'v1',
      global_principles: ['grounded'],
      hard_fail_rules: ['fabricated_observation'],
      stage_rubrics: { report: { dimensions: ['cue_consistency'] } },
    },
    row: {
      case_id: 'report_case',
      stage: 'report',
      locale: 'en-US',
      expectations: { expected_priority: 'barrier' },
      judge_notes: '',
    },
    result: {
      ok: true,
      reason: null,
      canonical: {
        summary_focus: { priority: 'barrier' },
        insights: [{ cue: 'redness', region: 'cheeks', severity: 'moderate', evidence: 'Visible redness.' }],
        routine_steps: [{ time: 'am', step_type: 'cleanse', target: 'barrier', cadence: 'daily' }],
        follow_up: { intent: 'reaction_check' },
      },
      public_output: {
        strategy: 'Barrier support first.',
        primary_question: 'What reaction has been most noticeable?',
      },
      raw_response_text: '{"very":"long"}',
    },
    localChecks: [{ check: 'model_ok', ok: true, detail: 'ok' }],
    debugRawOutput: true,
  });
  assert.equal(debug.includes('raw_model_output_digest'), true);
});

test('eval skin prompt quality: official acceptance fixture passes builder-only contract audit', () => {
  const mod = loadScriptWithEnv({});
  const rows = readJsonl(FIXTURE_PATH);
  assert.doesNotThrow(() => mod.auditAcceptanceCases(rows));
});

test('eval skin prompt quality: contract audit rejects legacy raw dto input for formal acceptance cases', () => {
  const mod = loadScriptWithEnv({});
  assert.throws(
    () => mod.auditAcceptanceCases([
      {
        case_id: 'legacy_report_case',
        stage: 'report',
        locale: 'en-US',
        input: {
          report_dto: { quality: { grade: 'pass' } },
        },
      },
    ]),
    /legacy acceptance input/,
  );
});

test('eval skin prompt quality: contract audit allows compatibility-only legacy dto coverage', () => {
  const mod = loadScriptWithEnv({});
  assert.doesNotThrow(() => mod.auditAcceptanceCases([
    {
      case_id: 'legacy_deepening_case',
      stage: 'deepening',
      locale: 'en-US',
      legacy_compat: true,
      input: {
        deepening_dto: { phase: 'products', question_intent: 'routine_share' },
      },
    },
  ]));
});

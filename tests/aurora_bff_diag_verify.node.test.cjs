const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function loadVerifyFresh() {
  const resolved = require.resolve('../src/auroraBff/diagVerify');
  delete require.cache[resolved];
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require('../src/auroraBff/diagVerify');
  if (typeof mod.resetVerifyBudgetGuardState === 'function') mod.resetVerifyBudgetGuardState();
  return mod;
}

async function withEnv(patch, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(patch || {})) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makeTempStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_diag_verify_'));
  return {
    root,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function makeConcern(type, bbox, severity, confidence, sourceModel) {
  return {
    type,
    regions: [{ kind: 'bbox', bbox_norm: bbox }],
    severity,
    confidence,
    evidence_text: `${type} evidence`,
    quality_sensitivity: 'medium',
    source_model: sourceModel,
    provenance: { provider: sourceModel },
  };
}

test('diag verify: disabled flag skips verifier and does not call providers', async () => {
  await withEnv(
    {
      DIAG_GEMINI_VERIFY: 'false',
    },
    async () => {
      const { runGeminiShadowVerify } = loadVerifyFresh();
      let cvCalls = 0;
      let geminiCalls = 0;

      const out = await runGeminiShadowVerify({
        imageBuffer: Buffer.from([1, 2, 3]),
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        providerOverrides: {
          cvProvider: async () => {
            cvCalls += 1;
            return { ok: true, provider: 'cv_provider', concerns: [] };
          },
          geminiProvider: async () => {
            geminiCalls += 1;
            return { ok: true, provider: 'gemini_provider', concerns: [] };
          },
        },
      });

      assert.equal(out.enabled, false);
      assert.equal(out.called, false);
      assert.equal(out.skipped_reason, 'DISABLED_BY_FLAG');
      assert.equal(cvCalls, 0);
      assert.equal(geminiCalls, 0);
    },
  );
});

test('diag verify: enabled writes model outputs and yields agreement score', async () => {
  const store = await makeTempStore();
  try {
    await withEnv(
      {
        DIAG_GEMINI_VERIFY: 'true',
        AURORA_PSEUDO_LABEL_ENABLED: 'true',
        AURORA_PSEUDO_LABEL_DIR: store.root,
        DIAG_GEMINI_VERIFY_HARD_CASE_PATH: path.join(store.root, 'hard_cases.ndjson'),
      },
      async () => {
        const { runGeminiShadowVerify } = loadVerifyFresh();
        const counters = {
          verifyAttempt: 0,
          verifyOk: 0,
          verifyFail: 0,
          agreement: [],
        };

        const out = await runGeminiShadowVerify({
          imageBuffer: Buffer.from([1, 2, 3, 4]),
          usedPhotos: true,
          photoQuality: { grade: 'pass', reasons: [] },
          inferenceId: 'verify_inf_1',
          providerOverrides: {
            cvProvider: async () => ({
              ok: true,
              provider: 'cv_provider',
              model_name: 'cv_ruleset',
              model_version: 'v1',
              concerns: [
                makeConcern('redness', { x0: 0.2, y0: 0.2, x1: 0.45, y1: 0.45 }, 2, 0.76, 'cv_provider'),
              ],
              latency_ms: 12,
            }),
            geminiProvider: async () => ({
              ok: true,
              provider: 'gemini_provider',
              model_name: 'gemini-test',
              model_version: 'v1',
              concerns: [
                makeConcern('redness', { x0: 0.22, y0: 0.22, x1: 0.46, y1: 0.46 }, 2.2, 0.81, 'gemini_provider'),
              ],
              flags: [],
              latency_ms: 18,
              attempts: 1,
              provider_status_code: 200,
            }),
          },
          metricsHooks: {
            onVerifyCall: ({ status }) => {
              if (status === 'attempt') counters.verifyAttempt += 1;
              if (status === 'ok') counters.verifyOk += 1;
            },
            onVerifyFail: () => {
              counters.verifyFail += 1;
            },
            onVerifyAgreement: (score) => {
              counters.agreement.push(score);
            },
          },
        });

        assert.equal(out.called, true);
        assert.equal(out.ok, true);
        assert.equal(out.agreement_score >= 0.7, true);
        assert.equal(out.hard_case_written, false);
        assert.equal(out.persistence && out.persistence.model_outputs_written >= 2, true);
        assert.equal(out.provider_status_code, 200);
        assert.equal(typeof out.latency_ms, 'number');
        assert.equal(out.attempts, 1);
        assert.equal(out.final_reason, 'OK');
        assert.equal(counters.verifyAttempt, 1);
        assert.equal(counters.verifyOk, 1);
        assert.equal(counters.verifyFail, 0);
        assert.equal(counters.agreement.length, 1);
        assert.equal(Array.isArray(out.provider_stats), true);
        assert.equal(out.provider_stats.length, 2);
        assert.equal(Number.isFinite(out.provider_stats[0].provider_status_code), true);
        assert.equal(Number.isFinite(out.provider_stats[1].provider_status_code), true);
        assert.equal(Number.isFinite(out.provider_stats[0].attempts), true);
        assert.equal(Number.isFinite(out.provider_stats[1].attempts), true);
        assert.equal(typeof out.provider_stats[0].final_reason, 'string');
        assert.equal(typeof out.provider_stats[1].final_reason, 'string');

        const modelOutputsPath = path.join(store.root, 'model_outputs.ndjson');
        const raw = await fs.readFile(modelOutputsPath, 'utf8');
        const rows = raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.equal(rows.length >= 2, true);
        const providers = new Set(rows.map((row) => row.provider));
        assert.equal(providers.has('cv_provider'), true);
        assert.equal(providers.has('gemini_provider'), true);
      },
    );
  } finally {
    await store.cleanup();
  }
});

test('diag verify: used_photos=false does not call gemini verifier', async () => {
  await withEnv(
    {
      DIAG_GEMINI_VERIFY: 'true',
    },
    async () => {
      const { runGeminiShadowVerify } = loadVerifyFresh();
      let cvCalls = 0;
      let geminiCalls = 0;

      const out = await runGeminiShadowVerify({
        imageBuffer: Buffer.from([1, 2, 3]),
        usedPhotos: false,
        photoQuality: { grade: 'pass', reasons: [] },
        providerOverrides: {
          cvProvider: async () => {
            cvCalls += 1;
            return { ok: true, provider: 'cv_provider', concerns: [] };
          },
          geminiProvider: async () => {
            geminiCalls += 1;
            return { ok: true, provider: 'gemini_provider', concerns: [] };
          },
        },
      });

      assert.equal(out.enabled, true);
      assert.equal(out.called, false);
      assert.equal(out.skipped_reason, 'PHOTO_NOT_USED');
      assert.equal(cvCalls, 0);
      assert.equal(geminiCalls, 0);
    },
  );
});

test('diag verify: budget guard skips verify calls and emits guard reason', async () => {
  await withEnv(
    {
      DIAG_GEMINI_VERIFY: 'true',
      DIAG_VERIFY_MAX_CALLS_PER_MIN: '1',
      DIAG_VERIFY_MAX_CALLS_PER_DAY: '1',
    },
    async () => {
      const { runGeminiShadowVerify, VERIFY_GUARD_REASON } = loadVerifyFresh();
      let cvCalls = 0;
      let geminiCalls = 0;
      const metricEvents = [];

      const providerOverrides = {
        cvProvider: async () => {
          cvCalls += 1;
          return {
            ok: true,
            provider: 'cv_provider',
            concerns: [makeConcern('redness', { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, 1, 0.7, 'cv_provider')],
            latency_ms: 5,
            attempts: 1,
            provider_status_code: 200,
          };
        },
        geminiProvider: async () => {
          geminiCalls += 1;
          return {
            ok: true,
            provider: 'gemini_provider',
            concerns: [makeConcern('redness', { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, 1, 0.8, 'gemini_provider')],
            latency_ms: 7,
            attempts: 1,
            provider_status_code: 200,
          };
        },
      };

      const commonInput = {
        imageBuffer: Buffer.from([1, 2, 3]),
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        providerOverrides,
        metricsHooks: {
          onVerifyCall: ({ status }) => metricEvents.push(['call', status]),
          onVerifyFail: ({ reason }) => metricEvents.push(['fail', reason]),
          onVerifyBudgetGuard: ({ reason }) => metricEvents.push(['guard', reason]),
        },
      };

      const first = await runGeminiShadowVerify(commonInput);
      const second = await runGeminiShadowVerify(commonInput);

      assert.equal(first.called, true);
      assert.equal(first.ok, true);
      assert.equal(second.called, false);
      assert.equal(second.decision, 'skip');
      assert.equal(second.skipped_reason, VERIFY_GUARD_REASON);
      assert.equal(second.final_reason, VERIFY_GUARD_REASON);
      assert.equal(second.provider_status_code, 0);
      assert.equal(cvCalls, 1);
      assert.equal(geminiCalls, 1);

      const guardCall = metricEvents.find((entry) => entry[0] === 'call' && entry[1] === 'guard');
      const guardMetric = metricEvents.find((entry) => entry[0] === 'guard' && entry[1] === VERIFY_GUARD_REASON);
      assert.equal(Boolean(guardCall), true);
      assert.equal(Boolean(guardMetric), true);
    },
  );
});

test('diag verify: failure path exposes provider status/latency/attempts/final reason', async () => {
  await withEnv(
    {
      DIAG_GEMINI_VERIFY: 'true',
    },
    async () => {
      const { runGeminiShadowVerify } = loadVerifyFresh();
      const failEvents = [];

      const out = await runGeminiShadowVerify({
        imageBuffer: Buffer.from([1, 2, 3]),
        usedPhotos: true,
        photoQuality: { grade: 'pass', reasons: [] },
        providerOverrides: {
          cvProvider: async () => ({
            ok: true,
            provider: 'cv_provider',
            concerns: [],
            latency_ms: 6,
            attempts: 1,
            provider_status_code: 200,
          }),
          geminiProvider: async () => ({
            ok: false,
            provider: 'gemini_provider',
            concerns: [],
            failure_reason: 'REQUEST_FAILED',
            latency_ms: 34,
            attempts: 2,
            provider_status_code: 503,
          }),
        },
        metricsHooks: {
          onVerifyFail: ({ reason }) => failEvents.push(reason),
        },
      });

      assert.equal(out.called, true);
      assert.equal(out.ok, false);
      assert.equal(out.provider_status_code, 503);
      assert.equal(out.attempts, 2);
      assert.equal(out.final_reason, 'UPSTREAM_5XX');
      assert.equal(out.raw_final_reason, 'REQUEST_FAILED');
      assert.equal(out.verify_fail_reason, 'UPSTREAM_5XX');
      assert.equal(out.decision, 'verify');
      assert.equal(typeof out.latency_ms, 'number');
      assert.equal(out.latency_ms >= 0, true);
      assert.equal(failEvents.includes('UPSTREAM_5XX'), true);
    },
  );
});

test('diag verify: maps provider failures into canonical verify fail reasons', async () => {
  await withEnv(
    {
      DIAG_GEMINI_VERIFY: 'true',
    },
    async () => {
      const { runGeminiShadowVerify } = loadVerifyFresh();
      const cases = [
        { reason: 'VERIFY_TIMEOUT', statusCode: 504, expected: 'TIMEOUT' },
        { reason: 'QUOTA_EXCEEDED', statusCode: 402, expected: 'QUOTA' },
        { reason: 'SCHEMA_INVALID', statusCode: 200, expected: 'SCHEMA_INVALID' },
        { reason: 'MISSING_IMAGE', statusCode: 400, expected: 'IMAGE_FETCH_FAILED' },
      ];

      for (const item of cases) {
        const out = await runGeminiShadowVerify({
          imageBuffer: Buffer.from([1, 2, 3]),
          usedPhotos: true,
          photoQuality: { grade: 'pass', reasons: [] },
          providerOverrides: {
            cvProvider: async () => ({
              ok: true,
              provider: 'cv_provider',
              concerns: [],
              latency_ms: 3,
              attempts: 1,
              provider_status_code: 200,
            }),
            geminiProvider: async () => ({
              ok: false,
              provider: 'gemini_provider',
              concerns: [],
              failure_reason: item.reason,
              latency_ms: 11,
              attempts: 1,
              provider_status_code: item.statusCode,
            }),
          },
        });
        assert.equal(out.verify_fail_reason, item.expected);
        assert.equal(out.final_reason, item.expected);
      }
    },
  );
});

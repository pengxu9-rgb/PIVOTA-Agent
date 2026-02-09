const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function loadVerifyFresh() {
  const resolved = require.resolve('../src/auroraBff/diagVerify');
  delete require.cache[resolved];
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require('../src/auroraBff/diagVerify');
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
        assert.equal(counters.verifyAttempt, 1);
        assert.equal(counters.verifyOk, 1);
        assert.equal(counters.verifyFail, 0);
        assert.equal(counters.agreement.length, 1);

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

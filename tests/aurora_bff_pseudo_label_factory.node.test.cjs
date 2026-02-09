const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function loadFactoryFresh() {
  const resolved = require.resolve('../src/auroraBff/pseudoLabelFactory');
  delete require.cache[resolved];
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require('../src/auroraBff/pseudoLabelFactory');
}

async function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch || {})) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makeTempStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_pseudo_factory_'));
  return {
    root,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function makeConcern({ type, bbox, severity, confidence, evidence }) {
  return {
    type,
    regions: [{ kind: 'bbox', bbox_norm: bbox }],
    severity,
    confidence,
    evidence_text: evidence,
    quality_sensitivity: 'medium',
    source_model: 'unit_test',
    provenance: { source_ids: ['unit:1'] },
  };
}

function makeOutput(provider, concern, modelName = 'unit-model') {
  return {
    ok: true,
    provider,
    model_name: modelName,
    model_version: 'test-v1',
    concerns: [concern],
    latency_ms: 5,
  };
}

test('store config agreement threshold honors new env key with legacy fallback', async () => {
  await withEnv(
    {
      AURORA_PSEUDO_LABEL_MIN_AGREEMENT: undefined,
      AURORA_PSEUDO_LABEL_AGREEMENT_THRESHOLD: undefined,
    },
    async () => {
      const { getStoreConfig, DEFAULT_AGREEMENT_THRESHOLD } = loadFactoryFresh();
      const cfg = getStoreConfig();
      assert.equal(cfg.agreementThreshold, DEFAULT_AGREEMENT_THRESHOLD);
      assert.equal(cfg.agreementThreshold, 0.75);
    },
  );

  await withEnv(
    {
      AURORA_PSEUDO_LABEL_MIN_AGREEMENT: undefined,
      AURORA_PSEUDO_LABEL_AGREEMENT_THRESHOLD: '0.61',
    },
    async () => {
      const { getStoreConfig } = loadFactoryFresh();
      const cfg = getStoreConfig();
      assert.equal(cfg.agreementThreshold, 0.61);
    },
  );

  await withEnv(
    {
      AURORA_PSEUDO_LABEL_MIN_AGREEMENT: '0.82',
      AURORA_PSEUDO_LABEL_AGREEMENT_THRESHOLD: '0.61',
    },
    async () => {
      const { getStoreConfig } = loadFactoryFresh();
      const cfg = getStoreConfig();
      assert.equal(cfg.agreementThreshold, 0.82);
    },
  );
});

test('agreement metrics: type/region/severity behave as expected', () => {
  const { computeAgreementForPair } = loadFactoryFresh();
  const left = makeOutput(
    'gemini_provider',
    makeConcern({
      type: 'acne',
      bbox: { x0: 0.2, y0: 0.2, x1: 0.45, y1: 0.45 },
      severity: 2,
      confidence: 0.8,
      evidence: 'left',
    }),
  );
  const right = makeOutput(
    'gpt_provider',
    makeConcern({
      type: 'acne',
      bbox: { x0: 0.22, y0: 0.22, x1: 0.46, y1: 0.46 },
      severity: 2.2,
      confidence: 0.75,
      evidence: 'right',
    }),
  );
  const agreement = computeAgreementForPair({ leftOutput: left, rightOutput: right });
  assert.equal(agreement.type_level.jaccard, 1);
  assert.equal(agreement.type_level.weighted_f1 > 0.95, true);
  assert.equal(agreement.region_level.mean_iou > 0.7, true);
  assert.equal(agreement.severity_level.mae < 0.3, true);
  assert.equal(agreement.overall > 0.7, true);
});

test('pseudo-label trigger rules: emit only on type+iou match and quality allowed', () => {
  const { generatePseudoLabelsForPair } = loadFactoryFresh();
  const gemini = makeOutput(
    'gemini_provider',
    makeConcern({
      type: 'acne',
      bbox: { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 },
      severity: 2,
      confidence: 0.8,
      evidence: 'left',
    }),
  );

  const gptFar = makeOutput(
    'gpt_provider',
    makeConcern({
      type: 'acne',
      bbox: { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 },
      severity: 2,
      confidence: 0.8,
      evidence: 'right',
    }),
  );
  const noMatch = generatePseudoLabelsForPair({
    geminiOutput: gemini,
    gptOutput: gptFar,
    qualityGrade: 'pass',
    regionIouThreshold: 0.3,
  });
  assert.equal(noMatch.quality_eligible, true);
  assert.equal(noMatch.matches.length, 0);
  assert.equal(noMatch.concerns.length, 0);

  const gptNear = makeOutput(
    'gpt_provider',
    makeConcern({
      type: 'acne',
      bbox: { x0: 0.12, y0: 0.12, x1: 0.31, y1: 0.31 },
      severity: 2.5,
      confidence: 0.7,
      evidence: 'right',
    }),
  );
  const matched = generatePseudoLabelsForPair({
    geminiOutput: gemini,
    gptOutput: gptNear,
    qualityGrade: 'degraded',
    regionIouThreshold: 0.3,
  });
  assert.equal(matched.quality_eligible, true);
  assert.equal(matched.matches.length, 1);
  assert.equal(matched.concerns.length, 1);
  assert.equal(matched.concerns[0].type, 'acne');
});

test('persistPseudoLabelArtifacts writes model outputs and gated pseudo labels', async () => {
  const store = await makeTempStore();
  try {
    await withEnv(
      {
        AURORA_PSEUDO_LABEL_ENABLED: 'true',
        AURORA_PSEUDO_LABEL_DIR: store.root,
        AURORA_PSEUDO_LABEL_REGION_IOU_THRESHOLD: '0.3',
        AURORA_PSEUDO_LABEL_MIN_AGREEMENT: '0.55',
        AURORA_PSEUDO_LABEL_ALLOW_ROI: 'false',
      },
      async () => {
        const { persistPseudoLabelArtifacts, readNdjsonFile, getStorePaths, getStoreConfig } = loadFactoryFresh();

        const sample1 = {
          inferenceId: 'inf_1',
          qualityGrade: 'pass',
          providerOutputs: [
            makeOutput(
              'gemini_provider',
              makeConcern({
                type: 'acne',
                bbox: { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.4 },
                severity: 2,
                confidence: 0.8,
                evidence: 'g acne',
              }),
              'gemini-test',
            ),
            makeOutput(
              'gpt_provider',
              makeConcern({
                type: 'acne',
                bbox: { x0: 0.21, y0: 0.21, x1: 0.41, y1: 0.41 },
                severity: 2.2,
                confidence: 0.78,
                evidence: 'gpt acne',
              }),
              'gpt-test',
            ),
          ],
          skinToneBucket: 'medium',
          lightingBucket: 'daylight',
        };

        const sample2 = {
          inferenceId: 'inf_2',
          qualityGrade: 'pass',
          providerOutputs: [
            makeOutput(
              'gemini_provider',
              makeConcern({
                type: 'acne',
                bbox: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 },
                severity: 2,
                confidence: 0.8,
                evidence: 'g acne far',
              }),
              'gemini-test',
            ),
            makeOutput(
              'gpt_provider',
              makeConcern({
                type: 'acne',
                bbox: { x0: 0.7, y0: 0.7, x1: 0.9, y1: 0.9 },
                severity: 2,
                confidence: 0.8,
                evidence: 'gpt acne far',
              }),
              'gpt-test',
            ),
          ],
          skinToneBucket: 'medium',
          lightingBucket: 'indoor',
        };

        const sample3 = {
          inferenceId: 'inf_3',
          qualityGrade: 'fail',
          providerOutputs: [
            makeOutput(
              'gemini_provider',
              makeConcern({
                type: 'redness',
                bbox: { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.4 },
                severity: 2,
                confidence: 0.9,
                evidence: 'g red',
              }),
              'gemini-test',
            ),
            makeOutput(
              'gpt_provider',
              makeConcern({
                type: 'redness',
                bbox: { x0: 0.22, y0: 0.22, x1: 0.42, y1: 0.42 },
                severity: 2.1,
                confidence: 0.85,
                evidence: 'gpt red',
              }),
              'gpt-test',
            ),
          ],
          skinToneBucket: 'deep',
          lightingBucket: 'low_light',
        };

        const out1 = await persistPseudoLabelArtifacts(sample1);
        assert.equal(out1.ok, true);
        assert.equal(out1.pseudo_label_written, true);

        const out2 = await persistPseudoLabelArtifacts(sample2);
        assert.equal(out2.ok, true);
        assert.equal(out2.pseudo_label_written, false);

        const out3 = await persistPseudoLabelArtifacts(sample3);
        assert.equal(out3.ok, true);
        assert.equal(out3.pseudo_label_written, false);

        const paths = getStorePaths(getStoreConfig());
        const modelOutputs = await readNdjsonFile(paths.modelOutputs);
        const pseudoLabels = await readNdjsonFile(paths.pseudoLabels);
        const agreementSamples = await readNdjsonFile(paths.agreementSamples);

        assert.equal(modelOutputs.length, 6);
        assert.equal(pseudoLabels.length, 1);
        assert.equal(agreementSamples.length, 3);

        const firstConcern = modelOutputs[0]?.output_json?.concerns?.[0] || {};
        assert.equal(Object.prototype.hasOwnProperty.call(firstConcern, 'regions'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(firstConcern, 'region_hint_bbox'), true);

        const emittedCount = agreementSamples.filter((row) => row && row.pseudo_label_emitted === true).length;
        assert.equal(emittedCount, 1);
      },
    );
  } finally {
    await store.cleanup();
  }
});

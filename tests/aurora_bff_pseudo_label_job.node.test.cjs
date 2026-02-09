const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { runPseudoLabelJob } = require('../scripts/run_pseudo_label_job');

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeStoredConcern({ type = 'acne', x0 = 0.1, y0 = 0.1, x1 = 0.3, y1 = 0.3 }) {
  return {
    type,
    severity: 2,
    confidence: 0.8,
    evidence_text: `${type} evidence`,
    quality_sensitivity: 'medium',
    source_model: 'unit-test',
    region_hint_bbox: { x0, y0, x1, y1 },
  };
}

function makeModelOutput({
  inferenceId,
  provider,
  createdAt = '2026-02-09T01:00:00.000Z',
  quality = 'pass',
  tone = 'medium',
  lighting = 'daylight',
  concerns = [],
  ok = true,
}) {
  return {
    schema_version: 'aurora.diag.model_output.v1',
    record_id: `mo_${inferenceId}_${provider}`,
    inference_id: inferenceId,
    created_at: createdAt,
    provider,
    model_name: `${provider}_model`,
    model_version: 'v1',
    quality_grade: quality,
    skin_tone_bucket: tone,
    lighting_bucket: lighting,
    device_class: 'mobile',
    output_json: {
      ok,
      concerns,
      flags: [],
      review: null,
      failure_reason: ok ? null : 'REQUEST_FAILED',
      schema_failed: false,
    },
    derived_features: {
      concern_count: concerns.length,
      concern_types: concerns.map((item) => item.type),
      confidence_mean: concerns.length ? 0.8 : 0,
      severity_mean: concerns.length ? 2 : 0,
    },
  };
}

function makeAgreementSample({
  inferenceId,
  overall,
  createdAt = '2026-02-09T01:00:00.000Z',
  quality = 'pass',
  tone = 'medium',
  lighting = 'daylight',
  issueType = 'acne',
}) {
  return {
    schema_version: 'aurora.diag.agreement_sample.v1',
    sample_id: `as_${inferenceId}`,
    inference_id: inferenceId,
    created_at: createdAt,
    quality_grade: quality,
    skin_tone_bucket: tone,
    lighting_bucket: lighting,
    metrics: {
      overall,
      by_type: [
        {
          type: issueType,
          iou: overall,
          severity_mae: 0.1,
          interval_overlap: 0.8,
        },
      ],
    },
    pseudo_label_eligible: true,
    pseudo_label_emitted: false,
  };
}

async function writeNdjson(filePath, rows) {
  const payload = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await fs.writeFile(filePath, payload, 'utf8');
}

async function readNdjson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('pseudo-label job threshold changes pseudo-label emission volume', async () => {
  const root = await makeTempDir('aurora_pseudo_job_');
  try {
    const store = path.join(root, 'store');
    await fs.mkdir(store, { recursive: true });
    const modelOutputsPath = path.join(store, 'model_outputs.ndjson');
    const agreementPath = path.join(store, 'agreement_samples.ndjson');

    const modelRows = [
      makeModelOutput({
        inferenceId: 'inf_hi',
        provider: 'gemini_provider',
        concerns: [makeStoredConcern({ type: 'acne', x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3 })],
      }),
      makeModelOutput({
        inferenceId: 'inf_hi',
        provider: 'gpt_provider',
        concerns: [makeStoredConcern({ type: 'acne', x0: 0.12, y0: 0.12, x1: 0.31, y1: 0.31 })],
      }),
      makeModelOutput({
        inferenceId: 'inf_mid',
        provider: 'gemini_provider',
        concerns: [makeStoredConcern({ type: 'redness', x0: 0.2, y0: 0.2, x1: 0.42, y1: 0.42 })],
      }),
      makeModelOutput({
        inferenceId: 'inf_mid',
        provider: 'gpt_provider',
        concerns: [makeStoredConcern({ type: 'redness', x0: 0.21, y0: 0.21, x1: 0.41, y1: 0.41 })],
      }),
    ];
    const agreementRows = [
      makeAgreementSample({ inferenceId: 'inf_hi', overall: 0.92, issueType: 'acne' }),
      makeAgreementSample({ inferenceId: 'inf_mid', overall: 0.62, issueType: 'redness' }),
    ];
    await writeNdjson(modelOutputsPath, modelRows);
    await writeNdjson(agreementPath, agreementRows);

    const outStrict = path.join(root, 'out_strict');
    const strictSummary = await runPseudoLabelJob({
      storeDir: store,
      outDir: outStrict,
      date: '2026-02-09',
      minAgreement: '0.75',
    });
    const strictPseudo = await readNdjson(strictSummary.outputs.pseudo_labels_daily);
    assert.equal(strictPseudo.length, 1);

    const outLoose = path.join(root, 'out_loose');
    const looseSummary = await runPseudoLabelJob({
      storeDir: store,
      outDir: outLoose,
      date: '2026-02-09',
      minAgreement: '0.55',
    });
    const loosePseudo = await readNdjson(looseSummary.outputs.pseudo_labels_daily);
    assert.equal(loosePseudo.length, 2);
    assert.equal(looseSummary.counters.pseudo_labels_written > strictSummary.counters.pseudo_labels_written, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pseudo-label job excludes fail quality from pseudo labels and writes hard-case reason', async () => {
  const root = await makeTempDir('aurora_pseudo_job_fail_');
  try {
    const store = path.join(root, 'store');
    await fs.mkdir(store, { recursive: true });
    await writeNdjson(path.join(store, 'model_outputs.ndjson'), [
      makeModelOutput({
        inferenceId: 'inf_fail',
        provider: 'gemini_provider',
        quality: 'fail',
        concerns: [makeStoredConcern({ type: 'texture', x0: 0.2, y0: 0.2, x1: 0.45, y1: 0.45 })],
      }),
      makeModelOutput({
        inferenceId: 'inf_fail',
        provider: 'gpt_provider',
        quality: 'fail',
        concerns: [makeStoredConcern({ type: 'texture', x0: 0.21, y0: 0.21, x1: 0.44, y1: 0.44 })],
      }),
    ]);
    await writeNdjson(path.join(store, 'agreement_samples.ndjson'), [
      makeAgreementSample({
        inferenceId: 'inf_fail',
        quality: 'fail',
        overall: 0.95,
        issueType: 'texture',
      }),
    ]);

    const summary = await runPseudoLabelJob({
      storeDir: store,
      outDir: path.join(root, 'out'),
      date: '2026-02-09',
      minAgreement: '0.75',
    });
    const pseudoRows = await readNdjson(summary.outputs.pseudo_labels_daily);
    const hardRows = await readNdjson(summary.outputs.hard_cases_daily);

    assert.equal(pseudoRows.length, 0);
    assert.equal(hardRows.length, 1);
    assert.equal(hardRows[0].disagreement_reason, 'QUALITY_NOT_ELIGIBLE');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

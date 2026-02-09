const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  buildReliabilityTable,
  should_use_verifier_in_vote,
} = require('../src/auroraBff/diagReliability');

const runExecFile = promisify(execFile);

function modelOutputRow({
  inferenceId,
  createdAt,
  quality = 'pass',
  tone = 'light',
  lighting = 'daylight',
  ok = true,
  decision = 'verify',
  failReason = null,
  latencyMs = 0,
}) {
  return {
    schema_version: 'aurora.diag.model_output.v1',
    record_id: `mo_${inferenceId}`,
    inference_id: inferenceId,
    created_at: createdAt,
    provider: 'gemini_provider',
    model_name: 'gemini-test',
    model_version: 'v1',
    quality_grade: quality,
    skin_tone_bucket: tone,
    lighting_bucket: lighting,
    output_json: {
      ok,
      decision,
      concerns: [],
      failure_reason: failReason,
      final_reason: failReason,
      verify_fail_reason: failReason,
      schema_failed: false,
      latency_ms: latencyMs,
      attempts: 1,
      provider_status_code: ok ? 200 : 504,
    },
  };
}

function agreementRow({ inferenceId, createdAt, overall, issueType = 'acne', quality = 'pass', tone = 'light', lighting = 'daylight' }) {
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
      by_type: [{ type: issueType }],
    },
  };
}

function goldRow({ inferenceId, createdAt, issueType = 'acne', quality = 'pass', tone = 'light', lighting = 'daylight' }) {
  return {
    schema_version: 'aurora.diag.gold_label.v1',
    inference_id: inferenceId,
    created_at: createdAt,
    quality_grade: quality,
    skin_tone_bucket: tone,
    lighting_bucket: lighting,
    concerns: [{ type: issueType, regions: [] }],
  };
}

async function writeNdjson(filePath, rows) {
  const payload = rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  await fs.writeFile(filePath, payload, 'utf8');
}

test('reliability table computes bucket metrics and gate decision', async () => {
  const modelOutputs = [
    modelOutputRow({
      inferenceId: 'inf1',
      createdAt: '2026-02-09T01:00:00.000Z',
      ok: true,
      latencyMs: 120,
    }),
    modelOutputRow({
      inferenceId: 'inf2',
      createdAt: '2026-02-09T01:10:00.000Z',
      ok: false,
      failReason: 'TIMEOUT',
      latencyMs: 200,
    }),
  ];
  const agreementSamples = [
    agreementRow({ inferenceId: 'inf1', createdAt: '2026-02-09T01:00:01.000Z', overall: 0.85 }),
    agreementRow({ inferenceId: 'inf2', createdAt: '2026-02-09T01:10:01.000Z', overall: 0.88 }),
    agreementRow({ inferenceId: 'inf3', createdAt: '2026-02-09T01:20:01.000Z', overall: 0.82 }),
  ];
  const goldLabels = [
    goldRow({ inferenceId: 'inf1', createdAt: '2026-02-09T02:00:00.000Z' }),
    goldRow({ inferenceId: 'inf2', createdAt: '2026-02-09T02:10:00.000Z' }),
  ];

  const table = buildReliabilityTable({
    modelOutputs,
    agreementSamples,
    goldLabels,
    datePrefix: '2026-02-09',
    gateConfig: {
      voteEnabled: true,
      maxFailRate: 0.6,
      minAgreement: 0.8,
      minAgreementSamples: 3,
      maxAgreementStddev: 0.2,
      minGoldSamples: 2,
    },
  });

  const bucket = table.buckets.find((item) => item.bucket_key === 'acne|pass|daylight|light');
  assert.ok(bucket);
  assert.equal(bucket.verify_calls_total, 2);
  assert.equal(bucket.verify_fail_total, 1);
  assert.equal(bucket.verify_fail_rate, 0.5);
  assert.equal(bucket.agreement_samples, 3);
  assert.equal(bucket.gold_samples, 2);
  assert.equal(bucket.eligible_for_vote, true);

  const gateTrue = should_use_verifier_in_vote(
    {
      issue_type: 'acne',
      quality_grade: 'pass',
      lighting_bucket: 'daylight',
      tone_bucket: 'light',
    },
    {
      table,
      gateConfig: {
        voteEnabled: true,
        maxFailRate: 0.6,
        minAgreement: 0.8,
        minAgreementSamples: 3,
        maxAgreementStddev: 0.2,
        minGoldSamples: 2,
      },
    },
  );
  assert.equal(gateTrue, true);

  const gateDisabled = should_use_verifier_in_vote(
    {
      issue_type: 'acne',
      quality_grade: 'pass',
      lighting_bucket: 'daylight',
      tone_bucket: 'light',
    },
    {
      table,
      gateConfig: {
        voteEnabled: false,
      },
    },
  );
  assert.equal(gateDisabled, false);

  const gateUnknownBucket = should_use_verifier_in_vote(
    {
      issue_type: 'tone',
      quality_grade: 'pass',
      lighting_bucket: 'daylight',
      tone_bucket: 'light',
    },
    {
      table,
      gateConfig: {
        voteEnabled: true,
      },
    },
  );
  assert.equal(gateUnknownBucket, false);
});

test('build_reliability_table script writes reliability.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aurora_reliability_script_'));
  try {
    const inputDir = path.join(root, 'store');
    const outputDir = path.join(root, 'out');
    await fs.mkdir(inputDir, { recursive: true });

    const manifest = {
      paths: {
        model_outputs: 'model_outputs.ndjson',
        agreement_samples: 'agreement_samples.ndjson',
        gold_labels: 'gold_labels.ndjson',
      },
    };
    await fs.writeFile(path.join(inputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeNdjson(path.join(inputDir, 'model_outputs.ndjson'), [
      modelOutputRow({
        inferenceId: 'inf1',
        createdAt: '2026-02-09T01:00:00.000Z',
        ok: true,
        latencyMs: 88,
      }),
    ]);
    await writeNdjson(path.join(inputDir, 'agreement_samples.ndjson'), [
      agreementRow({
        inferenceId: 'inf1',
        createdAt: '2026-02-09T01:00:01.000Z',
        overall: 0.91,
      }),
    ]);
    await writeNdjson(path.join(inputDir, 'gold_labels.ndjson'), [
      goldRow({
        inferenceId: 'inf1',
        createdAt: '2026-02-09T01:10:00.000Z',
      }),
    ]);

    const script = path.join(__dirname, '..', 'scripts', 'build_reliability_table.js');
    const outPath = path.join(outputDir, 'reliability.json');
    const { stdout } = await runExecFile('node', [
      script,
      '--in', inputDir,
      '--out', outPath,
      '--date', '2026-02-09',
    ]);

    assert.equal(stdout.trim(), outPath);
    const report = JSON.parse(await fs.readFile(outPath, 'utf8'));
    assert.equal(report.schema_version, 'aurora.diag.reliability.v1');
    assert.equal(Array.isArray(report.buckets), true);
    assert.equal(report.summary.bucket_count >= 1, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

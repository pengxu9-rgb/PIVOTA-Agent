const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const runExecFile = promisify(execFile);

function repoPath(...parts) {
  return path.join(__dirname, '..', ...parts);
}

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeNdjson(filePath, rows) {
  const lines = (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row));
  await fs.writeFile(filePath, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');
}

test('report_verify_daily generates markdown sections from small ndjson sample', async () => {
  const tempRoot = await makeTempDir('aurora_verify_daily_');
  try {
    const scriptPath = repoPath('scripts', 'report_verify_daily.js');
    const inputDir = repoPath('tests', 'testdata', 'verify_daily');
    const outputDir = path.join(tempRoot, 'reports');

    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--in', inputDir,
      '--out', outputDir,
      '--date', '2026-02-09',
    ]);

    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 2);

    const mdPath = lines[1];
    const markdown = await fs.readFile(mdPath, 'utf8');

    assert.ok(markdown.includes('# Verify Daily Report (2026-02-09)'));
    assert.ok(markdown.includes('## Overview'));
    assert.ok(markdown.includes('verify_calls_total: 3'));
    assert.ok(markdown.includes('verify_fail_total: 1'));
    assert.ok(markdown.includes('average_agreement: 0.6'));
    assert.ok(markdown.includes('hard_case_rate: 0.667'));
    assert.ok(markdown.includes('latency_p50_ms: 760'));
    assert.ok(markdown.includes('latency_p95_ms: 1336'));
    assert.ok(markdown.includes('calls_skipped_by_budget_guard: 1'));

    assert.ok(markdown.includes('## By Issue Type'));
    assert.ok(markdown.includes('LOW_AGREEMENT(1)'));
    assert.ok(markdown.includes('## By Quality Grade'));
    assert.ok(markdown.includes('| pass | 2 | 1 | 0.5 | 0.6 |'));
    assert.ok(markdown.includes('| degraded | 1 | 0 | 0 | 0.6 |'));
    assert.ok(markdown.includes('## Verify Fail By Reason'));
    assert.ok(markdown.includes('| TIMEOUT | 1 | 0.333 | 1 |'));
    assert.ok(markdown.includes('## Top UNKNOWN Samples'));
    assert.ok(markdown.includes('_No UNKNOWN failures for this date._'));

    assert.ok(markdown.includes('## Top 20 Hard Cases'));
    assert.ok(markdown.includes('reqhash001'));
    assert.ok(markdown.includes('assethash002'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('report_verify_daily derives hard case reason/type/hash from legacy rows', async () => {
  const tempRoot = await makeTempDir('aurora_verify_daily_legacy_');
  try {
    const scriptPath = repoPath('scripts', 'report_verify_daily.js');
    const inputDir = path.join(tempRoot, 'input');
    const outputDir = path.join(tempRoot, 'reports');
    const hardCasesPath = path.join(tempRoot, 'hard_cases.ndjson');

    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(
      path.join(inputDir, 'manifest.json'),
      JSON.stringify({
        paths: {
          model_outputs: 'model_outputs.ndjson',
          agreement_samples: 'agreement_samples.ndjson',
          gold_labels: 'gold_labels.ndjson',
        },
      }, null, 2),
      'utf8',
    );
    await writeNdjson(path.join(inputDir, 'model_outputs.ndjson'), [
      {
        created_at: '2026-02-09T10:00:00.000Z',
        provider: 'gemini_provider',
        quality_grade: 'pass',
        output_json: {
          ok: false,
          decision: 'verify',
          failure_reason: 'REQUEST_FAILED',
          final_reason: 'UPSTREAM_5XX',
          provider_status_code: 503,
          latency_ms: 11,
        },
      },
    ]);
    await writeNdjson(path.join(inputDir, 'agreement_samples.ndjson'), []);
    await writeNdjson(path.join(inputDir, 'gold_labels.ndjson'), []);
    await writeNdjson(hardCasesPath, [
      {
        schema_version: 'aurora.diag.verify_hard_case.v1',
        created_at: '2026-02-09T10:00:00.000Z',
        inference_id: null,
        quality_grade: 'pass',
        agreement_score: 1,
        disagreement_reasons: [],
        provider_status_code: 503,
        attempts: 2,
        final_reason: 'UPSTREAM_5XX',
        verifier: {
          per_issue: [],
        },
      },
    ]);

    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--in', inputDir,
      '--out', outputDir,
      '--hard-cases', hardCasesPath,
      '--date', '2026-02-09',
    ]);

    const lines = stdout.trim().split('\n');
    const jsonPath = lines[0];
    const report = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    const top = report.top_hard_cases[0];
    assert.equal(top.disagreement_reason, 'UPSTREAM_5XX');
    assert.equal(top.issue_type, 'verify');
    assert.equal(top.request_id_hash === 'unknown', false);
    assert.equal(top.asset_id_hash === 'unknown', false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('report_verify_daily includes top unknown sample table when UNKNOWN failures exist', async () => {
  const tempRoot = await makeTempDir('aurora_verify_daily_unknown_');
  try {
    const scriptPath = repoPath('scripts', 'report_verify_daily.js');
    const inputDir = path.join(tempRoot, 'input');
    const outputDir = path.join(tempRoot, 'reports');
    const hardCasesPath = path.join(tempRoot, 'hard_cases.ndjson');

    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(
      path.join(inputDir, 'manifest.json'),
      JSON.stringify({
        paths: {
          model_outputs: 'model_outputs.ndjson',
          agreement_samples: 'agreement_samples.ndjson',
          gold_labels: 'gold_labels.ndjson',
        },
      }, null, 2),
      'utf8',
    );
    await writeNdjson(path.join(inputDir, 'model_outputs.ndjson'), [
      {
        created_at: '2026-02-09T12:00:00.000Z',
        provider: 'gemini_provider',
        quality_grade: 'pass',
        inference_id: 'trace_abc123',
        output_json: {
          ok: false,
          decision: 'verify',
          failure_reason: 'SOMETHING_NEW',
          final_reason: 'VISION_UNKNOWN',
          provider_status_code: 0,
          latency_ms: 89,
          error_class: 'TLS_HANDSHAKE',
        },
      },
    ]);
    await writeNdjson(path.join(inputDir, 'agreement_samples.ndjson'), []);
    await writeNdjson(path.join(inputDir, 'gold_labels.ndjson'), []);
    await writeNdjson(hardCasesPath, []);

    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--in', inputDir,
      '--out', outputDir,
      '--hard-cases', hardCasesPath,
      '--date', '2026-02-09',
    ]);

    const lines = stdout.trim().split('\n');
    const mdPath = lines[1];
    const markdown = await fs.readFile(mdPath, 'utf8');
    assert.ok(markdown.includes('## Top UNKNOWN Samples'));
    assert.ok(markdown.includes('| trace_abc123 | TLS_HANDSHAKE | 89 | gemini_provider |'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('report_verify_daily maps REQUEST_FAILED legacy failures to UPSTREAM_5XX', async () => {
  const tempRoot = await makeTempDir('aurora_verify_daily_request_failed_');
  try {
    const scriptPath = repoPath('scripts', 'report_verify_daily.js');
    const inputDir = path.join(tempRoot, 'input');
    const outputDir = path.join(tempRoot, 'reports');

    await fs.mkdir(inputDir, { recursive: true });
    await fs.writeFile(
      path.join(inputDir, 'manifest.json'),
      JSON.stringify({
        paths: {
          model_outputs: 'model_outputs.ndjson',
          agreement_samples: 'agreement_samples.ndjson',
          gold_labels: 'gold_labels.ndjson',
        },
      }, null, 2),
      'utf8',
    );
    await writeNdjson(path.join(inputDir, 'model_outputs.ndjson'), [
      {
        created_at: '2026-02-09T13:00:00.000Z',
        provider: 'gemini_provider',
        quality_grade: 'pass',
        output_json: {
          ok: false,
          decision: 'verify',
          failure_reason: 'REQUEST_FAILED',
          final_reason: 'REQUEST_FAILED',
          provider_status_code: 0,
          latency_ms: 9,
        },
      },
    ]);
    await writeNdjson(path.join(inputDir, 'agreement_samples.ndjson'), []);
    await writeNdjson(path.join(inputDir, 'gold_labels.ndjson'), []);

    const { stdout } = await runExecFile('node', [
      scriptPath,
      '--in', inputDir,
      '--out', outputDir,
      '--date', '2026-02-09',
    ]);

    const lines = stdout.trim().split('\n');
    const jsonPath = lines[0];
    const report = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
    const reasonRow = report.verify_fail_by_reason.find((item) => item.reason === 'UPSTREAM_5XX');
    assert.ok(reasonRow);
    assert.equal(reasonRow.count, 1);
    assert.equal(report.verify_fail_by_reason.find((item) => item.reason === 'UNKNOWN'), undefined);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

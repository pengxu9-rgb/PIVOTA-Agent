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

    assert.ok(markdown.includes('## Top 20 Hard Cases'));
    assert.ok(markdown.includes('reqhash001'));
    assert.ok(markdown.includes('assethash002'));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

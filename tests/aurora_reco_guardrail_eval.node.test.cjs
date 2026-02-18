const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.resolve(REPO_ROOT, 'scripts/eval_reco_guardrail.js');
const FIXTURE_DIR = path.resolve(REPO_ROOT, 'tests/testdata/reco_guardrail');

function runEval({ inputName, failOnRedline = true }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-reco-guardrail-'));
  const outJson = path.join(tmpDir, 'report.json');
  const outMd = path.join(tmpDir, 'report.md');
  const args = [
    SCRIPT_PATH,
    '--in',
    path.join(FIXTURE_DIR, inputName),
    '--out-json',
    outJson,
    '--out-md',
    outMd,
    '--k',
    '5',
    '--quiet',
  ];
  if (failOnRedline) args.push('--fail-on-redline');
  const proc = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const report = fs.existsSync(outJson)
    ? JSON.parse(fs.readFileSync(outJson, 'utf8'))
    : null;
  return { proc, report, outJson, outMd };
}

test('eval_reco_guardrail: clean fixture passes and keeps hard redlines at zero', () => {
  const { proc, report } = runEval({ inputName: 'clean_samples.jsonl', failOnRedline: true });
  assert.equal(proc.status, 0, `expected exit 0, got ${proc.status}, stderr=${proc.stderr}`);
  assert.ok(report);
  assert.equal(Boolean(report.gates && report.gates.hard_fail), false);
  assert.equal(Number(report.metrics && report.metrics.competitors_same_brand_rate), 0);
  assert.equal(Number(report.metrics && report.metrics.competitors_on_page_source_rate), 0);
  assert.ok(Number(report.metrics && report.metrics.explanation_alignment_at_3) >= 0);
});

test('eval_reco_guardrail: same-brand pollution fails redline gate', () => {
  const { proc, report } = runEval({ inputName: 'polluted_same_brand.jsonl', failOnRedline: true });
  assert.equal(proc.status, 3, `expected exit 3, got ${proc.status}, stderr=${proc.stderr}`);
  assert.ok(report);
  assert.equal(Boolean(report.gates && report.gates.hard_fail), true);
  assert.ok(
    Array.isArray(report.gates && report.gates.violations)
      && report.gates.violations.includes('competitors_same_brand_rate_gt_zero'),
  );
});

test('eval_reco_guardrail: on-page pollution fails redline gate', () => {
  const { proc, report } = runEval({ inputName: 'polluted_on_page.jsonl', failOnRedline: true });
  assert.equal(proc.status, 3, `expected exit 3, got ${proc.status}, stderr=${proc.stderr}`);
  assert.ok(report);
  assert.equal(Boolean(report.gates && report.gates.hard_fail), true);
  assert.ok(
    Array.isArray(report.gates && report.gates.violations)
      && report.gates.violations.includes('competitors_on_page_source_rate_gt_zero'),
  );
});

test('eval_reco_guardrail: explanation alignment@3 is computed from score breakdown + reasons', () => {
  const { proc, report } = runEval({ inputName: 'clean_samples.jsonl', failOnRedline: false });
  assert.equal(proc.status, 0, `expected exit 0, got ${proc.status}, stderr=${proc.stderr}`);
  const alignment = Number(report && report.metrics && report.metrics.explanation_alignment_at_3);
  assert.ok(Number.isFinite(alignment));
  assert.ok(alignment > 0.9, `expected alignment > 0.9, got ${alignment}`);
});

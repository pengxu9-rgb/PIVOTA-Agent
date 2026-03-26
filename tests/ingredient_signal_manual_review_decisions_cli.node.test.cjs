const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-signal-manual-decisions-'));
}

function runPython(args, options = {}) {
  return execFileSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function writeCsv(filePath, fieldnames, rows) {
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(fieldnames.map((key) => JSON.stringify(String(row[key] || ''))).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function readCsv(filePath) {
  const output = runPython([
    '-c',
    [
      'import csv, json, sys',
      'with open(sys.argv[1], newline="", encoding="utf-8") as handle:',
      '    print(json.dumps(list(csv.DictReader(handle))))',
    ].join('\n'),
    filePath,
  ]);
  return JSON.parse(output);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('grouped signal manual review autofill and export create approved candidates', () => {
  const tempDir = makeTempDir();
  const decisionCsv = path.join(tempDir, 'signal_manual_packet.csv');
  const autofilledCsv = path.join(tempDir, 'signal_manual_packet_autofilled.csv');
  const approvedCsv = path.join(tempDir, 'signal_manual_candidates.csv');
  const remainderCsv = path.join(tempDir, 'signal_manual_remainder.csv');
  const summaryJson = path.join(tempDir, 'signal_manual_summary.json');

  const fieldnames = [
    'grouped_signal_key',
    'grouped_signal_bucket',
    'grouped_raw_tokens',
    'source_row_count',
    'suggestion_confidence',
    'resolution_rationale',
    'example_raw_token',
    'decision',
    'approved_signal_bucket',
    'approved_signal_key',
    'reviewer_notes',
  ];

  writeCsv(decisionCsv, fieldnames, [
    {
      grouped_signal_key: 'antioxidants',
      grouped_signal_bucket: 'marketing_or_blend_signal',
      grouped_raw_tokens: 'antioxidants; Antioxidants',
      source_row_count: '2',
      suggestion_confidence: 'medium',
      resolution_rationale: 'umbrella',
      example_raw_token: 'antioxidants',
      decision: '',
      approved_signal_bucket: 'marketing_or_blend_signal',
      approved_signal_key: 'antioxidants',
      reviewer_notes: '',
    },
    {
      grouped_signal_key: 'protective_antioxidants',
      grouped_signal_bucket: 'marketing_or_blend_signal',
      grouped_raw_tokens: 'protective antioxidants',
      source_row_count: '1',
      suggestion_confidence: 'medium',
      resolution_rationale: 'umbrella',
      example_raw_token: 'protective antioxidants',
      decision: '',
      approved_signal_bucket: 'marketing_or_blend_signal',
      approved_signal_key: 'protective_antioxidants',
      reviewer_notes: '',
    },
  ]);

  runPython([
    'scripts/autofill_ingredient_signal_manual_review_decisions.py',
    '--decision-csv', decisionCsv,
    '--out-csv', autofilledCsv,
    '--approve-bucket', 'marketing_or_blend_signal',
    '--only-empty-decision',
  ]);

  const autofilledRows = readCsv(autofilledCsv);
  assert.equal(autofilledRows[0].decision, 'approve_grouped_signal');
  assert.equal(autofilledRows[1].decision, 'approve_grouped_signal');

  runPython([
    'scripts/export_ingredient_signal_manual_review_candidates.py',
    '--decision-csv', autofilledCsv,
    '--out-approved-csv', approvedCsv,
    '--out-remainder-csv', remainderCsv,
    '--out-summary-json', summaryJson,
  ]);

  const approvedRows = readCsv(approvedCsv);
  const remainderRows = readCsv(remainderCsv);
  const summary = readJson(summaryJson);

  assert.equal(approvedRows.length, 2);
  assert.equal(remainderRows.length, 0);
  assert.equal(summary.approved_count, 2);
  assert.equal(approvedRows[0].signal_bucket, 'marketing_or_blend_signal');
});

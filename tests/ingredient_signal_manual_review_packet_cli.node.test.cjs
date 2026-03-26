const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-signal-manual-packet-'));
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

test('signal manual review packet groups remainder rows by signal key', () => {
  const tempDir = makeTempDir();
  const remainderCsv = path.join(tempDir, 'signal_remainder.csv');
  const outCsv = path.join(tempDir, 'signal_manual_packet.csv');
  const outJson = path.join(tempDir, 'signal_manual_packet.json');

  const fieldnames = [
    'raw_token',
    'normalized_token',
    'suggested_signal_bucket',
    'suggested_signal_key',
    'suggestion_confidence',
    'decision',
    'approved_signal_bucket',
    'approved_signal_key',
    'resolution_rationale',
    'reviewer_notes',
  ];

  writeCsv(remainderCsv, fieldnames, [
    {
      raw_token: 'antioxidants',
      normalized_token: 'antioxidants',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'antioxidants',
      suggestion_confidence: 'medium',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      resolution_rationale: 'umbrella',
      reviewer_notes: '',
    },
    {
      raw_token: 'Antioxidants',
      normalized_token: 'antioxidants',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'antioxidants',
      suggestion_confidence: 'medium',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      resolution_rationale: 'umbrella',
      reviewer_notes: '',
    },
    {
      raw_token: 'protective antioxidants',
      normalized_token: 'protectiveantioxidants',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'protective_antioxidants',
      suggestion_confidence: 'medium',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      resolution_rationale: 'umbrella',
      reviewer_notes: '',
    },
  ]);

  runPython([
    'scripts/build_ingredient_signal_manual_review_packet.py',
    '--remainder-csv', remainderCsv,
    '--out-csv', outCsv,
    '--out-json', outJson,
  ]);

  const rows = readCsv(outCsv);
  const summary = readJson(outJson);

  assert.equal(rows.length, 2);
  assert.equal(summary.input_row_count, 3);
  assert.equal(summary.grouped_row_count, 2);
  const antioxidants = rows.find((row) => row.grouped_signal_key === 'antioxidants');
  assert.equal(antioxidants.source_row_count, '2');
  assert.equal(antioxidants.grouped_raw_tokens, 'antioxidants; Antioxidants');
});

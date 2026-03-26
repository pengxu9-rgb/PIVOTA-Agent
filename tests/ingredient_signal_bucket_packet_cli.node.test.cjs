const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-signal-bucket-packet-'));
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

test('signal bucket packet export filters rows by suggested signal bucket', () => {
  const tempDir = makeTempDir();
  const packetCsv = path.join(tempDir, 'signal_packet.csv');
  const outCsv = path.join(tempDir, 'marketing_packet.csv');
  const outJson = path.join(tempDir, 'marketing_packet.json');
  const outXlsx = path.join(tempDir, 'marketing_packet.xlsx');

  const fieldnames = [
    'raw_token',
    'normalized_token',
    'suggested_signal_bucket',
    'suggested_signal_key',
    'suggestion_confidence',
    'decision',
  ];

  writeCsv(packetCsv, fieldnames, [
    {
      raw_token: 'Ceramides',
      normalized_token: 'ceramides',
      suggested_signal_bucket: 'ingredient_family_signal',
      suggested_signal_key: 'ceramides',
      suggestion_confidence: 'high',
      decision: 'approve_suggestion',
    },
    {
      raw_token: 'Antioxidant Complex',
      normalized_token: 'antioxidantcomplex',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'antioxidant_complex',
      suggestion_confidence: 'medium',
      decision: '',
    },
    {
      raw_token: 'ZOX12® Complex',
      normalized_token: 'zox12complex',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'zox12_complex',
      suggestion_confidence: 'medium',
      decision: '',
    },
  ]);

  runPython([
    'scripts/export_ingredient_signal_bucket_packet.py',
    '--packet-csv', packetCsv,
    '--signal-bucket', 'marketing_or_blend_signal',
    '--out-csv', outCsv,
    '--out-json', outJson,
    '--out-xlsx', outXlsx,
    '--sheet-name', 'Marketing_Signal_Review',
  ]);

  const rows = readCsv(outCsv);
  const summary = readJson(outJson);

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.raw_token),
    ['Antioxidant Complex', 'ZOX12® Complex']
  );
  assert.equal(summary.row_count, 2);
  assert.equal(summary.suggested_signal_bucket_counts.marketing_or_blend_signal, 2);
});

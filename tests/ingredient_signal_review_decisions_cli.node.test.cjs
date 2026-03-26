const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-signal-review-decisions-'));
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

test('signal review autofill and export produce approved high-confidence candidates', () => {
  const tempDir = makeTempDir();
  const decisionCsv = path.join(tempDir, 'signal_packet.csv');
  const autofilledCsv = path.join(tempDir, 'signal_packet_autofilled.csv');
  const approvedCsv = path.join(tempDir, 'signal_candidates.csv');
  const remainderCsv = path.join(tempDir, 'signal_remainder.csv');
  const summaryJson = path.join(tempDir, 'signal_candidates_summary.json');

  const fieldnames = [
    'priority_score',
    'raw_token',
    'normalized_token',
    'unmatched_count',
    'sku_row_count',
    'full_inci_count',
    'key_count',
    'top_categories',
    'example_brands',
    'example_products',
    'example_urls',
    'suggested_resolution',
    'suggested_signal_bucket',
    'suggested_signal_key',
    'suggestion_confidence',
    'resolution_rationale',
    'decision',
    'approved_signal_bucket',
    'approved_signal_key',
    'reviewer_notes',
  ];

  writeCsv(decisionCsv, fieldnames, [
    {
      priority_score: '80',
      raw_token: 'Ceramides',
      normalized_token: 'ceramides',
      unmatched_count: '6',
      sku_row_count: '6',
      full_inci_count: '0',
      key_count: '6',
      top_categories: 'moisturizer:6',
      example_brands: 'CeraVe',
      example_products: 'PM Lotion',
      example_urls: 'https://example.com/a',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'ingredient_family_signal',
      suggested_signal_key: 'ceramides',
      suggestion_confidence: 'high',
      resolution_rationale: 'Family term.',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      reviewer_notes: '',
    },
    {
      priority_score: '72',
      raw_token: 'AHA',
      normalized_token: 'aha',
      unmatched_count: '4',
      sku_row_count: '4',
      full_inci_count: '0',
      key_count: '4',
      top_categories: 'exfoliant:4',
      example_brands: 'FAB',
      example_products: 'Pads',
      example_urls: 'https://example.com/b',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'acid_family_signal',
      suggested_signal_key: 'aha',
      suggestion_confidence: 'high',
      resolution_rationale: 'Acid family term.',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      reviewer_notes: '',
    },
    {
      priority_score: '41',
      raw_token: 'Antioxidant Complex',
      normalized_token: 'antioxidantcomplex',
      unmatched_count: '1',
      sku_row_count: '1',
      full_inci_count: '0',
      key_count: '1',
      top_categories: 'serum:1',
      example_brands: 'BrandX',
      example_products: 'Glow Serum',
      example_urls: 'https://example.com/c',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'antioxidant_complex',
      suggestion_confidence: 'medium',
      resolution_rationale: 'Marketing term.',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      reviewer_notes: '',
    },
  ]);

  runPython([
    'scripts/autofill_ingredient_signal_review_decisions.py',
    '--decision-csv', decisionCsv,
    '--out-csv', autofilledCsv,
    '--approve-bucket', 'ingredient_family_signal',
    '--approve-bucket', 'acid_family_signal',
    '--only-empty-decision',
  ]);

  const autofilledRows = readCsv(autofilledCsv);
  const ceramides = autofilledRows.find((row) => row.raw_token === 'Ceramides');
  const aha = autofilledRows.find((row) => row.raw_token === 'AHA');
  const antioxidant = autofilledRows.find((row) => row.raw_token === 'Antioxidant Complex');

  assert.equal(ceramides.decision, 'approve_suggestion');
  assert.equal(ceramides.approved_signal_bucket, 'ingredient_family_signal');
  assert.equal(aha.decision, 'approve_suggestion');
  assert.equal(aha.approved_signal_key, 'aha');
  assert.equal(antioxidant.decision, '');

  runPython([
    'scripts/export_ingredient_signal_review_candidates.py',
    '--decision-csv', autofilledCsv,
    '--out-approved-csv', approvedCsv,
    '--out-remainder-csv', remainderCsv,
    '--out-summary-json', summaryJson,
  ]);

  const approvedRows = readCsv(approvedCsv);
  const remainderRows = readCsv(remainderCsv);
  const summary = readJson(summaryJson);

  assert.equal(approvedRows.length, 2);
  assert.equal(remainderRows.length, 1);
  assert.equal(summary.approved_count, 2);
  assert.equal(summary.remainder_count, 1);
  assert.deepEqual(
    approvedRows.map((row) => row.signal_bucket).sort(),
    ['acid_family_signal', 'ingredient_family_signal']
  );
});

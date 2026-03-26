const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-marketing-signal-decision-'));
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

test('marketing signal decision packet classifies and autofills safe subtypes', () => {
  const tempDir = makeTempDir();
  const marketingPacketCsv = path.join(tempDir, 'marketing_packet.csv');
  const decisionCsv = path.join(tempDir, 'marketing_decisions.csv');
  const decisionJson = path.join(tempDir, 'marketing_decisions.json');
  const autofilledCsv = path.join(tempDir, 'marketing_decisions_autofilled.csv');

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

  writeCsv(marketingPacketCsv, fieldnames, [
    {
      priority_score: '-14',
      raw_token: 'Vital ET™',
      normalized_token: 'vitalettm',
      unmatched_count: '2',
      sku_row_count: '2',
      full_inci_count: '',
      key_count: '2',
      top_categories: 'serum:2',
      example_brands: 'Colorescience',
      example_products: 'Even Up® Multi-Correction Serum',
      example_urls: 'https://example.com/a',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'vital_ettm',
      suggestion_confidence: 'medium',
      resolution_rationale: 'marketing',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      reviewer_notes: '',
    },
    {
      priority_score: '-27',
      raw_token: 'botanical brightening complex',
      normalized_token: 'botanicalbrighteningcomplex',
      unmatched_count: '1',
      sku_row_count: '1',
      full_inci_count: '',
      key_count: '1',
      top_categories: 'exfoliant:1',
      example_brands: 'Dermalogica',
      example_products: 'Daily Microfoliant',
      example_urls: 'https://example.com/b',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'botanical_brightening_complex',
      suggestion_confidence: 'medium',
      resolution_rationale: 'marketing',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      reviewer_notes: '',
    },
    {
      priority_score: '-14',
      raw_token: 'antioxidants',
      normalized_token: 'antioxidants',
      unmatched_count: '2',
      sku_row_count: '2',
      full_inci_count: '',
      key_count: '2',
      top_categories: 'serum:2',
      example_brands: 'BrandX',
      example_products: 'Serum',
      example_urls: 'https://example.com/c',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'marketing_or_blend_signal',
      suggested_signal_key: 'antioxidants',
      suggestion_confidence: 'medium',
      resolution_rationale: 'marketing',
      decision: '',
      approved_signal_bucket: '',
      approved_signal_key: '',
      reviewer_notes: '',
    },
  ]);

  runPython([
    'scripts/build_ingredient_marketing_signal_decision_packet.py',
    '--packet-csv', marketingPacketCsv,
    '--out-csv', decisionCsv,
    '--out-json', decisionJson,
  ]);

  const summary = readJson(decisionJson);
  const decisionRows = readCsv(decisionCsv);

  assert.equal(summary.row_count, 3);
  assert.equal(summary.suggested_marketing_subtype_counts.trademarked_trade_name_signal, 1);
  assert.equal(summary.suggested_marketing_subtype_counts.complex_or_blend_claim_signal, 1);
  assert.equal(summary.suggested_marketing_subtype_counts.umbrella_benefit_signal, 1);

  runPython([
    'scripts/autofill_ingredient_marketing_signal_decisions.py',
    '--decision-csv', decisionCsv,
    '--out-csv', autofilledCsv,
    '--approve-subtype', 'trademarked_trade_name_signal',
    '--approve-subtype', 'complex_or_blend_claim_signal',
    '--only-empty-decision',
  ]);

  const autofilledRows = readCsv(autofilledCsv);
  const trademark = autofilledRows.find((row) => row.raw_token === 'Vital ET™');
  const complex = autofilledRows.find((row) => row.raw_token === 'botanical brightening complex');
  const umbrella = autofilledRows.find((row) => row.raw_token === 'antioxidants');

  assert.equal(trademark.decision, 'approve_suggestion');
  assert.equal(trademark.approved_marketing_subtype, 'trademarked_trade_name_signal');
  assert.equal(complex.decision, 'approve_suggestion');
  assert.equal(complex.approved_signal_key, 'botanical_brightening_complex');
  assert.equal(umbrella.decision, '');
});

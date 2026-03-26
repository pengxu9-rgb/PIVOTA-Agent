const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-needs-signal-'));
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

test('needs signal decision packet classifies hardcases into refined buckets', () => {
  const tempDir = makeTempDir();
  const inputCsv = path.join(tempDir, 'signal_review.csv');
  const outCsv = path.join(tempDir, 'needs_signal_packet.csv');
  const outJson = path.join(tempDir, 'needs_signal_packet.json');

  writeCsv(inputCsv, [
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
  ], [
    {
      priority_score: '10',
      raw_token: '15% Vitamin C',
      normalized_token: '15vitaminc',
      unmatched_count: '1',
      sku_row_count: '1',
      key_count: '1',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'needs_signal_review',
      suggested_signal_key: '15_vitamin_c',
      suggestion_confidence: 'low',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '10',
      raw_token: 'Rice enzymes / rice-based enzyme powder',
      normalized_token: 'riceenzymesricebasedenzymepowder',
      unmatched_count: '1',
      sku_row_count: '1',
      key_count: '1',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'needs_signal_review',
      suggested_signal_key: 'rice_enzymes',
      suggestion_confidence: 'low',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '10',
      raw_token: 'Chamomile',
      normalized_token: 'chamomile',
      unmatched_count: '1',
      sku_row_count: '1',
      key_count: '1',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'needs_signal_review',
      suggested_signal_key: 'chamomile',
      suggestion_confidence: 'low',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '10',
      raw_token: 'AP',
      normalized_token: 'ap',
      unmatched_count: '1',
      sku_row_count: '1',
      key_count: '1',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'needs_signal_review',
      suggested_signal_key: 'ap',
      suggestion_confidence: 'low',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '10',
      raw_token: 'Thiamidol',
      normalized_token: 'thiamidol',
      unmatched_count: '1',
      sku_row_count: '1',
      key_count: '1',
      suggested_resolution: 'route_to_signal_dict',
      suggested_signal_bucket: 'needs_signal_review',
      suggested_signal_key: 'thiamidol',
      suggestion_confidence: 'low',
      resolution_rationale: 'manual',
    },
  ]);

  runPython([
    'scripts/build_ingredient_needs_signal_decision_packet.py',
    '--signal-review-csv', inputCsv,
    '--out-csv', outCsv,
    '--out-json', outJson,
  ]);

  const rows = readCsv(outCsv);
  const summary = readJson(outJson);

  assert.equal(rows.length, 5);
  assert.equal(summary.suggested_signal_bucket_counts.strength_claim_signal, 1);

  assert.equal(rows.find((row) => row.raw_token === '15% Vitamin C').hardcase_subtype, 'percent_strength_claim');
  assert.equal(rows.find((row) => row.raw_token === '15% Vitamin C').suggested_signal_bucket, 'strength_claim_signal');
  assert.equal(rows.find((row) => row.raw_token === 'Rice enzymes / rice-based enzyme powder').hardcase_subtype, 'claim_phrase_or_system');
  assert.equal(rows.find((row) => row.raw_token === 'Chamomile').suggested_signal_bucket, 'botanical_or_material_signal_review');
  assert.equal(rows.find((row) => row.raw_token === 'AP').suggested_signal_bucket, 'abbreviation_or_code_review');
  assert.equal(rows.find((row) => row.raw_token === 'Thiamidol').suggested_signal_bucket, 'named_active_review');
});

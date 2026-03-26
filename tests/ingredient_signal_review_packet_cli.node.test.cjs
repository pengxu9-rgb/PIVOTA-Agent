const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-signal-review-packet-'));
}

function runPython(args, options = {}) {
  return execFileSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function createQueueWorkbook(workbookPath, header, rows) {
  runPython([
    '-c',
    [
      'import json, sys',
      'from openpyxl import Workbook',
      'path = sys.argv[1]',
      'header = json.loads(sys.argv[2])',
      'rows = json.loads(sys.argv[3])',
      'wb = Workbook()',
      'ws = wb.active',
      "ws.title = 'Signal_Review_Queue'",
      'ws.append(header)',
      'for row in rows:',
      '    ws.append([row.get(col, "") for col in header])',
      'wb.save(path)',
    ].join('\n'),
    workbookPath,
    JSON.stringify(header),
    JSON.stringify(rows),
  ]);
}

test('signal review packet CLI builds a decision-ready packet from signal rows', () => {
  const tempDir = makeTempDir();
  const queueWorkbook = path.join(tempDir, 'signal_queue.xlsx');
  const outCsv = path.join(tempDir, 'signal_packet.csv');
  const outJson = path.join(tempDir, 'signal_packet.json');
  const outXlsx = path.join(tempDir, 'signal_packet.xlsx');

  const queueHeader = [
    'priority_score',
    'recommended_bucket',
    'recommended_action',
    'triage_reason',
    'raw_token',
    'normalized_token',
    'unmatched_count',
    'sku_row_count',
    'full_inci_count',
    'key_count',
    'product_only_count',
    'top_categories',
    'example_brands',
    'example_products',
    'example_urls',
    'in_current_master_like',
  ];

  createQueueWorkbook(queueWorkbook, queueHeader, [
    {
      priority_score: '80',
      recommended_bucket: 'signal_or_family_term',
      recommended_action: 'do_not_add_to_canonical__route_to_signal_dict',
      triage_reason: 'Broad family term.',
      raw_token: 'Ceramides',
      normalized_token: 'ceramides',
      unmatched_count: '6',
      sku_row_count: '6',
      full_inci_count: '0',
      key_count: '6',
      product_only_count: '0',
      top_categories: 'moisturizer:6',
      example_brands: 'CeraVe',
      example_products: 'PM Lotion',
      example_urls: 'https://example.com/a',
      in_current_master_like: 'False',
    },
    {
      priority_score: '72',
      recommended_bucket: 'signal_or_family_term',
      recommended_action: 'do_not_add_to_canonical__route_to_signal_dict',
      triage_reason: 'Short acid family term.',
      raw_token: 'AHA',
      normalized_token: 'aha',
      unmatched_count: '4',
      sku_row_count: '4',
      full_inci_count: '0',
      key_count: '4',
      product_only_count: '0',
      top_categories: 'exfoliant:4',
      example_brands: 'FAB',
      example_products: 'Radiance Pads',
      example_urls: 'https://example.com/b',
      in_current_master_like: 'False',
    },
    {
      priority_score: '41',
      recommended_bucket: 'signal_or_family_term',
      recommended_action: 'do_not_add_to_canonical__route_to_signal_dict',
      triage_reason: 'Marketing umbrella term.',
      raw_token: 'Antioxidant Complex',
      normalized_token: 'antioxidantcomplex',
      unmatched_count: '1',
      sku_row_count: '1',
      full_inci_count: '0',
      key_count: '1',
      product_only_count: '0',
      top_categories: 'serum:1',
      example_brands: 'BrandX',
      example_products: 'Glow Serum',
      example_urls: 'https://example.com/c',
      in_current_master_like: 'False',
    },
  ]);

  runPython([
    'scripts/build_ingredient_signal_review_packet.py',
    '--queue-xlsx', queueWorkbook,
    '--out-csv', outCsv,
    '--out-json', outJson,
    '--out-xlsx', outXlsx,
  ]);

  const summary = readJson(outJson);
  const rows = readCsv(outCsv);

  assert.equal(summary.row_count, 3);
  assert.equal(summary.suggested_signal_bucket_counts.ingredient_family_signal, 1);
  assert.equal(summary.suggested_signal_bucket_counts.acid_family_signal, 1);
  assert.equal(summary.suggested_signal_bucket_counts.marketing_or_blend_signal, 1);
  assert.equal(summary.confidence_counts.high, 2);
  assert.equal(summary.confidence_counts.medium, 1);

  const ceramides = rows.find((row) => row.raw_token === 'Ceramides');
  const aha = rows.find((row) => row.raw_token === 'AHA');
  const antioxidant = rows.find((row) => row.raw_token === 'Antioxidant Complex');

  assert.equal(ceramides.suggested_signal_bucket, 'ingredient_family_signal');
  assert.equal(ceramides.suggested_signal_key, 'ceramides');
  assert.equal(aha.suggested_signal_bucket, 'acid_family_signal');
  assert.equal(aha.suggested_signal_key, 'aha');
  assert.equal(antioxidant.suggested_signal_bucket, 'marketing_or_blend_signal');
  assert.equal(antioxidant.suggestion_confidence, 'medium');
});

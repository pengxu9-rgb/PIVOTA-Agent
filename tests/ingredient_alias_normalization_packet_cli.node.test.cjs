const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-alias-normalization-packet-'));
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

function createIngredientWorkbook(workbookPath, header, rows) {
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
      "ws.title = 'Ingredient_Reference_Merged_v2'",
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
      "ws.title = 'Alias_Normalization_Queue'",
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

test('alias normalization packet CLI builds a decision-ready packet from queue rows', () => {
  const tempDir = makeTempDir();
  const ingredientWorkbook = path.join(tempDir, 'ingredient_reference.xlsx');
  const queueWorkbook = path.join(tempDir, 'alias_queue.xlsx');
  const outCsv = path.join(tempDir, 'alias_normalization_packet.csv');
  const outJson = path.join(tempDir, 'alias_normalization_packet.json');
  const outXlsx = path.join(tempDir, 'alias_normalization_packet.xlsx');

  const ingredientHeader = [
    'record_id',
    'canonical_inci_name',
    'canonical_display_name',
    'us_label_name',
    'eu_label_name',
    'parser_variants',
    'aliases_common',
    'us_label_variants',
    'eu_label_variants',
    'deprecated_aliases',
    'normalized_key',
  ];

  const ingredientRows = [
    {
      record_id: 'ING-0001',
      canonical_inci_name: 'Titanium Dioxide',
      canonical_display_name: 'Titanium Dioxide',
      us_label_name: 'Titanium Dioxide',
      eu_label_name: 'Titanium Dioxide',
      parser_variants: 'Titanium Dioxide; titanium dioxide',
      aliases_common: '',
      us_label_variants: '',
      eu_label_variants: '',
      deprecated_aliases: '',
      normalized_key: 'titaniumdioxide',
    },
  ];

  createIngredientWorkbook(ingredientWorkbook, ingredientHeader, ingredientRows);

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

  const queueRows = [
    {
      priority_score: '50',
      recommended_bucket: 'alias_or_normalization_gap',
      recommended_action: 'append_alias_or_parser_variant',
      triage_reason: 'Uppercase label variant.',
      raw_token: 'TROMETHAMINE',
      normalized_token: 'tromethamine',
      unmatched_count: '3',
      sku_row_count: '3',
      full_inci_count: '3',
      key_count: '0',
      product_only_count: '0',
      top_categories: 'barrier cream:2',
      example_brands: 'Avène',
      example_products: 'Cicalfate+',
      example_urls: 'https://example.com/a',
      in_current_master_like: 'False',
    },
    {
      priority_score: '26',
      recommended_bucket: 'alias_or_normalization_gap',
      recommended_action: 'append_alias_or_parser_variant',
      triage_reason: 'Manual-risk slash variant.',
      raw_token: "BEESWAX / CIRE D'ABEILLE",
      normalized_token: 'beeswaxciredabeille',
      unmatched_count: '1',
      sku_row_count: '1',
      full_inci_count: '1',
      key_count: '0',
      product_only_count: '0',
      top_categories: 'barrier cream:1',
      example_brands: 'Avène',
      example_products: 'Cicalfate+',
      example_urls: 'https://example.com/b',
      in_current_master_like: 'False',
    },
  ];

  createQueueWorkbook(queueWorkbook, queueHeader, queueRows);

  runPython([
    'scripts/build_ingredient_alias_normalization_packet.py',
    '--queue-xlsx',
    queueWorkbook,
    '--ingredient-xlsx',
    ingredientWorkbook,
    '--out-csv',
    outCsv,
    '--out-json',
    outJson,
    '--out-xlsx',
    outXlsx,
  ]);

  const summary = readJson(outJson);
  assert.equal(summary.row_count, 2);
  assert.equal(summary.resolution_counts.new_canonical_candidate_with_parser_variants, 1);
  assert.equal(summary.resolution_counts.needs_manual_mapping, 1);

  const rows = readCsv(outCsv);
  const tromethamine = rows.find((row) => row.raw_token === 'TROMETHAMINE');
  assert.equal(tromethamine.suggested_resolution, 'new_canonical_candidate_with_parser_variants');
  assert.equal(tromethamine.suggested_new_canonical_inci_name, 'Tromethamine');
  assert.ok(tromethamine.suggested_parser_variants_addition.includes('Tromethamine'));

  const beeswax = rows.find((row) => row.raw_token === "BEESWAX / CIRE D'ABEILLE");
  assert.equal(beeswax.suggested_resolution, 'needs_manual_mapping');
  assert.equal(beeswax.suggestion_confidence, 'low');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-alias-manual-workbench-'));
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

test('alias manual mapping workbench finds safe CI-to-existing canonical mappings', () => {
  const tempDir = makeTempDir();
  const packetCsv = path.join(tempDir, 'manual_mapping_packet.csv');
  const ingredientWorkbook = path.join(tempDir, 'ingredient_reference.xlsx');
  const outCsv = path.join(tempDir, 'manual_mapping_workbench.csv');
  const outJson = path.join(tempDir, 'manual_mapping_workbench.json');

  writeCsv(packetCsv, [
    'priority_score',
    'raw_token',
    'normalized_token',
    'manual_mapping_subtype',
    'suggested_new_canonical_inci_name',
    'suggested_parser_variants_addition',
    'example_brands',
    'example_products',
    'example_urls',
    'resolution_rationale',
    'decision',
    'approved_existing_target_record_id',
    'approved_existing_target_canonical_inci_name',
    'approved_new_canonical_inci_name',
    'approved_parser_variants_addition',
    'reviewer_notes',
  ], [
    {
      priority_score: '22',
      raw_token: 'CI 77891 (TITANIUM DIOXIDE)',
      normalized_token: 'ci77891titaniumdioxide',
      manual_mapping_subtype: 'ci_color_index_token',
      suggested_new_canonical_inci_name: 'CI 77891 (TITANIUM DIOXIDE)',
      suggested_parser_variants_addition: 'CI 77891 (TITANIUM DIOXIDE)',
      example_brands: 'Brand',
      example_products: 'Product',
      example_urls: 'https://example.com',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '22',
      raw_token: 'GLUCOSAMINE HCL',
      normalized_token: 'glucosaminehcl',
      manual_mapping_subtype: 'salt_hcl_abbreviation',
      suggested_new_canonical_inci_name: 'Glucosamine HCl',
      suggested_parser_variants_addition: 'Glucosamine HCl',
      example_brands: 'Brand',
      example_products: 'Product',
      example_urls: 'https://example.com',
      resolution_rationale: 'manual',
    },
  ]);

  createIngredientWorkbook(ingredientWorkbook, [
    'record_id',
    'canonical_inci_name',
    'aliases_common',
    'parser_variants',
    'alias_quality',
  ], [
    {
      record_id: 'ING-0305',
      canonical_inci_name: 'Titanium Dioxide',
      aliases_common: '',
      parser_variants: 'Titanium Dioxide; titanium dioxide',
      alias_quality: '',
    },
  ]);

  runPython([
    'scripts/build_ingredient_alias_manual_mapping_workbench.py',
    '--packet-csv', packetCsv,
    '--ingredient-xlsx', ingredientWorkbook,
    '--out-csv', outCsv,
    '--out-json', outJson,
  ]);

  const rows = readCsv(outCsv);
  const summary = readJson(outJson);

  assert.equal(summary.row_count, 2);
  assert.equal(summary.suggested_decision_counts.map_to_existing_canonical, 1);
  assert.equal(summary.suggested_decision_counts.create_new_canonical, 1);
  const titanium = rows.find((row) => row.raw_token === 'CI 77891 (TITANIUM DIOXIDE)');
  assert.equal(titanium.suggested_existing_target_record_id, 'ING-0305');
  assert.equal(titanium.suggested_existing_parser_variants, 'Titanium Dioxide; titanium dioxide');
  assert.equal(titanium.suggestion_confidence, 'high');
});

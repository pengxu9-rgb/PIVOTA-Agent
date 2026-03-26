const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sku-seed-ingredient-match-'));
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

function createWorkbook(workbookPath, sheetName, header, rows) {
  runPython(
    [
      '-c',
      [
        'import json, sys',
        'from openpyxl import Workbook',
        'path = sys.argv[1]',
        'sheet_name = sys.argv[2]',
        'header = json.loads(sys.argv[3])',
        'rows = json.loads(sys.argv[4])',
        'wb = Workbook()',
        'ws = wb.active',
        'ws.title = sheet_name',
        'ws.append(header)',
        'for row in rows:',
        '    ws.append([row.get(col, "") for col in header])',
        'wb.save(path)',
      ].join('\n'),
      workbookPath,
      sheetName,
      JSON.stringify(header),
      JSON.stringify(rows),
    ],
  );
}

function readCsvViaPython(filePath) {
  const output = runPython([
    '-c',
    [
      'import csv, json, sys',
      'with open(sys.argv[1], newline="", encoding="utf-8") as handle:',
      '    rows = list(csv.DictReader(handle))',
      'print(json.dumps(rows))',
    ].join('\n'),
    filePath,
  ]);
  return JSON.parse(output);
}

test('sku seed ingredient match builder emits deterministic candidate matches and unmatched tokens', () => {
  const tempDir = makeTempDir();
  const skuWorkbookPath = path.join(tempDir, 'brand_sku_inventory_seed.xlsx');
  const ingredientWorkbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  const outJson = path.join(tempDir, 'sku_seed_ingredient_match_summary.json');
  const outCsv = path.join(tempDir, 'sku_seed_ingredient_match_candidates.csv');

  createWorkbook(
    ingredientWorkbookPath,
    'Ingredient_Reference_Merged_v2',
    [
      'record_id',
      'canonical_inci_name',
      'canonical_display_name',
      'ingredient_family',
      'us_label_name',
      'eu_label_name',
      'us_label_variants',
      'eu_label_variants',
      'normalized_key',
      'aliases_common',
      'parser_variants',
      'deprecated_aliases',
      'primary_bucket',
    ],
    [
      {
        record_id: 'ING-0001',
        canonical_inci_name: 'Aqua',
        canonical_display_name: 'Aqua',
        ingredient_family: 'solvent',
        us_label_name: 'Water',
        eu_label_name: 'Aqua',
        us_label_variants: 'Water',
        eu_label_variants: 'Aqua; Eau',
        normalized_key: 'aqua',
        aliases_common: 'Water',
        parser_variants: 'Aqua; Water; Eau',
        deprecated_aliases: '',
        primary_bucket: 'hydration',
      },
      {
        record_id: 'ING-0002',
        canonical_inci_name: 'Glycerin',
        canonical_display_name: 'Glycerin',
        ingredient_family: 'humectant',
        us_label_name: 'Glycerin',
        eu_label_name: 'Glycerin',
        us_label_variants: '',
        eu_label_variants: '',
        normalized_key: 'glycerin',
        aliases_common: '',
        parser_variants: 'Glycerin; glycerin',
        deprecated_aliases: '',
        primary_bucket: 'hydration',
      },
      {
        record_id: 'ING-0003',
        canonical_inci_name: 'Niacinamide',
        canonical_display_name: 'Niacinamide',
        ingredient_family: 'vitamin',
        us_label_name: 'Niacinamide',
        eu_label_name: 'Niacinamide',
        us_label_variants: '',
        eu_label_variants: '',
        normalized_key: 'niacinamide',
        aliases_common: 'Vitamin B3',
        parser_variants: 'Niacinamide; niacinamide',
        deprecated_aliases: '',
        primary_bucket: 'repair',
      },
      {
        record_id: 'ING-0004',
        canonical_inci_name: 'Hyaluronic Acid',
        canonical_display_name: 'Hyaluronic Acid',
        ingredient_family: 'humectant',
        us_label_name: 'Hyaluronic Acid',
        eu_label_name: 'Hyaluronic Acid',
        us_label_variants: '',
        eu_label_variants: '',
        normalized_key: 'hyaluronicacid',
        aliases_common: '',
        parser_variants: 'Hyaluronic Acid; hyaluronic acid',
        deprecated_aliases: '',
        primary_bucket: 'hydration',
      },
    ],
  );

  createWorkbook(
    skuWorkbookPath,
    'SKU_Seed_Inventory',
    [
      'brand_name',
      'product_name',
      'official_product_url',
      'market',
      'sku_code',
      'size_options',
      'category',
      'ingredient_granularity',
      'ingredients_or_key_ingredients',
      'source_note',
      'extraction_status',
    ],
    [
      {
        brand_name: 'Brand A',
        product_name: 'Hydrating Serum',
        official_product_url: 'https://example.com/hydrating-serum',
        market: 'US',
        sku_code: '',
        size_options: '',
        category: 'serum',
        ingredient_granularity: 'full_inci_official',
        ingredients_or_key_ingredients: 'Aqua / Water / Eau, Glycerin, Niacinamide',
        source_note: 'official inci',
        extraction_status: 'done',
      },
      {
        brand_name: 'Brand A',
        product_name: 'Brightening Gel',
        official_product_url: 'https://example.com/brightening-gel',
        market: 'US',
        sku_code: '',
        size_options: '',
        category: 'gel',
        ingredient_granularity: 'key_ingredients_official',
        ingredients_or_key_ingredients: 'Vitamin B3; Hyaluronic Acid; Mystery Complex',
        source_note: 'official hero ingredients',
        extraction_status: 'partial_key_ingredients',
      },
    ],
  );

  runPython([
    'scripts/build_sku_seed_ingredient_match_candidates.py',
    '--sku-xlsx',
    skuWorkbookPath,
    '--ingredient-xlsx',
    ingredientWorkbookPath,
    '--out-json',
    outJson,
    '--out-csv',
    outCsv,
  ]);

  const summary = readJson(outJson);
  assert.equal(summary.row_count, 2);
  assert.equal(summary.ingredient_sheet, 'Ingredient_Reference_Merged_v2');
  assert.equal(summary.token_count, 6);
  assert.equal(summary.matched_token_count, 5);
  assert.equal(summary.unmatched_token_count, 1);
  assert.equal(summary.ambiguous_token_count, 0);
  assert.equal(summary.sku_rows_with_any_match, 2);
  assert.equal(summary.recommended_target.table, 'seed_preview.sku_ingredient_reference_match_candidates');

  const rows = readCsvViaPython(outCsv);
  assert.equal(rows.length, 6);

  const aquaRow = rows.find((row) => row.raw_token === 'Aqua / Water / Eau');
  assert.ok(aquaRow);
  assert.equal(aquaRow.match_status, 'matched');
  assert.equal(aquaRow.canonical_inci_name, 'Aqua');
  assert.equal(aquaRow.matched_input_variant_type, 'slash_variant');

  const vitaminB3Row = rows.find((row) => row.raw_token === 'Vitamin B3');
  assert.ok(vitaminB3Row);
  assert.equal(vitaminB3Row.match_status, 'matched');
  assert.equal(vitaminB3Row.canonical_inci_name, 'Niacinamide');
  assert.equal(vitaminB3Row.match_method, 'common_alias');

  const unmatchedRow = rows.find((row) => row.raw_token === 'Mystery Complex');
  assert.ok(unmatchedRow);
  assert.equal(unmatchedRow.match_status, 'unmatched');
  assert.equal(unmatchedRow.canonical_inci_name, '');
});

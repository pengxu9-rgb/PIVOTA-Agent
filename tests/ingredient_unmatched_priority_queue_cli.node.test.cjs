const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-unmatched-queue-cli-'));
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

function readWorkbookSheet(workbookPath, sheetName) {
  const output = runPython([
    '-c',
    [
      'import json, sys',
      'from openpyxl import load_workbook',
      'wb = load_workbook(sys.argv[1], read_only=True, data_only=True)',
      'ws = wb[sys.argv[2]]',
      'rows = list(ws.iter_rows(values_only=True))',
      'header = [str(cell or "").strip() for cell in rows[0]]',
      'items = []',
      'for row in rows[1:]:',
      '    if not any(str(cell or "").strip() for cell in row):',
      '        continue',
      '    item = {header[i]: row[i] for i in range(len(header))}',
      '    items.append(item)',
      'print(json.dumps(items))',
    ].join('\n'),
    workbookPath,
    sheetName,
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

function createMatchCsv(csvPath, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map((column) => JSON.stringify(String(row[column] || ''))).join(','));
  }
  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');
}

test('ingredient unmatched priority queue CLI builds all four queue types from latest unmatched rows', () => {
  const tempDir = makeTempDir();
  const ingredientWorkbook = path.join(tempDir, 'ingredient_reference.xlsx');
  const matchCsv = path.join(tempDir, 'match_candidates.csv');
  const matchSummaryJson = path.join(tempDir, 'match_summary.json');
  const outWorkbook = path.join(tempDir, 'ingredient_unmatched_priority_queue.xlsx');
  const outSummaryJson = path.join(tempDir, 'ingredient_unmatched_priority_queue_summary.json');
  const outAllTriageCsv = path.join(tempDir, 'ingredient_unmatched_priority_all_triage.csv');

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
      canonical_inci_name: 'Sodium Hydroxide',
      canonical_display_name: 'Sodium Hydroxide',
      us_label_name: 'Sodium Hydroxide',
      eu_label_name: 'Sodium Hydroxide',
      parser_variants: 'Sodium Hydroxide; sodium hydroxide',
      aliases_common: '',
      us_label_variants: '',
      eu_label_variants: '',
      deprecated_aliases: '',
      normalized_key: 'sodiumhydroxide',
    },
  ];

  createIngredientWorkbook(ingredientWorkbook, ingredientHeader, ingredientRows);

  const matchHeader = [
    'candidate_match_key',
    'sku_row_key',
    'brand_name',
    'product_name',
    'official_product_url',
    'category',
    'ingredient_granularity',
    'raw_token',
    'token_normalized',
    'match_status',
  ];

  const matchRows = [
    {
      candidate_match_key: '1',
      sku_row_key: 'sku-1',
      brand_name: 'BrandA',
      product_name: 'ProductA',
      official_product_url: 'https://example.com/a',
      category: 'moisturizer',
      ingredient_granularity: 'full_inci_official',
      raw_token: 'Ethylhexyl Isononanoate',
      token_normalized: 'ethylhexylisononanoate',
      match_status: 'unmatched',
    },
    {
      candidate_match_key: '2',
      sku_row_key: 'sku-2',
      brand_name: 'BrandB',
      product_name: 'ProductB',
      official_product_url: 'https://example.com/b',
      category: 'serum',
      ingredient_granularity: 'full_inci_official',
      raw_token: 'TROMETHAMINE',
      token_normalized: 'tromethamine',
      match_status: 'unmatched',
    },
    {
      candidate_match_key: '3',
      sku_row_key: 'sku-3',
      brand_name: 'BrandC',
      product_name: 'ProductC',
      official_product_url: 'https://example.com/c',
      category: 'moisturizer',
      ingredient_granularity: 'key_ingredients_official',
      raw_token: 'Ceramides',
      token_normalized: 'ceramides',
      match_status: 'unmatched',
    },
    {
      candidate_match_key: '4',
      sku_row_key: 'sku-4',
      brand_name: 'BrandD',
      product_name: 'ProductD',
      official_product_url: 'https://example.com/d',
      category: 'cleanser',
      ingredient_granularity: 'full_inci_official',
      raw_token: 'Sodium Hydroxide',
      token_normalized: 'sodiumhydroxide',
      match_status: 'unmatched',
    },
    {
      candidate_match_key: '5',
      sku_row_key: 'sku-5',
      brand_name: 'BrandE',
      product_name: 'ProductE',
      official_product_url: 'https://example.com/e',
      category: 'sunscreen',
      ingredient_granularity: 'full_inci_official',
      raw_token: 'Active Ingredients: Petrolatum 60%',
      token_normalized: 'activeingredientspetrolatum60',
      match_status: 'unmatched',
    },
  ];

  createMatchCsv(matchCsv, matchHeader, matchRows);
  fs.writeFileSync(
    matchSummaryJson,
    `${JSON.stringify({
      token_count: 100,
      matched_token_count: 95,
      unmatched_token_count: 5,
      ambiguous_token_count: 0,
    }, null, 2)}\n`,
    'utf8',
  );

  runPython([
    'scripts/build_ingredient_unmatched_priority_queue.py',
    '--match-csv',
    matchCsv,
    '--ingredient-xlsx',
    ingredientWorkbook,
    '--match-summary-json',
    matchSummaryJson,
    '--out-xlsx',
    outWorkbook,
    '--out-json',
    outSummaryJson,
    '--out-all-triage-csv',
    outAllTriageCsv,
  ]);

  const summary = readJson(outSummaryJson);
  assert.equal(summary.full_inci_priority_rows, 1);
  assert.equal(summary.alias_normalization_rows, 1);
  assert.equal(summary.signal_or_family_rows, 1);
  assert.equal(summary.verify_parser_rows, 1);
  assert.equal(summary.manual_review_rows, 1);
  assert.equal(summary.all_triage_rows, 5);

  const fullInciRows = readWorkbookSheet(outWorkbook, 'Full_INCI_Priority_Queue');
  assert.equal(fullInciRows.length, 1);
  assert.equal(fullInciRows[0].raw_token, 'Ethylhexyl Isononanoate');

  const aliasRows = readWorkbookSheet(outWorkbook, 'Alias_Normalization_Queue');
  assert.equal(aliasRows.length, 1);
  assert.equal(aliasRows[0].raw_token, 'TROMETHAMINE');

  const signalRows = readWorkbookSheet(outWorkbook, 'Signal_Review_Queue');
  assert.equal(signalRows.length, 1);
  assert.equal(signalRows[0].raw_token, 'Ceramides');

  const verifyRows = readWorkbookSheet(outWorkbook, 'Verify_Parser_Queue');
  assert.equal(verifyRows.length, 1);
  assert.equal(verifyRows[0].raw_token, 'Sodium Hydroxide');
  assert.equal(verifyRows[0].in_current_master_like, true);

  const manualRows = readWorkbookSheet(outWorkbook, 'Manual_Review_Queue');
  assert.equal(manualRows.length, 1);
  assert.equal(manualRows[0].raw_token, 'Active Ingredients: Petrolatum 60%');
});

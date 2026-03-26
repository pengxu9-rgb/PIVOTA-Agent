const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-full-inci-cli-'));
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

function readWorkbookSummary(workbookPath) {
  const output = runPython([
    '-c',
    [
      'import json, sys',
      'from openpyxl import load_workbook',
      'wb = load_workbook(sys.argv[1], read_only=True, data_only=True)',
      "main = wb['Ingredient_Reference_Merged_v2']",
      "new_rows = wb['New_Rows_Only']",
      "readme = wb['README']",
      'metrics = {}',
      'for row in readme.iter_rows(values_only=True):',
      '    key = str(row[0] or "").strip()',
      '    if key:',
      '        metrics[key] = row[1]',
      'print(json.dumps({',
      '    "main_rows": main.max_row,',
      '    "new_rows_rows": new_rows.max_row,',
      '    "metrics": metrics,',
      '}))',
    ].join('\n'),
    workbookPath,
  ]);
  return JSON.parse(output);
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
      "readme = ws",
      "readme.title = 'README'",
      "readme.append(['base_rows', 500])",
      "readme.append(['new_canonical_patch_rows', 216])",
      "readme.append(['new_canonical_rows_appended', 216])",
      "readme.append(['merged_total_rows', 716])",
      "ws = wb.create_sheet('Ingredient_Reference_Merged_v2')",
      "ws.title = 'Ingredient_Reference_Merged_v2'",
      'ws.append(header)',
      'for row in rows:',
      '    ws.append([row.get(col, "") for col in header])',
      'new_rows = wb.create_sheet("New_Rows_Only")',
      'new_rows.append(header)',
      'for row in rows:',
      '    new_rows.append([row.get(col, "") for col in header])',
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
      "ws.title = 'Full_INCI_Priority_Queue'",
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

test('full INCI priority patch export splits clean candidates from review blockers', () => {
  const tempDir = makeTempDir();
  const ingredientWorkbook = path.join(tempDir, 'ingredient_reference.xlsx');
  const queueWorkbook = path.join(tempDir, 'priority_queue.xlsx');
  const outApplyCsv = path.join(tempDir, 'ingredient_full_inci_apply.csv');
  const outReviewCsv = path.join(tempDir, 'ingredient_full_inci_review.csv');
  const outSummaryJson = path.join(tempDir, 'ingredient_full_inci_summary.json');

  const ingredientHeader = [
    'record_id',
    'canonical_inci_name',
    'canonical_display_name',
    'ingredient_family',
    'us_label_name',
    'eu_label_name',
    'us_label_variants',
    'eu_label_variants',
    'cross_market_notes',
    'normalized_key',
    'aliases_common',
    'parser_variants',
    'deprecated_aliases',
    'alias_quality',
    'notes_for_parser',
    'primary_bucket',
    'all_buckets',
    'function_tags',
    'benefit_tags',
    'risk_flags',
    'is_humectant',
    'is_barrier_support',
    'is_retinoid',
    'is_exfoliant',
    'is_uv_filter',
    'is_preservative',
    'is_surfactant',
    'is_fragrance_or_eo',
    'regulatory_bucket',
    'source_urls',
    'source_authorities',
    'source_types',
    'review_status',
    'confidence',
    'last_reviewed_at',
    'review_notes',
    'notes',
    'kb_version',
  ];

  const ingredientRows = [
    {
      record_id: 'ING-0001',
      canonical_inci_name: 'Actinidia Chinensis Fruit Extract',
      canonical_display_name: 'Actinidia Chinensis Fruit Extract',
      ingredient_family: 'plant_extract',
      us_label_name: 'Actinidia Chinensis Fruit Extract',
      eu_label_name: 'Actinidia Chinensis Fruit Extract',
      us_label_variants: 'Actinidia Chinensis Fruit Extract',
      eu_label_variants: 'Actinidia Chinensis Fruit Extract',
      normalized_key: 'actinidiachinensisfruitextract',
      parser_variants: 'Actinidia Chinensis Fruit Extract',
      review_status: 'draft',
      confidence: 'medium',
    },
    {
      record_id: 'ing_patch_v13_219',
      canonical_inci_name: 'Ximenia Americana Seed Oil',
      canonical_display_name: 'Ximenia Americana Seed Oil',
      ingredient_family: 'other',
      us_label_name: 'Ximenia Americana Seed Oil',
      eu_label_name: 'Ximenia Americana Seed Oil',
      us_label_variants: 'Ximenia Americana Seed Oil',
      eu_label_variants: 'Ximenia Americana Seed Oil',
      normalized_key: 'ximeniaamericanaseedoil',
      parser_variants: 'Ximenia Americana Seed Oil',
      review_status: 'draft',
      confidence: 'low',
    },
  ];

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
      priority_score: '69',
      recommended_bucket: 'candidate_canonical_full_inci',
      recommended_action: 'append_new_canonical_candidate',
      triage_reason: 'Looks like a stable INCI token.',
      raw_token: 'Ethylhexyl Isononanoate',
      normalized_token: 'ethylhexylisononanoate',
      unmatched_count: '3',
      sku_row_count: '3',
      full_inci_count: '3',
      key_count: '0',
      product_only_count: '0',
      top_categories: 'moisturizer:3',
      example_brands: 'EltaMD',
      example_products: 'Barrier Renewal Complex',
      example_urls: 'https://example.com/eltamd',
      in_current_master_like: 'False',
    },
    {
      priority_score: '43',
      recommended_bucket: 'candidate_canonical_full_inci',
      recommended_action: 'append_new_canonical_candidate',
      triage_reason: 'Parser contamination example.',
      raw_token: 'Active Ingredients: Petrolatum 60%',
      normalized_token: 'activeingredientspetrolatum60',
      unmatched_count: '1',
      sku_row_count: '1',
      full_inci_count: '1',
      key_count: '0',
      product_only_count: '0',
      top_categories: 'balm:1',
      example_brands: 'EltaMD',
      example_products: 'Laser Balm',
      example_urls: 'https://example.com/laser-balm',
      in_current_master_like: 'False',
    },
    {
      priority_score: '43',
      recommended_bucket: 'candidate_canonical_full_inci',
      recommended_action: 'append_new_canonical_candidate',
      triage_reason: 'Parenthetical near-duplicate example.',
      raw_token: 'Actinidia Chinensis (Kiwi) Fruit Extract',
      normalized_token: 'actinidiachinensiskiwifruitextract',
      unmatched_count: '2',
      sku_row_count: '2',
      full_inci_count: '2',
      key_count: '0',
      product_only_count: '0',
      top_categories: 'moisturizer:2',
      example_brands: 'EltaMD',
      example_products: 'Barrier Renewal Complex',
      example_urls: 'https://example.com/barrier-renewal',
      in_current_master_like: 'False',
    },
  ];

  createIngredientWorkbook(ingredientWorkbook, ingredientHeader, ingredientRows);
  createQueueWorkbook(queueWorkbook, queueHeader, queueRows);

  runPython([
    'scripts/export_ingredient_full_inci_priority_patch.py',
    '--queue-xlsx',
    queueWorkbook,
    '--ingredient-xlsx',
    ingredientWorkbook,
    '--out-apply-csv',
    outApplyCsv,
    '--out-review-csv',
    outReviewCsv,
    '--out-summary-json',
    outSummaryJson,
  ]);

  const summary = readJson(outSummaryJson);
  assert.equal(summary.apply_ready_count, 1);
  assert.equal(summary.review_count, 2);
  assert.equal(summary.record_id_start, 'ing_patch_v13_220');
  assert.equal(summary.record_id_end, 'ing_patch_v13_220');

  const applyRows = readCsv(outApplyCsv);
  assert.equal(applyRows.length, 1);
  assert.equal(applyRows[0].record_id, 'ing_patch_v13_220');
  assert.equal(applyRows[0].canonical_inci_name, 'Ethylhexyl Isononanoate');
  assert.equal(applyRows[0].normalized_key, 'ethylhexylisononanoate');
  assert.equal(applyRows[0].queue_priority_score, '69');

  const reviewRows = readCsv(outReviewCsv);
  assert.equal(reviewRows.length, 2);

  const parserBlocked = reviewRows.find((row) => row.raw_token === 'Active Ingredients: Petrolatum 60%');
  assert.ok(parserBlocked.review_reason_codes.includes('parser_contaminated_percent_token'));
  assert.ok(parserBlocked.review_reason_codes.includes('parser_contaminated_active_inactive_segment'));

  const semanticBlocked = reviewRows.find((row) => row.raw_token === 'Actinidia Chinensis (Kiwi) Fruit Extract');
  assert.equal(semanticBlocked.review_reason_codes, 'existing_semantic_key_conflict');
  assert.equal(semanticBlocked.existing_record_ids, 'ING-0001');
  assert.equal(semanticBlocked.existing_canonical_inci_names, 'Actinidia Chinensis Fruit Extract');
});

test('new canonical apply CLI appends patch rows into a workbook copy and updates README metrics', () => {
  const tempDir = makeTempDir();
  const ingredientWorkbook = path.join(tempDir, 'ingredient_reference.xlsx');
  const queueWorkbook = path.join(tempDir, 'priority_queue.xlsx');
  const outApplyCsv = path.join(tempDir, 'ingredient_full_inci_apply.csv');
  const outReviewCsv = path.join(tempDir, 'ingredient_full_inci_review.csv');
  const outSummaryJson = path.join(tempDir, 'ingredient_full_inci_summary.json');
  const outWorkbook = path.join(tempDir, 'ingredient_reference_patched.xlsx');
  const outReportJson = path.join(tempDir, 'ingredient_reference_patched_report.json');

  const ingredientHeader = [
    'record_id',
    'canonical_inci_name',
    'canonical_display_name',
    'ingredient_family',
    'us_label_name',
    'eu_label_name',
    'us_label_variants',
    'eu_label_variants',
    'cross_market_notes',
    'normalized_key',
    'aliases_common',
    'parser_variants',
    'deprecated_aliases',
    'alias_quality',
    'notes_for_parser',
    'primary_bucket',
    'all_buckets',
    'function_tags',
    'benefit_tags',
    'risk_flags',
    'is_humectant',
    'is_barrier_support',
    'is_retinoid',
    'is_exfoliant',
    'is_uv_filter',
    'is_preservative',
    'is_surfactant',
    'is_fragrance_or_eo',
    'regulatory_bucket',
    'source_urls',
    'source_authorities',
    'source_types',
    'review_status',
    'confidence',
    'last_reviewed_at',
    'review_notes',
    'notes',
    'kb_version',
  ];

  const ingredientRows = [
    {
      record_id: 'ING-0001',
      canonical_inci_name: 'Actinidia Chinensis Fruit Extract',
      canonical_display_name: 'Actinidia Chinensis Fruit Extract',
      ingredient_family: 'plant_extract',
      us_label_name: 'Actinidia Chinensis Fruit Extract',
      eu_label_name: 'Actinidia Chinensis Fruit Extract',
      us_label_variants: 'Actinidia Chinensis Fruit Extract',
      eu_label_variants: 'Actinidia Chinensis Fruit Extract',
      normalized_key: 'actinidiachinensisfruitextract',
      parser_variants: 'Actinidia Chinensis Fruit Extract',
      review_status: 'draft',
      confidence: 'medium',
    },
  ];

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
      priority_score: '69',
      recommended_bucket: 'candidate_canonical_full_inci',
      recommended_action: 'append_new_canonical_candidate',
      triage_reason: 'Looks like a stable INCI token.',
      raw_token: 'Ethylhexyl Isononanoate',
      normalized_token: 'ethylhexylisononanoate',
      unmatched_count: '3',
      sku_row_count: '3',
      full_inci_count: '3',
      key_count: '0',
      product_only_count: '0',
      top_categories: 'moisturizer:3',
      example_brands: 'EltaMD',
      example_products: 'Barrier Renewal Complex',
      example_urls: 'https://example.com/eltamd',
      in_current_master_like: 'False',
    },
  ];

  createIngredientWorkbook(ingredientWorkbook, ingredientHeader, ingredientRows);
  createQueueWorkbook(queueWorkbook, queueHeader, queueRows);

  runPython([
    'scripts/export_ingredient_full_inci_priority_patch.py',
    '--queue-xlsx',
    queueWorkbook,
    '--ingredient-xlsx',
    ingredientWorkbook,
    '--out-apply-csv',
    outApplyCsv,
    '--out-review-csv',
    outReviewCsv,
    '--out-summary-json',
    outSummaryJson,
  ]);

  runPython([
    'scripts/apply_ingredient_new_canonical_patch.py',
    '--ingredient-xlsx',
    ingredientWorkbook,
    '--patch-csv',
    outApplyCsv,
    '--out-xlsx',
    outWorkbook,
    '--out-report-json',
    outReportJson,
  ]);

  const report = readJson(outReportJson);
  assert.equal(report.applied_count, 1);
  assert.equal(report.skipped_conflict_count, 0);
  assert.equal(report.skipped_invalid_count, 0);

  const workbookSummary = readWorkbookSummary(outWorkbook);
  assert.equal(workbookSummary.main_rows, 3);
  assert.equal(workbookSummary.new_rows_rows, 3);
  assert.equal(workbookSummary.metrics.new_canonical_patch_rows, 217);
  assert.equal(workbookSummary.metrics.new_canonical_rows_appended, 217);
  assert.equal(workbookSummary.metrics.merged_total_rows, 717);
  assert.equal(workbookSummary.metrics.v2_2_full_inci_priority_apply_rows, 1);
});

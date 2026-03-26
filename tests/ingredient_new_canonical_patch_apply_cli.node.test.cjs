const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-new-canonical-apply-'));
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

function createWorkbook(workbookPath, header, rows) {
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
      "ws.title = 'README'",
      "ws.append(['new_canonical_patch_rows', 10])",
      "ws.append(['new_canonical_rows_appended', 10])",
      "ws.append(['merged_total_rows', 110])",
      "main = wb.create_sheet('Ingredient_Reference_Merged_v2')",
      'main.append(header)',
      'for row in rows:',
      '    main.append([row.get(col, "") for col in header])',
      'new_rows = wb.create_sheet("New_Rows_Only")',
      'new_rows.append(header)',
      'wb.save(path)',
    ].join('\n'),
    workbookPath,
    JSON.stringify(header),
    JSON.stringify(rows),
  ]);
}

function readWorkbookState(workbookPath) {
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
      'print(json.dumps({"main_rows": main.max_row, "new_rows_rows": new_rows.max_row, "metrics": metrics}))',
    ].join('\n'),
    workbookPath,
  ]);
  return JSON.parse(output);
}

test('apply new canonical patch supports custom README metric prefix and note', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  const patchCsv = path.join(tempDir, 'patch.csv');
  const outWorkbook = path.join(tempDir, 'ingredient_reference_v2_3.xlsx');
  const outReport = path.join(tempDir, 'apply_report.json');

  const header = [
    'record_id',
    'canonical_inci_name',
    'canonical_display_name',
    'ingredient_family',
    'us_label_name',
    'eu_label_name',
    'normalized_key',
    'aliases_common',
    'parser_variants',
    'review_status',
    'confidence',
  ];

  createWorkbook(workbookPath, header, [
    {
      record_id: 'ING-0001',
      canonical_inci_name: 'Glycerin',
      canonical_display_name: 'Glycerin',
      ingredient_family: 'humectant',
      us_label_name: 'Glycerin',
      eu_label_name: 'Glycerin',
      normalized_key: 'glycerin',
      parser_variants: 'Glycerin',
      review_status: 'reviewed',
      confidence: 'high',
    },
  ]);

  writeCsv(patchCsv, [...header, 'semantic_match_key'], [
    {
      record_id: 'ing_patch_v13_303',
      canonical_inci_name: 'Tromethamine',
      canonical_display_name: 'Tromethamine',
      ingredient_family: 'other',
      us_label_name: 'Tromethamine',
      eu_label_name: 'Tromethamine',
      normalized_key: 'tromethamine',
      aliases_common: '',
      parser_variants: 'Tromethamine; TROMETHAMINE',
      review_status: 'draft',
      confidence: 'medium',
      semantic_match_key: 'tromethamine',
    },
  ]);

  runPython([
    'scripts/apply_ingredient_new_canonical_patch.py',
    '--ingredient-xlsx', workbookPath,
    '--patch-csv', patchCsv,
    '--out-xlsx', outWorkbook,
    '--out-report-json', outReport,
    '--readme-metric-prefix', 'v2_3_alias_normalization_candidate',
    '--readme-note', 'Applied alias normalization candidate canonical patch into a new workbook copy.',
  ]);

  const workbookState = readWorkbookState(outWorkbook);
  const report = JSON.parse(fs.readFileSync(outReport, 'utf8'));

  assert.equal(workbookState.main_rows, 3);
  assert.equal(workbookState.new_rows_rows, 2);
  assert.equal(workbookState.metrics.new_canonical_patch_rows, 11);
  assert.equal(workbookState.metrics.new_canonical_rows_appended, 11);
  assert.equal(workbookState.metrics.merged_total_rows, 111);
  assert.equal(workbookState.metrics.v2_3_alias_normalization_candidate_apply_rows, 1);
  assert.equal(
    workbookState.metrics.v2_3_alias_normalization_candidate_note,
    'Applied alias normalization candidate canonical patch into a new workbook copy.'
  );
  assert.ok(
    String(workbookState.metrics.v2_3_alias_normalization_candidate_patch_csv).endsWith('/patch.csv')
  );
  assert.equal(workbookState.metrics.v2_2_full_inci_priority_apply_rows, undefined);
  assert.equal(report.applied_count, 1);
  assert.equal(report.readme_metric_prefix, 'v2_3_alias_normalization_candidate');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-alias-writeback-'));
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

function readWorkbookRow(workbookPath) {
  const output = runPython([
    '-c',
    [
      'import json, sys',
      'from openpyxl import load_workbook',
      'wb = load_workbook(sys.argv[1], read_only=True, data_only=True)',
      "ws = wb['Ingredient_Reference_Merged_v2']",
      'header = [str(cell or "").strip() for cell in next(ws.iter_rows(values_only=True))]',
      'row = [str(cell or "").strip() for cell in next(ws.iter_rows(min_row=2, values_only=True))]',
      'print(json.dumps(dict(zip(header, row))))',
    ].join('\n'),
    workbookPath,
  ]);
  return JSON.parse(output);
}

test('apply alias writeback patch updates parser_variants on Ingredient_Reference_Merged_v2', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  const patchCsv = path.join(tempDir, 'alias_patch.csv');
  const outWorkbook = path.join(tempDir, 'ingredient_reference_patched.xlsx');
  const outReport = path.join(tempDir, 'alias_patch_report.json');

  const header = [
    'record_id',
    'canonical_inci_name',
    'aliases_common',
    'parser_variants',
    'alias_quality',
  ];

  createWorkbook(workbookPath, header, [
    {
      record_id: 'ING-0305',
      canonical_inci_name: 'Titanium Dioxide',
      aliases_common: '',
      parser_variants: 'Titanium Dioxide; titanium dioxide',
      alias_quality: '',
    },
  ]);

  writeCsv(patchCsv, [
    'record_id',
    'canonical_inci_name',
    'existing_aliases_common',
    'existing_parser_variants',
    'existing_alias_quality',
    'patch_aliases_common',
    'patch_parser_variants',
    'patch_alias_quality',
    'proposal_sources',
    'quality_reason',
  ], [
    {
      record_id: 'ING-0305',
      canonical_inci_name: 'Titanium Dioxide',
      existing_aliases_common: '',
      existing_parser_variants: 'Titanium Dioxide; titanium dioxide',
      existing_alias_quality: '',
      patch_aliases_common: 'CI 77891 (TITANIUM DIOXIDE)',
      patch_parser_variants: 'Titanium Dioxide; titanium dioxide; CI 77891 (TITANIUM DIOXIDE)',
      patch_alias_quality: 'exact_label_alias',
      proposal_sources: 'alias_manual_mapping_workbench',
      quality_reason: 'manual',
    },
  ]);

  runPython([
    'scripts/apply_ingredient_alias_writeback_patch.py',
    '--ingredient-xlsx', workbookPath,
    '--patch-csv', patchCsv,
    '--out-xlsx', outWorkbook,
    '--out-report-json', outReport,
  ]);

  const row = readWorkbookRow(outWorkbook);
  const report = JSON.parse(fs.readFileSync(outReport, 'utf8'));

  assert.equal(row.aliases_common, 'CI 77891 (TITANIUM DIOXIDE)');
  assert.equal(row.parser_variants, 'Titanium Dioxide; titanium dioxide; CI 77891 (TITANIUM DIOXIDE)');
  assert.equal(row.alias_quality, 'exact_label_alias');
  assert.equal(report.target_sheet, 'Ingredient_Reference_Merged_v2');
  assert.equal(report.applied_count, 1);
});

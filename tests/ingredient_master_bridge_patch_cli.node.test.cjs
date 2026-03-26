const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('build_ingredient_master_bridge_patch builds apply-ready alias/parser patch rows', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-master-bridge-patch-'));
  const bridgeCsv = path.join(tempDir, 'bridge.csv');
  const ingredientXlsx = path.join(tempDir, 'ingredient.xlsx');
  const outPatch = path.join(tempDir, 'patch.csv');
  const outSummary = path.join(tempDir, 'summary.json');

  fs.writeFileSync(
    bridgeCsv,
    [
      'signal_key,display_signal_name,reference_match_display_name,reference_match_inci_name',
      'calendula,Calendula,Calendula Officinalis Flower Extract,Calendula Officinalis Flower Extract',
      'glycerin,pure glycerin,Glycerin,Glycerin',
    ].join('\n') + '\n',
    'utf8',
  );

  const workbookResult = spawnSync(
    'python3',
    [
      '-c',
      `
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = 'Ingredient_Reference_Merged_v2'
ws.append(['record_id','canonical_inci_name','canonical_display_name','aliases_common','parser_variants','alias_quality'])
ws.append(['ING-0073','Calendula Officinalis Flower Extract','Calendula Officinalis Flower Extract','calendula officinalis flower extract','Calendula Officinalis Flower Extract; calendula officinalis flower extract','exact_label_alias'])
ws.append(['ING-0021','Glycerin','Glycerin','Glycerol','Glycerin; Glycerol; glycerin; glycerol','common_alias'])
wb.save(r'''${ingredientXlsx}''')
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(workbookResult.status, 0, workbookResult.stderr);

  const result = spawnSync(
    'python3',
    [
      'scripts/build_ingredient_master_bridge_patch.py',
      '--bridge-csv',
      bridgeCsv,
      '--ingredient-xlsx',
      ingredientXlsx,
      '--out-patch-csv',
      outPatch,
      '--out-summary-json',
      outSummary,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(fs.readFileSync(outSummary, 'utf8'));
  assert.equal(summary.patch_row_count, 2);

  const patchText = fs.readFileSync(outPatch, 'utf8');
  assert.match(patchText, /Calendula/);
  assert.match(patchText, /common_alias/);
  assert.match(patchText, /Pure Glycerin/);
  assert.match(patchText, /ingredient_master_followup_existing_bridge/);
});

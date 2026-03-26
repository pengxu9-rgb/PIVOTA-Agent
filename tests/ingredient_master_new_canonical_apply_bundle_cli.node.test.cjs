const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function writeCsv(filePath, fieldnames, rows) {
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(
      fieldnames
        .map((field) => {
          const raw = String(row[field] ?? '');
          if (/[",\n]/.test(raw)) {
            return `"${raw.replace(/"/g, '""')}"`;
          }
          return raw;
        })
        .join(','),
    );
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

test('build_ingredient_master_new_canonical_apply_bundle splits apply-ready and hold rows', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-master-apply-bundle-'));
  const decisionCsv = path.join(tempDir, 'decision.csv');
  const termsCsv = path.join(tempDir, 'terms.csv');
  const ingredientXlsx = path.join(tempDir, 'ingredient.xlsx');
  const outApply = path.join(tempDir, 'apply.csv');
  const outHold = path.join(tempDir, 'hold.csv');
  const outSummary = path.join(tempDir, 'summary.json');
  const outXlsx = path.join(tempDir, 'bundle.xlsx');

  writeCsv(
    decisionCsv,
    [
      'signal_key',
      'display_signal_name',
      'decision_status',
      'recommended_master_action',
      'recommended_candidate_display_name',
      'recommended_candidate_inci_name',
      'ingredient_master_ready',
      'canonical_writeback_ready',
      'runtime_evidence_eligible',
      'decision_basis',
      'source_urls',
      'example_brands',
      'example_products',
      'reviewer_notes',
    ],
    [
      {
        signal_key: 'viniferine',
        display_signal_name: 'Viniferine',
        decision_status: 'approved_rewrite_to_underlying_inci_candidate',
        recommended_master_action: 'open_new_canonical_candidate__palmitoyl_grapevine_shoot_extract',
        recommended_candidate_display_name: 'Palmitoyl Grapevine Shoot Extract',
        recommended_candidate_inci_name: 'Palmitoyl Grapevine Shoot Extract',
        ingredient_master_ready: 'candidate_only',
        canonical_writeback_ready: 'no',
        runtime_evidence_eligible: 'no',
        decision_basis: 'official source rewrite',
        source_urls: 'https://example.com/viniferine',
        example_brands: 'Caudalie',
        example_products: 'Serum',
        reviewer_notes: 'note',
      },
      {
        signal_key: 'thiamidol',
        display_signal_name: 'Thiamidol',
        decision_status: 'approved_hold_named_active_pending_exact_label_confirmation',
        recommended_master_action: 'keep_signal_only_until_exact_inci_confirmed',
        recommended_candidate_display_name: 'Thiamidol',
        recommended_candidate_inci_name: '',
        ingredient_master_ready: 'hold',
        canonical_writeback_ready: 'no',
        runtime_evidence_eligible: 'no',
        decision_basis: 'hold',
        source_urls: 'https://example.com/thiamidol',
        example_brands: 'Eucerin',
        example_products: 'Spot Corrector',
        reviewer_notes: 'hold',
      },
    ],
  );

  writeCsv(
    termsCsv,
    ['signal_key', 'followup_priority'],
    [
      { signal_key: 'viniferine', followup_priority: 'high' },
      { signal_key: 'thiamidol', followup_priority: 'high' },
    ],
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
ws.append(['record_id'])
ws.append(['ING-0001'])
ws.append(['ing_patch_v13_400'])
wb.save(r'''${ingredientXlsx}''')
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(workbookResult.status, 0, workbookResult.stderr);

  const result = spawnSync(
    'python3',
    [
      'scripts/build_ingredient_master_new_canonical_apply_bundle.py',
      '--decision-csv',
      decisionCsv,
      '--terms-csv',
      termsCsv,
      '--ingredient-xlsx',
      ingredientXlsx,
      '--out-apply-csv',
      outApply,
      '--out-hold-csv',
      outHold,
      '--out-summary-json',
      outSummary,
      '--out-xlsx',
      outXlsx,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(fs.readFileSync(outSummary, 'utf8'));
  assert.equal(summary.apply_ready_count, 1);
  assert.equal(summary.hold_count, 1);

  const applyText = fs.readFileSync(outApply, 'utf8');
  assert.match(applyText, /ing_patch_v13_401/);
  assert.match(applyText, /Palmitoyl Grapevine Shoot Extract/);
  assert.match(applyText, /reviewed_signal_followup_rewrite_to_inci_candidate/);

  const holdText = fs.readFileSync(outHold, 'utf8');
  assert.match(holdText, /Thiamidol/);
  assert.ok(fs.existsSync(outXlsx));
});

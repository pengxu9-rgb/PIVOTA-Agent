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

test('autofill_sku_ingredient_signal_decisions and export_sku_ingredient_signal_downstream_handoff create approved handoff rows', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-handoff-'));
  const decisionCsv = path.join(tempDir, 'decision.csv');
  const autofilledCsv = path.join(tempDir, 'decision_autofilled.csv');
  const approvedCsv = path.join(tempDir, 'approved.csv');
  const remainderCsv = path.join(tempDir, 'remainder.csv');
  const summaryJson = path.join(tempDir, 'summary.json');

  writeCsv(
    decisionCsv,
    [
      'brand_name',
      'product_name',
      'official_product_url',
      'market',
      'category',
      'sku_row_key',
      'recommended_review_action',
      'canonical_ingredients',
      'signal_display_names',
      'signal_keys',
      'parser_excluded_fragments',
      'suggested_follow_up',
      'suggestion_confidence',
      'decision_rationale',
      'decision',
      'approved_follow_up',
      'reviewer_notes',
    ],
    [
      {
        brand_name: 'BrandA',
        product_name: 'ProdA',
        official_product_url: 'https://example.com/a',
        market: 'US',
        category: 'cream',
        sku_row_key: 'sku-1',
        recommended_review_action: 'review_parser_fragment_series',
        canonical_ingredients: 'Niacinamide',
        signal_display_names: 'Vitamins B',
        signal_keys: 'vitamins_b',
        parser_excluded_fragments: 'C; and E',
        suggested_follow_up: 'keep_current_coverage_and_do_not_promote_fragments_as_ingredients',
        suggestion_confidence: 'high',
        decision_rationale: 'parser rationale',
        decision: '',
        approved_follow_up: '',
        reviewer_notes: '',
      },
      {
        brand_name: 'BrandB',
        product_name: 'ProdB',
        official_product_url: 'https://example.com/b',
        market: 'US',
        category: 'serum',
        sku_row_key: 'sku-2',
        recommended_review_action: 'review_signal_led_sku',
        canonical_ingredients: '',
        signal_display_names: 'Miracle Broth™',
        signal_keys: 'miracle_broth',
        parser_excluded_fragments: '',
        suggested_follow_up: 'keep_as_signal_led_preview_and_require_reviewed_evidence_before_runtime_evidence_ingest',
        suggestion_confidence: 'medium',
        decision_rationale: 'signal rationale',
        decision: '',
        approved_follow_up: '',
        reviewer_notes: '',
      },
    ],
  );

  const autofillResult = spawnSync(
    'python3',
    [
      'scripts/autofill_sku_ingredient_signal_decisions.py',
      '--decision-csv',
      decisionCsv,
      '--out-csv',
      autofilledCsv,
      '--approve-action',
      'review_parser_fragment_series',
      '--only-empty-decision',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(autofillResult.status, 0, autofillResult.stderr);

  const exportResult = spawnSync(
    'python3',
    [
      'scripts/export_sku_ingredient_signal_downstream_handoff.py',
      '--decision-csv',
      autofilledCsv,
      '--out-approved-csv',
      approvedCsv,
      '--out-remainder-csv',
      remainderCsv,
      '--out-summary-json',
      summaryJson,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(exportResult.status, 0, exportResult.stderr);

  const summary = JSON.parse(fs.readFileSync(summaryJson, 'utf8'));
  assert.equal(summary.approved_count, 1);
  assert.equal(summary.remainder_count, 1);
  assert.equal(
    summary.approved_handoff_path_counts.keep_current_coverage_and_do_not_promote_fragments_as_ingredients,
    1,
  );

  const approvedText = fs.readFileSync(approvedCsv, 'utf8');
  assert.match(approvedText, /sku-1/);
  assert.match(approvedText, /keep_current_coverage_and_do_not_promote_fragments_as_ingredients/);

  const remainderText = fs.readFileSync(remainderCsv, 'utf8');
  assert.match(remainderText, /sku-2/);
});

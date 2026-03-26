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

test('build_sku_ingredient_signal_manual_handoff_queue combines multiple decision packets into one manual queue workbook', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-manual-handoff-'));
  const decisionA = path.join(tempDir, 'signal_led.csv');
  const decisionB = path.join(tempDir, 'hybrid.csv');
  const outCsv = path.join(tempDir, 'manual_queue.csv');
  const outJson = path.join(tempDir, 'summary.json');
  const outXlsx = path.join(tempDir, 'manual_queue.xlsx');

  const fieldnames = [
    'review_priority_score',
    'brand_name',
    'product_name',
    'official_product_url',
    'market',
    'category',
    'sku_row_key',
    'recommended_review_action',
    'recommended_review_reason',
    'token_count',
    'ingredient_match_count',
    'signal_match_count',
    'parser_cleanup_count',
    'curated_signal_tail_count',
    'parser_fragment_exclusion_count',
    'canonical_ingredients',
    'signal_display_names',
    'signal_keys',
    'suggested_decision',
    'suggested_follow_up',
    'suggestion_confidence',
    'decision_rationale',
    'decision',
    'approved_follow_up',
    'reviewer_notes',
  ];

  writeCsv(decisionA, fieldnames, [
    {
      review_priority_score: '60',
      brand_name: 'BrandA',
      product_name: 'ProdA',
      official_product_url: 'https://example.com/a',
      market: 'US',
      category: 'serum',
      sku_row_key: 'sku-1',
      recommended_review_action: 'review_signal_led_sku',
      recommended_review_reason: 'signal',
      token_count: '2',
      ingredient_match_count: '0',
      signal_match_count: '2',
      parser_cleanup_count: '0',
      curated_signal_tail_count: '1',
      parser_fragment_exclusion_count: '0',
      canonical_ingredients: '',
      signal_display_names: 'Miracle Broth™',
      signal_keys: 'miracle_broth',
      suggested_decision: 'confirm_signal_only_sku',
      suggested_follow_up: 'keep_as_signal_led_preview_and_require_reviewed_evidence_before_runtime_evidence_ingest',
      suggestion_confidence: 'medium',
      decision_rationale: 'signal rationale',
      decision: '',
      approved_follow_up: '',
      reviewer_notes: '',
    },
  ]);

  writeCsv(decisionB, fieldnames, [
    {
      review_priority_score: '70',
      brand_name: 'BrandB',
      product_name: 'ProdB',
      official_product_url: 'https://example.com/b',
      market: 'US',
      category: 'cream',
      sku_row_key: 'sku-2',
      recommended_review_action: 'review_hybrid_ingredient_signal_sku',
      recommended_review_reason: 'hybrid',
      token_count: '4',
      ingredient_match_count: '2',
      signal_match_count: '2',
      parser_cleanup_count: '0',
      curated_signal_tail_count: '0',
      parser_fragment_exclusion_count: '0',
      canonical_ingredients: 'Niacinamide',
      signal_display_names: 'AHA',
      signal_keys: 'aha',
      suggested_decision: 'confirm_hybrid_sku',
      suggested_follow_up: 'keep_hybrid_review_path_for_combined_ingredient_and_signal_coverage',
      suggestion_confidence: 'medium',
      decision_rationale: 'hybrid rationale',
      decision: '',
      approved_follow_up: '',
      reviewer_notes: '',
    },
  ]);

  const result = spawnSync(
    'python3',
    [
      'scripts/build_sku_ingredient_signal_manual_handoff_queue.py',
      '--decision-csv',
      decisionA,
      '--decision-csv',
      decisionB,
      '--out-csv',
      outCsv,
      '--out-summary-json',
      outJson,
      '--out-xlsx',
      outXlsx,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(summary.row_count, 2);
  assert.equal(summary.source_packet_counts.signal_led, 1);
  assert.equal(summary.source_packet_counts.hybrid, 1);

  const outText = fs.readFileSync(outCsv, 'utf8');
  assert.match(outText, /review_signal_led_sku/);
  assert.match(outText, /review_hybrid_ingredient_signal_sku/);
  assert.ok(fs.existsSync(outXlsx));
});

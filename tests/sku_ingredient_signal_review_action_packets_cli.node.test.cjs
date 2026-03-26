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

test('build_sku_ingredient_signal_review_action_packets splits review packet by recommended action', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-review-action-packets-'));
  const reviewPacketCsv = path.join(tempDir, 'review_packet.csv');
  const outSummary = path.join(tempDir, 'summary.json');
  const outDir = path.join(tempDir, 'packets');
  const outXlsx = path.join(tempDir, 'packets.xlsx');

  writeCsv(
    reviewPacketCsv,
    [
      'review_priority_score',
      'recommended_review_action',
      'recommended_review_reason',
      'brand_name',
      'product_name',
      'official_product_url',
      'market',
      'category',
      'sku_row_key',
      'token_count',
      'covered_count',
      'coverage_pct',
      'ingredient_match_count',
      'signal_match_count',
      'parser_cleanup_count',
      'curated_signal_tail_count',
      'parser_fragment_exclusion_count',
      'ingredient_granularities',
      'canonical_ingredients',
      'signal_display_names',
      'signal_keys',
      'parser_cleanup_fragments',
      'parser_excluded_fragments',
      'review_decision',
      'reviewer_notes',
    ],
    [
      {
        review_priority_score: '90',
        recommended_review_action: 'review_parser_fragment_series',
        recommended_review_reason: 'parser',
        brand_name: 'BrandA',
        product_name: 'ProdA',
        official_product_url: 'https://example.com/a',
        market: 'US',
        category: 'cream',
        sku_row_key: 'sku-1',
        token_count: '3',
        covered_count: '3',
        coverage_pct: '100.00',
        ingredient_match_count: '2',
        signal_match_count: '0',
        parser_cleanup_count: '0',
        curated_signal_tail_count: '0',
        parser_fragment_exclusion_count: '1',
        ingredient_granularities: 'key_ingredients_official',
        canonical_ingredients: 'Niacinamide',
        signal_display_names: '',
        signal_keys: '',
        parser_cleanup_fragments: '',
        parser_excluded_fragments: 'and E',
        review_decision: '',
        reviewer_notes: '',
      },
      {
        review_priority_score: '70',
        recommended_review_action: 'review_hybrid_ingredient_signal_sku',
        recommended_review_reason: 'hybrid',
        brand_name: 'BrandB',
        product_name: 'ProdB',
        official_product_url: 'https://example.com/b',
        market: 'US',
        category: 'serum',
        sku_row_key: 'sku-2',
        token_count: '4',
        covered_count: '4',
        coverage_pct: '100.00',
        ingredient_match_count: '3',
        signal_match_count: '1',
        parser_cleanup_count: '0',
        curated_signal_tail_count: '0',
        parser_fragment_exclusion_count: '0',
        ingredient_granularities: 'full_inci_official',
        canonical_ingredients: 'Niacinamide',
        signal_display_names: 'AHA',
        signal_keys: 'aha',
        parser_cleanup_fragments: '',
        parser_excluded_fragments: '',
        review_decision: '',
        reviewer_notes: '',
      },
      {
        review_priority_score: '60',
        recommended_review_action: 'review_signal_led_sku',
        recommended_review_reason: 'signal',
        brand_name: 'BrandC',
        product_name: 'ProdC',
        official_product_url: 'https://example.com/c',
        market: 'US',
        category: 'mist',
        sku_row_key: 'sku-3',
        token_count: '2',
        covered_count: '2',
        coverage_pct: '100.00',
        ingredient_match_count: '0',
        signal_match_count: '2',
        parser_cleanup_count: '0',
        curated_signal_tail_count: '1',
        parser_fragment_exclusion_count: '0',
        ingredient_granularities: 'key_ingredients_official',
        canonical_ingredients: '',
        signal_display_names: 'Miracle Broth™',
        signal_keys: 'miracle_broth',
        parser_cleanup_fragments: '',
        parser_excluded_fragments: '',
        review_decision: '',
        reviewer_notes: '',
      },
    ],
  );

  const result = spawnSync(
    'python3',
    [
      'scripts/build_sku_ingredient_signal_review_action_packets.py',
      '--review-packet-csv',
      reviewPacketCsv,
      '--out-summary-json',
      outSummary,
      '--out-dir',
      outDir,
      '--out-xlsx',
      outXlsx,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(fs.readFileSync(outSummary, 'utf8'));
  assert.equal(summary.total_sku_count, 3);
  assert.equal(summary.action_counts.review_parser_fragment_series, 1);
  assert.equal(summary.action_counts.review_hybrid_ingredient_signal_sku, 1);
  assert.equal(summary.action_counts.review_signal_led_sku, 1);

  assert.ok(fs.existsSync(path.join(outDir, 'review_parser_fragment_series.csv')));
  assert.ok(fs.existsSync(path.join(outDir, 'review_hybrid_ingredient_signal_sku.csv')));
  assert.ok(fs.existsSync(path.join(outDir, 'review_signal_led_sku.csv')));
  assert.ok(fs.existsSync(outXlsx));
});

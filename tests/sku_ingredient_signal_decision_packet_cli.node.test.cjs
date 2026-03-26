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

test('build_sku_ingredient_signal_decision_packet filters review rows and pre-fills suggested decisions', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-decision-packet-'));
  const reviewPacketCsv = path.join(tempDir, 'review_packet.csv');
  const outCsv = path.join(tempDir, 'decision.csv');
  const outJson = path.join(tempDir, 'summary.json');
  const outXlsx = path.join(tempDir, 'decision.xlsx');

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
        ingredient_match_count: '2',
        signal_match_count: '1',
        parser_cleanup_count: '0',
        curated_signal_tail_count: '0',
        parser_fragment_exclusion_count: '1',
        ingredient_granularities: 'key_ingredients_official',
        canonical_ingredients: 'Niacinamide',
        signal_display_names: 'Vitamins B',
        signal_keys: 'vitamins_b',
        parser_cleanup_fragments: '',
        parser_excluded_fragments: 'C; and E',
      },
      {
        review_priority_score: '60',
        recommended_review_action: 'review_signal_led_sku',
        recommended_review_reason: 'signal',
        brand_name: 'BrandB',
        product_name: 'ProdB',
        official_product_url: 'https://example.com/b',
        market: 'US',
        category: 'serum',
        sku_row_key: 'sku-2',
        token_count: '2',
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
      },
      {
        review_priority_score: '40',
        recommended_review_action: 'ready_reference_only_sku',
        recommended_review_reason: 'reference',
        brand_name: 'BrandC',
        product_name: 'ProdC',
        official_product_url: 'https://example.com/c',
        market: 'US',
        category: 'cleanser',
        sku_row_key: 'sku-3',
        token_count: '4',
        ingredient_match_count: '4',
        signal_match_count: '0',
        parser_cleanup_count: '0',
        curated_signal_tail_count: '0',
        parser_fragment_exclusion_count: '0',
        ingredient_granularities: 'full_inci_official',
        canonical_ingredients: 'Glycerin',
        signal_display_names: '',
        signal_keys: '',
        parser_cleanup_fragments: '',
        parser_excluded_fragments: '',
      },
    ],
  );

  const result = spawnSync(
    'python3',
    [
      'scripts/build_sku_ingredient_signal_decision_packet.py',
      '--review-packet-csv',
      reviewPacketCsv,
      '--action',
      'review_parser_fragment_series',
      '--action',
      'review_signal_led_sku',
      '--out-csv',
      outCsv,
      '--out-json',
      outJson,
      '--out-xlsx',
      outXlsx,
      '--sheet-name',
      'Priority_Decisions',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(summary.row_count, 2);
  assert.equal(summary.action_counts.review_parser_fragment_series, 1);
  assert.equal(summary.action_counts.review_signal_led_sku, 1);
  assert.equal(summary.suggested_decision_counts.confirm_parser_fragment_exclusion, 1);
  assert.equal(summary.suggested_decision_counts.confirm_signal_only_sku, 1);

  const outText = fs.readFileSync(outCsv, 'utf8');
  assert.match(outText, /confirm_parser_fragment_exclusion/);
  assert.match(outText, /confirm_signal_only_sku/);
  assert.ok(fs.existsSync(outXlsx));
});

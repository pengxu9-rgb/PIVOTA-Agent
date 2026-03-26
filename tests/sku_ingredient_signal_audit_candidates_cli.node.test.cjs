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

test('build_sku_ingredient_signal_audit_candidates merges ingredient and signal layers into one reviewable candidate CSV', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-ing-signal-candidates-'));
  const ingredientCsv = path.join(tempDir, 'ingredient.csv');
  const signalCsv = path.join(tempDir, 'signal.csv');
  const outCsv = path.join(tempDir, 'combined.csv');
  const outUnresolved = path.join(tempDir, 'unresolved.csv');
  const outJson = path.join(tempDir, 'summary.json');

  writeCsv(
    ingredientCsv,
    [
      'candidate_match_key',
      'sku_row_key',
      'source_file',
      'source_sheet',
      'source_row_number',
      'brand_name',
      'product_name',
      'official_product_url',
      'market',
      'category',
      'ingredient_granularity',
      'extraction_status',
      'raw_ingredient_text',
      'raw_token',
      'token_index',
      'token_normalized',
      'match_status',
      'match_method',
      'match_confidence',
      'ingredient_record_id',
      'canonical_inci_name',
      'canonical_display_name',
      'ingredient_normalized_key',
      'ingredient_family',
      'primary_bucket',
      'matched_reference_term',
    ],
    [
      {
        candidate_match_key: 'cand-1',
        sku_row_key: 'row-1',
        source_file: 'sku.xlsx',
        source_sheet: 'SKU_Seed_Inventory',
        source_row_number: '2',
        brand_name: 'BrandA',
        product_name: 'ProdA',
        official_product_url: 'https://example.com/a',
        market: 'US',
        category: 'serum',
        ingredient_granularity: 'full_inci_official',
        extraction_status: 'done',
        raw_ingredient_text: 'Niacinamide, Water',
        raw_token: 'Niacinamide',
        token_index: '1',
        token_normalized: 'niacinamide',
        match_status: 'matched',
        match_method: 'canonical_inci_name',
        match_confidence: 'high',
        ingredient_record_id: 'ING-1',
        canonical_inci_name: 'Niacinamide',
        canonical_display_name: 'Niacinamide',
        ingredient_normalized_key: 'niacinamide',
        ingredient_family: 'vitamin',
        primary_bucket: 'repair',
        matched_reference_term: 'Niacinamide',
      },
      {
        candidate_match_key: 'cand-2',
        sku_row_key: 'row-2',
        source_file: 'sku.xlsx',
        source_sheet: 'SKU_Seed_Inventory',
        source_row_number: '3',
        brand_name: 'BrandB',
        product_name: 'ProdB',
        official_product_url: 'https://example.com/b',
        market: 'US',
        category: 'cream',
        ingredient_granularity: 'key_ingredients_official',
        extraction_status: 'done',
        raw_ingredient_text: 'Ceramides',
        raw_token: 'Ceramides',
        token_index: '1',
        token_normalized: 'ceramides',
        match_status: 'unmatched',
        match_method: '',
        match_confidence: 'none',
        ingredient_record_id: '',
        canonical_inci_name: '',
        canonical_display_name: '',
        ingredient_normalized_key: '',
        ingredient_family: '',
        primary_bucket: '',
        matched_reference_term: '',
      },
      {
        candidate_match_key: 'cand-3',
        sku_row_key: 'row-3',
        source_file: 'sku.xlsx',
        source_sheet: 'SKU_Seed_Inventory',
        source_row_number: '4',
        brand_name: 'BrandC',
        product_name: 'ProdC',
        official_product_url: 'https://example.com/c',
        market: 'US',
        category: 'cleanser',
        ingredient_granularity: 'product_page_only',
        extraction_status: 'done',
        raw_ingredient_text: 'Unknown Blend',
        raw_token: 'Unknown Blend',
        token_index: '1',
        token_normalized: 'unknownblend',
        match_status: 'unmatched',
        match_method: '',
        match_confidence: 'none',
        ingredient_record_id: '',
        canonical_inci_name: '',
        canonical_display_name: '',
        ingredient_normalized_key: '',
        ingredient_family: '',
        primary_bucket: '',
        matched_reference_term: '',
      },
      {
        candidate_match_key: 'cand-4',
        sku_row_key: 'row-4',
        source_file: 'sku.xlsx',
        source_sheet: 'SKU_Seed_Inventory',
        source_row_number: '5',
        brand_name: 'BrandD',
        product_name: 'ProdD',
        official_product_url: 'https://example.com/d',
        market: 'US',
        category: 'serum',
        ingredient_granularity: 'full_inci_official',
        extraction_status: 'done',
        raw_ingredient_text: 'Ambiguous Token',
        raw_token: 'Ambiguous Token',
        token_index: '1',
        token_normalized: 'ambiguoustoken',
        match_status: 'ambiguous',
        match_method: '',
        match_confidence: 'review',
        ingredient_record_id: '',
        canonical_inci_name: '',
        canonical_display_name: '',
        ingredient_normalized_key: '',
        ingredient_family: '',
        primary_bucket: '',
        matched_reference_term: '',
      },
    ],
  );

  writeCsv(
    signalCsv,
    [
      'candidate_match_key',
      'sku_row_key',
      'source_row_number',
      'brand_name',
      'product_name',
      'official_product_url',
      'category',
      'ingredient_granularity',
      'raw_token',
      'token_index',
      'token_normalized',
      'ingredient_match_status',
      'signal_match_status',
      'signal_match_score',
      'signal_match_method',
      'signal_bucket',
      'signal_key',
      'display_signal_name',
      'signal_confidence_levels',
      'signal_source_packets',
      'signal_source_decisions',
      'signal_raw_token_variants',
      'signal_normalized_token_variants',
      'ambiguity_signal_keys',
    ],
    [
      {
        candidate_match_key: 'cand-2',
        sku_row_key: 'row-2',
        source_row_number: '3',
        brand_name: 'BrandB',
        product_name: 'ProdB',
        official_product_url: 'https://example.com/b',
        category: 'cream',
        ingredient_granularity: 'key_ingredients_official',
        raw_token: 'Ceramides',
        token_index: '1',
        token_normalized: 'ceramides',
        ingredient_match_status: 'unmatched',
        signal_match_status: 'matched',
        signal_match_score: '100',
        signal_match_method: 'signal_key',
        signal_bucket: 'ingredient_family_signal',
        signal_key: 'ceramides',
        display_signal_name: 'Ceramides',
        signal_confidence_levels: 'high',
        signal_source_packets: 'ingredient_signal_review_packet',
        signal_source_decisions: 'approve_suggestion',
        signal_raw_token_variants: 'Ceramides',
        signal_normalized_token_variants: 'ceramides',
        ambiguity_signal_keys: '',
      },
      {
        candidate_match_key: 'cand-3',
        sku_row_key: 'row-3',
        source_row_number: '4',
        brand_name: 'BrandC',
        product_name: 'ProdC',
        official_product_url: 'https://example.com/c',
        category: 'cleanser',
        ingredient_granularity: 'product_page_only',
        raw_token: 'Unknown Blend',
        token_index: '1',
        token_normalized: 'unknownblend',
        ingredient_match_status: 'unmatched',
        signal_match_status: 'unmatched',
        signal_match_score: '',
        signal_match_method: '',
        signal_bucket: '',
        signal_key: '',
        display_signal_name: '',
        signal_confidence_levels: '',
        signal_source_packets: '',
        signal_source_decisions: '',
        signal_raw_token_variants: '',
        signal_normalized_token_variants: '',
        ambiguity_signal_keys: '',
      },
    ],
  );

  const result = spawnSync(
    'python3',
    [
      'scripts/build_sku_ingredient_signal_audit_candidates.py',
      '--ingredient-match-csv',
      ingredientCsv,
      '--signal-audit-csv',
      signalCsv,
      '--out-csv',
      outCsv,
      '--out-unresolved-csv',
      outUnresolved,
      '--out-summary-json',
      outJson,
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const csv = fs.readFileSync(outCsv, 'utf8');
  assert.match(csv, /cand-1,[^\n]*Niacinamide[^\n]*covered,ingredient_reference_match,100/);
  assert.match(csv, /cand-2,[^\n]*ingredient_family_signal,ceramides,Ceramides,high,ingredient_signal_review_packet,approve_suggestion,covered,signal_dictionary_match,80/);
  assert.match(csv, /cand-3,[^\n]*Unknown Blend[^\n]*unresolved,no_deterministic_match,0/);
  assert.match(csv, /cand-4,[^\n]*Ambiguous Token[^\n]*needs_review,ingredient_reference_ambiguous,25/);

  const summary = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(summary.token_count, 4);
  assert.equal(summary.covered_token_count, 2);
  assert.equal(summary.coverage_pct, 50);
  assert.equal(summary.resolution_type_counts.ingredient_reference_match, 1);
  assert.equal(summary.resolution_type_counts.signal_dictionary_match, 1);
  assert.equal(summary.resolution_type_counts.no_deterministic_match, 1);
  assert.equal(summary.resolution_type_counts.ingredient_reference_ambiguous, 1);
  assert.equal(summary.recommended_target.table, 'seed_preview.sku_ingredient_signal_audit_candidates');
}
);

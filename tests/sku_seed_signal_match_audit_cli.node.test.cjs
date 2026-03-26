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

test('build_sku_seed_signal_match_audit overlays unmatched ingredient rows onto signal dictionary', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-signal-audit-'));
  const matchCsv = path.join(tempDir, 'match.csv');
  const signalCsv = path.join(tempDir, 'signal_dictionary.csv');
  const outCsv = path.join(tempDir, 'signal_audit.csv');
  const outHits = path.join(tempDir, 'signal_hits.csv');
  const outRemainder = path.join(tempDir, 'signal_remainder.csv');
  const outJson = path.join(tempDir, 'signal_summary.json');

  writeCsv(
    matchCsv,
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
      'match_status',
    ],
    [
      {
        candidate_match_key: 'cand-1',
        sku_row_key: 'row-1',
        source_row_number: '2',
        brand_name: 'BrandA',
        product_name: 'ProdA',
        official_product_url: 'https://example.com/a',
        category: 'serum',
        ingredient_granularity: 'key_ingredients_official',
        raw_token: 'AHA',
        token_index: '1',
        token_normalized: 'aha',
        match_status: 'unmatched',
      },
      {
        candidate_match_key: 'cand-2',
        sku_row_key: 'row-2',
        source_row_number: '3',
        brand_name: 'BrandB',
        product_name: 'ProdB',
        official_product_url: 'https://example.com/b',
        category: 'cream',
        ingredient_granularity: 'key_ingredients_official',
        raw_token: 'Miracle Broth™',
        token_index: '2',
        token_normalized: 'miraclebroth',
        match_status: 'unmatched',
      },
      {
        candidate_match_key: 'cand-3',
        sku_row_key: 'row-3',
        source_row_number: '4',
        brand_name: 'BrandC',
        product_name: 'ProdC',
        official_product_url: 'https://example.com/c',
        category: 'cleanser',
        ingredient_granularity: 'full_inci_official',
        raw_token: 'Unknown Blend',
        token_index: '3',
        token_normalized: 'unknownblend',
        match_status: 'unmatched',
      },
      {
        candidate_match_key: 'cand-4',
        sku_row_key: 'row-4',
        source_row_number: '5',
        brand_name: 'BrandD',
        product_name: 'ProdD',
        official_product_url: 'https://example.com/d',
        category: 'serum',
        ingredient_granularity: 'full_inci_official',
        raw_token: 'Niacinamide',
        token_index: '4',
        token_normalized: 'niacinamide',
        match_status: 'matched',
      },
    ],
  );

  writeCsv(
    signalCsv,
    [
      'signal_bucket',
      'signal_key',
      'display_signal_name',
      'raw_token_variants',
      'normalized_token_variants',
      'source_packets',
      'source_decisions',
      'confidence_levels',
    ],
    [
      {
        signal_bucket: 'acid_family_signal',
        signal_key: 'aha',
        display_signal_name: 'AHA',
        raw_token_variants: 'AHA; Alpha Hydroxy Acids',
        normalized_token_variants: 'aha; alphahydroxyacids',
        source_packets: 'ingredient_signal_review_packet',
        source_decisions: 'approve_suggestion',
        confidence_levels: 'high',
      },
      {
        signal_bucket: 'marketing_or_blend_signal',
        signal_key: 'miracle_broth',
        display_signal_name: 'Miracle Broth',
        raw_token_variants: 'Miracle Broth; Miracle Broth™',
        normalized_token_variants: 'miraclebroth',
        source_packets: 'ingredient_marketing_signal_decision_packet',
        source_decisions: 'approve_override',
        confidence_levels: 'high',
      },
    ],
  );

  const result = spawnSync(
    'python3',
    [
      'scripts/build_sku_seed_signal_match_audit.py',
      '--match-csv',
      matchCsv,
      '--signal-dictionary',
      signalCsv,
      '--out-csv',
      outCsv,
      '--out-hit-csv',
      outHits,
      '--out-remainder-csv',
      outRemainder,
      '--out-summary-json',
      outJson,
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const rows = fs
    .readFileSync(outCsv, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','));
  assert.equal(rows.length, 3);

  const csv = fs.readFileSync(outCsv, 'utf8');
  assert.match(csv, /cand-1,row-1,2,BrandA,ProdA,https:\/\/example.com\/a,serum,key_ingredients_official,AHA,1,aha,unmatched,matched,100,signal_key,acid_family_signal,aha/);
  assert.match(csv, /cand-2,row-2,3,BrandB,ProdB,https:\/\/example.com\/b,cream,key_ingredients_official,Miracle Broth™,2,miraclebroth,unmatched,matched,100,signal_key,marketing_or_blend_signal,miracle_broth/);
  assert.match(csv, /cand-3,row-3,4,BrandC,ProdC,https:\/\/example.com\/c,cleanser,full_inci_official,Unknown Blend,3,unknownblend,unmatched,unmatched/);

  const summary = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(summary.unmatched_input_row_count, 3);
  assert.equal(summary.signal_match_status_counts.matched, 2);
  assert.equal(summary.signal_match_status_counts.unmatched, 1);
  assert.equal(summary.signal_bucket_hit_counts.acid_family_signal, 1);
  assert.equal(summary.signal_bucket_hit_counts.marketing_or_blend_signal, 1);
});

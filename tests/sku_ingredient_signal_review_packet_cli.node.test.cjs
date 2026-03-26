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

test('build_sku_ingredient_signal_review_packet aggregates candidate rows into SKU review rows', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-review-packet-'));
  const candidateCsv = path.join(tempDir, 'candidate.csv');
  const outCsv = path.join(tempDir, 'packet.csv');
  const outBrandCsv = path.join(tempDir, 'brand.csv');
  const outJson = path.join(tempDir, 'summary.json');
  const outXlsx = path.join(tempDir, 'packet.xlsx');

  writeCsv(
    candidateCsv,
    [
      'candidate_match_key',
      'sku_row_key',
      'brand_name',
      'product_name',
      'official_product_url',
      'market',
      'category',
      'ingredient_granularity',
      'raw_ingredient_text',
      'raw_token',
      'canonical_inci_name',
      'signal_key',
      'display_signal_name',
      'audit_resolution_status',
      'audit_resolution_type',
    ],
    [
      {
        candidate_match_key: 'cand-1',
        sku_row_key: 'sku-1',
        brand_name: 'BrandA',
        product_name: 'ProdA',
        official_product_url: 'https://example.com/a',
        market: 'US',
        category: 'serum',
        ingredient_granularity: 'full_inci_official',
        raw_ingredient_text: 'Niacinamide, AHA',
        raw_token: 'Niacinamide',
        canonical_inci_name: 'Niacinamide',
        signal_key: '',
        display_signal_name: '',
        audit_resolution_status: 'covered',
        audit_resolution_type: 'ingredient_reference_match',
      },
      {
        candidate_match_key: 'cand-2',
        sku_row_key: 'sku-1',
        brand_name: 'BrandA',
        product_name: 'ProdA',
        official_product_url: 'https://example.com/a',
        market: 'US',
        category: 'serum',
        ingredient_granularity: 'key_ingredients_official',
        raw_ingredient_text: 'Niacinamide, AHA',
        raw_token: 'AHA',
        canonical_inci_name: '',
        signal_key: 'aha',
        display_signal_name: 'AHA',
        audit_resolution_status: 'covered',
        audit_resolution_type: 'signal_dictionary_match',
      },
      {
        candidate_match_key: 'cand-3',
        sku_row_key: 'sku-2',
        brand_name: 'BrandB',
        product_name: 'ProdB',
        official_product_url: 'https://example.com/b',
        market: 'US',
        category: 'cream',
        ingredient_granularity: 'key_ingredients_official',
        raw_ingredient_text: 'Vitamins B, C, and E',
        raw_token: 'and E',
        canonical_inci_name: '',
        signal_key: '',
        display_signal_name: '',
        audit_resolution_status: 'covered',
        audit_resolution_type: 'parser_fragment_excluded',
      },
    ],
  );

  const result = spawnSync(
    'python3',
    [
      'scripts/build_sku_ingredient_signal_review_packet.py',
      '--candidate-csv',
      candidateCsv,
      '--out-csv',
      outCsv,
      '--out-brand-csv',
      outBrandCsv,
      '--out-summary-json',
      outJson,
      '--out-xlsx',
      outXlsx,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(summary.sku_count, 2);
  assert.equal(summary.brand_count, 2);
  assert.equal(summary.hybrid_sku_count, 1);
  assert.equal(summary.parser_fragment_review_sku_count, 1);

  const packetText = fs.readFileSync(outCsv, 'utf8');
  assert.match(packetText, /review_hybrid_ingredient_signal_sku/);
  assert.match(packetText, /review_parser_fragment_series/);
  assert.match(packetText, /Niacinamide/);
  assert.match(packetText, /AHA/);
  assert.match(packetText, /and E/);

  const brandText = fs.readFileSync(outBrandCsv, 'utf8');
  assert.match(brandText, /BrandA/);
  assert.match(brandText, /BrandB/);

  assert.ok(fs.existsSync(outXlsx));
});

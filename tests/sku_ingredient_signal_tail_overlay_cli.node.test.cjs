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

test('apply_sku_ingredient_signal_tail_overlay resolves parser matches and excludes parser fragments', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-tail-overlay-'));
  const candidateCsv = path.join(tempDir, 'candidate.csv');
  const ingredientXlsx = path.join(tempDir, 'ingredient.xlsx');
  const outCsv = path.join(tempDir, 'out.csv');
  const outSummary = path.join(tempDir, 'summary.json');
  const outRemainder = path.join(tempDir, 'remainder.csv');

  writeCsv(
    candidateCsv,
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
      'ingredient_match_status',
      'ingredient_match_method',
      'ingredient_match_confidence',
      'ingredient_record_id',
      'canonical_inci_name',
      'canonical_display_name',
      'ingredient_normalized_key',
      'ingredient_family',
      'primary_bucket',
      'matched_reference_term',
      'signal_match_status',
      'signal_match_score',
      'signal_match_method',
      'signal_bucket',
      'signal_key',
      'display_signal_name',
      'signal_confidence_levels',
      'signal_source_packets',
      'signal_source_decisions',
      'audit_resolution_status',
      'audit_resolution_type',
      'audit_resolution_rank',
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
        category: 'sunscreen',
        ingredient_granularity: 'full_inci_official',
        extraction_status: 'done',
        raw_ingredient_text: 'Active Ingredient(s) & Concentration: Octinoxate 7.5%',
        raw_token: 'Active Ingredient(s) & Concentration: Octinoxate 7.5%',
        token_index: '1',
        token_normalized: 'activeingredientconcentrationoctinoxate75',
        ingredient_match_status: 'unmatched',
        ingredient_match_method: '',
        ingredient_match_confidence: '',
        ingredient_record_id: '',
        canonical_inci_name: '',
        canonical_display_name: '',
        ingredient_normalized_key: '',
        ingredient_family: '',
        primary_bucket: '',
        matched_reference_term: '',
        signal_match_status: '',
        signal_match_score: '',
        signal_match_method: '',
        signal_bucket: '',
        signal_key: '',
        display_signal_name: '',
        signal_confidence_levels: '',
        signal_source_packets: '',
        signal_source_decisions: '',
        audit_resolution_status: 'unresolved',
        audit_resolution_type: 'no_deterministic_match',
        audit_resolution_rank: '0',
      },
      {
        candidate_match_key: 'cand-2',
        sku_row_key: 'row-2',
        source_file: 'sku.xlsx',
        source_sheet: 'SKU_Seed_Inventory',
        source_row_number: '3',
        brand_name: 'Bobbi Brown',
        product_name: 'Vitamin Enriched Face Base',
        official_product_url: 'https://example.com/b',
        market: 'US',
        category: 'moisturizer/primer',
        ingredient_granularity: 'key_ingredients_official',
        extraction_status: 'done',
        raw_ingredient_text: 'Vitamins B, C, and E; Hyaluronic Acid; Squalane; Shea Butter',
        raw_token: 'and E',
        token_index: '3',
        token_normalized: 'ande',
        ingredient_match_status: 'unmatched',
        ingredient_match_method: '',
        ingredient_match_confidence: '',
        ingredient_record_id: '',
        canonical_inci_name: '',
        canonical_display_name: '',
        ingredient_normalized_key: '',
        ingredient_family: '',
        primary_bucket: '',
        matched_reference_term: '',
        signal_match_status: '',
        signal_match_score: '',
        signal_match_method: '',
        signal_bucket: '',
        signal_key: '',
        display_signal_name: '',
        signal_confidence_levels: '',
        signal_source_packets: '',
        signal_source_decisions: '',
        audit_resolution_status: 'unresolved',
        audit_resolution_type: 'no_deterministic_match',
        audit_resolution_rank: '0',
      },
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
ws.append(['record_id', 'canonical_inci_name', 'canonical_display_name', 'normalized_key', 'ingredient_family', 'primary_bucket'])
ws.append(['ING-1', 'Ethylhexyl Methoxycinnamate', 'Ethylhexyl Methoxycinnamate', 'ethylhexylmethoxycinnamate', 'uv_filter', 'sunscreen'])
wb.save(r'''${ingredientXlsx}''')
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(workbookResult.status, 0, workbookResult.stderr);

  const result = spawnSync(
    'python3',
    [
      'scripts/apply_sku_ingredient_signal_tail_overlay.py',
      '--candidate-csv',
      candidateCsv,
      '--ingredient-xlsx',
      ingredientXlsx,
      '--out-csv',
      outCsv,
      '--out-summary-json',
      outSummary,
      '--out-remainder-csv',
      outRemainder,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(fs.readFileSync(outSummary, 'utf8'));
  assert.equal(summary.parser_overlay_count, 1);
  assert.equal(summary.parser_fragment_exclusion_count, 1);
  assert.equal(summary.total_overlay_count, 2);
  assert.equal(summary.remaining_unresolved_count, 0);
  assert.equal(summary.resolution_type_counts.parser_cleanup_ingredient_match, 1);
  assert.equal(summary.resolution_type_counts.parser_fragment_excluded, 1);

  const outRows = fs
    .readFileSync(outCsv, 'utf8')
    .trim()
    .split('\n');
  assert.equal(outRows.length, 3);
  const outText = fs.readFileSync(outCsv, 'utf8');
  assert.match(outText, /parser_cleanup_ingredient_match/);
  assert.match(outText, /parser_fragment_excluded/);

  const remainderText = fs.readFileSync(outRemainder, 'utf8').trim();
  assert.equal(remainderText, 'candidate_match_key,sku_row_key,source_file,source_sheet,source_row_number,brand_name,product_name,official_product_url,market,category,ingredient_granularity,extraction_status,raw_ingredient_text,raw_token,token_index,token_normalized,ingredient_match_status,ingredient_match_method,ingredient_match_confidence,ingredient_record_id,canonical_inci_name,canonical_display_name,ingredient_normalized_key,ingredient_family,primary_bucket,matched_reference_term,signal_match_status,signal_match_score,signal_match_method,signal_bucket,signal_key,display_signal_name,signal_confidence_levels,signal_source_packets,signal_source_decisions,audit_resolution_status,audit_resolution_type,audit_resolution_rank');
});

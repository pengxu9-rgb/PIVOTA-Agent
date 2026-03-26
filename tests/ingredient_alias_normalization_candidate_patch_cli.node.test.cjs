const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-alias-normalization-candidate-patch-'));
}

function runPython(args, options = {}) {
  return execFileSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCsv(filePath) {
  const output = runPython([
    '-c',
    [
      'import csv, json, sys',
      'with open(sys.argv[1], newline="", encoding="utf-8") as handle:',
      '    print(json.dumps(list(csv.DictReader(handle))))',
    ].join('\n'),
    filePath,
  ]);
  return JSON.parse(output);
}

function createIngredientWorkbook(workbookPath, header, rows) {
  runPython([
    '-c',
    [
      'import json, sys',
      'from openpyxl import Workbook',
      'path = sys.argv[1]',
      'header = json.loads(sys.argv[2])',
      'rows = json.loads(sys.argv[3])',
      'wb = Workbook()',
      'ws = wb.active',
      "ws.title = 'Ingredient_Reference_Merged_v2'",
      'ws.append(header)',
      'for row in rows:',
      '    ws.append([row.get(col, "") for col in header])',
      'wb.save(path)',
    ].join('\n'),
    workbookPath,
    JSON.stringify(header),
    JSON.stringify(rows),
  ]);
}

function writeCsv(filePath, fieldnames, rows) {
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(fieldnames.map((key) => JSON.stringify(String(row[key] || ''))).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

test('alias normalization candidate patch export keeps only medium/high new-canonical rows', () => {
  const tempDir = makeTempDir();
  const ingredientWorkbook = path.join(tempDir, 'ingredient_reference.xlsx');
  const packetCsv = path.join(tempDir, 'alias_packet.csv');
  const outApplyCsv = path.join(tempDir, 'alias_candidate_patch.csv');
  const outRemainderCsv = path.join(tempDir, 'alias_candidate_remainder.csv');
  const outSummaryJson = path.join(tempDir, 'alias_candidate_summary.json');

  const ingredientHeader = [
    'record_id',
    'canonical_inci_name',
    'canonical_display_name',
    'ingredient_family',
    'us_label_name',
    'eu_label_name',
    'us_label_variants',
    'eu_label_variants',
    'cross_market_notes',
    'normalized_key',
    'aliases_common',
    'parser_variants',
    'deprecated_aliases',
    'alias_quality',
    'notes_for_parser',
    'primary_bucket',
    'all_buckets',
    'function_tags',
    'benefit_tags',
    'risk_flags',
    'is_humectant',
    'is_barrier_support',
    'is_retinoid',
    'is_exfoliant',
    'is_uv_filter',
    'is_preservative',
    'is_surfactant',
    'is_fragrance_or_eo',
    'regulatory_bucket',
    'source_urls',
    'source_authorities',
    'source_types',
    'review_status',
    'confidence',
    'last_reviewed_at',
    'review_notes',
    'notes',
    'kb_version',
  ];

  const ingredientRows = [
    {
      record_id: 'ING-0001',
      canonical_inci_name: 'Glycerin',
      canonical_display_name: 'Glycerin',
      ingredient_family: 'humectant',
      us_label_name: 'Glycerin',
      eu_label_name: 'Glycerin',
      normalized_key: 'glycerin',
    },
    {
      record_id: 'ing_patch_v13_302',
      canonical_inci_name: 'Xylitylglucoside',
      canonical_display_name: 'Xylitylglucoside',
      ingredient_family: 'other',
      us_label_name: 'Xylitylglucoside',
      eu_label_name: 'Xylitylglucoside',
      normalized_key: 'xylitylglucoside',
    },
  ];

  createIngredientWorkbook(ingredientWorkbook, ingredientHeader, ingredientRows);

  const packetFieldnames = [
    'priority_score',
    'raw_token',
    'normalized_token',
    'unmatched_count',
    'sku_row_count',
    'full_inci_count',
    'key_count',
    'top_categories',
    'example_brands',
    'example_products',
    'example_urls',
    'suggested_resolution',
    'suggestion_confidence',
    'existing_target_record_id',
    'existing_target_canonical_inci_name',
    'existing_aliases_common',
    'existing_parser_variants',
    'suggested_new_canonical_inci_name',
    'suggested_aliases_common_addition',
    'suggested_alias_quality',
    'suggested_parser_variants_addition',
    'resolution_rationale',
    'decision',
    'approved_target_record_id',
    'approved_new_canonical_inci_name',
    'approved_aliases_common_addition',
    'approved_alias_quality',
    'approved_parser_variants_addition',
    'reviewer_notes',
  ];

  writeCsv(packetCsv, packetFieldnames, [
    {
      priority_score: '50',
      raw_token: 'TROMETHAMINE',
      normalized_token: 'tromethamine',
      unmatched_count: '3',
      sku_row_count: '3',
      full_inci_count: '3',
      key_count: '0',
      top_categories: 'barrier cream:2',
      example_brands: 'Avène',
      example_products: 'Cicalfate+',
      example_urls: 'https://example.com/a',
      suggested_resolution: 'new_canonical_candidate_with_parser_variants',
      suggestion_confidence: 'medium',
      existing_target_record_id: '',
      existing_target_canonical_inci_name: '',
      existing_aliases_common: '',
      existing_parser_variants: '',
      suggested_new_canonical_inci_name: 'Tromethamine',
      suggested_aliases_common_addition: '',
      suggested_alias_quality: '',
      suggested_parser_variants_addition: 'Tromethamine; TROMETHAMINE',
      resolution_rationale: 'Looks like case-normalized label form.',
      decision: '',
      approved_target_record_id: '',
      approved_new_canonical_inci_name: 'Tromethamine',
      approved_aliases_common_addition: '',
      approved_alias_quality: '',
      approved_parser_variants_addition: 'Tromethamine; TROMETHAMINE',
      reviewer_notes: '',
    },
    {
      priority_score: '26',
      raw_token: 'EDTA',
      normalized_token: 'edta',
      unmatched_count: '1',
      sku_row_count: '1',
      full_inci_count: '1',
      key_count: '0',
      top_categories: 'moisturizer:1',
      example_brands: 'FAB',
      example_products: 'Ultra Repair Face Moisturizer',
      example_urls: 'https://example.com/b',
      suggested_resolution: 'needs_manual_mapping',
      suggestion_confidence: 'low',
      existing_target_record_id: '',
      existing_target_canonical_inci_name: '',
      existing_aliases_common: '',
      existing_parser_variants: '',
      suggested_new_canonical_inci_name: 'Edta',
      suggested_aliases_common_addition: '',
      suggested_alias_quality: '',
      suggested_parser_variants_addition: 'Edta; EDTA',
      resolution_rationale: 'Needs manual mapping.',
      decision: '',
      approved_target_record_id: '',
      approved_new_canonical_inci_name: 'Edta',
      approved_aliases_common_addition: '',
      approved_alias_quality: '',
      approved_parser_variants_addition: 'Edta; EDTA',
      reviewer_notes: '',
    },
  ]);

  runPython([
    'scripts/export_ingredient_alias_normalization_candidate_patch.py',
    '--packet-csv',
    packetCsv,
    '--ingredient-xlsx',
    ingredientWorkbook,
    '--out-apply-csv',
    outApplyCsv,
    '--out-remainder-csv',
    outRemainderCsv,
    '--out-summary-json',
    outSummaryJson,
  ]);

  const summary = readJson(outSummaryJson);
  assert.equal(summary.apply_ready_count, 1);
  assert.equal(summary.remainder_count, 1);
  assert.equal(summary.record_id_start, 'ing_patch_v13_303');
  assert.equal(summary.record_id_end, 'ing_patch_v13_303');

  const applyRows = readCsv(outApplyCsv);
  assert.equal(applyRows.length, 1);
  assert.equal(applyRows[0].record_id, 'ing_patch_v13_303');
  assert.equal(applyRows[0].canonical_inci_name, 'Tromethamine');
  assert.equal(applyRows[0].normalized_key, 'tromethamine');
  assert.equal(applyRows[0].source_packet_resolution, 'new_canonical_candidate_with_parser_variants');

  const remainderRows = readCsv(outRemainderCsv);
  assert.equal(remainderRows.length, 1);
  assert.equal(remainderRows[0].raw_token, 'EDTA');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-alias-manual-resolution-'));
}

function runPython(args, options = {}) {
  return execFileSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function writeCsv(filePath, fieldnames, rows) {
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(fieldnames.map((key) => JSON.stringify(String(row[key] || ''))).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('alias manual mapping resolutions export alias patches and new-canonical patches', () => {
  const tempDir = makeTempDir();
  const decisionCsv = path.join(tempDir, 'workbench.csv');
  const ingredientWorkbook = path.join(tempDir, 'ingredient_reference.xlsx');
  const aliasApplyCsv = path.join(tempDir, 'alias_apply.csv');
  const newCanonicalCsv = path.join(tempDir, 'new_canonical.csv');
  const remainderCsv = path.join(tempDir, 'remainder.csv');
  const summaryJson = path.join(tempDir, 'summary.json');

  writeCsv(decisionCsv, [
    'priority_score',
    'raw_token',
    'normalized_token',
    'manual_mapping_subtype',
    'suggested_new_canonical_inci_name',
    'suggested_parser_variants_addition',
    'example_brands',
    'example_products',
    'example_urls',
    'resolution_rationale',
    'suggested_existing_target_record_id',
    'suggested_existing_target_canonical_inci_name',
    'suggested_existing_aliases_common',
    'suggested_existing_parser_variants',
    'suggested_existing_alias_quality',
    'suggested_decision',
    'suggested_alias_quality',
    'suggestion_confidence',
    'suggestion_rationale',
    'decision',
    'approved_existing_target_record_id',
    'approved_existing_target_canonical_inci_name',
    'approved_new_canonical_inci_name',
    'approved_parser_variants_addition',
    'approved_alias_quality',
    'reviewer_notes',
  ], [
    {
      priority_score: '22',
      raw_token: 'CI 77891 (TITANIUM DIOXIDE)',
      normalized_token: 'ci77891titaniumdioxide',
      manual_mapping_subtype: 'ci_color_index_token',
      suggested_new_canonical_inci_name: 'CI 77891 (TITANIUM DIOXIDE)',
      suggested_parser_variants_addition: 'CI 77891 (TITANIUM DIOXIDE)',
      example_brands: 'Brand',
      example_products: 'Product',
      example_urls: 'https://example.com',
      resolution_rationale: 'manual',
      suggested_existing_target_record_id: 'ING-0305',
      suggested_existing_target_canonical_inci_name: 'Titanium Dioxide',
      suggested_existing_aliases_common: '',
      suggested_existing_parser_variants: 'Titanium Dioxide; titanium dioxide',
      suggested_existing_alias_quality: '',
      suggested_decision: 'map_to_existing_canonical',
      suggested_alias_quality: 'exact_label_alias',
      suggestion_confidence: 'high',
      suggestion_rationale: 'safe',
      decision: 'map_to_existing_canonical',
      approved_existing_target_record_id: 'ING-0305',
      approved_existing_target_canonical_inci_name: 'Titanium Dioxide',
      approved_new_canonical_inci_name: 'CI 77891 (TITANIUM DIOXIDE)',
      approved_parser_variants_addition: 'CI 77891 (TITANIUM DIOXIDE)',
      approved_alias_quality: 'exact_label_alias',
      reviewer_notes: '',
    },
    {
      priority_score: '22',
      raw_token: 'MICROCRYSTALLINE WAX / CIRE MICROCRISTALLINE',
      normalized_token: 'microcrystallinewaxciremicrocristalline',
      manual_mapping_subtype: 'bilingual_or_slash_label_variant',
      suggested_new_canonical_inci_name: 'Microcrystalline Wax',
      suggested_parser_variants_addition: 'MICROCRYSTALLINE WAX / CIRE MICROCRISTALLINE; Cire Microcristalline',
      example_brands: 'Brand',
      example_products: 'Product',
      example_urls: 'https://example.com',
      resolution_rationale: 'manual',
      suggested_existing_target_record_id: '',
      suggested_existing_target_canonical_inci_name: '',
      suggested_existing_aliases_common: '',
      suggested_existing_parser_variants: '',
      suggested_existing_alias_quality: '',
      suggested_decision: 'create_new_canonical',
      suggested_alias_quality: '',
      suggestion_confidence: 'low',
      suggestion_rationale: 'manual',
      decision: 'create_new_canonical',
      approved_existing_target_record_id: '',
      approved_existing_target_canonical_inci_name: '',
      approved_new_canonical_inci_name: 'Microcrystalline Wax',
      approved_parser_variants_addition: 'MICROCRYSTALLINE WAX / CIRE MICROCRISTALLINE; Cire Microcristalline',
      approved_alias_quality: '',
      reviewer_notes: '',
    },
    {
      priority_score: '22',
      raw_token: 'MICROCRYSTALLINE WAX / XIRE MICROCRISTALLINE',
      normalized_token: 'microcrystallinewaxxiremicrocristalline',
      manual_mapping_subtype: 'bilingual_or_slash_label_variant',
      suggested_new_canonical_inci_name: 'Microcrystalline Wax',
      suggested_parser_variants_addition: 'MICROCRYSTALLINE WAX / XIRE MICROCRISTALLINE; Xire Microcristalline',
      example_brands: 'Brand',
      example_products: 'Product 2',
      example_urls: 'https://example-2.com',
      resolution_rationale: 'manual',
      suggested_existing_target_record_id: '',
      suggested_existing_target_canonical_inci_name: '',
      suggested_existing_aliases_common: '',
      suggested_existing_parser_variants: '',
      suggested_existing_alias_quality: '',
      suggested_decision: 'create_new_canonical',
      suggested_alias_quality: '',
      suggestion_confidence: 'low',
      suggestion_rationale: 'manual',
      decision: 'create_new_canonical',
      approved_existing_target_record_id: '',
      approved_existing_target_canonical_inci_name: '',
      approved_new_canonical_inci_name: 'Microcrystalline Wax',
      approved_parser_variants_addition: 'MICROCRYSTALLINE WAX / XIRE MICROCRISTALLINE; Xire Microcristalline',
      approved_alias_quality: '',
      reviewer_notes: 'legacy_alias_variant',
    },
  ]);

  createIngredientWorkbook(ingredientWorkbook, [
    'record_id',
    'canonical_inci_name',
    'canonical_display_name',
    'ingredient_family',
    'us_label_name',
    'eu_label_name',
    'normalized_key',
    'aliases_common',
    'parser_variants',
    'alias_quality',
    'regulatory_bucket',
    'source_urls',
    'source_authorities',
    'source_types',
    'review_status',
    'confidence',
    'review_notes',
    'notes',
    'kb_version',
  ], [
    {
      record_id: 'ING-0305',
      canonical_inci_name: 'Titanium Dioxide',
      canonical_display_name: 'Titanium Dioxide',
      ingredient_family: 'uv_filter',
      us_label_name: 'Titanium Dioxide',
      eu_label_name: 'Titanium Dioxide',
      normalized_key: 'titaniumdioxide',
      aliases_common: '',
      parser_variants: 'Titanium Dioxide',
      alias_quality: '',
      regulatory_bucket: '',
      source_urls: '',
      source_authorities: '',
      source_types: '',
      review_status: 'reviewed',
      confidence: 'high',
      review_notes: '',
      notes: '',
      kb_version: 'v1',
    },
  ]);

  runPython([
    'scripts/export_ingredient_alias_manual_mapping_resolutions.py',
    '--decision-csv', decisionCsv,
    '--ingredient-xlsx', ingredientWorkbook,
    '--out-alias-apply-csv', aliasApplyCsv,
    '--out-new-canonical-csv', newCanonicalCsv,
    '--out-remainder-csv', remainderCsv,
    '--out-summary-json', summaryJson,
  ]);

  const aliasRows = readCsv(aliasApplyCsv);
  const newCanonicalRows = readCsv(newCanonicalCsv);
  const remainderRows = readCsv(remainderCsv);
  const summary = readJson(summaryJson);

  assert.equal(aliasRows.length, 1);
  assert.equal(aliasRows[0].record_id, 'ING-0305');
  assert.equal(aliasRows[0].patch_aliases_common, 'CI 77891 (TITANIUM DIOXIDE)');
  assert.equal(
    aliasRows[0].patch_parser_variants,
    'Titanium Dioxide; titanium dioxide; CI 77891 (TITANIUM DIOXIDE)'
  );
  assert.equal(newCanonicalRows.length, 1);
  assert.equal(newCanonicalRows[0].canonical_inci_name, 'Microcrystalline Wax');
  assert.equal(
    newCanonicalRows[0].parser_variants,
    'Microcrystalline Wax; MICROCRYSTALLINE WAX / CIRE MICROCRISTALLINE; Cire Microcristalline; MICROCRYSTALLINE WAX / XIRE MICROCRISTALLINE; Xire Microcristalline'
  );
  assert.equal(newCanonicalRows[0].source_packet_raw_token, 'MICROCRYSTALLINE WAX / CIRE MICROCRISTALLINE; MICROCRYSTALLINE WAX / XIRE MICROCRISTALLINE');
  assert.equal(remainderRows.length, 0);
  assert.equal(summary.alias_apply_ready_count, 1);
  assert.equal(summary.new_canonical_apply_ready_count, 1);
});

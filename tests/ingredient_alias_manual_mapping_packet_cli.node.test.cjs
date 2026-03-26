const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-alias-manual-mapping-'));
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

test('alias manual mapping packet classifies tail rows into manual subtypes', () => {
  const tempDir = makeTempDir();
  const packetCsv = path.join(tempDir, 'alias_packet.csv');
  const outCsv = path.join(tempDir, 'alias_manual_packet.csv');
  const outJson = path.join(tempDir, 'alias_manual_packet.json');

  const fieldnames = [
    'priority_score',
    'raw_token',
    'normalized_token',
    'suggested_resolution',
    'suggested_new_canonical_inci_name',
    'suggested_parser_variants_addition',
    'example_brands',
    'example_products',
    'example_urls',
    'resolution_rationale',
  ];

  writeCsv(packetCsv, fieldnames, [
    {
      priority_score: '22',
      raw_token: 'ARGININE HCL',
      normalized_token: 'argininehcl',
      suggested_resolution: 'needs_manual_mapping',
      suggested_new_canonical_inci_name: 'Arginine HCl',
      suggested_parser_variants_addition: 'Arginine HCl',
      example_brands: 'Filorga',
      example_products: 'Cream',
      example_urls: 'https://example.com/a',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '22',
      raw_token: 'CI 77891 (TITANIUM DIOXIDE)',
      normalized_token: 'ci77891titaniumdioxide',
      suggested_resolution: 'needs_manual_mapping',
      suggested_new_canonical_inci_name: 'CI 77891 (TITANIUM DIOXIDE)',
      suggested_parser_variants_addition: 'CI 77891 (TITANIUM DIOXIDE)',
      example_brands: 'Bondi Sands',
      example_products: 'Eye Cream',
      example_urls: 'https://example.com/b',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '22',
      raw_token: 'MICROCRYSTALLINE WAX / CIRE MICROCRISTALLINE',
      normalized_token: 'microcrystallinewaxciremicrocristalline',
      suggested_resolution: 'needs_manual_mapping',
      suggested_new_canonical_inci_name: 'Microcrystalline Wax / Cire Microcristalline',
      suggested_parser_variants_addition: 'Microcrystalline Wax / Cire Microcristalline',
      example_brands: 'Avene',
      example_products: 'Cream',
      example_urls: 'https://example.com/c',
      resolution_rationale: 'manual',
    },
    {
      priority_score: '22',
      raw_token: 'EDTA',
      normalized_token: 'edta',
      suggested_resolution: 'needs_manual_mapping',
      suggested_new_canonical_inci_name: 'Edta',
      suggested_parser_variants_addition: 'Edta',
      example_brands: 'FAB',
      example_products: 'Moisturizer',
      example_urls: 'https://example.com/d',
      resolution_rationale: 'manual',
    },
  ]);

  runPython([
    'scripts/build_ingredient_alias_manual_mapping_packet.py',
    '--packet-csv', packetCsv,
    '--out-csv', outCsv,
    '--out-json', outJson,
  ]);

  const rows = readCsv(outCsv);
  const summary = readJson(outJson);

  assert.equal(rows.length, 4);
  assert.equal(summary.manual_mapping_subtype_counts.salt_hcl_abbreviation, 1);
  assert.equal(summary.manual_mapping_subtype_counts.ci_color_index_token, 1);
  assert.equal(summary.manual_mapping_subtype_counts.bilingual_or_slash_label_variant, 1);
  assert.equal(summary.manual_mapping_subtype_counts.generic_abbreviation, 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sku-ing-signal-bundle-'));
}

function runPython(args, options = {}) {
  return execFileSync('python3', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function runNode(args, options = {}) {
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function writeCsv(filePath, fieldnames, rows) {
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(fieldnames.map((key) => String(row[key] || '')).join(','));
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCsvRows(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] || '';
    });
    return row;
  });
}

test('sku ingredient signal audit bundle CLIs export manifest, DDL, and no-db target check', () => {
  const tempDir = makeTempDir();
  const candidateCsv = path.join(tempDir, 'sku_ingredient_signal_audit_candidates.csv');
  const outCsv = path.join(tempDir, 'sku_ingredient_signal_audit_bundle.csv');
  const outManifest = path.join(tempDir, 'sku_ingredient_signal_audit_manifest.json');
  const outCopySql = path.join(tempDir, 'sku_ingredient_signal_audit_copy.sql');
  const outDdl = path.join(tempDir, 'sku_ingredient_signal_audit_create.sql');
  const outTargetCheck = path.join(tempDir, 'sku_ingredient_signal_audit_target_check.json');

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
        source_file: 'brand_sku_inventory_seed_v13.xlsx',
        source_sheet: 'SKU_Seed_Inventory',
        source_row_number: '2',
        brand_name: 'BrandA',
        product_name: 'ProdA',
        official_product_url: 'https://example.com/a',
        market: 'US',
        category: 'serum',
        ingredient_granularity: 'full_inci_official',
        extraction_status: 'done',
        raw_ingredient_text: 'Niacinamide',
        raw_token: 'Niacinamide',
        token_index: '1',
        token_normalized: 'niacinamide',
        ingredient_match_status: 'matched',
        ingredient_match_method: 'canonical_inci_name',
        ingredient_match_confidence: 'high',
        ingredient_record_id: 'ING-1',
        canonical_inci_name: 'Niacinamide',
        canonical_display_name: 'Niacinamide',
        ingredient_normalized_key: 'niacinamide',
        ingredient_family: 'vitamin',
        primary_bucket: 'repair',
        matched_reference_term: 'Niacinamide',
        signal_match_status: '',
        signal_match_score: '',
        signal_match_method: '',
        signal_bucket: '',
        signal_key: '',
        display_signal_name: '',
        signal_confidence_levels: '',
        signal_source_packets: '',
        signal_source_decisions: '',
        audit_resolution_status: 'covered',
        audit_resolution_type: 'ingredient_reference_match',
        audit_resolution_rank: '100',
      },
      {
        candidate_match_key: 'cand-2',
        sku_row_key: 'row-2',
        source_file: 'brand_sku_inventory_seed_v13.xlsx',
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
        ingredient_match_status: 'unmatched',
        ingredient_match_method: '',
        ingredient_match_confidence: 'none',
        ingredient_record_id: '',
        canonical_inci_name: '',
        canonical_display_name: '',
        ingredient_normalized_key: '',
        ingredient_family: '',
        primary_bucket: '',
        matched_reference_term: '',
        signal_match_status: 'matched',
        signal_match_score: '100',
        signal_match_method: 'signal_key',
        signal_bucket: 'ingredient_family_signal',
        signal_key: 'ceramides',
        display_signal_name: 'Ceramides',
        signal_confidence_levels: 'high',
        signal_source_packets: 'ingredient_signal_review_packet',
        signal_source_decisions: 'approve_suggestion',
        audit_resolution_status: 'covered',
        audit_resolution_type: 'signal_dictionary_match',
        audit_resolution_rank: '80',
      },
    ],
  );

  runPython([
    'scripts/export_sku_ingredient_signal_audit_bundle.py',
    '--candidate-csv',
    candidateCsv,
    '--out-csv',
    outCsv,
    '--out-manifest-json',
    outManifest,
    '--out-copy-sql',
    outCopySql,
  ]);

  const manifest = readJson(outManifest);
  assert.equal(manifest.target_table, 'seed_preview.sku_ingredient_signal_audit_candidates');
  assert.equal(manifest.row_count, 2);
  assert.deepEqual(manifest.recommended_primary_key, ['candidate_match_key']);
  assert.ok(manifest.exported_columns.includes('source_bundle_csv'));
  assert.ok(manifest.exported_columns.includes('audit_resolution_status'));

  const exportedRows = readCsvRows(outCsv);
  assert.equal(exportedRows.length, 2);
  assert.equal(exportedRows[0].source_bundle_csv, 'sku_ingredient_signal_audit_candidates.csv');
  assert.equal(exportedRows[0].candidate_match_key, 'cand-1');

  const copySql = fs.readFileSync(outCopySql, 'utf8');
  assert.match(copySql, /COPY seed_preview\.sku_ingredient_signal_audit_candidates/);
  assert.match(copySql, /FORMAT csv/);

  runPython([
    'scripts/generate_sku_ingredient_signal_audit_ddl.py',
    '--bundle-manifest-json',
    outManifest,
    '--out-sql',
    outDdl,
  ]);

  const ddl = fs.readFileSync(outDdl, 'utf8');
  assert.match(ddl, /CREATE SCHEMA IF NOT EXISTS "seed_preview"/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS "seed_preview"\."sku_ingredient_signal_audit_candidates"/);
  assert.match(ddl, /"candidate_match_key" TEXT PRIMARY KEY/);
  assert.match(ddl, /sku_ingredient_signal_audit_candidates_sku_row_key_idx/);
  assert.match(ddl, /sku_ingredient_signal_audit_candidates_signal_key_idx/);

  const noDbEnv = { ...process.env };
  delete noDbEnv.DATABASE_URL;
  runNode(
    [
      'scripts/check_sku_ingredient_signal_audit_target.js',
      '--bundle-manifest-json',
      outManifest,
      '--out-json',
      outTargetCheck,
    ],
    { env: noDbEnv },
  );

  const targetCheck = readJson(outTargetCheck);
  assert.equal(targetCheck.db_configured, false);
  assert.equal(targetCheck.reason, 'DATABASE_URL not configured');
  assert.equal(targetCheck.target_table, 'seed_preview.sku_ingredient_signal_audit_candidates');
});

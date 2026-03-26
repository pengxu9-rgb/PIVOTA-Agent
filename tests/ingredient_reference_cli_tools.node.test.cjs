const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-reference-cli-'));
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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

function writeCsv(filePath, fieldnames, rows) {
  const lines = [fieldnames.join(',')];
  for (const row of rows) {
    lines.push(fieldnames.map((key) => String(row[key] || '')).join(','));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function createWorkbook(workbookPath, header, rows, sheetName = 'Dictionary') {
  runPython(
    [
      '-c',
      [
        'import json, sys',
        'from openpyxl import Workbook',
        'path = sys.argv[1]',
        'sheet_name = sys.argv[4]',
        'header = json.loads(sys.argv[2])',
        'rows = json.loads(sys.argv[3])',
        'wb = Workbook()',
        "ws = wb.active",
        'ws.title = sheet_name',
        'ws.append(header)',
        'for row in rows:',
        '    ws.append([row.get(col, "") for col in header])',
        'wb.save(path)',
      ].join('\n'),
      workbookPath,
      JSON.stringify(header),
      JSON.stringify(rows),
      sheetName,
    ],
  );
}

function readWorkbookRecords(workbookPath, sheetName = 'Dictionary') {
  const output = runPython([
    '-c',
    [
      'import json, sys',
      'from openpyxl import load_workbook',
      'wb = load_workbook(sys.argv[1], read_only=True, data_only=True)',
      'ws = wb[sys.argv[2]]',
      'rows = list(ws.iter_rows(values_only=True))',
      'header = [str(cell or "").strip() for cell in rows[0]]',
      'records = {}',
      'for row in rows[1:]:',
      '    item = {header[i]: str(row[i] or "").strip() for i in range(len(header))}',
      '    record_id = item.get("record_id", "")',
      '    if record_id:',
      '        records[record_id] = item',
      'print(json.dumps(records))',
    ].join('\n'),
    workbookPath,
    sheetName,
  ]);
  return JSON.parse(output);
}

const workbookHeader = [
  'record_id',
  'canonical_inci_name',
  'canonical_display_name',
  'ingredient_family',
  'us_label_name',
  'eu_label_name',
  'normalized_key',
  'aliases_common',
  'parser_variants',
  'primary_bucket',
  'all_buckets',
  'function_tags',
  'benefit_tags',
  'risk_flags',
  'notes_for_parser',
  'regulatory_bucket',
  'source_urls',
  'notes',
  'kb_version',
  'review_status',
  'confidence',
  'review_notes',
];

const workbookRows = [
  {
    record_id: 'ing-001',
    canonical_inci_name: 'Glycerin',
    canonical_display_name: 'Glycerin',
    ingredient_family: 'humectant',
    us_label_name: 'Glycerin',
    eu_label_name: 'Glycerin',
    normalized_key: 'glycerin',
    aliases_common: 'glycerin',
    parser_variants: 'Glycerin; glycerin',
    primary_bucket: 'hydration',
    all_buckets: 'hydration',
    function_tags: 'humectant',
    benefit_tags: 'hydration',
    risk_flags: '',
    notes_for_parser: '',
    regulatory_bucket: 'allowed',
    source_urls: 'https://example.com/glycerin',
    notes: '',
    kb_version: 'v1',
    review_status: 'draft',
    confidence: 'medium',
    review_notes: '',
  },
  {
    record_id: 'ing-002',
    canonical_inci_name: 'Niacinamide',
    canonical_display_name: 'Niacinamide',
    ingredient_family: 'vitamin',
    us_label_name: 'Niacinamide',
    eu_label_name: 'Niacinamide',
    normalized_key: 'niacinamide',
    aliases_common: 'niacinamide',
    parser_variants: 'Niacinamide; niacinamide',
    primary_bucket: 'repair',
    all_buckets: 'repair; anti-aging',
    function_tags: 'barrier support',
    benefit_tags: 'repair',
    risk_flags: '',
    notes_for_parser: '',
    regulatory_bucket: 'allowed',
    source_urls: 'https://example.com/niacinamide',
    notes: '',
    kb_version: 'v1',
    review_status: 'reviewed',
    confidence: 'low',
    review_notes: 'baseline note',
  },
];

test('ingredient reference seed_ingest bundle CLIs export a manifest, DDL, and no-db target check', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  const outCsv = path.join(tempDir, 'ingredient_reference_seed_ingest.csv');
  const outManifest = path.join(tempDir, 'ingredient_reference_seed_ingest_manifest.json');
  const outCopySql = path.join(tempDir, 'ingredient_reference_seed_ingest_copy.sql');
  const outDdl = path.join(tempDir, 'ingredient_reference_seed_ingest_create.sql');
  const outTargetCheck = path.join(tempDir, 'ingredient_reference_seed_ingest_target_check.json');

  createWorkbook(workbookPath, workbookHeader, workbookRows);

  runPython([
    'scripts/export_ingredient_reference_seed_ingest_bundle.py',
    '--ingredient-xlsx',
    workbookPath,
    '--out-csv',
    outCsv,
    '--out-manifest-json',
    outManifest,
    '--out-copy-sql',
    outCopySql,
  ]);

  const manifest = readJson(outManifest);
  assert.equal(manifest.target_table, 'seed_ingest.ingredient_reference_seed');
  assert.equal(manifest.row_count, 2);
  assert.deepEqual(manifest.recommended_primary_key, ['record_id']);
  assert.ok(manifest.exported_columns.includes('source_row_number'));
  assert.ok(manifest.exported_columns.includes('canonical_inci_name'));

  const exportedRows = readCsvRows(outCsv);
  assert.equal(exportedRows.length, 2);
  assert.equal(exportedRows[0].source_file, 'ingredient_reference.xlsx');
  assert.equal(exportedRows[0].source_sheet, 'Dictionary');
  assert.equal(exportedRows[0].record_id, 'ing-001');

  const copySql = fs.readFileSync(outCopySql, 'utf8');
  assert.match(copySql, /COPY seed_ingest\.ingredient_reference_seed/);
  assert.match(copySql, /FORMAT csv/);

  runPython([
    'scripts/generate_ingredient_reference_seed_ingest_ddl.py',
    '--bundle-manifest-json',
    outManifest,
    '--out-sql',
    outDdl,
  ]);

  const ddl = fs.readFileSync(outDdl, 'utf8');
  assert.match(ddl, /CREATE SCHEMA IF NOT EXISTS "seed_ingest"/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS "seed_ingest"\."ingredient_reference_seed"/);
  assert.match(ddl, /"record_id" TEXT PRIMARY KEY/);
  assert.match(ddl, /ingredient_reference_seed_normalized_key_key/);
  assert.match(ddl, /ingredient_reference_seed_canonical_inci_name_key/);

  const noDbEnv = { ...process.env };
  delete noDbEnv.DATABASE_URL;
  runNode(
    [
      'scripts/check_ingredient_reference_seed_ingest_target.js',
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
  assert.equal(targetCheck.target_table, 'seed_ingest.ingredient_reference_seed');
});

test('ingredient review_status CLIs export only eligible rows and apply the patch', () => {
  const tempDir = makeTempDir();
  const queuePath = path.join(tempDir, 'ingredient_reference_review_queue.json');
  const applyCsv = path.join(tempDir, 'ingredient_review_status_writeback_patch.csv');
  const remainderCsv = path.join(tempDir, 'ingredient_review_status_writeback_remainder.csv');
  const workbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  const outWorkbook = path.join(tempDir, 'ingredient_reference_review_status_patched.xlsx');
  const outReport = path.join(tempDir, 'ingredient_reference_review_status_patch_report.json');

  writeJson(queuePath, {
    all_review_rows: [
      {
        record_id: 'ing-001',
        canonical_inci_name: 'Glycerin',
        review_status: 'draft',
        confidence: 'medium',
        reasons: ['review_status_still_draft', 'confidence_medium'],
      },
      {
        record_id: 'ing-002',
        canonical_inci_name: 'Niacinamide',
        review_status: 'draft',
        confidence: 'low',
        reasons: ['review_status_still_draft', 'missing_aliases_common'],
      },
      {
        record_id: 'ing-003',
        canonical_inci_name: 'Panthenol',
        review_status: 'reviewed',
        confidence: 'high',
        reasons: [],
      },
    ],
  });

  createWorkbook(workbookPath, workbookHeader, [
    workbookRows[0],
    { ...workbookRows[1], record_id: 'ing-002', review_status: 'draft', review_notes: '' },
  ]);

  runPython([
    'scripts/export_ingredient_review_status_writeback_patch.py',
    '--queue-json',
    queuePath,
    '--out-apply-csv',
    applyCsv,
    '--out-remainder-csv',
    remainderCsv,
  ]);

  const applyRows = readCsvRows(applyCsv);
  const remainderRows = readCsvRows(remainderCsv);
  assert.equal(applyRows.length, 1);
  assert.equal(applyRows[0].record_id, 'ing-001');
  assert.equal(applyRows[0].patch_review_status, 'reviewed');
  assert.equal(remainderRows.length, 2);

  runPython([
    'scripts/apply_ingredient_review_status_patch.py',
    '--ingredient-xlsx',
    workbookPath,
    '--patch-csv',
    applyCsv,
    '--out-xlsx',
    outWorkbook,
    '--out-report-json',
    outReport,
  ]);

  const report = readJson(outReport);
  assert.equal(report.applied_count, 1);
  assert.equal(report.skipped_conflict_count, 0);

  const records = readWorkbookRecords(outWorkbook);
  assert.equal(records['ing-001'].review_status, 'reviewed');
  assert.equal(records['ing-002'].review_status, 'draft');
});

test('ingredient review queue and review_status apply support Ingredient_Reference_Merged_v2 sheet', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference_merged.xlsx');
  const queueJson = path.join(tempDir, 'ingredient_reference_review_queue.json');
  const applyCsv = path.join(tempDir, 'ingredient_review_status_writeback_patch.csv');
  const outWorkbook = path.join(tempDir, 'ingredient_reference_review_status_patched.xlsx');
  const outReport = path.join(tempDir, 'ingredient_reference_review_status_patch_report.json');

  createWorkbook(
    workbookPath,
    workbookHeader,
    [
      {
        ...workbookRows[0],
        aliases_common: '',
        review_status: 'draft',
        confidence: 'medium',
        review_notes: 'confirmed_no_safe_common_alias; confirmed_ingredient_family_other',
      },
      { ...workbookRows[1], record_id: 'ing-002', review_status: 'reviewed', confidence: 'high', review_notes: 'confirmed_confidence_medium' },
    ],
    'Ingredient_Reference_Merged_v2',
  );

  runPython([
    'scripts/build_ingredient_reference_review_queue.py',
    '--ingredient-xlsx',
    workbookPath,
    '--out-json',
    queueJson,
  ]);

  const queuePayload = readJson(queueJson);
  assert.equal(queuePayload.sheet_name, 'Ingredient_Reference_Merged_v2');

  runPython([
    'scripts/export_ingredient_review_status_writeback_patch.py',
    '--queue-json',
    queueJson,
    '--out-apply-csv',
    applyCsv,
  ]);

  runPython([
    'scripts/apply_ingredient_review_status_patch.py',
    '--ingredient-xlsx',
    workbookPath,
    '--patch-csv',
    applyCsv,
    '--out-xlsx',
    outWorkbook,
    '--out-report-json',
    outReport,
  ]);

  const report = readJson(outReport);
  const records = readWorkbookRecords(outWorkbook, 'Ingredient_Reference_Merged_v2');
  assert.equal(report.target_sheet, 'Ingredient_Reference_Merged_v2');
  assert.equal(records['ing-001'].review_status, 'reviewed');
});

test('ingredient alias proposal supports Ingredient_Reference_Merged_v2 sheet', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference_merged.xlsx');
  const outJson = path.join(tempDir, 'ingredient_alias_proposals.json');
  const outCsv = path.join(tempDir, 'ingredient_alias_proposals.csv');

  createWorkbook(
    workbookPath,
    workbookHeader,
    [
      {
        ...workbookRows[0],
        record_id: 'ing-merged-001',
        canonical_inci_name: 'Acetyl Hexapeptide-8',
        canonical_display_name: 'Argireline',
        us_label_name: 'Acetyl Hexapeptide-8',
        eu_label_name: 'Acetyl Hexapeptide-8',
        normalized_key: 'acetylhexapeptide8',
        aliases_common: '',
        alias_quality: '',
        parser_variants: 'Acetyl Hexapeptide-8; acetyl hexapeptide 8',
      },
    ],
    'Ingredient_Reference_Merged_v2',
  );

  runPython([
    'scripts/propose_ingredient_alias_backfill.py',
    '--ingredient-xlsx',
    workbookPath,
    '--out-json',
    outJson,
    '--out-csv',
    outCsv,
  ]);

  const summary = readJson(outJson);
  const rows = readCsvRows(outCsv);
  assert.equal(summary.sheet_name, 'Ingredient_Reference_Merged_v2');
  assert.equal(summary.proposal_row_count, 1);
  assert.equal(rows[0].record_id, 'ing-merged-001');
  assert.equal(rows[0].suggested_aliases_common, 'Argireline; acetyl hexapeptide 8');
  assert.equal(rows[0].suggested_alias_quality, 'mixed_review_required');
});

test('ingredient parser-note proposal and apply support Ingredient_Reference_Merged_v2 sheet', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference_parser_notes.xlsx');
  const outProposalJson = path.join(tempDir, 'ingredient_parser_notes_proposals.json');
  const outProposalCsv = path.join(tempDir, 'ingredient_parser_notes_proposals.csv');
  const patchCsv = path.join(tempDir, 'ingredient_parser_notes_patch.csv');
  const patchedWorkbook = path.join(tempDir, 'ingredient_reference_parser_notes_patched.xlsx');
  const applyReport = path.join(tempDir, 'ingredient_parser_notes_apply_report.json');

  createWorkbook(
    workbookPath,
    workbookHeader,
    [
      {
        ...workbookRows[0],
        record_id: 'ing-parser-001',
        canonical_inci_name: 'Palmitoyl Tripeptide-1',
        canonical_display_name: 'Palmitoyl Tripeptide-1',
        ingredient_family: 'peptide',
        normalized_key: 'palmitoyltripeptide1',
        aliases_common: '',
        parser_variants: 'Palmitoyl Tripeptide-1; palmitoyl tripeptide 1',
        notes_for_parser: '',
      },
    ],
    'Ingredient_Reference_Merged_v2',
  );

  runPython([
    'scripts/propose_ingredient_parser_notes_backfill.py',
    '--ingredient-xlsx',
    workbookPath,
    '--out-json',
    outProposalJson,
    '--out-csv',
    outProposalCsv,
  ]);

  const proposalSummary = readJson(outProposalJson);
  const proposalRows = readCsvRows(outProposalCsv);
  assert.equal(proposalSummary.sheet_name, 'Ingredient_Reference_Merged_v2');
  assert.equal(proposalRows[0].proposal_template, 'peptide_numeric');
  assert.equal(proposalRows[0].proposal_confidence, 'high');

  writeCsv(
    patchCsv,
    ['record_id', 'canonical_inci_name', 'existing_notes_for_parser', 'patch_notes_for_parser', 'proposal_sources', 'quality_reason'],
    [
      {
        record_id: 'ing-parser-001',
        canonical_inci_name: 'Palmitoyl Tripeptide-1',
        existing_notes_for_parser: '',
        patch_notes_for_parser: 'Keep peptide chain numbers and hyphenation during parsing; PDPs often vary separators.',
        proposal_sources: 'proposal_template:peptide_numeric',
        quality_reason: 'deterministic_template',
      },
    ],
  );

  runPython([
    'scripts/apply_ingredient_parser_notes_writeback_patch.py',
    '--ingredient-xlsx',
    workbookPath,
    '--patch-csv',
    patchCsv,
    '--target-sheet',
    'Ingredient_Reference_Merged_v2',
    '--out-xlsx',
    patchedWorkbook,
    '--out-report-json',
    applyReport,
  ]);

  const report = readJson(applyReport);
  const records = readWorkbookRecords(patchedWorkbook, 'Ingredient_Reference_Merged_v2');
  assert.equal(report.target_sheet, 'Ingredient_Reference_Merged_v2');
  assert.equal(records['ing-parser-001'].notes_for_parser, 'Keep peptide chain numbers and hyphenation during parsing; PDPs often vary separators.');
});

test('ingredient alias manual-review workbench supports Ingredient_Reference_Merged_v2 sheet', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference_alias_workbench.xlsx');
  const manualCsv = path.join(tempDir, 'ingredient_alias_manual.csv');
  const outJson = path.join(tempDir, 'ingredient_alias_workbench.json');
  const outCsv = path.join(tempDir, 'ingredient_alias_workbench.csv');

  createWorkbook(
    workbookPath,
    workbookHeader,
    [
      {
        ...workbookRows[0],
        record_id: 'ing-alias-001',
        canonical_inci_name: 'PABA',
        canonical_display_name: 'PABA',
        ingredient_family: 'uv_filter',
        normalized_key: 'paba',
        aliases_common: '',
        parser_variants: 'PABA; paba',
      },
    ],
    'Ingredient_Reference_Merged_v2',
  );

  writeCsv(
    manualCsv,
    ['record_id', 'canonical_inci_name', 'canonical_display_name', 'existing_aliases_common', 'existing_alias_quality', 'suggested_aliases_common', 'suggested_alias_quality', 'proposal_confidence', 'proposal_sources', 'quality_reason', 'needs_manual_review'],
    [
      {
        record_id: 'ing-alias-001',
        canonical_inci_name: 'PABA',
        canonical_display_name: 'PABA',
        existing_aliases_common: '',
        existing_alias_quality: '',
        suggested_aliases_common: '',
        suggested_alias_quality: '',
        proposal_confidence: 'none',
        proposal_sources: '',
        quality_reason: '',
        needs_manual_review: 'yes',
      },
    ],
  );

  runPython([
    'scripts/build_ingredient_alias_manual_review_workbench.py',
    '--ingredient-xlsx',
    workbookPath,
    '--sheet-name',
    'Ingredient_Reference_Merged_v2',
    '--manual-csv',
    manualCsv,
    '--out-json',
    outJson,
    '--out-csv',
    outCsv,
  ]);

  const summary = readJson(outJson);
  const rows = readCsvRows(outCsv);
  assert.equal(summary.sheet_name, 'Ingredient_Reference_Merged_v2');
  assert.equal(summary.resolution_counts.candidate_alias_high_confidence, 1);
  assert.equal(rows[0].suggested_resolution, 'candidate_alias_high_confidence');
  assert.equal(rows[0].suggested_aliases_common, 'Para-Aminobenzoic Acid');
});

test('ingredient confidence CLIs build a packet, export patches, and apply them safely', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  const sourceCsv = path.join(tempDir, 'status_confidence_review.csv');
  const packetCsv = path.join(tempDir, 'ingredient_confidence_confirmation_packet.csv');
  const packetJson = path.join(tempDir, 'ingredient_confidence_confirmation_packet.json');
  const confidencePatchCsv = path.join(tempDir, 'ingredient_confidence_apply_patch.csv');
  const reviewNotesPatchCsv = path.join(tempDir, 'ingredient_confidence_review_notes_apply_patch.csv');
  const remainderCsv = path.join(tempDir, 'ingredient_confidence_confirmation_remainder.csv');
  const confidencePatchedWorkbook = path.join(tempDir, 'ingredient_reference_confidence_patched.xlsx');
  const reviewNotesPatchedWorkbook = path.join(tempDir, 'ingredient_reference_confidence_confirmed.xlsx');

  createWorkbook(workbookPath, workbookHeader, workbookRows);

  writeCsv(
    sourceCsv,
    ['record_id', 'canonical_inci_name', 'ingredient_family', 'review_status', 'confidence', 'reasons'],
    [
      {
        record_id: 'ing-001',
        canonical_inci_name: 'Glycerin',
        ingredient_family: 'humectant',
        review_status: 'draft',
        confidence: 'medium',
        reasons: 'review_status_still_draft; confidence_medium',
      },
      {
        record_id: 'ing-002',
        canonical_inci_name: 'Niacinamide',
        ingredient_family: 'vitamin',
        review_status: 'reviewed',
        confidence: 'low',
        reasons: 'confidence_low',
      },
    ],
  );

  runPython([
    'scripts/build_ingredient_confidence_confirmation_packet.py',
    '--ingredient-xlsx',
    workbookPath,
    '--status-confidence-csv',
    sourceCsv,
    '--out-csv',
    packetCsv,
    '--out-json',
    packetJson,
  ]);

  const packetRows = readCsvRows(packetCsv);
  assert.equal(packetRows.length, 2);
  assert.equal(packetRows[0].suggested_marker, 'confirmed_confidence_medium');
  assert.equal(packetRows[1].suggested_marker, 'confirmed_confidence_low');

  writeCsv(
    packetCsv,
    [
      'record_id',
      'canonical_inci_name',
      'ingredient_family',
      'review_status',
      'existing_confidence',
      'existing_review_notes',
      'suggested_marker',
      'suggested_resolution',
      'suggested_rationale',
      'decision',
      'approved_confidence',
      'approved_marker',
      'reviewer_notes',
    ],
    [
      {
        ...packetRows[0],
        decision: 'confirm_current_confidence',
        approved_confidence: 'medium',
        approved_marker: 'confirmed_confidence_medium',
        reviewer_notes: 'reviewed and kept at medium confidence',
      },
      {
        ...packetRows[1],
        decision: 'set_high',
        approved_confidence: 'high',
        approved_marker: '',
        reviewer_notes: 'strong supporting evidence added',
      },
    ],
  );

  runPython([
    'scripts/export_ingredient_confidence_confirmation_patch.py',
    '--decision-csv',
    packetCsv,
    '--out-confidence-apply-csv',
    confidencePatchCsv,
    '--out-review-notes-apply-csv',
    reviewNotesPatchCsv,
    '--out-remainder-csv',
    remainderCsv,
  ]);

  const confidencePatchRows = readCsvRows(confidencePatchCsv);
  const reviewNotesPatchRows = readCsvRows(reviewNotesPatchCsv);
  const remainderRows = readCsvRows(remainderCsv);
  assert.equal(confidencePatchRows.length, 1);
  assert.equal(confidencePatchRows[0].record_id, 'ing-002');
  assert.equal(confidencePatchRows[0].patch_confidence, 'high');
  assert.equal(reviewNotesPatchRows.length, 1);
  assert.equal(reviewNotesPatchRows[0].record_id, 'ing-001');
  assert.match(reviewNotesPatchRows[0].patch_review_notes, /confirmed_confidence_medium/);
  assert.equal(remainderRows.length, 0);

  runPython([
    'scripts/apply_ingredient_confidence_patch.py',
    '--ingredient-xlsx',
    workbookPath,
    '--patch-csv',
    confidencePatchCsv,
    '--out-xlsx',
    confidencePatchedWorkbook,
  ]);

  runPython([
    'scripts/apply_ingredient_review_notes_patch.py',
    '--ingredient-xlsx',
    confidencePatchedWorkbook,
    '--patch-csv',
    reviewNotesPatchCsv,
    '--out-xlsx',
    reviewNotesPatchedWorkbook,
  ]);

  const records = readWorkbookRecords(reviewNotesPatchedWorkbook);
  assert.equal(records['ing-001'].confidence, 'medium');
  assert.equal(records['ing-001'].review_notes, 'confirmed_confidence_medium');
  assert.equal(records['ing-002'].confidence, 'high');
  assert.equal(records['ing-002'].review_notes, 'baseline note');
});

test('ingredient family-other and no-safe-alias confirmation CLIs build packets and apply review-note markers safely', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  const familyReviewCsv = path.join(tempDir, 'ingredient_family_review.csv');
  const familyPacketCsv = path.join(tempDir, 'ingredient_family_other_confirmation_packet.csv');
  const familyPatchCsv = path.join(tempDir, 'ingredient_family_other_confirmation_apply_patch.csv');
  const aliasGapCsv = path.join(tempDir, 'alias_backfill.csv');
  const aliasPacketCsv = path.join(tempDir, 'ingredient_alias_no_safe_confirmation_packet.csv');
  const aliasPatchCsv = path.join(tempDir, 'ingredient_alias_no_safe_confirmation_apply_patch.csv');
  const familyReviewedWorkbook = path.join(tempDir, 'ingredient_reference_family_other_reviewed.xlsx');
  const aliasReviewedWorkbook = path.join(tempDir, 'ingredient_reference_no_safe_alias_reviewed.xlsx');

  createWorkbook(workbookPath, workbookHeader, [
    { ...workbookRows[0], ingredient_family: 'other', review_notes: '' },
    { ...workbookRows[1], ingredient_family: 'vitamin', review_notes: 'baseline note' },
  ], 'Ingredient_Reference_Merged_v2');

  writeCsv(
    familyReviewCsv,
    ['record_id', 'canonical_inci_name', 'ingredient_family', 'reasons'],
    [
      {
        record_id: 'ing-001',
        canonical_inci_name: 'Glycerin',
        ingredient_family: 'other',
        reasons: 'ingredient_family_other_review',
      },
    ],
  );

  runPython([
    'scripts/build_ingredient_family_other_confirmation_packet.py',
    '--ingredient-xlsx',
    workbookPath,
    '--sheet-name',
    'Ingredient_Reference_Merged_v2',
    '--family-review-csv',
    familyReviewCsv,
    '--out-csv',
    familyPacketCsv,
  ]);

  const familyPacketRows = readCsvRows(familyPacketCsv);
  assert.equal(familyPacketRows.length, 1);
  assert.equal(familyPacketRows[0].suggested_marker, 'confirmed_ingredient_family_other');

  writeCsv(
    familyPacketCsv,
    [
      'record_id',
      'canonical_inci_name',
      'primary_bucket',
      'function_tags',
      'benefit_tags',
      'existing_ingredient_family',
      'existing_review_notes',
      'suggested_marker',
      'suggested_resolution',
      'suggested_rationale',
      'decision',
      'approved_marker',
      'reviewer_notes',
    ],
    [
      {
        ...familyPacketRows[0],
        decision: 'confirm_ingredient_family_other',
        approved_marker: 'confirmed_ingredient_family_other',
        reviewer_notes: 'kept as other after controlled-vocabulary review',
      },
    ],
  );

  runPython([
    'scripts/export_ingredient_family_other_confirmation_patch.py',
    '--decision-csv',
    familyPacketCsv,
    '--out-apply-csv',
    familyPatchCsv,
  ]);

  const familyPatchRows = readCsvRows(familyPatchCsv);
  assert.equal(familyPatchRows.length, 1);
  assert.equal(familyPatchRows[0].record_id, 'ing-001');

  runPython([
    'scripts/apply_ingredient_review_notes_patch.py',
    '--ingredient-xlsx',
    workbookPath,
    '--patch-csv',
    familyPatchCsv,
    '--out-xlsx',
    familyReviewedWorkbook,
  ]);

  writeCsv(
    aliasGapCsv,
    ['record_id', 'canonical_inci_name', 'ingredient_family', 'reasons'],
    [
      {
        record_id: 'ing-002',
        canonical_inci_name: 'Niacinamide',
        ingredient_family: 'vitamin',
        reasons: 'missing_aliases_common',
      },
    ],
  );

  runPython([
    'scripts/build_ingredient_alias_no_safe_confirmation_packet.py',
    '--ingredient-xlsx',
    familyReviewedWorkbook,
    '--alias-gap-csv',
    aliasGapCsv,
    '--out-csv',
    aliasPacketCsv,
  ]);

  const aliasPacketRows = readCsvRows(aliasPacketCsv);
  assert.equal(aliasPacketRows.length, 1);
  assert.equal(aliasPacketRows[0].suggested_marker, 'confirmed_no_safe_common_alias');
  assert.equal(aliasPacketRows[0].existing_review_notes, 'baseline note');

  writeCsv(
    aliasPacketCsv,
    [
      'record_id',
      'canonical_inci_name',
      'ingredient_family',
      'existing_review_notes',
      'suggested_marker',
      'suggested_resolution',
      'suggested_rationale',
      'decision',
      'approved_marker',
      'reviewer_notes',
    ],
    [
      {
        ...aliasPacketRows[0],
        decision: 'confirm_no_safe_common_alias',
        approved_marker: 'confirmed_no_safe_common_alias',
        reviewer_notes: 'reviewed and intentionally left without a safer common alias',
      },
    ],
  );

  runPython([
    'scripts/export_ingredient_alias_no_safe_confirmation_patch.py',
    '--decision-csv',
    aliasPacketCsv,
    '--out-apply-csv',
    aliasPatchCsv,
  ]);

  const aliasPatchRows = readCsvRows(aliasPatchCsv);
  assert.equal(aliasPatchRows.length, 1);
  assert.equal(aliasPatchRows[0].record_id, 'ing-002');

  runPython([
    'scripts/apply_ingredient_review_notes_patch.py',
    '--ingredient-xlsx',
    familyReviewedWorkbook,
    '--patch-csv',
    aliasPatchCsv,
    '--out-xlsx',
    aliasReviewedWorkbook,
  ]);

  const records = readWorkbookRecords(aliasReviewedWorkbook, 'Ingredient_Reference_Merged_v2');
  assert.equal(records['ing-001'].review_notes, 'confirmed_ingredient_family_other');
  assert.equal(records['ing-002'].review_notes, 'baseline note | confirmed_no_safe_common_alias');
});

test('ingredient curated family overlay and apply support Ingredient_Reference_Merged_v2 sheet', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference_family.xlsx');
  const familyReviewCsv = path.join(tempDir, 'ingredient_family_review.csv');
  const applyCsv = path.join(tempDir, 'ingredient_family_apply.csv');
  const remainderCsv = path.join(tempDir, 'ingredient_family_remainder.csv');
  const summaryJson = path.join(tempDir, 'ingredient_family_overlay_summary.json');
  const patchedWorkbook = path.join(tempDir, 'ingredient_reference_family_patched.xlsx');
  const applyReport = path.join(tempDir, 'ingredient_family_apply_report.json');

  createWorkbook(
    workbookPath,
    workbookHeader,
    [
      {
        ...workbookRows[0],
        record_id: 'ing-family-001',
        canonical_inci_name: 'Avena Sativa Kernel Flour',
        canonical_display_name: 'Avena Sativa Kernel Flour',
        ingredient_family: 'other',
        normalized_key: 'avenasativakernelflour',
      },
    ],
    'Ingredient_Reference_Merged_v2',
  );

  writeCsv(
    familyReviewCsv,
    ['record_id', 'canonical_inci_name', 'ingredient_family', 'reasons'],
    [
      {
        record_id: 'ing-family-001',
        canonical_inci_name: 'Avena Sativa Kernel Flour',
        ingredient_family: 'other',
        reasons: 'ingredient_family_other_review',
      },
    ],
  );

  runPython([
    'scripts/propose_ingredient_curated_family_overlay.py',
    '--ingredient-xlsx',
    workbookPath,
    '--sheet-name',
    'Ingredient_Reference_Merged_v2',
    '--family-review-csv',
    familyReviewCsv,
    '--out-apply-csv',
    applyCsv,
    '--out-remainder-csv',
    remainderCsv,
    '--out-json',
    summaryJson,
  ]);

  const summary = readJson(summaryJson);
  const applyRows = readCsvRows(applyCsv);
  assert.equal(summary.source_sheet, 'Ingredient_Reference_Merged_v2');
  assert.equal(summary.apply_ready_count, 1);
  assert.equal(applyRows[0].patch_ingredient_family, 'plant_extract');

  runPython([
    'scripts/apply_ingredient_family_patch.py',
    '--ingredient-xlsx',
    workbookPath,
    '--patch-csv',
    applyCsv,
    '--target-sheet',
    'Ingredient_Reference_Merged_v2',
    '--out-xlsx',
    patchedWorkbook,
    '--out-report-json',
    applyReport,
  ]);

  const report = readJson(applyReport);
  const records = readWorkbookRecords(patchedWorkbook, 'Ingredient_Reference_Merged_v2');
  assert.equal(report.target_sheet, 'Ingredient_Reference_Merged_v2');
  assert.equal(records['ing-family-001'].ingredient_family, 'plant_extract');
});

test('ingredient seed_ingest live smoke script fails fast when DATABASE_URL is absent', () => {
  const tempDir = makeTempDir();
  const workbookPath = path.join(tempDir, 'ingredient_reference.xlsx');
  createWorkbook(workbookPath, workbookHeader, workbookRows);

  const env = { ...process.env };
  delete env.DATABASE_URL;

  let error = null;
  try {
    execFileSync('bash', ['scripts/smoke_ingredient_reference_seed_ingest_target.sh', workbookPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    error = err;
  }

  assert.ok(error, 'expected live smoke script to fail without DATABASE_URL');
  const stderr = `${error.stderr || ''}`;
  assert.match(stderr, /DATABASE_URL is required/);
});

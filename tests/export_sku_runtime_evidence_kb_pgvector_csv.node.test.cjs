const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

test('export_sku_runtime_evidence_kb_pgvector_csv emits ingest-safe reviewed rows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-runtime-evidence-'));
  const inCsv = path.join(tempDir, 'runtime.csv');
  const outCsv = path.join(tempDir, 'out.csv');
  const outJson = path.join(tempDir, 'summary.json');

  fs.writeFileSync(
    inCsv,
    [
      'sku_row_key,brand_name,product_name,official_product_url,market,category,evidence_lane,runtime_evidence_eligible,downstream_handoff_path,canonical_ingredients,signal_display_names,signal_keys,signal_handling_lane,approved_decision,review_status,trust_tier,decision_rationale,source_packet',
      'sku-1,Brand A,Product A,https://example.com/a,US,serum,reference_only,yes,eligible_for_reference_led_review,"Niacinamide; Glycerin",,,none,confirm_reference_only_sku,approved,high,reason a,packet-a',
      'sku-2,Brand B,Product B,https://example.com/b,US,cream,hybrid_canonical_primary,yes,eligible_for_hybrid_review_with_signal_context,"Panthenol; Glycerin",Rose Petal,rose_petal,secondary_review_context,approve_hybrid_review_candidate,approved,medium,reason b,packet-b',
      'sku-3,Brand C,Product C,https://example.com/c,US,cream,hybrid_canonical_primary,no,keep,,"",,preview_only,approve,approved,medium,reason c,packet-c',
      '',
    ].join('\n'),
    'utf8',
  );

  const res = spawnSync(
    'python3',
    [
      'scripts/export_sku_runtime_evidence_kb_pgvector_csv.py',
      '--runtime-evidence-csv',
      inCsv,
      '--out-csv',
      outCsv,
      '--out-summary-json',
      outJson,
    ],
    {
      cwd: '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend',
      encoding: 'utf8',
    },
  );

  assert.equal(res.status, 0, res.stderr);
  const summary = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(summary.exported_row_count, 2);

  const outRows = fs.readFileSync(outCsv, 'utf8').trim().split('\n');
  assert.equal(outRows.length, 3);
  assert.match(outRows[1], /REVIEWED_RUNTIME_EVIDENCE/);
  assert.match(outRows[1], /OK/);
  assert.match(outRows[1], /PASS/);
  assert.match(outRows[2], /reviewed_runtime_evidence:hybrid_canonical_primary/);
});

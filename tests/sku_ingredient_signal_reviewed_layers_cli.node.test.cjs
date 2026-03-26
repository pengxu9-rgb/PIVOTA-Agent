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

test('export_sku_ingredient_signal_reviewed_layers splits reviewed workbook into runtime, preview, followup, and parser lanes', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-reviewed-layers-'));
  const reviewedXlsx = path.join(tempDir, 'reviewed.xlsx');
  const existingHandoffCsv = path.join(tempDir, 'existing_handoff.csv');
  const outRuntime = path.join(tempDir, 'runtime.csv');
  const outParser = path.join(tempDir, 'parser.csv');
  const outPreview = path.join(tempDir, 'preview.csv');
  const outFollowup = path.join(tempDir, 'followup.csv');
  const outSummary = path.join(tempDir, 'summary.json');
  const outXlsx = path.join(tempDir, 'layers.xlsx');

  writeCsv(
    existingHandoffCsv,
    [
      'sku_row_key',
      'brand_name',
      'product_name',
      'official_product_url',
      'market',
      'category',
      'recommended_review_action',
      'source_decision',
      'downstream_handoff_path',
      'canonical_ingredients',
      'signal_display_names',
      'signal_keys',
      'parser_excluded_fragments',
      'decision_rationale',
      'source_packet',
    ],
    [
      {
        sku_row_key: 'sku-ref',
        brand_name: 'BrandRef',
        product_name: 'Ref Product',
        official_product_url: 'https://example.com/ref',
        market: 'US',
        category: 'serum',
        recommended_review_action: 'ready_reference_only_sku',
        source_decision: 'approve_suggestion',
        downstream_handoff_path: 'eligible_for_reference_led_review',
        canonical_ingredients: 'Niacinamide',
        signal_display_names: '',
        signal_keys: '',
        parser_excluded_fragments: '',
        decision_rationale: 'reference rationale',
        source_packet: 'reference_packet',
      },
      {
        sku_row_key: 'sku-parser',
        brand_name: 'BrandParser',
        product_name: 'Parser Product',
        official_product_url: 'https://example.com/parser',
        market: 'US',
        category: 'cream',
        recommended_review_action: 'review_parser_fragment_series',
        source_decision: 'approve_suggestion',
        downstream_handoff_path: 'keep_current_coverage_and_do_not_promote_fragments_as_ingredients',
        canonical_ingredients: 'Glycerin',
        signal_display_names: 'Vitamins B',
        signal_keys: 'vitamins_b',
        parser_excluded_fragments: 'C; and E',
        decision_rationale: 'parser rationale',
        source_packet: 'parser_packet',
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
ws.title = 'Manual_Queue_Reviewed'
header = ['source_packet','review_priority_score','brand_name','product_name','official_product_url','market','category','sku_row_key','recommended_review_action','recommended_review_reason','token_count','ingredient_match_count','signal_match_count','parser_cleanup_count','curated_signal_tail_count','parser_fragment_exclusion_count','canonical_ingredients','signal_display_names','signal_keys','suggested_decision','suggested_follow_up','suggestion_confidence','decision_rationale','decision','approved_follow_up','reviewer_notes','approved_decision','trust_tier','reviewer_notes_auto','review_status']\nws.append(header)\nws.append(['hybrid_packet','70','BrandHybrid','Hybrid Product','https://example.com/hybrid','US','mist','sku-hybrid','review_hybrid_ingredient_signal_sku','hybrid','4','2','2','0','0','0','Niacinamide','AHA','aha','','','','','','','hybrid note','approve_hybrid_keep_ingredients__signal_preview_only','medium','','approved_with_caveat'])\nws.append(['signal_packet','60','BrandSignal','Signal Product','https://example.com/signal','US','cream','sku-signal','review_signal_led_sku','signal','2','0','2','0','0','0','','Miracle Broth™','miracle_broth','','','','','','','signal note','approve_signal_preview_only__candidate_for_alias_or_canonical_followup','medium','','approved_with_caveat'])\nwb.save(r'''${reviewedXlsx}''')\n      `,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(workbookResult.status, 0, workbookResult.stderr);

  const result = spawnSync(
    'python3',
    [
      'scripts/export_sku_ingredient_signal_reviewed_layers.py',
      '--reviewed-xlsx',
      reviewedXlsx,
      '--existing-handoff-csv',
      existingHandoffCsv,
      '--out-runtime-evidence-csv',
      outRuntime,
      '--out-parser-controls-csv',
      outParser,
      '--out-signal-preview-csv',
      outPreview,
      '--out-followup-csv',
      outFollowup,
      '--out-summary-json',
      outSummary,
      '--out-xlsx',
      outXlsx,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(fs.readFileSync(outSummary, 'utf8'));
  assert.equal(summary.runtime_evidence_count, 2);
  assert.equal(summary.parser_control_count, 1);
  assert.equal(summary.signal_preview_count, 1);
  assert.equal(summary.followup_count, 1);
  assert.equal(summary.runtime_evidence_lane_counts.reference_only, 1);
  assert.equal(summary.runtime_evidence_lane_counts.hybrid_canonical_primary, 1);
  assert.equal(summary.signal_preview_lane_counts.candidate_for_alias_or_canonical_followup, 1);

  const runtimeText = fs.readFileSync(outRuntime, 'utf8');
  assert.match(runtimeText, /eligible_for_reference_led_review/);
  assert.match(runtimeText, /eligible_for_hybrid_review__signal_preview_only/);

  const parserText = fs.readFileSync(outParser, 'utf8');
  assert.match(parserText, /parser_fragment_exclusion_confirmed/);

  const previewText = fs.readFileSync(outPreview, 'utf8');
  assert.match(previewText, /candidate_for_alias_or_canonical_followup,no,/);

  const followupText = fs.readFileSync(outFollowup, 'utf8');
  assert.match(followupText, /candidate_for_alias_or_canonical_followup/);
  assert.ok(fs.existsSync(outXlsx));
});

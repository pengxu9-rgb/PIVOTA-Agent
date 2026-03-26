const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

test('prefill manual review workbook carries exact semantic matches and leaves changed rows for review', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-review-prefill-'));
  const oldXlsx = path.join(tempDir, 'old_reviewed.xlsx');
  const newCsv = path.join(tempDir, 'new_queue.csv');
  const outXlsx = path.join(tempDir, 'prefilled.xlsx');
  const outJson = path.join(tempDir, 'summary.json');
  const makeOldPy = path.join(tempDir, 'make_old.py');

  fs.writeFileSync(
    makeOldPy,
    `
import sys
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = 'Manual_Queue_Reviewed'
header = ['source_packet','review_priority_score','brand_name','product_name','official_product_url','market','category','sku_row_key','recommended_review_action','recommended_review_reason','token_count','ingredient_match_count','signal_match_count','parser_cleanup_count','curated_signal_tail_count','parser_fragment_exclusion_count','canonical_ingredients','signal_display_names','signal_keys','suggested_decision','suggested_follow_up','suggestion_confidence','decision_rationale','decision','approved_follow_up','reviewer_notes','approved_decision','trust_tier','reviewer_notes_auto','review_status']
ws.append(header)
ws.append(['old_packet','70','Brand A','Product A','https://example.com/a','US','serum','sku-1','review_hybrid_ingredient_signal_sku','reason','2','1','1','0','0','0','Niacinamide','Rose Petal','rose_petal','confirm_hybrid_sku','follow','medium','rationale','approve_hybrid_review_candidate','approve_hybrid_review_candidate','note','approve_hybrid_review_candidate','medium','auto','approved'])
ws.append(['old_packet','60','Brand B','Product B','https://example.com/b','US','serum','sku-2','review_signal_led_sku','reason','1','0','1','0','0','0','','Ceramides','ceramides','confirm_signal_only_sku','follow','medium','rationale','approve_signal_preview_only__family_or_group_term','approve_signal_preview_only__family_or_group_term','note','approve_signal_preview_only__family_or_group_term','medium','auto','approved'])
wb.save(sys.argv[1])
`,
    'utf8',
  );

  const makeOld = spawnSync('python3', [makeOldPy, oldXlsx], { encoding: 'utf8' });
  assert.equal(makeOld.status, 0, makeOld.stderr);

  fs.writeFileSync(
    newCsv,
    [
      'source_packet,review_priority_score,brand_name,product_name,official_product_url,market,category,sku_row_key,recommended_review_action,recommended_review_reason,token_count,ingredient_match_count,signal_match_count,parser_cleanup_count,curated_signal_tail_count,parser_fragment_exclusion_count,canonical_ingredients,signal_display_names,signal_keys,suggested_decision,suggested_follow_up,suggestion_confidence,decision_rationale,decision,approved_follow_up,reviewer_notes',
      'new_packet,70,Brand A,Product A,https://example.com/a,US,serum,sku-1,review_hybrid_ingredient_signal_sku,reason,2,1,1,0,0,0,Niacinamide,Rose Petal,rose_petal,confirm_hybrid_sku,follow,medium,rationale,,,',
      'new_packet,60,Brand B,Product B,https://example.com/b,US,serum,sku-2,review_signal_led_sku,reason,1,1,1,0,0,0,Glycerin,Ceramides,ceramides,confirm_signal_only_sku,follow,medium,rationale,,,',
      '',
    ].join('\n'),
    'utf8',
  );

  const res = spawnSync(
    'python3',
    [
      'scripts/prefill_sku_ingredient_signal_manual_review_workbook.py',
      '--old-reviewed-xlsx',
      oldXlsx,
      '--new-manual-queue-csv',
      newCsv,
      '--out-xlsx',
      outXlsx,
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
  assert.equal(summary.carried_forward_count, 1);
  assert.equal(summary.needs_manual_review_count, 1);
});

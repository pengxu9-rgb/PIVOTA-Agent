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

test('build_ingredient_master_followup_packet builds row and unique-term followup sheets', () => {
  const repoRoot = '/Users/pengchydan/dev/Pivota-cursor-create-project-directory-structure-8344/pivota-agent-backend';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingredient-master-followup-'));
  const followupCsv = path.join(tempDir, 'followup.csv');
  const referenceCsv = path.join(tempDir, 'reference.csv');
  const signalCsv = path.join(tempDir, 'signals.csv');
  const outRows = path.join(tempDir, 'out_rows.csv');
  const outTerms = path.join(tempDir, 'out_terms.csv');
  const outSummary = path.join(tempDir, 'summary.json');
  const outXlsx = path.join(tempDir, 'packet.xlsx');

  writeCsv(
    followupCsv,
    [
      'sku_row_key',
      'brand_name',
      'product_name',
      'official_product_url',
      'market',
      'category',
      'followup_lane',
      'signal_display_names',
      'signal_keys',
      'canonical_ingredients',
      'approved_decision',
      'review_status',
      'trust_tier',
      'decision_rationale',
      'source_packet',
    ],
    [
      {
        sku_row_key: 'sku-1',
        brand_name: 'Clinique',
        product_name: 'Hydrator',
        official_product_url: 'https://example.com/1',
        market: 'US',
        category: 'cream',
        followup_lane: 'candidate_for_alias_or_canonical_followup',
        signal_display_names: 'pure glycerin; pure urea',
        signal_keys: 'glycerin; urea',
        canonical_ingredients: '',
        approved_decision: 'approve_signal_preview_only__candidate_for_alias_or_canonical_followup',
        review_status: 'approved',
        trust_tier: 'medium',
        decision_rationale: 'reviewed',
        source_packet: 'packet-a',
      },
      {
        sku_row_key: 'sku-2',
        brand_name: 'Guerlain',
        product_name: 'Oil Serum',
        official_product_url: 'https://example.com/2',
        market: 'US',
        category: 'serum',
        followup_lane: 'candidate_for_alias_or_canonical_followup',
        signal_display_names: 'Three black bee honeys; royal jelly',
        signal_keys: 'royal_jelly; three_black_bee_honeys',
        canonical_ingredients: '',
        approved_decision: 'approve_signal_preview_only__candidate_for_alias_or_canonical_followup',
        review_status: 'approved',
        trust_tier: 'medium',
        decision_rationale: 'reviewed',
        source_packet: 'packet-b',
      },
    ],
  );

  writeCsv(
    referenceCsv,
    [
      'canonical_display_name',
      'canonical_inci_name',
      'aliases_common',
      'us_label_variants',
      'eu_label_variants',
    ],
    [
      {
        canonical_display_name: 'Glycerin',
        canonical_inci_name: 'Glycerin',
        aliases_common: 'Glycerol',
        us_label_variants: 'Glycerin',
        eu_label_variants: 'Glycerin',
      },
      {
        canonical_display_name: 'Urea',
        canonical_inci_name: 'Urea',
        aliases_common: '',
        us_label_variants: 'Urea',
        eu_label_variants: 'Urea',
      },
      {
        canonical_display_name: 'Royal Jelly Extract',
        canonical_inci_name: 'Royal Jelly Extract',
        aliases_common: 'royal jelly extract',
        us_label_variants: 'Royal Jelly Extract',
        eu_label_variants: 'Royal Jelly Extract',
      },
    ],
  );

  writeCsv(
    signalCsv,
    ['signal_bucket', 'signal_key', 'display_signal_name'],
    [
      { signal_bucket: 'named_active_signal', signal_key: 'glycerin', display_signal_name: 'pure glycerin' },
      { signal_bucket: 'named_active_signal', signal_key: 'urea', display_signal_name: 'pure urea' },
      { signal_bucket: 'botanical_or_material_signal', signal_key: 'royal_jelly', display_signal_name: 'royal jelly' },
      {
        signal_bucket: 'botanical_or_material_signal',
        signal_key: 'three_black_bee_honeys',
        display_signal_name: 'Three black bee honeys',
      },
    ],
  );

  const result = spawnSync(
    'python3',
    [
      'scripts/build_ingredient_master_followup_packet.py',
      '--followup-csv',
      followupCsv,
      '--ingredient-reference-csv',
      referenceCsv,
      '--signal-dict-csv',
      signalCsv,
      '--out-rows-csv',
      outRows,
      '--out-terms-csv',
      outTerms,
      '--out-summary-json',
      outSummary,
      '--out-xlsx',
      outXlsx,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(fs.readFileSync(outSummary, 'utf8'));
  assert.equal(summary.followup_row_count, 2);
  assert.equal(summary.unique_term_count, 4);
  assert.equal(summary.term_lane_counts.existing_canonical_bridge, 3);
  assert.equal(summary.term_lane_counts.hold_signal_only_pending_confirmation, 1);

  const rowsText = fs.readFileSync(outRows, 'utf8');
  assert.match(rowsText, /split_row_terms_by_master_action/);
  assert.match(rowsText, /bridge_terms_to_existing_canonical_rows/);

  const termsText = fs.readFileSync(outTerms, 'utf8');
  assert.match(termsText, /bridge_signal_to_existing_canonical__glycerin/);
  assert.match(termsText, /add_common_alias_to_existing_canonical__royal_jelly_extract/);
  assert.match(termsText, /keep_signal_only__marketing_blend_not_safe_for_master/);
  assert.ok(fs.existsSync(outXlsx));
});

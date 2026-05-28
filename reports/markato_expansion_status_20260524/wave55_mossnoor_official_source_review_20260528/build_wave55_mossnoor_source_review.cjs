#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const outDir = __dirname;

const reviewedRows = [
  {
    priority: 'P0',
    external_product_id: 'ext_a7ab937f43db2868c6f9e383',
    title: 'After Workout Shower Gel - Clean Eucalyptus',
    canonical_url: 'https://mossnoor.com/products/after-workout-shower-gel-clean-eucalyptus',
    current_quality_flags: 'missing_how_to',
    official_source_status: 'official_pdp_reviewed',
    official_inci_found: true,
    official_how_to_found: false,
    pdp_ingredients_raw:
      'Aqua, Sodium Laureth Sulfate, Cocamidopropyl Betaine, Sodium Chloride, Disodium Laureth Sulfosuccinate, Glycerin, Sodium Cocoamphoacetate, Urea, Phenoxyethanol, PEG-7 Glyceryl Cocoate, Lactic Acid, Eucalyptus Globulus Leaf Oil, Menthol, Benzoic Acid, Magnesium Aspartate, Zinc Gluconate, Dehydroacetic Acid, Limonene, Sodium Benzoate, Copper Gluconate, Linalool.',
    source_observation:
      'Official PDP has title, description, scent, size, and INCI. It does not expose explicit use directions beyond shower-gel product context.',
    reviewer_decision: 'source_confirms_inci_but_how_to_still_blocked',
    patch_scope: 'none_current_row_already_not_flagged_missing_inci',
  },
  {
    priority: 'P0',
    external_product_id: 'ext_83b8555768814cac5243aef1',
    title: 'After Workout Shower Gel - Crispy Cucumber 500 ml',
    canonical_url: 'https://mossnoor.com/products/after-workout-shower-gel-crispy-cucumber',
    current_quality_flags: 'missing_full_inci|missing_how_to',
    official_source_status: 'official_pdp_reviewed',
    official_inci_found: true,
    official_how_to_found: false,
    pdp_ingredients_raw:
      'Aqua, Sodium Laureth Sulfate, Sodium Chloride, Cocamidopropyl Betaine, Disodium Laureth Sulfosuccinate, Propanediol, Glycerin, Sodium Cocoamphoacetate, Urea, Phenoxyethanol, PEG-7 Glyceryl Cocoate, Lactic Acid, Parfum, Menthol, Benzoic Acid, Magnesium Aspartate, Zinc Gluconate, Dehydroacetic Acid, Sodium Benzoate, Copper Gluconate.',
    source_observation:
      'Official PDP has title, description, scent, size, and INCI. It does not expose explicit use directions beyond shower-gel product context.',
    reviewer_decision: 'ingredients_only_dry_run_candidate_but_how_to_still_blocked',
    patch_scope: 'pdp_ingredients_raw_only',
  },
  {
    priority: 'P0',
    external_product_id: 'ext_67472974111568c15ac3920d',
    title: 'After Workout Shower Gel - Fresh Grapefruit',
    canonical_url: 'https://mossnoor.com/products/shower-gel',
    current_quality_flags: 'missing_full_inci|missing_how_to',
    official_source_status: 'official_pdp_reviewed',
    official_inci_found: true,
    official_how_to_found: false,
    pdp_ingredients_raw:
      'Aqua, Sodium Laureth Sulfate, Cocamidopropyl Betaine, Disodium Laureth Sulfosuccinate, Propanediol, Glycerin, Sodium Cocoamphoacetate, Sodium Chloride, Urea, Menthol, Zinc Gluconate, Magnesium Aspartate, PEG-7 Glyceryl Cocoate, Copper Gluconate, Phenoxyethanol, Benzoic Acid, Dehydroacetic Acid, Sodium Benzoate, Parfum, Limonene, Linalool.',
    source_observation:
      'Official PDP has title, description, scent, size, and INCI. It does not expose explicit use directions beyond shower-gel product context.',
    reviewer_decision: 'ingredients_only_dry_run_candidate_but_how_to_still_blocked',
    patch_scope: 'pdp_ingredients_raw_only',
  },
  {
    priority: 'P0',
    external_product_id: 'ext_cf945cc7bfe99bf9864bd6df',
    title: 'After Workout Shower Gel - Fresh Grapefruit 500 ml',
    canonical_url: 'https://mossnoor.com/products/after-workout-shower-gel-fresh-grapefruit-500-ml',
    current_quality_flags: 'missing_full_inci|missing_how_to',
    official_source_status: 'official_pdp_reviewed',
    official_inci_found: true,
    official_how_to_found: false,
    pdp_ingredients_raw:
      'Aqua, Sodium Laureth Sulfate, Sodium Chloride, Cocamidopropyl Betaine, Disodium Laureth Sulfosuccinate, Propanediol, Glycerin, Sodium Cocoamphoacetate, Urea, Phenoxyethanol, PEG-7 Glyceryl Cocoate, Lactic Acid, Menthol, Benzoic Acid, Magnesium Aspartate, Zinc Gluconate, Dehydroacetic Acid, Sodium Benzoate, Copper Gluconate, Parfum, Limonene, Linalool, Citrus Aurantium Peel Oil.',
    source_observation:
      'Official PDP has title, description, scent, size, and INCI. It does not expose explicit use directions beyond shower-gel product context.',
    reviewer_decision: 'ingredients_only_dry_run_candidate_but_how_to_still_blocked',
    patch_scope: 'pdp_ingredients_raw_only',
  },
  {
    priority: 'P0',
    external_product_id: 'ext_876342422f9629ea9363953c',
    title: 'After Workout Shower Gel - Light Mint',
    canonical_url: 'https://mossnoor.com/products/after-workout-shower-gel-light-mint',
    current_quality_flags: 'missing_full_inci|missing_how_to',
    official_source_status: 'official_pdp_reviewed',
    official_inci_found: true,
    official_how_to_found: false,
    pdp_ingredients_raw:
      'Aqua, Sodium Laureth Sulfate, Cocamidopropyl Betaine, Disodium Laureth Sulfosuccinate, Propanediol, Glycerin, Sodium Cocoamphoacetate, Sodium Chloride, Urea, Menthol, Zinc Gluconate, Magnesium Aspartate, PEG-7 Glyceryl Cocoate, Copper Gluconate, Phenoxyethanol, Benzoic Acid, Dehydroacetic Acid, Sodium Benzoate, Parfum, Limonene, Linalool, Citral.',
    source_observation:
      'Official PDP has title, description, scent, size, and INCI. It does not expose explicit use directions beyond shower-gel product context.',
    reviewer_decision: 'ingredients_only_dry_run_candidate_but_how_to_still_blocked',
    patch_scope: 'pdp_ingredients_raw_only',
  },
];

function toCsvValue(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(name, columns, rows) {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => toCsvValue(row[column])).join(',')),
  ];
  fs.writeFileSync(path.join(outDir, name), `${lines.join('\n')}\n`);
}

function markdownTable(columns, rows) {
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(row[column] ?? '').replaceAll('|', '\\|')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

const reviewColumns = [
  'priority',
  'external_product_id',
  'title',
  'canonical_url',
  'current_quality_flags',
  'official_source_status',
  'official_inci_found',
  'official_how_to_found',
  'reviewer_decision',
  'patch_scope',
  'source_observation',
];

const patchColumns = [
  'external_product_id',
  'title',
  'canonical_url',
  'patch_scope',
  'pdp_ingredients_raw',
  'review_gate',
  'serving_action',
];

const howToColumns = [
  'external_product_id',
  'title',
  'canonical_url',
  'current_quality_flags',
  'requested_source_fields',
  'serving_action',
  'reviewer_notes',
];

const ingredientsPatchCandidates = reviewedRows
  .filter((row) => row.patch_scope === 'pdp_ingredients_raw_only')
  .map((row) => ({
    ...row,
    review_gate: 'run production dry-run and human review before any apply',
    serving_action: 'do_not_promote_from_wave55',
  }));

const howToRequests = reviewedRows.map((row) => ({
  ...row,
  requested_source_fields: 'official product-specific directions / how-to',
  serving_action: 'do_not_promote_from_wave55',
  reviewer_notes:
    'Current official PDP review did not find explicit directions; keep the row held unless brand/partner source provides product-specific use instructions.',
}));

writeCsv('mossnoor_official_pdp_source_review.csv', reviewColumns, reviewedRows);
writeCsv('mossnoor_ingredients_only_patch_candidates.csv', patchColumns, ingredientsPatchCandidates);
writeCsv('mossnoor_remaining_how_to_requests.csv', howToColumns, howToRequests);

const manifest = {
  generated_at: '2026-05-28',
  brand: 'Moss & Noor',
  domain: 'mossnoor.com',
  runtime_database_writes: 0,
  serving_promotions_approved: 0,
  official_pdp_rows_reviewed: reviewedRows.length,
  official_inci_found_rows: reviewedRows.filter((row) => row.official_inci_found).length,
  official_how_to_found_rows: reviewedRows.filter((row) => row.official_how_to_found).length,
  ingredients_only_patch_candidate_rows: ingredientsPatchCandidates.length,
  remaining_how_to_request_rows: howToRequests.length,
  decision:
    'Official PDPs can support an ingredients-only dry-run for four Moss & Noor shower gel rows, but no row is serving-ready because product-specific how-to remains missing.',
  artifacts: [
    'mossnoor_official_pdp_source_review.csv',
    'mossnoor_ingredients_only_patch_candidates.csv',
    'mossnoor_remaining_how_to_requests.csv',
    'wave55_mossnoor_official_source_review_manifest.json',
    'wave55_mossnoor_official_source_review_closeout_20260528.md',
  ],
};

fs.writeFileSync(
  path.join(outDir, 'wave55_mossnoor_official_source_review_manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const closeout = `# Markato Wave55 Moss & Noor Official Source Review - 2026-05-28

## Reviewer Decision

Wave55 reviewed the five Moss & Noor P0 source-acquisition rows from Wave51 against current official Moss & Noor PDPs.

- Runtime/database writes performed: no
- Railway CLI deployment action performed: no
- Serving promotions approved: 0
- Official PDP rows reviewed: ${manifest.official_pdp_rows_reviewed}
- Official INCI found: ${manifest.official_inci_found_rows}
- Official how-to found: ${manifest.official_how_to_found_rows}
- Ingredients-only dry-run candidates: ${manifest.ingredients_only_patch_candidate_rows}
- Remaining how-to requests: ${manifest.remaining_how_to_request_rows}

## Finding

The official Moss & Noor shower gel PDPs expose title, description, scent, size, and full INCI. They do not expose explicit product-use directions. That means four rows can move to an ingredients-only production dry-run, but none should be promoted or marked ready from Wave55.

## Ingredients-Only Candidates

${markdownTable(
  ['external_product_id', 'title', 'canonical_url', 'patch_scope'],
  ingredientsPatchCandidates,
)}

## Still Blocked On How-To

${markdownTable(
  ['external_product_id', 'title', 'canonical_url', 'requested_source_fields'],
  howToRequests,
)}

## Operator Instructions

1. If production DB access is available, run an official-html dry-run for the four \`pdp_ingredients_raw_only\` rows before any apply.
2. Do not promote any Moss & Noor row from this wave; product-specific how-to remains missing for all five.
3. Ask brand/partner source for explicit shower-gel directions if the serving gate continues to require how-to.
4. Treat the Clean Eucalyptus row as source-confirmed but not an ingredients patch candidate because its current blocker is only \`missing_how_to\`.

## Artifacts

- \`mossnoor_official_pdp_source_review.csv\`
- \`mossnoor_ingredients_only_patch_candidates.csv\`
- \`mossnoor_remaining_how_to_requests.csv\`
- \`wave55_mossnoor_official_source_review_manifest.json\`
`;

fs.writeFileSync(
  path.join(outDir, 'wave55_mossnoor_official_source_review_closeout_20260528.md'),
  closeout,
);

console.log(JSON.stringify(manifest, null, 2));

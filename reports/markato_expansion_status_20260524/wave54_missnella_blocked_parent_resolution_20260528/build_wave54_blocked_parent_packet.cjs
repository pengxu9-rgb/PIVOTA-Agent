#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../..');
const inputPath = path.join(
  repoRoot,
  'reports/markato_expansion_status_20260524/wave52_missnella_canonical_mapping_20260528/missnella_blocked_parent_requests.csv'
);
const outDir = __dirname;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((candidate) => candidate.some((value) => value !== ''));
}

function toCsvValue(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(fileName, columns, rows) {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => toCsvValue(row[column])).join(',')),
  ];
  fs.writeFileSync(path.join(outDir, fileName), `${lines.join('\n')}\n`);
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => {
    const value = row[key] || '';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function markdownTable(columns, rows) {
  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(row[column] ?? '').replaceAll('|', '\\|')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

const parsed = parseCsv(fs.readFileSync(inputPath, 'utf8'));
const [headers, ...dataRows] = parsed;
const records = dataRows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));

const laneForDecision = {
  blocked_missing_ready_parent: 'create_or_source_ready_parent',
  blocked_parent_not_ready: 'clear_existing_parent_review',
  blocked_ambiguous_family_parent: 'split_or_terminal_hold_family_selector',
};

const actionForDecision = {
  blocked_missing_ready_parent:
    'Request official single-shade parent evidence or create a reviewed canonical parent before any child attachment.',
  blocked_parent_not_ready:
    'Clear the target parent source/risk/evidence blockers first, then rerun a metadata-only component-ref dry-run for the child row.',
  blocked_ambiguous_family_parent:
    'Split the family selector into explicit concrete variants with official source evidence, or keep the selector terminal-held.',
};

const requestedEvidenceForDecision = {
  blocked_missing_ready_parent:
    'official canonical single-shade PDP or partner sheet; product identity/shade; full INCI if formula parent will be created; product-specific directions/how-to; pack/add-on relationship evidence',
  blocked_parent_not_ready:
    'official full INCI and product-specific directions/how-to for the target parent; claim/risk evidence if parent flags require review',
  blocked_ambiguous_family_parent:
    'explicit variant list and concrete PDPs or partner sheet rows for each variant; do not map selector to one formula',
};

const normalizedRows = records.map((row) => ({
  priority: row.priority,
  external_product_id: row.external_product_id,
  title: row.title,
  canonical_url: row.canonical_url,
  blocker_decision: row.decision,
  wave54_lane: laneForDecision[row.decision] || 'manual_review',
  target_parent_external_product_id: row.target_parent_external_product_id,
  target_parent_title: row.target_parent_title || row.component_role,
  target_parent_lane: row.target_parent_lane,
  target_parent_flags: row.target_parent_flags,
  requested_evidence: requestedEvidenceForDecision[row.decision] || 'manual evidence review',
  next_safe_step: actionForDecision[row.decision] || row.next_safe_step,
  review_gate: 'human reviewer must approve parent readiness before any metadata apply or serving eligibility change',
  serving_action: 'do_not_promote_from_wave54',
  reviewer_notes: row.reviewer_notes,
}));

const missingParentRows = normalizedRows.filter((row) => row.blocker_decision === 'blocked_missing_ready_parent');
const nonReadyParentRows = normalizedRows.filter((row) => row.blocker_decision === 'blocked_parent_not_ready');
const ambiguousRows = normalizedRows.filter((row) => row.blocker_decision === 'blocked_ambiguous_family_parent');

const commonColumns = [
  'priority',
  'external_product_id',
  'title',
  'canonical_url',
  'blocker_decision',
  'wave54_lane',
  'target_parent_external_product_id',
  'target_parent_title',
  'target_parent_lane',
  'target_parent_flags',
  'requested_evidence',
  'next_safe_step',
  'review_gate',
  'serving_action',
  'reviewer_notes',
];

writeCsv('missnella_blocked_parent_resolution_queue.csv', commonColumns, normalizedRows);
writeCsv('missnella_missing_ready_parent_source_requests.csv', commonColumns, missingParentRows);
writeCsv('missnella_non_ready_parent_review_requests.csv', commonColumns, nonReadyParentRows);
writeCsv('missnella_ambiguous_family_selector_holds.csv', commonColumns, ambiguousRows);

const missingParentSummary = Object.entries(countBy(missingParentRows, 'target_parent_title'))
  .map(([target_parent_title, child_rows]) => ({ target_parent_title, child_rows }))
  .sort((a, b) => Number(b.child_rows) - Number(a.child_rows) || a.target_parent_title.localeCompare(b.target_parent_title));

const nonReadyParentSummary = nonReadyParentRows.map((row) => ({
  target_parent_title: row.target_parent_title,
  target_parent_external_product_id: row.target_parent_external_product_id,
  target_parent_lane: row.target_parent_lane,
  target_parent_flags: row.target_parent_flags,
  child_external_product_id: row.external_product_id,
  child_title: row.title,
}));

const ambiguousSummary = ambiguousRows.map((row) => ({
  selector_surface: row.title,
  external_product_id: row.external_product_id,
  canonical_url: row.canonical_url,
  action: row.next_safe_step,
}));

const manifest = {
  generated_at: '2026-05-28',
  source: path.relative(repoRoot, inputPath),
  runtime_database_writes: 0,
  serving_promotions_approved: 0,
  total_blocked_rows: normalizedRows.length,
  counts: {
    by_blocker_decision: countBy(normalizedRows, 'blocker_decision'),
    by_wave54_lane: countBy(normalizedRows, 'wave54_lane'),
    missing_ready_parent_rows: missingParentRows.length,
    non_ready_parent_rows: nonReadyParentRows.length,
    ambiguous_family_selector_rows: ambiguousRows.length,
  },
  review_gates: [
    'No Wave54 row is approved for serving promotion.',
    'No ingredient, how-to, or product-intel content should be inherited from a parent through this packet.',
    'Rows in clear_existing_parent_review must wait until the target parent clears source/risk/evidence review.',
    'Rows in create_or_source_ready_parent must wait for an official source-backed canonical parent.',
    'Rows in split_or_terminal_hold_family_selector must be split into explicit variants or remain held.',
  ],
  artifacts: [
    'missnella_blocked_parent_resolution_queue.csv',
    'missnella_missing_ready_parent_source_requests.csv',
    'missnella_non_ready_parent_review_requests.csv',
    'missnella_ambiguous_family_selector_holds.csv',
    'wave54_parent_resolution_manifest.json',
    'wave54_missnella_blocked_parent_resolution_closeout_20260528.md',
  ],
};

fs.writeFileSync(
  path.join(outDir, 'wave54_parent_resolution_manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`
);

const markdown = `# Markato Wave54 Miss Nella Blocked Parent Resolution - 2026-05-28

## Reviewer Decision

Wave54 converts the 20 Miss Nella rows blocked in Wave52 into concrete review queues. This is a review and acquisition packet only.

- Runtime/database writes performed: no
- Railway CLI deployment action performed: no
- Serving promotions approved: 0
- Blocked rows triaged: ${normalizedRows.length}
- Missing ready parent rows: ${missingParentRows.length}
- Non-ready parent rows: ${nonReadyParentRows.length}
- Ambiguous family selector rows: ${ambiguousRows.length}

## Lane Counts

${markdownTable(
  ['wave54_lane', 'count'],
  Object.entries(manifest.counts.by_wave54_lane).map(([wave54_lane, count]) => ({ wave54_lane, count }))
)}

## Missing Ready Parent Queue

These rows need an official source-backed canonical parent before any metadata attachment. Do not infer a parent from a 3-pack, wholesale, or add-on page alone.

${markdownTable(['target_parent_title', 'child_rows'], missingParentSummary)}

## Non-Ready Parent Queue

These rows have a likely parent, but the parent itself is not ready enough to authorize a child mapping.

${markdownTable(
  [
    'target_parent_title',
    'target_parent_external_product_id',
    'target_parent_lane',
    'target_parent_flags',
    'child_external_product_id',
    'child_title',
  ],
  nonReadyParentSummary
)}

## Ambiguous Selector Holds

These rows represent family/selector surfaces. A single formula mapping would be unsafe.

${markdownTable(['selector_surface', 'external_product_id', 'canonical_url', 'action'], ambiguousSummary)}

## Operator Instructions

1. Work \`missnella_non_ready_parent_review_requests.csv\` first if official parent evidence is available. Clearing three parent rows can unblock three child mappings without creating new canonical rows.
2. Work \`missnella_missing_ready_parent_source_requests.csv\` only with official source-backed single-shade evidence or a reviewed canonical parent creation path.
3. Keep \`missnella_ambiguous_family_selector_holds.csv\` out of serving until explicit variants are split and reviewed.
4. After parent readiness changes, run a production read-only component-ref dry-run before any metadata apply.
5. Do not inherit ingredients, how-to, or product-intel from parent rows through this packet.

## Artifacts

- \`missnella_blocked_parent_resolution_queue.csv\`
- \`missnella_missing_ready_parent_source_requests.csv\`
- \`missnella_non_ready_parent_review_requests.csv\`
- \`missnella_ambiguous_family_selector_holds.csv\`
- \`wave54_parent_resolution_manifest.json\`
`;

fs.writeFileSync(
  path.join(outDir, 'wave54_missnella_blocked_parent_resolution_closeout_20260528.md'),
  markdown
);

console.log(JSON.stringify(manifest.counts, null, 2));

#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { hasCommerceTruthClaim } = require('../src/services/pivotaInsightsQuality');

const OWNER_DELEGATED_REVIEW_CONTRACT_VERSION = 'pivota.owner_delegated_review.v1';

function parseArgs(argv) {
  const out = {
    compare: '',
    reviewPacket: '',
    out: '',
    ownerDelegated: false,
    reviewer: 'codex_quality_reviewer',
    reviewedAt: '',
    ownerInstruction: '',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--compare' && next) {
      out.compare = next;
      i += 1;
    } else if (token === '--review-packet' && next) {
      out.reviewPacket = next;
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (token === '--reviewer' && next) {
      out.reviewer = next;
      i += 1;
    } else if (token === '--reviewed-at' && next) {
      out.reviewedAt = next;
      i += 1;
    } else if (token === '--owner-instruction' && next) {
      out.ownerInstruction = next;
      i += 1;
    } else if (token === '--owner-delegated') {
      out.ownerDelegated = true;
    }
  }

  return out;
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeReviewedAt(value) {
  const text = asString(value);
  const date = text ? new Date(text) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`invalid_reviewed_at:${text}`);
  return date.toISOString();
}

function readRows(report) {
  return asArray(report?.rows);
}

function inferReviewDecision(compareRow) {
  const selectedMode = asString(compareRow?.selected?.selected_mode).toLowerCase();
  const selectedFieldCount = Number(compareRow?.selected?.selected_field_count || 0) || 0;
  if (
    selectedFieldCount > 0 ||
    selectedMode.includes('rewrite') ||
    selectedMode.includes('manual_override') ||
    selectedMode.includes('human_standard')
  ) {
    return 'rewrite';
  }
  return 'pass';
}

function assertPublishableRecommendedRow(compareRow, reviewRow) {
  const caseId = asString(reviewRow?.case_id || compareRow?.case_id);
  const selected = compareRow?.selected || null;
  const bundle = selected?.bundle || null;
  if (!caseId) throw new Error('missing_case_id');
  if (!selected || !bundle) throw new Error(`selected_bundle_missing:${caseId}`);
  if (asString(selected.selected_mode).toLowerCase() === 'baseline_only') {
    throw new Error(`baseline_only_not_publishable:${caseId}`);
  }
  if (asString(reviewRow?.review_decision) !== 'pass_recommended') {
    throw new Error(`review_recommendation_not_passed:${caseId}`);
  }
  if (asString(reviewRow?.reviewer_kind) !== 'assistant') {
    throw new Error(`reviewer_kind_must_be_assistant:${caseId}`);
  }
  if (asArray(reviewRow?.candidate_issues).length || asArray(reviewRow?.agent_unknowns).length) {
    throw new Error(`precheck_issues_present:${caseId}`);
  }
  if (hasCommerceTruthClaim(bundle)) {
    throw new Error(`commerce_truth_claim:${caseId}`);
  }
}

function buildOwnerDelegatedPublishRow(compareRow, reviewRow, options = {}) {
  assertPublishableRecommendedRow(compareRow, reviewRow);
  const selected = cloneJson(compareRow.selected);
  const canonical =
    selected?.bundle?.canonical_product_ref ||
    compareRow?.baseline?.canonical_product_ref ||
    null;
  const caseId = asString(compareRow?.case_id || reviewRow?.case_id);
  const reviewedAt = normalizeReviewedAt(options.reviewedAt);
  const reviewer = asString(options.reviewer) || 'codex_quality_reviewer';
  const ownerInstruction =
    asString(options.ownerInstruction) ||
    'Owner delegated Codex to perform the substantive quality review and approval process.';

  return {
    case_id: caseId,
    review_status: 'completed',
    review_decision: inferReviewDecision(compareRow),
    reviewer,
    reviewer_kind: 'assistant',
    reviewed_at: reviewedAt,
    notes:
      'Owner-delegated assistant quality review. This is not labeled as human review; public display still depends on product-intel review policy gates.',
    owner_delegated_review: {
      contract_version: OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
      delegated_to: reviewer,
      reviewer_kind: 'assistant',
      owner_instruction: ownerInstruction,
      source_review_packet_decision: asString(reviewRow.review_decision),
      source_public_write_allowed_by_packet: Boolean(reviewRow.public_write_allowed_by_this_packet),
      rationale: asString(reviewRow.rationale),
      candidate_bundle_hash: asString(reviewRow.candidate_bundle_hash),
      previous_bundle_hash: asString(reviewRow.previous_bundle_hash),
    },
    quality_improvement_review: {
      decision: 'approved_replacement',
      reviewer,
      reviewer_kind: 'assistant',
      owner_delegated: true,
      approval_basis: 'owner_delegated_assistant_quality_review',
      reason:
        asString(reviewRow.rationale) ||
        'Owner-delegated assistant review approved this replacement as a quality improvement.',
      candidate_bundle_hash: asString(reviewRow.candidate_bundle_hash),
      previous_bundle_hash: asString(reviewRow.previous_bundle_hash),
    },
    baseline: {
      canonical_product_ref: canonical,
    },
    selected,
  };
}

function buildOwnerDelegatedPublishReport(compareReport, reviewPacket, options = {}) {
  if (options.ownerDelegated !== true) {
    throw new Error('owner_delegation_required');
  }
  const compareRows = readRows(compareReport);
  const reviewRows = readRows(reviewPacket);
  const compareByCaseId = new Map(compareRows.map((row) => [asString(row?.case_id), row]));
  const reviewedAt = normalizeReviewedAt(options.reviewedAt);
  const rowOptions = {
    ...options,
    reviewedAt,
  };
  const targetRows = reviewRows.map((reviewRow) => {
    const caseId = asString(reviewRow?.case_id);
    const compareRow = compareByCaseId.get(caseId);
    if (!compareRow) throw new Error(`compare_row_missing:${caseId || 'unknown'}`);
    return buildOwnerDelegatedPublishRow(compareRow, reviewRow, rowOptions);
  });

  return {
    meta: {
      generated_at: reviewedAt,
      source: 'owner_delegated_assistant_review_publish_report',
      review_contract_version: OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
      source_compare_rows: compareRows.length,
      source_review_rows: reviewRows.length,
      selected_cases: targetRows.length,
      reviewer: asString(options.reviewer) || 'codex_quality_reviewer',
      reviewer_kind: 'assistant',
    },
    rows: targetRows,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const comparePath = resolvePath(rootDir, args.compare);
  const reviewPacketPath = resolvePath(rootDir, args.reviewPacket);
  const outPath = resolvePath(rootDir, args.out);

  if (!comparePath) throw new Error('missing_compare_path');
  if (!reviewPacketPath) throw new Error('missing_review_packet_path');
  if (!outPath) throw new Error('missing_out_path');

  const report = buildOwnerDelegatedPublishReport(readJson(comparePath), readJson(reviewPacketPath), {
    ownerDelegated: args.ownerDelegated,
    reviewer: args.reviewer,
    reviewedAt: args.reviewedAt,
    ownerInstruction: args.ownerInstruction,
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      compare: comparePath,
      review_packet: reviewPacketPath,
      out: outPath,
      rows: report.rows.map((row) => row.case_id),
    })}\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  OWNER_DELEGATED_REVIEW_CONTRACT_VERSION,
  buildOwnerDelegatedPublishReport,
  buildOwnerDelegatedPublishRow,
  inferReviewDecision,
  parseArgs,
};

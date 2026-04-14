#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  applyExternalHighlightReviewDecision,
} = require('../src/services/pivotaExternalHighlights');
const {
  buildHighlightSourcesSummary,
} = require('../src/services/pivotaEvidenceSignals');
const {
  deriveReviewContractFromReportRow,
} = require('../src/services/pivotaProductIntelReviewPolicy');

function parseArgs(argv) {
  const out = {
    generated: '',
    decisions: '',
    out: '',
    reviewBatch: '',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--generated' && next) {
      out.generated = next;
      i += 1;
    } else if (token === '--decisions' && next) {
      out.decisions = next;
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (token === '--review-batch' && next) {
      out.reviewBatch = next;
      i += 1;
    }
  }
  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildDecisionLookup(raw) {
  if (!raw) return {};
  if (Array.isArray(raw.rows)) {
    return raw.rows.reduce((acc, row) => {
      acc[asString(row.case_id)] = row;
      return acc;
    }, {});
  }
  return raw;
}

function reviewGeneratedReport(generatedReport, decisionLookup = {}, reviewBatch = '') {
  return {
    contract_version: 'pivota.product_intel_highlights_review.v1',
    generated_at: new Date().toISOString(),
    review_batch: asString(reviewBatch) || null,
    rows: toList(generatedReport?.rows).map((row) => {
      const decisionRow = decisionLookup[asString(row.case_id)] || {};
      const reviewDecision = asString(
        decisionRow.review_decision || decisionRow.decision || 'pass',
      ).toLowerCase();
      const rejectionReason = asString(
        decisionRow.rejection_reason || decisionRow.rejectionReason,
      );
      const notes = asString(decisionRow.notes);
      const reviewedBundle = applyExternalHighlightReviewDecision({
        bundle: row?.generated?.bundle,
        product: row?.product || {},
        decision: reviewDecision,
        rewrite: decisionRow.rewrite || {},
        notes,
        reviewBatch,
      });
      const reviewContract = deriveReviewContractFromReportRow({
        ...decisionRow,
        review_status: decisionRow.review_status || 'completed',
        review_decision: reviewDecision,
      });
      return {
        case_id: asString(row.case_id),
        canonical_product_ref: row?.canonical_product_ref || null,
        product: row?.product || {},
        baseline: row?.baseline || null,
        generated: row?.generated || null,
        selected: {
          selected_mode: `external_highlight_${reviewDecision}`,
          selected_field_count:
            reviewDecision === 'reject_external' || reviewDecision === 'seller_only_fallback'
              ? 0
              : 1,
          field_sources:
            reviewDecision === 'pass'
              ? { external_highlight_signals: 'review_pass' }
              : reviewDecision === 'rewrite'
                ? { external_highlight_signals: 'manual_rewrite' }
                : { external_highlight_signals: 'rejected' },
          bundle: reviewedBundle,
        },
        external_highlight_preview: toList(reviewedBundle?.external_highlight_signals),
        highlight_sources_summary: buildHighlightSourcesSummary(
          reviewedBundle?.external_highlight_signals,
        ),
        review_status: reviewContract.review_status || 'completed',
        decision: reviewDecision,
        review_decision: reviewContract.review_decision || reviewDecision,
        reviewer: reviewContract.reviewer,
        reviewer_kind: reviewContract.reviewer_kind,
        reviewed_at: reviewContract.reviewed_at,
        review_tier: reviewContract.review_tier,
        rejection_reason: rejectionReason,
        notes,
      };
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const generatedPath = resolvePath(rootDir, args.generated);
  const decisionsPath = resolvePath(rootDir, args.decisions);
  const outPath = resolvePath(rootDir, args.out);
  const generatedReport = readJson(generatedPath);
  const decisionLookup = buildDecisionLookup(decisionsPath ? readJson(decisionsPath) : null);
  const report = reviewGeneratedReport(generatedReport, decisionLookup, args.reviewBatch);
  if (outPath) writeJson(outPath, report);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      report_rows: report.rows.length,
      out: outPath || null,
    })}\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  reviewGeneratedReport,
};

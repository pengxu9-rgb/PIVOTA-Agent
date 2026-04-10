#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { buildProductIntelDraftBundle } = require('../src/pdpProductIntel');
const {
  augmentProductIntelWithHighlights,
} = require('../src/services/pivotaExternalHighlights');
const {
  buildHighlightSourcesSummary,
  normalizeCommunitySignals,
  normalizeMarketSignalBadges,
  normalizeReviewSummary,
} = require('../src/services/pivotaEvidenceSignals');

function parseArgs(argv) {
  const out = {
    cases: 'scripts/fixtures/product_intel_pilot_cases.json',
    evidence: '',
    out: '',
    model: process.env.PIVOTA_EXTERNAL_HIGHLIGHT_MODEL || 'external_highlight_pipeline_v1',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cases' && next) {
      out.cases = next;
      i += 1;
    } else if (token === '--evidence' && next) {
      out.evidence = next;
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    } else if (token === '--model' && next) {
      out.model = next;
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

function buildEvidenceLookup(report) {
  return toList(report?.rows).reduce((acc, row) => {
    acc[asString(row.case_id)] = row;
    return acc;
  }, {});
}

function buildEvidenceBackedProduct(product, evidenceRow) {
  const base = product && typeof product === 'object' ? product : {};
  const rawEvidence =
    evidenceRow?.raw_evidence_pack && typeof evidenceRow.raw_evidence_pack === 'object'
      ? evidenceRow.raw_evidence_pack
      : {};
  const reviewSummary =
    normalizeReviewSummary(rawEvidence.review_summary) ||
    normalizeReviewSummary(base.review_summary);
  const communitySignals =
    normalizeCommunitySignals(rawEvidence.community_signals) ||
    normalizeCommunitySignals(base.community_signals);
  const marketSignalBadges = normalizeMarketSignalBadges(
    rawEvidence.market_signal_badges || base.market_signal_badges,
  );

  return {
    ...base,
    ...(reviewSummary ? { review_summary: reviewSummary } : {}),
    ...(communitySignals ? { community_signals: communitySignals } : {}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
  };
}

function generateFromEvidenceReport(cases, evidenceReport, model = 'external_highlight_pipeline_v1') {
  const evidenceLookup = buildEvidenceLookup(evidenceReport);
  return {
    contract_version: 'pivota.product_intel_highlights_generation.v1',
    generated_at: new Date().toISOString(),
    external_evidence_model: asString(model) || 'external_highlight_pipeline_v1',
    rows: toList(cases).map((caseRow) => {
      const evidenceRow = evidenceLookup[asString(caseRow?.case_id)] || {};
      const evidenceBackedProduct = buildEvidenceBackedProduct(caseRow?.product || {}, evidenceRow);
      const baselineBundle = buildProductIntelDraftBundle({
        product: evidenceBackedProduct,
        canonicalProductRef: caseRow?.canonical_product_ref || null,
      });
      const generatedBundle = augmentProductIntelWithHighlights({
        baseBundle: baselineBundle,
        product: evidenceBackedProduct,
        externalHighlightSignals: evidenceRow.external_highlight_signals || [],
        evidenceModel: model,
      });
      return {
        case_id: asString(caseRow?.case_id),
        canonical_product_ref: caseRow?.canonical_product_ref || null,
        product: evidenceBackedProduct,
        baseline: {
          bundle: baselineBundle,
        },
        generated: {
          bundle: generatedBundle,
        },
        external_highlight_preview: toList(generatedBundle?.external_highlight_signals),
        highlight_sources_summary: buildHighlightSourcesSummary(
          generatedBundle?.external_highlight_signals,
        ),
      };
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const casesPath = resolvePath(rootDir, args.cases);
  const evidencePath = resolvePath(rootDir, args.evidence);
  const outPath = resolvePath(rootDir, args.out);
  const casesFile = readJson(casesPath);
  const cases = toList(casesFile?.rows || casesFile);
  const evidenceReport = readJson(evidencePath);
  const report = generateFromEvidenceReport(cases, evidenceReport, args.model);
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
  buildEvidenceBackedProduct,
  generateFromEvidenceReport,
};

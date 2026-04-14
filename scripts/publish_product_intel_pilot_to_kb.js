#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { upsertProductIntelKbEntry } = require('../src/auroraBff/productIntelKbStore');
const { closePool, query } = require('../src/db');
const { PRODUCT_INTEL_CONTRACT_VERSION } = require('../src/pdpProductIntel');
const {
  deriveReviewContractFromReportRow,
} = require('../src/services/pivotaProductIntelReviewPolicy');

function parseArgs(argv) {
  const out = {
    report: '',
    caseIds: [],
    write: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--report' && next) {
      out.report = next;
      i += 1;
    } else if (token === '--case-ids' && next) {
      out.caseIds = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--write') {
      out.write = true;
    }
  }

  return out;
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pickRows(report, caseIds) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  if (!caseIds.length) return rows;
  const allow = new Set(caseIds);
  return rows.filter((row) => allow.has(asString(row.case_id)));
}

function buildKbEntriesForRow(row) {
  const selectedBundle = row?.selected?.bundle;
  const canonical = selectedBundle?.canonical_product_ref || row?.baseline?.canonical_product_ref || null;
  const productId = asString(canonical?.product_id);
  if (!productId) return [];
  const reviewContract = deriveReviewContractFromReportRow(row);
  if (!reviewContract.approved) return [];
  const selectedMode = asString(row?.selected?.selected_mode);
  if (selectedMode === 'baseline_only') return [];

  const sourceMeta = {
    case_id: asString(row.case_id),
    selected_mode: asString(row?.selected?.selected_mode || 'baseline_only'),
    selected_field_count: Number(row?.selected?.selected_field_count || 0),
    field_sources: row?.selected?.field_sources || {},
    evidence_profile: asString(selectedBundle?.evidence_profile || ''),
    quality_state: asString(selectedBundle?.quality_state || ''),
    external_highlight_review_status: asString(
      selectedBundle?.provenance?.external_highlight_review_status ||
        row?.review_decision ||
        row?.decision ||
        '',
    ),
    external_evidence_generated_at: asString(
      selectedBundle?.provenance?.external_evidence_generated_at || '',
    ),
    external_evidence_model: asString(selectedBundle?.provenance?.external_evidence_model || ''),
    external_review_batch: asString(selectedBundle?.provenance?.external_review_batch || ''),
    review_contract_version: reviewContract.review_contract_version,
    review_status: reviewContract.review_status,
    review_decision: reviewContract.review_decision,
    reviewer: reviewContract.reviewer,
    reviewer_kind: reviewContract.reviewer_kind,
    reviewed_at: reviewContract.reviewed_at,
    review_tier: reviewContract.review_tier,
  };

  const analysis = {
    contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
    product_intel_v1: selectedBundle,
  };

  return [
    {
      kb_key: `product:${productId}`,
      analysis,
      source: 'pivota_product_intel_pilot_selected',
      source_meta: sourceMeta,
      last_success_at: new Date().toISOString(),
      last_error: null,
    },
  ];
}

async function assertProductIntelKbWritable(queryFn = query) {
  if (typeof queryFn !== 'function') {
    const err = new Error('product_intel_kb_query_unavailable');
    err.code = 'NO_DATABASE';
    throw err;
  }
  await queryFn('SELECT 1 FROM aurora_product_intel_kb LIMIT 1');
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const reportPath = resolvePath(rootDir, args.report);
  if (!reportPath) {
    throw new Error('missing_report_path');
  }

  const report = readJson(reportPath);
  const rows = pickRows(report, args.caseIds);
  const entries = rows.flatMap((row) => buildKbEntriesForRow(row));
  const skippedRows = rows
    .filter((row) => buildKbEntriesForRow(row).length === 0)
    .map((row) => ({
      case_id: asString(row?.case_id),
      product_id: asString(
        row?.selected?.bundle?.canonical_product_ref?.product_id ||
          row?.baseline?.canonical_product_ref?.product_id,
      ),
      review_status: asString(row?.review_status),
      review_decision: asString(row?.review_decision || row?.decision),
    }));

  if (args.write) {
    await assertProductIntelKbWritable();
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      await upsertProductIntelKbEntry(entry);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      mode: args.write ? 'write' : 'dry_run',
      report: reportPath,
      rows: rows.map((row) => asString(row.case_id)),
      entries: entries.map((entry) => entry.kb_key),
      skipped_rows: skippedRows,
    })}\n`,
  );
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
      }
    });
}

module.exports = {
  assertProductIntelKbWritable,
  buildKbEntriesForRow,
};

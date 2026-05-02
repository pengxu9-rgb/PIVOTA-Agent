#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const manualOverrides = require('./fixtures/product_intel_manual_overrides.json');
const {
  applyManualOverrideToSelected,
  resolveManualOverride,
} = require('./product_intel_pilot_compare');

function parseArgs(argv) {
  const out = {
    compare: '',
    caseIds: [],
    out: '',
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--compare' && next) {
      out.compare = next;
      i += 1;
    } else if (token === '--case-id' && next) {
      out.caseIds = [String(next).trim()].filter(Boolean);
      i += 1;
    } else if (token === '--case-ids' && next) {
      out.caseIds = String(next)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
      i += 1;
    }
  }

  return out;
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePath(rootDir, target) {
  if (!target) return '';
  if (path.isAbsolute(target)) return target;
  return path.join(rootDir, target);
}

function buildManualPublishRow(compareRow) {
  const canonical =
    compareRow?.selected?.bundle?.canonical_product_ref ||
    compareRow?.baseline?.canonical_product_ref ||
    null;
  const caseRow = {
    case_id: asString(compareRow?.case_id),
    canonical_product_ref: canonical,
    product: {
      title:
        asString(compareRow?.selected?.bundle?.shopping_card?.title) ||
        asString(compareRow?.baseline?.shopping_card?.title) ||
        asString(compareRow?.selected?.bundle?.display_name) ||
        asString(compareRow?.baseline?.display_name) ||
        '',
      product_id: asString(canonical?.product_id),
      review_summary:
        compareRow?.selected?.bundle?.review_summary ||
        compareRow?.baseline?.review_summary ||
        null,
      community_signals:
        compareRow?.selected?.bundle?.community_signals ||
        compareRow?.baseline?.community_signals ||
        null,
    },
  };

  const manualOverride = resolveManualOverride(caseRow, manualOverrides);
  if (!manualOverride) {
    throw new Error(`manual_override_missing:${caseRow.case_id || canonical?.product_id || 'unknown'}`);
  }
  const selected = applyManualOverrideToSelected(caseRow, compareRow?.selected, manualOverride);
  if (!selected?.bundle?.canonical_product_ref?.product_id) {
    throw new Error(`manual_override_apply_failed:${caseRow.case_id || canonical?.product_id || 'unknown'}`);
  }

  return {
    case_id: caseRow.case_id,
    review_status: asString(manualOverride.review_status) || 'approved',
    review_decision: asString(manualOverride.review_decision || manualOverride.decision) || 'approved',
    reviewer: asString(manualOverride.reviewer) || 'codex_manual_override',
    reviewer_kind: asString(manualOverride.reviewer_kind) || 'employee',
    reviewed_at: asString(manualOverride.reviewed_at) || new Date().toISOString(),
    notes: asString(manualOverride.notes),
    baseline: {
      canonical_product_ref:
        compareRow?.baseline?.canonical_product_ref || selected.bundle.canonical_product_ref,
    },
    selected,
  };
}

function buildManualPublishReport(compareReport, caseIds) {
  const rows = Array.isArray(compareReport?.rows) ? compareReport.rows : [];
  const targetRows = caseIds.length
    ? rows.filter((row) => caseIds.includes(asString(row?.case_id)))
    : rows;
  return {
    meta: {
      generated_at: new Date().toISOString(),
      source_compare_rows: rows.length,
      selected_cases: targetRows.length,
      source: 'manual_override_publish_report',
    },
    rows: targetRows.map((row) => buildManualPublishRow(row)),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const comparePath = resolvePath(rootDir, args.compare);
  const outPath = resolvePath(rootDir, args.out);

  if (!comparePath) throw new Error('missing_compare_path');
  if (!outPath) throw new Error('missing_out_path');

  const compareReport = readJson(comparePath);
  const report = buildManualPublishReport(compareReport, args.caseIds);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      compare: comparePath,
      out: outPath,
      rows: report.rows.map((row) => row.case_id),
    })}\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  buildManualPublishReport,
  buildManualPublishRow,
  parseArgs,
};

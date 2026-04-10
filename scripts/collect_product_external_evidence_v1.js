#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  collectExternalHighlightSignals,
} = require('../src/services/pivotaExternalHighlights');

function parseArgs(argv) {
  const out = {
    cases: 'scripts/fixtures/product_intel_pilot_cases.json',
    rawEvidence: '',
    out: '',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--cases' && next) {
      out.cases = next;
      i += 1;
    } else if (token === '--raw-evidence' && next) {
      out.rawEvidence = next;
      i += 1;
    } else if (token === '--out' && next) {
      out.out = next;
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

function buildEvidenceLookup(rawEvidence) {
  if (!rawEvidence) return {};
  if (Array.isArray(rawEvidence.rows)) {
    return rawEvidence.rows.reduce((acc, row) => {
      acc[asString(row.case_id)] = row;
      return acc;
    }, {});
  }
  return rawEvidence;
}

function collectFromCases(cases, rawEvidenceLookup = {}) {
  return {
    contract_version: 'pivota.external_highlight_collection.v1',
    generated_at: new Date().toISOString(),
    rows: toList(cases).map((caseRow) => {
      const caseId = asString(caseRow?.case_id);
      const rawEvidencePack =
        rawEvidenceLookup[caseId] ||
        rawEvidenceLookup[`product:${asString(caseRow?.canonical_product_ref?.product_id)}`] ||
        null;
      const collected = collectExternalHighlightSignals({
        product: caseRow?.product || {},
        rawEvidencePack,
      });
      return {
        case_id: caseId,
        canonical_product_ref: caseRow?.canonical_product_ref || null,
        raw_evidence_pack: collected.raw_evidence_pack,
        external_highlight_signals: collected.external_highlight_signals,
      };
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const rootDir = path.resolve(__dirname, '..');
  const casesPath = resolvePath(rootDir, args.cases);
  const rawEvidencePath = resolvePath(rootDir, args.rawEvidence);
  const outPath = resolvePath(rootDir, args.out);
  const casesFile = readJson(casesPath);
  const cases = toList(casesFile?.rows || casesFile);
  const rawEvidenceLookup = buildEvidenceLookup(rawEvidencePath ? readJson(rawEvidencePath) : null);
  const report = collectFromCases(cases, rawEvidenceLookup);
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
  collectFromCases,
};

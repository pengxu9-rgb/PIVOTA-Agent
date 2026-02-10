#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { runDailyReport } = require('./report_verify_daily');
const { runPseudoLabelJob, normalizeDateKey } = require('./run_pseudo_label_job');

const DEFAULT_VERIFY_IN = path.join('tmp', 'diag_pseudo_label_factory');
const DEFAULT_HARD_CASES = path.join('tmp', 'diag_verify', 'hard_cases.ndjson');
const DEFAULT_REPORTS_OUT = 'reports';
const DEFAULT_OUTPUTS_OUT = 'outputs';
const SHADOW_DAILY_SCHEMA_VERSION = 'aurora.diag.shadow_daily.v1';

const SYSTEM_HARD_CASE_REASONS = new Set([
  'IMAGE_FETCH_FAILED',
  'TIMEOUT',
  'UPSTREAM_4XX',
  'UPSTREAM_5XX',
  'RATE_LIMIT',
  'QUOTA',
  'NETWORK_ERROR',
  'SCHEMA_INVALID',
  'UNKNOWN',
  'VERIFY_BUDGET_GUARD',
]);

function parseArgs(argv) {
  const out = {
    date: '',
    since: '',
    verifyIn: '',
    hardCases: '',
    reportsOut: '',
    outputsOut: '',
    pseudoMinAgreement: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (!next) continue;
    if (token === '--date') {
      out.date = next;
      index += 1;
      continue;
    }
    if (token === '--since') {
      out.since = next;
      index += 1;
      continue;
    }
    if (token === '--in') {
      out.verifyIn = next;
      index += 1;
      continue;
    }
    if (token === '--hard-cases') {
      out.hardCases = next;
      index += 1;
      continue;
    }
    if (token === '--reports-out') {
      out.reportsOut = next;
      index += 1;
      continue;
    }
    if (token === '--outputs-out') {
      out.outputsOut = next;
      index += 1;
      continue;
    }
    if (token === '--pseudo-min-agreement') {
      out.pseudoMinAgreement = next;
      index += 1;
    }
  }
  return out;
}

function safeToken(value, fallback = '') {
  const token = String(value == null ? '' : value).trim();
  return token || fallback;
}

function safeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return fallback;
  }
}

async function readNdjson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_err) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_err) {
    return [];
  }
}

async function writeNdjson(filePath, rows) {
  const body = (Array.isArray(rows) ? rows : [])
    .map((row) => JSON.stringify(row))
    .join('\n');
  await fs.writeFile(filePath, `${body}${body ? '\n' : ''}`, 'utf8');
}

function dateIso(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function reasonCount(rows, key) {
  const match = (Array.isArray(rows) ? rows : []).find((item) => safeToken(item?.reason).toUpperCase() === key);
  return safeNumber(match?.count, 0) || 0;
}

function rateByReason(rows, key) {
  const match = (Array.isArray(rows) ? rows : []).find((item) => safeToken(item?.reason).toUpperCase() === key);
  return safeNumber(match?.rate_vs_calls, 0) || 0;
}

function subreasonCount(rows, key) {
  const match = (Array.isArray(rows) ? rows : []).find((item) => safeToken(item?.subreason).toUpperCase() === key);
  return safeNumber(match?.count, 0) || 0;
}

function pickPassFailRate(byQuality) {
  const passRow = (Array.isArray(byQuality) ? byQuality : []).find(
    (item) => safeToken(item?.quality_grade).toLowerCase() === 'pass',
  );
  return safeNumber(passRow?.fail_rate, 0) || 0;
}

function filterHardCases(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const reason = safeToken(row?.disagreement_reason).toUpperCase();
    if (!reason) return false;
    return !SYSTEM_HARD_CASE_REASONS.has(reason);
  });
}

async function runShadowDaily(options = {}) {
  const dateKey = normalizeDateKey(options.date);
  const verifyIn = path.resolve(options.verifyIn || DEFAULT_VERIFY_IN);
  const hardCases = path.resolve(options.hardCases || DEFAULT_HARD_CASES);
  const reportsOut = path.resolve(options.reportsOut || DEFAULT_REPORTS_OUT);
  const outputsOut = path.resolve(options.outputsOut || DEFAULT_OUTPUTS_OUT);
  const since = safeToken(options.since, '');
  const pseudoMinAgreement = safeToken(options.pseudoMinAgreement, '');

  const daily = await runDailyReport({
    inputPath: verifyIn,
    outDir: reportsOut,
    date: dateKey,
    since,
    hardCasesPath: hardCases,
  });

  const pseudoSummary = await runPseudoLabelJob({
    storeDir: verifyIn,
    outDir: path.join(outputsOut, 'pseudo_label_job'),
    date: dateKey,
    minAgreement: pseudoMinAgreement,
  });

  const pseudoRows = await readNdjson(safeToken(pseudoSummary?.outputs?.pseudo_labels_daily, ''));
  const hardRowsRaw = await readNdjson(safeToken(pseudoSummary?.outputs?.hard_cases_daily, ''));
  const hardRows = filterHardCases(hardRowsRaw);
  const verifyReport = await readJson(daily.jsonPath, {});

  await fs.mkdir(outputsOut, { recursive: true });
  const pseudoOutPath = path.join(outputsOut, `pseudo_labels_daily_${dateKey}.ndjson`);
  const hardOutPath = path.join(outputsOut, `hard_cases_daily_${dateKey}.jsonl`);
  const summaryOutPath = path.join(outputsOut, `job_summary_${dateKey}.json`);

  await writeNdjson(pseudoOutPath, pseudoRows);
  await writeNdjson(hardOutPath, hardRows);

  const verifySummary = verifyReport?.summary || {};
  const verifyFailByReason = Array.isArray(verifyReport?.verify_fail_by_reason) ? verifyReport.verify_fail_by_reason : [];
  const verifyFailBySubreason = Array.isArray(verifyReport?.verify_fail_by_subreason)
    ? verifyReport.verify_fail_by_subreason
    : [];
  const byQuality = Array.isArray(verifyReport?.by_quality_grade) ? verifyReport.by_quality_grade : [];
  const verifyCalls = safeNumber(verifySummary.verify_calls_total, 0) || 0;
  const verifyFails = safeNumber(verifySummary.verify_fail_total, 0) || 0;
  const verifySuccessRate = verifyCalls > 0 ? Number(((verifyCalls - verifyFails) / verifyCalls).toFixed(3)) : 0;
  const passFailRate = Number(pickPassFailRate(byQuality).toFixed(3));
  const timeoutRate = Number(rateByReason(verifyFailByReason, 'TIMEOUT').toFixed(3));
  const upstream5xxRate = Number(rateByReason(verifyFailByReason, 'UPSTREAM_5XX').toFixed(3));

  const jobSummary = {
    schema_version: SHADOW_DAILY_SCHEMA_VERSION,
    generated_at_utc: new Date().toISOString(),
    date_key: dateKey,
    date_utc: dateIso(dateKey),
    since_utc: since || null,
    inputs: {
      verify_in: verifyIn,
      hard_cases_source: hardCases,
      verify_daily_json: daily.jsonPath,
      pseudo_job_summary_json: pseudoSummary?.outputs?.job_summary || null,
    },
    summary: {
      verify_calls_total: verifyCalls,
      verify_fail_total: verifyFails,
      verify_success_rate: verifySuccessRate,
      average_agreement: verifySummary.average_agreement ?? null,
      hard_case_rate: verifySummary.hard_case_rate ?? null,
      calls_skipped_by_budget_guard: verifySummary.calls_skipped_by_budget_guard ?? 0,
      latency_p95_ms: verifySummary.latency_p95_ms ?? null,
      pseudo_labels_daily_count: pseudoRows.length,
      hard_cases_daily_count: hardRows.length,
    },
    rates: {
      pass_fail_rate: passFailRate,
      timeout_rate_vs_calls: timeoutRate,
      upstream_5xx_rate_vs_calls: upstream5xxRate,
      upstream_401_count: subreasonCount(verifyFailBySubreason, 'UPSTREAM_401'),
      upstream_403_count: subreasonCount(verifyFailBySubreason, 'UPSTREAM_403'),
    },
    fail_by_reason: verifyFailByReason.slice(0, 10),
    outputs: {
      verify_daily_md: daily.mdPath,
      verify_daily_json: daily.jsonPath,
      pseudo_labels_daily: pseudoOutPath,
      hard_cases_daily: hardOutPath,
      job_summary: summaryOutPath,
    },
  };

  await fs.writeFile(summaryOutPath, `${JSON.stringify(jobSummary, null, 2)}\n`, 'utf8');

  return jobSummary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runShadowDaily(args);
  process.stdout.write(`${JSON.stringify(summary.outputs, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  runShadowDaily,
  filterHardCases,
};

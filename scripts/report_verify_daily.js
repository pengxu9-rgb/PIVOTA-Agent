#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_INPUT_DIR = path.join('tmp', 'diag_pseudo_label_factory');
const DEFAULT_HARD_CASES = path.join('tmp', 'diag_verify', 'hard_cases.ndjson');
const DEFAULT_OUTPUT_DIR = 'reports';

function parseArgs(argv) {
  const out = {
    inputPath: '',
    outDir: '',
    date: '',
    hardCasesPath: '',
    storeDirLegacy: '',
    outDirLegacy: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (!next) continue;
    if (token === '--in') {
      out.inputPath = next;
      index += 1;
      continue;
    }
    if (token === '--out') {
      out.outDir = next;
      index += 1;
      continue;
    }
    if (token === '--date') {
      out.date = next;
      index += 1;
      continue;
    }
    if (token === '--hard-cases') {
      out.hardCasesPath = next;
      index += 1;
      continue;
    }
    if (token === '--store-dir') {
      out.storeDirLegacy = next;
      index += 1;
      continue;
    }
    if (token === '--out-dir') {
      out.outDirLegacy = next;
      index += 1;
      continue;
    }
  }
  return out;
}

function todayKeyUtc() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function normalizeDateKey(input) {
  const raw = String(input || '').trim();
  if (!raw) return todayKeyUtc();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replace(/-/g, '');
  throw new Error(`invalid --date value: ${input}`);
}

function datePrefix(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function safeToken(value, fallback = 'unknown') {
  const token = String(value || '').trim();
  return token || fallback;
}

function safeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function quantile(values, q) {
  const numbers = values.map((item) => Number(item)).filter((item) => Number.isFinite(item)).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const clampedQ = Math.min(1, Math.max(0, Number(q)));
  const rank = (numbers.length - 1) * clampedQ;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return round3(numbers[low]);
  const ratio = rank - low;
  return round3(numbers[low] * (1 - ratio) + numbers[high] * ratio);
}

function mean(values) {
  const numbers = values.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (!numbers.length) return null;
  const total = numbers.reduce((acc, value) => acc + value, 0);
  return round3(total / numbers.length);
}

function hashToken(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_err) {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return parsed;
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

function formatRate(num, den) {
  if (!den) return 0;
  return round3(num / den);
}

function table(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((value) => (value == null ? '' : String(value))).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function normalizeIssueType(raw) {
  return safeToken(raw, 'other').toLowerCase();
}

function isVerifyFailure(record) {
  const output = record && typeof record.output_json === 'object' ? record.output_json : {};
  if (output.ok === false) return true;
  if (output.schema_failed) return true;
  return Boolean(String(output.failure_reason || '').trim());
}

function extractAgreementRows(samples, dayPrefix) {
  const rows = [];
  for (const sample of samples) {
    if (!String(sample?.created_at || '').startsWith(dayPrefix)) continue;
    const qualityGrade = safeToken(sample?.quality_grade, 'unknown');
    const toneBucket = safeToken(sample?.skin_tone_bucket || sample?.tone_bucket, 'unknown');
    const lightingBucket = safeToken(sample?.lighting_bucket, 'unknown');
    const deviceClass = safeToken(sample?.device_class, 'unknown');
    const overall = safeNumber(sample?.metrics?.overall);
    const byType = Array.isArray(sample?.metrics?.by_type) ? sample.metrics.by_type : [];

    if (!byType.length) {
      rows.push({
        issue_type: 'none',
        quality_grade: qualityGrade,
        tone_bucket: toneBucket,
        lighting_bucket: lightingBucket,
        device_class: deviceClass,
        agreement: overall,
      });
      continue;
    }

    for (const item of byType) {
      rows.push({
        issue_type: normalizeIssueType(item?.type),
        quality_grade: qualityGrade,
        tone_bucket: toneBucket,
        lighting_bucket: lightingBucket,
        device_class: deviceClass,
        agreement: overall,
      });
    }
  }
  return rows;
}

function summarizeByIssueType(agreementRows, hardCases, dayPrefix) {
  const map = new Map();
  for (const row of agreementRows) {
    const issueType = normalizeIssueType(row.issue_type);
    if (!map.has(issueType)) {
      map.set(issueType, {
        issue_type: issueType,
        agreements: [],
      });
    }
    const entry = map.get(issueType);
    if (Number.isFinite(row.agreement)) entry.agreements.push(row.agreement);
  }

  const reasonBuckets = new Map();
  for (const hardCase of hardCases) {
    if (!String(hardCase?.created_at || '').startsWith(dayPrefix)) continue;
    const issueType = normalizeIssueType(hardCase?.issue_type);
    const reason = safeToken(hardCase?.disagreement_reason, 'UNKNOWN');
    const key = `${issueType}||${reason}`;
    reasonBuckets.set(key, (reasonBuckets.get(key) || 0) + 1);
  }

  const summaries = Array.from(map.values()).map((entry) => {
    const reasons = Array.from(reasonBuckets.entries())
      .filter(([key]) => key.startsWith(`${entry.issue_type}||`))
      .map(([key, count]) => ({
        reason: key.split('||')[1],
        count,
      }))
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.reason.localeCompare(b.reason);
      })
      .slice(0, 3);

    return {
      issue_type: entry.issue_type,
      count: entry.agreements.length,
      agreement_mean: mean(entry.agreements),
      agreement_p50: quantile(entry.agreements, 0.5),
      agreement_p90: quantile(entry.agreements, 0.9),
      top_disagreement_reasons: reasons,
    };
  });

  summaries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.issue_type.localeCompare(b.issue_type);
  });

  return summaries;
}

function summarizeByQualityGrade(modelRows, agreementRows) {
  const qualitySet = new Set(['pass', 'degraded']);
  for (const row of modelRows) qualitySet.add(safeToken(row?.quality_grade, 'unknown').toLowerCase());
  for (const row of agreementRows) qualitySet.add(safeToken(row?.quality_grade, 'unknown').toLowerCase());

  const summaries = [];
  for (const quality of Array.from(qualitySet.values()).sort()) {
    const modelSubset = modelRows.filter((row) => safeToken(row?.quality_grade, 'unknown').toLowerCase() === quality);
    const agreementSubset = agreementRows.filter((row) => safeToken(row?.quality_grade, 'unknown').toLowerCase() === quality);
    const failCount = modelSubset.filter((row) => isVerifyFailure(row)).length;
    summaries.push({
      quality_grade: quality,
      verify_calls: modelSubset.length,
      verify_fails: failCount,
      fail_rate: formatRate(failCount, modelSubset.length),
      agreement_mean: mean(agreementSubset.map((row) => row.agreement)),
    });
  }
  return summaries;
}

function topHardCases(hardCases, dayPrefix, limit = 20) {
  const out = [];
  for (const item of hardCases) {
    if (!String(item?.created_at || '').startsWith(dayPrefix)) continue;

    const requestHash = safeToken(item?.request_id_hash || hashToken(item?.request_id) || hashToken(item?.inference_id), 'unknown');
    const assetHash = safeToken(item?.asset_id_hash || hashToken(item?.asset_id), 'unknown');

    out.push({
      request_id_hash: requestHash,
      asset_id_hash: assetHash,
      issue_type: normalizeIssueType(item?.issue_type),
      disagreement_reason: safeToken(item?.disagreement_reason, 'UNKNOWN'),
    });
  }

  out.sort((a, b) => {
    const reasonCompare = a.disagreement_reason.localeCompare(b.disagreement_reason);
    if (reasonCompare !== 0) return reasonCompare;
    const issueCompare = a.issue_type.localeCompare(b.issue_type);
    if (issueCompare !== 0) return issueCompare;
    return a.request_id_hash.localeCompare(b.request_id_hash);
  });

  return out.slice(0, limit);
}

async function resolvePaths({ repoRoot, inputArg, storeDirLegacy, hardCasesArg, outArg, outDirLegacy }) {
  const inputSeed = inputArg || storeDirLegacy || DEFAULT_INPUT_DIR;
  const resolvedInput = path.resolve(repoRoot, inputSeed);

  let manifestPath = resolvedInput;
  let inputDir = resolvedInput;

  const stat = await fs.stat(resolvedInput).catch(() => null);
  if (stat && stat.isDirectory()) {
    manifestPath = path.join(resolvedInput, 'manifest.json');
    inputDir = resolvedInput;
  } else if (stat && stat.isFile()) {
    inputDir = path.dirname(resolvedInput);
  } else {
    manifestPath = path.join(resolvedInput, 'manifest.json');
    inputDir = resolvedInput;
  }

  const manifest = await readJson(manifestPath, {});
  const modelOutputsPath = path.resolve(inputDir, safeToken(manifest?.paths?.model_outputs || manifest?.files?.model_outputs, 'model_outputs.ndjson'));
  const agreementSamplesPath = path.resolve(inputDir, safeToken(manifest?.paths?.agreement_samples || manifest?.files?.agreement_samples, 'agreement_samples.ndjson'));

  let hardCasesPath = hardCasesArg ? path.resolve(repoRoot, hardCasesArg) : '';
  if (!hardCasesPath) {
    const fromManifest = safeToken(manifest?.paths?.hard_cases || manifest?.files?.hard_cases, '');
    if (fromManifest) {
      hardCasesPath = path.resolve(inputDir, fromManifest);
    } else {
      const localHard = path.join(inputDir, 'hard_cases.ndjson');
      if (await exists(localHard)) {
        hardCasesPath = localHard;
      } else {
        hardCasesPath = path.resolve(repoRoot, DEFAULT_HARD_CASES);
      }
    }
  }

  const outDir = path.resolve(repoRoot, outArg || outDirLegacy || DEFAULT_OUTPUT_DIR);

  return {
    manifestPath,
    modelOutputsPath,
    agreementSamplesPath,
    hardCasesPath,
    outDir,
  };
}

function buildMarkdown({ dateIso, generatedAt, summary, byIssueType, byQuality, hardCases }) {
  const lines = [];
  lines.push(`# Verify Daily Report (${dateIso})`);
  lines.push('');
  lines.push(`Generated at (UTC): ${generatedAt}`);
  lines.push('');
  lines.push('## Overview');
  lines.push(`- verify_calls_total: ${summary.verify_calls_total}`);
  lines.push(`- verify_fail_total: ${summary.verify_fail_total}`);
  lines.push(`- average_agreement: ${summary.average_agreement ?? 'n/a'}`);
  lines.push(`- hard_case_rate: ${summary.hard_case_rate}`);
  lines.push('');

  lines.push('## By Issue Type');
  lines.push('');
  if (byIssueType.length) {
    lines.push(table(
      ['issue_type', 'count', 'agreement_mean', 'agreement_p50', 'agreement_p90', 'top_disagreement_reasons'],
      byIssueType.map((row) => [
        row.issue_type,
        row.count,
        row.agreement_mean,
        row.agreement_p50,
        row.agreement_p90,
        row.top_disagreement_reasons.map((item) => `${item.reason}(${item.count})`).join(', ') || 'n/a',
      ]),
    ));
  } else {
    lines.push('_No issue_type data for this date._');
  }
  lines.push('');

  lines.push('## By Quality Grade');
  lines.push('');
  if (byQuality.length) {
    lines.push(table(
      ['quality_grade', 'verify_calls', 'verify_fails', 'fail_rate', 'agreement_mean'],
      byQuality.map((row) => [
        row.quality_grade,
        row.verify_calls,
        row.verify_fails,
        row.fail_rate,
        row.agreement_mean ?? 'n/a',
      ]),
    ));
  } else {
    lines.push('_No quality_grade data for this date._');
  }
  lines.push('');

  lines.push('## Top 20 Hard Cases');
  lines.push('');
  if (hardCases.length) {
    lines.push(table(
      ['request_id_hash', 'asset_id_hash', 'issue_type', 'disagreement_reason'],
      hardCases.map((row) => [row.request_id_hash, row.asset_id_hash, row.issue_type, row.disagreement_reason]),
    ));
  } else {
    lines.push('_No hard cases for this date._');
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function runDailyReport(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const dateKey = normalizeDateKey(options.date);
  const dateIso = datePrefix(dateKey);

  const paths = await resolvePaths({
    repoRoot,
    inputArg: options.inputPath,
    storeDirLegacy: options.storeDirLegacy,
    hardCasesArg: options.hardCasesPath,
    outArg: options.outDir,
    outDirLegacy: options.outDirLegacy,
  });

  const modelOutputs = await readNdjson(paths.modelOutputsPath);
  const agreementSamples = await readNdjson(paths.agreementSamplesPath);
  const hardCasesAll = await readNdjson(paths.hardCasesPath);

  const modelRows = modelOutputs.filter((row) => String(row?.created_at || '').startsWith(dateIso));
  const agreementRows = extractAgreementRows(agreementSamples, dateIso);
  const hardCases = topHardCases(hardCasesAll, dateIso, 20);

  const verifyCalls = modelRows.length;
  const verifyFails = modelRows.filter((row) => isVerifyFailure(row)).length;
  const averageAgreement = mean(agreementRows.map((row) => row.agreement));
  const hardCaseRate = formatRate(hardCases.length, verifyCalls);

  const byIssueType = summarizeByIssueType(agreementRows, hardCasesAll, dateIso);
  const byQualityGrade = summarizeByQualityGrade(modelRows, agreementRows);

  await fs.mkdir(paths.outDir, { recursive: true });
  const mdPath = path.join(paths.outDir, `verify_daily_${dateKey}.md`);
  const jsonPath = path.join(paths.outDir, `verify_daily_${dateKey}.json`);

  const report = {
    schema_version: 'aurora.diag.verify_daily.v2',
    generated_at_utc: new Date().toISOString(),
    date_utc: dateIso,
    inputs: {
      manifest_path: paths.manifestPath,
      model_outputs_path: paths.modelOutputsPath,
      agreement_samples_path: paths.agreementSamplesPath,
      hard_cases_path: paths.hardCasesPath,
      model_outputs_total: modelOutputs.length,
      agreement_samples_total: agreementSamples.length,
      hard_cases_total: hardCasesAll.length,
    },
    summary: {
      verify_calls_total: verifyCalls,
      verify_fail_total: verifyFails,
      average_agreement: averageAgreement,
      hard_case_rate: hardCaseRate,
    },
    by_issue_type: byIssueType,
    by_quality_grade: byQualityGrade,
    top_hard_cases: hardCases,
  };

  const markdown = buildMarkdown({
    dateIso,
    generatedAt: report.generated_at_utc,
    summary: report.summary,
    byIssueType,
    byQuality: byQualityGrade,
    hardCases,
  });

  await fs.writeFile(mdPath, markdown, 'utf8');
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  return {
    jsonPath,
    mdPath,
    report,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runDailyReport({
    inputPath: args.inputPath,
    outDir: args.outDir,
    date: args.date,
    hardCasesPath: args.hardCasesPath,
    storeDirLegacy: args.storeDirLegacy,
    outDirLegacy: args.outDirLegacy,
  });
  process.stdout.write(`${result.jsonPath}\n${result.mdPath}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  runDailyReport,
  normalizeDateKey,
};

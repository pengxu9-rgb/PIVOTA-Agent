#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_INPUT_DIR = path.join('tmp', 'diag_pseudo_label_factory');
const DEFAULT_HARD_CASES = path.join('tmp', 'diag_verify', 'hard_cases.ndjson');
const DEFAULT_OUTPUT_DIR = 'reports';
const ALERT_THRESHOLD_DEFAULTS = Object.freeze({
  verify_fail_rate_max: 0.45,
  upstream_5xx_rate_max: 0.12,
  timeout_rate_max: 0.08,
  upstream_4xx_rate_max: 0.12,
  upstream_401_rate_max: 0.08,
  upstream_403_rate_max: 0.04,
  upstream_429_rate_max: 0.05,
});

function parseArgs(argv) {
  const out = {
    inputPath: '',
    hardCasesPath: '',
    outDir: '',
    date: '',
    since: '',
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
    if (token === '--hard-cases') {
      out.hardCasesPath = next;
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
    if (token === '--since') {
      out.since = next;
      index += 1;
      continue;
    }
  }
  return out;
}

function safeToken(value, fallback = 'unknown') {
  const token = String(value || '').trim();
  return token || fallback;
}

function safeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function envThreshold(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function round3(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(3));
}

function formatRate(numerator, denominator) {
  if (!denominator) return 0;
  return round3(Number(numerator) / Number(denominator));
}

function dateToPrefix(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  throw new Error(`invalid --date value: ${input}`);
}

function parseSinceIso(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid --since value: ${input}`);
  return timestamp;
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

async function readJson(filePath, fallback = {}) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return fallback;
  } catch (_err) {
    return fallback;
  }
}

function normalizeVerifyFailReason(rawReason, statusCode, statusClass, errorClass) {
  const token = String(rawReason || '').trim().toUpperCase();
  const numericStatus = Number.isFinite(Number(statusCode)) ? Math.trunc(Number(statusCode)) : 0;
  const statusClassToken = String(statusClass || '').trim().toLowerCase();
  const errorToken = String(errorClass || '').trim().toUpperCase();

  if (token === 'VERIFY_BUDGET_GUARD') return 'VERIFY_BUDGET_GUARD';
  if (!token) {
    if (numericStatus >= 500) return 'UPSTREAM_5XX';
    if (numericStatus >= 400) return 'UPSTREAM_4XX';
    return 'UNKNOWN';
  }
  if (token.includes('TIMEOUT')) return 'TIMEOUT';
  if (token.includes('RATE_LIMIT')) return 'RATE_LIMIT';
  if (token.includes('QUOTA')) return 'QUOTA';
  if (token.includes('SCHEMA_INVALID') || token.includes('CANONICAL_SCHEMA_INVALID')) return 'SCHEMA_INVALID';
  if (token.includes('IMAGE_FETCH') || token.includes('MISSING_IMAGE') || token.includes('PHOTO_DOWNLOAD')) return 'IMAGE_FETCH_FAILED';
  if (token.includes('NETWORK_ERROR') || token.includes('DNS')) return 'NETWORK_ERROR';
  if (token.includes('REQUEST_FAILED') || token.includes('SERVICE_UNAVAILABLE') || errorToken.includes('MISSING_DEP')) return 'UPSTREAM_5XX';
  if (statusClassToken === '5xx') return 'UPSTREAM_5XX';
  if (statusClassToken === '4xx') return 'UPSTREAM_4XX';
  if (
    errorToken.includes('TIMEOUT') ||
    errorToken.includes('ETIMEDOUT') ||
    errorToken.includes('ECONNABORTED') ||
    errorToken.includes('DEADLINE_EXCEEDED')
  ) return 'TIMEOUT';
  if (
    errorToken.includes('NETWORK') ||
    errorToken.includes('ENOTFOUND') ||
    errorToken.includes('EAI_AGAIN') ||
    errorToken.includes('ECONNRESET') ||
    errorToken.includes('ECONNREFUSED') ||
    errorToken.includes('FETCH_FAILED') ||
    errorToken.includes('DNS')
  ) return 'NETWORK_ERROR';
  if (token.includes('UPSTREAM_5XX') || numericStatus >= 500) return 'UPSTREAM_5XX';
  if (token.includes('UPSTREAM_4XX') || numericStatus >= 400) return 'UPSTREAM_4XX';
  return 'UNKNOWN';
}

function classifyUpstream4xxSubreason(statusCode) {
  const numericStatus = Number.isFinite(Number(statusCode)) ? Math.trunc(Number(statusCode)) : 0;
  if (numericStatus === 401) return 'UPSTREAM_401';
  if (numericStatus === 403) return 'UPSTREAM_403';
  if (numericStatus === 404) return 'UPSTREAM_404';
  if (numericStatus === 408) return 'UPSTREAM_408';
  if (numericStatus === 409) return 'UPSTREAM_409';
  if (numericStatus === 422) return 'UPSTREAM_422';
  if (numericStatus === 429) return 'UPSTREAM_429';
  if (numericStatus >= 400 && numericStatus < 500) return `UPSTREAM_${numericStatus}`;
  return 'UPSTREAM_4XX_OTHER';
}

function getAlertThresholds() {
  return {
    verify_fail_rate_max: envThreshold('VERIFY_ALERT_VERIFY_FAIL_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.verify_fail_rate_max),
    upstream_5xx_rate_max: envThreshold('VERIFY_ALERT_UPSTREAM_5XX_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_5xx_rate_max),
    timeout_rate_max: envThreshold('VERIFY_ALERT_TIMEOUT_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.timeout_rate_max),
    upstream_4xx_rate_max: envThreshold('VERIFY_ALERT_UPSTREAM_4XX_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_4xx_rate_max),
    upstream_401_rate_max: envThreshold('VERIFY_ALERT_UPSTREAM_401_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_401_rate_max),
    upstream_403_rate_max: envThreshold('VERIFY_ALERT_UPSTREAM_403_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_403_rate_max),
    upstream_429_rate_max: envThreshold('VERIFY_ALERT_UPSTREAM_429_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_429_rate_max),
  };
}

function byCount(entries) {
  return entries.sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return String(left.key).localeCompare(String(right.key));
  });
}

function mapToRankedRows(counter, total) {
  return byCount(
    Array.from(counter.entries()).map(([key, count]) => ({ key, count })),
  ).map((row) => ({
    key: row.key,
    count: row.count,
    rate: formatRate(row.count, total),
  }));
}

async function resolveInputPaths(repoRoot, inputArg, hardCasesArg) {
  const inputSeed = inputArg || DEFAULT_INPUT_DIR;
  const inputPath = path.resolve(repoRoot, inputSeed);
  const stat = await fs.stat(inputPath).catch(() => null);

  const inputDir = stat && stat.isDirectory() ? inputPath : path.dirname(inputPath);
  const manifestPath = stat && stat.isDirectory() ? path.join(inputPath, 'manifest.json') : inputPath;
  const manifest = await readJson(manifestPath, {});

  const modelOutputsPath = path.resolve(
    inputDir,
    safeToken(manifest?.paths?.model_outputs || manifest?.files?.model_outputs, 'model_outputs.ndjson'),
  );
  const hardCasesPath = hardCasesArg
    ? path.resolve(repoRoot, hardCasesArg)
    : path.resolve(repoRoot, DEFAULT_HARD_CASES);

  return { manifestPath, modelOutputsPath, hardCasesPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const outDir = path.resolve(repoRoot, args.outDir || DEFAULT_OUTPUT_DIR);
  const datePrefix = dateToPrefix(args.date);
  const dateKey = datePrefix.replace(/-/g, '');
  const sinceTs = parseSinceIso(args.since);
  const paths = await resolveInputPaths(repoRoot, args.inputPath, args.hardCasesPath);

  const modelOutputsAll = await readNdjson(paths.modelOutputsPath);
  const hardCasesAll = await readNdjson(paths.hardCasesPath);

  const inWindow = (createdAt) => {
    const token = String(createdAt || '');
    if (!token.startsWith(datePrefix)) return false;
    if (!Number.isFinite(sinceTs)) return true;
    const rowTs = Date.parse(token);
    return Number.isFinite(rowTs) && rowTs >= sinceTs;
  };

  const modelOutputs = modelOutputsAll.filter((row) => inWindow(row?.created_at));
  const hardCases = hardCasesAll.filter((row) => inWindow(row?.created_at));

  const verifyRows = modelOutputs
    .filter((row) => safeToken(row?.provider, '').toLowerCase() === 'gemini_provider')
    .map((row) => {
      const output = row?.output_json && typeof row.output_json === 'object' ? row.output_json : {};
      const statusCode = safeNumber(output.provider_status_code, null);
      const decision = safeToken(output.decision, output.ok === false ? 'verify' : 'verify').toLowerCase();
      const rawReason = safeToken(
        output.verify_fail_reason || output.final_reason || output.failure_reason || '',
        '',
      );
      const statusClass = safeToken(output.http_status_class, '');
      const errorClass = safeToken(output.error_class, '');
      const normalizedReason = normalizeVerifyFailReason(rawReason, statusCode, statusClass, errorClass);
      const hasFailureSignal =
        output.ok === false ||
        output.schema_failed === true ||
        Boolean(output.failure_reason) ||
        (Boolean(output.final_reason) && String(output.final_reason).toUpperCase() !== 'OK');
      const isGuard = decision === 'skip' && normalizedReason === 'VERIFY_BUDGET_GUARD';
      return {
        created_at: row.created_at,
        decision,
        status_code: statusCode,
        ok: Boolean(output.ok),
        is_failure: !isGuard && hasFailureSignal,
        is_guard: isGuard,
        normalized_reason: !isGuard && hasFailureSignal ? normalizedReason : null,
        raw_reason: rawReason || null,
        final_reason: safeToken(output.final_reason, ''),
        verify_fail_reason: safeToken(output.verify_fail_reason, ''),
        http_status_class: statusClass,
        error_class: errorClass,
        attempts: safeNumber(output.attempts, null),
        latency_ms: safeNumber(output.latency_ms, null),
      };
    });

  const attemptsTotal = verifyRows.length;
  const failures = verifyRows.filter((row) => row.is_failure);
  const failuresTotal = failures.length;

  const reasonCounter = new Map();
  const subreasonCounter = new Map();
  const statusCounter = new Map();
  const rawReasonCounter = new Map();
  const reasonStatusCounter = new Map();

  for (const row of failures) {
    const reason = safeToken(row.normalized_reason, 'UNKNOWN');
    reasonCounter.set(reason, (reasonCounter.get(reason) || 0) + 1);
    const subreason = reason === 'UPSTREAM_4XX'
      ? classifyUpstream4xxSubreason(row.status_code)
      : reason;
    subreasonCounter.set(subreason, (subreasonCounter.get(subreason) || 0) + 1);

    const statusKey = Number.isFinite(Number(row.status_code)) ? String(Math.trunc(Number(row.status_code))) : 'none';
    statusCounter.set(statusKey, (statusCounter.get(statusKey) || 0) + 1);

    const rawReason = safeToken(row.raw_reason || row.final_reason || '', 'UNKNOWN');
    rawReasonCounter.set(rawReason, (rawReasonCounter.get(rawReason) || 0) + 1);

    const reasonStatusKey = `${reason}|${statusKey}`;
    reasonStatusCounter.set(reasonStatusKey, (reasonStatusCounter.get(reasonStatusKey) || 0) + 1);
  }

  const thresholds = getAlertThresholds();
  const failRate = formatRate(failuresTotal, attemptsTotal);
  const reasonRate = (key) => formatRate(reasonCounter.get(key) || 0, attemptsTotal);
  const subreasonRate = (key) => formatRate(subreasonCounter.get(key) || 0, attemptsTotal);
  const alertChecks = [
    {
      metric: 'verify_fail_rate',
      value: failRate,
      threshold: thresholds.verify_fail_rate_max,
      pass: failRate <= thresholds.verify_fail_rate_max,
    },
    {
      metric: 'upstream_5xx_rate',
      value: reasonRate('UPSTREAM_5XX'),
      threshold: thresholds.upstream_5xx_rate_max,
      pass: reasonRate('UPSTREAM_5XX') <= thresholds.upstream_5xx_rate_max,
    },
    {
      metric: 'timeout_rate',
      value: reasonRate('TIMEOUT'),
      threshold: thresholds.timeout_rate_max,
      pass: reasonRate('TIMEOUT') <= thresholds.timeout_rate_max,
    },
    {
      metric: 'upstream_4xx_rate',
      value: reasonRate('UPSTREAM_4XX'),
      threshold: thresholds.upstream_4xx_rate_max,
      pass: reasonRate('UPSTREAM_4XX') <= thresholds.upstream_4xx_rate_max,
    },
    {
      metric: 'upstream_401_rate',
      value: subreasonRate('UPSTREAM_401'),
      threshold: thresholds.upstream_401_rate_max,
      pass: subreasonRate('UPSTREAM_401') <= thresholds.upstream_401_rate_max,
    },
    {
      metric: 'upstream_403_rate',
      value: subreasonRate('UPSTREAM_403'),
      threshold: thresholds.upstream_403_rate_max,
      pass: subreasonRate('UPSTREAM_403') <= thresholds.upstream_403_rate_max,
    },
    {
      metric: 'upstream_429_rate',
      value: subreasonRate('UPSTREAM_429'),
      threshold: thresholds.upstream_429_rate_max,
      pass: subreasonRate('UPSTREAM_429') <= thresholds.upstream_429_rate_max,
    },
  ].map((item) => ({
    ...item,
    value: round3(item.value),
    threshold: round3(item.threshold),
  }));

  const hardCaseMissingIds = hardCases.filter((row) => {
    const requestId = String(row?.request_id_hash || row?.request_id || row?.inference_id || '').trim();
    const assetId = String(row?.asset_id_hash || row?.asset_id || row?.photo_id || row?.image_id || '').trim();
    return !requestId || !assetId;
  }).length;

  const diagnosis = {
    schema_version: 'aurora.diag.verify_fail_diagnosis.v1',
    generated_at_utc: new Date().toISOString(),
    date_utc: datePrefix,
    inputs: {
      manifest_path: paths.manifestPath,
      model_outputs_path: paths.modelOutputsPath,
      hard_cases_path: paths.hardCasesPath,
      since_utc: Number.isFinite(sinceTs) ? new Date(sinceTs).toISOString() : null,
      model_outputs_total: modelOutputsAll.length,
      hard_cases_total: hardCasesAll.length,
      model_outputs_on_date: modelOutputs.length,
      hard_cases_on_date: hardCases.length,
    },
    summary: {
      verify_attempts: attemptsTotal,
      verify_failures: failuresTotal,
      fail_rate: formatRate(failuresTotal, attemptsTotal),
      verify_calls_skipped_by_budget_guard: verifyRows.filter((row) => row.is_guard).length,
      hard_cases_missing_id_fields: hardCaseMissingIds,
    },
    failure_reason_breakdown: mapToRankedRows(reasonCounter, failuresTotal),
    failure_subreason_breakdown: mapToRankedRows(subreasonCounter, failuresTotal),
    status_code_breakdown: mapToRankedRows(statusCounter, failuresTotal),
    raw_reason_breakdown: mapToRankedRows(rawReasonCounter, failuresTotal).slice(0, 20),
    reason_status_breakdown: mapToRankedRows(reasonStatusCounter, failuresTotal).slice(0, 30),
    alert_thresholds: thresholds,
    alert_checks: alertChecks,
    alert_status: alertChecks.every((item) => item.pass) ? 'PASS' : 'FAIL',
    examples: failures.slice(0, 20),
  };

  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `verify_fail_diagnosis_${dateKey}.json`);
  await fs.writeFile(outPath, `${JSON.stringify(diagnosis, null, 2)}\n`, 'utf8');
  process.stdout.write(`${outPath}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

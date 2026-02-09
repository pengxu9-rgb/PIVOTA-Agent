#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildReliabilityTable, resolveVoteGateConfig } = require('../src/auroraBff/diagReliability');

const DEFAULT_INPUT_DIR = path.join('tmp', 'diag_pseudo_label_factory');
const DEFAULT_HARD_CASES = path.join('tmp', 'diag_verify', 'hard_cases.ndjson');
const DEFAULT_OUTPUT_DIR = 'reports';
const VERIFY_BUDGET_GUARD = 'VERIFY_BUDGET_GUARD';
const ALERT_THRESHOLD_DEFAULTS = Object.freeze({
  verify_fail_rate_max: 0.45,
  upstream_5xx_rate_vs_calls_max: 0.12,
  timeout_rate_vs_calls_max: 0.08,
  upstream_4xx_rate_vs_calls_max: 0.12,
  upstream_401_rate_vs_calls_max: 0.08,
  upstream_403_rate_vs_calls_max: 0.04,
  upstream_429_rate_vs_calls_max: 0.05,
  image_fetch_failed_rate_vs_calls_max: 0.08,
  schema_invalid_rate_vs_calls_max: 0.08,
});
const VERIFY_FAIL_REASON_ALLOWLIST = new Set([
  'TIMEOUT',
  'RATE_LIMIT',
  'QUOTA',
  'UPSTREAM_4XX',
  'UPSTREAM_5XX',
  'SCHEMA_INVALID',
  'IMAGE_FETCH_FAILED',
  'NETWORK_ERROR',
  'UNKNOWN',
]);

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

function normalizeVerifyFailReason(rawReason, statusCode, statusClass, errorClass) {
  const token = safeToken(rawReason, 'UNKNOWN').toUpperCase();
  const numericStatus = Number.isFinite(Number(statusCode)) ? Math.trunc(Number(statusCode)) : 0;
  const statusClassToken = safeToken(statusClass, '').toLowerCase();
  const errorToken = safeToken(errorClass, '').toUpperCase();

  if (token === VERIFY_BUDGET_GUARD) return VERIFY_BUDGET_GUARD;
  if (VERIFY_FAIL_REASON_ALLOWLIST.has(token)) return token;
  if (token.includes('VISION_TIMEOUT')) return 'TIMEOUT';
  if (token.includes('VISION_RATE_LIMITED')) return 'RATE_LIMIT';
  if (token.includes('VISION_QUOTA_EXCEEDED')) return 'QUOTA';
  if (token.includes('VISION_SCHEMA_INVALID')) return 'SCHEMA_INVALID';
  if (token.includes('VISION_IMAGE_INVALID')) return 'IMAGE_FETCH_FAILED';
  if (token.includes('VISION_NETWORK_ERROR')) return 'NETWORK_ERROR';
  if (token.includes('VISION_MISSING_KEY') || token.includes('VISION_UPSTREAM_4XX')) return 'UPSTREAM_4XX';
  if (token.includes('VISION_UPSTREAM_5XX')) return 'UPSTREAM_5XX';
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

function extractVerifyRows(modelRows) {
  const rows = [];
  for (const record of modelRows) {
    const provider = safeToken(record?.provider, 'unknown').toLowerCase();
    if (provider !== 'gemini_provider') continue;
    const output = record && typeof record.output_json === 'object' ? record.output_json : {};
    const statusCode = safeNumber(output.provider_status_code, null);
    const decision = safeToken(output.decision, output.ok === false ? 'verify' : 'verify').toLowerCase();
    const normalizedReason = normalizeVerifyFailReason(
      output.verify_fail_reason || output.final_reason || output.failure_reason,
      statusCode,
      output.http_status_class,
      output.error_class,
    );
    const isGuard = decision === 'skip' && normalizedReason === VERIFY_BUDGET_GUARD;
    const finalReasonToken = safeToken(output.final_reason, '').toUpperCase();
    const failureReasonToken = safeToken(output.failure_reason, '');
    const hasFailureSignal =
      output.ok === false ||
      output.schema_failed === true ||
      Boolean(failureReasonToken) ||
      (Boolean(finalReasonToken) && finalReasonToken !== 'OK');
    const isFailure = !isGuard && (
      hasFailureSignal
    );
    rows.push({
      trace_id: safeToken(output.trace_id || record?.trace_id || record?.inference_id, 'unknown'),
      created_at: String(record?.created_at || ''),
      provider,
      quality_grade: safeToken(record?.quality_grade, 'unknown').toLowerCase(),
      decision,
      latency_ms: safeNumber(output.latency_ms, null),
      provider_status_code: statusCode,
      http_status_class: safeToken(output.http_status_class, 'unknown').toLowerCase(),
      last_error_class: safeToken(output.error_class || output.http_status_class || 'unknown', 'unknown'),
      fail_reason: isFailure ? normalizedReason : null,
      is_failure: isFailure,
      is_guard: isGuard,
    });
  }
  return rows;
}

function summarizeVerifyFailByReason(verifyRows) {
  const counter = new Map();
  const totalCalls = Math.max(0, verifyRows.length);
  const failures = verifyRows.filter((row) => row.is_failure);
  for (const row of failures) {
    const reason = safeToken(row.fail_reason, 'UNKNOWN');
    counter.set(reason, (counter.get(reason) || 0) + 1);
  }
  return Array.from(counter.entries())
    .map(([reason, count]) => ({
      reason,
      count,
      rate_vs_calls: formatRate(count, totalCalls),
      rate_vs_fails: formatRate(count, failures.length),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.reason.localeCompare(b.reason);
    });
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

function summarizeVerifyFailBySubreason(verifyRows) {
  const counter = new Map();
  const totalCalls = Math.max(0, verifyRows.length);
  const failures = verifyRows.filter((row) => row.is_failure);
  for (const row of failures) {
    const reason = safeToken(row.fail_reason, 'UNKNOWN');
    const subreason = reason === 'UPSTREAM_4XX'
      ? classifyUpstream4xxSubreason(row.provider_status_code)
      : reason;
    counter.set(subreason, (counter.get(subreason) || 0) + 1);
  }
  return Array.from(counter.entries())
    .map(([subreason, count]) => ({
      subreason,
      count,
      rate_vs_calls: formatRate(count, totalCalls),
      rate_vs_fails: formatRate(count, failures.length),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.subreason.localeCompare(b.subreason);
    });
}

function getAlertThresholds() {
  return {
    verify_fail_rate_max: envThreshold('VERIFY_ALERT_VERIFY_FAIL_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.verify_fail_rate_max),
    upstream_5xx_rate_vs_calls_max: envThreshold('VERIFY_ALERT_UPSTREAM_5XX_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_5xx_rate_vs_calls_max),
    timeout_rate_vs_calls_max: envThreshold('VERIFY_ALERT_TIMEOUT_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.timeout_rate_vs_calls_max),
    upstream_4xx_rate_vs_calls_max: envThreshold('VERIFY_ALERT_UPSTREAM_4XX_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_4xx_rate_vs_calls_max),
    upstream_401_rate_vs_calls_max: envThreshold('VERIFY_ALERT_UPSTREAM_401_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_401_rate_vs_calls_max),
    upstream_403_rate_vs_calls_max: envThreshold('VERIFY_ALERT_UPSTREAM_403_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_403_rate_vs_calls_max),
    upstream_429_rate_vs_calls_max: envThreshold('VERIFY_ALERT_UPSTREAM_429_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.upstream_429_rate_vs_calls_max),
    image_fetch_failed_rate_vs_calls_max: envThreshold('VERIFY_ALERT_IMAGE_FETCH_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.image_fetch_failed_rate_vs_calls_max),
    schema_invalid_rate_vs_calls_max: envThreshold('VERIFY_ALERT_SCHEMA_INVALID_RATE_MAX', ALERT_THRESHOLD_DEFAULTS.schema_invalid_rate_vs_calls_max),
  };
}

function findRateByReason(rows, key) {
  const row = rows.find((item) => safeToken(item.reason, '') === key);
  return Number.isFinite(Number(row?.rate_vs_calls)) ? Number(row.rate_vs_calls) : 0;
}

function findRateBySubreason(rows, key) {
  const row = rows.find((item) => safeToken(item.subreason, '') === key);
  return Number.isFinite(Number(row?.rate_vs_calls)) ? Number(row.rate_vs_calls) : 0;
}

function buildAlertChecks({ summary, failByReason, failBySubreason, thresholds }) {
  const checks = [];
  const verifyCalls = Number.isFinite(Number(summary?.verify_calls_total)) ? Number(summary.verify_calls_total) : 0;
  const verifyFails = Number.isFinite(Number(summary?.verify_fail_total)) ? Number(summary.verify_fail_total) : 0;
  const verifyFailRate = verifyCalls > 0 ? verifyFails / verifyCalls : 0;

  const metrics = [
    {
      metric: 'verify_fail_rate',
      value: verifyFailRate,
      threshold: thresholds.verify_fail_rate_max,
      note: 'verify_fail_total / verify_calls_total',
    },
    {
      metric: 'upstream_5xx_rate_vs_calls',
      value: findRateByReason(failByReason, 'UPSTREAM_5XX'),
      threshold: thresholds.upstream_5xx_rate_vs_calls_max,
      note: 'UPSTREAM_5XX / verify_calls_total',
    },
    {
      metric: 'timeout_rate_vs_calls',
      value: findRateByReason(failByReason, 'TIMEOUT'),
      threshold: thresholds.timeout_rate_vs_calls_max,
      note: 'TIMEOUT / verify_calls_total',
    },
    {
      metric: 'upstream_4xx_rate_vs_calls',
      value: findRateByReason(failByReason, 'UPSTREAM_4XX'),
      threshold: thresholds.upstream_4xx_rate_vs_calls_max,
      note: 'UPSTREAM_4XX / verify_calls_total',
    },
    {
      metric: 'upstream_401_rate_vs_calls',
      value: findRateBySubreason(failBySubreason, 'UPSTREAM_401'),
      threshold: thresholds.upstream_401_rate_vs_calls_max,
      note: 'UPSTREAM_401 / verify_calls_total',
    },
    {
      metric: 'upstream_403_rate_vs_calls',
      value: findRateBySubreason(failBySubreason, 'UPSTREAM_403'),
      threshold: thresholds.upstream_403_rate_vs_calls_max,
      note: 'UPSTREAM_403 / verify_calls_total',
    },
    {
      metric: 'upstream_429_rate_vs_calls',
      value: findRateBySubreason(failBySubreason, 'UPSTREAM_429'),
      threshold: thresholds.upstream_429_rate_vs_calls_max,
      note: 'UPSTREAM_429 / verify_calls_total',
    },
    {
      metric: 'image_fetch_failed_rate_vs_calls',
      value: findRateByReason(failByReason, 'IMAGE_FETCH_FAILED'),
      threshold: thresholds.image_fetch_failed_rate_vs_calls_max,
      note: 'IMAGE_FETCH_FAILED / verify_calls_total',
    },
    {
      metric: 'schema_invalid_rate_vs_calls',
      value: findRateByReason(failByReason, 'SCHEMA_INVALID'),
      threshold: thresholds.schema_invalid_rate_vs_calls_max,
      note: 'SCHEMA_INVALID / verify_calls_total',
    },
  ];

  for (const item of metrics) {
    const value = round3(item.value);
    const threshold = round3(item.threshold);
    checks.push({
      metric: item.metric,
      value,
      threshold,
      pass: value <= threshold,
      note: item.note,
    });
  }
  return checks;
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

function deriveHardCaseReason(item) {
  const direct = String(item?.disagreement_reason || '').trim();
  if (direct) return direct;
  const fromList = Array.isArray(item?.disagreement_reasons) ? item.disagreement_reasons : [];
  for (const reason of fromList) {
    const token = String(reason || '').trim();
    if (token) return token;
  }
  const fallback = String(item?.verify_fail_reason || item?.final_reason || item?.raw_final_reason || '').trim();
  if (fallback) return fallback;
  return 'UNKNOWN';
}

function deriveHardCaseIssueType(item, disagreementReason) {
  const direct = String(item?.issue_type || '').trim();
  if (direct) return normalizeIssueType(direct);

  const perIssue = Array.isArray(item?.verifier?.per_issue) ? item.verifier.per_issue : [];
  if (perIssue.length) {
    const reasonToken = String(disagreementReason || '').trim().toLowerCase();
    const matchedByReason = perIssue.find((entry) => String(entry?.reason || '').trim().toLowerCase() === reasonToken);
    const candidate = matchedByReason || perIssue.find((entry) => String(entry?.type || '').trim()) || perIssue[0];
    return normalizeIssueType(candidate?.type);
  }

  const reason = String(disagreementReason || '').trim().toUpperCase();
  if (reason.startsWith('QUALITY_')) return 'quality';
  if (reason && reason !== 'UNKNOWN') return 'verify';
  return 'other';
}

function deriveHardCaseRequestHash(item) {
  const fromRequest = hashToken(item?.request_id);
  const fromInference = hashToken(item?.inference_id);
  const fallbackSeed = `${safeToken(item?.created_at, '')}|${safeToken(item?.final_reason, '')}|${safeToken(item?.provider_status_code, '')}|${safeToken(item?.attempts, '')}`;
  const fallbackHash = hashToken(fallbackSeed);
  return safeToken(item?.request_id_hash || fromRequest || fromInference || fallbackHash, 'unknown');
}

function deriveHardCaseAssetHash(item, issueType, disagreementReason) {
  const fromAsset = hashToken(item?.asset_id || item?.photo_id || item?.image_id);
  const fromInference = hashToken(item?.inference_id);
  const fallbackSeed = `${safeToken(item?.created_at, '')}|${safeToken(issueType, 'other')}|${safeToken(disagreementReason, 'UNKNOWN')}`;
  const fallbackHash = hashToken(fallbackSeed);
  return safeToken(item?.asset_id_hash || fromAsset || fromInference || fallbackHash, 'unknown');
}

function normalizeHardCaseRecord(item) {
  const disagreementReason = deriveHardCaseReason(item);
  const issueType = deriveHardCaseIssueType(item, disagreementReason);
  return {
    request_id_hash: deriveHardCaseRequestHash(item),
    asset_id_hash: deriveHardCaseAssetHash(item, issueType, disagreementReason),
    issue_type: issueType,
    disagreement_reason: safeToken(disagreementReason, 'UNKNOWN'),
  };
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
    const normalized = normalizeHardCaseRecord(hardCase);
    const issueType = normalized.issue_type;
    const reason = normalized.disagreement_reason;
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

function summarizeByQualityGrade(verifyRows, agreementRows) {
  const qualitySet = new Set(['pass', 'degraded']);
  for (const row of verifyRows) qualitySet.add(safeToken(row?.quality_grade, 'unknown').toLowerCase());
  for (const row of agreementRows) qualitySet.add(safeToken(row?.quality_grade, 'unknown').toLowerCase());

  const summaries = [];
  for (const quality of Array.from(qualitySet.values()).sort()) {
    const verifySubset = verifyRows.filter((row) => safeToken(row?.quality_grade, 'unknown').toLowerCase() === quality);
    const agreementSubset = agreementRows.filter((row) => safeToken(row?.quality_grade, 'unknown').toLowerCase() === quality);
    const failCount = verifySubset.filter((row) => row.is_failure).length;
    summaries.push({
      quality_grade: quality,
      verify_calls: verifySubset.length,
      verify_fails: failCount,
      fail_rate: formatRate(failCount, verifySubset.length),
      agreement_mean: mean(agreementSubset.map((row) => row.agreement)),
    });
  }
  return summaries;
}

function topHardCases(hardCases, dayPrefix, limit = 20) {
  const out = [];
  for (const item of hardCases) {
    if (!String(item?.created_at || '').startsWith(dayPrefix)) continue;
    out.push(normalizeHardCaseRecord(item));
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

function summarizeUnknownSamples(verifyRows, limit = 20) {
  const list = verifyRows
    .filter((row) => row && row.is_failure && row.fail_reason === 'UNKNOWN')
    .map((row) => ({
      trace_id: safeToken(row.trace_id, 'unknown'),
      last_error_class: safeToken(row.last_error_class, 'unknown'),
      latency_ms: safeNumber(row.latency_ms, null),
      provider: safeToken(row.provider, 'unknown'),
    }));

  list.sort((left, right) => {
    const leftLatency = Number.isFinite(Number(left.latency_ms)) ? Number(left.latency_ms) : -1;
    const rightLatency = Number.isFinite(Number(right.latency_ms)) ? Number(right.latency_ms) : -1;
    if (rightLatency !== leftLatency) return rightLatency - leftLatency;
    const classCmp = String(left.last_error_class).localeCompare(String(right.last_error_class));
    if (classCmp !== 0) return classCmp;
    return String(left.trace_id).localeCompare(String(right.trace_id));
  });

  return list.slice(0, Math.max(0, Math.trunc(Number(limit) || 20)));
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
  const goldLabelsPath = path.resolve(inputDir, safeToken(manifest?.paths?.gold_labels || manifest?.files?.gold_labels, 'gold_labels.ndjson'));

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
    goldLabelsPath,
    hardCasesPath,
    outDir,
  };
}

function buildMarkdown({
  dateIso,
  generatedAt,
  summary,
  byIssueType,
  byQuality,
  failByReason,
  failBySubreason,
  alertChecks,
  unknownSamples,
  eligibleBuckets,
  hardCases,
}) {
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
  lines.push(`- latency_p50_ms: ${summary.latency_p50_ms ?? 'n/a'}`);
  lines.push(`- latency_p95_ms: ${summary.latency_p95_ms ?? 'n/a'}`);
  lines.push(`- calls_skipped_by_budget_guard: ${summary.calls_skipped_by_budget_guard}`);
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

  lines.push('## Verify Fail By Reason');
  lines.push('');
  if (failByReason.length) {
    lines.push(table(
      ['reason', 'count', 'rate_vs_calls', 'rate_vs_fails'],
      failByReason.map((row) => [row.reason, row.count, row.rate_vs_calls, row.rate_vs_fails]),
    ));
  } else {
    lines.push('_No verifier failures for this date._');
  }
  lines.push('');

  lines.push('## Verify Fail By Subreason');
  lines.push('');
  if (failBySubreason.length) {
    lines.push(table(
      ['subreason', 'count', 'rate_vs_calls', 'rate_vs_fails'],
      failBySubreason.map((row) => [row.subreason, row.count, row.rate_vs_calls, row.rate_vs_fails]),
    ));
  } else {
    lines.push('_No verifier failures for this date._');
  }
  lines.push('');

  lines.push('## Alert Checks');
  lines.push('');
  if (alertChecks.length) {
    lines.push(table(
      ['metric', 'value', 'threshold_max', 'pass', 'note'],
      alertChecks.map((row) => [row.metric, row.value, row.threshold, row.pass ? 'yes' : 'no', row.note]),
    ));
  } else {
    lines.push('_No alert checks configured._');
  }
  lines.push('');

  lines.push('## Top UNKNOWN Samples');
  lines.push('');
  if (unknownSamples.length) {
    lines.push(table(
      ['trace_id', 'last_error_class', 'latency_ms', 'provider'],
      unknownSamples.map((row) => [row.trace_id, row.last_error_class, row.latency_ms ?? 'n/a', row.provider]),
    ));
  } else {
    lines.push('_No UNKNOWN failures for this date._');
  }
  lines.push('');

  lines.push('## Eligible Buckets (Observation)');
  lines.push('');
  if (eligibleBuckets.length) {
    lines.push(table(
      ['issue_type', 'quality_grade', 'lighting_bucket', 'tone_bucket', 'verify_fail_rate', 'agreement_mean', 'agreement_samples', 'gold_samples'],
      eligibleBuckets.map((row) => [
        row.issue_type,
        row.quality_grade,
        row.lighting_bucket,
        row.tone_bucket,
        row.verify_fail_rate,
        row.agreement_mean ?? 'n/a',
        row.agreement_samples,
        row.gold_samples,
      ]),
    ));
  } else {
    lines.push('_No eligible buckets under current thresholds._');
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
  const goldLabels = await readNdjson(paths.goldLabelsPath);
  const hardCasesAll = await readNdjson(paths.hardCasesPath);

  const modelRows = modelOutputs.filter((row) => String(row?.created_at || '').startsWith(dateIso));
  const verifyRows = extractVerifyRows(modelRows);
  const agreementRows = extractAgreementRows(agreementSamples, dateIso);
  const hardCases = topHardCases(hardCasesAll, dateIso, 20);

  const verifyCalls = verifyRows.length;
  const verifyFails = verifyRows.filter((row) => row.is_failure).length;
  const callsSkippedByBudgetGuard = verifyRows.filter((row) => row.is_guard).length;
  const averageAgreement = mean(agreementRows.map((row) => row.agreement));
  const latencyValues = verifyRows
    .filter((row) => !row.is_guard)
    .map((row) => safeNumber(row.latency_ms, null))
    .filter((value) => Number.isFinite(value));
  const latencyP50 = quantile(latencyValues, 0.5);
  const latencyP95 = quantile(latencyValues, 0.95);
  const hardCaseRate = formatRate(hardCases.length, verifyCalls);

  const byIssueType = summarizeByIssueType(agreementRows, hardCasesAll, dateIso);
  const byQualityGrade = summarizeByQualityGrade(verifyRows, agreementRows);
  const failByReason = summarizeVerifyFailByReason(verifyRows);
  const failBySubreason = summarizeVerifyFailBySubreason(verifyRows);
  const alertThresholds = getAlertThresholds();
  const alertChecks = buildAlertChecks({
    summary: {
      verify_calls_total: verifyCalls,
      verify_fail_total: verifyFails,
    },
    failByReason,
    failBySubreason,
    thresholds: alertThresholds,
  });
  const alertStatus = alertChecks.every((item) => item.pass) ? 'PASS' : 'FAIL';
  const unknownSamples = summarizeUnknownSamples(verifyRows, 20);
  const reliabilityTable = buildReliabilityTable({
    modelOutputs,
    agreementSamples,
    goldLabels,
    datePrefix: dateIso,
    gateConfig: {
      ...resolveVoteGateConfig(),
      voteEnabled: true,
    },
  });
  const eligibleBuckets = reliabilityTable.buckets
    .filter((bucket) => bucket.eligible_for_vote)
    .sort((left, right) => {
      const leftAgreement = Number.isFinite(Number(left.agreement_mean)) ? Number(left.agreement_mean) : -1;
      const rightAgreement = Number.isFinite(Number(right.agreement_mean)) ? Number(right.agreement_mean) : -1;
      if (rightAgreement !== leftAgreement) return rightAgreement - leftAgreement;
      return String(left.bucket_key || '').localeCompare(String(right.bucket_key || ''));
    })
    .slice(0, 30)
    .map((bucket) => ({
      issue_type: bucket.issue_type,
      quality_grade: bucket.quality_grade,
      lighting_bucket: bucket.lighting_bucket,
      tone_bucket: bucket.tone_bucket,
      verify_fail_rate: bucket.verify_fail_rate,
      agreement_mean: bucket.agreement_mean,
      agreement_samples: bucket.agreement_samples,
      gold_samples: bucket.gold_samples,
    }));

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
      gold_labels_path: paths.goldLabelsPath,
      hard_cases_path: paths.hardCasesPath,
      model_outputs_total: modelOutputs.length,
      agreement_samples_total: agreementSamples.length,
      gold_labels_total: goldLabels.length,
      hard_cases_total: hardCasesAll.length,
    },
    summary: {
      verify_calls_total: verifyCalls,
      verify_fail_total: verifyFails,
      average_agreement: averageAgreement,
      hard_case_rate: hardCaseRate,
      latency_p50_ms: latencyP50,
      latency_p95_ms: latencyP95,
      calls_skipped_by_budget_guard: callsSkippedByBudgetGuard,
    },
    by_issue_type: byIssueType,
    by_quality_grade: byQualityGrade,
    verify_fail_by_reason: failByReason,
    verify_fail_by_subreason: failBySubreason,
    alert_thresholds: alertThresholds,
    alert_checks: alertChecks,
    alert_status: alertStatus,
    top_unknown_samples: unknownSamples,
    eligible_buckets: eligibleBuckets,
    top_hard_cases: hardCases,
  };

  const markdown = buildMarkdown({
    dateIso,
    generatedAt: report.generated_at_utc,
    summary: report.summary,
    byIssueType,
    byQuality: byQualityGrade,
    failByReason,
    failBySubreason,
    alertChecks,
    unknownSamples,
    eligibleBuckets,
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

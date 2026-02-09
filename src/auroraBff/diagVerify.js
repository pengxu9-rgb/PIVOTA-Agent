const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runCvProvider, runGeminiProvider, iou } = require('./diagEnsemble');
const { persistPseudoLabelArtifacts } = require('./pseudoLabelFactory');
const { shouldUseVerifierInVote, should_use_verifier_in_vote } = require('./diagReliability');

const VERIFY_SCHEMA_VERSION = 'aurora.diag.verify_shadow.v1';
const HARD_CASE_SCHEMA_VERSION = 'aurora.diag.verify_hard_case.v1';
const VERIFY_GUARD_REASON = 'VERIFY_BUDGET_GUARD';
const VERIFY_CIRCUIT_REASON = 'VERIFY_CIRCUIT_OPEN_UPSTREAM_5XX';
const VERIFY_AUTH_CIRCUIT_REASON = 'VERIFY_CIRCUIT_OPEN_AUTH_4XX';
const VERIFY_INFLIGHT_GUARD_REASON = 'VERIFY_INFLIGHT_GUARD';
const VERIFY_SAMPLE_SKIP_REASON = 'VERIFY_SHADOW_SAMPLE_SKIP';
const VerifyFailReason = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  UPSTREAM_4XX: 'UPSTREAM_4XX',
  UPSTREAM_5XX: 'UPSTREAM_5XX',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  IMAGE_FETCH_FAILED: 'IMAGE_FETCH_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN',
});
const verifyBudgetState = {
  minuteWindowMs: 0,
  minuteCount: 0,
  dayKey: '',
  dayCount: 0,
};
const verify5xxCircuitState = {
  consecutive5xx: 0,
  openUntilMs: 0,
  lastOpenedAtMs: 0,
};
const verifyAuthCircuitState = {
  windowStartMs: 0,
  totalAttempts: 0,
  authFailures: 0,
  openUntilMs: 0,
  lastOpenedAtMs: 0,
};
const verifyInflightState = {
  count: 0,
};

function boolEnv(name, fallback = false) {
  const token = String(process.env[name] == null ? '' : process.env[name])
    .trim()
    .toLowerCase();
  if (!token) return Boolean(fallback);
  return token === '1' || token === 'true' || token === 'yes' || token === 'on';
}

function numEnv(name, fallback, min, max) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function rateEnv(name, fallback) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function round3(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Number(Number(value).toFixed(3));
}

function clamp01(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(1, Number(value)));
}

function hashToken(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
}

function stableShadowSampling({
  sampleRate,
  traceId,
  inferenceId,
  assetId,
} = {}) {
  const rate = clamp01(sampleRate);
  if (rate >= 1) return { selected: true, bucket: 0 };
  if (rate <= 0) return { selected: false, bucket: 1 };
  const token = `${String(traceId || '').trim()}|${String(inferenceId || '').trim()}|${String(assetId || '').trim()}`;
  const digest = crypto.createHash('sha256').update(token || 'shadow-default').digest();
  const bucket = digest.readUInt32BE(0) / 0xffffffff;
  return { selected: bucket < rate, bucket: round3(bucket) };
}

function deriveHardCaseReason({ disagreementReasons, finalReason, verifyFailReason } = {}) {
  const list = Array.isArray(disagreementReasons) ? disagreementReasons : [];
  for (const reason of list) {
    const token = String(reason || '').trim();
    if (token) return token;
  }
  const primary = String(verifyFailReason || finalReason || '').trim();
  if (primary) return primary;
  return VerifyFailReason.UNKNOWN;
}

function deriveHardCaseIssueType({ rows, fallbackReason } = {}) {
  const disagreements = (Array.isArray(rows) ? rows : []).filter((row) => row && row.verdict !== 'agree');
  if (!disagreements.length) {
    if (String(fallbackReason || '').trim().startsWith('QUALITY_')) return 'quality';
    if (String(fallbackReason || '').trim()) return 'verify';
    return 'other';
  }
  const first = disagreements.find((row) => String(row.type || '').trim()) || disagreements[0];
  const type = String(first?.type || '').trim().toLowerCase();
  return type || 'other';
}

function normalizeQualityGrade(grade) {
  const token = String(grade || '')
    .trim()
    .toLowerCase();
  if (token === 'pass' || token === 'degraded' || token === 'fail') return token;
  return 'unknown';
}

function qualityAllowsVerify(grade) {
  const normalized = normalizeQualityGrade(grade);
  return normalized === 'pass' || normalized === 'degraded';
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

function normalizeHttpStatusClass(input, fallbackReason = '') {
  const token = String(input || '').trim().toLowerCase();
  if (token === '2xx' || token === '4xx' || token === '5xx' || token === 'timeout' || token === 'unknown') return token;
  const code = Number(input);
  if (Number.isFinite(code) && code >= 200 && code < 300) return '2xx';
  if (Number.isFinite(code) && code >= 400 && code < 500) return '4xx';
  if (Number.isFinite(code) && code >= 500 && code < 600) return '5xx';
  if (String(fallbackReason || '').toUpperCase().includes('TIMEOUT')) return 'timeout';
  return 'unknown';
}

function summarizeSchemaError(raw) {
  const value = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return null;
  return value.slice(0, 120);
}

function utcDayKey(tsMs) {
  const date = new Date(tsMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resetBudgetWindows(nowMs) {
  const minuteWindowMs = Math.floor(nowMs / 60000) * 60000;
  if (verifyBudgetState.minuteWindowMs !== minuteWindowMs) {
    verifyBudgetState.minuteWindowMs = minuteWindowMs;
    verifyBudgetState.minuteCount = 0;
  }

  const dayKey = utcDayKey(nowMs);
  if (verifyBudgetState.dayKey !== dayKey) {
    verifyBudgetState.dayKey = dayKey;
    verifyBudgetState.dayCount = 0;
  }
}

function reserveVerifyBudget({ maxCallsPerMin, maxCallsPerDay, nowMs } = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  resetBudgetWindows(now);
  const limitMin = toInt(maxCallsPerMin, 0);
  const limitDay = toInt(maxCallsPerDay, 0);

  if (limitMin > 0 && verifyBudgetState.minuteCount >= limitMin) {
    return {
      allowed: false,
      reason: VERIFY_GUARD_REASON,
      usage: {
        minute_count: verifyBudgetState.minuteCount,
        minute_limit: limitMin,
        day_count: verifyBudgetState.dayCount,
        day_limit: limitDay,
      },
    };
  }
  if (limitDay > 0 && verifyBudgetState.dayCount >= limitDay) {
    return {
      allowed: false,
      reason: VERIFY_GUARD_REASON,
      usage: {
        minute_count: verifyBudgetState.minuteCount,
        minute_limit: limitMin,
        day_count: verifyBudgetState.dayCount,
        day_limit: limitDay,
      },
    };
  }

  verifyBudgetState.minuteCount += 1;
  verifyBudgetState.dayCount += 1;
  return {
    allowed: true,
    reason: null,
    usage: {
      minute_count: verifyBudgetState.minuteCount,
      minute_limit: limitMin,
      day_count: verifyBudgetState.dayCount,
      day_limit: limitDay,
    },
  };
}

function resetVerifyCircuitState() {
  verify5xxCircuitState.consecutive5xx = 0;
  verify5xxCircuitState.openUntilMs = 0;
  verify5xxCircuitState.lastOpenedAtMs = 0;
}

function resetAuthCircuitWindow(nowMs, windowMs) {
  const safeWindowMs = Math.max(60000, toInt(windowMs, 600000));
  const currentWindowStart = Math.floor(nowMs / safeWindowMs) * safeWindowMs;
  if (verifyAuthCircuitState.windowStartMs !== currentWindowStart) {
    verifyAuthCircuitState.windowStartMs = currentWindowStart;
    verifyAuthCircuitState.totalAttempts = 0;
    verifyAuthCircuitState.authFailures = 0;
  }
}

function getAuthCircuitSnapshot({
  threshold,
  cooldownMs,
  nowMs,
  windowMs,
  minSamples,
} = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
  resetAuthCircuitWindow(now, windowMs);
  const openUntil = Math.max(0, toInt(verifyAuthCircuitState.openUntilMs, 0));
  const isOpen = openUntil > now;
  const failRate = verifyAuthCircuitState.totalAttempts > 0
    ? verifyAuthCircuitState.authFailures / verifyAuthCircuitState.totalAttempts
    : 0;
  return {
    is_open: isOpen,
    open_until_ms: openUntil,
    remaining_ms: isOpen ? Math.max(0, openUntil - now) : 0,
    fail_rate: round3(failRate),
    total_attempts: verifyAuthCircuitState.totalAttempts,
    auth_failures: verifyAuthCircuitState.authFailures,
    threshold: clamp01(threshold),
    min_samples: Math.max(1, toInt(minSamples, 20)),
    window_ms: Math.max(60000, toInt(windowMs, 600000)),
    cooldown_ms: Math.max(10000, toInt(cooldownMs, 600000)),
  };
}

function updateVerifyAuthCircuitState({
  enabled,
  threshold,
  cooldownMs,
  nowMs,
  windowMs,
  minSamples,
  verifyFailReason,
  providerStatusCode,
} = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
  if (!enabled) {
    verifyAuthCircuitState.windowStartMs = 0;
    verifyAuthCircuitState.totalAttempts = 0;
    verifyAuthCircuitState.authFailures = 0;
    verifyAuthCircuitState.openUntilMs = 0;
    verifyAuthCircuitState.lastOpenedAtMs = 0;
    return { openedNow: false, snapshot: getAuthCircuitSnapshot({ threshold, cooldownMs, nowMs: now, windowMs, minSamples }) };
  }

  resetAuthCircuitWindow(now, windowMs);
  verifyAuthCircuitState.totalAttempts += 1;
  const statusCode = toInt(providerStatusCode, 0);
  if (verifyFailReason === VerifyFailReason.UPSTREAM_4XX && (statusCode === 401 || statusCode === 403)) {
    verifyAuthCircuitState.authFailures += 1;
  }

  const safeMinSamples = Math.max(1, toInt(minSamples, 20));
  const failRate = verifyAuthCircuitState.totalAttempts > 0
    ? verifyAuthCircuitState.authFailures / verifyAuthCircuitState.totalAttempts
    : 0;
  if (
    verifyAuthCircuitState.openUntilMs <= now &&
    verifyAuthCircuitState.totalAttempts >= safeMinSamples &&
    failRate > clamp01(threshold)
  ) {
    verifyAuthCircuitState.openUntilMs = now + Math.max(10000, toInt(cooldownMs, 600000));
    verifyAuthCircuitState.lastOpenedAtMs = now;
    return { openedNow: true, snapshot: getAuthCircuitSnapshot({ threshold, cooldownMs, nowMs: now, windowMs, minSamples }) };
  }

  return { openedNow: false, snapshot: getAuthCircuitSnapshot({ threshold, cooldownMs, nowMs: now, windowMs, minSamples }) };
}

function reserveInflightSlot(maxInflight) {
  const safeMax = Math.max(0, toInt(maxInflight, 0));
  if (safeMax > 0 && verifyInflightState.count >= safeMax) {
    return false;
  }
  verifyInflightState.count += 1;
  return true;
}

function releaseInflightSlot() {
  verifyInflightState.count = Math.max(0, verifyInflightState.count - 1);
}

function getCircuitGuardSnapshot({ threshold, cooldownMs, nowMs } = {}) {
  const now = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();
  const openUntil = Math.max(0, toInt(verify5xxCircuitState.openUntilMs, 0));
  const isOpen = openUntil > now;
  return {
    is_open: isOpen,
    open_until_ms: openUntil,
    remaining_ms: isOpen ? Math.max(0, openUntil - now) : 0,
    consecutive_5xx: Math.max(0, toInt(verify5xxCircuitState.consecutive5xx, 0)),
    threshold: Math.max(1, toInt(threshold, 1)),
    cooldown_ms: Math.max(1000, toInt(cooldownMs, 90000)),
  };
}

function updateVerifyCircuitState({
  enabled,
  threshold,
  cooldownMs,
  verifyFailReason,
  nowMs,
} = {}) {
  if (!enabled) {
    resetVerifyCircuitState();
    return { openedNow: false, snapshot: getCircuitGuardSnapshot({ threshold, cooldownMs, nowMs }) };
  }
  const safeThreshold = Math.max(1, toInt(threshold, 1));
  const safeCooldownMs = Math.max(1000, toInt(cooldownMs, 90000));
  const now = Number.isFinite(Number(nowMs)) ? Math.trunc(Number(nowMs)) : Date.now();

  if (verifyFailReason === VerifyFailReason.UPSTREAM_5XX) {
    verify5xxCircuitState.consecutive5xx += 1;
    if (verify5xxCircuitState.consecutive5xx >= safeThreshold) {
      verify5xxCircuitState.openUntilMs = now + safeCooldownMs;
      verify5xxCircuitState.lastOpenedAtMs = now;
      verify5xxCircuitState.consecutive5xx = 0;
      return {
        openedNow: true,
        snapshot: getCircuitGuardSnapshot({ threshold: safeThreshold, cooldownMs: safeCooldownMs, nowMs: now }),
      };
    }
    return {
      openedNow: false,
      snapshot: getCircuitGuardSnapshot({ threshold: safeThreshold, cooldownMs: safeCooldownMs, nowMs: now }),
    };
  }

  verify5xxCircuitState.consecutive5xx = 0;
  return {
    openedNow: false,
    snapshot: getCircuitGuardSnapshot({ threshold: safeThreshold, cooldownMs: safeCooldownMs, nowMs: now }),
  };
}

function extractPrimaryBBox(concern) {
  const regions = Array.isArray(concern?.regions) ? concern.regions : [];
  for (const region of regions) {
    if (region && region.kind === 'bbox' && region.bbox_norm && typeof region.bbox_norm === 'object') {
      const { x0, y0, x1, y1 } = region.bbox_norm;
      if ([x0, y0, x1, y1].every((v) => Number.isFinite(Number(v)))) {
        return {
          x0: clamp01(x0),
          y0: clamp01(y0),
          x1: clamp01(x1),
          y1: clamp01(y1),
        };
      }
    }
  }
  return null;
}

function avgSeverity(concerns) {
  if (!Array.isArray(concerns) || !concerns.length) return 0;
  let sum = 0;
  for (const concern of concerns) sum += Number.isFinite(Number(concern?.severity)) ? Number(concern.severity) : 0;
  return sum / concerns.length;
}

function avgConfidence(concerns) {
  if (!Array.isArray(concerns) || !concerns.length) return 0;
  let sum = 0;
  for (const concern of concerns) sum += clamp01(concern?.confidence);
  return sum / concerns.length;
}

function firstEvidence(concerns) {
  for (const concern of Array.isArray(concerns) ? concerns : []) {
    const text = String(concern?.evidence_text || '').trim();
    if (text) return text;
  }
  return '';
}

function buildGlobalNotes(flags = []) {
  const notes = [];
  const set = new Set((Array.isArray(flags) ? flags : []).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean));
  if (set.has('possible_lighting_bias')) notes.push('Lighting may affect confidence for this run.');
  if (set.has('possible_filter_bias')) notes.push('Filter-like artifacts may affect visual interpretation.');
  if (set.has('possible_makeup_bias')) notes.push('Makeup coverage may mask underlying skin texture/tone.');
  return notes.slice(0, 3);
}

function buildIssueComparisons({ cvConcerns = [], geminiConcerns = [], iouThreshold = 0.3 } = {}) {
  const byType = new Map();
  const addByType = (concern, source) => {
    const type = String(concern?.type || 'other').trim() || 'other';
    if (!byType.has(type)) byType.set(type, { cv: [], gemini: [] });
    byType.get(type)[source].push(concern);
  };
  for (const concern of cvConcerns) addByType(concern, 'cv');
  for (const concern of geminiConcerns) addByType(concern, 'gemini');

  const rows = [];
  for (const [type, groups] of Array.from(byType.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    const left = groups.cv;
    const right = groups.gemini;
    const item = {
      type,
      verdict: 'uncertain',
      iou: 0,
      severity_delta: 0,
      confidence_delta: 0,
      evidence: '',
      reason: '',
      suggested_fix: {},
    };

    if (!left.length && !right.length) continue;

    if (!left.length) {
      item.verdict = 'disagree';
      item.reason = 'missing_in_cv';
      item.evidence = firstEvidence(right);
      item.suggested_fix = {
        type_change: `cv_missing:${type}`,
        confidence_adjust: -0.12,
      };
      rows.push(item);
      continue;
    }

    if (!right.length) {
      item.verdict = 'disagree';
      item.reason = 'missing_in_gemini';
      item.evidence = firstEvidence(left);
      item.suggested_fix = {
        type_change: `gemini_missing:${type}`,
        confidence_adjust: -0.12,
      };
      rows.push(item);
      continue;
    }

    let bestIou = 0;
    let bestPair = null;
    for (const l of left) {
      const lBox = extractPrimaryBBox(l);
      for (const r of right) {
        const rBox = extractPrimaryBBox(r);
        if (!lBox || !rBox) continue;
        const overlap = iou(lBox, rBox);
        if (overlap >= bestIou) {
          bestIou = overlap;
          bestPair = { l, r, rBox };
        }
      }
    }

    const severityDelta = Math.abs(avgSeverity(left) - avgSeverity(right));
    const confidenceDelta = Math.abs(avgConfidence(left) - avgConfidence(right));
    item.iou = round3(bestIou);
    item.severity_delta = round3(severityDelta);
    item.confidence_delta = round3(confidenceDelta);
    item.evidence = firstEvidence(bestPair ? [bestPair.r, bestPair.l] : [...right, ...left]);

    if (!bestPair || bestIou < iouThreshold) {
      item.verdict = 'disagree';
      item.reason = 'region_mismatch';
      item.suggested_fix = {
        region_hint: bestPair?.rBox || null,
        confidence_adjust: -0.15,
      };
      rows.push(item);
      continue;
    }

    if (bestIou >= 0.55 && severityDelta <= 0.9) {
      item.verdict = 'agree';
      item.reason = 'consistent';
      item.suggested_fix = {
        confidence_adjust: confidenceDelta > 0.25 ? -0.03 : 0,
      };
      rows.push(item);
      continue;
    }

    item.verdict = severityDelta <= 1.6 ? 'uncertain' : 'disagree';
    item.reason = item.verdict === 'uncertain' ? 'severity_uncertain' : 'severity_mismatch';
    item.suggested_fix = {
      region_hint: bestPair.rBox || null,
      confidence_adjust: item.verdict === 'uncertain' ? -0.06 : -0.12,
    };
    rows.push(item);
  }

  return rows;
}

function computeAgreementScore(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 1;
  let sum = 0;
  for (const row of list) {
    if (row.verdict === 'agree') sum += 1;
    else if (row.verdict === 'uncertain') sum += 0.5;
  }
  return round3(sum / list.length);
}

function collectDisagreementReasons(rows) {
  const set = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.verdict === 'agree') continue;
    const reason = String(row.reason || '').trim();
    if (reason) set.add(reason);
  }
  return Array.from(set).slice(0, 10);
}

function buildProviderStat(output) {
  const concerns = Array.isArray(output?.concerns) ? output.concerns : [];
  const providerStatusCode = toInt(output?.provider_status_code, output?.ok ? 200 : 0);
  const attempts = Math.max(1, toInt(output?.attempts, 1));
  const finalReason = output?.ok ? 'OK' : String(output?.final_reason || output?.failure_reason || VerifyFailReason.UNKNOWN);
  return {
    provider: String(output?.provider || 'unknown'),
    ok: Boolean(output?.ok),
    latency_ms: round3(Math.max(0, Number(output?.latency_ms || 0))),
    provider_status_code: providerStatusCode,
    http_status_class: normalizeHttpStatusClass(output?.http_status_class, finalReason),
    attempts,
    final_reason: finalReason,
    concern_count: concerns.length,
    ...(output?.error_class ? { error_class: String(output.error_class) } : {}),
    ...(Number.isFinite(Number(output?.image_bytes_len)) ? { image_bytes_len: toInt(output.image_bytes_len, 0) } : {}),
    ...(Number.isFinite(Number(output?.request_payload_bytes_len))
      ? { request_payload_bytes_len: toInt(output.request_payload_bytes_len, 0) }
      : {}),
    ...(Number.isFinite(Number(output?.response_bytes_len)) ? { response_bytes_len: toInt(output.response_bytes_len, 0) } : {}),
    ...(output?.schema_error_summary ? { schema_error_summary: summarizeSchemaError(output.schema_error_summary) } : {}),
    ...(output?.failure_reason ? { failure_reason: String(output.failure_reason) } : {}),
    ...(output?.verify_fail_reason ? { verify_fail_reason: String(output.verify_fail_reason) } : {}),
    ...(output?.schema_failed ? { schema_failed: true } : {}),
  };
}

function normalizeVerifyFailReason({ reason, providerStatusCode, httpStatusClass, errorClass } = {}) {
  const statusCode = Number.isFinite(Number(providerStatusCode)) ? Math.trunc(Number(providerStatusCode)) : 0;
  const statusClass = String(httpStatusClass || '')
    .trim()
    .toLowerCase();
  const errorToken = String(errorClass || '')
    .trim()
    .toUpperCase();
  const token = String(reason || '')
    .trim()
    .toUpperCase();

  if (!token) {
    if (statusCode === 429) return VerifyFailReason.RATE_LIMIT;
    if (statusCode >= 500) return VerifyFailReason.UPSTREAM_5XX;
    if (statusCode >= 400) return VerifyFailReason.UPSTREAM_4XX;
    return VerifyFailReason.UNKNOWN;
  }

  if (
    token === VerifyFailReason.TIMEOUT ||
    token.includes('TIMEOUT') ||
    token === 'ETIMEDOUT' ||
    token.includes('VISION_TIMEOUT')
  ) {
    return VerifyFailReason.TIMEOUT;
  }
  if (
    token === VerifyFailReason.QUOTA ||
    token.includes('QUOTA') ||
    token.includes('INSUFFICIENT_QUOTA') ||
    token.includes('VISION_QUOTA_EXCEEDED')
  ) {
    return VerifyFailReason.QUOTA;
  }
  if (
    token === VerifyFailReason.RATE_LIMIT ||
    token.includes('RATE_LIMIT') ||
    token.includes('VISION_RATE_LIMITED') ||
    statusCode === 429
  ) {
    return VerifyFailReason.RATE_LIMIT;
  }
  if (
    token === VerifyFailReason.SCHEMA_INVALID ||
    token.includes('SCHEMA_INVALID') ||
    token.includes('CANONICAL_SCHEMA_INVALID') ||
    token.includes('VISION_SCHEMA_INVALID')
  ) {
    return VerifyFailReason.SCHEMA_INVALID;
  }
  if (
    token === VerifyFailReason.IMAGE_FETCH_FAILED ||
    token.includes('MISSING_IMAGE') ||
    token.includes('IMAGE_FETCH') ||
    token.includes('PHOTO_DOWNLOAD') ||
    token.includes('VISION_IMAGE_INVALID')
  ) {
    return VerifyFailReason.IMAGE_FETCH_FAILED;
  }
  if (token === VerifyFailReason.NETWORK_ERROR || token.includes('VISION_NETWORK_ERROR') || token.includes('DNS')) {
    return VerifyFailReason.NETWORK_ERROR;
  }
  if (token === VerifyFailReason.UPSTREAM_5XX || token.includes('UPSTREAM_5XX') || statusCode >= 500) {
    return VerifyFailReason.UPSTREAM_5XX;
  }
  if (
    token === VerifyFailReason.UPSTREAM_4XX ||
    token.includes('UPSTREAM_4XX') ||
    token.includes('VISION_UPSTREAM_4XX') ||
    token.includes('VISION_MISSING_KEY') ||
    statusCode >= 400
  ) {
    return VerifyFailReason.UPSTREAM_4XX;
  }
  if (statusClass === '5xx') return VerifyFailReason.UPSTREAM_5XX;
  if (statusClass === '4xx') return VerifyFailReason.UPSTREAM_4XX;
  if (
    errorToken.includes('TIMEOUT') ||
    errorToken.includes('ETIMEDOUT') ||
    errorToken.includes('ECONNABORTED') ||
    errorToken.includes('DEADLINE_EXCEEDED')
  ) {
    return VerifyFailReason.TIMEOUT;
  }
  if (errorToken.includes('RATE_LIMIT') || errorToken.includes('TOO_MANY_REQUESTS')) {
    return VerifyFailReason.RATE_LIMIT;
  }
  if (errorToken.includes('QUOTA') || errorToken.includes('RESOURCE_EXHAUSTED')) {
    return VerifyFailReason.QUOTA;
  }
  if (
    errorToken.includes('PERMISSION_DENIED') ||
    errorToken.includes('UNAUTHENTICATED') ||
    errorToken.includes('INVALID_ARGUMENT') ||
    errorToken.includes('FAILED_PRECONDITION') ||
    errorToken.includes('FORBIDDEN')
  ) {
    return VerifyFailReason.UPSTREAM_4XX;
  }
  if (
    errorToken.includes('UNAVAILABLE') ||
    errorToken.includes('SERVICE_UNAVAILABLE') ||
    errorToken.includes('INTERNAL')
  ) {
    return VerifyFailReason.UPSTREAM_5XX;
  }
  if (
    errorToken.includes('NETWORK') ||
    errorToken.includes('ENOTFOUND') ||
    errorToken.includes('EAI_AGAIN') ||
    errorToken.includes('ECONNRESET') ||
    errorToken.includes('ECONNREFUSED') ||
    errorToken.includes('FETCH_FAILED') ||
    errorToken.includes('DNS')
  ) {
    return VerifyFailReason.NETWORK_ERROR;
  }
  if (token.includes('REQUEST_FAILED') || token.includes('SERVICE_UNAVAILABLE') || errorToken.includes('MISSING_DEP')) {
    return VerifyFailReason.UPSTREAM_5XX;
  }
  return VerifyFailReason.UNKNOWN;
}

async function persistVerifierSkipRecord({
  inferenceId,
  qualityGrade,
  skinToneBucket,
  lightingBucket,
  finalReason,
  logger,
} = {}) {
  try {
    return await persistPseudoLabelArtifacts({
      inferenceId: inferenceId || null,
      qualityGrade,
      providerOutputs: [
        {
          ok: false,
          provider: 'gemini_provider',
          concerns: [],
          decision: 'skip',
          attempts: 0,
          latency_ms: 0,
          provider_status_code: 0,
          failure_reason: finalReason,
          final_reason: finalReason,
          verify_fail_reason: null,
        },
      ],
      skinToneBucket: String(skinToneBucket || 'unknown').trim() || 'unknown',
      lightingBucket: String(lightingBucket || 'unknown').trim() || 'unknown',
      logger,
    });
  } catch (err) {
    logger?.warn(
      { err: err && err.message ? err.message : String(err) },
      'diag verify: failed to persist skip output',
    );
    return null;
  }
}

function getHardCaseFilePath() {
  const configured = String(process.env.DIAG_GEMINI_VERIFY_HARD_CASE_PATH || '').trim();
  if (configured) return configured;
  return path.join(process.cwd(), 'tmp', 'diag_verify', 'hard_cases.ndjson');
}

async function appendHardCaseRecord(record) {
  const outputPath = getHardCaseFilePath();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.appendFile(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
  return outputPath;
}

function getVerifierConfig() {
  const connectTimeoutMs = numEnv(
    'DIAG_VERIFY_CONNECT_TIMEOUT_MS',
    numEnv('DIAG_GEMINI_VERIFY_CONNECT_TIMEOUT_MS', 6000, 500, 60000),
    500,
    60000,
  );
  const readTimeoutMs = numEnv(
    'DIAG_VERIFY_READ_TIMEOUT_MS',
    numEnv('DIAG_GEMINI_VERIFY_READ_TIMEOUT_MS', 12000, 500, 90000),
    500,
    90000,
  );
  const totalTimeoutDefault = Math.max(1000, Math.trunc(connectTimeoutMs + readTimeoutMs));
  const shadowEnabled = boolEnv('DIAG_VERIFY_SHADOW_ENABLED', false);
  const legacyEnabled = boolEnv('DIAG_GEMINI_VERIFY', false);
  const shadowModeFlag = boolEnv('DIAG_SHADOW_MODE', false);
  const enabled = shadowEnabled || legacyEnabled;
  return {
    enabled,
    shadowEnabled,
    legacyEnabled,
    shadowMode: shadowEnabled ? true : shadowModeFlag,
    sampleRate: rateEnv('DIAG_VERIFY_SHADOW_SAMPLE_RATE', shadowEnabled ? 0.01 : 1),
    iouThreshold: numEnv('DIAG_GEMINI_VERIFY_IOU_THRESHOLD', 0.3, 0.05, 0.95),
    timeoutConnectMs: connectTimeoutMs,
    timeoutReadMs: readTimeoutMs,
    timeoutMs: numEnv(
      'DIAG_VERIFY_TIMEOUT_MS',
      numEnv('DIAG_GEMINI_VERIFY_TIMEOUT_MS', totalTimeoutDefault, 1000, 120000),
      1000,
      120000,
    ),
    retries: Math.trunc(numEnv('DIAG_GEMINI_VERIFY_RETRIES', 1, 0, 3)),
    hardCaseThreshold: numEnv('DIAG_GEMINI_VERIFY_HARD_CASE_THRESHOLD', 0.55, 0, 1),
    maxCallsPerMin: Math.max(0, Math.trunc(numEnv('DIAG_VERIFY_MAX_CALLS_PER_MIN', 60, 0, 1000000))),
    maxCallsPerDay: Math.max(0, Math.trunc(numEnv('DIAG_VERIFY_MAX_CALLS_PER_DAY', 10000, 0, 100000000))),
    model: String(process.env.DIAG_GEMINI_VERIFY_MODEL || process.env.DIAG_ENSEMBLE_GEMINI_MODEL || 'gemini-2.0-flash').trim() || 'gemini-2.0-flash',
    circuitEnabled: boolEnv('DIAG_VERIFY_5XX_CIRCUIT_ENABLED', true),
    circuitConsecutiveThreshold: Math.max(1, Math.trunc(numEnv('DIAG_VERIFY_5XX_CONSECUTIVE_THRESHOLD', 3, 1, 50))),
    circuitCooldownMs: Math.max(1000, Math.trunc(numEnv('DIAG_VERIFY_5XX_COOLDOWN_MS', 90000, 1000, 900000))),
    authCircuitEnabled: boolEnv('DIAG_VERIFY_AUTH_CIRCUIT_ENABLED', true),
    authCircuitFailRateThreshold: rateEnv('DIAG_VERIFY_AUTH_FAIL_RATE_THRESHOLD', 0.01),
    authCircuitCooldownMs: Math.max(10000, Math.trunc(numEnv('DIAG_VERIFY_AUTH_CIRCUIT_COOLDOWN_MS', 600000, 10000, 3600000))),
    authCircuitWindowMs: Math.max(60000, Math.trunc(numEnv('DIAG_VERIFY_AUTH_FAIL_WINDOW_MS', 600000, 60000, 3600000))),
    authCircuitMinSamples: Math.max(1, Math.trunc(numEnv('DIAG_VERIFY_AUTH_FAIL_MIN_SAMPLES', 20, 1, 10000))),
    maxInflight: Math.max(0, Math.trunc(numEnv('DIAG_VERIFY_MAX_INFLIGHT', 32, 0, 10000))),
    allowGuardTest: boolEnv('ALLOW_GUARD_TEST', false),
  };
}

async function runGeminiShadowVerify({
  imageBuffer,
  language,
  photoQuality,
  usedPhotos,
  diagnosisV1,
  diagnosisInternal,
  profileSummary,
  recentLogsSummary,
  inferenceId,
  traceId,
  assetId,
  runtimeLimits,
  skinToneBucket,
  lightingBucket,
  logger,
  providerOverrides,
  metricsHooks,
} = {}) {
  const cfg = getVerifierConfig();
  const qualityGrade = normalizeQualityGrade(photoQuality?.grade || diagnosisV1?.quality?.grade || 'unknown');

  if (!cfg.enabled) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: 'DISABLED_BY_FLAG' });
    }
    return {
      ok: false,
      enabled: false,
      called: false,
      decision: 'skip',
      final_reason: 'DISABLED_BY_FLAG',
      provider_status_code: 0,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: 'DISABLED_BY_FLAG',
    };
  }

  if (!usedPhotos) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: 'PHOTO_NOT_USED' });
    }
    return {
      ok: false,
      enabled: true,
      called: false,
      decision: 'skip',
      final_reason: 'PHOTO_NOT_USED',
      provider_status_code: 0,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: 'PHOTO_NOT_USED',
    };
  }

  if (!qualityAllowsVerify(qualityGrade)) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: `QUALITY_${qualityGrade.toUpperCase()}` });
    }
    return {
      ok: false,
      enabled: true,
      called: false,
      decision: 'skip',
      final_reason: `QUALITY_${qualityGrade.toUpperCase()}`,
      provider_status_code: 0,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: `QUALITY_${qualityGrade.toUpperCase()}`,
    };
  }

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: 'MISSING_IMAGE_BUFFER' });
    }
    return {
      ok: false,
      enabled: true,
      called: false,
      decision: 'skip',
      final_reason: 'MISSING_IMAGE_BUFFER',
      provider_status_code: 0,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: 'MISSING_IMAGE_BUFFER',
    };
  }

  if (cfg.shadowMode) {
    const sample = stableShadowSampling({
      sampleRate: cfg.sampleRate,
      traceId,
      inferenceId,
      assetId,
    });
    if (!sample.selected) {
      if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
      if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
        metricsHooks.onVerifySkip({ reason: VERIFY_SAMPLE_SKIP_REASON });
      }
      return {
        ok: false,
        enabled: true,
        called: false,
        decision: 'skip',
        final_reason: VERIFY_SAMPLE_SKIP_REASON,
        provider_status_code: 0,
        latency_ms: 0,
        attempts: 0,
        skipped_reason: VERIFY_SAMPLE_SKIP_REASON,
      };
    }
  }

  const effectiveMaxCallsPerMin = cfg.allowGuardTest
    ? toInt(runtimeLimits?.maxCallsPerMin, cfg.maxCallsPerMin)
    : cfg.maxCallsPerMin;
  const effectiveMaxCallsPerDay = cfg.allowGuardTest
    ? toInt(runtimeLimits?.maxCallsPerDay, cfg.maxCallsPerDay)
    : cfg.maxCallsPerDay;

  const preCallCircuit = getCircuitGuardSnapshot({
    threshold: cfg.circuitConsecutiveThreshold,
    cooldownMs: cfg.circuitCooldownMs,
  });
  if (cfg.circuitEnabled && preCallCircuit.is_open) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifyCircuitOpen === 'function') {
      metricsHooks.onVerifyCircuitOpen({
        reason: VERIFY_CIRCUIT_REASON,
        ...preCallCircuit,
      });
    }
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: VERIFY_CIRCUIT_REASON });
    }
    const persistence = await persistVerifierSkipRecord({
      inferenceId: inferenceId || null,
      qualityGrade,
      skinToneBucket,
      lightingBucket,
      finalReason: VERIFY_CIRCUIT_REASON,
      logger,
    });
    return {
      ok: false,
      enabled: true,
      called: false,
      decision: 'skip',
      final_reason: VERIFY_CIRCUIT_REASON,
      provider_status_code: 503,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: VERIFY_CIRCUIT_REASON,
      circuit_breaker: preCallCircuit,
      persistence,
    };
  }

  const preAuthCircuit = getAuthCircuitSnapshot({
    threshold: cfg.authCircuitFailRateThreshold,
    cooldownMs: cfg.authCircuitCooldownMs,
    windowMs: cfg.authCircuitWindowMs,
    minSamples: cfg.authCircuitMinSamples,
  });
  if (cfg.authCircuitEnabled && preAuthCircuit.is_open) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: VERIFY_AUTH_CIRCUIT_REASON });
    }
    if (metricsHooks && typeof metricsHooks.onVerifyCircuitOpen === 'function') {
      metricsHooks.onVerifyCircuitOpen({
        reason: VERIFY_AUTH_CIRCUIT_REASON,
        ...preAuthCircuit,
      });
    }
    return {
      ok: false,
      enabled: true,
      called: false,
      decision: 'skip',
      final_reason: VERIFY_AUTH_CIRCUIT_REASON,
      provider_status_code: 403,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: VERIFY_AUTH_CIRCUIT_REASON,
      auth_circuit_breaker: preAuthCircuit,
    };
  }

  const budget = reserveVerifyBudget({
    maxCallsPerMin: effectiveMaxCallsPerMin,
    maxCallsPerDay: effectiveMaxCallsPerDay,
    nowMs: Date.now(),
  });
  if (!budget.allowed) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifyBudgetGuard === 'function') {
      metricsHooks.onVerifyBudgetGuard({
        reason: VERIFY_GUARD_REASON,
        ...budget.usage,
      });
    }
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: VERIFY_GUARD_REASON });
    }
    const persistence = await persistVerifierSkipRecord({
      inferenceId: inferenceId || null,
      qualityGrade,
      skinToneBucket,
      lightingBucket,
      finalReason: VERIFY_GUARD_REASON,
      logger,
    });
    return {
      ok: false,
      enabled: true,
      called: false,
      decision: 'skip',
      final_reason: VERIFY_GUARD_REASON,
      provider_status_code: 0,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: VERIFY_GUARD_REASON,
      budget_guard: {
        ...budget.usage,
      },
      persistence,
    };
  }

  if (!reserveInflightSlot(cfg.maxInflight)) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'skip' });
    if (metricsHooks && typeof metricsHooks.onVerifySkip === 'function') {
      metricsHooks.onVerifySkip({ reason: VERIFY_INFLIGHT_GUARD_REASON });
    }
    if (metricsHooks && typeof metricsHooks.onVerifyInFlightGuard === 'function') {
      metricsHooks.onVerifyInFlightGuard({
        reason: VERIFY_INFLIGHT_GUARD_REASON,
      });
    }
    return {
      ok: false,
      enabled: true,
      called: false,
      decision: 'skip',
      final_reason: VERIFY_INFLIGHT_GUARD_REASON,
      provider_status_code: 0,
      latency_ms: 0,
      attempts: 0,
      skipped_reason: VERIFY_INFLIGHT_GUARD_REASON,
    };
  }

  const runCv = providerOverrides && typeof providerOverrides.cvProvider === 'function' ? providerOverrides.cvProvider : runCvProvider;
  const runGemini =
    providerOverrides && typeof providerOverrides.geminiProvider === 'function' ? providerOverrides.geminiProvider : runGeminiProvider;

  if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'attempt' });

  let cvOutput;
  let geminiOutput;
  try {
    cvOutput = await runCv({
      diagnosisV1,
      diagnosisInternal,
      photoQuality,
      language,
    });

    geminiOutput = await runGemini({
      imageBuffer,
      language,
      profileSummary,
      recentLogsSummary,
      photoQuality,
      retries: cfg.retries,
      timeoutMs: cfg.timeoutMs,
      connectTimeoutMs: cfg.timeoutConnectMs,
      readTimeoutMs: cfg.timeoutReadMs,
      model: cfg.model,
    });
  } finally {
    releaseInflightSlot();
  }

  const verifyLatencyMs = round3(Math.max(0, Number(geminiOutput?.latency_ms || 0)));
  const verifyAttempts = Math.max(1, toInt(geminiOutput?.attempts, cfg.retries + 1));
  const providerStatusCode = toInt(geminiOutput?.provider_status_code, geminiOutput?.ok ? 200 : 0);
  const statusClass = normalizeHttpStatusClass(geminiOutput?.http_status_class || providerStatusCode, geminiOutput?.failure_reason);
  const timeoutStage = String(geminiOutput?.timeout_stage || '')
    .trim()
    .toLowerCase() || null;
  const rawFinalReason = geminiOutput?.ok ? 'OK' : String(geminiOutput?.failure_reason || VerifyFailReason.UNKNOWN);
  const verifyFailReason = geminiOutput?.ok
    ? null
    : normalizeVerifyFailReason({
        reason: rawFinalReason,
        providerStatusCode,
        httpStatusClass: geminiOutput?.http_status_class,
        errorClass: geminiOutput?.error_class,
      });
  const finalReason = geminiOutput?.ok ? 'OK' : verifyFailReason || VerifyFailReason.UNKNOWN;
  const schemaErrorSummary = summarizeSchemaError(geminiOutput?.schema_error_summary);
  const imageBytesLen = toInt(geminiOutput?.image_bytes_len, Buffer.isBuffer(imageBuffer) ? imageBuffer.length : 0);
  const requestPayloadBytesLen = toInt(geminiOutput?.request_payload_bytes_len, 0);
  const responseBytesLen = toInt(geminiOutput?.response_bytes_len, 0);
  const errorClass = String(geminiOutput?.error_class || '').trim() || null;
  const upstreamRequestId = String(geminiOutput?.upstream_request_id || '').trim() || null;
  const effectiveTraceId = String(traceId || inferenceId || '').trim() || null;
  const geminiOutputForStore = {
    ...geminiOutput,
    final_reason: finalReason,
    raw_final_reason: rawFinalReason,
    verify_fail_reason: verifyFailReason,
    decision: 'verify',
    attempts: verifyAttempts,
    provider_status_code: providerStatusCode,
    latency_ms: verifyLatencyMs,
    http_status_class: statusClass,
    error_class: errorClass,
    image_bytes_len: imageBytesLen,
    request_payload_bytes_len: requestPayloadBytesLen,
    response_bytes_len: responseBytesLen,
    schema_error_summary: schemaErrorSummary,
    ...(timeoutStage ? { timeout_stage: timeoutStage } : {}),
    ...(upstreamRequestId ? { upstream_request_id: upstreamRequestId } : {}),
    trace_id: effectiveTraceId,
  };
  const providerStats = [buildProviderStat(cvOutput), buildProviderStat(geminiOutputForStore)];
  if (metricsHooks && typeof metricsHooks.onProviderResult === 'function') {
    for (const stat of providerStats) metricsHooks.onProviderResult(stat);
  }

  const rows = buildIssueComparisons({
    cvConcerns: Array.isArray(cvOutput?.concerns) ? cvOutput.concerns : [],
    geminiConcerns: Array.isArray(geminiOutput?.concerns) ? geminiOutput.concerns : [],
    iouThreshold: cfg.iouThreshold,
  });
  const agreementScore = computeAgreementScore(rows);
  const disagreementReasons = collectDisagreementReasons(rows);
  const globalNotes = buildGlobalNotes(geminiOutput?.flags);

  const verifierVerdict = {
    schema_version: VERIFY_SCHEMA_VERSION,
    per_issue: rows.map((row) => ({
      type: row.type,
      verdict: row.verdict,
      iou: row.iou,
      severity_delta: row.severity_delta,
      confidence_delta: row.confidence_delta,
      evidence_text: row.evidence,
      reason: row.reason,
      suggested_fix: row.suggested_fix || {},
    })),
    suggested_fix: rows
      .filter((row) => row.suggested_fix && Object.keys(row.suggested_fix).length > 0)
      .slice(0, 8)
      .map((row) => ({ type: row.type, ...row.suggested_fix })),
    global_notes: globalNotes,
  };

  let persistence = null;
  try {
    persistence = await persistPseudoLabelArtifacts({
      inferenceId: inferenceId || null,
      qualityGrade,
      providerOutputs: [cvOutput, geminiOutputForStore],
      skinToneBucket: String(skinToneBucket || 'unknown').trim() || 'unknown',
      lightingBucket: String(lightingBucket || 'unknown').trim() || 'unknown',
      logger,
    });
  } catch (err) {
    logger?.warn(
      { err: err && err.message ? err.message : String(err) },
      'diag verify: failed to persist shadow outputs',
    );
  }

  const hardCase = !geminiOutput.ok || agreementScore < cfg.hardCaseThreshold || disagreementReasons.length > 0;
  let hardCasePath = null;
  if (hardCase) {
    try {
      const requestToken = String(inferenceId || '').trim();
      const assetToken = String(assetId || '').trim();
      const hardCaseReason = deriveHardCaseReason({
        disagreementReasons,
        finalReason,
        verifyFailReason,
      });
      const hardCaseIssueType = deriveHardCaseIssueType({
        rows,
        fallbackReason: hardCaseReason,
      });
      hardCasePath = await appendHardCaseRecord({
        schema_version: HARD_CASE_SCHEMA_VERSION,
        created_at: new Date().toISOString(),
        inference_id: requestToken || null,
        request_id_hash: hashToken(requestToken),
        asset_id_hash: hashToken(assetToken),
        quality_grade: qualityGrade,
        issue_type: hardCaseIssueType,
        disagreement_reason: hardCaseReason,
        agreement_score: agreementScore,
        disagreement_reasons: disagreementReasons,
        provider_stats: providerStats,
        provider_status_code: providerStatusCode,
        latency_ms: verifyLatencyMs,
        attempts: verifyAttempts,
        final_reason: finalReason,
        raw_final_reason: rawFinalReason,
        verifier: verifierVerdict,
      });
    } catch (err) {
      logger?.warn(
        { err: err && err.message ? err.message : String(err) },
        'diag verify: failed to write hard case record',
      );
    }
  }

  if (!geminiOutput.ok && metricsHooks && typeof metricsHooks.onVerifyFail === 'function') {
    metricsHooks.onVerifyFail({
      reason: verifyFailReason || VerifyFailReason.UNKNOWN,
      provider: 'gemini_provider',
      provider_status_code: providerStatusCode,
      http_status_class: statusClass,
      latency_ms: verifyLatencyMs,
      attempts: verifyAttempts,
      retry_count: Math.max(0, verifyAttempts - 1),
      final_reason: finalReason,
      raw_final_reason: rawFinalReason,
      trace_id: effectiveTraceId,
      error_class: errorClass,
      timeout_stage: timeoutStage,
      image_bytes_len: imageBytesLen,
      request_payload_bytes_len: requestPayloadBytesLen,
      response_bytes_len: responseBytesLen,
      schema_error_summary: schemaErrorSummary,
      upstream_request_id: upstreamRequestId,
    });
  }
  if (!geminiOutput.ok) {
    logger?.warn(
      {
        trace_id: effectiveTraceId,
        provider: 'gemini_provider',
        reason: verifyFailReason || VerifyFailReason.UNKNOWN,
        final_reason: finalReason,
        raw_final_reason: rawFinalReason,
        http_status: providerStatusCode || null,
        http_status_class: statusClass,
        latency_ms: verifyLatencyMs,
        attempt: verifyAttempts,
        image_bytes_len: imageBytesLen,
        request_payload_bytes_len: requestPayloadBytesLen,
        response_bytes_len: responseBytesLen,
        schema_error_summary: schemaErrorSummary,
        upstream_request_id: upstreamRequestId,
        error_class: errorClass,
      },
      'diag verify: provider failure',
    );
  }

  const circuitUpdate = updateVerifyCircuitState({
    enabled: cfg.circuitEnabled,
    threshold: cfg.circuitConsecutiveThreshold,
    cooldownMs: cfg.circuitCooldownMs,
    verifyFailReason,
  });
  const authCircuitUpdate = updateVerifyAuthCircuitState({
    enabled: cfg.authCircuitEnabled,
    threshold: cfg.authCircuitFailRateThreshold,
    cooldownMs: cfg.authCircuitCooldownMs,
    windowMs: cfg.authCircuitWindowMs,
    minSamples: cfg.authCircuitMinSamples,
    verifyFailReason,
    providerStatusCode,
    nowMs: Date.now(),
  });
  if (circuitUpdate.openedNow) {
    logger?.warn(
      {
        trace_id: effectiveTraceId,
        reason: VERIFY_CIRCUIT_REASON,
        circuit_breaker: circuitUpdate.snapshot,
      },
      'diag verify: 5xx circuit opened',
    );
    if (metricsHooks && typeof metricsHooks.onVerifyCircuitOpen === 'function') {
      metricsHooks.onVerifyCircuitOpen({
        reason: VERIFY_CIRCUIT_REASON,
        ...circuitUpdate.snapshot,
      });
    }
  }
  if (authCircuitUpdate.openedNow) {
    logger?.warn(
      {
        trace_id: effectiveTraceId,
        reason: VERIFY_AUTH_CIRCUIT_REASON,
        auth_circuit_breaker: authCircuitUpdate.snapshot,
      },
      'diag verify: auth circuit opened',
    );
    if (metricsHooks && typeof metricsHooks.onVerifyCircuitOpen === 'function') {
      metricsHooks.onVerifyCircuitOpen({
        reason: VERIFY_AUTH_CIRCUIT_REASON,
        ...authCircuitUpdate.snapshot,
      });
    }
  }
  if (metricsHooks && typeof metricsHooks.onVerifyAgreement === 'function') metricsHooks.onVerifyAgreement(agreementScore);
  if (metricsHooks && typeof metricsHooks.onVerifyRetry === 'function') {
    metricsHooks.onVerifyRetry({ attempts: verifyAttempts });
  }
  if (hardCase && metricsHooks && typeof metricsHooks.onVerifyHardCase === 'function') metricsHooks.onVerifyHardCase();
  if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') {
    metricsHooks.onVerifyCall({
      status: geminiOutput.ok ? 'success' : 'fail',
    });
  }
  if (metricsHooks && typeof metricsHooks.onVerifyLatency === 'function') {
    metricsHooks.onVerifyLatency({
      status: geminiOutput.ok ? 'success' : 'fail',
      latencyMs: verifyLatencyMs,
    });
  }

  return {
    ok: geminiOutput.ok,
    enabled: true,
    called: true,
    decision: 'verify',
    provider_status_code: providerStatusCode,
    latency_ms: verifyLatencyMs,
    attempts: verifyAttempts,
    final_reason: finalReason,
    raw_final_reason: rawFinalReason,
    verify_fail_reason: verifyFailReason,
    skipped_reason: null,
    ...(timeoutStage ? { timeout_stage: timeoutStage } : {}),
    ...(upstreamRequestId ? { upstream_request_id: upstreamRequestId } : {}),
    circuit_breaker: circuitUpdate.snapshot,
    auth_circuit_breaker: authCircuitUpdate.snapshot,
    agreement_score: agreementScore,
    disagreement_reasons: disagreementReasons,
    verifier: verifierVerdict,
    provider_stats: providerStats,
    hard_case_written: Boolean(hardCasePath),
    hard_case_path: hardCasePath,
    persistence,
  };
}

function resetVerifyBudgetGuardState() {
  verifyBudgetState.minuteWindowMs = 0;
  verifyBudgetState.minuteCount = 0;
  verifyBudgetState.dayKey = '';
  verifyBudgetState.dayCount = 0;
  resetVerifyCircuitState();
  verifyAuthCircuitState.windowStartMs = 0;
  verifyAuthCircuitState.totalAttempts = 0;
  verifyAuthCircuitState.authFailures = 0;
  verifyAuthCircuitState.openUntilMs = 0;
  verifyAuthCircuitState.lastOpenedAtMs = 0;
  verifyInflightState.count = 0;
}

module.exports = {
  VERIFY_SCHEMA_VERSION,
  HARD_CASE_SCHEMA_VERSION,
  VERIFY_GUARD_REASON,
  VERIFY_CIRCUIT_REASON,
  VERIFY_AUTH_CIRCUIT_REASON,
  VERIFY_INFLIGHT_GUARD_REASON,
  VERIFY_SAMPLE_SKIP_REASON,
  VerifyFailReason,
  normalizeVerifyFailReason,
  runGeminiShadowVerify,
  buildIssueComparisons,
  computeAgreementScore,
  collectDisagreementReasons,
  qualityAllowsVerify,
  stableShadowSampling,
  resetVerifyBudgetGuardState,
  shouldUseVerifierInVote,
  should_use_verifier_in_vote,
};

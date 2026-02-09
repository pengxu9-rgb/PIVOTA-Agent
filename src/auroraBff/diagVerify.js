const fs = require('node:fs/promises');
const path = require('node:path');
const { runCvProvider, runGeminiProvider, iou } = require('./diagEnsemble');
const { persistPseudoLabelArtifacts } = require('./pseudoLabelFactory');
const { shouldUseVerifierInVote, should_use_verifier_in_vote } = require('./diagReliability');

const VERIFY_SCHEMA_VERSION = 'aurora.diag.verify_shadow.v1';
const HARD_CASE_SCHEMA_VERSION = 'aurora.diag.verify_hard_case.v1';
const VERIFY_GUARD_REASON = 'VERIFY_BUDGET_GUARD';
const VerifyFailReason = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  UPSTREAM_4XX: 'UPSTREAM_4XX',
  UPSTREAM_5XX: 'UPSTREAM_5XX',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  IMAGE_FETCH_FAILED: 'IMAGE_FETCH_FAILED',
  UNKNOWN: 'UNKNOWN',
});
const verifyBudgetState = {
  minuteWindowMs: 0,
  minuteCount: 0,
  dayKey: '',
  dayCount: 0,
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

function round3(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Number(Number(value).toFixed(3));
}

function clamp01(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(1, Number(value)));
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
    attempts,
    final_reason: finalReason,
    concern_count: concerns.length,
    ...(output?.failure_reason ? { failure_reason: String(output.failure_reason) } : {}),
    ...(output?.verify_fail_reason ? { verify_fail_reason: String(output.verify_fail_reason) } : {}),
    ...(output?.schema_failed ? { schema_failed: true } : {}),
  };
}

function normalizeVerifyFailReason({ reason, providerStatusCode } = {}) {
  const statusCode = Number.isFinite(Number(providerStatusCode)) ? Math.trunc(Number(providerStatusCode)) : 0;
  const token = String(reason || '')
    .trim()
    .toUpperCase();

  if (!token) {
    if (statusCode === 429) return VerifyFailReason.RATE_LIMIT;
    if (statusCode >= 500) return VerifyFailReason.UPSTREAM_5XX;
    if (statusCode >= 400) return VerifyFailReason.UPSTREAM_4XX;
    return VerifyFailReason.UNKNOWN;
  }

  if (token === VerifyFailReason.TIMEOUT || token.includes('TIMEOUT') || token === 'ETIMEDOUT') {
    return VerifyFailReason.TIMEOUT;
  }
  if (token === VerifyFailReason.RATE_LIMIT || token.includes('RATE_LIMIT') || statusCode === 429) {
    return VerifyFailReason.RATE_LIMIT;
  }
  if (token === VerifyFailReason.QUOTA || token.includes('QUOTA') || token.includes('INSUFFICIENT_QUOTA')) {
    return VerifyFailReason.QUOTA;
  }
  if (token === VerifyFailReason.SCHEMA_INVALID || token.includes('SCHEMA_INVALID') || token.includes('CANONICAL_SCHEMA_INVALID')) {
    return VerifyFailReason.SCHEMA_INVALID;
  }
  if (
    token === VerifyFailReason.IMAGE_FETCH_FAILED ||
    token.includes('MISSING_IMAGE') ||
    token.includes('IMAGE_FETCH') ||
    token.includes('PHOTO_DOWNLOAD')
  ) {
    return VerifyFailReason.IMAGE_FETCH_FAILED;
  }
  if (token === VerifyFailReason.UPSTREAM_5XX || token.includes('UPSTREAM_5XX') || statusCode >= 500) {
    return VerifyFailReason.UPSTREAM_5XX;
  }
  if (token === VerifyFailReason.UPSTREAM_4XX || token.includes('UPSTREAM_4XX') || statusCode >= 400) {
    return VerifyFailReason.UPSTREAM_4XX;
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
  return {
    enabled: boolEnv('DIAG_GEMINI_VERIFY', false),
    iouThreshold: numEnv('DIAG_GEMINI_VERIFY_IOU_THRESHOLD', 0.3, 0.05, 0.95),
    timeoutMs: numEnv('DIAG_VERIFY_TIMEOUT_MS', numEnv('DIAG_GEMINI_VERIFY_TIMEOUT_MS', 12000, 1000, 45000), 1000, 45000),
    retries: Math.trunc(numEnv('DIAG_GEMINI_VERIFY_RETRIES', 1, 0, 3)),
    hardCaseThreshold: numEnv('DIAG_GEMINI_VERIFY_HARD_CASE_THRESHOLD', 0.55, 0, 1),
    maxCallsPerMin: Math.max(0, Math.trunc(numEnv('DIAG_VERIFY_MAX_CALLS_PER_MIN', 60, 0, 1000000))),
    maxCallsPerDay: Math.max(0, Math.trunc(numEnv('DIAG_VERIFY_MAX_CALLS_PER_DAY', 10000, 0, 100000000))),
    model: String(process.env.DIAG_GEMINI_VERIFY_MODEL || process.env.DIAG_ENSEMBLE_GEMINI_MODEL || 'gemini-2.0-flash').trim() || 'gemini-2.0-flash',
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
  skinToneBucket,
  lightingBucket,
  logger,
  providerOverrides,
  metricsHooks,
} = {}) {
  const cfg = getVerifierConfig();
  const qualityGrade = normalizeQualityGrade(photoQuality?.grade || diagnosisV1?.quality?.grade || 'unknown');

  if (!cfg.enabled) {
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

  const budget = reserveVerifyBudget({
    maxCallsPerMin: cfg.maxCallsPerMin,
    maxCallsPerDay: cfg.maxCallsPerDay,
    nowMs: Date.now(),
  });
  if (!budget.allowed) {
    if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'guard' });
    if (metricsHooks && typeof metricsHooks.onVerifyBudgetGuard === 'function') {
      metricsHooks.onVerifyBudgetGuard({
        reason: VERIFY_GUARD_REASON,
        ...budget.usage,
      });
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

  const runCv = providerOverrides && typeof providerOverrides.cvProvider === 'function' ? providerOverrides.cvProvider : runCvProvider;
  const runGemini =
    providerOverrides && typeof providerOverrides.geminiProvider === 'function' ? providerOverrides.geminiProvider : runGeminiProvider;

  if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') metricsHooks.onVerifyCall({ status: 'attempt' });

  const cvOutput = await runCv({
    diagnosisV1,
    diagnosisInternal,
    photoQuality,
    language,
  });

  const geminiOutput = await runGemini({
    imageBuffer,
    language,
    profileSummary,
    recentLogsSummary,
    photoQuality,
    retries: cfg.retries,
    timeoutMs: cfg.timeoutMs,
    model: cfg.model,
  });

  const verifyLatencyMs = round3(Math.max(0, Number(geminiOutput?.latency_ms || 0)));
  const verifyAttempts = Math.max(1, toInt(geminiOutput?.attempts, cfg.retries + 1));
  const providerStatusCode = toInt(geminiOutput?.provider_status_code, geminiOutput?.ok ? 200 : 0);
  const rawFinalReason = geminiOutput?.ok ? 'OK' : String(geminiOutput?.failure_reason || VerifyFailReason.UNKNOWN);
  const verifyFailReason = geminiOutput?.ok
    ? null
    : normalizeVerifyFailReason({ reason: rawFinalReason, providerStatusCode });
  const finalReason = geminiOutput?.ok ? 'OK' : verifyFailReason || VerifyFailReason.UNKNOWN;
  const geminiOutputForStore = {
    ...geminiOutput,
    final_reason: finalReason,
    raw_final_reason: rawFinalReason,
    verify_fail_reason: verifyFailReason,
    decision: 'verify',
    attempts: verifyAttempts,
    provider_status_code: providerStatusCode,
    latency_ms: verifyLatencyMs,
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
      hardCasePath = await appendHardCaseRecord({
        schema_version: HARD_CASE_SCHEMA_VERSION,
        created_at: new Date().toISOString(),
        inference_id: String(inferenceId || '').trim() || null,
        quality_grade: qualityGrade,
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
    });
  }
  if (metricsHooks && typeof metricsHooks.onVerifyAgreement === 'function') metricsHooks.onVerifyAgreement(agreementScore);
  if (hardCase && metricsHooks && typeof metricsHooks.onVerifyHardCase === 'function') metricsHooks.onVerifyHardCase();
  if (metricsHooks && typeof metricsHooks.onVerifyCall === 'function') {
    metricsHooks.onVerifyCall({
      status: geminiOutput.ok ? 'ok' : 'fail',
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
}

module.exports = {
  VERIFY_SCHEMA_VERSION,
  HARD_CASE_SCHEMA_VERSION,
  VERIFY_GUARD_REASON,
  VerifyFailReason,
  normalizeVerifyFailReason,
  runGeminiShadowVerify,
  buildIssueComparisons,
  computeAgreementScore,
  collectDisagreementReasons,
  qualityAllowsVerify,
  resetVerifyBudgetGuardState,
  shouldUseVerifierInVote,
  should_use_verifier_in_vote,
};

const fs = require('node:fs/promises');
const path = require('node:path');
const { runCvProvider, runGeminiProvider, iou } = require('./diagEnsemble');
const { persistPseudoLabelArtifacts } = require('./pseudoLabelFactory');

const VERIFY_SCHEMA_VERSION = 'aurora.diag.verify_shadow.v1';
const HARD_CASE_SCHEMA_VERSION = 'aurora.diag.verify_hard_case.v1';

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
  return {
    provider: String(output?.provider || 'unknown'),
    ok: Boolean(output?.ok),
    latency_ms: round3(Math.max(0, Number(output?.latency_ms || 0))),
    concern_count: concerns.length,
    ...(output?.failure_reason ? { failure_reason: String(output.failure_reason) } : {}),
    ...(output?.schema_failed ? { schema_failed: true } : {}),
  };
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
    timeoutMs: numEnv('DIAG_GEMINI_VERIFY_TIMEOUT_MS', 12000, 1000, 45000),
    retries: Math.trunc(numEnv('DIAG_GEMINI_VERIFY_RETRIES', 1, 0, 3)),
    hardCaseThreshold: numEnv('DIAG_GEMINI_VERIFY_HARD_CASE_THRESHOLD', 0.55, 0, 1),
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
      skipped_reason: 'DISABLED_BY_FLAG',
    };
  }

  if (!usedPhotos) {
    return {
      ok: false,
      enabled: true,
      called: false,
      skipped_reason: 'PHOTO_NOT_USED',
    };
  }

  if (!qualityAllowsVerify(qualityGrade)) {
    return {
      ok: false,
      enabled: true,
      called: false,
      skipped_reason: `QUALITY_${qualityGrade.toUpperCase()}`,
    };
  }

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    return {
      ok: false,
      enabled: true,
      called: false,
      skipped_reason: 'MISSING_IMAGE_BUFFER',
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

  const providerStats = [buildProviderStat(cvOutput), buildProviderStat(geminiOutput)];
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
      providerOutputs: [cvOutput, geminiOutput],
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
      reason: geminiOutput.failure_reason || 'UNKNOWN',
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

module.exports = {
  VERIFY_SCHEMA_VERSION,
  HARD_CASE_SCHEMA_VERSION,
  runGeminiShadowVerify,
  buildIssueComparisons,
  computeAgreementScore,
  collectDisagreementReasons,
  qualityAllowsVerify,
};

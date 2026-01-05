const fs = require('fs');

const { extractLookSpec } = require('../layer2/extractLookSpec');
const { generateAdjustments } = require('../layer2/personalization/generateAdjustments');
const { generateSteps } = require('../layer2/personalization/generateSteps');
const { buildKitPlan } = require('../layer3/buildKitPlan');
const { LookReplicateResultV0Schema } = require('../schemas/lookReplicateResultV0');
const { buildAdjustmentCandidates } = require('./buildAdjustmentCandidates');

const { Layer1BundleV0Schema } = require('../layer1/schemas/layer1BundleV0');
const { extractSelfieLookSpecGemini } = require('../layer1/selfie/extractSelfieLookSpecGemini');
const { extractReferenceLookSpecGemini } = require('../layer1/reference/extractReferenceLookSpecGemini');
const { buildContextFingerprintUS } = require('../telemetry/contextFingerprintUS');
const { buildContextFingerprintJP } = require('../telemetry/contextFingerprintJP');
const { normalizeMarket } = require('../markets/market');
const { getMarketPack } = require('../markets/getMarketPack');
const { deriveOnboardingSignalsV0, normalizeOnboardingProfileV0 } = require('./onboardingProfileV0');

function engineVersionFor(market) {
  const m = String(market || 'US').toLowerCase();
  return {
    layer2: `l2-${m}-0.1.0`,
    layer3: `l3-${m}-0.1.0`,
    orchestrator: `orchestrator-${m}-0.1.0`,
  };
}

function parseOptionalJsonField(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  return JSON.parse(s);
}

function normalizeLocale(v) {
  const s = String(v || 'en').trim();
  return s || 'en';
}

function normalizePreferenceMode(v) {
  const s = String(v || 'structure').trim().toLowerCase();
  if (s === 'vibe' || s === 'ease' || s === 'structure') return s;
  return 'structure';
}

function parseEnvBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(s);
}

function normalizeLookToken(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s || 'unknown';
}

function computeLookDiffField({ user, target }) {
  const u = normalizeLookToken(user);
  const t = normalizeLookToken(target);
  const needsChange = u !== 'unknown' && t !== 'unknown' && u !== t;
  return { user: u, target: t, needsChange };
}

function computeIntentDiffField({ user, target }) {
  const u = normalizeLookToken(user);
  const t = normalizeLookToken(target);
  const needsChange = t !== 'unknown' && u !== t;
  return { user: u, target: t, needsChange };
}

function mergeLookDiffIntoSimilarityReport({ similarityReport, targetLookSpec, userLookSpec }) {
  if (!similarityReport) return null;
  if (!targetLookSpec || !userLookSpec) return similarityReport;

  const lookDiff = {
    ...(similarityReport.lookDiff || {}),
    prep: {
      ...(similarityReport.lookDiff?.prep || {}),
      intent: computeIntentDiffField({
        user: userLookSpec?.breakdown?.prep?.intent,
        target: targetLookSpec?.breakdown?.prep?.intent,
      }),
    },
    base: {
      ...(similarityReport.lookDiff?.base || {}),
      finish: computeLookDiffField({
        user: userLookSpec?.breakdown?.base?.finish,
        target: targetLookSpec?.breakdown?.base?.finish,
      }),
      coverage: computeLookDiffField({
        user: userLookSpec?.breakdown?.base?.coverage,
        target: targetLookSpec?.breakdown?.base?.coverage,
      }),
    },
    contour: {
      ...(similarityReport.lookDiff?.contour || {}),
      intent: computeIntentDiffField({
        user: userLookSpec?.breakdown?.contour?.intent,
        target: targetLookSpec?.breakdown?.contour?.intent,
      }),
    },
    brow: {
      ...(similarityReport.lookDiff?.brow || {}),
      intent: computeIntentDiffField({
        user: userLookSpec?.breakdown?.brow?.intent,
        target: targetLookSpec?.breakdown?.brow?.intent,
      }),
    },
    blush: {
      ...(similarityReport.lookDiff?.blush || {}),
      intent: computeIntentDiffField({
        user: userLookSpec?.breakdown?.blush?.intent,
        target: targetLookSpec?.breakdown?.blush?.intent,
      }),
    },
    lip: {
      ...(similarityReport.lookDiff?.lip || {}),
      finish: computeLookDiffField({
        user: userLookSpec?.breakdown?.lip?.finish,
        target: targetLookSpec?.breakdown?.lip?.finish,
      }),
    },
  };

  return { ...similarityReport, lookDiff };
}

function hasAnyLookDiffNeedsChange(similarityReport) {
  const ld = similarityReport?.lookDiff;
  const candidates = [
    ld?.eye?.linerDirection?.needsChange,
    ld?.prep?.intent?.needsChange,
    ld?.base?.finish?.needsChange,
    ld?.base?.coverage?.needsChange,
    ld?.contour?.intent?.needsChange,
    ld?.brow?.intent?.needsChange,
    ld?.blush?.intent?.needsChange,
    ld?.lip?.finish?.needsChange,
  ];
  return candidates.some((v) => typeof v === 'boolean');
}

function toResultAdjustments(layer2Adjustments) {
  return layer2Adjustments.map((a) => ({
    impactArea: a.impactArea,
    title: a.title,
    because: a.because,
    do: a.do,
    why: a.why || a.because,
    evidence: Array.isArray(a.evidence) ? a.evidence : [],
    confidence: a.confidence,
  }));
}

function uniquePairs(items) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const id = String(it?.id || '').trim();
    const area = String(it?.area || '').trim();
    if (!id || !area) continue;
    const key = `${area}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, area });
  }
  return out;
}

function extractUsedTechniques(adjustments) {
  const refs = [];
  for (const a of Array.isArray(adjustments) ? adjustments : []) {
    if (Array.isArray(a.techniqueRefs)) refs.push(...a.techniqueRefs);
  }
  return uniquePairs(refs);
}

function extractUsedRules(adjustments) {
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(adjustments) ? adjustments : []) {
    const ruleId = String(a.ruleId || '').trim();
    const area = String(a.impactArea || '').trim();
    if (!ruleId || !area) continue;
    const key = `${area}:${ruleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ruleId, area });
  }
  return out;
}

function extractUsedTechniquesForTelemetry(adjustments) {
  const allowedAreas = new Set(['base', 'eye', 'lip']);
  return extractUsedTechniques(adjustments).filter((t) => allowedAreas.has(String(t.area || '')));
}

function extractUsedRulesForTelemetry(adjustments) {
  const allowedAreas = new Set(['base', 'eye', 'lip']);
  return extractUsedRules(adjustments).filter((r) => allowedAreas.has(String(r.area || '')));
}

function computeQualityFlags({ lookSpec, layer2Adjustments, usedFallback }) {
  const lookSpecLowConfidence = Boolean(Array.isArray(lookSpec?.warnings) && lookSpec.warnings.length > 0);
  const anyAdjustmentLowConfidence = Boolean(
    Array.isArray(layer2Adjustments) && layer2Adjustments.some((a) => a?.confidence === 'low'),
  );
  const anyFallbackUsed = Boolean(usedFallback);
  return { lookSpecLowConfidence, anyAdjustmentLowConfidence, anyFallbackUsed };
}

async function runLookReplicatePipeline(input) {
  const reportProgress = async (progress, step) => {
    if (typeof input?.onProgress !== 'function') return;
    try {
      await input.onProgress({ progress, step });
    } catch {
      // ignore
    }
  };

  const locale = normalizeLocale(input.locale);
  const preferenceMode = normalizePreferenceMode(input.preferenceMode);
  const market = normalizeMarket(input.market, normalizeMarket(process.env.DEFAULT_MARKET, 'US'));
  const pack = getMarketPack({ market, locale });

  const layer1Bundle = input.layer1Bundle ?? null;
  const layer1 = layer1Bundle ? Layer1BundleV0Schema.parse(layer1Bundle) : null;

  const userFaceProfile = layer1?.userFaceProfile ?? null;
  const refFaceProfile = layer1?.refFaceProfile ?? null;
  const similarityReport = layer1?.similarityReport ?? null;

  const promptPack = pack.getPromptPack(locale);
  const referenceBytes = fs.readFileSync(input.referenceImage.path);
  const versions = engineVersionFor(pack.market);
  const onboardingProfileV0 = input.onboardingProfileV0 ? normalizeOnboardingProfileV0(input.onboardingProfileV0) : null;
  const onboardingSignals = onboardingProfileV0 ? deriveOnboardingSignalsV0(onboardingProfileV0) : null;

  await reportProgress(20, 'lookspec');

  const geminiReferenceLookSpecEnabled = parseEnvBool(process.env.LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC);
  const geminiDebugEnabled = parseEnvBool(process.env.GEMINI_DEBUG) || parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);
  const debugGemini = (msg) => {
    if (!geminiDebugEnabled) return;
    // eslint-disable-next-line no-console
    console.log(`[gemini_reference] ${msg}`);
  };

  const geminiTelemetry = {
    limiter: { concurrencyMax: 2, ratePerMin: 60, circuitOpen: false },
    reference: { enabled: false, attempted: false, ok: null, errorCode: null, latencyMs: null, retries: null, model: null },
    selfie: { enabled: false, attempted: false, ok: null, errorCode: null, latencyMs: null, retries: null, model: null },
    lookDiffSource: null,
    lookDiff: null,
  };

  let lookSpec = null;
  if (geminiReferenceLookSpecEnabled && input.referenceImage?.path) {
    geminiTelemetry.reference.enabled = true;
    const t0 = Date.now();
    const geminiOut = await extractReferenceLookSpecGemini({
      market: pack.market,
      locale,
      imagePath: input.referenceImage.path,
      promptText: promptPack?.lookSpecExtract,
    });
    geminiTelemetry.reference.latencyMs = (geminiOut?.meta?.latencyMs ?? null) ?? Date.now() - t0;
    geminiTelemetry.reference.model = geminiOut?.meta?.model ?? null;
    geminiTelemetry.reference.retries = typeof geminiOut?.meta?.retries === 'number' ? geminiOut.meta.retries : null;
    geminiTelemetry.reference.attempted = Boolean(geminiOut?.meta?.attempted);

    if (geminiOut?.ok) {
      lookSpec = geminiOut.value;
      geminiTelemetry.reference.ok = true;
      geminiTelemetry.reference.attempted = true;
      debugGemini('using gemini reference lookSpec');
    } else if (geminiOut) {
      geminiTelemetry.reference.ok = false;
      geminiTelemetry.reference.errorCode = String(geminiOut?.error?.code || 'UNKNOWN');
      debugGemini(`gemini reference lookspec failed (fallback to extractLookSpec): ${String(geminiOut?.error?.code || 'UNKNOWN')}`);
    }

    if (geminiOut?.meta?.limiter) geminiTelemetry.limiter = geminiOut.meta.limiter;
  }

  if (!lookSpec) {
    lookSpec = await extractLookSpec({
      market: pack.market,
      locale,
      referenceImage: { kind: 'bytes', bytes: referenceBytes, contentType: input.referenceImage.contentType },
      imageKind: 'reference',
      promptPack,
    });
  }

  await reportProgress(35, 'adjustments');

  const selfieLookSpecEnabled = input.enableSelfieLookSpec === true || parseEnvBool(process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC);
  const geminiSelfieLookSpecEnabled = parseEnvBool(process.env.LAYER1_ENABLE_GEMINI_SELFIE_LOOKSPEC);
  const selfieImage = input.selfieImage ?? null;
  const selfieBytes = selfieLookSpecEnabled && selfieImage?.path ? fs.readFileSync(selfieImage.path) : null;

  const selfieLookSpecFromLayer1 = similarityReport?.selfieAnalysis?.selfieLookSpec ?? null;
  const lookDiffFromLayer1 = hasAnyLookDiffNeedsChange(similarityReport) ? similarityReport?.lookDiff ?? null : null;

  const selfieDebugEnabled = parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);
  const debugSelfie = (msg) => {
    if (!selfieDebugEnabled) return;
    // eslint-disable-next-line no-console
    console.log(`[selfie_contract] ${msg}`);
  };

  let userLookSpec = null;
  let similarityReportWithLookDiff = similarityReport;
  let lookDiffSource = null;

  if (selfieLookSpecEnabled && (lookDiffFromLayer1 || selfieLookSpecFromLayer1)) {
    lookDiffSource = 'layer1';
    userLookSpec = selfieLookSpecFromLayer1;
    similarityReportWithLookDiff = lookDiffFromLayer1
      ? similarityReport
      : mergeLookDiffIntoSimilarityReport({ similarityReport, targetLookSpec: lookSpec, userLookSpec });
    debugSelfie(`using layer1 contract (hasLookDiff=${Boolean(lookDiffFromLayer1)} hasSelfieLookSpec=${Boolean(selfieLookSpecFromLayer1)})`);
  } else if (selfieLookSpecEnabled && geminiSelfieLookSpecEnabled && selfieImage?.path) {
    geminiTelemetry.selfie.enabled = true;
    const t0 = Date.now();
    const geminiOut = await extractSelfieLookSpecGemini({
      market: pack.market,
      locale,
      imagePath: selfieImage.path,
      promptText: promptPack?.lookSpecExtract,
    });
    geminiTelemetry.selfie.latencyMs = (geminiOut?.meta?.latencyMs ?? null) ?? Date.now() - t0;
    geminiTelemetry.selfie.model = geminiOut?.meta?.model ?? null;
    geminiTelemetry.selfie.retries = typeof geminiOut?.meta?.retries === 'number' ? geminiOut.meta.retries : null;
    geminiTelemetry.selfie.attempted = Boolean(geminiOut?.meta?.attempted);

    if (geminiOut?.ok) {
      lookDiffSource = 'gemini';
      userLookSpec = geminiOut.value;
      similarityReportWithLookDiff = mergeLookDiffIntoSimilarityReport({
        similarityReport,
        targetLookSpec: lookSpec,
        userLookSpec,
      });
      geminiTelemetry.selfie.ok = true;
      geminiTelemetry.selfie.attempted = true;
      debugSelfie('computed lookDiff via gemini');
    } else {
      geminiTelemetry.selfie.ok = false;
      geminiTelemetry.selfie.errorCode = String(geminiOut?.error?.code || 'UNKNOWN');
      debugSelfie(`gemini selfie lookspec failed (fail-closed): ${String(geminiOut?.error?.code || 'UNKNOWN')}`);
    }

    if (geminiOut?.meta?.limiter) geminiTelemetry.limiter = geminiOut.meta.limiter;
  } else if (selfieLookSpecEnabled && selfieBytes) {
    lookDiffSource = 'pipeline_fallback';
    userLookSpec = await extractLookSpec({
      market: pack.market,
      locale,
      referenceImage: { kind: 'bytes', bytes: selfieBytes, contentType: selfieImage.contentType || 'image/jpeg' },
      imageKind: 'selfie',
      promptPack: pack.getPromptPack(locale),
    });
    similarityReportWithLookDiff = mergeLookDiffIntoSimilarityReport({
      similarityReport,
      targetLookSpec: lookSpec,
      userLookSpec,
    });
    debugSelfie(`computed lookDiff via pipeline_fallback (selfieImageProvided=${Boolean(selfieImage?.path)})`);
  }

  if (selfieLookSpecEnabled && similarityReportWithLookDiff && lookDiffSource) {
    similarityReportWithLookDiff = {
      ...similarityReportWithLookDiff,
      selfieAnalysis: {
        ...(similarityReportWithLookDiff.selfieAnalysis || {}),
        ...(userLookSpec ? { selfieLookSpec: userLookSpec } : {}),
        lookDiffSource,
      },
    };
  }

  geminiTelemetry.lookDiffSource = lookDiffSource;
  geminiTelemetry.lookDiff = similarityReportWithLookDiff?.lookDiff ?? null;

  const adjOut = await generateAdjustments({
    market: pack.market,
    locale,
    userFaceProfile,
    refFaceProfile,
    similarityReport: similarityReportWithLookDiff,
    lookSpec,
    preferenceMode,
    promptPack,
    ...(onboardingProfileV0 ? { userProfile: onboardingProfileV0, userSignals: onboardingSignals } : {}),
    ...(input.enableExtendedAreas === true ? { enableExtendedAreas: true } : {}),
    ...(input.enableSelfieLookSpec === true ? { enableSelfieLookSpec: true } : {}),
    ...(input.enableExtendedAreas === true ? { enableTriggerMatching: true } : {}),
  });

  await reportProgress(55, 'steps');

  const stepsOut = await generateSteps({
    market: pack.market,
    locale,
    lookSpec,
    adjustments: adjOut.adjustments,
    userFaceProfile,
    promptPack,
  });

  await reportProgress(75, 'kit');

  const kitPlan = await buildKitPlan({
    market: pack.market,
    locale,
    lookSpec,
    commerceEnabled: pack.commerceEnabled,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(onboardingProfileV0 ? { userProfile: onboardingProfileV0, userSignals: onboardingSignals } : {}),
  });

  await reportProgress(90, 'finalizing');

  const warnings = [
    ...(Array.isArray(lookSpec.warnings) ? lookSpec.warnings : []),
    ...(Array.isArray(adjOut.warnings) ? adjOut.warnings : []),
    ...(Array.isArray(stepsOut.warnings) ? stepsOut.warnings : []),
    ...(Array.isArray(kitPlan.warnings) ? kitPlan.warnings : []),
  ].filter(Boolean);

  const candidateOut = buildAdjustmentCandidates({ layer2Adjustments: adjOut.adjustments });
  const includeTechniqueRefs =
    parseEnvBool(process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT) ||
    parseEnvBool(process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT) ||
    parseEnvBool(process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT) ||
    parseEnvBool(process.env.LAYER2_ENABLE_EXTENDED_AREAS) ||
    input.enableExtendedAreas === true;

  const result = LookReplicateResultV0Schema.parse({
    schemaVersion: 'v0',
    market: pack.market,
    locale,
    ...(candidateOut.adjustmentCandidates ? { exposureId: candidateOut.exposureId } : {}),
    layer2EngineVersion: versions.layer2,
    layer3EngineVersion: versions.layer3,
    orchestratorVersion: versions.orchestrator,
    commerceEnabled: pack.commerceEnabled,
    breakdown: lookSpec.breakdown,
    adjustments: toResultAdjustments(adjOut.adjustments),
    steps: stepsOut.steps,
    kit: kitPlan,
    ...(includeTechniqueRefs ? { techniqueRefs: extractUsedTechniques(adjOut.skeletons) } : {}),
    ...(candidateOut.adjustmentCandidates ? { adjustmentCandidates: candidateOut.adjustmentCandidates } : {}),
    ...(candidateOut.experiment ? { experiment: candidateOut.experiment } : {}),
    ...(candidateOut.experiments ? { experiments: candidateOut.experiments } : {}),
    ...(warnings.length ? { warnings } : {}),
  });

  const includeGeminiTelemetry =
    geminiReferenceLookSpecEnabled ||
    geminiSelfieLookSpecEnabled ||
    geminiDebugEnabled ||
    selfieDebugEnabled ||
    Boolean(lookDiffSource) ||
    Boolean(geminiTelemetry.lookDiff);

  const telemetrySample = input.jobId
    ? {
        jobId: input.jobId,
        market: pack.market,
        locale,
        preferenceMode,
        createdAt: new Date().toISOString(),
        engineVersions: {
          layer2: result.layer2EngineVersion,
          layer3: result.layer3EngineVersion,
        },
        signals: {
          ...(onboardingSignals ? { onboarding: onboardingSignals } : {}),
        },
        qualityFlags: computeQualityFlags({
          lookSpec,
          layer2Adjustments: adjOut.adjustments,
          usedFallback: Boolean(adjOut.usedFallback),
        }),
        usedTechniques: extractUsedTechniquesForTelemetry(adjOut.skeletons),
        usedRules: extractUsedRulesForTelemetry(adjOut.skeletons),
        contextFingerprint:
          pack.market === 'US'
            ? buildContextFingerprintUS({ userFaceProfile, refFaceProfile, lookSpec })
            : buildContextFingerprintJP({ userFaceProfile, refFaceProfile, lookSpec }),
	        replayContext: adjOut.skeletons ? { adjustmentSkeletons: adjOut.skeletons } : undefined,
          ...(includeGeminiTelemetry ? { gemini: geminiTelemetry } : {}),
      }
    : null;

  if (telemetrySample && geminiDebugEnabled) {
    // eslint-disable-next-line no-console
    console.log(
      `[gemini] limiter={concurrencyMax:${geminiTelemetry.limiter.concurrencyMax},ratePerMin:${geminiTelemetry.limiter.ratePerMin},circuitOpen:${geminiTelemetry.limiter.circuitOpen}} reference={enabled:${geminiTelemetry.reference.enabled},attempted:${geminiTelemetry.reference.attempted},ok:${geminiTelemetry.reference.ok},code:${geminiTelemetry.reference.errorCode ?? 'null'},ms:${geminiTelemetry.reference.latencyMs ?? 'null'},retries:${geminiTelemetry.reference.retries ?? 'null'}} selfie={enabled:${geminiTelemetry.selfie.enabled},attempted:${geminiTelemetry.selfie.attempted},ok:${geminiTelemetry.selfie.ok},code:${geminiTelemetry.selfie.errorCode ?? 'null'},ms:${geminiTelemetry.selfie.latencyMs ?? 'null'},retries:${geminiTelemetry.selfie.retries ?? 'null'}} lookDiffSource=${geminiTelemetry.lookDiffSource ?? 'null'}`,
    );
  }

  return { result, locale, preferenceMode, telemetrySample };
}

module.exports = {
  runLookReplicatePipeline,
  parseOptionalJsonField,
  normalizeLocale,
  normalizePreferenceMode,
};

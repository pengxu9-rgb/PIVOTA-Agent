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

function computeQualityFlags({ lookSpec, layer2Adjustments, usedFallback }) {
  const lookSpecLowConfidence = Boolean(Array.isArray(lookSpec?.warnings) && lookSpec.warnings.length > 0);
  const anyAdjustmentLowConfidence = Boolean(
    Array.isArray(layer2Adjustments) && layer2Adjustments.some((a) => a?.confidence === 'low'),
  );
  const anyFallbackUsed = Boolean(usedFallback);
  return { lookSpecLowConfidence, anyAdjustmentLowConfidence, anyFallbackUsed };
}

async function runLookReplicatePipeline(input) {
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

  const geminiReferenceLookSpecEnabled = parseEnvBool(process.env.LAYER1_ENABLE_GEMINI_REFERENCE_LOOKSPEC);
  const geminiDebugEnabled = parseEnvBool(process.env.GEMINI_DEBUG) || parseEnvBool(process.env.LAYER1_SELFIE_DEBUG);
  const debugGemini = (msg) => {
    if (!geminiDebugEnabled) return;
    // eslint-disable-next-line no-console
    console.log(`[gemini_reference] ${msg}`);
  };

  const geminiTelemetry = {
    reference: { okCount: 0, failCount: 0, lastErrorCode: null, latencyMs: null },
    selfie: { okCount: 0, failCount: 0, lastErrorCode: null, latencyMs: null },
    lookDiffSource: null,
  };

  let lookSpec = null;
  if (geminiReferenceLookSpecEnabled && input.referenceImage?.path) {
    const t0 = Date.now();
    const geminiOut = await extractReferenceLookSpecGemini({
      market: pack.market,
      locale,
      imagePath: input.referenceImage.path,
      promptText: promptPack?.lookSpecExtract,
    });
    geminiTelemetry.reference.latencyMs = Date.now() - t0;

    if (geminiOut?.ok) {
      lookSpec = geminiOut.value;
      geminiTelemetry.reference.okCount = 1;
      debugGemini('using gemini reference lookSpec');
    } else if (geminiOut) {
      geminiTelemetry.reference.failCount = 1;
      geminiTelemetry.reference.lastErrorCode = String(geminiOut?.error?.code || 'UNKNOWN');
      debugGemini(`gemini reference lookspec failed (fallback to extractLookSpec): ${String(geminiOut?.error?.code || 'UNKNOWN')}`);
    }
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

  const selfieLookSpecEnabled = parseEnvBool(process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC);
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
    const t0 = Date.now();
    const geminiOut = await extractSelfieLookSpecGemini({
      market: pack.market,
      locale,
      imagePath: selfieImage.path,
      promptText: promptPack?.lookSpecExtract,
    });
    geminiTelemetry.selfie.latencyMs = Date.now() - t0;

    if (geminiOut?.ok) {
      lookDiffSource = 'gemini';
      userLookSpec = geminiOut.value;
      similarityReportWithLookDiff = mergeLookDiffIntoSimilarityReport({
        similarityReport,
        targetLookSpec: lookSpec,
        userLookSpec,
      });
      geminiTelemetry.selfie.okCount = 1;
      debugSelfie('computed lookDiff via gemini');
    } else {
      geminiTelemetry.selfie.failCount = 1;
      geminiTelemetry.selfie.lastErrorCode = String(geminiOut?.error?.code || 'UNKNOWN');
      debugSelfie(`gemini selfie lookspec failed (fail-closed): ${String(geminiOut?.error?.code || 'UNKNOWN')}`);
    }
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

  const adjOut = await generateAdjustments({
    market: pack.market,
    locale,
    userFaceProfile,
    refFaceProfile,
    similarityReport: similarityReportWithLookDiff,
    lookSpec,
    preferenceMode,
    promptPack,
  });

  const stepsOut = await generateSteps({
    market: pack.market,
    locale,
    lookSpec,
    adjustments: adjOut.adjustments,
    userFaceProfile,
    promptPack,
  });

  const kitPlan = await buildKitPlan({ market: pack.market, locale, lookSpec, commerceEnabled: pack.commerceEnabled });

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
    parseEnvBool(process.env.LAYER2_ENABLE_EXTENDED_AREAS);

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
        signals: {},
        qualityFlags: computeQualityFlags({
          lookSpec,
          layer2Adjustments: adjOut.adjustments,
          usedFallback: Boolean(adjOut.usedFallback),
        }),
        usedTechniques: extractUsedTechniques(adjOut.skeletons),
        usedRules: extractUsedRules(adjOut.skeletons),
        contextFingerprint:
          pack.market === 'US'
            ? buildContextFingerprintUS({ userFaceProfile, refFaceProfile, lookSpec })
            : buildContextFingerprintJP({ userFaceProfile, refFaceProfile, lookSpec }),
	        replayContext: adjOut.skeletons ? { adjustmentSkeletons: adjOut.skeletons } : undefined,
          gemini: geminiTelemetry,
	      }
	    : null;

  if (telemetrySample && geminiDebugEnabled) {
    // eslint-disable-next-line no-console
    console.log(
      `[gemini] reference_ok=${geminiTelemetry.reference.okCount} reference_fail=${geminiTelemetry.reference.failCount} reference_ms=${geminiTelemetry.reference.latencyMs ?? 'null'} selfie_ok=${geminiTelemetry.selfie.okCount} selfie_fail=${geminiTelemetry.selfie.failCount} selfie_ms=${geminiTelemetry.selfie.latencyMs ?? 'null'} lookDiffSource=${geminiTelemetry.lookDiffSource ?? 'null'}`,
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

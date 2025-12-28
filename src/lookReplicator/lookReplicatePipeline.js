const fs = require('fs');

const { extractLookSpec } = require('../layer2/extractLookSpec');
const { generateAdjustments } = require('../layer2/personalization/generateAdjustments');
const { generateSteps } = require('../layer2/personalization/generateSteps');
const { buildKitPlan } = require('../layer3/buildKitPlan');
const { LookReplicateResultV0Schema } = require('../schemas/lookReplicateResultV0');
const { buildAdjustmentCandidates } = require('./buildAdjustmentCandidates');

const { Layer1BundleV0Schema } = require('../layer1/schemas/layer1BundleV0');
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

  const referenceBytes = fs.readFileSync(input.referenceImage.path);
  const versions = engineVersionFor(pack.market);

  const lookSpec = await extractLookSpec({
    market: pack.market,
    locale,
    referenceImage: { kind: 'bytes', bytes: referenceBytes, contentType: input.referenceImage.contentType },
    promptPack: pack.getPromptPack(locale),
  });

  const adjOut = await generateAdjustments({
    market: pack.market,
    locale,
    userFaceProfile,
    refFaceProfile,
    similarityReport,
    lookSpec,
    preferenceMode,
    promptPack: pack.getPromptPack(locale),
  });

  const stepsOut = await generateSteps({
    market: pack.market,
    locale,
    lookSpec,
    adjustments: adjOut.adjustments,
    userFaceProfile,
    promptPack: pack.getPromptPack(locale),
  });

  const kitPlan = await buildKitPlan({ market: pack.market, locale, lookSpec, commerceEnabled: pack.commerceEnabled });

  const warnings = [
    ...(Array.isArray(lookSpec.warnings) ? lookSpec.warnings : []),
    ...(Array.isArray(adjOut.warnings) ? adjOut.warnings : []),
    ...(Array.isArray(stepsOut.warnings) ? stepsOut.warnings : []),
    ...(Array.isArray(kitPlan.warnings) ? kitPlan.warnings : []),
  ].filter(Boolean);

  const candidateOut = buildAdjustmentCandidates({ layer2Adjustments: adjOut.adjustments });

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
      }
    : null;

  return { result, locale, preferenceMode, telemetrySample };
}

module.exports = {
  runLookReplicatePipeline,
  parseOptionalJsonField,
  normalizeLocale,
  normalizePreferenceMode,
};

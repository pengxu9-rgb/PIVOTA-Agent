const fs = require('fs');

const { extractLookSpec } = require('../layer2/extractLookSpec');
const { generateAdjustments } = require('../layer2/personalization/generateAdjustments');
const { generateSteps } = require('../layer2/personalization/generateSteps');
const { buildKitPlan } = require('../layer3/buildKitPlan');
const { LookReplicateResultV0Schema } = require('../schemas/lookReplicateResultV0');

const { Layer1BundleV0Schema } = require('../layer1/schemas/layer1BundleV0');
const { buildContextFingerprintUS } = require('../telemetry/contextFingerprintUS');

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

  const layer1Bundle = input.layer1Bundle ?? null;
  const layer1 = layer1Bundle ? Layer1BundleV0Schema.parse(layer1Bundle) : null;

  const userFaceProfile = layer1?.userFaceProfile ?? null;
  const refFaceProfile = layer1?.refFaceProfile ?? null;
  const similarityReport = layer1?.similarityReport ?? null;

  const referenceBytes = fs.readFileSync(input.referenceImage.path);

  const lookSpec = await extractLookSpec({
    market: 'US',
    locale,
    referenceImage: { kind: 'bytes', bytes: referenceBytes, contentType: input.referenceImage.contentType },
  });

  const adjOut = await generateAdjustments({
    market: 'US',
    locale,
    userFaceProfile,
    refFaceProfile,
    similarityReport,
    lookSpec,
    preferenceMode,
  });

  const stepsOut = await generateSteps({
    market: 'US',
    locale,
    lookSpec,
    adjustments: adjOut.adjustments,
    userFaceProfile,
  });

  const kitPlan = await buildKitPlan({ market: 'US', locale, lookSpec });

  const warnings = [
    ...(Array.isArray(lookSpec.warnings) ? lookSpec.warnings : []),
    ...(Array.isArray(adjOut.warnings) ? adjOut.warnings : []),
    ...(Array.isArray(stepsOut.warnings) ? stepsOut.warnings : []),
    ...(Array.isArray(kitPlan.warnings) ? kitPlan.warnings : []),
  ].filter(Boolean);

  const result = LookReplicateResultV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    locale,
    layer2EngineVersion: 'l2-us-0.1.0',
    layer3EngineVersion: 'l3-us-0.1.0',
    orchestratorVersion: 'orchestrator-us-0.1.0',
    breakdown: lookSpec.breakdown,
    adjustments: toResultAdjustments(adjOut.adjustments),
    steps: stepsOut.steps,
    kit: kitPlan,
    ...(warnings.length ? { warnings } : {}),
  });

  const telemetrySample = input.jobId
    ? {
        jobId: input.jobId,
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
        usedTechniques: extractUsedTechniques(adjOut.adjustments),
        usedRules: extractUsedRules(adjOut.adjustments),
        contextFingerprint: buildContextFingerprintUS({ userFaceProfile, refFaceProfile, lookSpec }),
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

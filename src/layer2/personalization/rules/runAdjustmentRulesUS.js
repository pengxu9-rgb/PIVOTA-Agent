const { z } = require('zod');

const { AdjustmentSkeletonV0Schema } = require('../../schemas/adjustmentSkeletonV0');
const { normalizeLookSpecToV1 } = require('../../schemas/lookSpecV1');
const { getTechniqueIdsForIntent } = require('../../dicts/intents');

const { US_ADJUSTMENT_RULES, US_ADJUSTMENT_FALLBACK_RULES } = require('./usAdjustmentRules');
const { SimilarityReportV0Schema } = require('../../../layer1/schemas/similarityReportV0');

const PreferenceModeSchema = z.enum(['structure', 'vibe', 'ease']);

function parseEnvBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function extendedAreasEnabled(input) {
  if (typeof input?.enableExtendedAreas === 'boolean') return input.enableExtendedAreas;
  return parseEnvBool(process.env.LAYER2_ENABLE_EXTENDED_AREAS) === true;
}

function eyeActivitySlotEnabled() {
  return parseEnvBool(process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT) === true;
}

function baseActivitySlotEnabled() {
  return parseEnvBool(process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT) === true;
}

function lipActivitySlotEnabled() {
  return parseEnvBool(process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT) === true;
}

function triggerMatchingEnabled() {
  return parseEnvBool(process.env.LAYER2_ENABLE_TRIGGER_MATCHING) === true;
}

function selfieLookSpecEnabled(input) {
  if (typeof input?.enableSelfieLookSpec === 'boolean') return input.enableSelfieLookSpec;
  return parseEnvBool(process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC) === true;
}

function buildExtendedFallbackSkeleton({ impactArea, ruleId, intentId }) {
  const doActionIds = getTechniqueIdsForIntent(intentId, 'US') ?? [];
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea,
    ruleId,
    severity: 0.15,
    confidence: 'low',
    becauseFacts: ['Extended areas enabled: include a minimal safe set of techniques for this area.'],
    doActionSelection: 'sequence',
    ...(doActionIds.length ? { doActionIds } : {}),
    doActions: [],
    whyMechanism: ['A minimal conservative set keeps output stable while expanding coverage.'],
    evidenceKeys: ['flag:LAYER2_ENABLE_EXTENDED_AREAS'],
    tags: ['extended_area', 'fallback'],
  });
}

function buildEyeLinerActivitySlotSkeleton(input) {
  const dir = String(input && input.lookSpec && input.lookSpec.breakdown && input.lookSpec.breakdown.eye && input.lookSpec.breakdown.eye.linerDirection && input.lookSpec.breakdown.eye.linerDirection.direction || '').trim();
  if (!dir || dir === 'unknown') return null;

  const doActionIds = getTechniqueIdsForIntent('EYE_LINER_ACTIVITY_PICK', 'US') ?? [];
  if (!doActionIds.length) return null;

  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea: 'eye',
    ruleId: 'EYE_LINER_ACTIVITY_SLOT',
    severity: 0.1,
    confidence: 'low',
    becauseFacts: ['Optional: add one macro activity technique card after the micro-steps.'],
    doActionSelection: 'choose_one',
    doActionIds,
    doActions: [],
    whyMechanism: ['Choose exactly one activity card to avoid mixing granularity inside the micro-step sequence.'],
    evidenceKeys: ['intent:EYE_LINER_ACTIVITY_PICK', 'lookSpec.breakdown.eye.linerDirection.direction'],
    tags: ['activity_slot', 'eye_liner'],
  });
}

function needsLookDiffChange(similarityReport, path) {
  if (!similarityReport) return false;
  const sr = SimilarityReportV0Schema.parse(similarityReport);
  if (path === 'base.finish') return sr.lookDiff?.base?.finish?.needsChange === true;
  if (path === 'base.coverage') return sr.lookDiff?.base?.coverage?.needsChange === true;
  if (path === 'lip.finish') return sr.lookDiff?.lip?.finish?.needsChange === true;
  return false;
}

function needsLookDiffIntentChange(similarityReport, area) {
  if (!similarityReport) return false;
  const sr = SimilarityReportV0Schema.parse(similarityReport);
  if (area === 'prep') return sr.lookDiff?.prep?.intent?.needsChange === true;
  if (area === 'contour') return sr.lookDiff?.contour?.intent?.needsChange === true;
  if (area === 'brow') return sr.lookDiff?.brow?.intent?.needsChange === true;
  if (area === 'blush') return sr.lookDiff?.blush?.intent?.needsChange === true;
  return false;
}

function buildBaseActivitySlotSkeleton(input) {
  if (!needsLookDiffChange(input.similarityReport, 'base.finish') && !needsLookDiffChange(input.similarityReport, 'base.coverage')) return null;
  const doActionIds = getTechniqueIdsForIntent('BASE_BUILD_COVERAGE_SPOT_ACTIVITY_PICK', 'US') ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea: 'base',
    ruleId: 'BASE_ACTIVITY_SLOT',
    severity: 0.1,
    confidence: 'low',
    becauseFacts: ['Optional: add one macro activity technique card after the micro-steps.'],
    doActionSelection: 'choose_one',
    doActionIds,
    doActions: [],
    whyMechanism: ['Choose exactly one activity card to avoid mixing granularity inside the micro-step sequence.'],
    evidenceKeys: [
      'intent:BASE_BUILD_COVERAGE_SPOT_ACTIVITY_PICK',
      'similarityReport.lookDiff.base.finish.needsChange',
      'similarityReport.lookDiff.base.coverage.needsChange',
    ],
    tags: ['activity_slot', 'base'],
  });
}

function buildLipActivitySlotSkeleton(input) {
  if (!needsLookDiffChange(input.similarityReport, 'lip.finish')) return null;
  const doActionIds = getTechniqueIdsForIntent('LIP_FALLBACK_FINISH_FOCUS_ACTIVITY_PICK', 'US') ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea: 'lip',
    ruleId: 'LIP_ACTIVITY_SLOT',
    severity: 0.1,
    confidence: 'low',
    becauseFacts: ['Optional: add one macro activity technique card after the micro-steps.'],
    doActionSelection: 'choose_one',
    doActionIds,
    doActions: [],
    whyMechanism: ['Choose exactly one activity card to avoid mixing granularity inside the micro-step sequence.'],
    evidenceKeys: ['intent:LIP_FALLBACK_FINISH_FOCUS_ACTIVITY_PICK', 'similarityReport.lookDiff.lip.finish.needsChange'],
    tags: ['activity_slot', 'lip'],
  });
}

function buildPrepActivitySlotSkeleton(input) {
  if (!needsLookDiffIntentChange(input.similarityReport, 'prep')) return null;
  const doActionIds = getTechniqueIdsForIntent('PREP_ACTIVITY_PICK', 'US') ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea: 'prep',
    ruleId: 'PREP_ACTIVITY_SLOT',
    severity: 0.1,
    confidence: 'low',
    becauseFacts: ['Optional: add one macro activity technique card for prep when a change is needed.'],
    doActionSelection: 'choose_one',
    doActionIds,
    doActions: [],
    whyMechanism: ['Choose exactly one activity card to keep extended-area output stable and low-noise.'],
    evidenceKeys: ['intent:PREP_ACTIVITY_PICK', 'similarityReport.lookDiff.prep.intent.needsChange'],
    tags: ['activity_slot', 'prep'],
  });
}

function buildContourActivitySlotSkeleton(input) {
  if (!needsLookDiffIntentChange(input.similarityReport, 'contour')) return null;
  const doActionIds = getTechniqueIdsForIntent('CONTOUR_ACTIVITY_PICK', 'US') ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea: 'contour',
    ruleId: 'CONTOUR_ACTIVITY_SLOT',
    severity: 0.1,
    confidence: 'low',
    becauseFacts: ['Optional: add one macro activity technique card for contour when a change is needed.'],
    doActionSelection: 'choose_one',
    doActionIds,
    doActions: [],
    whyMechanism: ['Choose exactly one activity card to keep extended-area output stable and low-noise.'],
    evidenceKeys: ['intent:CONTOUR_ACTIVITY_PICK', 'similarityReport.lookDiff.contour.intent.needsChange'],
    tags: ['activity_slot', 'contour'],
  });
}

function buildBrowActivitySlotSkeleton(input) {
  if (!needsLookDiffIntentChange(input.similarityReport, 'brow')) return null;
  const doActionIds = getTechniqueIdsForIntent('BROW_ACTIVITY_PICK', 'US') ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea: 'brow',
    ruleId: 'BROW_ACTIVITY_SLOT',
    severity: 0.1,
    confidence: 'low',
    becauseFacts: ['Optional: add one macro activity technique card for brows when a change is needed.'],
    doActionSelection: 'choose_one',
    doActionIds,
    doActions: [],
    whyMechanism: ['Choose exactly one activity card to keep extended-area output stable and low-noise.'],
    evidenceKeys: ['intent:BROW_ACTIVITY_PICK', 'similarityReport.lookDiff.brow.intent.needsChange'],
    tags: ['activity_slot', 'brow'],
  });
}

function buildBlushActivitySlotSkeleton(input) {
  if (!needsLookDiffIntentChange(input.similarityReport, 'blush')) return null;
  const doActionIds = getTechniqueIdsForIntent('BLUSH_ACTIVITY_PICK', 'US') ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: 'v0',
    market: 'US',
    impactArea: 'blush',
    ruleId: 'BLUSH_ACTIVITY_SLOT',
    severity: 0.1,
    confidence: 'low',
    becauseFacts: ['Optional: add one macro activity technique card for blush when a change is needed.'],
    doActionSelection: 'choose_one',
    doActionIds,
    doActions: [],
    whyMechanism: ['Choose exactly one activity card to keep extended-area output stable and low-noise.'],
    evidenceKeys: ['intent:BLUSH_ACTIVITY_PICK', 'similarityReport.lookDiff.blush.intent.needsChange'],
    tags: ['activity_slot', 'blush'],
  });
}

function runAdjustmentRulesUS(input) {
  const lookSpec = normalizeLookSpecToV1(input.lookSpec);
  if (lookSpec.market !== 'US') throw new Error('runAdjustmentRulesUS only supports market=US.');

  const preferenceMode = PreferenceModeSchema.parse(input.preferenceMode);

  const ctx = {
    userFaceProfile: input.userFaceProfile ?? null,
    refFaceProfile: input.refFaceProfile ?? null,
    similarityReport: input.similarityReport ?? null,
    lookSpec,
    preferenceMode,
  };

  const outByArea = {};
  const areas = ['base', 'eye', 'lip'];
  for (const area of areas) {
    const candidates = US_ADJUSTMENT_RULES.filter((r) => r.impactArea === area && r.matches(ctx));
    let chosen = null;
    if (candidates.length) {
      const built = candidates.map((r) => r.build(ctx));
      if (preferenceMode === 'ease') {
        const sorted = candidates
          .map((r, idx) => ({ r, idx }))
          .sort((a, b) => a.r.difficulty - b.r.difficulty || a.r.ruleId.localeCompare(b.r.ruleId));
        chosen = built[sorted[0].idx];
      } else {
        const sorted = built
          .map((s) => AdjustmentSkeletonV0Schema.parse(s))
          .sort((a, b) => b.severity - a.severity || a.ruleId.localeCompare(b.ruleId));
        chosen = sorted[0];
      }
    } else {
      chosen = US_ADJUSTMENT_FALLBACK_RULES[area].build(ctx);
    }

    outByArea[area] = AdjustmentSkeletonV0Schema.parse(chosen);
  }

  const eyeActivitySlot =
    eyeActivitySlotEnabled() && triggerMatchingEnabled() && outByArea.eye?.ruleId === 'EYE_LINER_DIRECTION_ADAPT'
      ? buildEyeLinerActivitySlotSkeleton({ lookSpec })
      : null;

  const baseActivitySlot =
    baseActivitySlotEnabled() && triggerMatchingEnabled() && outByArea.base?.ruleId === 'BASE_BUILD_COVERAGE_SPOT'
      ? buildBaseActivitySlotSkeleton({ similarityReport: ctx.similarityReport })
      : null;

  const lipActivitySlot =
    lipActivitySlotEnabled() && triggerMatchingEnabled() && outByArea.lip?.ruleId === 'LIP_FALLBACK_FINISH_FOCUS'
      ? buildLipActivitySlotSkeleton({ similarityReport: ctx.similarityReport })
      : null;

  if (!extendedAreasEnabled(input)) {
    return [
      outByArea.base,
      ...(baseActivitySlot ? [baseActivitySlot] : []),
      outByArea.eye,
      ...(eyeActivitySlot ? [eyeActivitySlot] : []),
      outByArea.lip,
      ...(lipActivitySlot ? [lipActivitySlot] : []),
    ];
  }

  const selfieEnabled = selfieLookSpecEnabled(input);

  const includePrep = !selfieEnabled || needsLookDiffIntentChange(ctx.similarityReport, 'prep');
  const includeContour = !selfieEnabled || needsLookDiffIntentChange(ctx.similarityReport, 'contour');
  const includeBrow = !selfieEnabled || needsLookDiffIntentChange(ctx.similarityReport, 'brow');
  const includeBlush = !selfieEnabled || needsLookDiffIntentChange(ctx.similarityReport, 'blush');

  const prep = includePrep
    ? buildExtendedFallbackSkeleton({ impactArea: 'prep', ruleId: 'PREP_FALLBACK_SAFE', intentId: 'PREP_FALLBACK_SAFE_MICRO' })
    : null;
  const prepActivitySlot = selfieEnabled && triggerMatchingEnabled() && includePrep ? buildPrepActivitySlotSkeleton({ similarityReport: ctx.similarityReport }) : null;

  const contour = includeContour
    ? buildExtendedFallbackSkeleton({ impactArea: 'contour', ruleId: 'CONTOUR_FALLBACK_SAFE', intentId: 'CONTOUR_FALLBACK_SAFE_MICRO' })
    : null;
  const contourActivitySlot = selfieEnabled && triggerMatchingEnabled() && includeContour ? buildContourActivitySlotSkeleton({ similarityReport: ctx.similarityReport }) : null;

  const brow = includeBrow
    ? buildExtendedFallbackSkeleton({ impactArea: 'brow', ruleId: 'BROW_FALLBACK_SAFE', intentId: 'BROW_FALLBACK_SAFE_MICRO' })
    : null;
  const browActivitySlot = selfieEnabled && triggerMatchingEnabled() && includeBrow ? buildBrowActivitySlotSkeleton({ similarityReport: ctx.similarityReport }) : null;

  const blush = includeBlush
    ? buildExtendedFallbackSkeleton({ impactArea: 'blush', ruleId: 'BLUSH_FALLBACK_SAFE', intentId: 'BLUSH_FALLBACK_SAFE_MICRO' })
    : null;
  const blushActivitySlot = selfieEnabled && triggerMatchingEnabled() && includeBlush ? buildBlushActivitySlotSkeleton({ similarityReport: ctx.similarityReport }) : null;

  return [
    ...(prep ? [prep] : []),
    ...(prepActivitySlot ? [prepActivitySlot] : []),
    outByArea.base,
    ...(baseActivitySlot ? [baseActivitySlot] : []),
    ...(contour ? [contour] : []),
    ...(contourActivitySlot ? [contourActivitySlot] : []),
    ...(brow ? [brow] : []),
    ...(browActivitySlot ? [browActivitySlot] : []),
    outByArea.eye,
    ...(eyeActivitySlot ? [eyeActivitySlot] : []),
    ...(blush ? [blush] : []),
    ...(blushActivitySlot ? [blushActivitySlot] : []),
    outByArea.lip,
    ...(lipActivitySlot ? [lipActivitySlot] : []),
  ];
}

module.exports = {
  runAdjustmentRulesUS,
};

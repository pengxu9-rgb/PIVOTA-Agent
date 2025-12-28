const { z } = require('zod');

const { AdjustmentSkeletonV0Schema } = require('../../schemas/adjustmentSkeletonV0');
const { normalizeLookSpecToV1 } = require('../../schemas/lookSpecV1');
const { getTechniqueIdsForIntent } = require('../../dicts/intents');

const { US_ADJUSTMENT_RULES, US_ADJUSTMENT_FALLBACK_RULES } = require('./usAdjustmentRules');

const PreferenceModeSchema = z.enum(['structure', 'vibe', 'ease']);

function parseEnvBool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function extendedAreasEnabled() {
  return parseEnvBool(process.env.LAYER2_ENABLE_EXTENDED_AREAS) === true;
}

function eyeActivitySlotEnabled() {
  const fromEnv = parseEnvBool(process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT);
  if (fromEnv === null) return true;
  return fromEnv === true;
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

function buildEyeLinerActivitySlotSkeleton() {
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
    eyeActivitySlotEnabled() && outByArea.eye?.ruleId === 'EYE_LINER_DIRECTION_ADAPT'
      ? buildEyeLinerActivitySlotSkeleton()
      : null;

  if (!extendedAreasEnabled()) {
    return [outByArea.base, outByArea.eye, ...(eyeActivitySlot ? [eyeActivitySlot] : []), outByArea.lip];
  }

  const prep = buildExtendedFallbackSkeleton({ impactArea: 'prep', ruleId: 'PREP_FALLBACK_SAFE', intentId: 'PREP_FALLBACK_SAFE' });
  const contour = buildExtendedFallbackSkeleton({
    impactArea: 'contour',
    ruleId: 'CONTOUR_FALLBACK_SAFE',
    intentId: 'CONTOUR_FALLBACK_SAFE',
  });
  const brow = buildExtendedFallbackSkeleton({ impactArea: 'brow', ruleId: 'BROW_FALLBACK_SAFE', intentId: 'BROW_FALLBACK_SAFE' });
  const blush = buildExtendedFallbackSkeleton({
    impactArea: 'blush',
    ruleId: 'BLUSH_FALLBACK_SAFE',
    intentId: 'BLUSH_FALLBACK_SAFE',
  });

  return [
    prep,
    outByArea.base,
    contour,
    brow,
    outByArea.eye,
    ...(eyeActivitySlot ? [eyeActivitySlot] : []),
    blush,
    outByArea.lip,
  ];
}

module.exports = {
  runAdjustmentRulesUS,
};

import { z } from "zod";

import { AdjustmentSkeletonV0, AdjustmentSkeletonV0Schema } from "../../schemas/adjustmentSkeletonV0";
import { normalizeLookSpecToV1 } from "../../schemas/lookSpecV1";
import { getTechniqueIdsForIntent } from "../../dicts/intents";

import { PreferenceMode, US_ADJUSTMENT_FALLBACK_RULES, US_ADJUSTMENT_RULES } from "./usAdjustmentRules";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SimilarityReportV0Schema } = require("../../../layer1/schemas/similarityReportV0");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FaceProfileV0Schema } = require("../../../layer1/schemas/faceProfileV0");

const PreferenceModeSchema = z.enum(["structure", "vibe", "ease"]);

export type RunAdjustmentRulesUSInput = {
  userFaceProfile?: unknown | null;
  refFaceProfile?: unknown | null;
  similarityReport?: unknown | null;
  lookSpec: unknown;
  preferenceMode: PreferenceMode;
};

function parseEnvBool(v: unknown): boolean | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return null;
}

function extendedAreasEnabled(input: unknown): boolean {
  const rec = input as Record<string, unknown> | null;
  const override = rec && typeof rec === "object" ? rec["enableExtendedAreas"] : undefined;
  if (typeof override === "boolean") return override;
  return parseEnvBool(process.env.LAYER2_ENABLE_EXTENDED_AREAS) === true;
}

function eyeActivitySlotEnabled(): boolean {
  return parseEnvBool(process.env.LAYER2_ENABLE_EYE_ACTIVITY_SLOT) === true;
}

function baseActivitySlotEnabled(): boolean {
  return parseEnvBool(process.env.LAYER2_ENABLE_BASE_ACTIVITY_SLOT) === true;
}

function lipActivitySlotEnabled(): boolean {
  return parseEnvBool(process.env.LAYER2_ENABLE_LIP_ACTIVITY_SLOT) === true;
}

function triggerMatchingEnabled(): boolean {
  return parseEnvBool(process.env.LAYER2_ENABLE_TRIGGER_MATCHING) === true;
}

function selfieLookSpecEnabled(input: unknown): boolean {
  const rec = input as Record<string, unknown> | null;
  const override = rec && typeof rec === "object" ? rec["enableSelfieLookSpec"] : undefined;
  if (typeof override === "boolean") return override;
  return parseEnvBool(process.env.LAYER2_ENABLE_SELFIE_LOOKSPEC) === true;
}

function buildExtendedFallbackSkeleton(input: { impactArea: AdjustmentSkeletonV0["impactArea"]; ruleId: string; intentId: string }): AdjustmentSkeletonV0 {
  const doActionIds = getTechniqueIdsForIntent(input.intentId, "US") ?? [];
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: input.impactArea,
    ruleId: input.ruleId,
    severity: 0.15,
    confidence: "low",
    becauseFacts: ["Extended areas enabled: include a minimal safe set of techniques for this area."],
    doActionSelection: "sequence",
    ...(doActionIds.length ? { doActionIds } : {}),
    doActions: [],
    whyMechanism: ["A minimal conservative set keeps output stable while expanding coverage."],
    evidenceKeys: ["flag:LAYER2_ENABLE_EXTENDED_AREAS"],
    tags: ["extended_area", "fallback"],
  });
}

function uniqueStrings(items: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const s = String(raw || "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function moveToFront(ids: string[], preferredId: string | null): string[] {
  if (!preferredId) return ids;
  const idx = ids.indexOf(preferredId);
  if (idx <= 0) return ids;
  return [ids[idx], ...ids.slice(0, idx), ...ids.slice(idx + 1)];
}

function normalizeToken(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function inferRefFaceShape(refFaceProfile: unknown | null | undefined): string {
  try {
    const parsed = FaceProfileV0Schema.parse(refFaceProfile);
    return normalizeToken(parsed?.categorical?.faceShape);
  } catch {
    return normalizeToken((refFaceProfile as any)?.categorical?.faceShape);
  }
}

function buildExtendedActivityCardSkeleton(input: {
  impactArea: "prep" | "contour" | "brow" | "blush";
  ruleId: string;
  intentId: string;
  fallbackIntentId: string;
  preferredFirstId?: string | null;
  evidenceKeys?: string[];
}): AdjustmentSkeletonV0 | null {
  const primary = getTechniqueIdsForIntent(input.intentId, "US") ?? [];
  const fallback = getTechniqueIdsForIntent(input.fallbackIntentId, "US") ?? [];
  let doActionIds = uniqueStrings([...primary, ...fallback]);
  if (!doActionIds.length) return null;

  doActionIds = moveToFront(doActionIds, input.preferredFirstId ?? null);

  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: input.impactArea,
    ruleId: input.ruleId,
    severity: 0.15,
    confidence: "low",
    becauseFacts: ["Extended areas enabled: include one targeted technique card for this area."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choosing one focused card avoids noise while improving coverage across areas."],
    evidenceKeys: input.evidenceKeys ?? ["flag:enableExtendedAreas", `intent:${input.intentId}`],
    tags: ["extended_area", "activity_card", input.impactArea],
  });
}

function buildEyeLinerActivitySlotSkeleton(input: { lookSpec: unknown }): AdjustmentSkeletonV0 | null {
  const dir = String((input as any)?.lookSpec?.breakdown?.eye?.linerDirection?.direction ?? "").trim();
  if (!dir || dir === "unknown") return null;

  const doActionIds = getTechniqueIdsForIntent("EYE_LINER_ACTIVITY_PICK", "US") ?? [];
  if (!doActionIds.length) return null;

  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: "eye",
    ruleId: "EYE_LINER_ACTIVITY_SLOT",
    severity: 0.1,
    confidence: "low",
    becauseFacts: ["Optional: add one macro activity technique card after the micro-steps."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choose exactly one activity card to avoid mixing granularity inside the micro-step sequence."],
    evidenceKeys: ["intent:EYE_LINER_ACTIVITY_PICK", "lookSpec.breakdown.eye.linerDirection.direction"],
    tags: ["activity_slot", "eye_liner"],
  });
}

function needsLookDiffChange(similarityReport: unknown | null | undefined, path: "base.finish" | "base.coverage" | "lip.finish"): boolean {
  if (!similarityReport) return false;
  const sr = SimilarityReportV0Schema.parse(similarityReport);
  if (path === "base.finish") return sr.lookDiff?.base?.finish?.needsChange === true;
  if (path === "base.coverage") return sr.lookDiff?.base?.coverage?.needsChange === true;
  if (path === "lip.finish") return sr.lookDiff?.lip?.finish?.needsChange === true;
  return false;
}

function needsLookDiffIntentChange(similarityReport: unknown | null | undefined, area: "prep" | "contour" | "brow" | "blush"): boolean {
  if (!similarityReport) return false;
  const sr = SimilarityReportV0Schema.parse(similarityReport);
  if (area === "prep") return sr.lookDiff?.prep?.intent?.needsChange === true;
  if (area === "contour") return sr.lookDiff?.contour?.intent?.needsChange === true;
  if (area === "brow") return sr.lookDiff?.brow?.intent?.needsChange === true;
  if (area === "blush") return sr.lookDiff?.blush?.intent?.needsChange === true;
  return false;
}

function buildBaseActivitySlotSkeleton(input: { similarityReport?: unknown | null }): AdjustmentSkeletonV0 | null {
  if (!needsLookDiffChange(input.similarityReport, "base.finish") && !needsLookDiffChange(input.similarityReport, "base.coverage")) return null;
  const doActionIds = getTechniqueIdsForIntent("BASE_BUILD_COVERAGE_SPOT_ACTIVITY_PICK", "US") ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: "base",
    ruleId: "BASE_ACTIVITY_SLOT",
    severity: 0.1,
    confidence: "low",
    becauseFacts: ["Optional: add one macro activity technique card after the micro-steps."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choose exactly one activity card to avoid mixing granularity inside the micro-step sequence."],
    evidenceKeys: ["intent:BASE_BUILD_COVERAGE_SPOT_ACTIVITY_PICK", "similarityReport.lookDiff.base.finish.needsChange", "similarityReport.lookDiff.base.coverage.needsChange"],
    tags: ["activity_slot", "base"],
  });
}

function buildLipActivitySlotSkeleton(input: { similarityReport?: unknown | null }): AdjustmentSkeletonV0 | null {
  if (!needsLookDiffChange(input.similarityReport, "lip.finish")) return null;
  const doActionIds = getTechniqueIdsForIntent("LIP_FALLBACK_FINISH_FOCUS_ACTIVITY_PICK", "US") ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: "lip",
    ruleId: "LIP_ACTIVITY_SLOT",
    severity: 0.1,
    confidence: "low",
    becauseFacts: ["Optional: add one macro activity technique card after the micro-steps."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choose exactly one activity card to avoid mixing granularity inside the micro-step sequence."],
    evidenceKeys: ["intent:LIP_FALLBACK_FINISH_FOCUS_ACTIVITY_PICK", "similarityReport.lookDiff.lip.finish.needsChange"],
    tags: ["activity_slot", "lip"],
  });
}

function buildPrepActivitySlotSkeleton(input: { similarityReport?: unknown | null }): AdjustmentSkeletonV0 | null {
  if (!needsLookDiffIntentChange(input.similarityReport, "prep")) return null;
  const doActionIds = getTechniqueIdsForIntent("PREP_ACTIVITY_PICK", "US") ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: "prep",
    ruleId: "PREP_ACTIVITY_SLOT",
    severity: 0.1,
    confidence: "low",
    becauseFacts: ["Optional: add one macro activity technique card for prep when a change is needed."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choose exactly one activity card to keep extended-area output stable and low-noise."],
    evidenceKeys: ["intent:PREP_ACTIVITY_PICK", "similarityReport.lookDiff.prep.intent.needsChange"],
    tags: ["activity_slot", "prep"],
  });
}

function buildContourActivitySlotSkeleton(input: { similarityReport?: unknown | null }): AdjustmentSkeletonV0 | null {
  if (!needsLookDiffIntentChange(input.similarityReport, "contour")) return null;
  const doActionIds = getTechniqueIdsForIntent("CONTOUR_ACTIVITY_PICK", "US") ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: "contour",
    ruleId: "CONTOUR_ACTIVITY_SLOT",
    severity: 0.1,
    confidence: "low",
    becauseFacts: ["Optional: add one macro activity technique card for contour when a change is needed."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choose exactly one activity card to keep extended-area output stable and low-noise."],
    evidenceKeys: ["intent:CONTOUR_ACTIVITY_PICK", "similarityReport.lookDiff.contour.intent.needsChange"],
    tags: ["activity_slot", "contour"],
  });
}

function buildBrowActivitySlotSkeleton(input: { similarityReport?: unknown | null }): AdjustmentSkeletonV0 | null {
  if (!needsLookDiffIntentChange(input.similarityReport, "brow")) return null;
  const doActionIds = getTechniqueIdsForIntent("BROW_ACTIVITY_PICK", "US") ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: "brow",
    ruleId: "BROW_ACTIVITY_SLOT",
    severity: 0.1,
    confidence: "low",
    becauseFacts: ["Optional: add one macro activity technique card for brows when a change is needed."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choose exactly one activity card to keep extended-area output stable and low-noise."],
    evidenceKeys: ["intent:BROW_ACTIVITY_PICK", "similarityReport.lookDiff.brow.intent.needsChange"],
    tags: ["activity_slot", "brow"],
  });
}

function buildBlushActivitySlotSkeleton(input: { similarityReport?: unknown | null }): AdjustmentSkeletonV0 | null {
  if (!needsLookDiffIntentChange(input.similarityReport, "blush")) return null;
  const doActionIds = getTechniqueIdsForIntent("BLUSH_ACTIVITY_PICK", "US") ?? [];
  if (!doActionIds.length) return null;
  return AdjustmentSkeletonV0Schema.parse({
    schemaVersion: "v0",
    market: "US",
    impactArea: "blush",
    ruleId: "BLUSH_ACTIVITY_SLOT",
    severity: 0.1,
    confidence: "low",
    becauseFacts: ["Optional: add one macro activity technique card for blush when a change is needed."],
    doActionSelection: "choose_one",
    doActionIds,
    doActions: [],
    whyMechanism: ["Choose exactly one activity card to keep extended-area output stable and low-noise."],
    evidenceKeys: ["intent:BLUSH_ACTIVITY_PICK", "similarityReport.lookDiff.blush.intent.needsChange"],
    tags: ["activity_slot", "blush"],
  });
}

export function runAdjustmentRulesUS(input: RunAdjustmentRulesUSInput): AdjustmentSkeletonV0[] {
  const lookSpec = normalizeLookSpecToV1(input.lookSpec);
  if (lookSpec.market !== "US") {
    throw new Error("runAdjustmentRulesUS only supports market=US.");
  }

  const preferenceMode = PreferenceModeSchema.parse(input.preferenceMode);

  const ctx = {
    userFaceProfile: input.userFaceProfile ?? null,
    refFaceProfile: input.refFaceProfile ?? null,
    similarityReport: input.similarityReport ?? null,
    lookSpec,
    preferenceMode,
  };

  const outByArea: Partial<Record<AdjustmentSkeletonV0["impactArea"], AdjustmentSkeletonV0>> = {};
  const areas: Array<AdjustmentSkeletonV0["impactArea"]> = ["base", "eye", "lip"];

  for (const area of areas) {
    const candidates = US_ADJUSTMENT_RULES.filter((r) => r.impactArea === area && r.matches(ctx));
    let chosen = null as null | AdjustmentSkeletonV0;
    if (candidates.length) {
      const built = candidates.map((r) => r.build(ctx));
      // PreferenceMode = ease: pick the lowest-difficulty candidate.
      if (preferenceMode === "ease") {
        const sorted = candidates
          .map((r, idx) => ({ r, idx }))
          .sort((a, b) => a.r.difficulty - b.r.difficulty || a.r.ruleId.localeCompare(b.r.ruleId));
        chosen = built[sorted[0].idx];
      } else {
        // structure/vibe: pick the highest severity, deterministic tie-breaker on ruleId.
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
    eyeActivitySlotEnabled() && triggerMatchingEnabled() && outByArea.eye?.ruleId === "EYE_LINER_DIRECTION_ADAPT"
      ? buildEyeLinerActivitySlotSkeleton({ lookSpec })
      : null;

  const baseActivitySlot =
    baseActivitySlotEnabled() && triggerMatchingEnabled() && outByArea.base?.ruleId === "BASE_BUILD_COVERAGE_SPOT"
      ? buildBaseActivitySlotSkeleton({ similarityReport: ctx.similarityReport })
      : null;

  const lipActivitySlot =
    lipActivitySlotEnabled() && triggerMatchingEnabled() && outByArea.lip?.ruleId === "LIP_FALLBACK_FINISH_FOCUS"
      ? buildLipActivitySlotSkeleton({ similarityReport: ctx.similarityReport })
      : null;

  if (!extendedAreasEnabled(input)) {
    return [
      outByArea.base!,
      ...(baseActivitySlot ? [baseActivitySlot] : []),
      outByArea.eye!,
      ...(eyeActivitySlot ? [eyeActivitySlot] : []),
      outByArea.lip!,
      ...(lipActivitySlot ? [lipActivitySlot] : []),
    ];
  }

  const baseFinish = normalizeToken((lookSpec as any)?.breakdown?.base?.finish);
  const contourIntent = normalizeToken((lookSpec as any)?.breakdown?.contour?.intent);
  const browIntent = normalizeToken((lookSpec as any)?.breakdown?.brow?.intent);
  const faceShape = inferRefFaceShape(input.refFaceProfile ?? null);

  const prepPreferred = baseFinish === "matte" ? "US_prep_primer_01-en" : "US_prep_moisturize_01-en";
  const contourPreferred = contourIntent.includes("highlight") ? "US_contour_nose_highlight_points_01-en" : "US_contour_nose_root_contour_01-en";
  const browPreferred = browIntent.includes("arch") ? "US_brow_fix_high_arch_01-en" : "US_brow_fill_natural_strokes_01-en";
  const blushPreferred = faceShape === "round" ? "US_blush_round_face_placement_01-en" : "US_blush_oval_face_gradient_01-en";

  const prepCard = buildExtendedActivityCardSkeleton({
    impactArea: "prep",
    ruleId: "PREP_ACTIVITY_CARD",
    intentId: "PREP_ACTIVITY_PICK",
    fallbackIntentId: "PREP_FALLBACK_SAFE_MICRO",
    preferredFirstId: prepPreferred,
    evidenceKeys: ["flag:enableExtendedAreas", "intent:PREP_ACTIVITY_PICK", "lookSpec.breakdown.base.finish"],
  });

  const contourCard = buildExtendedActivityCardSkeleton({
    impactArea: "contour",
    ruleId: "CONTOUR_ACTIVITY_CARD",
    intentId: "CONTOUR_ACTIVITY_PICK",
    fallbackIntentId: "CONTOUR_FALLBACK_SAFE_MICRO",
    preferredFirstId: contourPreferred,
    evidenceKeys: ["flag:enableExtendedAreas", "intent:CONTOUR_ACTIVITY_PICK", "lookSpec.breakdown.contour.intent"],
  });

  const browCard = buildExtendedActivityCardSkeleton({
    impactArea: "brow",
    ruleId: "BROW_ACTIVITY_CARD",
    intentId: "BROW_ACTIVITY_PICK",
    fallbackIntentId: "BROW_FALLBACK_SAFE_MICRO",
    preferredFirstId: browPreferred,
    evidenceKeys: ["flag:enableExtendedAreas", "intent:BROW_ACTIVITY_PICK", "lookSpec.breakdown.brow.intent"],
  });

  const blushCard = buildExtendedActivityCardSkeleton({
    impactArea: "blush",
    ruleId: "BLUSH_ACTIVITY_CARD",
    intentId: "BLUSH_ACTIVITY_PICK",
    fallbackIntentId: "BLUSH_FALLBACK_SAFE_MICRO",
    preferredFirstId: blushPreferred,
    evidenceKeys: ["flag:enableExtendedAreas", "intent:BLUSH_ACTIVITY_PICK", "refFaceProfile.categorical.faceShape"],
  });

  return [
    ...(prepCard ? [prepCard] : []),
    outByArea.base!,
    ...(baseActivitySlot ? [baseActivitySlot] : []),
    ...(contourCard ? [contourCard] : []),
    ...(browCard ? [browCard] : []),
    outByArea.eye!,
    ...(eyeActivitySlot ? [eyeActivitySlot] : []),
    ...(blushCard ? [blushCard] : []),
    outByArea.lip!,
    ...(lipActivitySlot ? [lipActivitySlot] : []),
  ];
}

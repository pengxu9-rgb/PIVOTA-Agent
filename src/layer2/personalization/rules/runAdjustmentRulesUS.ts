import { z } from "zod";

import { AdjustmentSkeletonV0, AdjustmentSkeletonV0Schema } from "../../schemas/adjustmentSkeletonV0";
import { normalizeLookSpecToV1 } from "../../schemas/lookSpecV1";
import { getTechniqueIdsForIntent } from "../../dicts/intents";

import { PreferenceMode, US_ADJUSTMENT_FALLBACK_RULES, US_ADJUSTMENT_RULES } from "./usAdjustmentRules";

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

function extendedAreasEnabled(): boolean {
  return parseEnvBool(process.env.LAYER2_ENABLE_EXTENDED_AREAS) === true;
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
    becauseFacts: ["Extended areas enabled: include a safe starter technique for this area."],
    ...(doActionIds.length ? { doActionIds } : {}),
    doActions: [],
    whyMechanism: ["A single conservative technique keeps output stable while expanding coverage."],
    evidenceKeys: ["flag:LAYER2_ENABLE_EXTENDED_AREAS"],
    tags: ["extended_area", "fallback"],
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

  if (!extendedAreasEnabled()) {
    return [outByArea.base!, outByArea.eye!, outByArea.lip!];
  }

  const prep = buildExtendedFallbackSkeleton({ impactArea: "prep", ruleId: "PREP_FALLBACK_SAFE", intentId: "PREP_FALLBACK_SAFE" });
  const contour = buildExtendedFallbackSkeleton({ impactArea: "contour", ruleId: "CONTOUR_FALLBACK_SAFE", intentId: "CONTOUR_FALLBACK_SAFE" });
  const brow = buildExtendedFallbackSkeleton({ impactArea: "brow", ruleId: "BROW_FALLBACK_SAFE", intentId: "BROW_FALLBACK_SAFE" });
  const blush = buildExtendedFallbackSkeleton({ impactArea: "blush", ruleId: "BLUSH_FALLBACK_SAFE", intentId: "BLUSH_FALLBACK_SAFE" });

  return [prep, outByArea.base!, contour, brow, outByArea.eye!, blush, outByArea.lip!];
}

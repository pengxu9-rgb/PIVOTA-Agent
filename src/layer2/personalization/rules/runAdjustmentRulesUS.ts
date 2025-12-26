import { z } from "zod";

import { AdjustmentSkeletonV0, AdjustmentSkeletonV0Schema } from "../../schemas/adjustmentSkeletonV0";
import { LookSpecV0, LookSpecV0Schema } from "../../schemas/lookSpecV0";

import { PreferenceMode, US_ADJUSTMENT_FALLBACK_RULES, US_ADJUSTMENT_RULES } from "./usAdjustmentRules";

const PreferenceModeSchema = z.enum(["structure", "vibe", "ease"]);

export type RunAdjustmentRulesUSInput = {
  userFaceProfile?: unknown | null;
  refFaceProfile?: unknown | null;
  similarityReport?: unknown | null;
  lookSpec: unknown;
  preferenceMode: PreferenceMode;
};

export function runAdjustmentRulesUS(input: RunAdjustmentRulesUSInput): [AdjustmentSkeletonV0, AdjustmentSkeletonV0, AdjustmentSkeletonV0] {
  const lookSpec: LookSpecV0 = LookSpecV0Schema.parse(input.lookSpec);
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

  return [outByArea.base!, outByArea.eye!, outByArea.lip!];
}

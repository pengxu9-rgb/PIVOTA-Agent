import { AdjustmentSkeletonV0 } from "../../schemas/adjustmentSkeletonV0";
import { LookSpecV0 } from "../../schemas/lookSpecV0";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { FaceProfileV0Schema } = require("../../../layer1/schemas/faceProfileV0");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SimilarityReportV0Schema } = require("../../../layer1/schemas/similarityReportV0");

export type PreferenceMode = "structure" | "vibe" | "ease";

export type UsAdjustmentRuleContext = {
  userFaceProfile?: unknown | null;
  refFaceProfile?: unknown | null;
  similarityReport?: unknown | null;
  lookSpec: LookSpecV0;
  preferenceMode: PreferenceMode;
};

export type UsAdjustmentRule = {
  ruleId: string;
  impactArea: AdjustmentSkeletonV0["impactArea"];
  difficulty: number; // 0 (easiest) .. 1 (hardest)
  matches: (ctx: UsAdjustmentRuleContext) => boolean;
  build: (ctx: UsAdjustmentRuleContext) => AdjustmentSkeletonV0;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function baseConfidence(ctx: UsAdjustmentRuleContext): AdjustmentSkeletonV0["confidence"] {
  const user = ctx.userFaceProfile == null ? null : FaceProfileV0Schema.parse(ctx.userFaceProfile);
  const ref = ctx.refFaceProfile == null ? null : FaceProfileV0Schema.parse(ctx.refFaceProfile);
  if (!user || !ref) return "low";
  if (!user.quality?.valid) return "low";
  if (typeof user.quality?.score === "number" && user.quality.score < 70) return "low";
  return "medium";
}

function findTopDelta(similarityReport: unknown | null | undefined, keySuffix: string) {
  if (!similarityReport) return null;
  const sr = SimilarityReportV0Schema.parse(similarityReport);
  const deltas = Array.isArray(sr.topDeltas) ? sr.topDeltas : [];
  return deltas.find((d: any) => String(d?.key || "").endsWith(keySuffix)) ?? null;
}

function includesAny(haystack: string, needles: string[]): boolean {
  const s = String(haystack || "").toLowerCase();
  return needles.some((n) => s.includes(n.toLowerCase()));
}

export const RULE_TITLES_US: Record<string, string> = {
  // EYE
  EYE_LINER_DIRECTION_ADAPT: "Adapt liner direction",
  EYE_TIGHTLINE_AND_SMUDGE: "Keep liner thin + smudged",
  EYE_FALLBACK_SAFE_CONTROL: "Control liner safely",

  // BASE
  BASE_THIN_LAYERS_TARGET_GLOW: "Keep base thin + targeted glow",
  BASE_BUILD_COVERAGE_SPOT: "Build coverage in thin passes",
  BASE_FALLBACK_THIN_LAYER: "Keep base thin",

  // LIP
  LIP_GLOSS_CENTER_GRADIENT: "Add gloss focus at center",
  LIP_SOFT_EDGE_BLUR: "Soften lip edge",
  LIP_FALLBACK_FINISH_FOCUS: "Match lip finish",
};

export const US_ADJUSTMENT_RULES: readonly UsAdjustmentRule[] = [
  // === EYE ===
  {
    ruleId: "EYE_LINER_DIRECTION_ADAPT",
    impactArea: "eye",
    difficulty: 0.4,
    matches: (ctx) => {
      if (!ctx.userFaceProfile || !ctx.refFaceProfile) return false;
      const user = FaceProfileV0Schema.parse(ctx.userFaceProfile);
      const ref = FaceProfileV0Schema.parse(ctx.refFaceProfile);
      const diff = Math.abs(Number(user.geometry.eyeTiltDeg) - Number(ref.geometry.eyeTiltDeg));
      const top = findTopDelta(ctx.similarityReport, "geometry.eyeTiltDeg");
      const severity = top ? Number(top.severity || 0) : clamp01(diff / 10);
      return severity >= 0.35;
    },
    build: (ctx) => {
      const user = ctx.userFaceProfile ? FaceProfileV0Schema.parse(ctx.userFaceProfile) : null;
      const ref = ctx.refFaceProfile ? FaceProfileV0Schema.parse(ctx.refFaceProfile) : null;
      const top = findTopDelta(ctx.similarityReport, "geometry.eyeTiltDeg");
      const severity = clamp01(top ? Number(top.severity || 0.6) : user && ref ? Math.abs(user.geometry.eyeTiltDeg - ref.geometry.eyeTiltDeg) / 10 : 0.6);
      const isEase = ctx.preferenceMode === "ease";

      return {
        schemaVersion: "v0",
        market: "US",
        impactArea: "eye",
        ruleId: "EYE_LINER_DIRECTION_ADAPT",
        severity,
        confidence: baseConfidence(ctx),
        becauseFacts: [
          "The reference eye look relies on liner direction/wing control.",
          "Eye tilt differs between user and reference, so wing angle needs adjustment.",
        ],
        doActionIds: isEase
          ? ["T_EYE_LINER_OUTER_THIRD_START", "T_EYE_LINER_THIN_LINE", "T_EYE_WING_SHORTEN"]
          : ["T_EYE_LINER_OUTER_THIRD_START", "T_EYE_WING_SHORTEN", "T_EYE_WING_ANGLE_MORE_HORIZONTAL", "T_EYE_FILL_GAP_LASHLINE"],
        doActions: [],
        whyMechanism: [
          "A slightly more horizontal, shorter wing reduces emphasis on tilt differences while preserving the reference mood.",
        ],
        evidenceKeys: [
          "userFaceProfile.geometry.eyeTiltDeg",
          "refFaceProfile.geometry.eyeTiltDeg",
          ...(top?.evidence?.length ? ["similarityReport.topDeltas[*].evidence"] : []),
          "lookSpec.breakdown.eye.intent",
        ],
        safetyNotes: ["Avoid thick liner across the full lid; thickness can overwhelm the eye area."],
        tags: ["liner", "wing"],
      };
    },
  },
  {
    ruleId: "EYE_TIGHTLINE_AND_SMUDGE",
    impactArea: "eye",
    difficulty: 0.3,
    matches: (ctx) => {
      if (!ctx.userFaceProfile) return false;
      const user = FaceProfileV0Schema.parse(ctx.userFaceProfile);
      const openness = Number(user.geometry.eyeOpennessRatio);
      const wantsLiner = includesAny(ctx.lookSpec.breakdown.eye.intent, ["liner", "wing", "cat"]) || includesAny(ctx.lookSpec.breakdown.eye.finish, ["sharp", "defined"]);
      return wantsLiner && openness <= 0.32;
    },
    build: (ctx) => {
      const user = ctx.userFaceProfile ? FaceProfileV0Schema.parse(ctx.userFaceProfile) : null;
      const openness = user ? Number(user.geometry.eyeOpennessRatio) : 0.3;
      const severity = clamp01((0.35 - openness) / 0.15);
      const isEase = ctx.preferenceMode === "ease";
      return {
        schemaVersion: "v0",
        market: "US",
        impactArea: "eye",
        ruleId: "EYE_TIGHTLINE_AND_SMUDGE",
        severity,
        confidence: baseConfidence(ctx),
        becauseFacts: ["The lid space is limited, so thick liner can take over the eye area.", "The reference calls for noticeable eye emphasis."],
        doActionIds: isEase
          ? ["T_EYE_TIGHTLINE_UPPER_LASHLINE", "T_EYE_SMUDGE_OUTER_CORNER", "T_EYE_LINER_THIN_LINE"]
          : ["T_EYE_TIGHTLINE_UPPER_LASHLINE", "T_EYE_SMUDGE_OUTER_CORNER", "T_EYE_FILL_GAP_LASHLINE", "T_EYE_LINER_THIN_LINE"],
        doActions: [],
        whyMechanism: ["Tightlining keeps definition at the lash line without consuming lid space; smudging adds emphasis with less heaviness."],
        evidenceKeys: ["userFaceProfile.geometry.eyeOpennessRatio", "lookSpec.breakdown.eye.intent"],
        safetyNotes: ["If your eyes are sensitive, skip waterline and tightline just at the lashes."],
        tags: ["tightline", "smudge"],
      };
    },
  },

  // === BASE ===
  {
    ruleId: "BASE_THIN_LAYERS_TARGET_GLOW",
    impactArea: "base",
    difficulty: 0.2,
    matches: (ctx) => includesAny(ctx.lookSpec.breakdown.base.finish, ["dewy", "glow", "radiant"]),
    build: (ctx) => {
      const isEase = ctx.preferenceMode === "ease";
      return {
        schemaVersion: "v0",
        market: "US",
        impactArea: "base",
        ruleId: "BASE_THIN_LAYERS_TARGET_GLOW",
        severity: 0.6,
        confidence: baseConfidence(ctx),
        becauseFacts: ["The reference base finish is dewy/radiant.", "A thin base keeps texture controlled while still allowing glow."],
        doActionIds: isEase
          ? ["T_BASE_HYDRATE_PREP", "T_BASE_THIN_LAYER", "T_BASE_TARGET_GLOW_HIGHLIGHTS", "T_BASE_SET_TZONE_LIGHT"]
          : ["T_BASE_HYDRATE_PREP", "T_BASE_THIN_LAYER", "T_BASE_SPOT_CONCEAL_ONLY", "T_BASE_TARGET_GLOW_HIGHLIGHTS", "T_BASE_SET_TZONE_LIGHT"],
        doActions: [],
        whyMechanism: ["Targeting glow keeps the finish aligned with the reference without amplifying texture everywhere."],
        evidenceKeys: ["lookSpec.breakdown.base.finish", "lookSpec.breakdown.base.intent"],
        safetyNotes: ["Avoid heavy powder over glow areas; it can flatten the intended finish."],
        tags: ["dewy", "thin-layers"],
      };
    },
  },
  {
    ruleId: "BASE_BUILD_COVERAGE_SPOT",
    impactArea: "base",
    difficulty: 0.3,
    matches: (ctx) => includesAny(ctx.lookSpec.breakdown.base.coverage, ["full", "high", "medium-full"]),
    build: (ctx) => ({
      schemaVersion: "v0",
      market: "US",
      impactArea: "base",
      ruleId: "BASE_BUILD_COVERAGE_SPOT",
      severity: 0.7,
      confidence: baseConfidence(ctx),
      becauseFacts: ["The reference base coverage is higher.", "Building coverage in thin passes reduces caking while still matching the reference."],
      doActionIds: ["T_BASE_BUILD_COVERAGE_THIN_PASSES", "T_BASE_SPOT_CONCEAL_ONLY", "T_BASE_SET_TZONE_LIGHT", "T_BASE_MIST_MELT"],
      doActions: [],
      whyMechanism: ["Thin passes reduce buildup while letting you reach the desired coverage level."],
      evidenceKeys: ["lookSpec.breakdown.base.coverage", "lookSpec.breakdown.base.finish"],
      safetyNotes: ["If the base starts to look heavy, stop layering and spot-correct instead."],
      tags: ["coverage"],
    }),
  },

  // === LIP ===
  {
    ruleId: "LIP_GLOSS_CENTER_GRADIENT",
    impactArea: "lip",
    difficulty: 0.2,
    matches: (ctx) => {
      if (!includesAny(ctx.lookSpec.breakdown.lip.finish, ["gloss", "glossy"])) return false;
      if (!ctx.userFaceProfile) return true; // safe if selfie missing: still a gentle gloss focus
      const user = FaceProfileV0Schema.parse(ctx.userFaceProfile);
      const lipRatio = Number(user.geometry.lipFullnessRatio);
      return lipRatio <= 0.32 || String(user.categorical?.lipType || "") === "thin";
    },
    build: (ctx) => {
      const user = ctx.userFaceProfile ? FaceProfileV0Schema.parse(ctx.userFaceProfile) : null;
      const lipRatio = user ? Number(user.geometry.lipFullnessRatio) : 0.3;
      const severity = clamp01((0.35 - lipRatio) / 0.15);
      return {
        schemaVersion: "v0",
        market: "US",
        impactArea: "lip",
        ruleId: "LIP_GLOSS_CENTER_GRADIENT",
        severity,
        confidence: baseConfidence(ctx),
        becauseFacts: ["The reference lip finish is glossy.", "A center-focused gloss effect is a safe way to match finish and enhance shape without over-lining."],
        doActionIds: ["T_LIP_SOFT_EDGE", "T_LIP_GLOSS_CENTER", "T_LIP_SHADE_CLOSE_FAMILY"],
        doActions: [],
        whyMechanism: ["Center gloss increases dimension and keeps the glossy finish aligned with the reference."],
        evidenceKeys: ["lookSpec.breakdown.lip.finish", ...(ctx.userFaceProfile ? ["userFaceProfile.geometry.lipFullnessRatio"] : [])],
        safetyNotes: ["Avoid heavy over-lining; keep changes subtle to stay faithful to the reference."],
        tags: ["gloss"],
      };
    },
  },
  {
    ruleId: "LIP_SOFT_EDGE_BLUR",
    impactArea: "lip",
    difficulty: 0.3,
    matches: (ctx) => includesAny(ctx.lookSpec.breakdown.lip.intent, ["soft", "blur", "diffused"]) || includesAny(ctx.lookSpec.breakdown.lip.finish, ["satin", "matte"]),
    build: (ctx) => ({
      schemaVersion: "v0",
      market: "US",
      impactArea: "lip",
      ruleId: "LIP_SOFT_EDGE_BLUR",
      severity: 0.45,
      confidence: baseConfidence(ctx),
      becauseFacts: ["The reference lip reads softer/diffused.", "A blurred edge stays within the reference vibe without requiring exact lip shape."],
      doActionIds: ["T_LIP_BLUR_EDGE", "T_LIP_CENTER_STRONGER", "T_LIP_MATCH_FINISH"],
      doActions: [],
      whyMechanism: ["Soft edges reduce shape sensitivity and keep the lip mood consistent with the reference."],
      evidenceKeys: ["lookSpec.breakdown.lip.intent", "lookSpec.breakdown.lip.finish"],
      safetyNotes: ["If unsure on shade, stay within a close shade family rather than jumping to a different hue."],
      tags: ["soft-edge"],
    }),
  },
];

export const US_ADJUSTMENT_FALLBACK_RULES: Record<AdjustmentSkeletonV0["impactArea"], UsAdjustmentRule> = {
  base: {
    ruleId: "BASE_FALLBACK_THIN_LAYER",
    impactArea: "base",
    difficulty: 0.1,
    matches: () => true,
    build: (ctx) => ({
      schemaVersion: "v0",
      market: "US",
      impactArea: "base",
      ruleId: "BASE_FALLBACK_THIN_LAYER",
      severity: 0.2,
      confidence: baseConfidence(ctx),
      becauseFacts: ["A thin base is the safest path to preserve texture and match the reference finish."],
      doActionIds: ["T_BASE_THIN_LAYER", "T_BASE_SPOT_CONCEAL_ONLY", "T_BASE_SET_TZONE_LIGHT"],
      doActions: [],
      whyMechanism: ["Thin layers are more forgiving and keep the finish closer to the reference."],
      evidenceKeys: ["lookSpec.breakdown.base.finish"],
      tags: ["fallback"],
    }),
  },
  eye: {
    ruleId: "EYE_FALLBACK_SAFE_CONTROL",
    impactArea: "eye",
    difficulty: 0.1,
    matches: () => true,
    build: (ctx) => ({
      schemaVersion: "v0",
      market: "US",
      impactArea: "eye",
      ruleId: "EYE_FALLBACK_SAFE_CONTROL",
      severity: 0.2,
      confidence: baseConfidence(ctx),
      becauseFacts: ["Liner direction strongly affects the eye emphasis, so keep control and stay subtle."],
      doActionIds: ["T_EYE_LINER_OUTER_THIRD_START", "T_EYE_LINER_THIN_LINE", "T_EYE_WING_SHORTEN"],
      doActions: [],
      whyMechanism: ["A thin, short wing is forgiving and still aligns with many reference looks."],
      evidenceKeys: ["lookSpec.breakdown.eye.intent"],
      tags: ["fallback"],
    }),
  },
  lip: {
    ruleId: "LIP_FALLBACK_FINISH_FOCUS",
    impactArea: "lip",
    difficulty: 0.1,
    matches: () => true,
    build: (ctx) => ({
      schemaVersion: "v0",
      market: "US",
      impactArea: "lip",
      ruleId: "LIP_FALLBACK_FINISH_FOCUS",
      severity: 0.2,
      confidence: baseConfidence(ctx),
      becauseFacts: ["Lip finish (gloss/satin/matte) is the most reliable match when details are uncertain."],
      doActionIds: ["T_LIP_MATCH_FINISH", "T_LIP_SHADE_CLOSE_FAMILY", "T_LIP_BLOT_ADJUST"],
      doActions: [],
      whyMechanism: ["Finish carries the lip mood more reliably than precise shape tweaks."],
      evidenceKeys: ["lookSpec.breakdown.lip.finish"],
      tags: ["fallback"],
    }),
  },
};

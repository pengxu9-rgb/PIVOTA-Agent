import { z } from "zod";
import { StepPlanV0Schema } from "../layer2/schemas/stepPlanV0";
import { KitPlanV0Schema } from "../layer3/schemas/kitPlanV0";
import { LookSpecBreakdownAreaV0Schema } from "../layer2/schemas/lookSpecV0";

export const ImpactAreaSchema = z.enum(["base", "eye", "lip"]);

export const AdjustmentV0Schema = z
  .object({
    impactArea: ImpactAreaSchema,
    title: z.string().min(1),
    because: z.string().min(1),
    do: z.string().min(1),
    why: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

export const AdjustmentCandidateAreaV0Schema = z.enum([
  "prep",
  "base",
  "contour",
  "brow",
  "eye",
  "blush",
  "lip",
]);

export const AdjustmentCandidateV0Schema = z
  .object({
    id: z.string().min(1),
    area: AdjustmentCandidateAreaV0Schema,
    title: z.string().min(1),
    why: z.string().min(1).max(120),
    techniqueId: z.string().min(1).nullable(),
    ruleId: z.string().min(1).nullable(),
    score: z.number().min(0).max(1),
    rank: z.number().int().min(1).max(7),
    isDefault: z.boolean(),
    gating: z
      .object({
        status: z.enum([
          "ok",
          "low_confidence",
          "low_coverage",
          "fallback_only",
        ]),
        reason: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ShareInfoV0Schema = z
  .object({
    shareId: z.string().min(1),
    canonicalUrl: z.string().url().optional(),
  })
  .strict();

export const LookReplicateResultV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: z.enum(["US", "JP"]),
    locale: z.string().min(1),

    layer2EngineVersion: z.union([z.literal("l2-us-0.1.0"), z.literal("l2-jp-0.1.0")]),
    layer3EngineVersion: z.union([z.literal("l3-us-0.1.0"), z.literal("l3-jp-0.1.0")]),
    orchestratorVersion: z.union([z.literal("orchestrator-us-0.1.0"), z.literal("orchestrator-jp-0.1.0")]),

    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV0Schema,
        eye: LookSpecBreakdownAreaV0Schema,
        lip: LookSpecBreakdownAreaV0Schema,
      })
      .strict(),

    adjustments: z
      .array(AdjustmentV0Schema)
      .length(3)
      .refine(
        (items) => new Set(items.map((i) => i.impactArea)).size === 3,
        "adjustments must include exactly one per impactArea"
      ),

    steps: z.array(StepPlanV0Schema).min(8).max(12),

    kit: KitPlanV0Schema,

    warnings: z.array(z.string().min(1)).optional(),
    share: ShareInfoV0Schema.optional(),
    commerceEnabled: z.boolean().optional(),
    adjustmentCandidates: z.array(AdjustmentCandidateV0Schema).max(7).optional(),
    experiments: z
      .object({
        variant: z.string().min(1).optional(),
        explorationRate: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LookReplicateResultV0 = z.infer<typeof LookReplicateResultV0Schema>;

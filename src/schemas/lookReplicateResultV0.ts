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
  })
  .strict();

export type LookReplicateResultV0 = z.infer<typeof LookReplicateResultV0Schema>;

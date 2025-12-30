import { z } from "zod";

export const AdjustmentSkeletonImpactAreaSchema = z.enum([
  "prep",
  "base",
  "contour",
  "brow",
  "eye",
  "blush",
  "lip",
]);
export type AdjustmentSkeletonImpactArea = z.infer<typeof AdjustmentSkeletonImpactAreaSchema>;

export const AdjustmentSkeletonConfidenceSchema = z.enum(["high", "medium", "low"]);
export type AdjustmentSkeletonConfidence = z.infer<typeof AdjustmentSkeletonConfidenceSchema>;

export const AdjustmentSkeletonDoActionSelectionSchema = z.enum(["sequence", "choose_one"]);
export type AdjustmentSkeletonDoActionSelection = z.infer<typeof AdjustmentSkeletonDoActionSelectionSchema>;

export const AdjustmentSkeletonV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: z.enum(["US", "JP"]),
    impactArea: AdjustmentSkeletonImpactAreaSchema,

    ruleId: z.string().min(1),
    severity: z.number().min(0).max(1),
    confidence: AdjustmentSkeletonConfidenceSchema,

    becauseFacts: z.array(z.string().min(1)).min(1),
    // Backward compatible: rule engine can emit `doActionIds` first, and a later renderer can fill `doActions`.
    // Default semantics for doActionIds: ordered sequence.
    doActionSelection: AdjustmentSkeletonDoActionSelectionSchema.optional(),
    doActionIds: z.array(z.string().min(1)).min(1).optional(),
    // Resolved selection ids (after choose_one), used to re-localize without re-running trigger selection.
    selectedDoActionIds: z.array(z.string().min(1)).min(1).optional(),
    doActions: z.array(z.string().min(1)).default([]),
    whyMechanism: z.array(z.string().min(1)).min(1),
    evidenceKeys: z.array(z.string().min(1)).min(1),

    // Optional references to technique cards used to render actions.
    techniqueRefs: z
      .array(
        z
          .object({
            id: z.string().min(1),
            area: AdjustmentSkeletonImpactAreaSchema,
          })
          .strict()
      )
      .optional(),

    // Optional lightweight technique card snapshots for UI rendering.
    techniqueCards: z
      .array(
        z
          .object({
            id: z.string().min(1),
            resolvedId: z.string().min(1).optional(),
            title: z.string().min(1).optional(),
            steps: z.array(z.string().min(1)).optional(),
            rationale: z.array(z.string().min(1)).optional(),
          })
          .strict()
      )
      .optional(),

    safetyNotes: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type AdjustmentSkeletonV0 = z.infer<typeof AdjustmentSkeletonV0Schema>;

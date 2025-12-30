const { z } = require('zod');

const AdjustmentSkeletonImpactAreaSchema = z.enum(['prep', 'base', 'contour', 'brow', 'eye', 'blush', 'lip']);
const AdjustmentSkeletonConfidenceSchema = z.enum(['high', 'medium', 'low']);
const AdjustmentSkeletonDoActionSelectionSchema = z.enum(['sequence', 'choose_one']);

const AdjustmentSkeletonV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: z.enum(['US', 'JP']),
    impactArea: AdjustmentSkeletonImpactAreaSchema,

    ruleId: z.string().min(1),
    severity: z.number().min(0).max(1),
    confidence: AdjustmentSkeletonConfidenceSchema,

    becauseFacts: z.array(z.string().min(1)).min(1),
    doActionSelection: AdjustmentSkeletonDoActionSelectionSchema.optional(),
    doActionIds: z.array(z.string().min(1)).min(1).optional(),
    selectedDoActionIds: z.array(z.string().min(1)).min(1).optional(),
    doActions: z.array(z.string().min(1)).default([]),
    whyMechanism: z.array(z.string().min(1)).min(1),
    evidenceKeys: z.array(z.string().min(1)).min(1),

    techniqueRefs: z
      .array(
        z
          .object({
            id: z.string().min(1),
            area: AdjustmentSkeletonImpactAreaSchema,
          })
          .strict(),
      )
      .optional(),

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
          .strict(),
      )
      .optional(),

    safetyNotes: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

module.exports = {
  AdjustmentSkeletonImpactAreaSchema,
  AdjustmentSkeletonConfidenceSchema,
  AdjustmentSkeletonDoActionSelectionSchema,
  AdjustmentSkeletonV0Schema,
};

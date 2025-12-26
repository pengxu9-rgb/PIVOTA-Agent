const { z } = require('zod');

const AdjustmentSkeletonImpactAreaSchema = z.enum(['base', 'eye', 'lip']);
const AdjustmentSkeletonConfidenceSchema = z.enum(['high', 'medium', 'low']);

const AdjustmentSkeletonV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: z.literal('US'),
    impactArea: AdjustmentSkeletonImpactAreaSchema,

    ruleId: z.string().min(1),
    severity: z.number().min(0).max(1),
    confidence: AdjustmentSkeletonConfidenceSchema,

    becauseFacts: z.array(z.string().min(1)).min(1),
    doActions: z.array(z.string().min(1)).min(1),
    whyMechanism: z.array(z.string().min(1)).min(1),
    evidenceKeys: z.array(z.string().min(1)).min(1),

    safetyNotes: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

module.exports = {
  AdjustmentSkeletonImpactAreaSchema,
  AdjustmentSkeletonConfidenceSchema,
  AdjustmentSkeletonV0Schema,
};

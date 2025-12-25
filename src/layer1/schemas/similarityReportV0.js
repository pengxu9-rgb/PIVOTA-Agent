const { z } = require('zod');

const PreferenceModeSchema = z.enum(['structure', 'vibe', 'ease']);
const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

const ReasonSchema = z
  .object({
    title: z.string().min(1),
    copy: z.string().min(1),
    evidence: z.array(z.string()).min(1),
  })
  .strict();

const DeltaSchema = z
  .object({
    key: z.string().min(1),
    userValue: z.union([z.number(), z.string(), z.null()]),
    refValue: z.union([z.number(), z.string()]),
    severity: z.number().min(0).max(1),
    explanationKey: z.string().min(1),
    evidence: z.array(z.string()).min(1),
  })
  .strict();

const AdjustmentSchema = z
  .object({
    impactArea: z.enum(['base', 'eye', 'lip']),
    title: z.string().min(1),
    because: z.string().min(1),
    do: z.string().min(1),
    confidence: ConfidenceSchema,
    evidence: z.array(z.string()).min(1),
  })
  .strict();

const SimilarityReportV0Schema = z
  .object({
    version: z.literal('v0'),
    schemaVersion: z.literal('v0'),
    engineVersion: z.string().min(1),
    market: z.literal('US'),
    preferenceMode: PreferenceModeSchema,
    confidence: ConfidenceSchema,
    fitScore: z.number().min(0).max(100),
    scoreBreakdown: z
      .object({
        geometryFit: z.number().min(0).max(60),
        riskPenalty: z.number().min(0).max(25),
        adaptabilityBonus: z.number().min(0).max(15),
      })
      .strict(),
    reasons: z.tuple([ReasonSchema, ReasonSchema, ReasonSchema]),
    topDeltas: z.array(DeltaSchema).max(5),
    adjustments: z.tuple([AdjustmentSchema, AdjustmentSchema, AdjustmentSchema]),
    layer2Hints: z
      .object({
        base: z.array(z.string()).optional(),
        eye: z.array(z.string()).optional(),
        lip: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    userControls: z
      .object({
        modes: z
          .array(
            z
              .object({
                mode: PreferenceModeSchema,
                label: z.string().min(1),
                description: z.string().min(1),
              })
              .strict(),
          )
          .min(3),
        defaultMode: z.literal('structure'),
      })
      .strict(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

module.exports = {
  SimilarityReportV0Schema,
  PreferenceModeSchema,
  ConfidenceSchema,
};

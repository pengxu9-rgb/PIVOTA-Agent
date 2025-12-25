const { z } = require('zod');

const { FaceProfileV0Schema } = require('./faceProfileV0');
const { SimilarityReportV0Schema, PreferenceModeSchema } = require('./similarityReportV0');

const Layer1BundleV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: z.literal('US'),
    locale: z.string().min(1),
    preferenceMode: PreferenceModeSchema,
    createdAt: z.string().datetime(),
    userFaceProfile: FaceProfileV0Schema.nullable().optional(),
    refFaceProfile: FaceProfileV0Schema,
    similarityReport: SimilarityReportV0Schema,
  })
  .strict()
  .superRefine((bundle, ctx) => {
    if (bundle.similarityReport.market !== 'US') {
      ctx.addIssue({ code: 'custom', message: 'similarityReport.market must be US' });
    }
    if (bundle.similarityReport.preferenceMode !== bundle.preferenceMode) {
      ctx.addIssue({ code: 'custom', message: 'preferenceMode must match similarityReport.preferenceMode' });
    }
    // Defensive invariants (SimilarityReportV0Schema already enforces tuples).
    if (!Array.isArray(bundle.similarityReport.reasons) || bundle.similarityReport.reasons.length !== 3) {
      ctx.addIssue({ code: 'custom', message: 'similarityReport.reasons must have length 3' });
    }
    if (!Array.isArray(bundle.similarityReport.adjustments) || bundle.similarityReport.adjustments.length !== 3) {
      ctx.addIssue({ code: 'custom', message: 'similarityReport.adjustments must have length 3' });
    }
  });

module.exports = {
  Layer1BundleV0Schema,
};


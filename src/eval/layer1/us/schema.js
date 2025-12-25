const { z } = require('zod');
const { FaceProfileV0Schema } = require('../../../layer1/schemas/faceProfileV0');
const { PreferenceModeSchema } = require('../../../layer1/schemas/similarityReportV0');

const EvalSampleSchema = z
  .object({
    id: z.string().min(1),
    market: z.literal('US'),
    locale: z.string().min(1),
    preferenceMode: PreferenceModeSchema,
    userFaceProfile: FaceProfileV0Schema.nullable().optional(),
    refFaceProfile: FaceProfileV0Schema,
    labels: z.record(z.any()).optional(),
  })
  .strict();

module.exports = {
  EvalSampleSchema,
};


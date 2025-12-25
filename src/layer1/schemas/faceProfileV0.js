const { z } = require('zod');

const MarketSchema = z.literal('US');
const SourceSchema = z.enum(['selfie', 'reference']);

const PoseSchema = z
  .object({
    yawDeg: z.number(),
    pitchDeg: z.number(),
    rollDeg: z.number(),
  })
  .strict();

const FaceQualitySchema = z
  .object({
    valid: z.boolean(),
    score: z.number().min(0).max(100),
    faceCount: z.number().int().min(0).max(10),
    lightingScore: z.number().min(0).max(100),
    sharpnessScore: z.number().min(0).max(100),
    pose: PoseSchema,
    occlusionFlags: z
      .object({
        eyesOccluded: z.boolean(),
        mouthOccluded: z.boolean(),
        faceBorderCutoff: z.boolean(),
      })
      .strict(),
    rejectReasons: z.array(z.string()),
  })
  .strict();

const FaceGeometrySchema = z
  .object({
    faceAspect: z.number(),
    jawToCheekRatio: z.number(),
    chinLengthRatio: z.number(),
    midfaceRatio: z.number(),
    eyeSpacingRatio: z.number(),
    eyeTiltDeg: z.number(),
    eyeOpennessRatio: z.number(),
    lipFullnessRatio: z.number(),
  })
  .strict();

const FaceCategoricalSchema = z
  .object({
    faceShape: z.enum(['round', 'oval', 'square', 'heart', 'long', 'unknown']),
    eyeType: z.enum(['almond', 'round', 'downturned', 'upturned', 'hooded_like', 'unknown']),
    lipType: z.enum(['thin', 'balanced', 'full', 'unknown']),
  })
  .strict();

const FaceDerivedSchema = z
  .object({
    geometryVector: z.array(z.number()).length(8),
    embeddingVersion: z.literal('geom-v0'),
  })
  .strict();

const FaceProfileV0Schema = z
  .object({
    version: z.literal('v0'),
    market: MarketSchema,
    source: SourceSchema,
    locale: z.string().min(1),
    quality: FaceQualitySchema,
    geometry: FaceGeometrySchema,
    categorical: FaceCategoricalSchema,
    derived: FaceDerivedSchema,
  })
  .strict();

module.exports = {
  FaceProfileV0Schema,
};


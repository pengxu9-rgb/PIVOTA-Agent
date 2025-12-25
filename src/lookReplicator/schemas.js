const { z } = require('zod');

const MarketSchema = z.enum(['NA', 'JP']).default('NA');
const LocaleSchema = z.enum(['en', 'ja']).default('en');

const CreateSignedUploadSchema = z.object({
  kind: z.enum(['reference', 'selfie']),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.coerce.number().int().positive(),
  market: MarketSchema.optional(),
  locale: LocaleSchema.optional(),
});

const CreateLookJobSchema = z.object({
  referenceImageUrl: z.string().url(),
  selfieImageUrl: z.string().url().optional(),
  undertone: z.string().optional(),
  market: MarketSchema.optional(),
  locale: LocaleSchema.optional(),
});

module.exports = {
  MarketSchema,
  LocaleSchema,
  CreateSignedUploadSchema,
  CreateLookJobSchema,
};


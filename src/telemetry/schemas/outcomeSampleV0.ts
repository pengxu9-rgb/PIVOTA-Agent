import { z } from 'zod';

export const MarketSchema = z.enum(['US', 'JP']);
export const AreaSchema = z.enum(['base', 'eye', 'lip']);
export const PreferenceModeSchema = z.enum(['structure', 'vibe', 'ease']);

export const EngineVersionsSchema = z
  .object({
    layer1: z.string().min(1).optional(),
    layer2: z.string().min(1),
    layer3: z.string().min(1),
  })
  .strict();

export const SignalsSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    issueTags: z.array(z.enum(['base', 'eye', 'lip', 'other'])).optional(),
    shared: z.boolean().optional(),
    addToCart: z.boolean().optional(),
    checkoutStarted: z.boolean().optional(),
    checkoutSuccess: z.boolean().optional(),
  })
  .strict();

export const QualityFlagsSchema = z
  .object({
    lookSpecLowConfidence: z.boolean(),
    anyAdjustmentLowConfidence: z.boolean(),
    anyFallbackUsed: z.boolean(),
  })
  .strict();

export const UsedTechniqueSchema = z
  .object({
    id: z.string().min(1),
    area: AreaSchema,
  })
  .strict();

export const UsedRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    area: AreaSchema,
  })
  .strict();

export const ContextFingerprintSchema = z
  .object({
    faceShape: z.string().min(1).optional(),
    eyeType: z.string().min(1).optional(),
    lipType: z.string().min(1).optional(),
    linerDirection: z.string().min(1).optional(),
    baseFinish: z.string().min(1).optional(),
    lipFinish: z.string().min(1).optional(),
    vibeTags: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ReplayContextSchema = z
  .object({
    adjustmentSkeletons: z.array(z.unknown()).optional(),
  })
  .strict()
  .optional();

export const GeminiTelemetryLegacySchema = z
  .object({
    reference: z
      .object({
        okCount: z.number().int().min(0),
        failCount: z.number().int().min(0),
        lastErrorCode: z.string().min(1).nullable(),
        latencyMs: z.number().int().min(0).nullable(),
      })
      .strict(),
    selfie: z
      .object({
        okCount: z.number().int().min(0),
        failCount: z.number().int().min(0),
        lastErrorCode: z.string().min(1).nullable(),
        latencyMs: z.number().int().min(0).nullable(),
      })
      .strict(),
    lookDiffSource: z.enum(['layer1', 'gemini', 'pipeline_fallback']).nullable(),
  })
  .strict();

export const GeminiCallTelemetrySchema = z
  .object({
    enabled: z.boolean(),
    attempted: z.boolean(),
    ok: z.boolean().nullable(),
    errorCode: z.string().min(1).nullable(),
    latencyMs: z.number().int().min(0).nullable(),
    retries: z.number().int().min(0).nullable(),
    model: z.string().min(1).nullable(),
  })
  .strict();

export const GeminiLimiterSchema = z
  .object({
    concurrencyMax: z.number().int().min(1),
    ratePerMin: z.number().int().min(0),
    circuitOpen: z.boolean(),
  })
  .strict();

export const GeminiTelemetrySchema = z
  .union([
    GeminiTelemetryLegacySchema,
    z
      .object({
        limiter: GeminiLimiterSchema,
        reference: GeminiCallTelemetrySchema,
        selfie: GeminiCallTelemetrySchema,
        lookDiffSource: z.enum(['layer1', 'gemini', 'pipeline_fallback']).nullable(),
        lookDiff: z.unknown().nullable(),
      })
      .strict(),
  ])
  .optional();

export const OutcomeSampleV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: MarketSchema,
    jobId: z.string().min(1),
    sessionIdHash: z.string().min(1).optional(),
    locale: z.string().min(1),
    preferenceMode: PreferenceModeSchema,
    createdAt: z.string().datetime(),
    engineVersions: EngineVersionsSchema,
    signals: SignalsSchema,
    qualityFlags: QualityFlagsSchema,
    usedTechniques: z.array(UsedTechniqueSchema),
    usedRules: z.array(UsedRuleSchema),
    contextFingerprint: ContextFingerprintSchema,
    replayContext: ReplayContextSchema,
    gemini: GeminiTelemetrySchema,
  })
  .strict();

export type OutcomeSampleV0 = z.infer<typeof OutcomeSampleV0Schema>;

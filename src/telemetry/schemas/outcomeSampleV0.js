const { z } = require('zod');

const MarketSchema = z.literal('US');
const AreaSchema = z.enum(['base', 'eye', 'lip']);
const PreferenceModeSchema = z.enum(['structure', 'vibe', 'ease']);

const EngineVersionsSchema = z
  .object({
    layer1: z.string().min(1).optional(),
    layer2: z.string().min(1),
    layer3: z.string().min(1),
  })
  .strict();

const SignalsSchema = z
  .object({
    rating: z.number().int().min(1).max(5).optional(),
    issueTags: z.array(z.enum(['base', 'eye', 'lip', 'other'])).optional(),
    shared: z.boolean().optional(),
    addToCart: z.boolean().optional(),
    checkoutStarted: z.boolean().optional(),
    checkoutSuccess: z.boolean().optional(),
  })
  .strict();

const QualityFlagsSchema = z
  .object({
    lookSpecLowConfidence: z.boolean(),
    anyAdjustmentLowConfidence: z.boolean(),
    anyFallbackUsed: z.boolean(),
  })
  .strict();

const UsedTechniqueSchema = z
  .object({
    id: z.string().min(1),
    area: AreaSchema,
  })
  .strict();

const UsedRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    area: AreaSchema,
  })
  .strict();

const ContextFingerprintSchema = z
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

// Optional replay context: derived-only artifacts used for deterministic replay without images.
const ReplayContextSchema = z
  .object({
    adjustmentSkeletons: z.array(z.unknown()).optional(),
  })
  .strict()
  .optional();

const OutcomeSampleV0Schema = z
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
  })
  .strict();

module.exports = {
  AreaSchema,
  PreferenceModeSchema,
  OutcomeSampleV0Schema,
  UsedTechniqueSchema,
  UsedRuleSchema,
};


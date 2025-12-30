const { z } = require('zod');

const { LookSpecLinerDirectionSchema, LookSpecV0Schema, ShadeProfileV0Schema, UnknownLookSpecBreakdownAreaV0 } = require('./lookSpecV0');

const LookSpecBreakdownAreaV1Schema = z
  .object({
    intent: z.string().min(1),
    finish: z.string().min(1),
    coverage: z.string().min(1),
    shade: ShadeProfileV0Schema.default({
      hueFamily: 'unknown',
      temperature: 'unknown',
      undertone: 'unknown',
      depth: 'unknown',
      saturation: 'unknown',
      keyColors: [],
      notes: [],
    }),
    keyNotes: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

const LookSpecBreakdownEyeV1Schema = LookSpecBreakdownAreaV1Schema.extend({
  linerDirection: LookSpecLinerDirectionSchema.default({ direction: 'unknown' }),
  shadowShape: z.string().min(1).optional(),
}).strict();

const LookSpecBreakdownContourV1Schema = LookSpecBreakdownAreaV1Schema.extend({
  highlight: z
    .object({
      intensity: z.string().min(1),
    })
    .strict()
    .optional(),
}).strict();

const UnknownLookSpecBreakdownAreaV1 = UnknownLookSpecBreakdownAreaV0;

const LookSpecV1Schema = z
  .object({
    schemaVersion: z.literal('v1'),
    market: z.enum(['US', 'JP']),
    locale: z.string().min(1),

    layer2EngineVersion: z.union([z.literal('l2-us-0.1.0'), z.literal('l2-jp-0.1.0')]),
    layer3EngineVersion: z.union([z.literal('l3-us-0.1.0'), z.literal('l3-jp-0.1.0')]),
    orchestratorVersion: z.union([z.literal('orchestrator-us-0.1.0'), z.literal('orchestrator-jp-0.1.0')]),

    lookTitle: z.string().min(1).optional(),
    styleTags: z.array(z.string().min(1)).default([]),

    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV1Schema,
        eye: LookSpecBreakdownEyeV1Schema,
        lip: LookSpecBreakdownAreaV1Schema,
        prep: LookSpecBreakdownAreaV1Schema.default(UnknownLookSpecBreakdownAreaV1),
        brow: LookSpecBreakdownAreaV1Schema.default(UnknownLookSpecBreakdownAreaV1),
        blush: LookSpecBreakdownAreaV1Schema.default(UnknownLookSpecBreakdownAreaV1),
        contour: LookSpecBreakdownContourV1Schema.default(UnknownLookSpecBreakdownAreaV1),
      })
      .strict(),

    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();

const LookSpecAnySchema = z.union([LookSpecV0Schema, LookSpecV1Schema]);

function normalizeLookSpecToV1(input) {
  const parsed = LookSpecAnySchema.parse(input);
  if (parsed.schemaVersion === 'v1') return parsed;
  return LookSpecV1Schema.parse({ ...parsed, schemaVersion: 'v1' });
}

module.exports = {
  LookSpecBreakdownEyeV1Schema,
  LookSpecBreakdownAreaV1Schema,
  LookSpecBreakdownContourV1Schema,
  LookSpecV1Schema,
  LookSpecAnySchema,
  normalizeLookSpecToV1,
};

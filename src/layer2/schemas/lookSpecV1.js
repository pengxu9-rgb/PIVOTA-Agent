const { z } = require('zod');

const { LookSpecV0Schema } = require('./lookSpecV0');

const LookSpecBreakdownAreaV1Schema = z
  .object({
    intent: z.string().min(1),
    finish: z.string().min(1),
    coverage: z.string().min(1),
    keyNotes: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

const LookSpecBreakdownContourV1Schema = LookSpecBreakdownAreaV1Schema.extend({
  highlight: z
    .object({
      intensity: z.string().min(1),
    })
    .strict()
    .optional(),
}).strict();

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
        eye: LookSpecBreakdownAreaV1Schema,
        lip: LookSpecBreakdownAreaV1Schema,
        prep: LookSpecBreakdownAreaV1Schema.optional(),
        brow: LookSpecBreakdownAreaV1Schema.optional(),
        blush: LookSpecBreakdownAreaV1Schema.optional(),
        contour: LookSpecBreakdownContourV1Schema.optional(),
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
  LookSpecBreakdownAreaV1Schema,
  LookSpecBreakdownContourV1Schema,
  LookSpecV1Schema,
  LookSpecAnySchema,
  normalizeLookSpecToV1,
};


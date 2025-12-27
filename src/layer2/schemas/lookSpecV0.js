const { z } = require('zod');

const LookAreaSchema = z.enum(['base', 'eye', 'lip']);

const LookSpecBreakdownAreaV0Schema = z
  .object({
    intent: z.string().min(1),
    finish: z.string().min(1),
    coverage: z.string().min(1),
    keyNotes: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

const LookSpecV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: z.enum(['US', 'JP']),
    locale: z.string().min(1),

    layer2EngineVersion: z.union([z.literal('l2-us-0.1.0'), z.literal('l2-jp-0.1.0')]),
    layer3EngineVersion: z.union([z.literal('l3-us-0.1.0'), z.literal('l3-jp-0.1.0')]),
    orchestratorVersion: z.union([z.literal('orchestrator-us-0.1.0'), z.literal('orchestrator-jp-0.1.0')]),

    lookTitle: z.string().min(1).optional(),
    styleTags: z.array(z.string().min(1)).default([]),

    breakdown: z
      .object({
        base: LookSpecBreakdownAreaV0Schema,
        eye: LookSpecBreakdownAreaV0Schema,
        lip: LookSpecBreakdownAreaV0Schema,
      })
      .strict(),

    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();

module.exports = {
  LookAreaSchema,
  LookSpecBreakdownAreaV0Schema,
  LookSpecV0Schema,
};

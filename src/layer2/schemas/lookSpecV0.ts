import { z } from "zod";

export const LookAreaSchema = z.enum(["base", "eye", "lip"]);

export const LookSpecBreakdownAreaV0Schema = z
  .object({
    intent: z.string().min(1),
    finish: z.string().min(1),
    coverage: z.string().min(1),
    keyNotes: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const LookSpecV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: z.literal("US"),
    locale: z.string().min(1),

    layer2EngineVersion: z.literal("l2-us-0.1.0"),
    layer3EngineVersion: z.literal("l3-us-0.1.0"),
    orchestratorVersion: z.literal("orchestrator-us-0.1.0"),

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

export type LookSpecV0 = z.infer<typeof LookSpecV0Schema>;


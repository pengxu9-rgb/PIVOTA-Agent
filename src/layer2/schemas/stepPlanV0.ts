import { z } from "zod";

export const StepImpactAreaSchema = z.enum(["base", "eye", "lip"]);

export const StepPlanV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: z.literal("US"),
    locale: z.string().min(1),

    layer2EngineVersion: z.literal("l2-us-0.1.0"),
    layer3EngineVersion: z.literal("l3-us-0.1.0"),
    orchestratorVersion: z.literal("orchestrator-us-0.1.0"),

    stepId: z.string().min(1),
    order: z.number().int().nonnegative(),
    impactArea: StepImpactAreaSchema,
    title: z.string().min(1),
    instruction: z.string().min(1),
    tips: z.array(z.string().min(1)).default([]),
    cautions: z.array(z.string().min(1)).default([]),
    fitConditions: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type StepPlanV0 = z.infer<typeof StepPlanV0Schema>;


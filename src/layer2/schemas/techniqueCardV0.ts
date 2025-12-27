import { z } from "zod";

export const TechniqueMarketSchema = z.enum(["US", "JP"]);
export const TechniqueAreaSchema = z.enum(["base", "eye", "lip"]);
export const TechniqueDifficultySchema = z.enum(["easy", "medium", "hard"]);

export const TechniqueConditionOpSchema = z.enum([
  "lt",
  "lte",
  "gt",
  "gte",
  "eq",
  "neq",
  "in",
  "between",
  "exists",
]);

export const TechniqueConditionV0Schema = z
  .object({
    key: z.string().min(1),
    op: TechniqueConditionOpSchema,
    value: z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

export type TechniqueConditionV0 = z.infer<typeof TechniqueConditionV0Schema>;

export const TechniqueTriggersV0Schema = z
  .object({
    all: z.array(TechniqueConditionV0Schema).optional(),
    any: z.array(TechniqueConditionV0Schema).optional(),
    none: z.array(TechniqueConditionV0Schema).optional(),
  })
  .strict();

export type TechniqueTriggersV0 = z.infer<typeof TechniqueTriggersV0Schema>;

export const TechniqueActionTemplateV0Schema = z
  .object({
    title: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    variables: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type TechniqueActionTemplateV0 = z.infer<typeof TechniqueActionTemplateV0Schema>;

export const TechniqueCardV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: TechniqueMarketSchema,
    id: z.string().min(1),
    area: TechniqueAreaSchema,
    difficulty: TechniqueDifficultySchema,
    triggers: TechniqueTriggersV0Schema,
    actionTemplate: TechniqueActionTemplateV0Schema,
    rationaleTemplate: z.array(z.string().min(1)).min(1),
    productRoleHints: z.array(z.string().min(1)).optional(),
    safetyNotes: z.array(z.string().min(1)).optional(),
    sourceId: z.string().min(1).optional(),
    sourcePointer: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type TechniqueCardV0 = z.infer<typeof TechniqueCardV0Schema>;

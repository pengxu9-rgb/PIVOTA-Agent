const { z } = require('zod');

const TechniqueMarketSchema = z.literal('US');
const TechniqueAreaSchema = z.enum(['base', 'eye', 'lip']);
const TechniqueDifficultySchema = z.enum(['easy', 'medium', 'hard']);

const TechniqueConditionOpSchema = z.enum(['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'in', 'between', 'exists']);

const TechniqueConditionV0Schema = z
  .object({
    key: z.string().min(1),
    op: TechniqueConditionOpSchema,
    value: z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

const TechniqueTriggersV0Schema = z
  .object({
    all: z.array(TechniqueConditionV0Schema).optional(),
    any: z.array(TechniqueConditionV0Schema).optional(),
    none: z.array(TechniqueConditionV0Schema).optional(),
  })
  .strict();

const TechniqueActionTemplateV0Schema = z
  .object({
    title: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    variables: z.array(z.string().min(1)).optional(),
  })
  .strict();

const TechniqueCardV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: TechniqueMarketSchema,
    id: z.string().min(1),
    area: TechniqueAreaSchema,
    difficulty: TechniqueDifficultySchema,
    triggers: TechniqueTriggersV0Schema,
    actionTemplate: TechniqueActionTemplateV0Schema,
    rationaleTemplate: z.array(z.string().min(1)).min(1),
    productRoleHints: z.array(z.string().min(1)).optional(),
    safetyNotes: z.array(z.string().min(1)).optional(),
  })
  .strict();

module.exports = {
  TechniqueMarketSchema,
  TechniqueAreaSchema,
  TechniqueDifficultySchema,
  TechniqueConditionOpSchema,
  TechniqueConditionV0Schema,
  TechniqueTriggersV0Schema,
  TechniqueActionTemplateV0Schema,
  TechniqueCardV0Schema,
};


const { z } = require('zod');
const { ProductAttributesV0Schema } = require('./productAttributesV0');

const KitAreaSchema = z.enum(['base', 'eye', 'lip']);

const KitSlotV0Schema = z
  .object({
    best: ProductAttributesV0Schema,
    dupe: ProductAttributesV0Schema,
  })
  .strict();

const KitPlanV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: z.literal('US'),
    locale: z.string().min(1),

    layer2EngineVersion: z.literal('l2-us-0.1.0'),
    layer3EngineVersion: z.literal('l3-us-0.1.0'),
    orchestratorVersion: z.literal('orchestrator-us-0.1.0'),

    kit: z
      .object({
        base: KitSlotV0Schema,
        eye: KitSlotV0Schema,
        lip: KitSlotV0Schema,
      })
      .strict(),

    warnings: z.array(z.string().min(1)).optional(),
  })
  .strict();

module.exports = {
  KitAreaSchema,
  KitSlotV0Schema,
  KitPlanV0Schema,
};


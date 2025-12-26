import { z } from "zod";

export const AvailabilitySchema = z.enum(["in_stock", "out_of_stock", "unknown"]);
export const ProductCategorySchema = z.enum(["base", "eye", "lip"]);
export const PriceTierSchema = z.enum(["budget", "mid", "premium", "unknown"]);
export const UndertoneFitSchema = z.enum(["cool", "warm", "neutral", "unknown"]);

export const ProductTagsV0Schema = z
  .object({
    finish: z.array(z.string().min(1)).default([]),
    texture: z.array(z.string().min(1)).default([]),
    coverage: z.array(z.string().min(1)).default([]),
    effect: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const AvailabilityByMarketV0Schema = z
  .object({
    US: AvailabilitySchema,
  })
  .strict();

export const MoneyV0Schema = z
  .object({
    currency: z.string().min(1),
    amount: z.number().finite().nonnegative(),
  })
  .strict();

export const ProductAttributesV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    market: z.literal("US"),
    locale: z.string().min(1),

    layer2EngineVersion: z.literal("l2-us-0.1.0"),
    layer3EngineVersion: z.literal("l3-us-0.1.0"),
    orchestratorVersion: z.literal("orchestrator-us-0.1.0"),

    category: ProductCategorySchema,
    skuId: z.string().min(1),
    name: z.string().min(1),
    brand: z.string().min(1),
    price: MoneyV0Schema,
    priceTier: PriceTierSchema,
    imageUrl: z.string().url().optional(),
    productUrl: z.string().url().optional(),
    availability: AvailabilitySchema,
    availabilityByMarket: AvailabilityByMarketV0Schema,
    tags: ProductTagsV0Schema,
    undertoneFit: UndertoneFitSchema,
    shadeDescriptor: z.string().min(1).optional(),
    whyThis: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ProductAttributesV0 = z.infer<typeof ProductAttributesV0Schema>;

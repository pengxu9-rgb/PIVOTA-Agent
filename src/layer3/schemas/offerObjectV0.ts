import { z } from "zod";

const MarketSchema = z.union([z.literal("US"), z.literal("JP")]);

const MoneySchema = z
  .object({
    amount: z.number().finite(),
    currency: z.string().min(1),
  })
  .strict();

export const ExternalOfferV0Schema = z
  .object({
    offerId: z.string().min(1),
    source: z.literal("external"),
    market: MarketSchema,
    canonicalUrl: z.string().url(),
    domain: z.string().min(1),
    title: z.string().min(1),
    imageUrl: z.string().url().optional(),
    price: MoneySchema.optional(),
    listPrice: MoneySchema.optional(),
    availability: z.union([z.literal("in_stock"), z.literal("out_of_stock"), z.literal("unknown")]).optional(),
    lastCheckedAt: z.string().datetime(),
    disclosure: z
      .object({
        type: z.union([z.literal("affiliate"), z.literal("partner"), z.literal("none"), z.literal("unknown")]),
        text: z.string().min(1),
      })
      .strict(),
    evidence: z
      .object({
        provider: z.union([z.literal("og"), z.literal("jsonld"), z.literal("manual")]),
        fetchedAt: z.string().datetime(),
        snapshotId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const InternalOfferV0Schema = z
  .object({
    offerId: z.string().min(1),
    source: z.literal("internal"),
    market: MarketSchema,
    skuId: z.string().min(1),
    merchantId: z.string().min(1).optional(),
    offer: z.unknown().optional(),
    purchaseEnabled: z.boolean(),
  })
  .strict();

export const OfferObjectV0Schema = z.discriminatedUnion("source", [ExternalOfferV0Schema, InternalOfferV0Schema]);

export type ExternalOfferV0 = z.infer<typeof ExternalOfferV0Schema>;
export type InternalOfferV0 = z.infer<typeof InternalOfferV0Schema>;
export type OfferObjectV0 = z.infer<typeof OfferObjectV0Schema>;


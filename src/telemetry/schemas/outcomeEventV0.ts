import { z } from 'zod';

export const MarketSchema = z.enum(['US', 'JP']);

export const OutcomeEventTypeSchema = z.enum([
  'rating',
  'issue_tags',
  'share',
  'add_to_cart',
  'checkout_start',
  'checkout_success',
]);

export const OutcomeEventV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    market: MarketSchema,
    jobId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    eventType: OutcomeEventTypeSchema,
    payload: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string().datetime(),
  })
  .strict();

export type OutcomeEventV0 = z.infer<typeof OutcomeEventV0Schema>;

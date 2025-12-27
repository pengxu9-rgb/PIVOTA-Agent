import { z } from "zod";

export const LookReplicatorEventIngestV0Schema = z
  .object({
    event: z.string().min(1),
    properties: z.record(z.string(), z.unknown()).default({}),
    timestamp: z.string().datetime().optional(),
    distinctId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  })
  .strict();

export type LookReplicatorEventIngestV0 = z.infer<
  typeof LookReplicatorEventIngestV0Schema
>;


import { z } from "zod";

import { readDictJson } from "./loadDicts";

export type Market = "US" | "JP";

const IntentMarketMappingSchema = z
  .object({
    techniqueIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const IntentV0Schema = z
  .object({
    id: z.string().min(1),
    area: z.enum(["prep", "base", "contour", "brow", "eye", "blush", "lip"]),
    markets: z
      .object({
        US: IntentMarketMappingSchema,
        JP: IntentMarketMappingSchema,
      })
      .strict(),
  })
  .strict();

const IntentsV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    placeholders: z.array(z.string().min(1)).default([]),
    intents: z.array(IntentV0Schema).min(1),
  })
  .strict();

export type IntentsV0 = z.infer<typeof IntentsV0Schema>;

export function loadIntentsV0(): IntentsV0 {
  return IntentsV0Schema.parse(readDictJson("intents_v0.json"));
}

export function getTechniqueIdsForIntent(intentId: string, market: Market, dict?: IntentsV0): string[] | null {
  const d = dict ?? loadIntentsV0();
  const hit = d.intents.find((i) => i.id === intentId);
  if (!hit) return null;
  const m = hit.markets[market];
  return Array.isArray(m.techniqueIds) ? [...m.techniqueIds] : null;
}

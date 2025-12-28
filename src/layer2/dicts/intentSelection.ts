import { z } from "zod";

import { readDictJson } from "./loadDicts";

export type Market = "US" | "JP";
export type IntentSelection = "sequence" | "choose_one";

const IntentSelectionSchema = z.enum(["sequence", "choose_one"]);
const IntentSelectionMappingSchema = z.object({}).catchall(IntentSelectionSchema);

const IntentSelectionV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    markets: z
      .object({
        US: IntentSelectionMappingSchema.optional(),
        JP: IntentSelectionMappingSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type IntentSelectionV0 = z.infer<typeof IntentSelectionV0Schema>;

export function loadIntentSelectionV0(): IntentSelectionV0 {
  return IntentSelectionV0Schema.parse(readDictJson("intent_selection_v0.json"));
}

export function getIntentSelection(intentId: string, market: Market, dict?: IntentSelectionV0): IntentSelection {
  const d = dict ?? loadIntentSelectionV0();
  const m = market === "JP" ? "JP" : "US";
  const hit = (d.markets?.[m] ?? {})[intentId];
  return hit === "choose_one" ? "choose_one" : "sequence";
}

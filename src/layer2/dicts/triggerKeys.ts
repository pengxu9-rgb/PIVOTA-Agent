import { z } from "zod";

import { readDictJson } from "./loadDicts";

const TriggerKeysV0Schema = z
  .object({
    schemaVersion: z.literal("v0"),
    allowedPrefixes: z.array(z.string().min(1)).min(1),
    disallowedSubstrings: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type TriggerKeysV0 = z.infer<typeof TriggerKeysV0Schema>;

export function loadTriggerKeysV0(): TriggerKeysV0 {
  return TriggerKeysV0Schema.parse(readDictJson("trigger_keys_v0.json"));
}

export function isTriggerKeyAllowed(key: string, dict?: TriggerKeysV0): boolean {
  const s = String(key || "");
  if (!s) return false;
  const d = dict ?? loadTriggerKeysV0();
  for (const bad of d.disallowedSubstrings) {
    if (s.includes(bad)) return false;
  }
  return d.allowedPrefixes.some((p) => s === p || s.startsWith(p));
}


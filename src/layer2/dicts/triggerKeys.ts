import { z } from "zod";

import { readDictJson } from "./loadDicts";

const TriggerKeysCommonSchema = z
  .object({
    allowedPrefixes: z.array(z.string().min(1)).min(1),
    disallowedSubstrings: z.array(z.string().min(1)).default([]),
  })
  .strict();

const TriggerKeysV0Schema = TriggerKeysCommonSchema.extend({
  schemaVersion: z.literal("v0"),
}).strict();

const TriggerKeysV1Schema = TriggerKeysCommonSchema.extend({
  schemaVersion: z.literal("v1"),
}).strict();

export type TriggerKeysV0 = z.infer<typeof TriggerKeysV0Schema>;
export type TriggerKeysV1 = z.infer<typeof TriggerKeysV1Schema>;
export type TriggerKeysAny = TriggerKeysV0 | TriggerKeysV1;

export function loadTriggerKeysV0(): TriggerKeysV0 {
  return TriggerKeysV0Schema.parse(readDictJson("trigger_keys_v0.json"));
}

export function loadTriggerKeysV1(): TriggerKeysV1 {
  return TriggerKeysV1Schema.parse(readDictJson("trigger_keys_v1.json"));
}

export function loadTriggerKeysLatest(): TriggerKeysAny {
  // v1 is a strict superset of v0; prefer it when present.
  return loadTriggerKeysV1();
}

export function isTriggerKeyAllowed(key: string, dict?: TriggerKeysAny): boolean {
  const s = String(key || "");
  if (!s) return false;
  const d = dict ?? loadTriggerKeysLatest();
  for (const bad of d.disallowedSubstrings) {
    if (s.includes(bad)) return false;
  }
  return d.allowedPrefixes.some((p) => s === p || s.startsWith(p));
}

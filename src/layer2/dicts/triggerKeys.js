const { z } = require('zod');
const { readDictJson } = require('./loadDicts');

const TriggerKeysCommonSchema = z
  .object({
    allowedPrefixes: z.array(z.string().min(1)).min(1),
    disallowedSubstrings: z.array(z.string().min(1)).default([]),
  })
  .strict();

const TriggerKeysV0Schema = TriggerKeysCommonSchema.extend({
  schemaVersion: z.literal('v0'),
}).strict();

const TriggerKeysV1Schema = TriggerKeysCommonSchema.extend({
  schemaVersion: z.literal('v1'),
}).strict();

function loadTriggerKeysV0() {
  return TriggerKeysV0Schema.parse(readDictJson('trigger_keys_v0.json'));
}

function loadTriggerKeysV1() {
  return TriggerKeysV1Schema.parse(readDictJson('trigger_keys_v1.json'));
}

function loadTriggerKeysLatest() {
  // v1 is a strict superset of v0; prefer it when present.
  return loadTriggerKeysV1();
}

function isTriggerKeyAllowed(key, dict) {
  const s = String(key || '');
  if (!s) return false;
  const d = dict ?? loadTriggerKeysLatest();
  for (const bad of d.disallowedSubstrings || []) {
    if (s.includes(bad)) return false;
  }
  return (d.allowedPrefixes || []).some((p) => s === p || s.startsWith(p));
}

module.exports = {
  loadTriggerKeysV0,
  loadTriggerKeysV1,
  loadTriggerKeysLatest,
  isTriggerKeyAllowed,
};

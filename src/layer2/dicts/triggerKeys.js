const { z } = require('zod');
const { readDictJson } = require('./loadDicts');

const TriggerKeysV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    allowedPrefixes: z.array(z.string().min(1)).min(1),
    disallowedSubstrings: z.array(z.string().min(1)).default([]),
  })
  .strict();

function loadTriggerKeysV0() {
  return TriggerKeysV0Schema.parse(readDictJson('trigger_keys_v0.json'));
}

function isTriggerKeyAllowed(key, dict) {
  const s = String(key || '');
  if (!s) return false;
  const d = dict ?? loadTriggerKeysV0();
  for (const bad of d.disallowedSubstrings || []) {
    if (s.includes(bad)) return false;
  }
  return (d.allowedPrefixes || []).some((p) => s === p || s.startsWith(p));
}

module.exports = {
  loadTriggerKeysV0,
  isTriggerKeyAllowed,
};


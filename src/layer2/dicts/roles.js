const { z } = require('zod');
const { readDictJson } = require('./loadDicts');

const RoleV0Schema = z
  .object({
    id: z.string().min(1),
    synonyms: z.array(z.string().min(1)).default([]),
  })
  .strict();

const RolesV0Schema = z
  .object({
    schemaVersion: z.literal('v0'),
    roles: z.array(RoleV0Schema).min(1),
    normalization_rules: z
      .object({
        lowercase: z.boolean().default(true),
        trim: z.boolean().default(true),
        collapse_whitespace: z.boolean().default(true),
        replace_chars: z
          .array(
            z
              .object({
                from: z.string(),
                to: z.string(),
              })
              .strict(),
          )
          .default([]),
      })
      .default({}),
  })
  .strict();

function loadRolesV0() {
  return RolesV0Schema.parse(readDictJson('roles_v0.json'));
}

function applyNormalization(s, rules) {
  let out = String(s || '');
  if (rules.trim) out = out.trim();
  for (const r of rules.replace_chars || []) out = out.split(r.from).join(r.to);
  if (rules.collapse_whitespace) out = out.replace(/\\s+/g, ' ');
  if (rules.lowercase) out = out.toLowerCase();
  return out;
}

function buildRoleNormalizer(dict) {
  const d = dict ?? loadRolesV0();
  const rules = d.normalization_rules || {};
  const byNormalized = new Map();

  for (const role of d.roles || []) {
    byNormalized.set(applyNormalization(role.id, rules), role.id);
    for (const syn of role.synonyms || []) {
      byNormalized.set(applyNormalization(syn, rules), role.id);
    }
  }

  return {
    normalizeRoleHint: (hint) => {
      const raw = String(hint || '');
      if (!raw.trim()) return null;
      return byNormalized.get(applyNormalization(raw, rules)) ?? null;
    },
  };
}

module.exports = {
  loadRolesV0,
  buildRoleNormalizer,
};


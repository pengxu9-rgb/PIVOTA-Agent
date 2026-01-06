const { z } = require('zod');
const { readDictJson } = require('./loadDicts');

const RoleSchema = z
  .object({
    id: z.string().min(1),
    synonyms: z.array(z.string().min(1)).default([]),
  })
  .strict();

const RolesCommonSchema = z
  .object({
    roles: z.array(RoleSchema).min(1),
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

const RolesV0Schema = RolesCommonSchema.extend({
  schemaVersion: z.literal('v0'),
}).strict();

const RolesV1Schema = RolesCommonSchema.extend({
  schemaVersion: z.literal('v1'),
}).strict();

function loadRolesV0() {
  return RolesV0Schema.parse(readDictJson('roles_v0.json'));
}

function loadRolesV1() {
  return RolesV1Schema.parse(readDictJson('roles_v1.json'));
}

function loadRolesLatest() {
  // v1 is a strict superset of v0; prefer it when present.
  return loadRolesV1();
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
  const d = dict ?? loadRolesLatest();
  const rules = d.normalization_rules || {};
  const byNormalized = new Map();
  const byNormalizedDetail = new Map();

  for (const role of d.roles || []) {
    const roleKey = applyNormalization(role.id, rules);
    byNormalized.set(roleKey, role.id);
    byNormalizedDetail.set(roleKey, { roleId: role.id, matched: 'id', matchedValue: role.id });
    for (const syn of role.synonyms || []) {
      const synKey = applyNormalization(syn, rules);
      byNormalized.set(synKey, role.id);
      byNormalizedDetail.set(synKey, { roleId: role.id, matched: 'synonym', matchedValue: syn });
    }
  }

  return {
    normalizeRoleHint: (hint) => {
      const raw = String(hint || '');
      if (!raw.trim()) return null;
      return byNormalized.get(applyNormalization(raw, rules)) ?? null;
    },
    normalizeRoleHintDetailed: (hint) => {
      const raw = String(hint || '');
      if (!raw.trim()) return null;
      const normalizedHint = applyNormalization(raw, rules);
      const detail = byNormalizedDetail.get(normalizedHint);
      if (!detail) return null;
      return { normalizedHint, ...detail };
    },
  };
}

module.exports = {
  loadRolesV0,
  loadRolesV1,
  loadRolesLatest,
  buildRoleNormalizer,
};

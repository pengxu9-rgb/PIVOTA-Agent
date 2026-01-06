import { z } from "zod";

import { readDictJson } from "./loadDicts";

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
              .strict()
          )
          .default([]),
      })
      .default({}),
  })
  .strict();

const RolesV0Schema = RolesCommonSchema.extend({
  schemaVersion: z.literal("v0"),
}).strict();

const RolesV1Schema = RolesCommonSchema.extend({
  schemaVersion: z.literal("v1"),
}).strict();

export type RolesV0 = z.infer<typeof RolesV0Schema>;
export type RolesV1 = z.infer<typeof RolesV1Schema>;
export type RolesAny = RolesV0 | RolesV1;

export function loadRolesV0(): RolesV0 {
  return RolesV0Schema.parse(readDictJson("roles_v0.json"));
}

export function loadRolesV1(): RolesV1 {
  return RolesV1Schema.parse(readDictJson("roles_v1.json"));
}

export function loadRolesLatest(): RolesAny {
  // v1 is a strict superset of v0; prefer it when present.
  return loadRolesV1();
}

function applyNormalization(s: string, rules: RolesAny["normalization_rules"]): string {
  let out = s;
  if (rules.trim) out = out.trim();
  for (const r of rules.replace_chars || []) out = out.split(r.from).join(r.to);
  if (rules.collapse_whitespace) out = out.replace(/\s+/g, " ");
  if (rules.lowercase) out = out.toLowerCase();
  return out;
}

export function buildRoleNormalizer(dict?: RolesAny) {
  const d = dict ?? loadRolesLatest();
  const rules = d.normalization_rules;
  const byNormalized = new Map<string, string>();
  const byNormalizedDetail = new Map<
    string,
    { roleId: string; matched: "id" | "synonym"; matchedValue: string }
  >();
  for (const role of d.roles) {
    const roleKey = applyNormalization(role.id, rules);
    byNormalized.set(roleKey, role.id);
    byNormalizedDetail.set(roleKey, { roleId: role.id, matched: "id", matchedValue: role.id });
    for (const syn of role.synonyms || []) {
      const synKey = applyNormalization(syn, rules);
      byNormalized.set(synKey, role.id);
      byNormalizedDetail.set(synKey, { roleId: role.id, matched: "synonym", matchedValue: syn });
    }
  }
  return {
    normalizeRoleHint: (hint: unknown): string | null => {
      const raw = String(hint || "");
      if (!raw.trim()) return null;
      return byNormalized.get(applyNormalization(raw, rules)) ?? null;
    },
    normalizeRoleHintDetailed: (
      hint: unknown,
    ): { normalizedHint: string; roleId: string; matched: "id" | "synonym"; matchedValue: string } | null => {
      const raw = String(hint || "");
      if (!raw.trim()) return null;
      const normalizedHint = applyNormalization(raw, rules);
      const detail = byNormalizedDetail.get(normalizedHint);
      if (!detail) return null;
      return { normalizedHint, ...detail };
    },
  };
}

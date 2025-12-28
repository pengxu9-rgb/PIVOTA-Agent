import fs from "fs";
import path from "path";

import { loadLookSpecLexiconV0, normalizeVibeTagsForMarket } from "../../src/layer2/dicts/lookSpecLexicon";
import { buildRoleNormalizer, loadRolesV1 } from "../../src/layer2/dicts/roles";
import { isTriggerKeyAllowed, loadTriggerKeysV1 } from "../../src/layer2/dicts/triggerKeys";
import { loadIntentsV0 } from "../../src/layer2/dicts/intents";
import { LookSpecV0Schema } from "../../src/layer2/schemas/lookSpecV0";
import { loadTechniqueKB } from "../../src/layer2/kb/loadTechniqueKB";

function readJson(relPath: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", relPath), "utf8"));
}

function getTriggerKeysFromCard(card: any): string[] {
  const out: string[] = [];
  const trig = card?.triggers;
  if (!trig || typeof trig !== "object") return out;
  for (const clause of ["all", "any", "none"] as const) {
    const list = (trig as any)[clause];
    if (!Array.isArray(list)) continue;
    for (const cond of list) {
      const key = String(cond?.key || "").trim();
      if (key) out.push(key);
    }
  }
  return out;
}

describe("dicts integrity", () => {
  test("LookSpec fixtures stay within lexicon + vibe tags dicts", () => {
    for (const market of ["US", "JP"] as const) {
      const lookSpecRaw = readJson(`fixtures/contracts/${market.toLowerCase()}/lookSpecV0.sample.json`);
      const lookSpec = LookSpecV0Schema.parse(lookSpecRaw);
      expect(lookSpec.market).toBe(market);

      const lex = loadLookSpecLexiconV0(market);

      expect(lex.base.finish).toContain(lookSpec.breakdown.base.finish);
      expect(lex.base.coverage).toContain(lookSpec.breakdown.base.coverage);
      expect(lex.lip.finish).toContain(lookSpec.breakdown.lip.finish);

      expect(lookSpec.styleTags).toEqual(normalizeVibeTagsForMarket(lookSpec.styleTags, market));
    }
  });

  test("Technique KB trigger keys are whitelisted by trigger_keys_v1.json", () => {
    loadTriggerKeysV1(); // ensures schema-valid

    for (const market of ["US", "JP"] as const) {
      const kb = loadTechniqueKB(market);
      for (const card of kb.list as any[]) {
        const keys = getTriggerKeysFromCard(card);
        for (const k of keys) {
          expect(isTriggerKeyAllowed(k)).toBe(true);
        }
      }
    }
  });

  test("Technique KB role hints normalize to roles_v1.json ids", () => {
    const roles = loadRolesV1();
    const allowedRoleIds = new Set(roles.roles.map((r) => r.id));
    const { normalizeRoleHint } = buildRoleNormalizer(roles);

    for (const market of ["US", "JP"] as const) {
      const kb = loadTechniqueKB(market);
      for (const card of kb.list as any[]) {
        for (const hint of (card.productRoleHints || []) as any[]) {
          const normalized = normalizeRoleHint(hint);
          expect(normalized).not.toBeNull();
          expect(allowedRoleIds.has(String(normalized))).toBe(true);
        }
      }
    }
  });

  test("intents dict references technique ids present in market KB (or declared placeholders)", () => {
    const dict = loadIntentsV0();
    const placeholderIds = new Set(dict.placeholders || []);

    for (const market of ["US", "JP"] as const) {
      const kb = loadTechniqueKB(market);
      const knownTechniqueIds = new Set(Array.from(kb.byId.keys()));

      for (const intent of dict.intents) {
        const ids = intent.markets[market].techniqueIds;
        for (const id of ids) {
          expect(knownTechniqueIds.has(id) || placeholderIds.has(id)).toBe(true);

          if (id.endsWith("-en")) {
            expect(knownTechniqueIds.has(`${id.slice(0, -3)}-zh`)).toBe(true);
          }
          if (id.endsWith("-zh")) {
            expect(knownTechniqueIds.has(`${id.slice(0, -3)}-en`)).toBe(true);
          }
        }
      }
    }
  });
});

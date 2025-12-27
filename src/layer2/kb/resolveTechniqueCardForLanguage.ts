import type { TechniqueCardV0, TechniqueTriggersV0 } from "../schemas/techniqueCardV0";
import type { TechniqueKB } from "./loadTechniqueKB";
import { inferTechniqueLanguagePreferenceMode, type TechniqueLanguagePreferenceMode } from "./languagePreferenceMode";

function stripLangSuffix(id: string): string {
  return String(id || "").replace(/-(zh|en)$/i, "");
}

function candidateIdsFor(baseId: string, lang: TechniqueLanguagePreferenceMode): string[] {
  const b = stripLangSuffix(baseId);
  if (/-zh$/i.test(baseId)) return [baseId, `${b}-en`, b];
  if (/-en$/i.test(baseId)) return [baseId, b];
  if (lang === "zh") return [`${b}-zh`, `${b}-en`, b];
  return [`${b}-en`, b];
}

function hasPreferenceModeConditions(triggers: TechniqueTriggersV0 | undefined): boolean {
  const t = triggers || {};
  const all = Array.isArray(t.all) ? t.all : [];
  const any = Array.isArray(t.any) ? t.any : [];
  const none = Array.isArray(t.none) ? t.none : [];
  return [...all, ...any, ...none].some((c) => c?.key === "preferenceMode");
}

function evalPreferenceModeCond(
  lang: TechniqueLanguagePreferenceMode,
  cond: { op: string; value?: unknown } | null | undefined,
): boolean {
  if (!cond) return false;
  switch (cond.op) {
    case "exists":
      return Boolean(lang);
    case "eq":
      return cond.value === lang;
    case "neq":
      return cond.value !== lang;
    case "in": {
      const list = Array.isArray(cond.value) ? cond.value : [];
      return list.includes(lang);
    }
    default:
      return false;
  }
}

function cardAllowsLanguage(card: TechniqueCardV0, lang: TechniqueLanguagePreferenceMode): boolean {
  const triggers = card.triggers || {};
  if (!hasPreferenceModeConditions(triggers)) return true;

  const all = Array.isArray(triggers.all) ? triggers.all.filter((c) => c.key === "preferenceMode") : [];
  const any = Array.isArray(triggers.any) ? triggers.any.filter((c) => c.key === "preferenceMode") : [];
  const none = Array.isArray(triggers.none) ? triggers.none.filter((c) => c.key === "preferenceMode") : [];

  if (all.length && !all.every((c) => evalPreferenceModeCond(lang, c))) return false;
  if (any.length && !any.some((c) => evalPreferenceModeCond(lang, c))) return false;
  if (none.length && none.some((c) => evalPreferenceModeCond(lang, c))) return false;
  return true;
}

export type ResolveTechniqueCardForLanguageInput = {
  id: string;
  kb: TechniqueKB;
  locale?: string | null;
  acceptLanguage?: string | null;
  appLanguage?: string | null;
  userLanguage?: string | null;
};

export type ResolveTechniqueCardForLanguageOutput = {
  inferredLanguage: TechniqueLanguagePreferenceMode;
  usedFallbackLanguage: boolean;
  resolvedId: string | null;
  triedIds: string[];
  card: TechniqueCardV0 | null;
};

export function resolveTechniqueCardForLanguage(
  input: ResolveTechniqueCardForLanguageInput,
): ResolveTechniqueCardForLanguageOutput {
  const inferredLanguage = inferTechniqueLanguagePreferenceMode({
    locale: input.locale,
    acceptLanguage: input.acceptLanguage,
    appLanguage: input.appLanguage,
    userLanguage: input.userLanguage,
  });

  const triedIds = candidateIdsFor(input.id, inferredLanguage);
  const candidates: TechniqueCardV0[] = [];
  for (const cid of triedIds) {
    const card = input.kb.byId.get(cid);
    if (card) candidates.push(card);
  }

  const primary = candidates.find((c) => cardAllowsLanguage(c, inferredLanguage)) ?? null;
  if (primary) {
    return {
      inferredLanguage,
      usedFallbackLanguage: false,
      resolvedId: primary.id,
      triedIds,
      card: primary,
    };
  }

  if (inferredLanguage === "zh") {
    const fallback = candidates.find((c) => cardAllowsLanguage(c, "en")) ?? null;
    if (fallback) {
      return {
        inferredLanguage,
        usedFallbackLanguage: true,
        resolvedId: fallback.id,
        triedIds,
        card: fallback,
      };
    }
  }

  return { inferredLanguage, usedFallbackLanguage: false, resolvedId: null, triedIds, card: null };
}


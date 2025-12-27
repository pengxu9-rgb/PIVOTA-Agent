const { inferTechniqueLanguagePreferenceMode } = require("./languagePreferenceMode");

function stripLangSuffix(id) {
  return String(id || "").replace(/-(zh|en)$/i, "");
}

function candidateIdsFor(baseId, lang) {
  const b = stripLangSuffix(baseId);
  if (/-zh$/i.test(baseId)) return [baseId, `${b}-en`, b];
  if (/-en$/i.test(baseId)) return [baseId, b];
  if (lang === "zh") return [`${b}-zh`, `${b}-en`, b];
  return [`${b}-en`, b];
}

function hasPreferenceModeConditions(triggers) {
  const t = triggers || {};
  const all = Array.isArray(t.all) ? t.all : [];
  const any = Array.isArray(t.any) ? t.any : [];
  const none = Array.isArray(t.none) ? t.none : [];
  return [...all, ...any, ...none].some((c) => c && c.key === "preferenceMode");
}

function evalPreferenceModeCond(lang, cond) {
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

function cardAllowsLanguage(card, lang) {
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

function resolveTechniqueCardForLanguage(input) {
  const inferredLanguage = inferTechniqueLanguagePreferenceMode({
    locale: input && input.locale,
    acceptLanguage: input && input.acceptLanguage,
    appLanguage: input && input.appLanguage,
    userLanguage: input && input.userLanguage,
  });

  const triedIds = candidateIdsFor(input && input.id, inferredLanguage);
  const candidates = [];
  for (const cid of triedIds) {
    const card = input && input.kb && input.kb.byId && input.kb.byId.get(cid);
    if (card) candidates.push(card);
  }

  const primary = candidates.find((c) => cardAllowsLanguage(c, inferredLanguage)) || null;
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
    const fallback = candidates.find((c) => cardAllowsLanguage(c, "en")) || null;
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

module.exports = {
  resolveTechniqueCardForLanguage,
};


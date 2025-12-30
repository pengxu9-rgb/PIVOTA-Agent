const { inferTechniqueLanguagePreferenceMode } = require("./languagePreferenceMode");

function stripLangSuffix(id) {
  return String(id || "").replace(/-(zh|en)$/i, "");
}

function candidateIdsFor(baseId, lang) {
  const b = stripLangSuffix(baseId);
  // If the caller already provided a language-specific id, prefer the requested language variant first.
  if (/-zh$/i.test(baseId)) {
    if (lang === "en") return [`${b}-en`, baseId, b];
    return [baseId, `${b}-en`, b];
  }
  if (/-en$/i.test(baseId)) {
    if (lang === "zh") return [`${b}-zh`, baseId, b];
    return [baseId, b];
  }
  // Legacy ids without language suffix are treated as canonical English.
  // Prefer the unsuffixed id for English to avoid accidentally selecting `-zh` when only it exists.
  if (lang === "zh") return [`${b}-zh`, b, `${b}-en`];
  return [b, `${b}-en`, `${b}-zh`];
}

function isLanguageToken(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "en" || s === "zh";
}

function isLanguagePreferenceModeCondition(cond) {
  if (!cond || cond.key !== "preferenceMode") return false;
  const op = String(cond.op || "");
  if (op === "eq" || op === "neq") return isLanguageToken(cond.value);
  if (op === "in") {
    const list = Array.isArray(cond.value) ? cond.value : [];
    return list.some((x) => isLanguageToken(x));
  }
  return false;
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
  const all = Array.isArray(triggers.all) ? triggers.all.filter((c) => isLanguagePreferenceModeCondition(c)) : [];
  const any = Array.isArray(triggers.any) ? triggers.any.filter((c) => isLanguagePreferenceModeCondition(c)) : [];
  const none = Array.isArray(triggers.none) ? triggers.none.filter((c) => isLanguagePreferenceModeCondition(c)) : [];
  if (!all.length && !any.length && !none.length) return true;

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
    const usedFallbackLanguage = (inferredLanguage === "zh" && /-en$/i.test(primary.id)) || (inferredLanguage === "en" && /-zh$/i.test(primary.id));
    return {
      inferredLanguage,
      usedFallbackLanguage,
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

const { getAuroraKbV0 } = require('./loader');

const compiledCache = new WeakMap();

function normalizeLanguage(language) {
  return String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeLower(value) {
  return cleanText(value).toLowerCase();
}

function normalizeCompact(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, '');
}

function escapeRegex(raw) {
  return String(raw || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiToken(value) {
  return /^[a-z0-9 _+\-./]+$/i.test(String(value || ''));
}

function addUniqueEntry(target, keySet, entry, key) {
  const k = String(key || '').toLowerCase();
  if (!k || keySet.has(k)) return;
  keySet.add(k);
  target.push(entry);
}

function buildConceptEntries(kbPayload) {
  const concepts = (kbPayload && kbPayload.concept_dictionary && kbPayload.concept_dictionary.concepts) || [];
  const exactEntries = [];
  const regexEntries = [];
  const substringEntries = [];
  const ingredientEntries = [];

  const exactSeen = new Set();
  const regexSeen = new Set();
  const substringSeen = new Set();
  const ingredientSeen = new Set();

  for (const concept of concepts) {
    if (!concept || typeof concept !== 'object') continue;
    const conceptId = cleanText(concept.concept_id).toUpperCase();
    if (!conceptId) continue;
    const synonymsEn = safeArray(concept.synonyms_en);
    const synonymsZh = safeArray(concept.synonyms_zh);
    const inciAliases = safeArray(concept.inci_aliases);
    const regexHints = concept.regex_hints && typeof concept.regex_hints === 'object' ? concept.regex_hints : {};

    const termRows = [
      ...synonymsEn.map((term) => ({ term, lang: 'EN', source: 'synonyms_en' })),
      ...synonymsZh.map((term) => ({ term, lang: 'CN', source: 'synonyms_zh' })),
      ...inciAliases.map((term) => ({ term, lang: 'ANY', source: 'inci_aliases' })),
      { term: conceptId, lang: 'ANY', source: 'concept_id' },
    ];

    for (const row of termRows) {
      const term = cleanText(row.term);
      if (!term) continue;
      const lower = term.toLowerCase();
      const compact = term.toLowerCase().replace(/\s+/g, '');
      const boundaryRegex =
        isAsciiToken(term) && term.length <= 120
          ? new RegExp(`(^|[^a-z0-9])${escapeRegex(lower)}($|[^a-z0-9])`, 'i')
          : null;

      addUniqueEntry(
        exactEntries,
        exactSeen,
        {
          concept_id: conceptId,
          term,
          lower,
          compact,
          source: row.source,
          lang: row.lang,
          boundary_regex: boundaryRegex,
        },
        `${conceptId}|${row.source}|${lower}`,
      );

      if (compact.length >= 3) {
        addUniqueEntry(
          substringEntries,
          substringSeen,
          {
            concept_id: conceptId,
            term,
            lower,
            compact,
            source: row.source,
            lang: row.lang,
          },
          `${conceptId}|${row.source}|${compact}`,
        );
      }
    }

    const regexRows = [
      ...safeArray(regexHints.en).map((pattern) => ({ pattern, lang: 'EN', source: 'regex_hints.en' })),
      ...safeArray(regexHints.zh).map((pattern) => ({ pattern, lang: 'CN', source: 'regex_hints.zh' })),
    ];
    for (const row of regexRows) {
      const pattern = cleanText(row.pattern);
      if (!pattern) continue;
      try {
        const regex = new RegExp(pattern, 'i');
        addUniqueEntry(
          regexEntries,
          regexSeen,
          {
            concept_id: conceptId,
            pattern,
            regex,
            lang: row.lang,
            source: row.source,
          },
          `${conceptId}|${row.lang}|${pattern}`,
        );
      } catch {
        // ignore invalid regex hints at runtime
      }
    }
  }

  const ingredients = (kbPayload && kbPayload.ingredient_ontology && kbPayload.ingredient_ontology.ingredients) || [];
  for (const ingredient of ingredients) {
    if (!ingredient || typeof ingredient !== 'object') continue;
    const ingredientId = cleanText(ingredient.ingredient_id).toLowerCase();
    if (!ingredientId) continue;
    const terms = [];
    terms.push({
      term: ingredientId,
      source: 'ingredient_id',
      lang: 'ANY',
    });
    const inci = cleanText(ingredient.inci);
    if (inci) {
      terms.push({
        term: inci,
        source: 'inci',
        lang: 'ANY',
      });
    }
    const commonNames = ingredient.common_names && typeof ingredient.common_names === 'object' ? ingredient.common_names : {};
    for (const term of safeArray(commonNames.en)) {
      terms.push({
        term,
        source: 'common_names.en',
        lang: 'EN',
      });
    }
    for (const term of safeArray(commonNames.zh)) {
      terms.push({
        term,
        source: 'common_names.zh',
        lang: 'CN',
      });
    }

    for (const row of terms) {
      const term = cleanText(row.term);
      if (!term) continue;
      const lower = term.toLowerCase();
      const compact = term.toLowerCase().replace(/\s+/g, '');
      const boundaryRegex =
        isAsciiToken(term) && term.length <= 120
          ? new RegExp(`(^|[^a-z0-9])${escapeRegex(lower)}($|[^a-z0-9])`, 'i')
          : null;
      addUniqueEntry(
        ingredientEntries,
        ingredientSeen,
        {
          ingredient_id: ingredientId,
          term,
          lower,
          compact,
          source: row.source,
          lang: row.lang,
          boundary_regex: boundaryRegex,
          classes: safeArray(ingredient.classes).map((value) => cleanText(value).toUpperCase()).filter(Boolean),
          contraindication_tags: safeArray(ingredient.contraindication_tags)
            .map((value) => cleanText(value).toLowerCase())
            .filter(Boolean),
          evidence_level: cleanText(ingredient.evidence_level).toLowerCase(),
        },
        `${ingredientId}|${row.source}|${lower}`,
      );
    }
  }

  return {
    exactEntries,
    regexEntries,
    substringEntries,
    ingredientEntries,
  };
}

function getCompiledIndex(kbPayload) {
  if (!kbPayload || typeof kbPayload !== 'object') return null;
  const cached = compiledCache.get(kbPayload);
  if (cached) return cached;
  const compiled = buildConceptEntries(kbPayload);
  compiledCache.set(kbPayload, compiled);
  return compiled;
}

function languageMatches(entryLang, activeLang) {
  if (!entryLang || entryLang === 'ANY') return true;
  if (entryLang === 'EN') return activeLang === 'EN';
  if (entryLang === 'CN') return activeLang === 'CN';
  return true;
}

function scoreStage(stage) {
  if (stage === 'exact') return 3;
  if (stage === 'regex') return 2;
  return 1;
}

function addConceptMatch(target, seen, match) {
  const key = `${String(match.concept_id || '').toUpperCase()}|${String(match.stage || '')}`;
  if (!match.concept_id || seen.has(key)) return;
  seen.add(key);
  target.push(match);
}

function isConceptMatcherDebugEnabled() {
  const raw = String(process.env.AURORA_KB_V0_MATCH_DEBUG || process.env.AURORA_KB_MATCH_DEBUG || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function buildConceptMatchesDetailed({ text, language = 'EN', max = 64, includeSubstring = true, kbPayload } = {}) {
  const raw = cleanText(text);
  if (!raw) {
    return {
      matched_concepts: [],
      matched_concepts_debug: [],
    };
  }
  const lang = normalizeLanguage(language);
  const lower = normalizeLower(raw);
  const compact = normalizeCompact(raw);

  const kb = kbPayload && kbPayload.ok !== false ? kbPayload : getAuroraKbV0();
  if (!kb || kb.ok === false) {
    return {
      matched_concepts: [],
      matched_concepts_debug: [],
    };
  }
  const compiled = getCompiledIndex(kb);
  if (!compiled) {
    return {
      matched_concepts: [],
      matched_concepts_debug: [],
    };
  }

  const matches = [];
  const seen = new Set();
  const bestByConcept = new Map();
  const rawHits = [];

  const pushRawHit = (candidate) => {
    rawHits.push({
      concept_id: candidate.concept_id,
      stage: candidate.stage,
      source: candidate.source,
      matched_text: candidate.matched_text,
      language: candidate.language,
      priority: scoreStage(candidate.stage),
    });
  };

  for (const row of compiled.exactEntries) {
    if (!languageMatches(row.lang, lang)) continue;
    let hit = false;
    if (lower === row.lower || compact === row.compact) hit = true;
    else if (row.boundary_regex && row.boundary_regex.test(lower)) hit = true;
    else if (!row.boundary_regex && compact.includes(row.compact)) hit = true;
    if (!hit) continue;
    const candidate = {
      concept_id: row.concept_id,
      stage: 'exact',
      source: row.source,
      matched_text: row.term,
      language: row.lang,
    };
    pushRawHit(candidate);
    const prev = bestByConcept.get(row.concept_id);
    if (!prev || scoreStage(candidate.stage) > scoreStage(prev.stage)) {
      bestByConcept.set(row.concept_id, candidate);
    }
  }

  for (const row of compiled.regexEntries) {
    if (!languageMatches(row.lang, lang)) continue;
    if (!row.regex.test(raw)) continue;
    const candidate = {
      concept_id: row.concept_id,
      stage: 'regex',
      source: row.source,
      matched_text: row.pattern,
      language: row.lang,
    };
    pushRawHit(candidate);
    const prev = bestByConcept.get(row.concept_id);
    if (!prev || scoreStage(candidate.stage) > scoreStage(prev.stage)) {
      bestByConcept.set(row.concept_id, candidate);
    }
  }

  if (includeSubstring) {
    for (const row of compiled.substringEntries) {
      if (!languageMatches(row.lang, lang)) continue;
      if (row.compact.length < 3) continue;
      if (!compact.includes(row.compact)) continue;
      const candidate = {
        concept_id: row.concept_id,
        stage: 'substring',
        source: row.source,
        matched_text: row.term,
        language: row.lang,
      };
      pushRawHit(candidate);
      const prev = bestByConcept.get(row.concept_id);
      if (!prev || scoreStage(candidate.stage) > scoreStage(prev.stage)) {
        bestByConcept.set(row.concept_id, candidate);
      }
    }
  }

  const ordered = Array.from(bestByConcept.values()).sort((a, b) => {
    const stageDiff = scoreStage(b.stage) - scoreStage(a.stage);
    if (stageDiff) return stageDiff;
    return String(a.concept_id).localeCompare(String(b.concept_id));
  });

  for (const row of ordered.slice(0, Math.max(1, max))) {
    addConceptMatch(matches, seen, row);
  }
  rawHits.sort((a, b) => {
    const stageDiff = scoreStage(b.stage) - scoreStage(a.stage);
    if (stageDiff) return stageDiff;
    const conceptDiff = String(a.concept_id || '').localeCompare(String(b.concept_id || ''));
    if (conceptDiff) return conceptDiff;
    return String(a.matched_text || '').localeCompare(String(b.matched_text || ''));
  });

  return {
    matched_concepts: matches,
    matched_concepts_debug: rawHits,
  };
}

function matchConcepts({ text, language = 'EN', max = 64, includeSubstring = true, kbPayload } = {}) {
  return buildConceptMatchesDetailed({ text, language, max, includeSubstring, kbPayload }).matched_concepts;
}

function matchIngredientOntology({ text, language = 'EN', max = 24, kbPayload } = {}) {
  const raw = cleanText(text);
  if (!raw) return [];
  const lang = normalizeLanguage(language);
  const lower = normalizeLower(raw);
  const compact = normalizeCompact(raw);

  const kb = kbPayload && kbPayload.ok !== false ? kbPayload : getAuroraKbV0();
  if (!kb || kb.ok === false) return [];
  const compiled = getCompiledIndex(kb);
  if (!compiled) return [];

  const byIngredient = new Map();
  for (const row of compiled.ingredientEntries) {
    if (!languageMatches(row.lang, lang)) continue;
    const hit =
      lower === row.lower ||
      compact === row.compact ||
      (row.boundary_regex ? row.boundary_regex.test(lower) : compact.includes(row.compact));
    if (!hit) continue;
    const prev = byIngredient.get(row.ingredient_id);
    const candidate = {
      ingredient_id: row.ingredient_id,
      matched_text: row.term,
      source: row.source,
      classes: row.classes,
      contraindication_tags: row.contraindication_tags,
      evidence_level: row.evidence_level || 'unknown',
    };
    if (!prev || candidate.matched_text.length > prev.matched_text.length) {
      byIngredient.set(row.ingredient_id, candidate);
    }
  }
  return Array.from(byIngredient.values())
    .sort((a, b) => String(a.ingredient_id).localeCompare(String(b.ingredient_id)))
    .slice(0, Math.max(1, max));
}

const CONCEPT_TO_ACTIVE_TOKEN = Object.freeze({
  RETINOID: 'retinoid',
  RETINOL: 'retinoid',
  RETINAL: 'retinoid',
  TRETINOIN: 'retinoid',
  ADAPALENE: 'retinoid',
  TAZAROTENE: 'retinoid',
  TRIFAROTENE: 'retinoid',
  RETINYL_ESTER: 'retinoid',
  BENZOYL_PEROXIDE: 'benzoyl_peroxide',
  BPO: 'benzoyl_peroxide',
  BHA: 'bha',
  SALICYLIC_ACID: 'bha',
  AHA: 'aha',
  GLYCOLIC_ACID: 'aha',
  LACTIC_ACID: 'aha',
  MANDELIC_ACID: 'aha',
  PHA: 'aha',
  VITAMIN_C: 'vitamin_c',
  ASCORBIC_ACID: 'vitamin_c',
  NIACINAMIDE: 'niacinamide',
  AZELAIC_ACID: 'azelaic_acid',
  TRANEXAMIC_ACID: 'tranexamic_acid',
});

function mapConceptsToRoutineActiveTokens(conceptIds) {
  const out = [];
  const seen = new Set();
  for (const raw of safeArray(conceptIds)) {
    const conceptId = cleanText(raw).toUpperCase();
    if (!conceptId) continue;
    const mapped = CONCEPT_TO_ACTIVE_TOKEN[conceptId];
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}

function collectConceptMatchesFromText({
  text,
  language = 'EN',
  max = 64,
  includeSubstring = true,
  kbPayload,
  includeDebug = false,
} = {}) {
  const detailed = buildConceptMatchesDetailed({
    text,
    language,
    max,
    includeSubstring,
    kbPayload,
  });
  const matchedConcepts = safeArray(detailed.matched_concepts);
  const out = {
    matched_concepts: matchedConcepts,
    concept_ids: matchedConcepts.map((row) => row.concept_id),
  };
  if (includeDebug || isConceptMatcherDebugEnabled()) {
    out.matched_concepts_debug = safeArray(detailed.matched_concepts_debug);
  }
  return out;
}

function collectConceptIdsFromText({ text, language = 'EN', max = 64, includeSubstring = true, kbPayload } = {}) {
  return collectConceptMatchesFromText({
    text,
    language,
    max,
    includeSubstring,
    kbPayload,
    includeDebug: false,
  }).concept_ids;
}

module.exports = {
  matchConcepts,
  matchIngredientOntology,
  collectConceptMatchesFromText,
  collectConceptIdsFromText,
  mapConceptsToRoutineActiveTokens,
  normalizeLanguage,
  __internal: {
    getCompiledIndex,
    buildConceptEntries,
    buildConceptMatchesDetailed,
    isConceptMatcherDebugEnabled,
    scoreStage,
    CONCEPT_TO_ACTIVE_TOKEN,
  },
};

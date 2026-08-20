const {
  detectBrandEntities,
  resolveBeautyBrandBrowseQuery,
} = require('./brandLexicon');

const QUERY_UNDERSTANDING_VERSION = 'query_understanding_v1';
const SEARCH_QUALITY_CONTRACT_VERSION = 'search_quality_contract_v1';

const CATEGORY_TYPO_CORRECTIONS = Object.freeze([
  {
    canonical: 'fragrance',
    pattern: /\b(fragarances?|fragances?|fragrences?|fragrancee)\b/gi,
    categoryPathPrefix: 'beauty/fragrance/',
    reason: 'known_beauty_category_typo',
  },
  {
    canonical: 'oily',
    pattern: /\b(aoily|oilly|oilyskin)\b/gi,
    categoryPathPrefix: null,
    reason: 'known_beauty_profile_typo',
  },
]);

const CATEGORY_ALIAS_RULES = Object.freeze([
  {
    category: 'fragrance',
    categoryPathPrefix: 'beauty/fragrance/',
    pattern:
      /\b(perfume|perfumes|fragrance|fragrances|parfum|cologne|eau de parfum|eau de toilette|body mist|scent|scents)\b|香水|香氛|古龙|古龍|香體|香体/i,
  },
  {
    category: 'lipstick',
    categoryPathPrefix: 'beauty/makeup/lip/',
    pattern: /\b(lipsticks?|lip\s*sticks?|lip\s*colors?|lip\s*colours?|liquid\s*lips?|rouge)\b|口红|口紅/i,
  },
  {
    category: 'lip_care_or_gloss',
    categoryPathPrefix: 'beauty/makeup/lip/',
    pattern: /\b(lip\s*oils?|lip\s*balms?|lip\s*treatments?|lip\s*masks?|lip\s*gloss(?:es)?)\b|唇油|润唇|潤唇|唇膜|唇彩/i,
  },
  // Haircare. MEASURED GAP, 2026-08-20: bare `shampoo` / `conditioner` /
  // `hair mask` / `hair oil` had no rule here and no entry in
  // hasBeautySearchSignal, so the contract classified them
  // other/ambiguous_or_non_shopping and the safe-empty branch answered
  // "No products matched this search." in ~0.2s — BEFORE any SQL ran. That
  // silently nullified the #2035/#2039 category-browse union for exactly the
  // vocabulary it was built to fix (the union's own end-to-end trap #2,
  // "possibly a no-op", turned out to live one layer up).
  //
  // MUST SIT ABOVE the moisturizer / serum / skincare_treatment rules:
  // first match wins, and `hair cream` / `hair serum` / `hair treatment`
  // would otherwise be claimed by the `cream` / `serum` / `treatment` arms
  // of those skincare rules and browse the wrong tree. Hair words with no
  // hair/scalp anchor (bare `mask`, bare `oil`) are deliberately NOT
  // claimed. The lookbehind keeps `lip conditioner` out — it is a lip
  // product; it had no rule before and keeps having none.
  //
  // Prefix is the broad beauty/haircare/ tree (measured 2026-08-20:
  // shampoo 130 + conditioner 42 + general 244 + root 47 serving-eligible
  // rows): the leaf buckets (mask 2, hair-oil 1) are too sparse to browse,
  // and the category-browse union's title boost sorts the queried form to
  // the head inside the broad bucket.
  {
    category: 'haircare',
    categoryPathPrefix: 'beauty/haircare/',
    // The lookbehinds are \b-anchored on the guard word: an unanchored
    // (?<!air\s) is satisfied by the trailing "air " of hAIR, repAIR, chAIR,
    // which blocked the single most canonical phrasing of this category —
    // "hair conditioner" (caught in the pre-merge review, by execution).
    pattern:
      /\b(shampoos?|dry\s+shampoos?|(?<!\blip\s)(?<!\bair\s)(?<!\bfabric\s)conditioners?|leave[-\s]?in\s+conditioners?|(?:hair|scalp)\s+(?:masks?|oils?|serums?|mists?|tonics?|treatments?|creams?)|hair\s?care)\b|洗发|洗髮|护发素|護髮素|护发|護髮|发膜|髮膜/i,
  },
  {
    category: 'mascara',
    categoryPathPrefix: 'beauty/makeup/eye/',
    pattern: /\bmascara\b|睫毛膏/i,
  },
  {
    category: 'blush',
    categoryPathPrefix: 'beauty/makeup/face/blush/',
    pattern: /\b(blush|blusher|rouge\s+blush|cheek\s+color|cheek\s+colour|cheek\s+tint|liquid\s+blush|cream\s+blush)\b|腮红|腮紅/i,
  },
  {
    category: 'foundation',
    categoryPathPrefix: 'beauty/makeup/face/',
    pattern: /\b(foundation|skin\s*tint|tinted\s+moisturi[sz]er|concealer|base\s+makeup)\b|粉底|遮瑕|底妆|底妝/i,
  },
  {
    category: 'sunscreen',
    categoryPathPrefix: 'beauty/skincare/sun/',
    pattern: /\b(sunscreen|sun\s*screen|sunblock|spf\b|broad spectrum|uv|uva|uvb|pa\+{1,4})\b|防晒|防曬|日焼け止め/i,
  },
  {
    category: 'cleanser',
    categoryPathPrefix: 'beauty/skincare/cleanse/',
    pattern: /\b(cleanser|cleansing|face wash|facial wash|cleansing foam|cleansing gel|wash)\b|洁面|潔面|洗顔料/i,
  },
  {
    category: 'moisturizer',
    categoryPathPrefix: 'beauty/skincare/moisturize/',
    pattern: /\b(moisturi(?:z|s)er|cream|lotion|gel cream|gel-cream|barrier cream)\b|面霜|乳液|クリーム/i,
  },
  // Toner. Same measured gap as haircare above: bare `toner` (and `best
  // toner`, `toner pads`, `face mist`) safe-emptied before any SQL. The
  // bucket is real — beauty/skincare/tone/toner held 333 serving-eligible
  // rows on 2026-08-20 (the backfill that repaired the once-empty tone/
  // target), 58 of them mist-titled, which is why face/facial mist maps
  // here rather than to fragrance (whose rule only claims BODY mist, and
  // sits earlier so body mist still wins there). The lookbehind/lookahead
  // keep `printer toner` / `toner cartridge` out of the beauty domain —
  // they stay unclassified exactly as before.
  {
    category: 'toner',
    categoryPathPrefix: 'beauty/skincare/tone/',
    pattern:
      /\b(?<!printer\s)toners?\b(?!\s+cartridges?)|\btoner\s+pads?\b|\b(?:face|facial)\s+mists?\b|爽肤水|爽膚水|化妆水|化妝水|化粧水/i,
  },
  {
    category: 'serum',
    categoryPathPrefix: 'beauty/skincare/treat/',
    pattern: /\b(serum|essence|ampoule|concentrate)\b|精华|精華|美容液/i,
  },
  {
    category: 'skincare_treatment',
    categoryPathPrefix: 'beauty/skincare/treat/',
    pattern:
      /\b(acne|blemish|breakouts?|pimples?|clogged pores?|congestion|spot treatment|acne treatment|treatment|salicylic(?: acid)?|benzoyl peroxide|azelaic|niacinamide|bha)\b|祛痘|痘痘|闭口|閉口|粉刺|水杨酸|水楊酸/i,
  },
]);

const GENERIC_CATEGORY_BY_PREFIX = Object.freeze({
  'beauty/fragrance/': 'fragrance',
  'beauty/makeup/lip/': 'lipstick',
  'beauty/makeup/eye/': 'mascara',
  'beauty/makeup/face/blush/': 'blush',
  'beauty/makeup/cheek/': 'blush',
  'beauty/makeup/face/': 'foundation',
  'beauty/skincare/sun/': 'sunscreen',
  'beauty/skincare/cleanse/': 'cleanser',
  'beauty/skincare/moisturize/': 'moisturizer',
  'beauty/skincare/treat/': 'serum',
  'beauty/skincare/tone/': 'toner',
  'beauty/haircare/': 'shampoo',
});

function normalizeQueryTextForUnderstanding(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMessages(messages, max = 12) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const role = String(message.role || '').trim().toLowerCase();
      const content = String(message.content || '').trim();
      if (!role || !content) return null;
      return {
        role,
        content,
        ...(message.id != null ? { id: String(message.id) } : {}),
        ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
      };
    })
    .filter(Boolean)
    .slice(-max);
}

function applyDeterministicCorrections(rawQuery) {
  let corrected = String(rawQuery || '').trim();
  const corrections = [];
  if (!corrected) return { corrected_query: corrected, corrections };

  for (const rule of CATEGORY_TYPO_CORRECTIONS) {
    corrected = corrected.replace(rule.pattern, (match) => {
      corrections.push({
        token: match,
        replacement: rule.canonical,
        confidence: 0.98,
        source: rule.reason,
        category_path_prefix: rule.categoryPathPrefix,
      });
      return rule.canonical;
    });
  }

  corrected = corrected.replace(/\s+/g, ' ').trim();
  return { corrected_query: corrected, corrections };
}

function hasFragranceFreeSkincareSignal(text) {
  return /\b(fragrance(?:\s|-)?free|fragranceless|unscented|without fragrance|no fragrance|sans parfum)\b/i.test(
    String(text || ''),
  );
}

function hasFragranceProductQuerySignal(text) {
  if (hasFragranceFreeSkincareSignal(text)) return false;
  const raw = String(text || '');
  if (CATEGORY_ALIAS_RULES[0].pattern.test(raw)) return true;
  const corrected = applyDeterministicCorrections(raw).corrected_query;
  return corrected !== raw && CATEGORY_ALIAS_RULES[0].pattern.test(corrected);
}

function resolveBeautyCategoryPathPrefixFromText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fragranceFreeSkincare = hasFragranceFreeSkincareSignal(raw);
  for (const rule of CATEGORY_ALIAS_RULES) {
    if (fragranceFreeSkincare && rule.category === 'fragrance') continue;
    if (rule.pattern.test(raw)) return rule.categoryPathPrefix;
  }
  return '';
}

function isStrictLipstickQuery(text) {
  const raw = String(text || '');
  if (!raw) return false;
  if (!/\b(lipsticks?|lip\s*sticks?)\b/i.test(raw) && !/口红|口紅/.test(raw)) return false;
  return !/\b(lip\s*gloss(?:es)?|lip\s*oils?|lip\s*balms?|lip\s*treatments?|lip\s*masks?)\b/i.test(raw);
}

function extractConstraintSignals(text) {
  const raw = String(text || '');
  const normalized = normalizeQueryTextForUnderstanding(raw);
  const constraints = [];
  const push = (value) => {
    if (!value || constraints.includes(value)) return;
    constraints.push(value);
  };

  if (hasFragranceFreeSkincareSignal(raw)) push('fragrance_free');
  if (/\b(unscented|no\s+fragrance|without\s+fragrance|sans\s+parfum)\b/i.test(raw)) push('fragrance_free');
  if (
    /\b(pregnan\w*|pregnancy|ttc|trying\s+to\s+conceive|retinol[-\s]?free|retinoid[-\s]?free)\b/i.test(raw) ||
    /怀孕|懷孕|备孕|備孕|孕期|不要视黄醇|不含视黄醇|避开视黄醇/.test(raw)
  ) {
    push('pregnancy_safe');
    if (/\b(retinol[-\s]?free|retinoid[-\s]?free|avoid\s+retinoid|no\s+retinol)\b/i.test(raw)) {
      push('avoid_retinoids');
    }
  }
  if (/\b(sensitive|sensiti[sz]ed|gentle|rosacea|redness|non[-\s]?irritating)\b/.test(normalized) || /敏感|泛红|泛紅|玫瑰痤疮|酒糟|温和|溫和/.test(raw)) {
    push('sensitive_or_redness');
  }
  if (/\b(non[-\s]?comedogenic|won'?t\s+clog\s+pores|oil[-\s]?free)\b/i.test(raw)) push('non_comedogenic_or_oil_free');
  return constraints;
}

function extractIngredientSignals(text) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  const ingredients = [];
  const push = (value) => {
    if (!value || ingredients.includes(value)) return;
    ingredients.push(value);
  };
  const rules = [
    ['niacinamide', /\bniacinamide\b|烟酰胺|煙酰胺/],
    ['retinoid', /\b(retinol|retinal|retinoid|adapalene)\b|视黄醇|視黃醇/],
    ['vitamin_c', /\b(vitamin\s*c|ascorbic)\b|维生素c|維生素c/],
    ['ceramide', /\bceramides?\b|神经酰胺|神經醯胺/],
    ['hyaluronic_acid', /\bhyaluronic\b|透明质酸|透明質酸/],
    ['azelaic_acid', /\bazelaic\b|壬二酸/],
    ['salicylic_acid', /\b(salicylic|bha)\b|水杨酸|水楊酸/],
    ['benzoyl_peroxide', /\bbenzoyl\s+peroxide\b|过氧化苯甲酰|過氧化苯甲酰/],
    ['peptide', /\bpeptides?\b|胜肽|胜肽/],
    ['zinc', /\bzinc\b|锌|鋅/],
  ];
  for (const [name, pattern] of rules) {
    if (pattern.test(normalized)) push(name);
  }
  return ingredients;
}

function extractFormatSignals(text) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  const formats = [];
  const push = (value) => {
    if (!value || formats.includes(value)) return;
    formats.push(value);
  };
  if (/\b(waterproof|water\s+resistant)\b/.test(normalized)) push('waterproof');
  if (/\b(mini|travel|travel\s+size|portable)\b/.test(normalized)) push('travel_size');
  if (/\b(stick|balm|cream|gel|lotion|spray|mist|powder|liquid)\b/.test(normalized)) {
    const match = normalized.match(/\b(stick|balm|cream|gel|lotion|spray|mist|powder|liquid)\b/);
    if (match) push(match[1]);
  }
  return formats;
}

function extractLocalDestinationSignals(text) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  const signals = [];
  const push = (value) => {
    if (!value || signals.includes(value)) return;
    signals.push(value);
  };
  if (/\b(k[-\s]?beauty|korean|korea|seoul)\b/.test(normalized) || /韩国|韓國|首尔|首爾/.test(String(text || ''))) {
    push('k_beauty');
  }
  if (/\b(j[-\s]?beauty|japanese|japan|tokyo)\b/.test(normalized) || /日本|东京|東京/.test(String(text || ''))) {
    push('j_beauty');
  }
  return signals;
}

function hasBeautySearchSignal(text) {
  const raw = String(text || '');
  const normalized = normalizeQueryTextForUnderstanding(raw);
  return Boolean(
    resolveBeautyCategoryPathPrefixFromText(raw) ||
      extractBeautyConcernSignals(raw).has_concern_signal ||
      extractConstraintSignals(raw).length ||
      // toner/shampoo/conditioner are deliberately NOT in this bare-noun list
      // even though they gained alias rules on 2026-08-20: the first arm of
      // this predicate (resolveBeautyCategoryPathPrefixFromText) already
      // covers every phrasing the alias patterns accept, and the alias
      // patterns carry the non-beauty guards (printer toner, air
      // conditioner) that a bare noun here would bypass.
      /\b(makeup|cosmetics?|beauty|skincare|skin\s+care|haircare|hair\s+care|fragrance|perfume|pdp|spf|serum|cleanser|moisturi[sz]er|lipstick|mascara|blush|foundation|concealer)\b/.test(normalized) ||
      /护肤|護膚|彩妆|彩妝|美妆|美妝|香水|粉底|口红|口紅|睫毛膏|腮红|腮紅/.test(raw)
  );
}

function hasNonMerchandiseQuerySignal(text) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  if (!normalized) return false;
  return /\b(?:donat(?:e|ion|ions)|clara\s+lionel\s+foundation|gift\s+cards?|e\s+gift\s+cards?|shipping\s+protection|package\s+protection|route\s+protection|order\s+protection|returns?\s+policy|privacy\s+policy|terms\s+of\s+service|warranty|contact\s+us|customer\s+service|support\s+center)\b/.test(
    normalized,
  );
}

function stripBrandTokensFromNormalizedQuery(normalizedQuery, brandBrowse) {
  const normalized = normalizeQueryTextForUnderstanding(normalizedQuery);
  if (!normalized || !brandBrowse?.matched) return normalized;
  const partsToRemove = [
    brandBrowse.brand,
    brandBrowse.alias,
    String(brandBrowse.brand || '').replace(/\bbeauty\b/g, '').trim(),
  ]
    .map((value) => normalizeQueryTextForUnderstanding(value))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let out = ` ${normalized} `;
  for (const part of partsToRemove) {
    out = out.replace(new RegExp(`\\s${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'g'), ' ');
  }
  return out.replace(/\b(beauty|cosmetics?|products?|shop|buy|show|find|recommend|recommendations|best)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferExactProductAnchor({ correctedQuery, categoryPathPrefix, brandBrowse }) {
  if (!brandBrowse?.matched) return null;
  const remainder = stripBrandTokensFromNormalizedQuery(correctedQuery, brandBrowse);
  if (!remainder) return null;
  const tokens = remainder.split(/\s+/).filter((token) => token.length >= 3);
  if (tokens.length >= 4) return remainder;
  if (/\b(no\.?\s*\d+|spf\s*\d+|[a-z]+\s+\d{2,})\b/i.test(String(correctedQuery || ''))) return remainder;
  return null;
}

function buildSearchQualityContract({
  rawQuery,
  conversationMessages = [],
  sessionRecentQueries = [],
  market = null,
  source = null,
  allowContextBinding = true,
} = {}) {
  const understanding = understandShoppingQuery({
    rawQuery,
    conversationMessages,
    sessionRecentQueries,
    market,
    source,
    allowContextBinding,
  });
  const effectiveQuery = understanding.effective_query || understanding.corrected_query || understanding.raw_query || '';
  const normalized = normalizeQueryTextForUnderstanding(effectiveQuery);
  const inferredCategoryPathPrefix =
    understanding.category_path_prefix || resolveBeautyCategoryPathPrefixFromText(effectiveQuery) || null;
  const beautyBrandBrowse = resolveBeautyBrandBrowseQuery(effectiveQuery);
  const brandCandidates = Array.isArray(understanding.brand_candidates) ? understanding.brand_candidates : [];
  const brand = beautyBrandBrowse.matched
    ? {
        brand_key: beautyBrandBrowse.brand_key || null,
        canonical: beautyBrandBrowse.brand || null,
        alias: beautyBrandBrowse.alias || null,
      }
    : null;
  const concernSignals = understanding.beauty_context?.effective_concerns || extractBeautyConcernSignals(effectiveQuery);
  const profileSignals = understanding.beauty_context?.effective_profile || extractBeautyProfileSignals(effectiveQuery);
  const constraints = extractConstraintSignals(effectiveQuery);
  const ingredientTokens = extractIngredientSignals(effectiveQuery);
  const formatSignals = extractFormatSignals(effectiveQuery);
  const localDestinationSignals = extractLocalDestinationSignals(effectiveQuery);
  const exactProductAnchor = inferExactProductAnchor({
    correctedQuery: effectiveQuery,
    categoryPathPrefix: inferredCategoryPathPrefix,
    brandBrowse: beautyBrandBrowse,
  });
  const categoryPathPrefix = exactProductAnchor ? null : inferredCategoryPathPrefix;
  const hasKnownBeautyBrand = Boolean(beautyBrandBrowse.matched);
  const hasStaticNonBeautyBrand = Boolean(brandCandidates.length && !hasKnownBeautyBrand);
  const hasNonMerchandiseSignal = hasNonMerchandiseQuerySignal(effectiveQuery);
  const effectiveBrand = hasNonMerchandiseSignal ? null : brand;
  const effectiveExactProductAnchor = hasNonMerchandiseSignal ? null : exactProductAnchor;
  const effectiveCategoryPathPrefix = hasNonMerchandiseSignal ? null : categoryPathPrefix;
  const targetDomain =
    !hasNonMerchandiseSignal &&
    (hasKnownBeautyBrand || inferredCategoryPathPrefix || concernSignals?.has_concern_signal || constraints.length || hasBeautySearchSignal(effectiveQuery))
      ? 'beauty'
      : 'other';

  let queryClass = 'ambiguous_or_non_shopping';
  if (targetDomain === 'beauty') {
    if (effectiveExactProductAnchor) {
      queryClass = 'exact_product';
    } else if (hasKnownBeautyBrand && effectiveCategoryPathPrefix) {
      queryClass = 'brand_category';
    } else if (hasKnownBeautyBrand && constraints.length) {
      queryClass = 'constraint_search';
    } else if (hasKnownBeautyBrand && !effectiveCategoryPathPrefix && beautyBrandBrowse.brand_only) {
      queryClass = 'brand_browse';
    } else if (constraints.length) {
      queryClass = 'constraint_search';
    } else if (concernSignals?.has_concern_signal) {
      queryClass = 'need_solution';
    } else if (effectiveCategoryPathPrefix) {
      queryClass = 'category_browse';
    } else if (hasKnownBeautyBrand) {
      queryClass = 'brand_browse';
    }
  } else if (hasStaticNonBeautyBrand && !hasBeautySearchSignal(effectiveQuery)) {
    queryClass = 'ambiguous_or_non_shopping';
  }

  const exclusions = [];
  if (understanding.hard_negatives?.fragrance_free_skincare) exclusions.push('fragrance_product');
  if (understanding.hard_negatives?.strict_lipstick) exclusions.push('lip_gloss_oil_balm_mask');
  if (constraints.includes('pregnancy_safe') || constraints.includes('avoid_retinoids')) exclusions.push('retinoid_forward');

  return {
    contract_version: SEARCH_QUALITY_CONTRACT_VERSION,
    target_domain: targetDomain,
    query_class: queryClass,
    effective_query: effectiveQuery,
    clarification_allowed: queryClass === 'ambiguous_or_non_shopping',
    hard_constraints: {
      brand: effectiveBrand,
      category_path_prefix: effectiveCategoryPathPrefix,
      market: market ? String(market).trim().toUpperCase() : null,
      exclusions,
      exact_product_anchor: effectiveExactProductAnchor,
      strict_lipstick: Boolean(understanding.hard_negatives?.strict_lipstick),
      fragrance_free_skincare: Boolean(understanding.hard_negatives?.fragrance_free_skincare),
    },
    soft_preferences: {
      concerns: Array.isArray(concernSignals?.concerns) ? concernSignals.concerns : [],
      primary_concern: concernSignals?.primary_concern || null,
      ingredient_tokens: ingredientTokens,
      skin_type: profileSignals?.skin_type || null,
      format: formatSignals,
      local_destination: localDestinationSignals,
    },
    query_understanding: understanding,
  };
}

function isGenericCategoryOnlyQuery(text, categoryPathPrefix) {
  const normalized = normalizeQueryTextForUnderstanding(text)
    .replace(/\b(show|find|get|recommend|recommendations|products|items|some|me|for|please|all|shop|buy)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const categoryTerm = GENERIC_CATEGORY_BY_PREFIX[String(categoryPathPrefix || '')];
  if (!normalized || !categoryTerm) return false;
  if (categoryTerm === 'fragrance') {
    return /^(perfume|perfumes|fragrance|fragrances|parfum|cologne|scent|scents)$/.test(normalized);
  }
  if (categoryTerm === 'lipstick') {
    return /^(lipstick|lipsticks|lip stick|lip sticks|rouge)$/.test(normalized);
  }
  return normalized === categoryTerm;
}

function extractPriorUserMessages(conversationMessages, rawQuery) {
  const normalizedRaw = normalizeQueryTextForUnderstanding(rawQuery);
  const messages = normalizeMessages(conversationMessages, 12);
  const out = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const normalizedContent = normalizeQueryTextForUnderstanding(message.content);
    if (!normalizedContent) continue;
    if (!out.length && normalizedRaw && normalizedContent === normalizedRaw) continue;
    out.push(message);
    if (out.length >= 5) break;
  }
  return out;
}

function extractBeautyProfileSignals(text) {
  const raw = String(text || '');
  const normalized = normalizeQueryTextForUnderstanding(raw);
  const signals = {
    skin_type: null,
    environment: null,
    location: null,
    has_profile_signal: false,
  };

  if (
    /\b(oily|oilier|greasy|shiny|sebum|oil prone|oil-prone)\b/.test(normalized) ||
    /油皮|混油|出油/.test(raw)
  ) {
    signals.skin_type = 'oily';
  } else if (/\b(combination|combo)\b/.test(normalized) || /混合/.test(raw)) {
    signals.skin_type = 'combination';
  } else if (/\b(dry|dehydrated)\b/.test(normalized) || /干皮|乾皮|缺水/.test(raw)) {
    signals.skin_type = 'dry';
  } else if (/\b(sensitive|sensitized|reactive)\b/.test(normalized) || /敏感/.test(raw)) {
    signals.skin_type = 'sensitive';
  } else if (/\b(normal)\s+skin\b/.test(normalized) || /中性/.test(raw)) {
    signals.skin_type = 'normal';
  }

  if (/\b(sf|san francisco|bay area)\b/.test(normalized) || /旧金山|舊金山|湾区|灣區/.test(raw)) {
    signals.location = 'San Francisco';
    signals.environment = 'San Francisco';
  } else {
    const liveInMatch = normalized.match(/\b(?:live|living|based|located)\s+in\s+([a-z][a-z\s]{1,40})\b/);
    if (liveInMatch && liveInMatch[1]) {
      const value = liveInMatch[1]
        .replace(/\b(and|with|but|my|skin|type|is|i)\b.*$/i, '')
        .trim();
      if (value && value.length <= 32) {
        signals.location = value.replace(/\b\w/g, (char) => char.toUpperCase());
        signals.environment = signals.location;
      }
    }
  }

  signals.has_profile_signal = Boolean(signals.skin_type || signals.environment || signals.location);
  return signals;
}

function extractBeautyConcernSignals(text) {
  const raw = String(text || '');
  const normalized = normalizeQueryTextForUnderstanding(raw);
  const concerns = [];
  const push = (value) => {
    if (!value || concerns.includes(value)) return;
    concerns.push(value);
  };

  if (/\b(acne|blemish|breakouts?|pimples?|zits?)\b/.test(normalized) || /祛痘|痘痘|粉刺/.test(raw)) {
    push('acne');
  }
  if (/\b(clogged pores?|congestion|blackheads?|whiteheads?)\b/.test(normalized) || /闭口|閉口|黑头|黑頭|毛孔/.test(raw)) {
    push('clogged_pores');
  }
  if (/\b(oily skin|oil control|shine control|sebum|greasy|shiny)\b/.test(normalized) || /控油|出油/.test(raw)) {
    push('oil_control');
  }

  const hasConcernSignal = concerns.length > 0;
  return {
    concerns,
    primary_concern: concerns[0] || null,
    category_path_prefix: hasConcernSignal ? 'beauty/skincare/treat/' : null,
    target_step_family: hasConcernSignal ? 'treatment' : null,
    semantic_family: concerns.includes('acne')
      ? 'acne'
      : concerns.includes('oil_control')
        ? 'oil_control'
        : concerns.includes('clogged_pores')
          ? 'oil_control'
          : null,
    has_concern_signal: hasConcernSignal,
  };
}

function isBeautyProfileOnlyFollowup(text, profileSignals, concernSignals) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  if (!normalized || !profileSignals?.has_profile_signal) return false;
  if (resolveBeautyCategoryPathPrefixFromText(text)) return false;
  const hasProductIntent = /\b(recommend|recommendation|products?|buy|shop|find|show|need|looking for|serum|cleanser|moisturizer|sunscreen|treatment)\b/.test(
    normalized,
  );
  const concernIsOnlyProfileSkinType =
    concernSignals?.has_concern_signal &&
    Array.isArray(concernSignals.concerns) &&
    concernSignals.concerns.length === 1 &&
    concernSignals.primary_concern === 'oil_control' &&
    Boolean(profileSignals.skin_type) &&
    !hasProductIntent;
  if (concernSignals?.has_concern_signal && !concernIsOnlyProfileSkinType) return false;
  return !hasProductIntent;
}

function buildBeautySlotContextualQuery({ concernSignals, profileSignals }) {
  const parts = [];
  if (concernSignals?.primary_concern === 'acne') parts.push('acne treatment serum');
  else if (concernSignals?.primary_concern === 'clogged_pores') parts.push('clogged pores treatment serum');
  else if (concernSignals?.primary_concern === 'oil_control') parts.push('oil control treatment serum');
  else parts.push('skincare treatment serum');

  if (profileSignals?.skin_type) parts.push(`${profileSignals.skin_type} skin`);
  if (profileSignals?.environment) parts.push(profileSignals.environment);
  return Array.from(new Set(parts.map((item) => String(item || '').trim()).filter(Boolean))).join(' ');
}

function maybeBindBeautySlotFollowupContext({
  rawQuery,
  correctedQuery,
  conversationMessages,
  currentProfileSignals,
  currentConcernSignals,
}) {
  if (!isBeautyProfileOnlyFollowup(correctedQuery || rawQuery, currentProfileSignals, currentConcernSignals)) {
    return null;
  }
  const priorUserMessages = extractPriorUserMessages(conversationMessages, rawQuery);
  for (const message of priorUserMessages) {
    const priorCorrected = applyDeterministicCorrections(message.content).corrected_query || message.content;
    const priorConcernSignals = extractBeautyConcernSignals(priorCorrected);
    if (!priorConcernSignals.has_concern_signal) continue;
    const contextualQuery = buildBeautySlotContextualQuery({
      concernSignals: priorConcernSignals,
      profileSignals: currentProfileSignals,
    });
    if (!contextualQuery) continue;
    return {
      scope: 'conversation',
      source: 'current_conversation_messages',
      source_query: message.content,
      category_path_prefix: priorConcernSignals.category_path_prefix,
      reason: 'beauty_slot_followup_conversation_context',
      contextual_query: contextualQuery,
      beauty_context: {
        concern: priorConcernSignals.primary_concern,
        concerns: priorConcernSignals.concerns,
        target_step_family: priorConcernSignals.target_step_family,
        semantic_family: priorConcernSignals.semantic_family,
        skin_type: currentProfileSignals.skin_type,
        environment: currentProfileSignals.environment,
        location: currentProfileSignals.location,
      },
    };
  }
  return null;
}

function maybeBindConversationContext({ rawQuery, correctedQuery, categoryPathPrefix, conversationMessages }) {
  if (!isGenericCategoryOnlyQuery(correctedQuery || rawQuery, categoryPathPrefix)) return null;
  const priorUserMessages = extractPriorUserMessages(conversationMessages, rawQuery);
  for (const message of priorUserMessages) {
    const prior = understandShoppingQuery({
      rawQuery: message.content,
      conversationMessages: [],
      sessionRecentQueries: [],
      allowContextBinding: false,
    });
    const priorBrand = Array.isArray(prior.brand_candidates) ? prior.brand_candidates[0] : '';
    if (!priorBrand || prior.category_path_prefix !== categoryPathPrefix) continue;
    const categoryTerm = GENERIC_CATEGORY_BY_PREFIX[categoryPathPrefix] || String(correctedQuery || rawQuery).trim();
    return {
      scope: 'conversation',
      source: 'current_conversation_messages',
      source_query: message.content,
      brand: priorBrand,
      category_path_prefix: categoryPathPrefix,
      reason: 'generic_category_followup_conversation_brand',
      contextual_query: `${priorBrand} ${categoryTerm}`.trim(),
    };
  }
  return null;
}

function isExplicitSessionContinuationQuery(text) {
  const normalized = normalizeQueryTextForUnderstanding(text);
  if (!normalized) return false;
  return (
    /\b(continue|resume|use|show|get|repeat)\s+(the\s+)?(previous|last|prior)\s+(search|query|results?)\b/.test(normalized) ||
    /\b(same|again)\s+as\s+(before|last\s+time|previous)\b/.test(normalized) ||
    /\b(previous|last)\s+(search|query|results?)\b/.test(normalized) ||
    /继续(刚才|之前|上次)|接着(刚才|之前|上次)|刚才那个|之前那个|上次那个/.test(String(text || ''))
  );
}

function maybeBindExplicitSessionContext({ rawQuery, correctedQuery, categoryPathPrefix, sessionRecentQueries }) {
  if (!isExplicitSessionContinuationQuery(correctedQuery || rawQuery)) return null;
  const history = Array.isArray(sessionRecentQueries) ? sessionRecentQueries : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const sourceQuery = String(history[i] || '').trim();
    if (!sourceQuery) continue;
    const prior = understandShoppingQuery({
      rawQuery: sourceQuery,
      conversationMessages: [],
      sessionRecentQueries: [],
      allowContextBinding: false,
    });
    const contextualQuery = String(prior?.effective_query || prior?.corrected_query || sourceQuery).trim();
    if (!contextualQuery) continue;
    if (categoryPathPrefix && prior?.category_path_prefix && prior.category_path_prefix !== categoryPathPrefix) {
      continue;
    }
    return {
      scope: 'session_explicit',
      source: 'session_recent_queries',
      source_query: sourceQuery,
      brand: Array.isArray(prior?.brand_candidates) ? prior.brand_candidates[0] || null : null,
      category_path_prefix: prior?.category_path_prefix || categoryPathPrefix || null,
      reason: 'explicit_session_previous_query',
      contextual_query: contextualQuery,
    };
  }
  return null;
}

function buildBrandCandidates(queryText) {
  const detected = detectBrandEntities(queryText, { candidateProducts: [] });
  return Array.isArray(detected?.brands) ? detected.brands : [];
}

function understandShoppingQuery({
  rawQuery,
  conversationMessages = [],
  sessionRecentQueries = [],
  market = null,
  source = null,
  allowContextBinding = true,
} = {}) {
  const raw = String(rawQuery || '').trim();
  const normalized = normalizeQueryTextForUnderstanding(raw);
  const correctionResult = applyDeterministicCorrections(raw);
  const correctedQuery = correctionResult.corrected_query || raw;
  const correctedNormalized = normalizeQueryTextForUnderstanding(correctedQuery);
  const nonMerchandiseQuery = hasNonMerchandiseQuerySignal(correctedQuery);
  const categoryPathPrefix = nonMerchandiseQuery ? '' : resolveBeautyCategoryPathPrefixFromText(correctedQuery);
  const brandCandidates = buildBrandCandidates(correctedQuery);
  const currentProfileSignals = extractBeautyProfileSignals(correctedQuery);
  const currentConcernSignals = extractBeautyConcernSignals(correctedQuery);
  const riskFlags = [];
  if (nonMerchandiseQuery) riskFlags.push('non_merchandise_query_guard');
  if (hasFragranceFreeSkincareSignal(correctedQuery)) riskFlags.push('fragrance_free_skincare_guard');
  if (Array.isArray(sessionRecentQueries) && sessionRecentQueries.length) {
    riskFlags.push('session_recent_queries_ignored_for_context');
  }

  const contextBinding = allowContextBinding
    ? maybeBindConversationContext({
        rawQuery: raw,
        correctedQuery,
        categoryPathPrefix,
        conversationMessages,
      }) ||
      maybeBindBeautySlotFollowupContext({
        rawQuery: raw,
        correctedQuery,
        conversationMessages,
        currentProfileSignals,
        currentConcernSignals,
      }) ||
      maybeBindExplicitSessionContext({
        rawQuery: raw,
        correctedQuery,
        categoryPathPrefix,
        sessionRecentQueries,
      })
    : null;
  const effectiveQuery = contextBinding?.contextual_query || correctedQuery || raw;
  const effectiveCategoryPathPrefix =
    nonMerchandiseQuery
      ? null
      : contextBinding?.category_path_prefix ||
        resolveBeautyCategoryPathPrefixFromText(effectiveQuery) ||
        categoryPathPrefix ||
        null;
  const effectiveProfileSignals = extractBeautyProfileSignals(effectiveQuery);
  const effectiveConcernSignals = extractBeautyConcernSignals(effectiveQuery);
  if (contextBinding?.reason === 'beauty_slot_followup_conversation_context') {
    riskFlags.push('beauty_slot_followup_bound');
  }
  const decision = contextBinding
    ? 'apply_conversation_context'
    : correctionResult.corrections.length
      ? 'apply_correction'
      : 'apply_raw';

  return {
    version: QUERY_UNDERSTANDING_VERSION,
    query_understanding_executed: true,
    raw_query: raw,
    normalized_query: normalized,
    corrected_query: correctedQuery,
    corrected_normalized_query: correctedNormalized,
    effective_query: effectiveQuery,
    corrections: correctionResult.corrections,
    brand_candidates: brandCandidates,
    category_path_prefix: effectiveCategoryPathPrefix,
    context_binding: contextBinding,
    context_scope: contextBinding?.scope || 'none',
    risk_flags: riskFlags,
    decision,
    beauty_context: {
      current_profile: currentProfileSignals,
      current_concerns: currentConcernSignals,
      effective_profile: effectiveProfileSignals,
      effective_concerns: effectiveConcernSignals,
      ...(contextBinding?.beauty_context ? { bound: contextBinding.beauty_context } : {}),
    },
    hard_negatives: {
      fragrance_free_skincare: hasFragranceFreeSkincareSignal(correctedQuery),
      strict_lipstick: isStrictLipstickQuery(correctedQuery),
      non_merchandise_query: nonMerchandiseQuery,
    },
    ...(market ? { market: String(market).trim().toUpperCase() } : {}),
    ...(source ? { source: String(source).trim() } : {}),
  };
}

module.exports = {
  QUERY_UNDERSTANDING_VERSION,
  SEARCH_QUALITY_CONTRACT_VERSION,
  understandShoppingQuery,
  buildSearchQualityContract,
  normalizeQueryTextForUnderstanding,
  resolveBeautyCategoryPathPrefixFromText,
  hasFragranceFreeSkincareSignal,
  hasFragranceProductQuerySignal,
  isStrictLipstickQuery,
};

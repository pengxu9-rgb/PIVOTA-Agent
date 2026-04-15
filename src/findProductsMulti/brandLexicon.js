const STATIC_BRAND_ALIASES = Object.freeze({
  tom_ford: ['tom ford', 'tomford', 'tf'],
  jo_malone: ['jo malone london', 'jo malone', 'jomalone', 'jomalonelondon'],
  byredo: ['byredo'],
  dior: ['dior', 'christian dior'],
  chanel: ['chanel'],
  ysl: ['yves saint laurent', 'ysl', 'ysl beauty', 'yves saint laurent beauty'],
  armani: ['armani beauty', 'giorgio armani beauty', 'giorgio armani', 'armani'],
  gucci: ['gucci beauty', 'gucci'],
  prada: ['prada beauty', 'prada'],
  valentino: ['valentino beauty', 'valentino'],
  givenchy: ['givenchy beauty', 'givenchy'],
  fenty_beauty: ['fenty beauty', 'fentybeauty', 'fenty'],
  rare_beauty: ['rare beauty', 'rarebeauty'],
  charlotte_tilbury: ['charlotte tilbury', 'charlottetilbury'],
  nars: ['nars'],
  clinique: ['clinique'],
  shiseido: ['shiseido'],
  laneige: ['laneige'],
  innisfree: ['innisfree'],
  the_ordinary: ['the ordinary', 'theordinary'],
  cerave: ['cerave', 'cera ve'],
  la_roche_posay: ['la roche posay', 'larocheposay', 'la roche-posay'],
  kiehls: ["kiehl's", 'kiehls', 'kiehl s'],
  tatcha: ['tatcha'],
  drunk_elephant: ['drunk elephant', 'drunkelephant'],
  la_mer: ['la mer', 'lamer'],
  diptyque: ['diptyque'],
  le_labo: ['le labo', 'lelabo'],
  kylie_cosmetics: ['kylie cosmetics', 'kyliecosmetics', 'kylie'],
  sigma_beauty: ['sigma beauty', 'sigmabeauty', 'sigma'],
  zara: ['zara'],
  uniqlo: ['uniqlo'],
  lululemon: ['lululemon', 'lulu lemon'],
  alo_yoga: ['alo yoga', 'aloyoga', 'alo'],
  free_people: ['free people', 'freepeople'],
  skims: ['skims'],
  arcteryx: ['arc teryx', "arc'teryx", 'arcteryx'],
  new_balance: ['new balance', 'newbalance'],
  adidas: ['adidas'],
  nike: ['nike'],
  hm: ['h&m', 'hm'],
  mango: ['mango'],
});

const BRAND_SUFFIX_TOKENS = new Set([
  'beauty',
  'cosmetic',
  'cosmetics',
  'fragrance',
  'perfume',
  'parfum',
  'makeup',
]);

const BRAND_STOP_TOKENS = new Set([
  'the',
  'for',
  'with',
  'from',
  'and',
  'shop',
  'store',
  'official',
  'products',
  'product',
  'best',
  'buy',
  'gift',
  'gifts',
  'set',
  'kits',
  'kit',
]);

function normalizeBrandText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[`’'".,!?()[\]{}|/\\:+_*#~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeBrandText(value) {
  return normalizeBrandText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function toCanonicalBrandLabel(raw) {
  return tokenizeBrandText(raw).join(' ');
}

function isSingleShortBrandAlias(normalizedAlias) {
  const tokens = tokenizeBrandText(normalizedAlias);
  return tokens.length === 1 && tokens[0].length <= 2;
}

function matchesBrandAliasInNormalizedText(normalizedText, normalizedAlias) {
  const text = normalizeBrandText(normalizedText);
  const alias = normalizeBrandText(normalizedAlias);
  if (!text || !alias) return false;

  if (isSingleShortBrandAlias(alias)) {
    return tokenizeBrandText(text).includes(alias);
  }

  const compactText = text.replace(/\s+/g, '');
  const compactAlias = alias.replace(/\s+/g, '');
  return (
    text === alias ||
    text.includes(` ${alias} `) ||
    text.startsWith(`${alias} `) ||
    text.endsWith(` ${alias}`) ||
    text.includes(alias) ||
    (compactAlias && compactText.includes(compactAlias))
  );
}

function collectDynamicBrandAliases(candidateProducts = []) {
  const out = new Set();
  for (const product of Array.isArray(candidateProducts) ? candidateProducts : []) {
    if (!product || typeof product !== 'object') continue;
    const rawCandidates = [
      product.brand,
      product.brand_name,
      product.vendor,
      product.manufacturer,
      product.seed_data?.brand,
    ];
    for (const raw of rawCandidates) {
      const normalized = normalizeBrandText(raw);
      if (!normalized) continue;
      const tokens = tokenizeBrandText(normalized).filter(
        (token) =>
          token.length >= 2 &&
          !BRAND_STOP_TOKENS.has(token) &&
          !BRAND_SUFFIX_TOKENS.has(token),
      );
      if (!tokens.length) continue;
      const phrase = tokens.slice(0, 4).join(' ');
      if (phrase.length >= 3) out.add(phrase);
      for (const token of tokens) {
        if (token.length >= 4) out.add(token);
      }
    }
    if (out.size >= 256) break;
  }
  return Array.from(out);
}

function detectBrandByStaticAliases(normalizedQuery) {
  const matches = [];
  for (const aliases of Object.values(STATIC_BRAND_ALIASES)) {
    const sortedAliases = [...aliases].sort((a, b) => String(b || '').length - String(a || '').length);
    let matchedAlias = null;
    for (const alias of sortedAliases) {
      const normalizedAlias = normalizeBrandText(alias);
      if (!normalizedAlias) continue;
      if (matchesBrandAliasInNormalizedText(normalizedQuery, normalizedAlias)) {
        matchedAlias = normalizedAlias;
        break;
      }
    }
    if (!matchedAlias) continue;
    const canonical = toCanonicalBrandLabel(aliases[0]);
    matches.push(canonical);
    if (matchedAlias !== canonical) {
      matches.push(toCanonicalBrandLabel(matchedAlias));
    }
  }
  return Array.from(new Set(matches));
}

function detectBrandByDynamicAliases(normalizedQuery, candidateProducts = []) {
  const dynamicAliases = collectDynamicBrandAliases(candidateProducts);
  if (!dynamicAliases.length) return [];
  const matches = [];
  for (const alias of dynamicAliases) {
    if (matchesBrandAliasInNormalizedText(normalizedQuery, alias)) {
      matches.push(alias);
    }
  }
  return Array.from(new Set(matches));
}

function detectBrandByHeuristic(normalizedQuery) {
  const matches = [];
  const suffixPattern = /\b([a-z0-9][a-z0-9&\-\s]{0,48})\s+(beauty|cosmetics?|fragrance|perfume|parfum)\b/g;
  let hit = suffixPattern.exec(normalizedQuery);
  while (hit) {
    const left = tokenizeBrandText(hit[1]).filter((token) => !BRAND_STOP_TOKENS.has(token));
    if (left.length > 0) {
      matches.push(`${left.join(' ')} ${hit[2]}`);
    }
    hit = suffixPattern.exec(normalizedQuery);
  }
  return Array.from(new Set(matches.map((item) => toCanonicalBrandLabel(item))));
}

function detectBrandEntities(queryText, options = {}) {
  const normalizedQuery = normalizeBrandText(queryText);
  if (!normalizedQuery) {
    return {
      brand_like: false,
      brands: [],
      detection_mode: null,
    };
  }

  const staticMatches = detectBrandByStaticAliases(normalizedQuery);
  if (staticMatches.length) {
    return {
      brand_like: true,
      brands: staticMatches,
      detection_mode: 'static',
    };
  }

  const dynamicMatches = detectBrandByDynamicAliases(
    normalizedQuery,
    Array.isArray(options?.candidateProducts) ? options.candidateProducts : [],
  );
  if (dynamicMatches.length) {
    return {
      brand_like: true,
      brands: dynamicMatches,
      detection_mode: 'dynamic',
    };
  }

  const heuristicMatches = detectBrandByHeuristic(normalizedQuery);
  if (heuristicMatches.length) {
    return {
      brand_like: true,
      brands: heuristicMatches,
      detection_mode: 'heuristic',
    };
  }

  return {
    brand_like: false,
    brands: [],
    detection_mode: null,
  };
}

function hasExplicitCategoryHint(queryText, intent = null) {
  const normalized = normalizeBrandText(queryText);
  if (!normalized) return false;
  if (
    /\b(perfume|fragrance|parfum|cologne|body mist|lingerie|underwear|bra|bralette|panties|sleepwear|loungewear|pajamas?|blazer|cardigan|dress|robe|shirt|tee|t shirt|tshirt|top|tank|sweater|hoodie|sweatshirt|jacket|coat|parka|windbreaker|leggings|jeans|trousers|pants|shorts|skirt|activewear|athleisure|sports bra|yoga set|matching set|sneakers?|shoes?|boots?|sandals?|heels?|skincare|serum|toner|lipstick|mascara|foundation|brush|tool|shampoo|conditioner)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  const categories = Array.isArray(intent?.category?.required) ? intent.category.required : [];
  return categories.length > 0;
}

function buildBrandQueryVariants(queryText, brands = []) {
  const normalizedQuery = normalizeBrandText(queryText);
  const variants = [];
  const seen = new Set();
  const push = (value) => {
    const normalized = normalizeBrandText(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    variants.push(normalized);
  };

  push(normalizedQuery);
  for (const brand of Array.isArray(brands) ? brands : []) {
    push(brand);
    const tokens = tokenizeBrandText(brand);
    if (!tokens.length) continue;
    if (BRAND_SUFFIX_TOKENS.has(tokens[tokens.length - 1]) && tokens.length > 1) {
      push(tokens.slice(0, -1).join(' '));
    }
    if (tokens.length >= 2) {
      push(tokens.join(''));
    }
  }

  return variants.slice(0, 8);
}

module.exports = {
  detectBrandEntities,
  buildBrandQueryVariants,
  hasExplicitCategoryHint,
  normalizeBrandText,
};

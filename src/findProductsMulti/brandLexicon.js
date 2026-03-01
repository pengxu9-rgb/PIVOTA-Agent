const STATIC_BRAND_ALIASES = Object.freeze({
  tom_ford: ['tom ford', 'tomford', 'tf'],
  jo_malone: ['jo malone london', 'jo malone', 'jomalone', 'jomalonelondon'],
  byredo: ['byredo'],
  dior: ['dior', 'christian dior'],
  fenty_beauty: ['fenty beauty', 'fentybeauty', 'fenty'],
  kylie_cosmetics: ['kylie cosmetics', 'kyliecosmetics', 'kylie'],
  sigma_beauty: ['sigma beauty', 'sigmabeauty', 'sigma'],
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
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  const matches = [];
  for (const aliases of Object.values(STATIC_BRAND_ALIASES)) {
    const sortedAliases = [...aliases].sort((a, b) => String(b || '').length - String(a || '').length);
    let matchedAlias = null;
    for (const alias of sortedAliases) {
      const normalizedAlias = normalizeBrandText(alias);
      if (!normalizedAlias) continue;
      const compactAlias = normalizedAlias.replace(/\s+/g, '');
      if (
        normalizedQuery === normalizedAlias ||
        normalizedQuery.includes(` ${normalizedAlias} `) ||
        normalizedQuery.startsWith(`${normalizedAlias} `) ||
        normalizedQuery.endsWith(` ${normalizedAlias}`) ||
        normalizedQuery.includes(normalizedAlias) ||
        (compactAlias && compactQuery.includes(compactAlias))
      ) {
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
    if (
      normalizedQuery === alias ||
      normalizedQuery.includes(` ${alias} `) ||
      normalizedQuery.startsWith(`${alias} `) ||
      normalizedQuery.endsWith(` ${alias}`) ||
      normalizedQuery.includes(alias)
    ) {
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
    /\b(perfume|fragrance|parfum|cologne|body mist|lingerie|underwear|bra|panties|skincare|serum|toner|lipstick|mascara|foundation|brush|tool|shampoo|conditioner)\b/.test(
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

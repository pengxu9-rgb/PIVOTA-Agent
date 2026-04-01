const SURFACING_QUERY_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'best',
  'for',
  'i',
  'im',
  "i'm",
  'me',
  'my',
  'of',
  'product',
  'products',
  'recommend',
  'recommended',
  'recommendation',
  'recommendations',
  'skin',
  'skincare',
  'the',
  'to',
  'use',
  'what',
  'with',
]);

function uniqStrings(values = [], max = 48) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeSurfacingSearchText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff%+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSurfacingSearchText(value, { max = 32, dropStopwords = false } = {}) {
  const normalized = normalizeSurfacingSearchText(value);
  if (!normalized) return [];
  const tokens = normalized
    .split(/\s+/)
    .map((item) => String(item || '').trim())
    .filter((item) => item.length >= 2);
  const filtered = dropStopwords
    ? tokens.filter((token) => !SURFACING_QUERY_STOPWORDS.has(token))
    : tokens;
  return uniqStrings(filtered, max);
}

function collectStringArray(raw) {
  return Array.isArray(raw)
    ? raw.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function buildExternalSeedSurfacingText(candidate, { anchorOnly = false } = {}) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const sku = row.sku && typeof row.sku === 'object' && !Array.isArray(row.sku)
    ? row.sku
    : row.product && typeof row.product === 'object' && !Array.isArray(row.product)
      ? row.product
      : {};

  const textParts = [
    row.brand,
    row.brand_name,
    row.brandName,
    row.name,
    row.title,
    row.display_name,
    row.displayName,
    ...collectStringArray(row.search_aliases),
    ...collectStringArray(row.searchAliases),
    ...collectStringArray(row.aliases),
    sku.brand,
    sku.brand_name,
    sku.brandName,
    sku.name,
    sku.title,
    sku.display_name,
    sku.displayName,
    ...collectStringArray(sku.search_aliases),
    ...collectStringArray(sku.searchAliases),
    ...collectStringArray(sku.aliases),
  ];

  if (!anchorOnly) {
    textParts.push(
      row.category,
      row.category_name,
      row.categoryName,
      row.product_type,
      row.productType,
      row.type,
      row.ingredient_name,
      row.short_description,
      row.shortDescription,
      row.description,
      row.summary,
      row.subtitle,
      row.seed_description,
      row.seedDescription,
      sku.category,
      sku.category_name,
      sku.categoryName,
      sku.product_type,
      sku.productType,
      sku.type,
      sku.short_description,
      sku.shortDescription,
      sku.description,
      sku.summary,
      sku.subtitle,
      ...collectStringArray(row.ingredient_tokens),
      ...collectStringArray(row.tag_tokens),
      ...collectStringArray(row.skin_type_tags),
      ...collectStringArray(row.benefit_tags),
      ...collectStringArray(row.benefitTags),
      ...collectStringArray(row.benefit_tags_list),
      ...collectStringArray(row.benefitTagsList),
      ...collectStringArray(row.key_benefits),
      ...collectStringArray(row.keyBenefits),
      ...collectStringArray(sku.ingredient_tokens),
      ...collectStringArray(sku.tag_tokens),
      ...collectStringArray(sku.skin_type_tags),
      ...collectStringArray(sku.benefit_tags),
      ...collectStringArray(sku.benefitTags),
      ...collectStringArray(sku.benefit_tags_list),
      ...collectStringArray(sku.benefitTagsList),
      ...collectStringArray(sku.key_benefits),
      ...collectStringArray(sku.keyBenefits),
    );
  }

  return uniqStrings(textParts, anchorOnly ? 24 : 72)
    .join(' ')
    .toLowerCase();
}

function computeExternalSeedSurfacingMatch({
  query = '',
  candidate = null,
  anchorOnly = false,
} = {}) {
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
  const haystack = buildExternalSeedSurfacingText(row, { anchorOnly });
  const normalizedQuery = normalizeSurfacingSearchText(query);
  const queryTokens =
    tokenizeSurfacingSearchText(query, { max: 20, dropStopwords: true }).length > 0
      ? tokenizeSurfacingSearchText(query, { max: 20, dropStopwords: true })
      : tokenizeSurfacingSearchText(query, { max: 20, dropStopwords: false });
  if (!haystack || !queryTokens.length) {
    return {
      exact_phrase: false,
      overlap: 0,
      total: queryTokens.length,
      ratio: 0,
      strong: false,
      weak: true,
      score: 0,
    };
  }

  const haystackWrapped = ` ${haystack} `;
  const overlap = queryTokens.reduce((count, token) => (
    haystackWrapped.includes(` ${String(token).toLowerCase()} `) ? count + 1 : count
  ), 0);
  const ratio = queryTokens.length ? Number((overlap / queryTokens.length).toFixed(3)) : 0;
  const exactPhrase = Boolean(normalizedQuery) && haystackWrapped.includes(` ${normalizedQuery} `);
  const strong =
    exactPhrase ||
    overlap >= Math.max(2, Math.ceil(queryTokens.length * 0.66)) ||
    (queryTokens.length <= 2 && overlap === queryTokens.length && overlap > 0);
  const weak = !strong && overlap <= 1;
  const score =
    (exactPhrase ? 200 : 0) +
    (strong ? 60 : 0) +
    (overlap * 25) +
    Math.round(ratio * 100);

  return {
    exact_phrase: exactPhrase,
    overlap,
    total: queryTokens.length,
    ratio,
    strong,
    weak,
    score,
  };
}

function choosePreferredExternalSeedCandidate({
  query = '',
  internalCandidate = null,
  externalCandidate = null,
} = {}) {
  const internalMatch = computeExternalSeedSurfacingMatch({
    query,
    candidate: internalCandidate,
    anchorOnly: true,
  });
  const externalMatch = computeExternalSeedSurfacingMatch({
    query,
    candidate: externalCandidate,
    anchorOnly: true,
  });

  if (!internalCandidate && !externalCandidate) {
    return {
      preferredSource: 'none',
      candidate: null,
      internalMatch,
      externalMatch,
    };
  }
  if (internalCandidate && !externalCandidate) {
    return {
      preferredSource: 'internal',
      candidate: internalCandidate,
      internalMatch,
      externalMatch,
    };
  }
  if (!internalCandidate && externalCandidate) {
    return {
      preferredSource: 'external_seed',
      candidate: externalCandidate,
      internalMatch,
      externalMatch,
    };
  }

  if (externalMatch.score > internalMatch.score + 5) {
    return {
      preferredSource: 'external_seed',
      candidate: externalCandidate,
      internalMatch,
      externalMatch,
    };
  }
  if (externalMatch.strong && !internalMatch.strong) {
    return {
      preferredSource: 'external_seed',
      candidate: externalCandidate,
      internalMatch,
      externalMatch,
    };
  }
  return {
    preferredSource: 'internal',
    candidate: internalCandidate,
    internalMatch,
    externalMatch,
  };
}

module.exports = {
  buildExternalSeedSurfacingText,
  choosePreferredExternalSeedCandidate,
  computeExternalSeedSurfacingMatch,
  normalizeSurfacingSearchText,
  tokenizeSurfacingSearchText,
};

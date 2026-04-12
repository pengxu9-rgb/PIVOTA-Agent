function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function uniqCaseInsensitiveStrings(values, maxItems = 32) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = normalizeNonEmptyString(raw);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeAuthorityText(value) {
  return normalizeNonEmptyString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[%]/g, ' percent ')
    .replace(/[+]/g, ' plus ')
    .replace(/[_/|]+/g, ' ')
    .replace(/[-‐‑–—]+/g, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function compactAuthorityText(value) {
  return normalizeAuthorityText(value).replace(/\s+/g, '');
}

function splitAuthorityWords(value) {
  return normalizeAuthorityText(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinBrandAndName(brand, name) {
  const normalizedBrand = normalizeNonEmptyString(brand);
  const normalizedName = normalizeNonEmptyString(name);
  return [normalizedBrand, normalizedName].filter(Boolean).join(' ').trim();
}

function buildTailPhrases(words, { minWords = 2, maxPhrases = 4 } = {}) {
  const list = Array.isArray(words) ? words.filter(Boolean) : [];
  if (list.length < minWords + 1) return [];
  const out = [];
  for (let start = 1; start < list.length - (minWords - 1); start += 1) {
    const phrase = list.slice(start).join(' ').trim();
    if (phrase) out.push(phrase);
    if (out.length >= maxPhrases) break;
  }
  return out;
}

function buildBigramPhrases(words, { maxItems = 8 } = {}) {
  const list = Array.isArray(words) ? words.filter(Boolean) : [];
  const out = [];
  for (let idx = 0; idx < list.length - 1; idx += 1) {
    const left = String(list[idx] || '').trim();
    const right = String(list[idx + 1] || '').trim();
    if (!left || !right) continue;
    out.push(`${left} ${right}`);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildSpfVariants(text) {
  const normalized = normalizeAuthorityText(text);
  if (!normalized) return [];
  const matches = Array.from(normalized.matchAll(/\bspf\s*(\d{2,3})(?:\s*(plus))?\b/g));
  if (!matches.length) return [];
  const out = [];
  for (const match of matches) {
    const value = String(match[1] || '').trim();
    const hasPlus = String(match[2] || '').trim() === 'plus';
    if (!value) continue;
    const compact = hasPlus ? `spf${value}+` : `spf${value}`;
    const spaced = hasPlus ? `spf ${value} plus` : `spf ${value}`;
    out.push(normalized.replace(match[0], compact).trim());
    out.push(normalized.replace(match[0], spaced).trim());
    if (hasPlus) {
      out.push(normalized.replace(match[0], `spf ${value}`).trim());
      out.push(normalized.replace(match[0], `spf${value}`).trim());
    }
  }
  return uniqCaseInsensitiveStrings(out, 8);
}

function buildPhraseVariants(value, { includeTailPhrases = false } = {}) {
  const raw = normalizeNonEmptyString(value);
  if (!raw) return [];
  const normalized = normalizeAuthorityText(raw);
  const compact = compactAuthorityText(raw);
  const words = splitAuthorityWords(raw);
  const out = uniqCaseInsensitiveStrings(
    [
      raw,
      normalized,
      compact.length >= 6 ? compact : '',
      ...buildSpfVariants(raw),
      ...(includeTailPhrases ? buildTailPhrases(words) : []),
      ...(includeTailPhrases ? buildBigramPhrases(words) : []),
    ],
    24,
  );
  return out;
}

function buildRecoAuthorityAliasTokens({
  brand = '',
  name = '',
  category = '',
  usageRole = '',
  searchAliases = [],
} = {}) {
  const stopwords = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'official',
    'beauty',
    'shop',
    'product',
    'products',
    'new',
    'care',
    'daily',
  ]);
  const brandWords = new Set(splitAuthorityWords(brand));
  const phraseSurfaces = uniqCaseInsensitiveStrings(
    [
      ...buildPhraseVariants(name, { includeTailPhrases: true }),
      ...buildPhraseVariants(category),
      ...buildPhraseVariants(usageRole),
      ...[].concat(searchAliases || []).flatMap((alias) => buildPhraseVariants(alias, { includeTailPhrases: true })),
    ],
    24,
  );
  const tokenSurfaces = [];
  for (const phrase of phraseSurfaces) {
    for (const word of splitAuthorityWords(phrase)) {
      if (!word || word.length < 2 || brandWords.has(word) || stopwords.has(word)) continue;
      tokenSurfaces.push(word);
    }
  }
  return uniqCaseInsensitiveStrings([...phraseSurfaces, ...tokenSurfaces], 32);
}

function buildRecoAuthorityQueryVariants({
  brand = '',
  name = '',
  category = '',
  usageRole = '',
  searchAliases = [],
  maxVariants = 6,
} = {}) {
  const normalizedBrand = normalizeNonEmptyString(brand);
  const normalizedName = normalizeNonEmptyString(name);
  const label = joinBrandAndName(normalizedBrand, normalizedName);
  const normalizedLabel = normalizeAuthorityText(label);
  const normalizedNameSurface = normalizeAuthorityText(normalizedName);
  const aliasCandidates = buildRecoAuthorityAliasTokens({
    brand: normalizedBrand,
    name: normalizedName,
    category,
    usageRole,
    searchAliases,
  });
  const candidates = [
    { query: label, kind: 'brand_name_exact' },
    { query: normalizedLabel, kind: 'brand_name_normalized' },
    { query: normalizedName, kind: 'name_exact' },
    { query: normalizedNameSurface, kind: 'name_normalized' },
    ...aliasCandidates.map((query) => ({ query, kind: 'alias' })),
  ];

  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const query = normalizeNonEmptyString(candidate?.query);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      query,
      normalized_query: normalizeAuthorityText(query),
      kind: normalizeNonEmptyString(candidate?.kind) || 'alias',
    });
    if (out.length >= Math.max(1, Number(maxVariants) || 6)) break;
  }
  return out;
}

function buildRecoAuthoritySearchAliases({
  brand = '',
  name = '',
  category = '',
  usageRole = '',
  searchAliases = [],
  maxAliases = 8,
} = {}) {
  const variants = buildRecoAuthorityQueryVariants({
    brand,
    name,
    category,
    usageRole,
    searchAliases,
    maxVariants: Math.max(maxAliases, 6),
  });
  return uniqCaseInsensitiveStrings(
    [
      ...variants.map((item) => item.query),
      ...[].concat(searchAliases || []),
    ],
    Math.max(1, Number(maxAliases) || 8),
  );
}

module.exports = {
  normalizeAuthorityText,
  compactAuthorityText,
  splitAuthorityWords,
  buildRecoAuthorityAliasTokens,
  buildRecoAuthorityQueryVariants,
  buildRecoAuthoritySearchAliases,
};

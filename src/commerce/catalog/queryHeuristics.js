const {
  createSearchRelevanceHelpers,
} = require('./searchRelevance');

function createCatalogQueryHeuristics({
  normalizeResolverText,
  tokenizeResolverQuery,
  isKnownLookupAliasQueryBase,
  expandLookupAnchorTokensBase,
  hasPetSearchSignal,
  hasPetHarnessSearchSignal,
  hasBeautyMakeupSearchSignal,
} = {}) {
  const {
    normalizeSearchTextForMatch,
    sanitizeSearchQueryForRelevance,
    extractSearchAnchorTokens,
    isLookupStyleSearchQuery,
    expandLookupAnchorTokens,
  } = createSearchRelevanceHelpers({
    normalizeResolverText,
    tokenizeResolverQuery,
    isKnownLookupAliasQueryBase,
    expandLookupAnchorTokensBase,
    hasPetSearchSignal,
    hasPetHarnessSearchSignal,
    hasBeautyMakeupSearchSignal,
  });

  function looksSkuLikeQuery(queryText) {
    const normalized = String(queryText || '').trim().toLowerCase();
    if (!normalized) return false;
    if (!/[0-9]/.test(normalized)) return false;
    return /^[a-z0-9-]{6,}$/.test(normalized);
  }

  function tokenizeQueryForCache(queryText) {
    const rawInput = String(queryText || '').trim();
    const lowerInput = rawInput.toLowerCase();
    const sanitizedInput = sanitizeSearchQueryForRelevance(rawInput);
    const resolverInput = sanitizedInput || rawInput;
    const resolverNormalized = normalizeResolverText
      ? normalizeResolverText(resolverInput)
      : String(resolverInput || '').trim().toLowerCase();
    const resolverTokens = Array.isArray(tokenizeResolverQuery?.(resolverNormalized))
      ? tokenizeResolverQuery(resolverNormalized)
      : String(resolverNormalized || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
    const latinTokens = lowerInput.split(/[^a-z0-9]+/g).filter(Boolean);
    const cjkTokens = Array.from(
      new Set(
        (resolverInput.match(/[\u4e00-\u9fff]{2,}/g) || [])
          .map((token) => String(token || '').trim())
          .filter(Boolean),
      ),
    );
    const raw = [...latinTokens, ...resolverTokens, ...cjkTokens];

    if (hasPetSearchSignal?.(rawInput)) {
      raw.push('dog', 'pet');
      if (hasPetHarnessSearchSignal?.(rawInput)) {
        raw.push('harness', 'leash', 'collar');
      }
    }

    if (hasBeautyMakeupSearchSignal?.(rawInput)) {
      raw.push(
        'makeup',
        'cosmetic',
        'beauty',
        'foundation',
        'concealer',
        'lipstick',
        'blush',
        'mascara',
        'eyeshadow',
        'brush',
        'palette',
        'fenty',
        'tom ford',
      );
    }

    const stop = new Set([
      'a',
      'an',
      'and',
      'are',
      'as',
      'at',
      'be',
      'bought',
      'by',
      'can',
      'could',
      'do',
      'does',
      'for',
      'from',
      'have',
      'help',
      'i',
      'in',
      'is',
      'it',
      'just',
      'like',
      'me',
      'my',
      'of',
      'on',
      'or',
      'please',
      'some',
      'that',
      'the',
      'their',
      'them',
      'this',
      'to',
      'u',
      'we',
      'what',
      'which',
      'with',
      'you',
      'your',
      '什么',
      '有什麼',
      '有什么',
      '有沒有',
      '有哪些',
      '哪些',
      '的吗',
      '的嗎',
      '有吗',
      '有嗎',
      '吗',
      '嗎',
      '呢',
      '的',
      '了',
    ]);

    const kept = [];
    for (const token of raw) {
      const normalizedToken = normalizeSearchTextForMatch(token);
      if (!normalizedToken) continue;
      if (stop.has(normalizedToken)) continue;
      const isLatinToken = /^[a-z0-9]+$/.test(normalizedToken);
      if (isLatinToken && normalizedToken.length < 3 && normalizedToken !== 'xs' && normalizedToken !== 'xl') {
        continue;
      }
      if (!isLatinToken && normalizedToken.length < 2) continue;
      kept.push(normalizedToken);
    }

    const seen = new Set();
    const uniq = [];
    for (const token of kept) {
      if (seen.has(token)) continue;
      seen.add(token);
      uniq.push(token);
    }

    const lookupExpanded = isLookupStyleSearchQuery(rawInput, extractSearchAnchorTokens(rawInput))
      ? expandLookupAnchorTokens(rawInput, uniq)
      : uniq;

    const expandedSeen = new Set();
    const expandedUniq = [];
    for (const token of lookupExpanded) {
      const normalizedToken = normalizeSearchTextForMatch(token);
      if (!normalizedToken) continue;
      if (stop.has(normalizedToken)) continue;
      if (expandedSeen.has(normalizedToken)) continue;
      expandedSeen.add(normalizedToken);
      expandedUniq.push(normalizedToken);
    }

    if (expandedUniq.length <= 8) return expandedUniq;
    const first = expandedUniq.slice(0, 4);
    const last = expandedUniq.slice(-4);
    const outSeen = new Set();
    const out = [];
    for (const token of [...first, ...last]) {
      if (outSeen.has(token)) continue;
      outSeen.add(token);
      out.push(token);
      if (out.length >= 8) break;
    }
    return out;
  }

  function detectToyOutfitIntentFromQuery(queryText) {
    const normalized = String(queryText || '').toLowerCase();
    const toy = /\b(labubu|toy|toys|doll|dolls|plush|plushie|figure|collectible)\b/.test(normalized);
    const outfit =
      /\b(clothes|clothing|outfit|accessory|accessories|hat)\b/.test(normalized) || /衣服|穿/.test(normalized);
    const lingerie =
      /\b(lingerie|underwear|bra|pant(y|ies)|thong|sleepwear|nightgown|nightdress)\b/.test(normalized);
    return {
      toy_intent: toy,
      outfit_intent: toy && outfit,
      lingerie_intent: lingerie,
    };
  }

  function buildUnderwearExclusionSql(startIndex) {
    const tokens = [
      'lingerie',
      'underwear',
      'bra',
      'panties',
      'panty',
      'briefs',
      'thong',
      'push-up',
      'push up',
      'backless',
      "women's sleepwear",
      'womens sleepwear',
      'women sleepwear',
      'sleepwear set',
      "women's lingerie",
      'lingerie set',
      'ropa interior',
      'sujetador',
      'bragas',
    ];

    const fields = [
      "lower(coalesce(product_data->>'title',''))",
      "lower(coalesce(product_data->>'product_type',''))",
    ];

    const parts = [];
    const params = [];
    let idx = startIndex;
    for (const token of tokens) {
      params.push(`%${token}%`);
      const ors = fields.map((field) => `${field} LIKE $${idx}`).join(' OR ');
      parts.push(`(${ors})`);
      idx += 1;
    }

    return {
      sql: parts.length ? `NOT (${parts.join(' OR ')})` : 'TRUE',
      params,
      nextIndex: idx,
    };
  }

  return {
    looksSkuLikeQuery,
    tokenizeQueryForCache,
    detectToyOutfitIntentFromQuery,
    buildUnderwearExclusionSql,
  };
}

module.exports = {
  createCatalogQueryHeuristics,
};

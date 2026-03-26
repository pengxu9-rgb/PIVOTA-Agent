const SEARCH_QUERY_NOISE_RE =
  /有货|库存|有没有|有無|有沒|有没|是否有|能买|能买吗|哪里买|哪裡買|相關|相关|related|推荐|推薦|recommend(?:ed|ation|ations)?|products?|items?|show\s+me|where\s+to\s+buy|in\s+stock|instock|availability|available|search|find|please|商品|产品|買|购买|買う|买/gimu;
const SEARCH_QUERY_STOP_TOKENS = new Set([
  'a',
  'an',
  'and',
  'any',
  'available',
  'availability',
  'beauty',
  'buy',
  'find',
  'for',
  'how',
  'i',
  'in',
  'instock',
  'is',
  'item',
  'items',
  'me',
  'my',
  'of',
  'on',
  'or',
  'please',
  'product',
  'products',
  'recommend',
  'recommended',
  'related',
  'search',
  'show',
  'stock',
  'the',
  'to',
  'where',
  'with',
  'you',
  'your',
  '可以买',
  '能买吗',
  'products',
  '买',
  '产品',
  '商品',
  '推荐',
  '相關',
  '相关',
  '有货',
  '库存',
  '有没有',
  '哪里买',
  '哪裡買',
  '护肤',
  '化妆',
  '化妆品',
  '美妆',
]);
const BEAUTY_FORM_FACTOR_TOKENS = new Set([
  'serum',
  'essence',
  'ampoule',
  'lotion',
  'cream',
  'moisturizer',
  'moisturiser',
  'cleanser',
  'toner',
  'mask',
  'spf',
  'sunscreen',
]);
const FRAGRANCE_SEMANTIC_TERMS = [
  'fragrance',
  'perfume',
  'parfum',
  'cologne',
  'eau de parfum',
  'eau de toilette',
  'body mist',
];
const FRAGRANCE_QUERY_REGEX =
  /\b(perfume|fragrance|parfum|cologne|body mist|eau de parfum|eau de toilette)\b/i;

function createSearchRelevanceHelpers({
  firstQueryParamValue,
  normalizeResolverText,
  tokenizeResolverQuery,
  isKnownLookupAliasQueryBase,
  expandLookupAnchorTokensBase,
  hasPetSearchSignal,
  hasPetHarnessSearchSignal,
  hasBeautyMakeupSearchSignal,
  searchExternalHardRulePrune = true,
  searchCacheValidate = false,
  searchCacheMinCount = 6,
  searchCacheMinAnchor = 0.15,
  searchCacheMaxDomainEntropy = 0.55,
  searchCacheMaxCrossDomainRatio = 0.08,
} = {}) {
  const firstParam =
    typeof firstQueryParamValue === 'function'
      ? firstQueryParamValue
      : (value) => {
          if (Array.isArray(value)) {
            for (const item of value) {
              if (item != null && String(item).trim()) return item;
            }
            return value.length > 0 ? value[0] : undefined;
          }
          return value;
        };
  const normalizeResolver =
    typeof normalizeResolverText === 'function'
      ? normalizeResolverText
      : (value) => String(value || '').trim().toLowerCase();
  const tokenizeResolver =
    typeof tokenizeResolverQuery === 'function'
      ? tokenizeResolverQuery
      : (value) =>
          String(value || '')
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
  const hasPetSearchSignalImpl =
    typeof hasPetSearchSignal === 'function' ? hasPetSearchSignal : () => false;
  const hasPetHarnessSearchSignalImpl =
    typeof hasPetHarnessSearchSignal === 'function' ? hasPetHarnessSearchSignal : () => false;
  const hasBeautyMakeupSearchSignalImpl =
    typeof hasBeautyMakeupSearchSignal === 'function' ? hasBeautyMakeupSearchSignal : () => false;

  function extractSearchQueryText(rawQuery) {
    const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
    const raw =
      firstParam(query.query) ??
      firstParam(query.q) ??
      firstParam(query.keyword) ??
      firstParam(query.text);
    return String(raw || '').trim();
  }

  function normalizeSearchQueryParams(rawQuery) {
    const queryParams =
      rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery) ? { ...rawQuery } : {};
    const queryText = extractSearchQueryText(queryParams);
    const hasQuery = String(firstParam(queryParams.query) || '').trim().length > 0;
    if (queryText && !hasQuery) {
      queryParams.query = queryText;
    }
    return { queryText, queryParams };
  }

  function extractSearchProductId(product) {
    if (!product || typeof product !== 'object') return '';
    const raw =
      product.product_id ||
      product.productId ||
      product.platform_product_id ||
      product.platformProductId ||
      product.sku_id ||
      product.skuId ||
      product.id;
    return String(raw || '').trim();
  }

  function hasUsableSearchProduct(product) {
    if (!product || typeof product !== 'object') return false;
    const merchantId = String(product.merchant_id || product.merchantId || '').trim();
    if (!merchantId) return false;
    return Boolean(extractSearchProductId(product));
  }

  function countUsableSearchProducts(products) {
    if (!Array.isArray(products)) return 0;
    return products.filter((product) => hasUsableSearchProduct(product)).length;
  }

  function normalizeSearchTextForMatch(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenizeSearchTextForMatch(raw) {
    return normalizeSearchTextForMatch(raw)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
  }

  function sanitizeSearchQueryForRelevance(raw) {
    return String(raw || '')
      .replace(SEARCH_QUERY_NOISE_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractSearchAnchorTokens(queryText) {
    const sanitized = sanitizeSearchQueryForRelevance(queryText);
    const resolverInput = sanitized || String(queryText || '');
    const resolverNormalized = normalizeResolver(resolverInput);
    const resolverTokens = Array.isArray(tokenizeResolver(resolverNormalized))
      ? tokenizeResolver(resolverNormalized)
      : [];
    const looseTokens = tokenizeSearchTextForMatch(resolverInput);

    const anchors = [];
    const seen = new Set();
    for (const token of [...resolverTokens, ...looseTokens]) {
      const normalized = normalizeSearchTextForMatch(token);
      if (!normalized || SEARCH_QUERY_STOP_TOKENS.has(normalized)) continue;
      if (/^[0-9]+$/.test(normalized)) continue;

      const isLatin = /^[a-z0-9]+$/.test(normalized);
      if (isLatin && normalized.length < 3) continue;
      if (!isLatin && normalized.length < 2) continue;

      if (seen.has(normalized)) continue;
      seen.add(normalized);
      anchors.push(normalized);
      if (anchors.length >= 10) break;
    }
    return anchors;
  }

  function isKnownLookupAliasQuery(queryText) {
    if (typeof isKnownLookupAliasQueryBase !== 'function') return false;
    return isKnownLookupAliasQueryBase({
      queryText,
      normalizeSearchTextForMatch,
    });
  }

  function expandLookupAnchorTokens(queryText, anchorTokens) {
    if (typeof expandLookupAnchorTokensBase !== 'function') {
      return Array.isArray(anchorTokens) ? anchorTokens : [];
    }
    return expandLookupAnchorTokensBase({
      queryText,
      anchorTokens,
      normalizeSearchTextForMatch,
      tokenizeSearchTextForMatch,
    });
  }

  function isLookupStyleSearchQuery(queryText, anchorTokens = null) {
    const raw = String(queryText || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    const hasStrongLookupEntity =
      /\bsku\b|\bmodel\b|型号|型號/.test(raw) ||
      /\b[a-z]{1,6}\d{2,}\b/i.test(raw) ||
      isKnownLookupAliasQuery(raw);
    if (/(ipsa|茵芙莎|winona|薇诺娜|the ordinary|sk[\s-]?ii|流金水|神仙水|time reset aqua)/i.test(lower)) {
      return true;
    }
    if (
      /(有货|库存|有没有|哪里买|能买|能买吗|where to buy|in stock|available|availability)/i.test(lower) &&
      hasStrongLookupEntity
    ) {
      return true;
    }
    if (hasPetHarnessSearchSignalImpl(raw) || hasBeautyMakeupSearchSignalImpl(raw)) {
      return false;
    }
    const anchors = Array.isArray(anchorTokens) ? anchorTokens : extractSearchAnchorTokens(raw);
    if (!anchors.length) return false;
    if (
      anchors.length <= 2 &&
      raw.length <= 48 &&
      !/(推荐|recommend|best|适合|怎么|教程|搭配|guide|tips)/i.test(lower)
    ) {
      return true;
    }
    return false;
  }

  function hasFragranceQuerySignal(queryText = '') {
    return FRAGRANCE_QUERY_REGEX.test(String(queryText || ''));
  }

  function buildFragranceSemanticRetryQuery(queryText = '') {
    const raw = String(queryText || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    const terms = [raw];
    let appendedAnySemanticTerm = false;
    for (const item of FRAGRANCE_SEMANTIC_TERMS) {
      if (!lower.includes(item)) {
        terms.push(item);
        appendedAnySemanticTerm = true;
      }
    }
    if (!appendedAnySemanticTerm) {
      if (!lower.includes('fragrance products')) {
        terms.push('fragrance products');
      } else if (!lower.includes('fragrance catalog')) {
        terms.push('fragrance catalog');
      } else {
        terms.push('fragrance shopping');
      }
    }
    const joined = terms.join(' ').replace(/\s+/g, ' ').trim();
    return joined.length > 220 ? joined.slice(0, 220).trim() : joined;
  }

  function buildFallbackCandidateText(product) {
    if (!product || typeof product !== 'object') return '';
    const parts = [
      product.title,
      product.name,
      product.display_name,
      product.brand,
      product.vendor,
      product.product_name,
      product.description,
      product.product_type,
      product.category,
      product.external_domain,
      product.external_url,
      product.canonical_url,
      product.destination_url,
    ]
      .map((v) => String(v || '').trim())
      .filter(Boolean);
    return normalizeSearchTextForMatch(parts.join(' '));
  }

  function hasBrandTermMatch(candidateText, brandTerm) {
    const normalizedCandidate = normalizeSearchTextForMatch(candidateText);
    const normalizedTerm = normalizeSearchTextForMatch(brandTerm);
    if (!normalizedCandidate || !normalizedTerm) return false;
    if (normalizedCandidate.includes(normalizedTerm)) return true;
    const compactTerm = normalizedTerm.replace(/\s+/g, '');
    const compactCandidate = normalizedCandidate.replace(/\s+/g, '');
    if (compactTerm && compactCandidate.includes(compactTerm)) return true;
    const rawTokens = tokenizeSearchTextForMatch(normalizedTerm);
    const coreTokens = rawTokens.filter(
      (token) =>
        token &&
        !['beauty', 'cosmetics', 'cosmetic', 'fragrance', 'perfume', 'parfum', 'makeup'].includes(
          token,
        ),
    );
    const tokens = coreTokens.length > 0 ? coreTokens : rawTokens;
    if (!tokens.length) return false;
    if (tokens.length === 1) return normalizedCandidate.includes(tokens[0]);
    return tokens.every((token) => normalizedCandidate.includes(token));
  }

  function hasBeautyIngredientIntentSignal(queryText) {
    const q = normalizeSearchTextForMatch(queryText);
    if (!q) return false;
    return (
      /\b(copper|peptide|tripeptide|tetrapeptide|hexapeptide|retinol|retinal|niacinamide|ceramide|hyaluronic|ascorbic|vitamin c|salicylic|glycolic|lactic|mandelic|azelaic|tranexamic|benzoyl)\b/i.test(
        q,
      ) ||
      /(铜肽|胜肽|视黄醇|烟酰胺|神经酰胺|玻尿酸|水杨酸|果酸|壬二酸)/.test(q)
    );
  }

  function buildBeautyIngredientIntentTokens(queryText, queryTokens = []) {
    const normalized = normalizeSearchTextForMatch(queryText);
    const out = new Set();
    const pushToken = (token) => {
      const value = normalizeSearchTextForMatch(token);
      if (!value || BEAUTY_FORM_FACTOR_TOKENS.has(value) || value.length < 3) return;
      out.add(value);
    };

    for (const token of Array.isArray(queryTokens) ? queryTokens : []) {
      pushToken(token);
    }

    if (!normalized) return Array.from(out);
    if (/\bcopper\b/.test(normalized) && /\b(peptide|tripeptide|tetrapeptide|hexapeptide)/.test(normalized)) {
      pushToken('copper');
      pushToken('peptide');
      pushToken('multi peptide');
      pushToken('copper tripeptide');
      pushToken('tripeptide');
    }
    if (/\b(peptide|tripeptide|tetrapeptide|hexapeptide)/.test(normalized)) {
      pushToken('peptide');
      pushToken('multi peptide');
    }
    if (/\bretinol|retinal|retinoid/.test(normalized)) pushToken('retinol');
    if (/\bniacinamide/.test(normalized)) pushToken('niacinamide');
    if (/\bceramide/.test(normalized)) pushToken('ceramide');
    if (/\bhyaluronic/.test(normalized)) pushToken('hyaluronic');
    if (/\bascorbic|vitamin c/.test(normalized)) pushToken('vitamin c');
    if (/\bsalicylic/.test(normalized)) pushToken('salicylic');
    if (/\bglycolic/.test(normalized)) pushToken('glycolic');
    if (/\blactic/.test(normalized)) pushToken('lactic');
    if (/\bazelaic/.test(normalized)) pushToken('azelaic');
    if (/\btranexamic/.test(normalized)) pushToken('tranexamic');

    return Array.from(out);
  }

  function buildFallbackOverlapPreview(products, queryText, maxItems = 3) {
    const rows = [];
    const normalizedQuery = normalizeSearchTextForMatch(queryText);
    const baseTokens = Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
    const ingredientIntent = hasBeautyIngredientIntentSignal(queryText);
    const meaningfulTokens = ingredientIntent
      ? baseTokens.filter((token) => !BEAUTY_FORM_FACTOR_TOKENS.has(token))
      : baseTokens;
    const intentTokens = ingredientIntent
      ? buildBeautyIngredientIntentTokens(queryText, meaningfulTokens)
      : [];
    const effectiveTokens = Array.from(new Set([...meaningfulTokens, ...intentTokens])).slice(0, 12);

    for (const product of Array.isArray(products) ? products : []) {
      if (rows.length >= maxItems) break;
      if (!hasUsableSearchProduct(product)) continue;
      const candidateText = buildFallbackCandidateText(product);
      if (!candidateText) continue;
      const matched = effectiveTokens.filter((token) => candidateText.includes(token)).slice(0, 4);
      rows.push({
        product_id: String(product?.product_id || product?.id || ''),
        title: String(product?.title || product?.name || ''),
        overlap_count: matched.length,
        matched_tokens: matched,
      });
    }
    return rows;
  }

  function hasFragranceSearchSignal(queryText) {
    return (
      /\b(perfume|fragrance|parfum|cologne|body mist|eau de parfum|eau de toilette)\b/i.test(
        String(queryText || ''),
      ) ||
      /香水|体香喷雾|體香噴霧/.test(String(queryText || ''))
    );
  }

  function hasLingerieSearchSignal(queryText) {
    return (
      /\b(lingerie|underwear|bra|bras|panty|panties|thong|sleepwear|nightgown|nightdress|bodysuit|bralette|intimates?)\b/i.test(
        String(queryText || ''),
      ) ||
      /内衣|內衣|文胸|胸罩|情趣|ブラ|ランジェリー/.test(String(queryText || ''))
    );
  }

  function hasLingerieCatalogProductSignal(candidateText) {
    return (
      /\b(lingerie|underwear|bra|bras|panty|panties|thong|sleepwear|nightgown|nightdress|bodysuit|bralette|intimates?|teddy|mesh panels?)\b/i.test(
        String(candidateText || ''),
      ) ||
      /内衣|內衣|文胸|胸罩|情趣|ブラ|ランジェリー/.test(String(candidateText || ''))
    );
  }

  function isProxySearchFallbackRelevant(normalized, queryText) {
    const products = Array.isArray(normalized?.products) ? normalized.products : [];
    if (!products.length) return false;

    const normalizedQuery = normalizeSearchTextForMatch(queryText);
    if (!normalizedQuery) return true;
    if (hasFragranceQuerySignal(queryText)) {
      return products.slice(0, 8).some((product) => hasUsableSearchProduct(product));
    }

    if (hasLingerieSearchSignal(queryText)) {
      for (const product of products.slice(0, 8)) {
        if (!hasUsableSearchProduct(product)) continue;
        const candidateText = buildFallbackCandidateText(product);
        if (!candidateText) continue;
        if (hasLingerieCatalogProductSignal(candidateText)) return true;
      }
      return false;
    }

    const hasPetHarnessSignal = hasPetHarnessSearchSignalImpl(queryText);
    if (hasPetHarnessSignal) {
      for (const product of products.slice(0, 8)) {
        if (!hasUsableSearchProduct(product)) continue;
        const candidateText = buildFallbackCandidateText(product);
        if (!candidateText) continue;
        if (
          /\b(dog harness|cat harness|pet harness|harness vest|pet vest)\b/i.test(candidateText) ||
          /宠物背带|宠物胸背|狗背带|猫背带/.test(candidateText)
        ) {
          return true;
        }
      }
      return false;
    }

    if (hasBeautyMakeupSearchSignalImpl(queryText)) {
      for (const product of products.slice(0, 8)) {
        if (!hasUsableSearchProduct(product)) continue;
        const candidateText = buildFallbackCandidateText(product);
        if (!candidateText) continue;
        if (
          /\b(brush|brushes|blender|sponge|powder puff|puff|applicator|eyelash curler|tool kit|makeup tool)\b/i.test(
            candidateText,
          )
        ) {
          return true;
        }
      }
      return false;
    }

    const anchorTokens = extractSearchAnchorTokens(queryText);
    const lookupTokens = expandLookupAnchorTokens(queryText, anchorTokens);
    if (isLookupStyleSearchQuery(queryText, anchorTokens) && lookupTokens.length > 0) {
      for (const product of products.slice(0, 8)) {
        if (!hasUsableSearchProduct(product)) continue;
        const candidateText = buildFallbackCandidateText(product);
        if (!candidateText) continue;
        if (lookupTokens.some((token) => candidateText.includes(token))) return true;
      }
      return false;
    }

    const queryTokens = Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
    const ingredientIntent = hasBeautyIngredientIntentSignal(queryText);
    const meaningfulTokens = ingredientIntent
      ? queryTokens.filter((token) => !BEAUTY_FORM_FACTOR_TOKENS.has(token))
      : queryTokens;
    const intentTokens = ingredientIntent
      ? buildBeautyIngredientIntentTokens(queryText, meaningfulTokens)
      : [];
    const effectiveTokens = Array.from(new Set([...meaningfulTokens, ...intentTokens]));
    const longQuery = effectiveTokens.length >= 2;
    const requiredOverlap = ingredientIntent ? 1 : 2;

    for (const product of products.slice(0, 8)) {
      if (!hasUsableSearchProduct(product)) continue;
      const candidateText = buildFallbackCandidateText(product);
      if (!candidateText) continue;
      if (candidateText.includes(normalizedQuery)) return true;
      if (!effectiveTokens.length) return true;
      if (effectiveTokens.length === 1) return candidateText.includes(effectiveTokens[0]);
      if (!longQuery) return true;
      const overlapCount = effectiveTokens.filter((token) => candidateText.includes(token)).length;
      if (overlapCount >= requiredOverlap) return true;
    }

    return false;
  }

  function isSupplementCandidateRelevant(product, queryText, options = {}) {
    if (!product || typeof product !== 'object') return false;
    const candidateText = buildFallbackCandidateText(product);
    if (!candidateText) return false;

    const hasFragranceSearch = hasFragranceSearchSignal(queryText);
    const hasFragranceCandidateSignal =
      /\b(perfume|fragrance|parfum|cologne|body mist|eau de parfum|eau de toilette|scent|aroma)\b/i.test(
        candidateText,
      ) ||
      /\b(tom ford|jo malone|byredo|dior|chanel|ysl|guerlain|diptyque|le labo|creed|kilian|armani|versace|prada)\b/i.test(
        candidateText,
      );
    const isBeautyToolLikeCandidate =
      /\b(brush|brushes|blender|sponge|powder puff|puff|applicator|eyelash curler|tool kit|makeup tool)\b/i.test(
        candidateText,
      );

    if (hasFragranceSearch) {
      if (!hasFragranceCandidateSignal) return false;
      if (isBeautyToolLikeCandidate) return false;
      return true;
    }

    const brandTerms = Array.isArray(options.brandTerms)
      ? options.brandTerms
          .map((term) => normalizeSearchTextForMatch(term))
          .filter((term) => term && term.length >= 2)
      : [];
    if (brandTerms.length > 0) {
      const brandMatched = brandTerms.some((term) => hasBrandTermMatch(candidateText, term));
      if (!brandMatched && !searchExternalHardRulePrune) return false;
    }

    if (hasPetHarnessSearchSignalImpl(queryText)) {
      if (
        !/\b(dog harness|cat harness|pet harness|harness vest|pet vest)\b/i.test(candidateText) &&
        !/宠物背带|宠物胸背|狗背带|猫背带/.test(candidateText)
      ) {
        return false;
      }
    }

    if (
      hasBeautyMakeupSearchSignalImpl(queryText) &&
      !/\b(brush|brushes|blender|sponge|powder puff|puff|applicator|eyelash curler|tool kit|makeup tool)\b/i.test(
        candidateText,
      )
    ) {
      return false;
    }

    const normalizedQuery =
      typeof options.normalizedQuery === 'string'
        ? options.normalizedQuery
        : normalizeSearchTextForMatch(queryText);
    if (!normalizedQuery) return true;

    const anchorTokens = Array.isArray(options.anchorTokens)
      ? options.anchorTokens
      : extractSearchAnchorTokens(queryText);
    const lookupTokens = expandLookupAnchorTokens(queryText, anchorTokens);
    if (isLookupStyleSearchQuery(queryText, anchorTokens) && lookupTokens.length > 0) {
      return lookupTokens.some((token) => candidateText.includes(token));
    }

    if (candidateText.includes(normalizedQuery)) return true;

    const rawQueryTokens = Array.isArray(options.queryTokens)
      ? options.queryTokens
      : Array.from(new Set(tokenizeSearchTextForMatch(normalizedQuery)));
    const usefulQueryTokens = rawQueryTokens.filter((token) => {
      if (!token) return false;
      if (token.length < 2) return false;
      if (/^(de|of|the|for|and|to|a|an)$/i.test(token)) return false;
      return true;
    });
    const ingredientIntent = hasBeautyIngredientIntentSignal(queryText);
    const meaningfulTokens = ingredientIntent
      ? usefulQueryTokens.filter((token) => !BEAUTY_FORM_FACTOR_TOKENS.has(token))
      : usefulQueryTokens;
    const intentTokens = ingredientIntent
      ? buildBeautyIngredientIntentTokens(queryText, meaningfulTokens)
      : [];
    const effectiveTokens = Array.from(new Set([...meaningfulTokens, ...intentTokens]));
    if (!effectiveTokens.length) return true;
    if (effectiveTokens.length === 1) {
      return candidateText.includes(effectiveTokens[0]);
    }
    const overlapCount = effectiveTokens.filter((token) => candidateText.includes(token)).length;
    return overlapCount >= (ingredientIntent ? 1 : 2);
  }

  function inferCacheProductDomainKey(product) {
    if (!product || typeof product !== 'object') return 'general';
    const pivotaDomain = String(
      product?.attributes?.pivota?.domain || product?.domain || product?.category_domain || '',
    )
      .trim()
      .toLowerCase();
    if (pivotaDomain) {
      if (pivotaDomain === 'beauty') return 'beauty';
      if (pivotaDomain === 'pet' || pivotaDomain === 'pet_supplies') return 'pet';
      if (pivotaDomain === 'travel') return 'travel';
      if (
        pivotaDomain === 'hiking' ||
        pivotaDomain === 'outdoor' ||
        pivotaDomain === 'sports_outdoor'
      ) {
        return 'hiking';
      }
    }
    const text = buildFallbackCandidateText(product);
    if (!text) return 'general';
    if (
      /\b(dog|dogs|cat|cats|pet|harness|leash|collar|puppy|kitten)\b/i.test(text) ||
      /宠物|狗|猫|牵引|狗链|背带|项圈/.test(text)
    ) {
      return 'pet';
    }
    if (
      /\b(foundation|concealer|mascara|lipstick|serum|toner|moisturizer|makeup|cosmetic)\b/i.test(
        text,
      ) ||
      /化妆|美妆|护肤|精华|口红|粉底|防晒|唇膏|眼影/.test(text)
    ) {
      return 'beauty';
    }
    if (
      /\b(hiking|outdoor|camping|trekking|trail|parka|shell)\b/i.test(text) ||
      /徒步|登山|露营|冲锋衣|户外/.test(text)
    ) {
      return 'hiking';
    }
    if (
      /\b(luggage|packing|travel|toiletry|carry-on|adapter)\b/i.test(text) ||
      /行李|收纳|旅行|出差|分装|登机/.test(text)
    ) {
      return 'travel';
    }
    return 'general';
  }

  function inferIntentDomainKeyForCacheValidation(intent, queryText) {
    const target = String(intent?.target_object?.type || '').toLowerCase();
    const primaryDomain = String(intent?.primary_domain || '').toLowerCase();
    const normalizedQuery = normalizeSearchTextForMatch(queryText);
    if (target === 'pet' || hasPetSearchSignalImpl(normalizedQuery)) return 'pet';
    if (primaryDomain === 'beauty' || hasBeautyMakeupSearchSignalImpl(normalizedQuery)) {
      return 'beauty';
    }
    if (/travel|trip|business trip|packing|luggage|toiletry|出差|旅行|旅游|差旅/.test(normalizedQuery)) {
      return 'travel';
    }
    if (/hiking|trail|camping|outdoor|徒步|登山|露营|户外/.test(normalizedQuery)) {
      return 'hiking';
    }
    if (primaryDomain === 'sports_outdoor') return 'hiking';
    return null;
  }

  function computeDomainEntropyTopK(products, topK = 10) {
    const list = Array.isArray(products) ? products.slice(0, topK) : [];
    if (!list.length) return 1;
    const counts = new Map();
    for (const product of list) {
      const key = inferCacheProductDomainKey(product);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const total = list.length;
    if (!total || counts.size <= 1) return 0;
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log(p);
    }
    const maxEntropy = Math.log(counts.size);
    if (!(maxEntropy > 0)) return 0;
    return Math.max(0, Math.min(1, entropy / maxEntropy));
  }

  function computeAnchorRatioTopK(queryText, products, topK = 10) {
    const anchors = extractSearchAnchorTokens(queryText);
    if (!anchors.length) return 1;
    const list = Array.isArray(products) ? products.slice(0, topK) : [];
    if (!list.length) return 0;
    let matched = 0;
    for (const product of list) {
      const text = buildFallbackCandidateText(product);
      if (!text) continue;
      if (anchors.some((token) => text.includes(token))) matched += 1;
    }
    return Math.max(0, Math.min(1, matched / list.length));
  }

  function resolveCacheValidationMinCount(queryClass) {
    const qc = String(queryClass || '').toLowerCase();
    if (qc === 'lookup') return 1;
    if (qc === 'scenario' || qc === 'mission') {
      return Math.max(1, Math.min(searchCacheMinCount, 4));
    }
    return searchCacheMinCount;
  }

  function evaluateCacheQualityGate({ products, queryText, intent, queryClass }) {
    const list = Array.isArray(products) ? products : [];
    const minCount = resolveCacheValidationMinCount(queryClass);
    const anchorRatio = computeAnchorRatioTopK(queryText, list, 10);
    const domainEntropy = computeDomainEntropyTopK(list, 10);
    const expectedDomain = inferIntentDomainKeyForCacheValidation(intent, queryText);
    const topDomains = list.slice(0, 10).map((item) => inferCacheProductDomainKey(item));
    const crossDomainRatio =
      expectedDomain && topDomains.length > 0
        ? topDomains.filter((domain) => domain && domain !== 'general' && domain !== expectedDomain)
            .length / topDomains.length
        : null;
    const countOk = list.length >= minCount;
    const anchorOk = anchorRatio >= searchCacheMinAnchor;
    const entropyOk = domainEntropy <= searchCacheMaxDomainEntropy;
    const crossDomainOk =
      crossDomainRatio == null || crossDomainRatio <= searchCacheMaxCrossDomainRatio;
    const accepted = countOk && anchorOk && entropyOk && crossDomainOk;
    return {
      enabled: searchCacheValidate,
      accepted,
      min_count: minCount,
      count: list.length,
      anchor_ratio: anchorRatio,
      min_anchor: searchCacheMinAnchor,
      domain_entropy_topk: domainEntropy,
      max_domain_entropy: searchCacheMaxDomainEntropy,
      expected_domain: expectedDomain,
      cross_domain_ratio: crossDomainRatio,
      max_cross_domain_ratio: searchCacheMaxCrossDomainRatio,
      reason: accepted
        ? 'ok'
        : !countOk
          ? 'count_below_threshold'
          : !anchorOk
            ? 'anchor_below_threshold'
            : !entropyOk
              ? 'domain_entropy_above_threshold'
              : 'cross_domain_ratio_above_threshold',
    };
  }

  function computePrimaryQualityScore(gateResult) {
    if (!gateResult || typeof gateResult !== 'object') return null;
    const count = Math.max(0, Number(gateResult.count || 0) || 0);
    const minCount = Math.max(1, Number(gateResult.min_count || 1) || 1);
    const countScore = Math.max(0, Math.min(1, count / minCount));
    const anchorScore = Math.max(0, Math.min(1, Number(gateResult.anchor_ratio || 0) || 0));
    const entropyTopK = Math.max(0, Number(gateResult.domain_entropy_topk || 0) || 0);
    const maxEntropy = Math.max(0.01, Number(gateResult.max_domain_entropy || 1) || 1);
    const entropyScore = Math.max(0, Math.min(1, 1 - entropyTopK / maxEntropy));
    const crossDomainRatioRaw = gateResult.cross_domain_ratio;
    const maxCrossDomain = Math.max(
      0.01,
      Number(gateResult.max_cross_domain_ratio == null ? 1 : gateResult.max_cross_domain_ratio) || 1,
    );
    const crossDomainScore =
      crossDomainRatioRaw == null
        ? 1
        : Math.max(
            0,
            Math.min(1, 1 - (Math.max(0, Number(crossDomainRatioRaw) || 0) / maxCrossDomain)),
          );
    const composite = (countScore + anchorScore + entropyScore + crossDomainScore) / 4;
    return Math.max(0, Math.min(1, Number(composite.toFixed(3)) || 0));
  }

  return {
    extractSearchQueryText,
    normalizeSearchQueryParams,
    extractSearchProductId,
    hasUsableSearchProduct,
    countUsableSearchProducts,
    normalizeSearchTextForMatch,
    tokenizeSearchTextForMatch,
    sanitizeSearchQueryForRelevance,
    extractSearchAnchorTokens,
    isKnownLookupAliasQuery,
    expandLookupAnchorTokens,
    isLookupStyleSearchQuery,
    hasFragranceQuerySignal,
    buildFragranceSemanticRetryQuery,
    buildFallbackCandidateText,
    hasBrandTermMatch,
    hasBeautyIngredientIntentSignal,
    buildBeautyIngredientIntentTokens,
    buildFallbackOverlapPreview,
    hasFragranceSearchSignal,
    hasLingerieSearchSignal,
    hasLingerieCatalogProductSignal,
    isProxySearchFallbackRelevant,
    isSupplementCandidateRelevant,
    inferCacheProductDomainKey,
    inferIntentDomainKeyForCacheValidation,
    computeDomainEntropyTopK,
    computeAnchorRatioTopK,
    resolveCacheValidationMinCount,
    evaluateCacheQualityGate,
    computePrimaryQualityScore,
  };
}

module.exports = {
  createSearchRelevanceHelpers,
};

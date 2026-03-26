function firstQueryParamValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item != null && String(item).trim()) return item;
    }
    return value.length > 0 ? value[0] : undefined;
  }
  return value;
}

function parseQueryBoolean(value) {
  const raw = firstQueryParamValue(value);
  if (raw == null) return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseQueryNumber(value) {
  const raw = firstQueryParamValue(value);
  if (raw == null || String(raw).trim() === '') return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function parseQueryStringArray(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .flatMap((item) => String(item || '').split(','))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function extractSearchQueryText(rawQuery) {
  const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const raw =
    firstQueryParamValue(query.query) ??
    firstQueryParamValue(query.q) ??
    firstQueryParamValue(query.keyword) ??
    firstQueryParamValue(query.text);
  return String(raw || '').trim();
}

function normalizeSearchQueryParams(rawQuery) {
  const queryParams =
    rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery) ? { ...rawQuery } : {};
  const queryText = extractSearchQueryText(queryParams);
  const hasQuery = String(firstQueryParamValue(queryParams.query) || '').trim().length > 0;
  if (queryText && !hasQuery) {
    queryParams.query = queryText;
  }
  return { queryText, queryParams };
}

function buildFindProductsMultiPayloadFromQuery(rawQuery, options = {}) {
  const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const search = {};
  const metadata = {};
  const allowEmptyQuery = options.allowEmptyQuery === true;
  const searchLimitMax = Math.max(
    1,
    Number.isFinite(Number(options.searchLimitMax)) ? Number(options.searchLimitMax) : 200,
  );

  const textQuery = extractSearchQueryText(query);
  if (!textQuery && !allowEmptyQuery) return null;
  search.query = textQuery || '';

  const merchantId = String(firstQueryParamValue(query.merchant_id || query.merchantId) || '').trim();
  if (merchantId) search.merchant_id = merchantId;

  const merchantIds = parseQueryStringArray(query.merchant_ids || query.merchantIds);
  if (merchantIds.length > 0) search.merchant_ids = merchantIds;

  const searchAllMerchants = parseQueryBoolean(query.search_all_merchants || query.searchAllMerchants);
  if (searchAllMerchants !== undefined) search.search_all_merchants = searchAllMerchants;

  const inStockOnly = parseQueryBoolean(query.in_stock_only || query.inStockOnly);
  if (inStockOnly !== undefined) search.in_stock_only = inStockOnly;

  const lang = String(firstQueryParamValue(query.lang) || '').trim();
  if (lang) search.lang = lang;

  const category = String(firstQueryParamValue(query.category) || '').trim();
  if (category) search.category = category;

  const catalogSurface = String(firstQueryParamValue(query.catalog_surface || query.catalogSurface) || '').trim();
  if (catalogSurface) search.catalog_surface = catalogSurface;

  const commerceSurface = String(
    firstQueryParamValue(query.commerce_surface || query.commerceSurface) || '',
  ).trim();
  if (commerceSurface) search.commerce_surface = commerceSurface;

  const minPrice = parseQueryNumber(query.min_price ?? query.price_min);
  if (minPrice !== undefined) search.min_price = minPrice;

  const maxPrice = parseQueryNumber(query.max_price ?? query.price_max);
  if (maxPrice !== undefined) search.max_price = maxPrice;

  const allowExternalSeed = parseQueryBoolean(query.allow_external_seed ?? query.allowExternalSeed);
  if (allowExternalSeed !== undefined) search.allow_external_seed = allowExternalSeed;

  const allowStaleCache = parseQueryBoolean(query.allow_stale_cache ?? query.allowStaleCache);
  if (allowStaleCache !== undefined) search.allow_stale_cache = allowStaleCache;

  const fastMode = parseQueryBoolean(query.fast_mode ?? query.fastMode);
  if (fastMode !== undefined) search.fast_mode = fastMode;

  const externalSeedStrategy = String(
    firstQueryParamValue(query.external_seed_strategy || query.externalSeedStrategy) || '',
  ).trim();
  if (externalSeedStrategy) search.external_seed_strategy = externalSeedStrategy;

  const limit = parseQueryNumber(query.limit ?? query.page_size);
  if (limit !== undefined) search.limit = Math.max(1, Math.min(searchLimitMax, Math.floor(limit)));

  const offset = parseQueryNumber(query.offset);
  if (offset !== undefined) {
    const normalizedOffset = Math.max(0, Math.floor(offset));
    if (search.limit) {
      search.page = Math.floor(normalizedOffset / search.limit) + 1;
    } else {
      search.offset = normalizedOffset;
    }
  }

  const source = String(firstQueryParamValue(query.source) || '').trim().toLowerCase();
  if (source) metadata.source = source;

  const payload = { search };
  if (Object.keys(metadata).length > 0) payload.metadata = metadata;
  return payload;
}

module.exports = {
  firstQueryParamValue,
  parseQueryBoolean,
  parseQueryNumber,
  parseQueryStringArray,
  extractSearchQueryText,
  normalizeSearchQueryParams,
  buildFindProductsMultiPayloadFromQuery,
};

const {
  applyShoppingCatalogQueryGuards: applyShoppingCatalogQueryGuardsBase,
  isCreatorUiSource: isCreatorUiSourceBase,
} = require('./searchGuards');

const CATALOG_REQUEST_BUILDER_OPERATIONS = new Set([
  'find_products',
  'products.recommendations',
  'find_products_multi',
  'get_product_detail',
  'track_product_click',
]);

function clampSearchLimit(value, fallback, max) {
  return Math.min(Math.max(1, Number(value || fallback) || fallback), max);
}

function getSearchPayload(effectivePayload, payload) {
  if (effectivePayload && typeof effectivePayload === 'object') {
    return effectivePayload.search || effectivePayload;
  }
  if (payload && typeof payload === 'object') {
    return payload.search || payload;
  }
  return {};
}

function extractCommerceSurface(search) {
  if (!search || typeof search !== 'object') return '';
  return String(
    search.commerce_surface ||
      search.commerceSurface ||
      search.catalog_surface ||
      search.catalogSurface ||
      '',
  ).trim();
}

function buildFindProductsRequest({
  effectivePayload,
  payload,
  metadata,
  searchLimitMax,
  applyShoppingCatalogQueryGuards = applyShoppingCatalogQueryGuardsBase,
}) {
  const search = getSearchPayload(effectivePayload, payload);
  const page = Math.max(1, Number(search.page || 1) || 1);
  const limit = clampSearchLimit(search.page_size || search.limit || 20, 20, searchLimitMax);
  const offset = (page - 1) * limit;

  const merchantId = String(search.merchant_id || search.merchantId || '').trim();
  const searchAllMerchants =
    !merchantId || search.search_all_merchants === true || search.searchAllMerchants === true;
  const priceMin = search.price_min ?? search.min_price;
  const priceMax = search.price_max ?? search.max_price;
  const commerceSurface = extractCommerceSurface(search);

  const queryParams = {
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(search.query != null ? { query: String(search.query || '') } : {}),
    ...(search.lang ? { lang: search.lang } : {}),
    ...(search.category ? { category: search.category } : {}),
    ...(commerceSurface ? { commerce_surface: commerceSurface, catalog_surface: commerceSurface } : {}),
    ...(metadata?.source ? { source: metadata.source } : {}),
    ...(priceMin != null ? { min_price: priceMin } : {}),
    ...(priceMax != null ? { max_price: priceMax } : {}),
    ...(searchAllMerchants ? { search_all_merchants: true } : {}),
    in_stock_only: search.in_stock_only !== false,
    limit,
    offset,
  };

  return {
    queryParams: applyShoppingCatalogQueryGuards(queryParams, metadata?.source),
  };
}

function buildRecommendationsRequest({ effectivePayload, payload }) {
  const search = getSearchPayload(effectivePayload, payload);
  return {
    queryParams: {
      ...(search.merchant_id && { merchant_id: search.merchant_id }),
      ...(search.platform_product_id && { platform_product_id: search.platform_product_id }),
      ...(search.platform && { platform: search.platform }),
      ...(search.limit && { limit: Math.min(Number(search.limit || 0) || 0, 50) }),
    },
  };
}

function buildFindProductsMultiRequest({
  effectivePayload,
  payload,
  metadata,
  creatorId,
  getCreatorConfig,
  uniqueStrings,
  isCreatorUiSource = isCreatorUiSourceBase,
  proxySearchCreatorScopeToConfig,
  searchLimitMax,
  applyShoppingCatalogQueryGuards = applyShoppingCatalogQueryGuardsBase,
}) {
  const search = getSearchPayload(effectivePayload, payload);
  const page = Math.max(1, Number(search.page || 1) || 1);
  const limit = clampSearchLimit(search.limit || search.page_size || 20, 20, searchLimitMax);
  const offset = (page - 1) * limit;

  const merchantId = String(search.merchant_id || search.merchantId || '').trim();
  const merchantIdsRaw = search.merchant_ids || search.merchantIds;
  const merchantIds = Array.isArray(merchantIdsRaw)
    ? merchantIdsRaw.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  const searchAllMerchantsExplicit =
    search.search_all_merchants === true || search.searchAllMerchants === true;
  const creatorMerchantIds = uniqueStrings(
    (typeof getCreatorConfig === 'function' ? getCreatorConfig(creatorId)?.merchantIds : []) || [],
  );

  const priceMin = search.price_min ?? search.min_price;
  const priceMax = search.price_max ?? search.max_price;
  const commerceSurface = extractCommerceSurface(search);

  const shouldScopeToCreatorCatalog =
    proxySearchCreatorScopeToConfig &&
    typeof isCreatorUiSource === 'function' &&
    isCreatorUiSource(metadata?.source) &&
    !merchantId &&
    merchantIds.length === 0 &&
    !searchAllMerchantsExplicit &&
    creatorMerchantIds.length > 0;

  const queryParams = {
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(!merchantId && merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
    ...(!merchantId && merchantIds.length === 0 && shouldScopeToCreatorCatalog
      ? { merchant_ids: creatorMerchantIds }
      : {}),
    ...(!merchantId && merchantIds.length === 0 && !shouldScopeToCreatorCatalog
      ? { search_all_merchants: true }
      : {}),
    ...(search.query != null ? { query: String(search.query || '') } : {}),
    ...(search.lang ? { lang: search.lang } : {}),
    ...(search.category ? { category: search.category } : {}),
    ...(commerceSurface ? { commerce_surface: commerceSurface, catalog_surface: commerceSurface } : {}),
    ...(metadata?.source ? { source: metadata.source } : {}),
    ...(priceMin != null ? { min_price: priceMin } : {}),
    ...(priceMax != null ? { max_price: priceMax } : {}),
    in_stock_only: search.in_stock_only !== false,
    limit,
    offset,
  };

  return {
    queryParams: applyShoppingCatalogQueryGuards(queryParams, metadata?.source),
  };
}

function buildGetProductDetailRequest({
  payload,
  url,
  checkoutToken,
  buildRequestError,
}) {
  const productRef =
    (payload && typeof payload.product === 'object' && payload.product) ||
    (payload && typeof payload.product_ref === 'object' && payload.product_ref) ||
    {};
  const merchantId = String(productRef.merchant_id || productRef.merchantId || '').trim();
  const productId = String(productRef.product_id || productRef.productId || '').trim();
  const options =
    (payload && typeof payload.options === 'object' && payload.options) ||
    (productRef && typeof productRef.options === 'object' && productRef.options) ||
    {};
  const productDetailDebug =
    options.debug === true ||
    String(options.debug || '').trim().toLowerCase() === 'true' ||
    payload?.debug === true;
  const productDetailBypassCache =
    options.no_cache === true ||
    options.cache_bypass === true ||
    options.bypass_cache === true ||
    String(options.no_cache || '').trim().toLowerCase() === 'true' ||
    String(options.cache_bypass || options.bypass_cache || '')
      .trim()
      .toLowerCase() === 'true';

  if (!merchantId || !productId) {
    throw buildRequestError(
      'MISSING_PARAMETERS',
      'merchant_id and product_id are required',
    );
  }

  return {
    url: String(url || '')
      .replace('{merchant_id}', encodeURIComponent(merchantId))
      .replace('{product_id}', encodeURIComponent(productId)),
    productDetail: {
      merchantId,
      productId,
      cacheKey: JSON.stringify({
        merchantId,
        productId,
        hasCheckoutToken: Boolean(checkoutToken),
      }),
      debug: productDetailDebug,
      bypassCache: productDetailBypassCache,
    },
  };
}

function buildTrackProductClickRequest({
  payload,
  buildRequestError,
}) {
  const productPayload = payload?.product || {};
  const requestBody = {
    merchant_id: productPayload.merchant_id,
    platform: productPayload.platform,
    platform_product_id: productPayload.product_id,
    position: productPayload.position,
    ranking_score: productPayload.ranking_score,
    quality_content_score: productPayload.cq,
    quality_model_readiness: productPayload.mr,
    query: productPayload.query,
    ...(productPayload.event_type || productPayload.eventType || productPayload.action
      ? {
          event_type: String(
            productPayload.event_type || productPayload.eventType || productPayload.action,
          ).trim(),
        }
      : {}),
  };

  if (!requestBody.merchant_id || !requestBody.platform_product_id) {
    throw buildRequestError(
      'MISSING_PARAMETERS',
      'merchant_id and product_id are required for track_product_click',
    );
  }

  return { requestBody };
}

function buildCatalogInvokeUpstreamRequest({
  operation,
  effectivePayload,
  payload,
  metadata,
  creatorId,
  url,
  checkoutToken,
  buildRequestError,
  searchLimitMax,
  applyShoppingCatalogQueryGuards,
  getCreatorConfig,
  uniqueStrings,
  isCreatorUiSource,
  proxySearchCreatorScopeToConfig,
} = {}) {
  const normalizedOperation = String(operation || '').trim();
  if (!CATALOG_REQUEST_BUILDER_OPERATIONS.has(normalizedOperation)) {
    return null;
  }

  switch (normalizedOperation) {
    case 'find_products':
      return buildFindProductsRequest({
        effectivePayload,
        payload,
        metadata,
        searchLimitMax,
        applyShoppingCatalogQueryGuards,
      });
    case 'products.recommendations':
      return buildRecommendationsRequest({ effectivePayload, payload });
    case 'find_products_multi':
      return buildFindProductsMultiRequest({
        effectivePayload,
        payload,
        metadata,
        creatorId,
        getCreatorConfig,
        uniqueStrings,
        isCreatorUiSource,
        proxySearchCreatorScopeToConfig,
        searchLimitMax,
        applyShoppingCatalogQueryGuards,
      });
    case 'get_product_detail':
      return buildGetProductDetailRequest({
        payload,
        url,
        checkoutToken,
        buildRequestError,
      });
    case 'track_product_click':
      return buildTrackProductClickRequest({ payload, buildRequestError });
    default:
      return null;
  }
}

module.exports = {
  CATALOG_REQUEST_BUILDER_OPERATIONS,
  buildCatalogInvokeUpstreamRequest,
};

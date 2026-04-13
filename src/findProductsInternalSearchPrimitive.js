const INTERNAL_PRODUCTS_SEARCH_PATH = '/agent/internal/products/search';

const INTERNAL_PRODUCTS_SEARCH_ALLOWED_FIELDS = [
  'query',
  'limit',
  'offset',
  'merchant_id',
  'merchant_ids',
  'search_all_merchants',
  'catalog_surface',
  'in_stock_only',
  'allow_external_seed',
  'external_seed_strategy',
  'fast_mode',
  'target_step_family',
  'semantic_family',
  'query_step_strength',
  'product_only',
  'trace_id',
];

const INTERNAL_PRODUCTS_SEARCH_FORBIDDEN_FIELDS = [
  'semantic_contract',
  'semanticContract',
  'search_request_contract',
  'searchRequestContract',
  'primary_lane',
  'primary_retrieval_contract',
  'primaryRetrievalContract',
  'supplement_lanes',
  'supplementLanes',
  'local_mainline_child',
  'localMainlineChild',
  'ui_surface',
  'uiSurface',
  'decision_mode',
  'decisionMode',
  'payload',
  'metadata',
  'search',
  'request_context',
  'requestContext',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function parseBooleanLike(value) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(Array.isArray(value) ? value[0] : value).trim().toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function normalizeStringArray(value) {
  const list = Array.isArray(value)
    ? value
    : value == null
      ? []
      : [value];
  return Array.from(
    new Set(
      list
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizeNonNegativeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function pruneEmptyFields(value) {
  if (!isPlainObject(value)) return {};
  return Object.entries(value).reduce((out, [key, entry]) => {
    if (entry == null) return out;
    if (typeof entry === 'string' && !entry.trim()) return out;
    if (Array.isArray(entry) && entry.length <= 0) return out;
    out[key] = entry;
    return out;
  }, {});
}

function sanitizeInternalProductsSearchRequest(
  rawInput,
  {
    rejectUnknown = true,
    rejectForbidden = true,
    defaultSearchAllMerchants = true,
  } = {},
) {
  const input = isPlainObject(rawInput) ? rawInput : {};
  const allowed = new Set(INTERNAL_PRODUCTS_SEARCH_ALLOWED_FIELDS);
  const forbidden = new Set(INTERNAL_PRODUCTS_SEARCH_FORBIDDEN_FIELDS);
  const unknownFields = [];
  const forbiddenFields = [];

  for (const key of Object.keys(input)) {
    if (forbidden.has(key)) {
      forbiddenFields.push(key);
      continue;
    }
    if (!allowed.has(key)) unknownFields.push(key);
  }

  if ((rejectForbidden && forbiddenFields.length > 0) || (rejectUnknown && unknownFields.length > 0)) {
    return {
      ok: false,
      search: null,
      forbidden_fields: forbiddenFields,
      unknown_fields: unknownFields,
      invalid_fields: Array.from(new Set([...forbiddenFields, ...unknownFields])),
    };
  }

  const merchantId = firstNonEmptyString(input.merchant_id);
  const merchantIds = normalizeStringArray(input.merchant_ids).filter((value) => value !== merchantId);
  const explicitSearchAllMerchants = parseBooleanLike(input.search_all_merchants);
  const query = firstNonEmptyString(input.query);
  const limit = normalizeNonNegativeInteger(input.limit, { min: 1, max: 50 });
  const offset = normalizeNonNegativeInteger(input.offset, { min: 0 });
  const inStockOnly = parseBooleanLike(input.in_stock_only);
  const allowExternalSeed = parseBooleanLike(input.allow_external_seed);
  const fastMode = parseBooleanLike(input.fast_mode);
  const productOnly = parseBooleanLike(input.product_only);
  const normalized = pruneEmptyFields({
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(merchantId ? { merchant_id: merchantId } : {}),
    ...(!merchantId && merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
    ...(
      explicitSearchAllMerchants !== undefined
        ? { search_all_merchants: explicitSearchAllMerchants }
        : !merchantId && merchantIds.length <= 0 && defaultSearchAllMerchants
          ? { search_all_merchants: true }
          : {}
    ),
    ...(firstNonEmptyString(input.catalog_surface)
      ? { catalog_surface: firstNonEmptyString(input.catalog_surface).toLowerCase() }
      : {}),
    ...(inStockOnly !== undefined ? { in_stock_only: inStockOnly } : {}),
    ...(allowExternalSeed !== undefined ? { allow_external_seed: allowExternalSeed } : {}),
    ...(firstNonEmptyString(input.external_seed_strategy)
      ? { external_seed_strategy: firstNonEmptyString(input.external_seed_strategy).toLowerCase() }
      : {}),
    ...(fastMode !== undefined ? { fast_mode: fastMode } : {}),
    ...(firstNonEmptyString(input.target_step_family)
      ? { target_step_family: firstNonEmptyString(input.target_step_family).toLowerCase() }
      : {}),
    ...(firstNonEmptyString(input.semantic_family)
      ? { semantic_family: firstNonEmptyString(input.semantic_family).toLowerCase() }
      : {}),
    ...(firstNonEmptyString(input.query_step_strength)
      ? { query_step_strength: firstNonEmptyString(input.query_step_strength).toLowerCase() }
      : {}),
    ...(productOnly !== undefined ? { product_only: productOnly } : {}),
    ...(firstNonEmptyString(input.trace_id) ? { trace_id: firstNonEmptyString(input.trace_id) } : {}),
  });

  return {
    ok: Boolean(normalized.query),
    search: normalized,
    forbidden_fields: [],
    unknown_fields: [],
    invalid_fields: normalized.query ? [] : ['query'],
  };
}

function buildInternalProductsSearchUpstreamBody({
  search = null,
  buildSearchProductsV2Body = null,
  traceId = null,
} = {}) {
  const normalizedSearch = isPlainObject(search) ? search : {};
  if (typeof buildSearchProductsV2Body === 'function') {
    return buildSearchProductsV2Body({
      payload: {
        search: normalizedSearch,
        metadata: {
          source: 'internal_products_search_primitive',
          ...(traceId ? { trace_id: traceId } : {}),
        },
      },
      search: normalizedSearch,
      metadata: {
        source: 'internal_products_search_primitive',
        ...(traceId ? { trace_id: traceId } : {}),
      },
      clientChannel: 'internal',
      gatewayRequestId: traceId || null,
      defaultSearchAllMerchants:
        !firstNonEmptyString(normalizedSearch.merchant_id) &&
        normalizeStringArray(normalizedSearch.merchant_ids).length <= 0,
    });
  }
  return normalizedSearch;
}

function resolveInternalSearchTimeoutMs(headerValue, fallbackTimeoutMs) {
  const requested = normalizeNonNegativeInteger(headerValue, { min: 200, max: 20000 });
  if (requested !== undefined) return requested;
  const fallback = normalizeNonNegativeInteger(fallbackTimeoutMs, { min: 200, max: 20000 });
  return fallback !== undefined ? fallback : 5000;
}

function buildInternalSearchTimeoutError(timeoutMs) {
  const err = new Error(`internal products search timed out after ${timeoutMs}ms`);
  err.code = 'ECONNABORTED';
  return err;
}

async function withLocalSearchTimeout(promise, timeoutMs) {
  const safeTimeoutMs = resolveInternalSearchTimeoutMs(timeoutMs, timeoutMs);
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(buildInternalSearchTimeoutError(safeTimeoutMs)), safeTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function matchesMerchantScope(product, merchantScope = null) {
  const allowed = merchantScope instanceof Set ? merchantScope : new Set();
  if (allowed.size <= 0) return true;
  const merchantId = firstNonEmptyString(product?.merchant_id, product?.merchantId);
  return merchantId ? allowed.has(merchantId) : false;
}

function sliceInternalSearchProducts(products, offset, limit) {
  const normalizedProducts = Array.isArray(products) ? products : [];
  const safeOffset = normalizeNonNegativeInteger(offset, { min: 0 }) || 0;
  const safeLimit = normalizeNonNegativeInteger(limit, { min: 1, max: 50 }) || 20;
  return normalizedProducts.slice(safeOffset, safeOffset + safeLimit);
}

function normalizeBeautyStepFamily(value) {
  const normalized = firstNonEmptyString(value).toLowerCase();
  if (!normalized) return '';
  if (normalized === 'treatment') return 'serum';
  if (/(serum|essence|ampoule|booster|concentrate)/.test(normalized)) return 'serum';
  if (/(moistur|cream|lotion|gel)/.test(normalized)) return 'moisturizer';
  if (/(sunscreen|spf|uv|sunblock)/.test(normalized)) return 'sunscreen';
  if (/(cleanser|cleanse|face wash|wash|foam|cleansing balm)/.test(normalized)) return 'cleanser';
  return normalized;
}

function normalizeBeautySemanticFamily(value) {
  const normalized = firstNonEmptyString(value).toLowerCase();
  if (!normalized) return '';
  if (/(oil_control|shine_control|mattif|sebum|anti-shine|oil[- ]?control|oil[- ]?balance)/.test(normalized)) {
    return 'oil_control';
  }
  if (/(moistur|barrier|hydrat|gel cream|lightweight_moisturizer|ceramide)/.test(normalized)) {
    return 'moisturizer';
  }
  if (/(sunscreen|spf|uv|daily_sunscreen)/.test(normalized)) return 'sunscreen';
  if (/(cleanser|cleanse|face wash)/.test(normalized)) return 'cleanser';
  return normalized;
}

function buildInternalBeautyCandidateText(product) {
  if (!isPlainObject(product)) return '';
  return [
    product.title,
    product.name,
    product.display_name,
    product.displayName,
    product.product_title,
    product.productTitle,
    product.product_name,
    product.productName,
    product.description,
    product.body_html,
    product.bodyHtml,
    product.overview,
    product.subtitle,
    product.short_description,
    product.product_type,
    product.productType,
    product.category,
    product.category_name,
    product.categoryName,
    product.vendor,
    product.vendor_name,
    product.vendorName,
    product.brand,
    product.brand_name,
    product.brandName,
    ...(Array.isArray(product.search_aliases) ? product.search_aliases : []),
    ...(Array.isArray(product.category_path) ? product.category_path : []),
    ...(Array.isArray(product.tags) ? product.tags : []),
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function hasBeautyHardExclusionSignal(text, { excludeBeautyTools = false } = {}) {
  const haystack = String(text || '');
  if (!haystack) return true;
  const crossDomainHit =
    /\b(lingerie|underwear|bra|panties|bodysuit|overall|overalls|onesie|dress|jacket|coat|hoodie|sweater|sweatshirt|shirt|tee|vest|apparel|clothing|pet|dog|dogs|cat|cats|puppy|kitten|harness|leash|collar|toy|toys|doll|plush|costume)\b/i.test(
      haystack,
    )
    || /内衣|文胸|胸罩|下着|ランジェリー|宠物|寵物|狗|猫|犬|项圈|項圈|牵引|牽引|玩具|娃娃/.test(haystack)
  ;
  if (crossDomainHit) return true;
  if (!excludeBeautyTools) return false;
  return /\b(brush|brushes|beauty tool|tool kit|applicator|blender|sponge|powder puff|puff|eyelash curler)\b/i.test(
      haystack,
    );
}

function hasBeautyDomainSignal(product, text) {
  const domain = firstNonEmptyString(
    product?.attributes?.pivota?.domain,
    product?.domain,
    product?.category_domain,
  ).toLowerCase();
  if (domain) return domain === 'beauty';
  const haystack = String(text || '');
  return /\b(serum|essence|ampoule|booster|concentrate|moisturizer|cream|lotion|gel cream|water gel|cleanser|face wash|sunscreen|spf|uv|skincare|skin care|beauty|cosmetic|cosmetics|niacinamide|salicylic|ceramide|hyaluronic|retinol|face|facial)\b/i.test(
    haystack,
  );
}

function matchesBeautyStepFamily(text, stepFamily) {
  const haystack = String(text || '');
  const normalizedStepFamily = normalizeBeautyStepFamily(stepFamily);
  if (!normalizedStepFamily) return true;
  if (normalizedStepFamily === 'serum') {
    return /\b(serum|essence|ampoule|booster|concentrate|treatment)\b/i.test(haystack)
      && !/\b(sunscreen|spf|uv filters?)\b/i.test(haystack);
  }
  if (normalizedStepFamily === 'moisturizer') {
    return /\b(moisturizer|moisturiser|cream|gel cream|water gel|lotion|emulsion)\b/i.test(haystack)
      && !/\b(hand cream|body cream|body lotion|foot cream)\b/i.test(haystack);
  }
  if (normalizedStepFamily === 'sunscreen') {
    return /\b(sunscreen|spf|uv|sunblock|broad spectrum)\b/i.test(haystack);
  }
  if (normalizedStepFamily === 'cleanser') {
    return /\b(cleanser|cleanse|face wash|cleansing balm|washing foam|foam cleanser)\b/i.test(haystack);
  }
  return true;
}

function matchesBeautySemanticFamily(text, semanticFamily) {
  const haystack = String(text || '');
  const normalizedSemanticFamily = normalizeBeautySemanticFamily(semanticFamily);
  if (!normalizedSemanticFamily) return true;
  if (normalizedSemanticFamily === 'oil_control') {
    return /\b(oil|oily|shine|sebum|mattif|anti-shine|niacinamide|salicylic|blemish|acne)\b/i.test(haystack);
  }
  if (normalizedSemanticFamily === 'moisturizer') {
    return /\b(moistur|hydrat|gel cream|water gel|barrier|ceramide|glycerin|panthenol|oil-free|lightweight)\b/i.test(
      haystack,
    );
  }
  if (normalizedSemanticFamily === 'sunscreen') {
    return /\b(sunscreen|spf|uv|sunblock|broad spectrum)\b/i.test(haystack);
  }
  if (normalizedSemanticFamily === 'cleanser') {
    return /\b(cleanser|cleanse|face wash|cleansing balm|foam cleanser)\b/i.test(haystack);
  }
  return true;
}

function filterInternalBeautySearchProducts(products, search) {
  const list = Array.isArray(products) ? products : [];
  const catalogSurface = firstNonEmptyString(search?.catalog_surface).toLowerCase();
  const stepFamily = normalizeBeautyStepFamily(search?.target_step_family);
  const semanticFamily = normalizeBeautySemanticFamily(search?.semantic_family);
  const queryStepStrength = firstNonEmptyString(search?.query_step_strength).toLowerCase();
  const enabled = catalogSurface === 'beauty' || Boolean(stepFamily) || Boolean(semanticFamily);
  if (!enabled || list.length === 0) {
    return {
      products: list,
      applied: false,
      rejected_count: 0,
      target_step_family: stepFamily || null,
      semantic_family: semanticFamily || null,
      query_step_strength: queryStepStrength || null,
    };
  }

  const filtered = [];
  let rejectedCount = 0;
  const requireSemanticMatch = queryStepStrength === 'strong_goal_family' && Boolean(semanticFamily);
  const excludeBeautyTools = Boolean(stepFamily) || Boolean(semanticFamily);
  for (const product of list) {
    const candidateText = buildInternalBeautyCandidateText(product);
    if (!candidateText) {
      rejectedCount += 1;
      continue;
    }
    if (hasBeautyHardExclusionSignal(candidateText, { excludeBeautyTools })) {
      rejectedCount += 1;
      continue;
    }
    if (!hasBeautyDomainSignal(product, candidateText)) {
      rejectedCount += 1;
      continue;
    }
    if (!matchesBeautyStepFamily(candidateText, stepFamily)) {
      rejectedCount += 1;
      continue;
    }
    if (requireSemanticMatch && !matchesBeautySemanticFamily(candidateText, semanticFamily)) {
      rejectedCount += 1;
      continue;
    }
    filtered.push(product);
  }

  return {
    products: filtered,
    applied: true,
    rejected_count: rejectedCount,
    target_step_family: stepFamily || null,
    semantic_family: semanticFamily || null,
    query_step_strength: queryStepStrength || null,
  };
}

function createFindProductsInternalSearchPrimitiveRuntime(deps = {}) {
  const normalizeAgentProductsListResponse =
    typeof deps.normalizeAgentProductsListResponse === 'function'
      ? deps.normalizeAgentProductsListResponse
      : (value) => value;
  const getDefaultTimeoutMs =
    typeof deps.getDefaultTimeoutMs === 'function'
      ? deps.getDefaultTimeoutMs
      : () => Number(deps.defaultTimeoutMs || 5000) || 5000;
  const searchCrossMerchantFromCache =
    typeof deps.searchCrossMerchantFromCache === 'function' ? deps.searchCrossMerchantFromCache : null;
  const loadCrossMerchantBrowseFromCache =
    typeof deps.loadCrossMerchantBrowseFromCache === 'function' ? deps.loadCrossMerchantBrowseFromCache : null;
  const loadMerchantBrowseFromCache =
    typeof deps.loadMerchantBrowseFromCache === 'function' ? deps.loadMerchantBrowseFromCache : null;

  async function handleInternalProductsSearch(req, res) {
    if (
      !searchCrossMerchantFromCache &&
      !loadCrossMerchantBrowseFromCache &&
      !loadMerchantBrowseFromCache
    ) {
      return res.status(503).json({
        error: 'INTERNAL_PRODUCTS_SEARCH_UNAVAILABLE',
        message: 'internal products search primitive is not configured',
      });
    }

    const validation = sanitizeInternalProductsSearchRequest(req.body, {
      rejectUnknown: true,
      rejectForbidden: true,
      defaultSearchAllMerchants: true,
    });
    if (!validation.ok) {
      return res.status(400).json({
        error: 'INVALID_INTERNAL_PRODUCTS_SEARCH_REQUEST',
        message: 'request body must contain only thin search fields',
        invalid_fields: validation.invalid_fields,
        forbidden_fields: validation.forbidden_fields,
        unknown_fields: validation.unknown_fields,
      });
    }

    const traceId = firstNonEmptyString(validation.search.trace_id, req.header('X-Trace-ID'));

    const timeoutMs = resolveInternalSearchTimeoutMs(
      req.header('X-Internal-Search-Timeout-Ms') || req.header('x-internal-search-timeout-ms'),
      getDefaultTimeoutMs(),
    );
    const limit = normalizeNonNegativeInteger(validation.search.limit, { min: 1, max: 50 }) || 20;
    const offset = normalizeNonNegativeInteger(validation.search.offset, { min: 0 }) || 0;
    const page = Math.floor(offset / Math.max(1, limit)) + 1;
    const fetchLimit = Math.max(limit, offset + limit);
    const inStockOnly = parseBooleanLike(validation.search.in_stock_only) !== false;
    const merchantId = firstNonEmptyString(validation.search.merchant_id);
    const merchantIds = normalizeStringArray(validation.search.merchant_ids);
    const merchantScope = new Set([merchantId, ...merchantIds].filter(Boolean));

    let localResult;
    try {
      localResult = await withLocalSearchTimeout(
        (async () => {
          if (!validation.search.query && merchantId && loadMerchantBrowseFromCache) {
            return await loadMerchantBrowseFromCache(merchantId, 1, fetchLimit, {
              inStockOnly,
            });
          }
          if (!validation.search.query && loadCrossMerchantBrowseFromCache) {
            return await loadCrossMerchantBrowseFromCache(1, fetchLimit, {
              inStockOnly,
            });
          }
          if (!searchCrossMerchantFromCache) {
            throw new Error('cross-merchant cache search is not configured');
          }
          return await searchCrossMerchantFromCache(validation.search.query, 1, fetchLimit, {
            inStockOnly,
          });
        })(),
        timeoutMs,
      );
    } catch (err) {
      const statusCode = err?.code === 'ECONNABORTED' ? 504 : 502;
      return res.status(statusCode).json({
        error:
          err?.code === 'ECONNABORTED'
            ? 'INTERNAL_PRODUCTS_SEARCH_TIMEOUT'
            : 'INTERNAL_PRODUCTS_SEARCH_UPSTREAM_ERROR',
        message: err?.message || String(err),
        failure_stage: 'local_cache_retrieval',
        internal_error_code: err?.code || null,
      });
    }

    const allProducts = (Array.isArray(localResult?.products) ? localResult.products : []).filter((product) =>
      matchesMerchantScope(product, merchantScope),
    );
    const beautyFiltered = filterInternalBeautySearchProducts(allProducts, validation.search);
    const filteredProducts = Array.isArray(beautyFiltered.products) ? beautyFiltered.products : allProducts;
    const products = sliceInternalSearchProducts(filteredProducts, offset, limit);
    const normalizedBody = normalizeAgentProductsListResponse(
      {
        status: 'success',
        success: true,
        products,
        total:
          merchantScope.size > 0
            ? filteredProducts.length
            : beautyFiltered.applied
              ? filteredProducts.length
              : Number(localResult?.total || 0) || filteredProducts.length,
        page,
        page_size: products.length,
        reply: null,
        metadata: {
          query_source: 'internal_products_search_primitive_cache',
          transport_owner: 'internal_products_search_primitive',
          endpoint_kind: 'internal_primitive',
          thin_search_primitive: true,
          fetched_at: new Date().toISOString(),
          ...(traceId ? { trace_id: traceId } : {}),
          ...(firstNonEmptyString(validation.search.target_step_family)
            ? { query_target_step_family: firstNonEmptyString(validation.search.target_step_family) }
            : {}),
          ...(firstNonEmptyString(validation.search.semantic_family)
            ? { semantic_family: firstNonEmptyString(validation.search.semantic_family) }
            : {}),
          ...(firstNonEmptyString(validation.search.query_step_strength)
            ? { query_step_strength: firstNonEmptyString(validation.search.query_step_strength) }
            : {}),
          ...(merchantId ? { merchant_id: merchantId } : {}),
          ...(merchantIds.length > 0 ? { merchant_ids: merchantIds } : {}),
          ...(Array.isArray(localResult?.retrieval_sources)
            ? { retrieval_sources: localResult.retrieval_sources }
            : {}),
          ...(Array.isArray(localResult?.query_terms)
            ? { query_terms: localResult.query_terms }
            : {}),
          ...(firstNonEmptyString(localResult?.beauty_query_bucket)
            ? { beauty_query_bucket: firstNonEmptyString(localResult.beauty_query_bucket) }
            : {}),
          ...(beautyFiltered.applied
            ? {
                post_filter_applied: true,
                post_filter_rejected_count: Number(beautyFiltered.rejected_count || 0),
                post_filter_target_step_family: beautyFiltered.target_step_family,
                post_filter_semantic_family: beautyFiltered.semantic_family,
                post_filter_query_step_strength: beautyFiltered.query_step_strength,
              }
            : {}),
        },
      },
      { limit, offset },
    );
    const responseBody = isPlainObject(normalizedBody)
      ? normalizedBody
      : {
          status: 'success',
          success: true,
          products: [],
          total: 0,
          page: 1,
          page_size: 0,
          reply: null,
        };
    const metadata = pruneEmptyFields({
      ...(isPlainObject(responseBody.metadata) ? responseBody.metadata : {}),
      transport_owner: 'internal_products_search_primitive',
      endpoint_kind: 'internal_primitive',
      thin_search_primitive: true,
    });
    return res.status(200).json({
      ...responseBody,
      metadata,
    });
  }

  return {
    handleInternalProductsSearch,
  };
}

module.exports = {
  INTERNAL_PRODUCTS_SEARCH_PATH,
  INTERNAL_PRODUCTS_SEARCH_ALLOWED_FIELDS,
  INTERNAL_PRODUCTS_SEARCH_FORBIDDEN_FIELDS,
  sanitizeInternalProductsSearchRequest,
  buildInternalProductsSearchUpstreamBody,
  createFindProductsInternalSearchPrimitiveRuntime,
};

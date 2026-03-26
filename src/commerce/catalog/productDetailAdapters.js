const {
  parseOfferId: parseOfferIdBase,
} = require('../../offers/offerIds');
const {
  fetchProductGroupMembersFromUpstream: fetchProductGroupMembersFromUpstreamBase,
} = require('../pdp/upstreamAdapters');

function parseTimeoutMs(raw, fallbackMs) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

function parsePositiveInt(raw, fallbackValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallbackValue;
  return Math.min(max, Math.max(min, parsed));
}

function safeCloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

let configuredDeps = null;

function configureProductDetailAdapters(deps = {}) {
  configuredDeps = {
    ...(configuredDeps || {}),
    ...deps,
  };
}

function requireDeps() {
  if (!configuredDeps) {
    throw new Error('Product detail adapters are not configured');
  }
  return configuredDeps;
}

const PRODUCT_DETAIL_CACHE_ENABLED =
  process.env.PRODUCT_DETAIL_CACHE_ENABLED !== 'false';
const PRODUCT_DETAIL_CACHE = new Map();
const PRODUCT_DETAIL_INFLIGHT = new Map();
const PRODUCT_DETAIL_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
  evictions: 0,
  db_hits: 0,
};
const PRODUCT_DETAIL_CACHE_TTL_MS = parseTimeoutMs(
  process.env.PRODUCT_DETAIL_CACHE_TTL_MS,
  10 * 60 * 1000,
);
const PRODUCT_DETAIL_CACHE_MAX_ENTRIES = Math.max(
  50,
  Number(process.env.PRODUCT_DETAIL_CACHE_MAX_ENTRIES || 2000) || 2000,
);
const PRODUCT_DETAIL_STALE_LOOKUP_ENABLED =
  String(process.env.PRODUCT_DETAIL_STALE_LOOKUP_ENABLED || 'true').toLowerCase() === 'true';
const PRODUCT_DETAIL_STALE_MAX_AGE_HOURS = parsePositiveInt(
  process.env.PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
  30 * 24,
  { min: 1, max: 24 * 90 },
);

function getProductDetailCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return null;
  const hit = PRODUCT_DETAIL_CACHE.get(key);
  if (!hit) {
    PRODUCT_DETAIL_CACHE_METRICS.misses += 1;
    return null;
  }
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    PRODUCT_DETAIL_CACHE.delete(key);
    PRODUCT_DETAIL_CACHE_METRICS.misses += 1;
    return null;
  }
  PRODUCT_DETAIL_CACHE_METRICS.hits += 1;
  return hit;
}

function setProductDetailCache(cacheKey, value, ttlMs = PRODUCT_DETAIL_CACHE_TTL_MS) {
  const key = String(cacheKey || '');
  if (!key) return;

  const ttl = Number(ttlMs) || PRODUCT_DETAIL_CACHE_TTL_MS;
  const now = Date.now();

  if (PRODUCT_DETAIL_CACHE.size >= PRODUCT_DETAIL_CACHE_MAX_ENTRIES) {
    const overflow = PRODUCT_DETAIL_CACHE.size - PRODUCT_DETAIL_CACHE_MAX_ENTRIES + 1;
    let removed = 0;
    for (const existingKey of PRODUCT_DETAIL_CACHE.keys()) {
      PRODUCT_DETAIL_CACHE.delete(existingKey);
      removed += 1;
      if (removed >= overflow) break;
    }
    if (removed > 0) PRODUCT_DETAIL_CACHE_METRICS.evictions += removed;
  }

  PRODUCT_DETAIL_CACHE_METRICS.sets += 1;
  PRODUCT_DETAIL_CACHE.set(key, {
    value: safeCloneJson(value),
    storedAtMs: now,
    expiresAtMs: now + Math.max(5_000, ttl),
  });
}

function snapshotProductDetailCacheStats() {
  return {
    enabled: PRODUCT_DETAIL_CACHE_ENABLED,
    ttl_ms: PRODUCT_DETAIL_CACHE_TTL_MS,
    max_entries: PRODUCT_DETAIL_CACHE_MAX_ENTRIES,
    size: PRODUCT_DETAIL_CACHE.size,
    ...PRODUCT_DETAIL_CACHE_METRICS,
  };
}

function parseNullableProductPrice(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeProductDetailPrice(product) {
  if (!product || typeof product !== 'object') return product;
  const normalized = { ...product };

  let resolvedPrice = parseNullableProductPrice(normalized.price);
  if (resolvedPrice === null && Array.isArray(normalized.variants)) {
    for (const variant of normalized.variants) {
      if (!variant || typeof variant !== 'object') continue;
      const candidate =
        parseNullableProductPrice(variant.price) ??
        parseNullableProductPrice(variant.price_amount) ??
        parseNullableProductPrice(variant.amount) ??
        parseNullableProductPrice(variant.value);
      if (candidate !== null) {
        resolvedPrice = candidate;
        break;
      }
    }
  }

  normalized.price = resolvedPrice;
  return normalized;
}

async function fetchProductDetailFromProductsCache(args) {
  const { query, logger } = requireDeps();
  if (!process.env.DATABASE_URL) return null;
  const merchantId = String(args?.merchantId || '').trim();
  const productId = String(args?.productId || '').trim();
  if (!merchantId || !productId) return null;
  const includeExpired = args?.includeExpired === true;
  const staleMaxAgeHours = Math.max(
    1,
    Math.min(
      24 * 90,
      Number.isFinite(Number(args?.staleMaxAgeHours))
        ? Number(args?.staleMaxAgeHours)
        : PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
    ),
  );

  try {
    const fetchFresh = async () => {
      const res = await query(
        `
          SELECT product_data, cached_at
          FROM products_cache
          WHERE merchant_id = $1
            AND (expires_at IS NULL OR expires_at > now())
            AND (
              platform_product_id = $2
              OR product_data->>'id' = $2
              OR product_data->>'product_id' = $2
              OR product_data->>'productId' = $2
            )
          ORDER BY cached_at DESC
          LIMIT 1
        `,
        [merchantId, productId],
      );
      return res?.rows && res.rows[0] ? res.rows[0] : null;
    };

    const fetchStale = async () => {
      if (!PRODUCT_DETAIL_STALE_LOOKUP_ENABLED) return null;
      const res = await query(
        `
          SELECT product_data, cached_at
          FROM products_cache
          WHERE merchant_id = $1
            AND (cached_at IS NULL OR cached_at >= now() - ($3 * interval '1 hour'))
            AND (
              platform_product_id = $2
              OR product_data->>'id' = $2
              OR product_data->>'product_id' = $2
              OR product_data->>'productId' = $2
            )
          ORDER BY cached_at DESC
          LIMIT 1
        `,
        [merchantId, productId, staleMaxAgeHours],
      );
      return res?.rows && res.rows[0] ? res.rows[0] : null;
    };

    let row = await fetchFresh();
    let staleFallbackUsed = false;
    if (!row && includeExpired) {
      row = await fetchStale();
      staleFallbackUsed = Boolean(row);
    }

    const productData = row?.product_data;
    if (!productData || typeof productData !== 'object') return null;

    const normalized = {
      ...productData,
      merchant_id: merchantId,
      product_id: String(productData.product_id || productData.id || productId).trim() || productId,
    };
    const withPrice = normalizeProductDetailPrice(normalized);
    return {
      product: withPrice,
      cached_at: row?.cached_at || null,
      stale_fallback_used: staleFallbackUsed,
      stale_max_age_hours: staleFallbackUsed ? staleMaxAgeHours : null,
    };
  } catch (err) {
    logger.warn(
      { err: err.message, merchantId, productId },
      'Failed to load product detail from products_cache',
    );
    return null;
  }
}

function attachProductDetailSource(product, detailSource) {
  if (!product || typeof product !== 'object') return product;
  const source = String(detailSource || '').trim();
  if (!source) return product;
  try {
    Object.defineProperty(product, '__detail_source', {
      value: source,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    product.__detail_source = source;
  }
  return product;
}

function inferDetailSourceFromQuerySource(querySource) {
  const source = String(querySource || '').trim().toLowerCase();
  if (!source) return null;
  if (source === 'products_cache') return 'fresh_cache';
  if (source === 'products_cache_stale') return 'stale_cache';
  if (source === 'upstream') return 'upstream';
  return null;
}

function getProductDetailSource(product) {
  if (!product || typeof product !== 'object') return null;
  const source = String(product.__detail_source || '').trim();
  return source || null;
}

async function fetchProductDetailFromUpstream(args) {
  const {
    axios,
    buildInvokeUpstreamAuthHeaders,
    getUpstreamTimeoutMs,
    callUpstreamWithOptionalRetry,
    pivotaApiBase,
  } = requireDeps();
  const { merchantId, productId, skuId, checkoutToken } = args || {};
  const timeoutMsRaw = Number(args?.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? timeoutMsRaw
    : getUpstreamTimeoutMs('get_product_detail');
  const url = `${pivotaApiBase}/agent/shop/v1/invoke`;
  const data = {
    operation: 'get_product_detail',
    payload: {
      product: {
        merchant_id: merchantId,
        product_id: productId,
        ...(skuId ? { sku_id: skuId } : {}),
      },
    },
  };
  const axiosConfig = {
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    },
    timeout: timeoutMs,
    data,
  };
  const resp = args?.noRetry
    ? await axios(axiosConfig)
    : await callUpstreamWithOptionalRetry('get_product_detail', axiosConfig, { axios });
  return resp?.data?.product || null;
}

async function fetchLegacyProductDetailFromUpstream(args) {
  const {
    axios,
    buildInvokeUpstreamAuthHeaders,
    getUpstreamTimeoutMs,
    callUpstreamWithOptionalRetry,
    pivotaApiBase,
  } = requireDeps();
  const { merchantId, productId, checkoutToken } = args || {};
  const url = `${pivotaApiBase}/agent/v1/products/${encodeURIComponent(
    merchantId,
  )}/${encodeURIComponent(productId)}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    },
    timeout: getUpstreamTimeoutMs('get_product_detail'),
  };
  const resp = await callUpstreamWithOptionalRetry('get_product_detail', axiosConfig, { axios });
  return resp?.data?.product || null;
}

async function fetchProductDetailForOffers(args) {
  const merchantId = String(args?.merchantId || '').trim();
  const productId = String(args?.productId || '').trim();
  const checkoutToken = args?.checkoutToken;
  if (!merchantId || !productId) return null;

  const cacheKey = JSON.stringify({
    merchantId,
    productId,
    hasCheckoutToken: Boolean(checkoutToken),
  });

  if (PRODUCT_DETAIL_CACHE_ENABLED) {
    const cachedEntry = getProductDetailCacheEntry(cacheKey);
    const cachedValue = cachedEntry?.value;
    const cachedProduct =
      cachedValue && typeof cachedValue === 'object'
        ? cachedValue.product || cachedValue?.data?.product
        : null;
    const cachedSource = inferDetailSourceFromQuerySource(cachedValue?.metadata?.query_source);
    if (cachedProduct && typeof cachedProduct === 'object') {
      return attachProductDetailSource(
        normalizeProductDetailPrice({
          ...cachedProduct,
          merchant_id: merchantId,
          product_id:
            String(cachedProduct.product_id || cachedProduct.id || productId).trim() ||
            productId,
        }),
        cachedSource || 'fresh_cache',
      );
    }
  }

  const inflight = PRODUCT_DETAIL_INFLIGHT.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const loadPromise = (async () => {
    if (process.env.DATABASE_URL) {
      const fromDb = await fetchProductDetailFromProductsCache({
        merchantId,
        productId,
        includeExpired: false,
      });
      if (fromDb?.product) {
        const normalizedDb = attachProductDetailSource(
          normalizeProductDetailPrice(fromDb.product),
          'fresh_cache',
        );
        if (PRODUCT_DETAIL_CACHE_ENABLED) {
          setProductDetailCache(cacheKey, {
            status: 'success',
            success: true,
            product: normalizedDb,
            metadata: {
              query_source: 'products_cache',
              cached_at: fromDb.cached_at || null,
            },
          });
        }
        return normalizedDb;
      }
    }

    let upstreamProduct = null;
    try {
      upstreamProduct = await fetchLegacyProductDetailFromUpstream({
        merchantId,
        productId,
        checkoutToken,
      });
    } catch {
      upstreamProduct = null;
    }

    if (upstreamProduct && typeof upstreamProduct === 'object') {
      const normalizedUpstream = attachProductDetailSource(
        normalizeProductDetailPrice({
          ...upstreamProduct,
          merchant_id: merchantId,
          product_id:
            String(upstreamProduct.product_id || upstreamProduct.id || productId).trim() ||
            productId,
        }),
        'upstream',
      );

      if (PRODUCT_DETAIL_CACHE_ENABLED) {
        setProductDetailCache(cacheKey, {
          status: 'success',
          success: true,
          product: normalizedUpstream,
          metadata: { query_source: 'upstream' },
        });
      }
      return normalizedUpstream;
    }

    if (process.env.DATABASE_URL && PRODUCT_DETAIL_STALE_LOOKUP_ENABLED) {
      const staleFromDb = await fetchProductDetailFromProductsCache({
        merchantId,
        productId,
        includeExpired: true,
        staleMaxAgeHours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
      });
      if (staleFromDb?.product) {
        const normalizedStale = attachProductDetailSource(
          normalizeProductDetailPrice(staleFromDb.product),
          'stale_cache',
        );
        if (PRODUCT_DETAIL_CACHE_ENABLED) {
          setProductDetailCache(cacheKey, {
            status: 'success',
            success: true,
            product: normalizedStale,
            metadata: {
              query_source: 'products_cache_stale',
              cached_at: staleFromDb.cached_at || null,
              stale_max_age_hours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
            },
          });
        }
        return normalizedStale;
      }
    }

    return null;
  })();

  PRODUCT_DETAIL_INFLIGHT.set(cacheKey, loadPromise);
  try {
    return await loadPromise;
  } finally {
    PRODUCT_DETAIL_INFLIGHT.delete(cacheKey);
  }
}

function normalizeOptionsRecord(raw) {
  const out = {};
  if (!raw) return out;

  const normKey = (value) => String(value || '').trim().toLowerCase();
  const normVal = (value) => String(value || '').trim().toLowerCase();

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const key = normKey(item.name || item.option || item.key);
      const val = normVal(item.value);
      if (!key || !val) continue;
      out[key] = val;
    }
    return out;
  }

  if (raw && typeof raw === 'object') {
    for (const [keyRaw, valueRaw] of Object.entries(raw)) {
      const key = normKey(keyRaw);
      const val = normVal(valueRaw);
      if (!key || !val) continue;
      out[key] = val;
    }
    return out;
  }

  return out;
}

function optionsRecordEquals(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (String(a[key]) !== String(b[key])) return false;
  }
  return true;
}

function extractVariantId(variant) {
  const raw = variant?.variant_id || variant?.variantId || variant?.id || null;
  return raw == null ? '' : String(raw).trim();
}

function extractVariantSku(variant) {
  const raw = variant?.sku || variant?.sku_id || variant?.skuId || variant?.sku_code || null;
  return raw == null ? '' : String(raw).trim().toUpperCase();
}

function extractVariantOptions(variant) {
  const raw = variant?.options || variant?.selected_options || variant?.selectedOptions || null;
  return normalizeOptionsRecord(raw);
}

function findVariantIdInProduct(product, selector) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!variants.length) return null;

  const desiredSku = selector?.sku ? String(selector.sku).trim() : '';
  const desiredOptions =
    selector?.options && typeof selector.options === 'object' ? selector.options : null;

  if (desiredSku) {
    const hit = variants.find((variant) => extractVariantSku(variant) === desiredSku);
    const id = hit ? extractVariantId(hit) : '';
    if (id) return id;
  }

  if (desiredOptions && Object.keys(desiredOptions).length > 0) {
    for (const variant of variants) {
      const options = extractVariantOptions(variant);
      if (optionsRecordEquals(options, desiredOptions)) {
        const id = extractVariantId(variant);
        if (id) return id;
      }
    }
  }

  return null;
}

async function rewriteCheckoutItemsForOfferSelection({
  offerId,
  merchantId,
  items,
  checkoutToken,
  parseOfferId = parseOfferIdBase,
  fetchProductGroupMembersFromUpstream = fetchProductGroupMembersFromUpstreamBase,
  fetchLegacyDetail = fetchLegacyProductDetailFromUpstream,
} = {}) {
  const parsed = offerId ? parseOfferId(offerId) : null;
  const productGroupId = parsed?.product_group_id ? String(parsed.product_group_id).trim() : null;
  if (!productGroupId) return { product_group_id: null, product_id: null, items };

  const groupResp = await fetchProductGroupMembersFromUpstream({
    productGroupId,
    checkoutToken,
  }).catch(() => null);
  const members = Array.isArray(groupResp?.members) ? groupResp.members : [];
  const targetMember = members.find(
    (member) =>
      String(member?.merchant_id || member?.merchantId || '').trim() ===
      String(merchantId || '').trim(),
  );
  const targetProductId =
    String(targetMember?.product_id || targetMember?.productId || '').trim() || null;
  if (!targetProductId) return { product_group_id: productGroupId, product_id: null, items };

  const productCache = new Map();
  const fetchProduct = async (mid, pid) => {
    const key = `${mid}:${pid}`;
    if (productCache.has(key)) return productCache.get(key);
    const product = await fetchLegacyDetail({
      merchantId: mid,
      productId: pid,
      checkoutToken,
    }).catch(() => null);
    productCache.set(key, product || null);
    return product || null;
  };

  const targetProduct = await fetchProduct(merchantId, targetProductId);
  if (!targetProduct) return { product_group_id: productGroupId, product_id: targetProductId, items };

  async function deriveVariantSelectorFromGroup(variantId, preferredProductId) {
    const vid = String(variantId || '').trim();
    if (!vid) return { sku: null, options: null };
    const preferredPid = String(preferredProductId || '').trim();
    const ordered = preferredPid
      ? [
          ...members.filter(
            (member) => String(member?.product_id || member?.productId || '').trim() === preferredPid,
          ),
          ...members.filter(
            (member) => String(member?.product_id || member?.productId || '').trim() !== preferredPid,
          ),
        ]
      : members;

    for (const member of ordered) {
      const mid = String(member?.merchant_id || member?.merchantId || '').trim();
      const pid = String(member?.product_id || member?.productId || '').trim();
      if (!mid || !pid) continue;
      const product = await fetchProduct(mid, pid);
      if (!product) continue;
      const variants = Array.isArray(product.variants) ? product.variants : [];
      const hit = variants.find((variant) => extractVariantId(variant) === vid);
      if (!hit) continue;
      const sku = extractVariantSku(hit) || null;
      const options = extractVariantOptions(hit);
      return {
        sku,
        options: options && Object.keys(options).length ? options : null,
      };
    }
    return { sku: null, options: null };
  }

  const rewritten = [];
  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = rawItem && typeof rawItem === 'object' ? { ...rawItem } : null;
    if (!item) continue;

    const originalProductId = String(item.product_id || item.productId || '').trim();
    const originalVariantId = String(item.variant_id || item.variantId || '').trim();
    const originalSku = String(item.sku || item.sku_id || item.skuId || '')
      .trim()
      .toUpperCase();
    const selectedOptionsRaw =
      item.selected_options || item.selectedOptions || item.options || null;
    const selectedOptions = normalizeOptionsRecord(selectedOptionsRaw);

    let desiredSku = originalSku || null;
    let desiredOptions = Object.keys(selectedOptions).length ? selectedOptions : null;

    if (!desiredSku && !desiredOptions && originalVariantId) {
      const derived = await deriveVariantSelectorFromGroup(originalVariantId, originalProductId);
      desiredSku = derived.sku;
      desiredOptions = derived.options;
    }

    const mappedVariantId = findVariantIdInProduct(targetProduct, {
      sku: desiredSku,
      options: desiredOptions,
    });

    if (!mappedVariantId && originalProductId && originalProductId !== targetProductId) {
      const err = new Error('Selected variant is not available for this seller.');
      err.code = 'VARIANT_MAPPING_FAILED';
      throw err;
    }

    item.product_id = targetProductId;
    if (mappedVariantId) {
      item.variant_id = mappedVariantId;
      item.variantId = mappedVariantId;
    }
    if (desiredSku && !item.sku) item.sku = desiredSku;
    if (desiredOptions && !item.selected_options) item.selected_options = desiredOptions;
    rewritten.push(item);
  }

  return { product_group_id: productGroupId, product_id: targetProductId, items: rewritten };
}

function resetProductDetailAdapterCaches() {
  PRODUCT_DETAIL_CACHE.clear();
  PRODUCT_DETAIL_INFLIGHT.clear();
  PRODUCT_DETAIL_CACHE_METRICS.hits = 0;
  PRODUCT_DETAIL_CACHE_METRICS.misses = 0;
  PRODUCT_DETAIL_CACHE_METRICS.sets = 0;
  PRODUCT_DETAIL_CACHE_METRICS.bypasses = 0;
  PRODUCT_DETAIL_CACHE_METRICS.evictions = 0;
  PRODUCT_DETAIL_CACHE_METRICS.db_hits = 0;
}

module.exports = {
  configureProductDetailAdapters,
  productDetailCacheEnabled: PRODUCT_DETAIL_CACHE_ENABLED,
  productDetailCacheTtlMs: PRODUCT_DETAIL_CACHE_TTL_MS,
  productDetailStaleMaxAgeHours: PRODUCT_DETAIL_STALE_MAX_AGE_HOURS,
  productDetailCacheMetrics: PRODUCT_DETAIL_CACHE_METRICS,
  snapshotProductDetailCacheStats,
  getProductDetailCacheEntry,
  setProductDetailCache,
  normalizeProductDetailPrice,
  fetchProductDetailFromProductsCache,
  attachProductDetailSource,
  inferDetailSourceFromQuerySource,
  getProductDetailSource,
  fetchProductDetailFromUpstream,
  fetchLegacyProductDetailFromUpstream,
  fetchProductDetailForOffers,
  rewriteCheckoutItemsForOfferSelection,
  __internal: {
    resetProductDetailAdapterCaches,
  },
};

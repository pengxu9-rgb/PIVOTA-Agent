function parseTimeoutMs(raw, fallbackMs) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

function safeCloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

const PDP_REVIEW_SUMMARY_CACHE_ENABLED =
  process.env.PDP_REVIEW_SUMMARY_CACHE_ENABLED !== 'false';
const PDP_REVIEW_SUMMARY_CACHE = new Map();
const PDP_REVIEW_SUMMARY_INFLIGHT = new Map();
const PDP_REVIEW_SUMMARY_CACHE_TTL_MS = parseTimeoutMs(
  process.env.PDP_REVIEW_SUMMARY_CACHE_TTL_MS,
  90 * 1000,
);
const PDP_REVIEW_SUMMARY_NEGATIVE_TTL_MS = Math.max(
  3_000,
  parseTimeoutMs(process.env.PDP_REVIEW_SUMMARY_NEGATIVE_TTL_MS, 20 * 1000),
);
const PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES = Math.max(
  50,
  Number(process.env.PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES || 800) || 800,
);
const PDP_REVIEW_SUMMARY_INFLIGHT_MAX_ENTRIES = Math.max(
  20,
  Number(process.env.PDP_REVIEW_SUMMARY_INFLIGHT_MAX_ENTRIES || 300) || 300,
);

const PDP_SIMILAR_INFLIGHT = new Map();
const PDP_SIMILAR_INFLIGHT_MAX_ENTRIES = Math.max(
  20,
  Number(process.env.PDP_SIMILAR_INFLIGHT_MAX_ENTRIES || 300) || 300,
);

let configuredDeps = null;

function configurePdpUpstreamAdapters(deps = {}) {
  configuredDeps = {
    ...(configuredDeps || {}),
    ...deps,
  };
}

function requireDeps() {
  if (!configuredDeps) {
    throw new Error('PDP upstream adapters are not configured');
  }
  return configuredDeps;
}

function buildPdpReviewSummaryCacheKey({ merchantId, platform, platformProductId }) {
  const mid = String(merchantId || '').trim();
  const pf = String(platform || '').trim().toLowerCase();
  const pid = String(platformProductId || '').trim();
  if (!mid || !pf || !pid) return '';
  return `${mid}::${pf}::${pid}`;
}

function getPdpReviewSummaryCacheEntry(cacheKey) {
  const key = String(cacheKey || '');
  if (!key) return { found: false, value: null };
  const hit = PDP_REVIEW_SUMMARY_CACHE.get(key);
  if (!hit) return { found: false, value: null };
  if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
    PDP_REVIEW_SUMMARY_CACHE.delete(key);
    return { found: false, value: null };
  }
  return { found: true, value: safeCloneJson(hit.value) };
}

function setPdpReviewSummaryCacheEntry(cacheKey, value, ttlMs) {
  const key = String(cacheKey || '');
  if (!key) return;
  const ttl = Math.max(1_000, Number(ttlMs) || PDP_REVIEW_SUMMARY_CACHE_TTL_MS);

  if (PDP_REVIEW_SUMMARY_CACHE.size >= PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES) {
    const overflow = PDP_REVIEW_SUMMARY_CACHE.size - PDP_REVIEW_SUMMARY_CACHE_MAX_ENTRIES + 1;
    let removed = 0;
    for (const existingKey of PDP_REVIEW_SUMMARY_CACHE.keys()) {
      PDP_REVIEW_SUMMARY_CACHE.delete(existingKey);
      removed += 1;
      if (removed >= overflow) break;
    }
  }

  PDP_REVIEW_SUMMARY_CACHE.set(key, {
    value: safeCloneJson(value),
    expiresAtMs: Date.now() + ttl,
  });
}

function buildPdpSimilarInflightKey(args = {}) {
  const product = args?.pdp_product && typeof args.pdp_product === 'object' ? args.pdp_product : {};
  const merchantId = String(
    product.merchant_id || product.merchantId || product.merchant?.id || '',
  ).trim();
  const productId = String(product.product_id || product.productId || product.id || '').trim();
  if (!merchantId || !productId) return '';
  const limit = Math.max(1, Math.min(24, Number(args?.k || 6) || 6));
  const locale = String(args?.locale || 'en-US').trim().toLowerCase();
  const currency = String(args?.currency || product.currency || 'USD').trim().toUpperCase();
  const bypass = Boolean(
    args?.options?.no_cache || args?.options?.cache_bypass || args?.options?.bypass_cache,
  );
  return `${merchantId}::${productId}::${limit}::${locale}::${currency}::${bypass ? '1' : '0'}`;
}

function trimOldestInflightEntries(map, maxEntries) {
  while (map.size >= maxEntries) {
    const firstKey = map.keys().next().value;
    if (!firstKey) break;
    map.delete(firstKey);
  }
}

async function fetchVariantDetailFromUpstream(args) {
  const { axios, buildInvokeUpstreamAuthHeaders, getUpstreamTimeoutMs, callUpstreamWithOptionalRetry, pivotaApiBase } =
    requireDeps();
  const { merchantId, variantId, checkoutToken } = args || {};
  const url = `${pivotaApiBase}/agent/v1/products/merchants/${encodeURIComponent(
    merchantId,
  )}/variant/${encodeURIComponent(variantId)}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    },
    timeout: getUpstreamTimeoutMs('get_product_detail'),
  };
  const resp = await callUpstreamWithOptionalRetry('get_product_detail', axiosConfig, { axios });
  return resp?.data || null;
}

async function fetchProductGroupMembersFromUpstream(args) {
  const { axios, buildInvokeUpstreamAuthHeaders, getUpstreamTimeoutMs, pivotaApiBase } = requireDeps();
  const { productGroupId, checkoutToken } = args || {};
  const url = `${pivotaApiBase}/agent/v1/product-groups/${encodeURIComponent(productGroupId)}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    },
    timeout: getUpstreamTimeoutMs('find_products_multi'),
  };
  const resp = await axios(axiosConfig);
  return resp?.data || null;
}

async function resolveProductGroupFromUpstream(args) {
  const { axios, buildQueryString, buildInvokeUpstreamAuthHeaders, getUpstreamTimeoutMs, pivotaApiBase } =
    requireDeps();
  const { merchantId, productId, platform, checkoutToken } = args || {};
  const queryString = buildQueryString({
    merchant_id: merchantId,
    product_id: productId,
    ...(platform ? { platform } : {}),
  });
  const url = `${pivotaApiBase}/agent/v1/product-groups/resolve${queryString}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    },
    timeout: getUpstreamTimeoutMs('find_products_multi'),
  };
  const resp = await axios(axiosConfig);
  return resp?.data || null;
}

async function resolveProductGroupByProductIdFromUpstream(args) {
  const { axios, buildQueryString, buildInvokeUpstreamAuthHeaders, getUpstreamTimeoutMs, pivotaApiBase } =
    requireDeps();
  const { productId, platform, checkoutToken } = args || {};
  const queryString = buildQueryString({
    product_id: productId,
    ...(platform ? { platform } : {}),
  });
  const url = `${pivotaApiBase}/agent/v1/product-groups/resolve-by-product-id${queryString}`;
  const axiosConfig = {
    method: 'GET',
    url,
    headers: {
      ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
    },
    timeout: getUpstreamTimeoutMs('find_products_multi'),
  };
  const resp = await axios(axiosConfig);
  return resp?.data || null;
}

async function fetchReviewSummaryFromUpstream(args) {
  const {
    callUpstreamWithOptionalRetry,
    reviewsApiBase,
    upstreamTimeoutReviewsMs,
  } = requireDeps();
  const { merchantId, platform, platformProductId, checkoutToken } = args || {};
  const mid = String(merchantId || '').trim();
  const pf = String(platform || '').trim();
  const pid = String(platformProductId || '').trim();
  if (!mid || !pf || !pid) return null;

  const url = `${reviewsApiBase}/agent/shop/v1/invoke`;
  const data = {
    operation: 'get_review_summary',
    payload: {
      sku: {
        merchant_id: mid,
        platform: pf,
        platform_product_id: pid,
        variant_id: null,
      },
    },
  };

  const axiosConfig = {
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(checkoutToken ? { 'X-Checkout-Token': checkoutToken } : {}),
    },
    timeout: upstreamTimeoutReviewsMs,
    data,
  };

  const resp = await callUpstreamWithOptionalRetry('get_review_summary', axiosConfig);
  const summary = resp?.data?.review_summary;
  return summary && typeof summary === 'object' ? summary : null;
}

async function fetchReviewSummaryCached(args = {}) {
  const merchantId = String(args?.merchantId || '').trim();
  const platform = String(args?.platform || '').trim();
  const platformProductId = String(args?.platformProductId || '').trim();
  if (!merchantId || !platform || !platformProductId) return null;

  const bypassCache = Boolean(args?.bypassCache);
  const cacheKey = buildPdpReviewSummaryCacheKey({
    merchantId,
    platform,
    platformProductId,
  });
  if (!cacheKey) return null;

  if (PDP_REVIEW_SUMMARY_CACHE_ENABLED && !bypassCache) {
    const cached = getPdpReviewSummaryCacheEntry(cacheKey);
    if (cached.found) return cached.value;
  }

  const existing = PDP_REVIEW_SUMMARY_INFLIGHT.get(cacheKey);
  if (existing) return existing;

  trimOldestInflightEntries(PDP_REVIEW_SUMMARY_INFLIGHT, PDP_REVIEW_SUMMARY_INFLIGHT_MAX_ENTRIES);
  const task = (async () => {
    try {
      const summary = await fetchReviewSummaryFromUpstream({
        ...args,
        merchantId,
        platform,
        platformProductId,
      });
      if (PDP_REVIEW_SUMMARY_CACHE_ENABLED && !bypassCache) {
        const ttl = summary ? PDP_REVIEW_SUMMARY_CACHE_TTL_MS : PDP_REVIEW_SUMMARY_NEGATIVE_TTL_MS;
        setPdpReviewSummaryCacheEntry(cacheKey, summary, ttl);
      }
      return summary;
    } finally {
      PDP_REVIEW_SUMMARY_INFLIGHT.delete(cacheKey);
    }
  })();
  PDP_REVIEW_SUMMARY_INFLIGHT.set(cacheKey, task);
  return task;
}

async function fetchSimilarProductsDeduped(args = {}) {
  const { recommendPdpProducts } = requireDeps();
  const inflightKey = buildPdpSimilarInflightKey(args);
  const runOnce = async () => {
    const rec = await recommendPdpProducts(args);
    return Array.isArray(rec?.items) ? rec.items : [];
  };

  if (!inflightKey) return runOnce();
  const existing = PDP_SIMILAR_INFLIGHT.get(inflightKey);
  if (existing) return existing;

  trimOldestInflightEntries(PDP_SIMILAR_INFLIGHT, PDP_SIMILAR_INFLIGHT_MAX_ENTRIES);
  const task = (async () => {
    try {
      return await runOnce();
    } finally {
      PDP_SIMILAR_INFLIGHT.delete(inflightKey);
    }
  })();
  PDP_SIMILAR_INFLIGHT.set(inflightKey, task);
  return task;
}

function resetPdpUpstreamAdapterCaches() {
  PDP_REVIEW_SUMMARY_CACHE.clear();
  PDP_REVIEW_SUMMARY_INFLIGHT.clear();
  PDP_SIMILAR_INFLIGHT.clear();
}

module.exports = {
  configurePdpUpstreamAdapters,
  fetchVariantDetailFromUpstream,
  fetchProductGroupMembersFromUpstream,
  resolveProductGroupFromUpstream,
  resolveProductGroupByProductIdFromUpstream,
  fetchReviewSummaryCached,
  fetchSimilarProductsDeduped,
  __internal: {
    buildPdpReviewSummaryCacheKey,
    buildPdpSimilarInflightKey,
    resetPdpUpstreamAdapterCaches,
  },
};

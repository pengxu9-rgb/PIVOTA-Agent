function parseShopifyAccessToken(apiKeyRaw) {
  if (!apiKeyRaw) return '';
  const raw = String(apiKeyRaw).trim();
  if (!raw) return '';
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const token = parsed.access_token || parsed.token || '';
      return String(token || '').trim();
    }
  } catch (_) {
    // ignore malformed legacy values
  }
  return raw;
}

function createShopifyCurrencyRuntime({
  queryDb,
  axiosClient,
  logger,
  databaseUrl = process.env.DATABASE_URL,
  shopifyApiVersion = '2024-07',
  cacheTtlMs = 6 * 60 * 60 * 1000,
  negativeCacheTtlMs = 10 * 60 * 1000,
} = {}) {
  const merchantCurrencyCache = new Map();

  function getCachedShopifyMerchantCurrency(merchantId) {
    const mid = String(merchantId || '').trim();
    if (!mid) return null;
    const hit = merchantCurrencyCache.get(mid);
    if (!hit) return null;
    if (hit.expiresAtMs && hit.expiresAtMs < Date.now()) {
      merchantCurrencyCache.delete(mid);
      return null;
    }
    return hit.currency || null;
  }

  function setCachedShopifyMerchantCurrency(merchantId, currency, ttlMs = cacheTtlMs) {
    const mid = String(merchantId || '').trim();
    const cur = String(currency || '').trim().toUpperCase();
    if (!mid) return;
    merchantCurrencyCache.set(mid, {
      currency: cur || null,
      expiresAtMs: Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : cacheTtlMs),
    });
  }

  async function fetchShopifyMerchantCurrency(merchantId) {
    const cached = getCachedShopifyMerchantCurrency(merchantId);
    if (cached) return cached;
    if (!databaseUrl) return null;

    const mid = String(merchantId || '').trim();
    if (!mid) return null;

    let storeRow;
    try {
      const res = await queryDb(
        `
          SELECT domain, api_key
          FROM merchant_stores
          WHERE merchant_id = $1
            AND platform = 'shopify'
            AND status IN ('active', 'connected')
          ORDER BY connected_at DESC NULLS LAST
          LIMIT 1
        `,
        [mid],
      );
      storeRow = res.rows && res.rows[0] ? res.rows[0] : null;
    } catch (err) {
      logger?.warn?.(
        { err: err.message, merchantId: mid },
        'Failed to query merchant_stores for Shopify currency',
      );
      return null;
    }

    const domain = storeRow && storeRow.domain ? String(storeRow.domain).trim() : '';
    const accessToken = parseShopifyAccessToken(storeRow && storeRow.api_key ? storeRow.api_key : '');

    if (!domain || !accessToken) {
      setCachedShopifyMerchantCurrency(mid, null, negativeCacheTtlMs);
      return null;
    }

    try {
      const url = `https://${domain}/admin/api/${shopifyApiVersion}/shop.json`;
      const resp = await axiosClient.get(url, {
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
        validateStatus: () => true,
      });

      if (resp.status !== 200) {
        setCachedShopifyMerchantCurrency(mid, null, negativeCacheTtlMs);
        return null;
      }

      const cur = String(resp.data && resp.data.shop && resp.data.shop.currency ? resp.data.shop.currency : '')
        .trim()
        .toUpperCase();
      if (!cur) {
        setCachedShopifyMerchantCurrency(mid, null, negativeCacheTtlMs);
        return null;
      }

      setCachedShopifyMerchantCurrency(mid, cur, cacheTtlMs);
      return cur;
    } catch (err) {
      logger?.warn?.(
        { err: err.message, merchantId: mid },
        'Failed to fetch Shopify shop currency',
      );
      setCachedShopifyMerchantCurrency(mid, null, negativeCacheTtlMs);
      return null;
    }
  }

  async function applyShopifyCurrencyOverride(products) {
    if (!Array.isArray(products) || products.length === 0) return products;

    const merchantIds = new Set();
    for (const product of products) {
      if (!product) continue;
      const platform = String(product.platform || '').toLowerCase();
      if (platform !== 'shopify') continue;
      const cur = String(product.currency || '').trim().toUpperCase();
      if (cur && cur !== 'USD') continue;
      const mid = String(product.merchant_id || product.merchantId || '').trim();
      if (mid) merchantIds.add(mid);
    }

    if (!merchantIds.size) return products;

    const mids = Array.from(merchantIds);
    const currencies = await Promise.all(mids.map((mid) => fetchShopifyMerchantCurrency(mid)));
    const currencyByMerchant = new Map();
    mids.forEach((mid, idx) => {
      if (currencies[idx]) currencyByMerchant.set(mid, currencies[idx]);
    });

    if (!currencyByMerchant.size) return products;

    for (const product of products) {
      if (!product) continue;
      const platform = String(product.platform || '').toLowerCase();
      if (platform !== 'shopify') continue;
      const mid = String(product.merchant_id || product.merchantId || '').trim();
      const cur = currencyByMerchant.get(mid);
      if (cur) product.currency = cur;
    }

    return products;
  }

  return {
    applyShopifyCurrencyOverride,
  };
}

module.exports = {
  createShopifyCurrencyRuntime,
};

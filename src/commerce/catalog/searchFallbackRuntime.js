const {
  isAuroraSource: isAuroraSourceBase,
} = require('./searchGuards');
const {
  createSearchRelevanceHelpers,
} = require('./searchRelevance');

const {
  countUsableSearchProducts: countUsableSearchProductsBase,
  normalizeSearchTextForMatch: normalizeSearchTextForMatchBase,
} = createSearchRelevanceHelpers();

function isExternalSeedProduct(product) {
  if (!product || typeof product !== 'object') return false;
  const merchantId = String(product.merchant_id || product.merchantId || '').trim();
  const source = String(product.source || '').trim().toLowerCase();
  return merchantId === 'external_seed' || source === 'external_seed';
}

function normalizeSearchBrandToken(value, { normalizeSearchTextForMatch } = {}) {
  const normalize =
    typeof normalizeSearchTextForMatch === 'function'
      ? normalizeSearchTextForMatch
      : normalizeSearchTextForMatchBase;
  const normalized = normalize(String(value || '').trim());
  if (!normalized) return '';
  return normalized.replace(/\s+/g, ' ').trim();
}

function extractSearchProductBrandToken(product, options = {}) {
  if (!product || typeof product !== 'object') return '';
  const brand = String(product.brand || product.brand_name || product.vendor || '').trim();
  return normalizeSearchBrandToken(brand, options);
}

function detectAuroraExternalSeedMonoculture(
  { normalized, queryText, source } = {},
  {
    isAuroraSource = isAuroraSourceBase,
    normalizeSearchTextForMatch = normalizeSearchTextForMatchBase,
    isExternalSeedProduct: isExternalSeedProductImpl = isExternalSeedProduct,
  } = {},
) {
  if (!(typeof isAuroraSource === 'function' && isAuroraSource(source))) {
    return {
      detected: false,
      dominantBrand: null,
      externalCount: 0,
      totalCount: 0,
      externalRatio: 0,
    };
  }
  const products = Array.isArray(normalized?.products) ? normalized.products : [];
  if (products.length < 3) {
    return {
      detected: false,
      dominantBrand: null,
      externalCount: 0,
      totalCount: products.length,
      externalRatio: 0,
    };
  }
  const externalProducts = products.filter((product) => isExternalSeedProductImpl(product));
  if (externalProducts.length < 3) {
    return {
      detected: false,
      dominantBrand: null,
      externalCount: externalProducts.length,
      totalCount: products.length,
      externalRatio: externalProducts.length / Math.max(1, products.length),
    };
  }
  const externalRatio = externalProducts.length / Math.max(1, products.length);
  if (externalRatio < 0.8) {
    return {
      detected: false,
      dominantBrand: null,
      externalCount: externalProducts.length,
      totalCount: products.length,
      externalRatio,
    };
  }
  const brandCounts = new Map();
  for (const product of externalProducts) {
    const brandToken = extractSearchProductBrandToken(product, {
      normalizeSearchTextForMatch,
    });
    if (!brandToken) continue;
    brandCounts.set(brandToken, Number(brandCounts.get(brandToken) || 0) + 1);
  }
  if (brandCounts.size !== 1) {
    return {
      detected: false,
      dominantBrand: null,
      externalCount: externalProducts.length,
      totalCount: products.length,
      externalRatio,
    };
  }
  const [[dominantBrand, dominantCount]] = Array.from(brandCounts.entries());
  if (dominantCount < Math.max(3, Math.floor(externalProducts.length * 0.8))) {
    return {
      detected: false,
      dominantBrand,
      externalCount: externalProducts.length,
      totalCount: products.length,
      externalRatio,
    };
  }
  const normalizedQuery = normalizeSearchTextForMatch(String(queryText || ''));
  if (!normalizedQuery || !normalizedQuery.includes(dominantBrand)) {
    return {
      detected: false,
      dominantBrand,
      externalCount: externalProducts.length,
      totalCount: products.length,
      externalRatio,
    };
  }
  return {
    detected: true,
    dominantBrand,
    externalCount: externalProducts.length,
    totalCount: products.length,
    externalRatio,
  };
}

async function withStageBudget(promise, timeoutMs, timeoutLabel) {
  const budgetMs = Math.max(1, Number(timeoutMs || 0) || 0);
  if (!budgetMs) return promise;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(
            `Stage budget exceeded (${timeoutLabel || 'stage'}): ${budgetMs}ms`,
          );
          err.code = 'STAGE_TIMEOUT';
          err.stage = timeoutLabel || 'stage';
          reject(err);
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shouldFallbackProxySearch(
  normalized,
  statusCode,
  {
    countUsableSearchProducts = countUsableSearchProductsBase,
  } = {},
) {
  const status = Number(statusCode || 0);
  if (status >= 500) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status < 200 || status >= 300) return false;
  const products = Array.isArray(normalized?.products) ? normalized.products : [];
  const usableCount =
    typeof countUsableSearchProducts === 'function'
      ? countUsableSearchProducts(products)
      : 0;
  const total = Number(normalized?.total);
  if (products.length > 0 && usableCount === 0) return true;
  if (Number.isFinite(total) && total > 0 && usableCount === 0) return true;
  if (products.length === 0 && Number.isFinite(total) && total === 0) return true;
  return false;
}

function getFallbackAdoptUsableThreshold(
  { operation, source, primaryUsableCount, primaryIrrelevant } = {},
  {
    isAuroraSource = isAuroraSourceBase,
    proxySearchAuroraRelaxPrimaryIrrelevantAdopt =
      String(process.env.PROXY_SEARCH_AURORA_RELAX_PRIMARY_IRRELEVANT_ADOPT || 'true')
        .trim()
        .toLowerCase() !== 'false',
  } = {},
) {
  const baseThreshold = Math.max(1, Number(primaryUsableCount || 0));
  const op = String(operation || '').trim();
  if (op !== 'find_products_multi') return baseThreshold;
  if (!primaryIrrelevant) return baseThreshold;
  if (
    typeof isAuroraSource === 'function' &&
    isAuroraSource(source) &&
    proxySearchAuroraRelaxPrimaryIrrelevantAdopt
  ) {
    return 1;
  }
  return baseThreshold;
}

function shouldBypassSecondaryFallbackSkipOnPrimaryException({ err } = {}) {
  const status = Number(err?.response?.status || err?.status || 0);
  if (Number.isFinite(status) && status >= 500) return true;

  const code = String(err?.code || '').trim().toUpperCase();
  if (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }

  const message = String(err?.message || '').trim();
  return /timeout|timed out|socket hang up|aborted|network error/i.test(message);
}

module.exports = {
  isExternalSeedProduct,
  detectAuroraExternalSeedMonoculture,
  withStageBudget,
  shouldFallbackProxySearch,
  getFallbackAdoptUsableThreshold,
  shouldBypassSecondaryFallbackSkipOnPrimaryException,
};

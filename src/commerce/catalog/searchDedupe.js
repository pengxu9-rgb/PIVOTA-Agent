function defaultNormalizeSearchTextForMatch(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function createSearchDedupeHelpers({
  normalizeSearchTextForMatch = defaultNormalizeSearchTextForMatch,
} = {}) {
  function buildSearchProductKey(product) {
    if (!product || typeof product !== 'object') return '';
    const merchantId = String(product.merchant_id || product.merchantId || '').trim();
    const productId = String(
      product.product_id || product.productId || product.id || product.platform_product_id || '',
    ).trim();
    return `${merchantId}::${productId}`;
  }

  function normalizeSearchProductTitleForDedupe(product) {
    if (!product || typeof product !== 'object') return '';
    const title = String(
      product.title ||
        product.name ||
        product.display_name ||
        product.product_name ||
        '',
    ).trim();
    if (!title) return '';
    return normalizeSearchTextForMatch(title);
  }

  function collapseNearDuplicateSearchProducts(products, options = {}) {
    const list = Array.isArray(products) ? products : [];
    if (!list.length) return [];
    const perTitleLimitRaw = Number(options.perTitleLimit);
    const perTitleLimit =
      Number.isFinite(perTitleLimitRaw) && perTitleLimitRaw >= 1
        ? Math.floor(perTitleLimitRaw)
        : 1;
    const counts = new Map();
    const out = [];
    for (const product of list) {
      const titleKey = normalizeSearchProductTitleForDedupe(product);
      if (!titleKey) {
        out.push(product);
        continue;
      }
      const count = Number(counts.get(titleKey) || 0);
      if (count >= perTitleLimit) continue;
      counts.set(titleKey, count + 1);
      out.push(product);
    }
    return out;
  }

  function resolveSearchDedupePerTitleLimit({ queryText, intent, queryClass }) {
    const normalizedClass = String(queryClass || intent?.query_class || '')
      .trim()
      .toLowerCase();
    const primaryDomain = String(intent?.primary_domain || '').trim().toLowerCase();
    const scenarioName = String(intent?.scenario?.name || '').trim().toLowerCase();
    const raw = String(queryText || '').trim();

    if (normalizedClass === 'lookup') {
      return 1;
    }

    if (primaryDomain === 'beauty') {
      const beautyGeneralScenario = scenarioName === 'general';
      const beautySceneSignal =
        /约会妆|约会|出差妆|旅行妆|date makeup|date look|night out makeup|wedding makeup|interview makeup/i.test(
          raw,
        );
      if (
        normalizedClass === 'scenario' ||
        normalizedClass === 'mission' ||
        (beautyGeneralScenario && beautySceneSignal)
      ) {
        return 3;
      }
      return 2;
    }

    if (
      normalizedClass === 'scenario' ||
      normalizedClass === 'mission' ||
      normalizedClass === 'gift'
    ) {
      return 2;
    }

    return 1;
  }

  return {
    buildSearchProductKey,
    normalizeSearchProductTitleForDedupe,
    collapseNearDuplicateSearchProducts,
    resolveSearchDedupePerTitleLimit,
  };
}

module.exports = {
  defaultNormalizeSearchTextForMatch,
  createSearchDedupeHelpers,
  ...createSearchDedupeHelpers(),
};

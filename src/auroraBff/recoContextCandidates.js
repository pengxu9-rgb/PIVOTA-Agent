function extractRecoContextProductCandidatesFromRecommendations(
  recommendations,
  {
    max = 12,
    normalizeRecoCatalogProduct,
    pickFirstTrimmed,
    joinBrandAndName,
    isPlainObject,
  } = {},
) {
  const rows = Array.isArray(recommendations) ? recommendations : [];
  const out = [];
  const seen = new Set();
  const normalize = typeof normalizeRecoCatalogProduct === 'function' ? normalizeRecoCatalogProduct : null;
  const pickFirst = typeof pickFirstTrimmed === 'function' ? pickFirstTrimmed : null;
  const joinBrandName = typeof joinBrandAndName === 'function' ? joinBrandAndName : null;
  const isObject = typeof isPlainObject === 'function'
    ? isPlainObject
    : (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  if (!normalize || !pickFirst || !joinBrandName) return out;

  for (const raw of rows) {
    const normalized = normalize(raw);
    if (!isObject(normalized)) continue;
    const dedupeKey = pickFirst(
      normalized.product_id,
      normalized.sku_id,
      normalized.canonical_product_ref && `${normalized.canonical_product_ref.merchant_id}:${normalized.canonical_product_ref.product_id}`,
      joinBrandName(normalized.brand, pickFirst(normalized.display_name, normalized.name)),
    ).toLowerCase();
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

module.exports = {
  extractRecoContextProductCandidatesFromRecommendations,
};

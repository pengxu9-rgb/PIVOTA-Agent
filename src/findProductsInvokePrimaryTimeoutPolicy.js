function resolveFindProductsMultiPrimaryUpstreamTimeoutMs({
  queryClass = '',
  isLookupPolicyQuery = false,
  strictBeautyDirectSearch = false,
  semanticOwnerControlled = false,
  upstreamDefaultTimeoutMs = 0,
  lookupTimeoutMs = 0,
  defaultTimeoutMs = 0,
  beautyMainlineTimeoutMs = 0,
} = {}) {
  const normalizedQueryClass = String(queryClass || '').trim().toLowerCase();
  const safeUpstreamDefaultTimeoutMs = Math.max(
    100,
    Number.isFinite(Number(upstreamDefaultTimeoutMs)) ? Number(upstreamDefaultTimeoutMs) : 100,
  );
  const safeLookupTimeoutMs = Math.max(
    100,
    Number.isFinite(Number(lookupTimeoutMs)) ? Number(lookupTimeoutMs) : safeUpstreamDefaultTimeoutMs,
  );
  const safeDefaultTimeoutMs = Math.max(
    100,
    Number.isFinite(Number(defaultTimeoutMs)) ? Number(defaultTimeoutMs) : safeUpstreamDefaultTimeoutMs,
  );
  const safeBeautyMainlineTimeoutMs = Math.max(
    safeDefaultTimeoutMs,
    Number.isFinite(Number(beautyMainlineTimeoutMs))
      ? Number(beautyMainlineTimeoutMs)
      : safeDefaultTimeoutMs,
  );
  const beautyMainlineOwned = strictBeautyDirectSearch || semanticOwnerControlled;
  const shortLookupClass =
    ['lookup', 'attribute'].includes(normalizedQueryClass) ||
    (normalizedQueryClass === 'category' && !beautyMainlineOwned);

  if (
    isLookupPolicyQuery ||
    shortLookupClass
  ) {
    return Math.min(safeUpstreamDefaultTimeoutMs, safeLookupTimeoutMs);
  }

  if (beautyMainlineOwned) {
    return safeBeautyMainlineTimeoutMs;
  }

  return Math.min(safeUpstreamDefaultTimeoutMs, safeDefaultTimeoutMs);
}

module.exports = {
  resolveFindProductsMultiPrimaryUpstreamTimeoutMs,
};

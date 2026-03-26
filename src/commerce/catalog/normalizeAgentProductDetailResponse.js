function normalizeAgentProductDetailResponse(raw) {
  if (!raw) return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.product) return raw;
    if (raw.data && typeof raw.data === 'object' && raw.data.product) {
      return { ...raw, product: raw.data.product };
    }
    const looksLikeProduct =
      (raw.id || raw.product_id || raw.productId || raw.title || raw.name) &&
      typeof raw !== 'string';
    if (looksLikeProduct) {
      return { status: 'success', success: true, product: raw };
    }
    if (raw.data && typeof raw.data === 'object') {
      const data = raw.data;
      const dataLooksLikeProduct =
        data && (data.id || data.product_id || data.productId || data.title || data.name);
      if (dataLooksLikeProduct) {
        return { ...raw, product: data };
      }
    }
  }
  return raw;
}

module.exports = {
  normalizeAgentProductDetailResponse,
};

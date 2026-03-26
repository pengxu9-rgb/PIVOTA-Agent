function shouldIncludePdp(payload) {
  if (!payload) return false;
  const view = String(payload.view || '').toLowerCase();
  if (view === 'pdp') return true;
  const include = Array.isArray(payload.include) ? payload.include : [];
  return include.includes('pdp') || include.includes('pdp_payload');
}

function getPdpOptions(payload) {
  const include = Array.isArray(payload?.include) ? payload.include : [];
  return {
    includeRecommendations:
      include.includes('recommendations') || Boolean(payload?.recommendations?.limit),
    includeEmptyReviews:
      include.includes('reviews_preview') || payload?.include_empty_reviews === true,
    templateHint: payload?.template_hint || payload?.template || null,
    entryPoint: payload?.context?.entry_point || payload?.entry_point || null,
    experiment: payload?.context?.experiment || payload?.experiment || null,
    debug:
      payload?.debug === true ||
      payload?.options?.debug === true ||
      payload?.context?.debug === true,
  };
}

module.exports = {
  shouldIncludePdp,
  getPdpOptions,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildBeautySearchSourceBreakdown({
  existingSourceBreakdown = null,
  sourceObservability = null,
  semanticOwnerCacheSourceIsolated = false,
  semanticOwnerLastResortCacheApplied = false,
} = {}) {
  const existing =
    existingSourceBreakdown && isPlainObject(existingSourceBreakdown)
      ? existingSourceBreakdown
      : {};
  const observability = sourceObservability && isPlainObject(sourceObservability)
    ? sourceObservability
    : {};

  return {
    ...existing,
    internal_count: Math.max(0, Number(observability.internal_live || 0) || 0),
    external_seed_count: Math.max(0, Number(observability.external_supplement || 0) || 0),
    stable_prior_count: Math.max(0, Number(observability.stable_prior || 0) || 0),
    stale_cache_used: Number(observability.source_tier_counts?.cache_stale || 0) > 0,
    source_channel_counts: isPlainObject(observability.source_channel_counts)
      ? observability.source_channel_counts
      : {},
    source_tier_counts: isPlainObject(observability.source_tier_counts)
      ? observability.source_tier_counts
      : {},
    source_quality_counts: isPlainObject(observability.source_quality_counts)
      ? observability.source_quality_counts
      : {},
    cache_owner_paths: Array.isArray(observability.cache_owner_paths)
      ? observability.cache_owner_paths
      : [],
    top_candidate_provenance: isPlainObject(observability.top_candidate_provenance)
      ? observability.top_candidate_provenance
      : null,
    ...(semanticOwnerCacheSourceIsolated
      ? { strategy_applied: 'semantic_owner_cache_source_isolated' }
      : semanticOwnerLastResortCacheApplied
      ? { strategy_applied: 'semantic_owner_last_resort_cache' }
      : {}),
  };
}

module.exports = {
  buildBeautySearchSourceBreakdown,
};

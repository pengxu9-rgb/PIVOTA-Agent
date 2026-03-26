function createHealthRouteHandler({
  env = process.env,
  logger,
  getCreatorConfig,
  uniqueStrings,
  probeCreatorCacheDbStats,
  getAuroraRequiredRouteContractsHealth,
  auroraRoutesFailClosed = false,
  auroraRoutesReady = true,
  auroraRoutesLoadError = null,
  useMock = false,
  port = null,
  apiMode = 'REAL',
  useHybrid = false,
  realApiEnabled = true,
  serviceName = null,
  serviceGitShaShort = null,
  serviceBuildId = null,
  serviceGitBranch = null,
  serviceDeploymentId = null,
  serviceStartedAt = null,
  pivotaApiBase = null,
  proxySearchAuroraApiBase = null,
  pivotaApiKey = null,
  snapshotResolveProductCandidatesCacheStats,
  snapshotResolveProductGroupCacheStats,
  snapshotProductDetailCacheStats,
  snapshotPdpV2CoreHotCacheStats,
  getPdpRecsCacheStats,
  buildCatalogSyncSnapshot,
} = {}) {
  return function healthRouteHandler(req, res) {
    const dbConfigured = Boolean(env.DATABASE_URL);
    const taxonomyEnabled = env.TAXONOMY_ENABLED !== 'false';
    const minSellable = Math.max(Number(env.HEALTHZ_MIN_SELLABLE_PRODUCTS || 20) || 20, 0);
    const includeCacheStats = env.HEALTHZ_INCLUDE_CACHE_STATS === 'true';
    const auroraStartupCritical = auroraRoutesFailClosed && !auroraRoutesReady;
    const requiredRoutesHealth =
      typeof getAuroraRequiredRouteContractsHealth === 'function'
        ? getAuroraRequiredRouteContractsHealth()
        : null;

    const creatorIdForStats = env.HEALTHZ_CACHE_STATS_CREATOR_ID || 'nina-studio';
    const creatorConfig =
      typeof getCreatorConfig === 'function' ? getCreatorConfig(creatorIdForStats) : null;
    const merchantIds = typeof uniqueStrings === 'function'
      ? uniqueStrings(creatorConfig?.merchantIds || [])
      : [];

    const cacheStatsPromise =
      includeCacheStats &&
      dbConfigured &&
      merchantIds.length &&
      typeof probeCreatorCacheDbStats === 'function'
        ? probeCreatorCacheDbStats(merchantIds, 'unknown', { force: true })
        : Promise.resolve(null);

    return cacheStatsPromise
      .then((cacheStats) => {
        const sellable = cacheStats && typeof cacheStats.products_cache_sellable_total === 'number'
          ? cacheStats.products_cache_sellable_total
          : null;
        const cacheWarning = typeof sellable === 'number' ? sellable < minSellable : null;

        return res.status(auroraStartupCritical ? 503 : 200).json({
          ok: !auroraStartupCritical,
          use_mock: useMock,
          port,
          api_mode: apiMode,
          aurora_routes_ready: auroraRoutesReady,
          aurora_routes_fail_closed: auroraRoutesFailClosed,
          aurora_routes_error: auroraRoutesLoadError,
          required_routes_ok:
            requiredRoutesHealth && Object.prototype.hasOwnProperty.call(requiredRoutesHealth, 'ok')
              ? Boolean(requiredRoutesHealth.ok)
              : null,
          missing_routes:
            requiredRoutesHealth && Array.isArray(requiredRoutesHealth.missing_routes)
              ? requiredRoutesHealth.missing_routes
              : [],
          modes: {
            mock: useMock,
            hybrid: useHybrid,
            real_api_enabled: realApiEnabled,
          },
          version: {
            service: serviceName,
            commit: serviceGitShaShort,
            build_id: serviceBuildId,
            branch: serviceGitBranch || null,
            deployment_id: serviceDeploymentId || null,
            started_at: serviceStartedAt,
          },
          backend: {
            api_base: pivotaApiBase,
            aurora_proxy_search_api_base: proxySearchAuroraApiBase || null,
            api_key_configured: !!pivotaApiKey,
            db_configured: dbConfigured,
            taxonomy_enabled: taxonomyEnabled,
            taxonomy_view_id: env.TAXONOMY_VIEW_ID || 'GLOBAL_FASHION',
            taxonomy_version: env.TAXONOMY_VERSION || null,
          },
          resolve_product_candidates_cache:
            typeof snapshotResolveProductCandidatesCacheStats === 'function'
              ? snapshotResolveProductCandidatesCacheStats()
              : null,
          resolve_product_group_cache:
            typeof snapshotResolveProductGroupCacheStats === 'function'
              ? snapshotResolveProductGroupCacheStats()
              : null,
          product_detail_cache:
            typeof snapshotProductDetailCacheStats === 'function'
              ? snapshotProductDetailCacheStats()
              : null,
          pdp_v2_core_hot_cache:
            typeof snapshotPdpV2CoreHotCacheStats === 'function'
              ? snapshotPdpV2CoreHotCacheStats()
              : null,
          pdp_recommendations_cache:
            typeof getPdpRecsCacheStats === 'function' ? getPdpRecsCacheStats() : null,
          products_available: true,
          catalog_cache: includeCacheStats
            ? {
                creator_id: creatorIdForStats,
                merchant_ids: merchantIds,
                min_sellable_products: minSellable,
                warning: cacheWarning,
                stats: cacheStats,
              }
            : undefined,
          catalog_sync:
            typeof buildCatalogSyncSnapshot === 'function' ? buildCatalogSyncSnapshot() : null,
          features: {
            product_search: true,
            order_creation: true,
            payment: useMock || useHybrid ? 'mock' : 'real',
            tracking: true,
            layer1_compatibility: true,
            find_products_multi_vector_enabled:
              env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED === 'true',
          },
          startup_guards: {
            aurora_routes_critical: auroraStartupCritical,
          },
          message: `Running in ${apiMode} mode. ${
            useMock
              ? 'Using internal mock products.'
              : useHybrid
              ? 'Real products, mock payment.'
              : 'Full real API integration.'
          }`,
        });
      })
      .catch((err) => {
        logger?.warn?.({ err: err.message }, 'healthz cache stats probe failed');
        return res.status(auroraStartupCritical ? 503 : 200).json({
          ok: !auroraStartupCritical,
          api_mode: apiMode,
          aurora_routes_ready: auroraRoutesReady,
          aurora_routes_fail_closed: auroraRoutesFailClosed,
          aurora_routes_error: auroraRoutesLoadError,
          required_routes_ok:
            requiredRoutesHealth && Object.prototype.hasOwnProperty.call(requiredRoutesHealth, 'ok')
              ? Boolean(requiredRoutesHealth.ok)
              : null,
          missing_routes:
            requiredRoutesHealth && Array.isArray(requiredRoutesHealth.missing_routes)
              ? requiredRoutesHealth.missing_routes
              : [],
          version: {
            service: serviceName,
            commit: serviceGitShaShort,
            build_id: serviceBuildId,
            branch: serviceGitBranch || null,
            deployment_id: serviceDeploymentId || null,
            started_at: serviceStartedAt,
          },
          backend: {
            api_base: pivotaApiBase,
            aurora_proxy_search_api_base: proxySearchAuroraApiBase || null,
            api_key_configured: !!pivotaApiKey,
            db_configured: dbConfigured,
          },
          resolve_product_candidates_cache:
            typeof snapshotResolveProductCandidatesCacheStats === 'function'
              ? snapshotResolveProductCandidatesCacheStats()
              : null,
          resolve_product_group_cache:
            typeof snapshotResolveProductGroupCacheStats === 'function'
              ? snapshotResolveProductGroupCacheStats()
              : null,
          product_detail_cache:
            typeof snapshotProductDetailCacheStats === 'function'
              ? snapshotProductDetailCacheStats()
              : null,
          pdp_v2_core_hot_cache:
            typeof snapshotPdpV2CoreHotCacheStats === 'function'
              ? snapshotPdpV2CoreHotCacheStats()
              : null,
          pdp_recommendations_cache:
            typeof getPdpRecsCacheStats === 'function' ? getPdpRecsCacheStats() : null,
          products_available: true,
          startup_guards: {
            aurora_routes_critical: auroraStartupCritical,
          },
          warning: 'healthz_cache_stats_failed',
        });
      });
  };
}

module.exports = {
  createHealthRouteHandler,
};

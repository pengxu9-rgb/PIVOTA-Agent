const {
  firstQueryParamValue,
  parseQueryBoolean,
} = require('./searchQueryParams');

function normalizeCommerceSurface(raw, fallback = 'agent_api') {
  const value = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '_');
  if (!value) return fallback;
  if (
    value === 'agent_api' ||
    value === 'shopping_web' ||
    value === 'shopping_agent_ui' ||
    value === 'shopping_agent_web' ||
    value === 'creator_agent_ui' ||
    value === 'aurora' ||
    value === 'aurora_bff'
  ) {
    return value;
  }
  return fallback;
}

function normalizeExternalSeedStrategy(value, fallback = 'unified_relevance') {
  const token = String(value || '')
    .trim()
    .toLowerCase();
  if (
    token === 'legacy' ||
    token === 'unified_relevance' ||
    token === 'supplement_internal_first'
  ) {
    return token;
  }
  return fallback;
}

function isUnifiedLikeExternalSeedStrategy(value) {
  const normalized = normalizeExternalSeedStrategy(value, 'unified_relevance');
  return normalized === 'unified_relevance' || normalized === 'supplement_internal_first';
}

function createSearchGuardHelpers(config = {}) {
  const pivotaApiBase = String(
    config.pivotaApiBase || process.env.PIVOTA_API_BASE || 'http://localhost:8080',
  ).replace(/\/$/, '');
  const proxySearchAuroraApiBase = String(
    config.proxySearchAuroraApiBase ||
      process.env.PROXY_SEARCH_AURORA_API_BASE ||
      pivotaApiBase,
  ).replace(/\/$/, '');
  const proxySearchAuroraForceFastMode =
    config.proxySearchAuroraForceFastMode !== undefined
      ? config.proxySearchAuroraForceFastMode === true
      : String(process.env.PROXY_SEARCH_AURORA_FORCE_FAST_MODE || 'true').toLowerCase() !==
        'false';
  const proxySearchAuroraDisableSkipAfterResolverMiss =
    config.proxySearchAuroraDisableSkipAfterResolverMiss !== undefined
      ? config.proxySearchAuroraDisableSkipAfterResolverMiss === true
      : String(process.env.PROXY_SEARCH_AURORA_DISABLE_SKIP_AFTER_RESOLVER_MISS || 'true')
          .toLowerCase() !== 'false';
  const proxySearchAuroraForceSecondaryFallback =
    config.proxySearchAuroraForceSecondaryFallback !== undefined
      ? config.proxySearchAuroraForceSecondaryFallback === true
      : String(process.env.PROXY_SEARCH_AURORA_FORCE_SECONDARY_FALLBACK || 'true').toLowerCase() !==
        'false';
  const proxySearchAuroraForceInvokeFallback =
    config.proxySearchAuroraForceInvokeFallback !== undefined
      ? config.proxySearchAuroraForceInvokeFallback === true
      : String(process.env.PROXY_SEARCH_AURORA_FORCE_INVOKE_FALLBACK || 'true').toLowerCase() !==
        'false';
  const proxySearchAuroraAllowExternalSeed =
    config.proxySearchAuroraAllowExternalSeed !== undefined
      ? config.proxySearchAuroraAllowExternalSeed === true
      : String(process.env.PROXY_SEARCH_AURORA_ALLOW_EXTERNAL_SEED || 'true').toLowerCase() ===
        'true';
  const proxySearchAuroraExternalSeedStrategy = normalizeExternalSeedStrategy(
    config.proxySearchAuroraExternalSeedStrategy ||
      process.env.PROXY_SEARCH_AURORA_EXTERNAL_SEED_STRATEGY ||
      'supplement_internal_first',
    'supplement_internal_first',
  );

  function normalizeAgentSource(source) {
    return String(source || '')
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, '-')
      .replace(/-+/g, '-');
  }

  function isShoppingSource(source) {
    const normalized = normalizeAgentSource(source);
    return (
      normalized === 'shopping-agent' ||
      normalized === 'shopping-agent-ui' ||
      normalized === 'shopping-agent-web' ||
      normalized === 'shopping-web' ||
      normalized === 'agent-sdk-fixed-delegate'
    );
  }

  function isCreatorUiSource(source) {
    return normalizeAgentSource(source) === 'creator-agent-ui';
  }

  function isAuroraSource(source) {
    const normalized = normalizeAgentSource(source);
    return normalized === 'aurora-chatbox' || normalized === 'aurora-bff';
  }

  function isCatalogGuardSource(source) {
    const normalized = normalizeAgentSource(source);
    return (
      isShoppingSource(source) ||
      normalized === 'creator-agent' ||
      normalized === 'creator-agent-ui' ||
      (proxySearchAuroraForceFastMode && isAuroraSource(source))
    );
  }

  function isResolverFirstCatalogSource(source) {
    return isShoppingSource(source) || normalizeAgentSource(source) === 'creator-agent';
  }

  function getProxySearchApiBase(source) {
    if (isAuroraSource(source) && proxySearchAuroraApiBase) return proxySearchAuroraApiBase;
    return pivotaApiBase;
  }

  function getAuroraFallbackOverrides(source, operation) {
    const isAurora =
      isAuroraSource(source) && String(operation || '').trim() === 'find_products_multi';
    return {
      active: isAurora,
      strategySource: isAurora ? 'aurora_force_path' : 'default',
      disableSkipAfterResolverMiss:
        isAurora && proxySearchAuroraDisableSkipAfterResolverMiss,
      forceSecondaryFallback: isAurora && proxySearchAuroraForceSecondaryFallback,
      forceInvokeFallback: isAurora && proxySearchAuroraForceInvokeFallback,
    };
  }

  function applyShoppingCatalogQueryGuards(queryParams, source) {
    const params =
      queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
        ? { ...queryParams }
        : {};
    if (!isCatalogGuardSource(source)) return params;
    const auroraSource = isAuroraSource(source);
    const explicitCommerceSurface = normalizeCommerceSurface(
      firstQueryParamValue(
        params.commerce_surface ??
          params.commerceSurface ??
          params.catalog_surface ??
          params.catalogSurface,
      ),
      '',
    );
    const explicitAllowExternalSeed = parseQueryBoolean(
      params.allow_external_seed ?? params.allowExternalSeed,
    );
    const explicitFastMode = parseQueryBoolean(params.fast_mode ?? params.fastMode);
    const explicitExternalSeedStrategy = firstQueryParamValue(
      params.external_seed_strategy ?? params.externalSeedStrategy,
    );
    const allowExternalSeed =
      explicitAllowExternalSeed !== undefined
        ? explicitAllowExternalSeed
        : explicitCommerceSurface
          ? false
          : auroraSource
            ? proxySearchAuroraAllowExternalSeed
            : true;
    const defaultExternalSeedStrategy =
      allowExternalSeed === false
        ? 'legacy'
        : auroraSource
          ? proxySearchAuroraExternalSeedStrategy
          : 'supplement_internal_first';
    const externalSeedStrategy = normalizeExternalSeedStrategy(
      explicitExternalSeedStrategy || defaultExternalSeedStrategy,
      defaultExternalSeedStrategy,
    );
    return {
      ...params,
      allow_external_seed: allowExternalSeed,
      allow_stale_cache: false,
      external_seed_strategy: externalSeedStrategy,
      fast_mode: explicitFastMode !== undefined ? explicitFastMode : true,
    };
  }

  return {
    normalizeAgentSource,
    isShoppingSource,
    isCreatorUiSource,
    isCatalogGuardSource,
    isResolverFirstCatalogSource,
    isAuroraSource,
    getProxySearchApiBase,
    getAuroraFallbackOverrides,
    applyShoppingCatalogQueryGuards,
    normalizeExternalSeedStrategy,
    isUnifiedLikeExternalSeedStrategy,
  };
}

const defaultSearchGuards = createSearchGuardHelpers();

module.exports = {
  createSearchGuardHelpers,
  firstQueryParamValue,
  parseQueryBoolean,
  normalizeExternalSeedStrategy,
  isUnifiedLikeExternalSeedStrategy,
  ...defaultSearchGuards,
};

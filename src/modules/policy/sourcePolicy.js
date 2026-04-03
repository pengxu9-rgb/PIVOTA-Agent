const {
  normalizeSourceToken,
  isPublicSearchSource,
  isShoppingAgentSource,
  isAuroraSource,
} = require('../../api/gateway/sourceProfiles');

function normalizeExternalSeedStrategy(value, fallback = 'unified_relevance') {
  const token = String(value || '')
    .trim()
    .toLowerCase();
  if (token === 'supplement_internal_first') return 'unified_relevance';
  if (token === 'legacy' || token === 'unified_relevance') return token;
  return fallback;
}

function stripExternalSeedStrategyOverride(params = {}) {
  const next = { ...params };
  delete next.external_seed_strategy;
  delete next.externalSeedStrategy;
  return next;
}

function fallbackFirstQueryParamValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = String(item || '').trim();
      if (normalized) return normalized;
    }
    return '';
  }
  return String(value || '').trim();
}

function fallbackParseQueryBoolean(value) {
  const token = String(fallbackFirstQueryParamValue(value) || '')
    .trim()
    .toLowerCase();
  if (!token) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return undefined;
}

function createSourcePolicyRuntime(config = {}) {
  const parseQueryBoolean =
    typeof config.parseQueryBoolean === 'function'
      ? config.parseQueryBoolean
      : fallbackParseQueryBoolean;
  const firstQueryParamValue =
    typeof config.firstQueryParamValue === 'function'
      ? config.firstQueryParamValue
      : fallbackFirstQueryParamValue;
  const pivotaApiBase = config.pivotaApiBase || null;
  const auroraApiBase = config.auroraApiBase || null;
  const forceAuroraFastMode = Boolean(config.forceAuroraFastMode);
  const auroraAllowExternalSeed = Boolean(config.auroraAllowExternalSeed);
  const auroraExternalSeedStrategy = normalizeExternalSeedStrategy(
    config.auroraExternalSeedStrategy || 'unified_relevance',
    'unified_relevance',
  );
  const disableSkipAfterResolverMiss = Boolean(config.disableSkipAfterResolverMiss);
  const forceSecondaryFallback = Boolean(config.forceSecondaryFallback);
  const forceInvokeFallback = Boolean(config.forceInvokeFallback);

  function normalizeAgentSource(source) {
    return normalizeSourceToken(source);
  }

  function isShoppingSource(source) {
    return isShoppingAgentSource(source);
  }

  function isCreatorUiSource(source) {
    return normalizeAgentSource(source) === 'creator-agent-ui';
  }

  function isCatalogGuardSource(source) {
    const normalized = normalizeAgentSource(source);
    return (
      isShoppingSource(source) ||
      normalized === 'creator-agent' ||
      normalized === 'creator-agent-ui' ||
      (forceAuroraFastMode && isAuroraSource(source))
    );
  }

  function isResolverFirstCatalogSource(source) {
    return isShoppingSource(source) || normalizeAgentSource(source) === 'creator-agent';
  }

  function getProxySearchApiBase(source) {
    if (isAuroraSource(source) && auroraApiBase) return auroraApiBase;
    return pivotaApiBase;
  }

  function getAuroraFallbackOverrides(source, operation) {
    const active = isAuroraSource(source) && String(operation || '').trim() === 'find_products_multi';
    return {
      active,
      strategySource: active ? 'aurora_force_path' : 'default',
      disableSkipAfterResolverMiss: active && disableSkipAfterResolverMiss,
      forceSecondaryFallback: active && forceSecondaryFallback,
      forceInvokeFallback: active && forceInvokeFallback,
    };
  }

  function applyShoppingCatalogQueryGuards(queryParams, source) {
    const params =
      queryParams && typeof queryParams === 'object' && !Array.isArray(queryParams)
        ? { ...queryParams }
        : {};
    if (isPublicSearchSource(source)) return stripExternalSeedStrategyOverride(params);
    if (!isCatalogGuardSource(source)) return params;
    const auroraSource = isAuroraSource(source);
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
        : (auroraSource ? auroraAllowExternalSeed : true);
    const normalizedStrategy = normalizeExternalSeedStrategy(
      explicitExternalSeedStrategy ||
        (auroraSource ? auroraExternalSeedStrategy : 'supplement_internal_first'),
      auroraSource ? auroraExternalSeedStrategy : 'supplement_internal_first',
    );
    const externalSeedStrategy =
      isShoppingSource(source) || auroraSource
        ? normalizedStrategy
        : normalizedStrategy === 'unified_relevance'
          ? 'supplement_internal_first'
          : normalizedStrategy;
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
    isPublicSearchSource,
    getProxySearchApiBase,
    getAuroraFallbackOverrides,
    applyShoppingCatalogQueryGuards,
  };
}

function applyFindProductsMultiSourceContract(rawPayload, metadata = {}, operation = '') {
  if (String(operation || '').trim() !== 'find_products_multi') return rawPayload;
  if (!isPublicSearchSource(metadata?.source)) return rawPayload;
  const payload =
    rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
  const rawSearch =
    payload.search && typeof payload.search === 'object' && !Array.isArray(payload.search)
      ? payload.search
      : null;
  if (!rawSearch) return payload;
  const changed =
    Object.prototype.hasOwnProperty.call(rawSearch, 'external_seed_strategy') ||
    Object.prototype.hasOwnProperty.call(rawSearch, 'externalSeedStrategy');
  if (!changed) return payload;
  return {
    ...payload,
    search: stripExternalSeedStrategyOverride(rawSearch),
  };
}

module.exports = {
  normalizeExternalSeedStrategy,
  stripExternalSeedStrategyOverride,
  applyFindProductsMultiSourceContract,
  createSourcePolicyRuntime,
};

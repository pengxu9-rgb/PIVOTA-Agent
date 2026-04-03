'use strict';

function getEnv(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : '';
}

function normalizeProviderName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'gemini') return normalized;
  return '';
}

function uniqueProviders(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const normalized = normalizeProviderName(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function resolveFindProductsOpenAiApiKey() {
  return getEnv('OPENAI_API_KEY') || getEnv('LLM_API_KEY');
}

function resolveFindProductsGeminiApiKey() {
  return (
    getEnv('AURORA_RECO_GEMINI_API_KEY') ||
    getEnv('PIVOTA_GEMINI_API_KEY') ||
    getEnv('AURORA_SKIN_GEMINI_API_KEY') ||
    getEnv('GEMINI_API_KEY') ||
    getEnv('GOOGLE_API_KEY')
  );
}

function resolveFeatureEnvNames(feature = 'semantic_rewrite') {
  const normalized = String(feature || '').trim().toLowerCase();
  if (normalized === 'rerank') {
    return {
      featureEnabledEnv: 'FIND_PRODUCTS_MULTI_RERANK_LLM_ENABLED',
      featurePrimaryEnv: 'PIVOTA_RERANK_LLM_PROVIDER',
      featureFallbackEnv: 'PIVOTA_RERANK_LLM_FALLBACK_PROVIDER',
    };
  }
  return {
    featureEnabledEnv: 'PIVOTA_INTENT_LLM_ENABLED',
    featurePrimaryEnv: 'PIVOTA_INTENT_LLM_PROVIDER',
    featureFallbackEnv: 'PIVOTA_INTENT_LLM_FALLBACK_PROVIDER',
  };
}

function parseExplicitBoolean(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function resolveFindProductsLlmRuntime(feature = 'semantic_rewrite') {
  const {
    featureEnabledEnv,
    featurePrimaryEnv,
    featureFallbackEnv,
  } = resolveFeatureEnvNames(feature);
  const masterEnabled = parseExplicitBoolean(getEnv('FIND_PRODUCTS_MULTI_LLM_ENABLED'));
  const legacyFeatureEnabled = parseExplicitBoolean(getEnv(featureEnabledEnv));
  const openaiAvailable = Boolean(resolveFindProductsOpenAiApiKey());
  const geminiAvailable = Boolean(resolveFindProductsGeminiApiKey());
  const availableProviders = ['openai', 'gemini'].filter((provider) =>
    provider === 'openai' ? openaiAvailable : geminiAvailable,
  );

  if (masterEnabled === false) {
    return {
      feature,
      enabled: false,
      disabledReason: 'master_disabled',
      enableOwner: 'FIND_PRODUCTS_MULTI_LLM_ENABLED',
      availableProviders,
      primaryProvider: null,
      fallbackProvider: null,
      providerChain: [],
      providerOwner: null,
      fallbackOwner: null,
      legacyFeatureGateIgnored: legacyFeatureEnabled != null ? featureEnabledEnv : null,
      legacyFeatureGateValue: legacyFeatureEnabled,
    };
  }

  if (!availableProviders.length) {
    return {
      feature,
      enabled: false,
      disabledReason: 'no_provider_configured',
      enableOwner: masterEnabled != null ? 'FIND_PRODUCTS_MULTI_LLM_ENABLED' : 'provider_auto_enable',
      availableProviders,
      primaryProvider: null,
      fallbackProvider: null,
      providerChain: [],
      providerOwner: null,
      fallbackOwner: null,
      legacyFeatureGateIgnored: legacyFeatureEnabled != null ? featureEnabledEnv : null,
      legacyFeatureGateValue: legacyFeatureEnabled,
    };
  }

  const masterPrimary = normalizeProviderName(getEnv('FIND_PRODUCTS_MULTI_LLM_PROVIDER'));
  const featurePrimary = normalizeProviderName(getEnv(featurePrimaryEnv));
  const masterFallback = normalizeProviderName(getEnv('FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER'));
  const featureFallback = normalizeProviderName(getEnv(featureFallbackEnv));
  const inferredPrimary = openaiAvailable ? 'openai' : 'gemini';
  const primaryProvider = uniqueProviders([
    masterPrimary,
    featurePrimary,
    inferredPrimary,
    'openai',
    'gemini',
  ]).find((provider) => availableProviders.includes(provider)) || availableProviders[0];
  const fallbackProvider = uniqueProviders([
    masterFallback,
    featureFallback,
    primaryProvider === 'openai' ? 'gemini' : 'openai',
  ]).find((provider) => provider !== primaryProvider && availableProviders.includes(provider)) || null;
  const providerChain = [primaryProvider, ...(fallbackProvider ? [fallbackProvider] : [])];

  return {
    feature,
    enabled: true,
    disabledReason: null,
    enableOwner: masterEnabled != null ? 'FIND_PRODUCTS_MULTI_LLM_ENABLED' : 'provider_auto_enable',
    availableProviders,
    primaryProvider,
    fallbackProvider,
    providerChain,
    providerOwner: masterPrimary ? 'FIND_PRODUCTS_MULTI_LLM_PROVIDER' : featurePrimary ? featurePrimaryEnv : 'provider_auto_select',
    fallbackOwner: masterFallback
      ? 'FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER'
      : featureFallback
        ? featureFallbackEnv
        : fallbackProvider
          ? 'provider_auto_select'
          : null,
    legacyFeatureGateIgnored: legacyFeatureEnabled != null ? featureEnabledEnv : null,
    legacyFeatureGateValue: legacyFeatureEnabled,
  };
}

module.exports = {
  getEnv,
  normalizeProviderName,
  resolveFindProductsGeminiApiKey,
  resolveFindProductsLlmRuntime,
  resolveFindProductsOpenAiApiKey,
};

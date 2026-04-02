'use strict';

const AURORA_MODEL_POLICY_VERSION = 'aurora_model_policy_v1';

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeAuroraLlmProvider(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'gemini' || token === 'openai') return token;
  return null;
}

function normalizeAuroraLlmModel(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  return token.slice(0, 120);
}

function isAuroraBlockedMainlineModel(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return false;
  return /^gemini[-_. ]?2(\b|[-_. ])/i.test(token);
}

function classifyAuroraGeminiRouteGroup(route = '') {
  const token = String(route || '').trim().toLowerCase();
  if (!token) return 'unknown';
  if (token.includes('aurora_concern') || token.includes('aurora_mainline') || token.includes('aurora_reco')) {
    return 'aurora_mainline';
  }
  if (token.includes('diag') || token.includes('verify') || token.includes('ensemble')) {
    return 'diagnosis_verify_ensemble';
  }
  if (token.includes('layer1')) return 'layer1_clients';
  if (token.includes('async') || token.includes('background') || token.includes('job')) {
    return 'async_background';
  }
  return 'other';
}

function shouldAllowAuroraPublicLlmOverride({ productionLike = false } = {}) {
  return productionLike !== true;
}

function resolveAuroraGeminiMainlineModel({
  configuredModel = '',
  fallbackModel = 'gemini-3-flash-preview',
  envSource = 'aurora_mainline_default',
  callPath = 'aurora_mainline',
} = {}) {
  const requestedModel = normalizeAuroraLlmModel(configuredModel) || normalizeAuroraLlmModel(fallbackModel);
  return {
    requested_model: requestedModel,
    effective_model: requestedModel,
    selection_source: normalizeAuroraLlmModel(configuredModel) ? 'explicit_config' : 'default_fallback',
    env_source: String(envSource || '').trim() || 'aurora_mainline_default',
    call_path: String(callPath || '').trim() || 'aurora_mainline',
    policy_version: AURORA_MODEL_POLICY_VERSION,
  };
}

function resolveAuroraPublicLlmRoute({
  requestedProvider = null,
  requestedModel = null,
  headerProvider = null,
  headerModel = null,
  defaultProvider = null,
  defaultModel = null,
  productionLike = false,
} = {}) {
  const allowExternalOverride = shouldAllowAuroraPublicLlmOverride({ productionLike });
  const llmProvider =
    (allowExternalOverride ? normalizeAuroraLlmProvider(requestedProvider) : null) ||
    (allowExternalOverride ? normalizeAuroraLlmProvider(headerProvider) : null) ||
    normalizeAuroraLlmProvider(defaultProvider) ||
    null;
  const llmModel =
    (allowExternalOverride ? normalizeAuroraLlmModel(requestedModel) : null) ||
    (allowExternalOverride ? normalizeAuroraLlmModel(headerModel) : null) ||
    normalizeAuroraLlmModel(defaultModel) ||
    null;
  return {
    llm_provider: llmProvider,
    llm_model: llmModel,
    override_allowed: allowExternalOverride,
    selection_source: allowExternalOverride
      ? (
        pickFirstTrimmed(requestedProvider, requestedModel) ? 'body_override'
          : pickFirstTrimmed(headerProvider, headerModel) ? 'header_override'
            : pickFirstTrimmed(defaultProvider, defaultModel) ? 'configured_default'
              : 'none'
      )
      : pickFirstTrimmed(defaultProvider, defaultModel) ? 'configured_default' : 'policy_blocked',
    policy_version: AURORA_MODEL_POLICY_VERSION,
  };
}

function validateAuroraModelSelection({
  requestedProvider = null,
  requestedModel = null,
  effectiveProvider = null,
  effectiveModel = null,
  selectionSource = 'unknown',
} = {}) {
  const requestedProviderToken = normalizeAuroraLlmProvider(requestedProvider);
  const requestedModelToken = normalizeAuroraLlmModel(requestedModel);
  const effectiveProviderToken = normalizeAuroraLlmProvider(effectiveProvider);
  const effectiveModelToken = normalizeAuroraLlmModel(effectiveModel);
  const providerMismatch =
    requestedProviderToken && effectiveProviderToken && requestedProviderToken !== effectiveProviderToken;
  const modelMismatch =
    requestedModelToken && effectiveModelToken && requestedModelToken !== effectiveModelToken;
  if (providerMismatch || modelMismatch) {
    return {
      ok: false,
      policy_violation: true,
      selection_source: 'policy_violation_blocked',
      requested_provider: requestedProviderToken,
      requested_model: requestedModelToken,
      effective_provider: effectiveProviderToken,
      effective_model: effectiveModelToken,
      original_selection_source: String(selectionSource || '').trim() || 'unknown',
      policy_version: AURORA_MODEL_POLICY_VERSION,
    };
  }
  return {
    ok: true,
    policy_violation: false,
    selection_source: String(selectionSource || '').trim() || 'explicit_config',
    requested_provider: requestedProviderToken,
    requested_model: requestedModelToken,
    effective_provider: effectiveProviderToken || requestedProviderToken,
    effective_model: effectiveModelToken || requestedModelToken,
    policy_version: AURORA_MODEL_POLICY_VERSION,
  };
}

function validateAuroraMainlineModelSelection({
  requestedProvider = null,
  requestedModel = null,
  effectiveProvider = null,
  effectiveModel = null,
  selectionSource = 'unknown',
  route = '',
} = {}) {
  const base = validateAuroraModelSelection({
    requestedProvider,
    requestedModel,
    effectiveProvider,
    effectiveModel,
    selectionSource,
  });
  const routeGroup = classifyAuroraGeminiRouteGroup(route);
  if (!base.ok) {
    return {
      ...base,
      route: String(route || '').trim() || null,
      route_group: routeGroup,
    };
  }
  if (isAuroraBlockedMainlineModel(base.effective_model)) {
    return {
      ...base,
      ok: false,
      policy_violation: true,
      policy_violation_reason: 'blocked_model_family',
      selection_source: 'policy_violation_blocked',
      route: String(route || '').trim() || null,
      route_group: routeGroup,
    };
  }
  return {
    ...base,
    route: String(route || '').trim() || null,
    route_group: routeGroup,
  };
}

module.exports = {
  AURORA_MODEL_POLICY_VERSION,
  normalizeAuroraLlmProvider,
  normalizeAuroraLlmModel,
  isAuroraBlockedMainlineModel,
  classifyAuroraGeminiRouteGroup,
  shouldAllowAuroraPublicLlmOverride,
  resolveAuroraGeminiMainlineModel,
  resolveAuroraPublicLlmRoute,
  validateAuroraModelSelection,
  validateAuroraMainlineModelSelection,
};

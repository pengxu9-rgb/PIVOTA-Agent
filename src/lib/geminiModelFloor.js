'use strict';

const TEMPORARY_UNIFIED_GEMINI_MODEL = 'gemini-2.5-flash';
const TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL = 'gemini-2.5-flash';
const LEGACY_GEMINI_FLASH_PREVIEW_ALIAS = 'gemini-2.5-flash-preview';
const LEGACY_GEMINI_FLASH_PREVIEW_RUNTIME_MODEL = 'gemini-2.5-flash-preview-09-2025';
const NON_IMAGE_GEMINI_FLOOR_MODEL = TEMPORARY_UNIFIED_GEMINI_MODEL;
const warnedAdjustments = new Set();

function normalizeGeminiModelName(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
}

function resolveGeminiRuntimeModelName(model) {
  const normalized = normalizeGeminiModelName(model);
  if (
    normalized === LEGACY_GEMINI_FLASH_PREVIEW_ALIAS ||
    normalized === LEGACY_GEMINI_FLASH_PREVIEW_RUNTIME_MODEL
  ) {
    return TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL;
  }
  if (normalized === TEMPORARY_UNIFIED_GEMINI_MODEL) return TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL;
  return normalized;
}

function uniqueNonEmptyStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeGeminiModelName(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function resolveGeminiRuntimeModelCandidates(model) {
  return uniqueNonEmptyStrings([resolveGeminiRuntimeModelName(model)]);
}

function isGeminiModelName(model) {
  const normalized = normalizeGeminiModelName(model).toLowerCase();
  return normalized.startsWith('gemini-');
}

function isGeminiImageGenerationModel(model) {
  const normalized = normalizeGeminiModelName(model).toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('imagen-')) return true;
  return normalized.includes('image-generation') || normalized.includes('-image-preview');
}

function isGeminiAtOrAboveNonImageFloor(model) {
  const normalized = normalizeGeminiModelName(model).toLowerCase();
  if (!normalized || !isGeminiModelName(normalized)) return false;
  if (isGeminiImageGenerationModel(normalized)) return false;
  const match = normalized.match(/^gemini-(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1] || 0);
  const minor = Number(match[2] || 0);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 2 || (major === 2 && minor >= 5);
}

function isExplicitFalse(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function isExplicitTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isProductionLikeRuntime() {
  const values = [
    process.env.NODE_ENV,
    process.env.PIVOTA_ENV,
    process.env.APP_ENV,
    process.env.RAILWAY_ENVIRONMENT,
    process.env.RAILWAY_ENVIRONMENT_NAME,
  ];
  return values.some((value) => {
    const token = String(value || '').trim().toLowerCase();
    return token === 'production' || token === 'prod';
  });
}

function isTemporaryUnifiedGeminiModelEnabled() {
  const raw = process.env.PIVOTA_GEMINI_UNIFIED_MODEL_ENABLED || process.env.PIVOTA_TEMP_GEMINI_25_FLASH_ENABLED;
  if (isExplicitFalse(raw)) return false;
  if (isExplicitTrue(raw)) return true;
  return isProductionLikeRuntime();
}

function resolveTemporaryUnifiedGeminiModel() {
  const configured = normalizeGeminiModelName(
    process.env.PIVOTA_GEMINI_UNIFIED_MODEL || process.env.PIVOTA_TEMP_GEMINI_MODEL || TEMPORARY_UNIFIED_GEMINI_MODEL,
  );
  if (configured && isGeminiModelName(configured) && !isGeminiImageGenerationModel(configured)) {
    return resolveGeminiRuntimeModelName(configured);
  }
  return TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL;
}

function emitFloorWarning(detail) {
  const key = JSON.stringify(detail);
  if (warnedAdjustments.has(key)) return;
  warnedAdjustments.add(key);
  // eslint-disable-next-line no-console
  console.warn('[gemini-model-floor]', JSON.stringify(detail));
}

function resolveNonImageGeminiModel(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const configuredModel = normalizeGeminiModelName(opts.model);
  const fallbackModel = normalizeGeminiModelName(opts.fallbackModel) || NON_IMAGE_GEMINI_FLOOR_MODEL;
  let effectiveModel = resolveGeminiRuntimeModelName(configuredModel || fallbackModel);
  const envSource = String(opts.envSource || '').trim() || null;
  const callPath = String(opts.callPath || '').trim() || null;

  let isGemini = isGeminiModelName(effectiveModel);
  let isImageGeneration = isGeminiImageGenerationModel(effectiveModel);
  let adjusted = false;

  if (configuredModel && !isGeminiModelName(configuredModel)) {
    adjusted = true;
    effectiveModel = resolveGeminiRuntimeModelName(fallbackModel);
    isGemini = isGeminiModelName(effectiveModel);
    isImageGeneration = isGeminiImageGenerationModel(effectiveModel);
    emitFloorWarning({
      event: 'gemini_model_non_gemini_fallback',
      configured_model: configuredModel || null,
      effective_model: effectiveModel,
      env_source: envSource,
      call_path: callPath,
    });
  }

  if (isGemini && !isImageGeneration && isTemporaryUnifiedGeminiModelEnabled()) {
    const unifiedModel = resolveTemporaryUnifiedGeminiModel();
    if (effectiveModel !== unifiedModel) {
      adjusted = true;
      effectiveModel = unifiedModel;
      emitFloorWarning({
        event: 'gemini_temporary_unified_model_override',
        configured_model: configuredModel || null,
        effective_model: effectiveModel,
        env_source: envSource,
        call_path: callPath,
      });
    }
  } else if (isGemini && !isImageGeneration && !isGeminiAtOrAboveNonImageFloor(effectiveModel)) {
    adjusted = true;
    effectiveModel = resolveGeminiRuntimeModelName(NON_IMAGE_GEMINI_FLOOR_MODEL);
    emitFloorWarning({
      event: 'gemini_model_floor_autoupgrade',
      configured_model: configuredModel || null,
      effective_model: effectiveModel,
      env_source: envSource,
      call_path: callPath,
    });
  }

  return {
    configuredModel: configuredModel || null,
    effectiveModel,
    adjusted,
    envSource,
    callPath,
    isGemini: isGeminiModelName(effectiveModel),
    isImageGeneration: isGeminiImageGenerationModel(effectiveModel),
  };
}

function resetGeminiModelFloorWarningsForTest() {
  warnedAdjustments.clear();
}

module.exports = {
  TEMPORARY_UNIFIED_GEMINI_MODEL,
  TEMPORARY_UNIFIED_GEMINI_RUNTIME_MODEL,
  NON_IMAGE_GEMINI_FLOOR_MODEL,
  normalizeGeminiModelName,
  resolveGeminiRuntimeModelName,
  resolveGeminiRuntimeModelCandidates,
  isGeminiModelName,
  isGeminiImageGenerationModel,
  isGeminiAtOrAboveNonImageFloor,
  isTemporaryUnifiedGeminiModelEnabled,
  isProductionLikeRuntime,
  resolveTemporaryUnifiedGeminiModel,
  resolveNonImageGeminiModel,
  resetGeminiModelFloorWarningsForTest,
};

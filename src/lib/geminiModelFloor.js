'use strict';

const NON_IMAGE_GEMINI_FLOOR_MODEL = 'gemini-3-flash-preview';
const warnedAdjustments = new Set();

function normalizeGeminiModelName(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
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
  return Number.isFinite(major) && major >= 3;
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
  let effectiveModel = configuredModel || fallbackModel;
  const envSource = String(opts.envSource || '').trim() || null;
  const callPath = String(opts.callPath || '').trim() || null;

  const isGemini = isGeminiModelName(effectiveModel);
  const isImageGeneration = isGeminiImageGenerationModel(effectiveModel);
  let adjusted = false;

  if (isGemini && !isImageGeneration && !isGeminiAtOrAboveNonImageFloor(effectiveModel)) {
    adjusted = true;
    effectiveModel = NON_IMAGE_GEMINI_FLOOR_MODEL;
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
    isGemini,
    isImageGeneration,
  };
}

function resetGeminiModelFloorWarningsForTest() {
  warnedAdjustments.clear();
}

module.exports = {
  NON_IMAGE_GEMINI_FLOOR_MODEL,
  normalizeGeminiModelName,
  isGeminiModelName,
  isGeminiImageGenerationModel,
  isGeminiAtOrAboveNonImageFloor,
  resolveNonImageGeminiModel,
  resetGeminiModelFloorWarningsForTest,
};

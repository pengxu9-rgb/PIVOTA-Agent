const LAYER_TYPES = Object.freeze([
  'orchestration',
  'decisioning',
  'execution_facing',
]);

function normalizeLayerType(value, fallback = null) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (LAYER_TYPES.includes(normalized)) return normalized;
  return fallback;
}

function isLayerType(value) {
  return normalizeLayerType(value) !== null;
}

module.exports = {
  LAYER_TYPES,
  normalizeLayerType,
  isLayerType,
};

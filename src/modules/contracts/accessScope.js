const { normalizeLayerType } = require('./layerType');

const RESULT_DEPTHS = new Set(['summary_only', 'bounded_results', 'deep_resolution']);
const ALLOWED_SOURCES = new Set(['search', 'shopping_agent', 'aurora-bff']);

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function normalizeResultDepth(value, fallback = 'summary_only') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return RESULT_DEPTHS.has(normalized) ? normalized : fallback;
}

function buildAccessScope(input = {}) {
  return {
    allowed_layers: uniqueStrings(Array.isArray(input.allowed_layers) ? input.allowed_layers : [])
      .map((item) => normalizeLayerType(item))
      .filter(Boolean),
    allowed_sources: uniqueStrings(Array.isArray(input.allowed_sources) ? input.allowed_sources : [])
      .filter((item) => ALLOWED_SOURCES.has(item)),
    allow_execution_handoff: input.allow_execution_handoff !== false,
    allow_checkout_handoff: input.allow_checkout_handoff === true,
    merchant_allowlist: uniqueStrings(input.merchant_allowlist || []),
    category_allowlist: uniqueStrings(input.category_allowlist || []),
    result_depth: normalizeResultDepth(input.result_depth, 'summary_only'),
    max_results_per_request: normalizePositiveInteger(input.max_results_per_request, 10),
    max_pages: normalizePositiveInteger(input.max_pages, 1),
    max_variant_expansions: normalizePositiveInteger(input.max_variant_expansions, 0),
    allow_deep_offer_fields: input.allow_deep_offer_fields === true,
  };
}

function cloneAccessScope(scope) {
  return buildAccessScope(scope || {});
}

module.exports = {
  buildAccessScope,
  cloneAccessScope,
  normalizeResultDepth,
};

// Read-through layer for catalog_products fashion fields
// (material / care / size_guide + per-field provenance).
//
// Why this exists:
//   The gateway's PDP detail path reads from products_cache, which only
//   stores the raw Shopify payload. catalog_products is the source of
//   truth for fashion fields populated by Python-side extractors (LLM,
//   regex, variant-aggregate, manual admin override). Without a
//   read-through, those fields never reach the rendered PDP unless a
//   bridge script writes them back into products_cache — which races
//   against the next Shopify sync that overwrites the whole
//   products_cache row.
//
// Design:
//   - One small SELECT per (merchant_id, source_product_id) lookup,
//     indexed by idx_catalog_products_source_identity (existing).
//   - In-memory LRU cache, ~5-min TTL — catalog_products fashion
//     fields change slowly (after sync or admin edit), and the gateway
//     processes hot PDPs many times per minute. A 5-min staleness on
//     a fashion description is acceptable; the alternative (every
//     read hits PostgreSQL) is unnecessary load.
//   - Pure read-through: returns a provenance-tagged fashion_meta
//     blob that pdpBuilder.buildPdpPayload can merge into the
//     product dict without any further extractor work.

const { query } = require('../db');

const _cache = new Map(); // key → { value, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const CACHE_MAX = 5000;

function _cacheKey(merchantId, sourceProductId) {
  return `${merchantId || ''}::${sourceProductId || ''}`;
}

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX) {
    // Cheap-ish eviction: drop the first entry. Good enough for a
    // size-capped LRU-ish cache — the gateway re-fetches when an entry
    // is missed.
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _invalidateCache() {
  _cache.clear();
}

function _looksProvenanceShape(meta) {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    && typeof meta.value === 'string' && meta.value.length > 0;
}

function _buildProvField(value, source, confidence) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const out = { value: value.trim() };
  if (typeof source === 'string' && source.trim()) out.source = source.trim();
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    out.confidence = confidence;
  }
  return out;
}

function _buildSizeGuideField(rawValue, source, confidence) {
  // size_guide is JSONB; the column holds either {raw: str} (current
  // shape from the regex/LLM extractor wrapping) or a structured
  // {columns, rows, ...} dict (future). pdpBuilder consumes size_fit_chart
  // as an object — so we pass it through unchanged.
  if (rawValue == null) return null;
  let parsed = rawValue;
  if (typeof rawValue === 'string') {
    try { parsed = JSON.parse(rawValue); } catch { parsed = { raw: rawValue }; }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed; // size_fit_chart is plain object — provenance lives on neighboring fields
}

/**
 * Read fashion fields for a single product from catalog_products.
 * Returns a fashion_meta-shaped dict ({material?, care?, size_fit_chart?})
 * or null when the row has no populated fashion data.
 *
 * Cached for ~5 min. Pass `bypassCache:true` to force re-read.
 */
async function readFashionFieldsByProductRef({ merchantId, sourceProductId, bypassCache = false } = {}) {
  const merchant = String(merchantId || '').trim();
  const source = String(sourceProductId || '').trim();
  if (!merchant || !source) return null;
  const key = _cacheKey(merchant, source);
  if (!bypassCache) {
    const cached = _cacheGet(key);
    if (cached !== undefined) return cached;
  }

  let row = null;
  try {
    const result = await query(
      `SELECT material, material_source, material_confidence,
              care, care_source, care_confidence,
              size_guide, size_guide_source, size_guide_confidence
         FROM catalog_products
        WHERE merchant_id = $1
          AND platform = 'shopify'
          AND source_product_id = $2
        LIMIT 1`,
      [merchant, source],
    );
    row = result?.rows?.[0] || null;
  } catch (_err) {
    // Failure isolation: catalog_products may not have the columns yet
    // (older deploy), or DB may be unavailable. Returning null lets the
    // gateway render PDP without fashion_meta rather than 500ing.
    _cacheSet(key, null);
    return null;
  }
  if (!row) {
    _cacheSet(key, null);
    return null;
  }
  const out = {};
  const material = _buildProvField(row.material, row.material_source, row.material_confidence);
  if (material) out.material = material;
  const care = _buildProvField(row.care, row.care_source, row.care_confidence);
  if (care) out.care = care;
  const sizeGuide = _buildSizeGuideField(row.size_guide, row.size_guide_source, row.size_guide_confidence);
  if (sizeGuide) out.size_fit_chart = sizeGuide;
  const value = Object.keys(out).length ? out : null;
  _cacheSet(key, value);
  return value;
}

/**
 * Merge catalog_products fashion fields into a product dict's
 * fashion_meta. Upstream values (already on product.fashion_meta) win;
 * catalog_products fills in gaps. Mutates + returns the product for
 * caller convenience.
 *
 * No-op when sourceProductId is missing (caller must pass the
 * Shopify product_id, not a sig_*).
 */
async function enrichProductWithCatalogFashionFields(product, { merchantId, sourceProductId, bypassCache = false } = {}) {
  if (!product || typeof product !== 'object') return product;
  const fromCatalog = await readFashionFieldsByProductRef({ merchantId, sourceProductId, bypassCache });
  if (!fromCatalog) return product;
  const existing = product.fashion_meta && typeof product.fashion_meta === 'object'
    ? product.fashion_meta
    : {};
  const merged = { ...existing };
  for (const k of ['material', 'care']) {
    if (!_looksProvenanceShape(merged[k]) && typeof merged[k] !== 'string' && fromCatalog[k]) {
      merged[k] = fromCatalog[k];
    }
  }
  if (!merged.size_fit_chart && fromCatalog.size_fit_chart) {
    merged.size_fit_chart = fromCatalog.size_fit_chart;
  }
  product.fashion_meta = Object.keys(merged).length ? merged : product.fashion_meta;
  return product;
}

module.exports = {
  readFashionFieldsByProductRef,
  enrichProductWithCatalogFashionFields,
  // exposed for tests
  __test: { _cacheKey, _cacheGet, _cacheSet, _invalidateCache, CACHE_TTL_MS },
};

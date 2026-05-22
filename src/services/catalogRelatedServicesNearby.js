// Read-through layer for related nearby service providers on beauty PDPs.
//
// Stage 1 is intentionally narrow: when a beauty category maps to one or
// more service types, surface matching scraped providers in Seoul/Gangnam-gu.
// The PDP path must never depend on this enrichment succeeding.

const { query } = require('../db');
const logger = require('../logger');

const _cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const CACHE_MAX = 5000;
const PILOT_SCOPE = { city: 'Seoul', region: 'Gangnam-gu', country_code: 'KR' };
const PROVIDER_LIMIT = 6;
const LISTING_LIMIT = 5;

function _cacheKey(categoryPath) {
  return String(categoryPath || '').trim();
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
    // size-capped LRU-ish cache; a miss will re-fetch from PostgreSQL.
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _invalidateCache() {
  _cache.clear();
}

function _asNonEmptyString(value) {
  const out = String(value || '').trim();
  return out || '';
}

function _normalizeCategoryPath(value) {
  if (Array.isArray(value)) {
    return value.map(_asNonEmptyString).filter(Boolean).join('/');
  }
  return _asNonEmptyString(value);
}

function _isBeautyCategoryPath(categoryPath) {
  return _normalizeCategoryPath(categoryPath).toLowerCase().startsWith('beauty');
}

function _normalizeServiceTypes(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (_err) {
      raw = [raw];
    }
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const serviceType = _asNonEmptyString(item);
    if (!serviceType || seen.has(serviceType)) continue;
    seen.add(serviceType);
    out.push(serviceType);
  }
  return out;
}

function _parseJsonObject(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (_err) {
      return null;
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

function _parseJsonArray(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (_err) {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

function _normalizeNullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function _normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _normalizeNullableBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function _normalizeProviderUrl(value) {
  if (typeof value === 'string') return _asNonEmptyString(value) || null;
  if (value && typeof value === 'object') {
    return _asNonEmptyString(value.url || value.href || value.value) || null;
  }
  return null;
}

function _composeAddress(row = {}) {
  const a1 = _asNonEmptyString(row.address_line1);
  const city = _asNonEmptyString(row.city);
  const region = _asNonEmptyString(row.region);
  const cc = _asNonEmptyString(row.country_code);
  const a1Lower = a1.toLowerCase();
  const parts = [];
  if (a1) parts.push(a1);
  if (city && !a1Lower.includes(city.toLowerCase())) parts.push(city);
  if (region && !a1Lower.includes(region.toLowerCase())) parts.push(region);
  if (cc) parts.push(cc);
  return parts.filter(Boolean).join(', ');
}

function _normalizeListings(value) {
  return _parseJsonArray(value)
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      index,
      listing: {
        service_type: _asNonEmptyString(item.service_type) || null,
        title: _asNonEmptyString(item.title) || null,
        price_cents: _normalizeNullableInteger(item.price_cents),
        currency: _asNonEmptyString(item.currency) || null,
        duration_minutes: _normalizeNullableInteger(item.duration_minutes),
        requires_consult: _normalizeNullableBoolean(item.requires_consult),
      },
    }))
    .sort((a, b) => {
      const aNull = a.listing.price_cents === null;
      const bNull = b.listing.price_cents === null;
      if (aNull !== bNull) return aNull ? 1 : -1;
      if (a.listing.price_cents !== b.listing.price_cents) {
        return (a.listing.price_cents || 0) - (b.listing.price_cents || 0);
      }
      return a.index - b.index;
    })
    .map((item) => item.listing);
}

function _englishFriendlyRank(signal) {
  const normalized = _asNonEmptyString(signal).toLowerCase();
  if (normalized === 'explicit') return 0;
  if (normalized === 'inferred') return 1;
  return 2;
}

function _buildProvider(row) {
  const listings = _normalizeListings(row?.matching_listings);
  if (!listings.length) return null;
  const displayName = _asNonEmptyString(row.display_name || row.name || row.provider_id);
  const name = _asNonEmptyString(row.name || displayName);
  return {
    provider_id: _asNonEmptyString(row.provider_id) || null,
    name: name || displayName || null,
    display_name: displayName || name || null,
    address: _composeAddress(row) || null,
    url: _normalizeProviderUrl(row.provider_url),
    english_friendly_signal: _asNonEmptyString(row.english_friendly_signal) || null,
    english_friendly_evidence: _asNonEmptyString(row.english_friendly_evidence) || null,
    tourist_metadata: _parseJsonObject(row.tourist_metadata),
    rating: _normalizeNullableNumber(row.rating),
    rating_count: _normalizeNullableInteger(row.rating_count),
    matching_listings_count: listings.length,
    matching_listings: listings.slice(0, LISTING_LIMIT),
  };
}

function _buildModuleData({ categoryPath, serviceTypes, providerRows }) {
  const providers = (providerRows || [])
    .map(_buildProvider)
    .filter(Boolean)
    .sort((a, b) => {
      const rankDelta =
        _englishFriendlyRank(a.english_friendly_signal) -
        _englishFriendlyRank(b.english_friendly_signal);
      if (rankDelta !== 0) return rankDelta;
      return b.matching_listings_count - a.matching_listings_count;
    })
    .slice(0, PROVIDER_LIMIT);
  if (!providers.length) return null;
  return {
    category_path: categoryPath,
    service_types: serviceTypes,
    scope: { ...PILOT_SCOPE },
    providers,
  };
}

async function readRelatedServicesNearbyByCategoryPath(categoryPath, { bypassCache = false } = {}) {
  const resolvedCategoryPath = _normalizeCategoryPath(categoryPath);
  if (!resolvedCategoryPath) return null;
  const key = _cacheKey(resolvedCategoryPath);
  if (!bypassCache) {
    const cached = _cacheGet(key);
    if (cached !== undefined) return cached;
  }

  try {
    const taxonomyResult = await query(
      `SELECT service_types, confidence
         FROM product_to_service_taxonomy
        WHERE product_category_path = $1 AND active
        ORDER BY confidence DESC
        LIMIT 1`,
      [resolvedCategoryPath],
    );
    const taxonomyRow = taxonomyResult?.rows?.[0] || null;
    const serviceTypes = _normalizeServiceTypes(taxonomyRow?.service_types);
    if (!taxonomyRow || !serviceTypes.length) {
      _cacheSet(key, null);
      return null;
    }

    const providersResult = await query(
      `SELECT
          sp.provider_id, sp.display_name, sp.name,
          sp.address_line1, sp.city, sp.region, sp.country_code,
          sp.metadata->>'english_friendly_signal' AS english_friendly_signal,
          sp.metadata->>'english_friendly_evidence' AS english_friendly_evidence,
          sp.metadata->'tourist_metadata' AS tourist_metadata,
          sp.metadata->>'final_url' AS provider_url,
          sp.rating, sp.rating_count,
          jsonb_agg(
            jsonb_build_object(
              'service_type', sl.service_type,
              'title', sl.title,
              'price_cents', sl.price_cents,
              'currency', sl.currency,
              'duration_minutes', sl.duration_minutes,
              'requires_consult', sl.requires_consult
            )
            ORDER BY (sl.price_cents IS NULL), sl.price_cents
          ) AS matching_listings
         FROM service_providers sp
         JOIN service_listings sl ON sl.provider_id = sp.provider_id
        WHERE sp.source = 'scrape'
          AND sp.country_code = 'KR'
          AND sp.region = 'Gangnam-gu'
          AND sp.status IN ('candidate', 'live')
          AND sl.status = 'active'
          AND sl.service_type = ANY($1::text[])
        GROUP BY sp.provider_id
        ORDER BY
          CASE sp.metadata->>'english_friendly_signal'
            WHEN 'explicit' THEN 0
            WHEN 'inferred' THEN 1
            ELSE 2
          END,
          COUNT(sl.listing_id) DESC
        LIMIT 6`,
      [serviceTypes],
    );
    const value = _buildModuleData({
      categoryPath: resolvedCategoryPath,
      serviceTypes,
      providerRows: providersResult?.rows || [],
    });
    _cacheSet(key, value);
    return value;
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err), category_path: resolvedCategoryPath },
      'catalog related services nearby lookup failed; PDP renders without related services',
    );
    _cacheSet(key, null);
    return null;
  }
}

async function enrichProductWithRelatedServices(product, { bypassCache = false } = {}) {
  try {
    if (!product || typeof product !== 'object') return product;
    if (process.env.SERVICES_NEARBY_ENABLED !== 'true') return product;
    const categoryPath = _normalizeCategoryPath(product.category_path);
    if (!categoryPath || !_isBeautyCategoryPath(categoryPath)) return product;
    const relatedServices = await readRelatedServicesNearbyByCategoryPath(categoryPath, { bypassCache });
    if (!relatedServices) return product;
    product._related_services_nearby = relatedServices;
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err) },
      'enrichProductWithRelatedServices failed; PDP renders without related services',
    );
  }
  return product;
}

module.exports = {
  readRelatedServicesNearbyByCategoryPath,
  enrichProductWithRelatedServices,
  // exposed for tests
  __test: {
    _cacheKey,
    _cacheGet,
    _cacheSet,
    _invalidateCache,
    _normalizeCategoryPath,
    _composeAddress,
    _normalizeListings,
    _buildModuleData,
    CACHE_TTL_MS,
  },
};

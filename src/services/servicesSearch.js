const { query } = require('../db');

const _cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 5000;
const DEFAULT_SCOPE = Object.freeze({ city: 'Seoul', region: 'Gangnam-gu', country_code: 'KR' });
const DEFAULT_LIMIT = 20;
const DEFAULT_OFFSET = 0;
const MAX_LIMIT = 50;
const PREVIEW_LISTING_LIMIT = 3;
const SERVICE_TYPE_ALLOW_LIST = Object.freeze([
  'nails',
  'gel-nails',
  'nail-art',
  'lashes',
  'facial',
  'chemical-peel',
  'dermatology-clinic',
  'skin-care',
  'massage',
  'body-care',
  'hair-cut',
  'hair-color',
  'hair-perm',
  'hair-treatment',
  'scalp-care',
  'makeup',
  'bridal-makeup',
  'waxing',
  'eyebrow-tattoo',
]);
const SERVICE_TYPE_SET = new Set(SERVICE_TYPE_ALLOW_LIST);

class ServicesSearchValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServicesSearchValidationError';
    this.code = 'SERVICES_SEARCH_VALIDATION';
    this.statusCode = 400;
  }
}

function _cacheKey(params) {
  return JSON.stringify([
    params.q,
    params.service_type,
    params.city,
    params.region,
    params.country_code,
    params.english_friendly,
    params.priced_only,
    params.max_price_won,
    params.limit,
    params.offset,
  ]);
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
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _invalidateCache() {
  _cache.clear();
}

function _singleQueryValue(raw, name) {
  if (Array.isArray(raw)) {
    throw new ServicesSearchValidationError(`${name} must be provided at most once`);
  }
  if (raw && typeof raw === 'object') {
    throw new ServicesSearchValidationError(`${name} must be a scalar value`);
  }
  return raw;
}

function _normalizeText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _normalizeOptionalQuery(raw) {
  const value = _singleQueryValue(raw, 'q');
  if (value === undefined || value === null) return null;
  const normalized = _normalizeText(value);
  if (!normalized) return null;
  if (normalized.length > 120) {
    throw new ServicesSearchValidationError('q must be 120 characters or fewer');
  }
  return normalized;
}

function _normalizeOptionalServiceType(raw) {
  const value = _singleQueryValue(raw, 'service_type');
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!SERVICE_TYPE_SET.has(normalized)) {
    throw new ServicesSearchValidationError(
      `service_type must be one of: ${SERVICE_TYPE_ALLOW_LIST.join(', ')}`,
    );
  }
  return normalized;
}

function _normalizeScopeString(raw, name, defaultValue, maxLength) {
  const value = _singleQueryValue(raw, name);
  if (value === undefined || value === null) return defaultValue;
  const normalized = _normalizeText(value);
  if (!normalized) {
    throw new ServicesSearchValidationError(`${name} must be a non-empty string`);
  }
  if (normalized.length > maxLength) {
    throw new ServicesSearchValidationError(`${name} must be ${maxLength} characters or fewer`);
  }
  return name === 'country_code' ? normalized.toUpperCase() : normalized;
}

function _normalizeBoolean(raw, name) {
  const value = _singleQueryValue(raw, name);
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new ServicesSearchValidationError(`${name} must be "true" or "false"`);
}

function _normalizeInteger(raw, name, { defaultValue = null, min = null, max = null } = {}) {
  const value = _singleQueryValue(raw, name);
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) {
    throw new ServicesSearchValidationError(`${name} must be an integer`);
  }
  if (min !== null && n < min) {
    throw new ServicesSearchValidationError(`${name} must be >= ${min}`);
  }
  if (max !== null && n > max) {
    throw new ServicesSearchValidationError(`${name} must be <= ${max}`);
  }
  return n;
}

function normalizeServicesSearchParams(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    q: _normalizeOptionalQuery(input.q),
    service_type: _normalizeOptionalServiceType(input.service_type),
    city: _normalizeScopeString(input.city, 'city', DEFAULT_SCOPE.city, 80),
    region: _normalizeScopeString(input.region, 'region', DEFAULT_SCOPE.region, 80),
    country_code: _normalizeScopeString(input.country_code, 'country_code', DEFAULT_SCOPE.country_code, 3),
    english_friendly: _normalizeBoolean(input.english_friendly, 'english_friendly'),
    priced_only: _normalizeBoolean(input.priced_only, 'priced_only'),
    max_price_won: _normalizeInteger(input.max_price_won, 'max_price_won', { defaultValue: null, min: 0 }),
    limit: _normalizeInteger(input.limit, 'limit', { defaultValue: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT }),
    offset: _normalizeInteger(input.offset, 'offset', { defaultValue: DEFAULT_OFFSET, min: 0 }),
  };
}

function _buildIlikePattern(value) {
  return `%${value}%`;
}

function _buildFilter(params) {
  const values = [];
  const addParam = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  const cityRef = addParam(params.city);
  const regionRef = addParam(params.region);
  const countryRef = addParam(params.country_code);
  const clauses = [
    "sp.source = 'scrape'",
    "sp.status IN ('candidate', 'live')",
    "sl.status = 'active'",
    `sp.city = ${cityRef}`,
    `sp.region = ${regionRef}`,
    `sp.country_code = ${countryRef}`,
  ];
  let qRef = null;

  if (params.service_type) {
    clauses.push(`sl.service_type = ${addParam(params.service_type)}`);
  }
  if (params.q) {
    qRef = addParam(_buildIlikePattern(params.q));
    clauses.push(`(
      COALESCE(sl.title, '') ILIKE ${qRef}
      OR COALESCE(sl.description, '') ILIKE ${qRef}
      OR COALESCE(sp.display_name, '') ILIKE ${qRef}
      OR COALESCE(sp.name, '') ILIKE ${qRef}
    )`);
  }
  if (params.english_friendly) {
    clauses.push("(sp.metadata->>'english_friendly_signal') IN ('explicit', 'inferred')");
  }
  if (params.priced_only) {
    clauses.push('sl.price_cents IS NOT NULL');
  }
  if (params.max_price_won !== null) {
    clauses.push(`sl.price_cents <= ${addParam(params.max_price_won)}`);
  }

  return {
    whereSql: clauses.join('\n          AND '),
    values,
    qRef,
  };
}

function _buildFilteredListingsCte(whereSql) {
  return `filtered_listings AS (
        SELECT
          sl.listing_id,
          sl.provider_id,
          sl.service_type,
          sl.title,
          sl.description,
          sl.price_cents,
          sl.currency,
          sl.duration_minutes,
          sl.requires_consult,
          COALESCE(sp.display_name, '') AS provider_display_name,
          COALESCE(sp.name, '') AS provider_name
         FROM service_listings sl
         JOIN service_providers sp ON sp.provider_id = sl.provider_id
        WHERE ${whereSql}
      )`;
}

function _buildServicesSearchQueries(params) {
  const filter = _buildFilter(params);
  const filteredListingsCte = _buildFilteredListingsCte(filter.whereSql);
  const matchScoreSql = filter.qRef
    ? `MAX(GREATEST(
          CASE WHEN COALESCE(title, '') ILIKE ${filter.qRef} THEN 30 ELSE 0 END,
          CASE WHEN COALESCE(provider_display_name, '') ILIKE ${filter.qRef} THEN 20 ELSE 0 END,
          CASE WHEN COALESCE(provider_name, '') ILIKE ${filter.qRef} THEN 15 ELSE 0 END,
          CASE WHEN COALESCE(description, '') ILIKE ${filter.qRef} THEN 10 ELSE 0 END
        ))`
    : '0';
  const limitRef = `$${filter.values.length + 1}`;
  const offsetRef = `$${filter.values.length + 2}`;

  const resultsSql = `WITH
      ${filteredListingsCte},
      ranked_listings AS (
        SELECT
          filtered_listings.*,
          ROW_NUMBER() OVER (
            PARTITION BY provider_id
            ORDER BY (price_cents IS NULL), price_cents ASC, title ASC, listing_id ASC
          ) AS preview_rank
         FROM filtered_listings
      ),
      provider_agg AS (
        SELECT
          provider_id,
          COUNT(*)::int AS matching_listings_count,
          ARRAY_AGG(DISTINCT service_type ORDER BY service_type) AS service_types_offered,
          ${matchScoreSql} AS match_score,
          jsonb_agg(
            jsonb_build_object(
              'service_type', service_type,
              'title', title,
              'price_cents', price_cents,
              'currency', currency,
              'duration_minutes', duration_minutes,
              'requires_consult', requires_consult
            )
            ORDER BY (price_cents IS NULL), price_cents ASC, title ASC, listing_id ASC
          ) FILTER (WHERE preview_rank <= ${PREVIEW_LISTING_LIMIT}) AS preview_listings
         FROM ranked_listings
        GROUP BY provider_id
      )
      SELECT
        sp.provider_id,
        sp.display_name,
        sp.name,
        sp.address_line1,
        sp.city,
        sp.region,
        sp.country_code,
        COALESCE(sp.metadata->>'final_url', sp.website_url) AS provider_url,
        sp.metadata->>'english_friendly_signal' AS english_friendly_signal,
        sp.metadata->>'english_friendly_evidence' AS english_friendly_evidence,
        sp.metadata->'tourist_metadata' AS tourist_metadata,
        sp.rating,
        sp.rating_count,
        provider_agg.service_types_offered,
        provider_agg.matching_listings_count,
        COALESCE(provider_agg.preview_listings, '[]'::jsonb) AS preview_listings
       FROM provider_agg
       JOIN service_providers sp ON sp.provider_id = provider_agg.provider_id
      ORDER BY
        provider_agg.match_score DESC,
        CASE sp.metadata->>'english_friendly_signal'
          WHEN 'explicit' THEN 0
          WHEN 'inferred' THEN 1
          ELSE 2
        END,
        provider_agg.matching_listings_count DESC,
        COALESCE(NULLIF(sp.display_name, ''), sp.name) ASC
      LIMIT ${limitRef}
      OFFSET ${offsetRef}`;

  const countSql = `WITH
      ${filteredListingsCte}
      SELECT COUNT(DISTINCT provider_id)::int AS total
       FROM filtered_listings`;

  return {
    results: {
      sql: resultsSql,
      values: [...filter.values, params.limit, params.offset],
    },
    count: {
      sql: countSql,
      values: [...filter.values],
    },
  };
}

function _asNonEmptyString(value) {
  const out = String(value || '').trim();
  return out || '';
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

function _parseTextArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(_asNonEmptyString).filter(Boolean))];
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return _parseTextArray(parsed);
    } catch (_err) {
      // PostgreSQL text[] is normally decoded by pg, but keep a conservative fallback.
      return value
        .replace(/^\{|\}$/g, '')
        .split(',')
        .map((item) => item.replace(/^"|"$/g, '').trim())
        .filter(Boolean);
    }
  }
  return [];
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

function _normalizePreviewListings(value) {
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
    .slice(0, PREVIEW_LISTING_LIMIT)
    .map((item) => item.listing);
}

function _buildProvider(row = {}) {
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
    service_types_offered: _parseTextArray(row.service_types_offered),
    matching_listings_count: _normalizeNullableInteger(row.matching_listings_count) || 0,
    preview_listings: _normalizePreviewListings(row.preview_listings),
  };
}

async function searchServices(params = {}) {
  const normalized = normalizeServicesSearchParams(params);
  const key = _cacheKey(normalized);
  const cached = _cacheGet(key);
  if (cached !== undefined) return cached;

  const statements = _buildServicesSearchQueries(normalized);
  const resultsResult = await query(statements.results.sql, statements.results.values);
  const countResult = await query(statements.count.sql, statements.count.values);
  const value = {
    results: (resultsResult?.rows || []).map(_buildProvider),
    total: _normalizeNullableInteger(countResult?.rows?.[0]?.total) || 0,
  };
  _cacheSet(key, value);
  return value;
}

module.exports = {
  searchServices,
  normalizeServicesSearchParams,
  ServicesSearchValidationError,
  SERVICE_TYPE_ALLOW_LIST,
  DEFAULT_SCOPE,
  // exposed for tests
  __test: {
    _cacheKey,
    _cacheGet,
    _cacheSet,
    _invalidateCache,
    _buildIlikePattern,
    _buildServicesSearchQueries,
    _composeAddress,
    _normalizePreviewListings,
    _buildProvider,
    CACHE_TTL_MS,
    CACHE_MAX,
    DEFAULT_LIMIT,
    DEFAULT_OFFSET,
    MAX_LIMIT,
    PREVIEW_LISTING_LIMIT,
  },
};

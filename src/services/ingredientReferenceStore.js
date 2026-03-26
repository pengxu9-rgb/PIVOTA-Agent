const VIEW_NAME = 'pci_kb.ingredient_reference_dictionary_v1';
const INGREDIENT_REFERENCE_DB_ENV_NAMES = ['INGREDIENT_REFERENCE_DATABASE_URL', 'PIVOTA_KB_DATABASE_URL'];

let ingredientReferencePool = null;
let ingredientReferencePoolCtor = null;
let ingredientReferencePoolCtorResolved = false;
let ingredientReferencePoolDatabaseUrl = '';

function normalizeBooleanEnv(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  return null;
}

function getIngredientReferenceDatabaseUrl() {
  for (const envName of INGREDIENT_REFERENCE_DB_ENV_NAMES) {
    const value = String(process.env[envName] || '').trim();
    if (value) return value;
  }
  return '';
}

function getIngredientReferencePoolConstructor() {
  if (ingredientReferencePoolCtorResolved) return ingredientReferencePoolCtor;
  ingredientReferencePoolCtorResolved = true;
  try {
    const mod = require('pg');
    ingredientReferencePoolCtor = mod && typeof mod.Pool === 'function' ? mod.Pool : null;
  } catch (_err) {
    ingredientReferencePoolCtor = null;
  }
  return ingredientReferencePoolCtor;
}

function shouldUseIngredientReferenceSsl(databaseUrl) {
  const explicitSsl = normalizeBooleanEnv(process.env.INGREDIENT_REFERENCE_DB_SSL);
  if (explicitSsl !== null) return explicitSsl;

  const sharedSsl = normalizeBooleanEnv(process.env.DB_SSL);
  if (sharedSsl !== null) return sharedSsl;

  const url = String(databaseUrl || '');
  return (
    /[?&]sslmode=(require|verify-full|verify-ca)\b/i.test(url) ||
    /[?&]ssl=true\b/i.test(url)
  );
}

function shouldRejectIngredientReferenceUnauthorized() {
  const explicit = normalizeBooleanEnv(process.env.INGREDIENT_REFERENCE_DB_SSL_REJECT_UNAUTHORIZED);
  if (explicit !== null) return explicit;

  const shared = normalizeBooleanEnv(process.env.DB_SSL_REJECT_UNAUTHORIZED);
  if (shared !== null) return shared;

  return true;
}

function getIngredientReferencePool() {
  const databaseUrl = getIngredientReferenceDatabaseUrl();
  if (!databaseUrl) return null;

  const Pool = getIngredientReferencePoolConstructor();
  if (!Pool) return null;

  if (ingredientReferencePool && ingredientReferencePoolDatabaseUrl !== databaseUrl) {
    if (typeof ingredientReferencePool.end === 'function') {
      Promise.resolve(ingredientReferencePool.end()).catch(() => {});
    }
    ingredientReferencePool = null;
    ingredientReferencePoolDatabaseUrl = '';
  }

  if (!ingredientReferencePool) {
    const useSsl = shouldUseIngredientReferenceSsl(databaseUrl);
    ingredientReferencePool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.INGREDIENT_REFERENCE_DB_POOL_MAX || process.env.DB_POOL_MAX || 3),
      idleTimeoutMillis: Number(
        process.env.INGREDIENT_REFERENCE_DB_IDLE_TIMEOUT_MS || process.env.DB_IDLE_TIMEOUT_MS || 30000,
      ),
      connectionTimeoutMillis: Number(
        process.env.INGREDIENT_REFERENCE_DB_CONN_TIMEOUT_MS || process.env.DB_CONN_TIMEOUT_MS || 10000,
      ),
      ssl: useSsl ? { rejectUnauthorized: shouldRejectIngredientReferenceUnauthorized() } : undefined,
    });
    ingredientReferencePoolDatabaseUrl = databaseUrl;
  }

  return ingredientReferencePool;
}

async function queryIngredientReference(text, params) {
  const pool = getIngredientReferencePool();
  if (!pool) {
    const err = new Error('Ingredient reference database not configured or pg driver unavailable');
    err.code = 'NO_DATABASE';
    throw err;
  }
  return pool.query(text, params);
}

function normalizeIngredientReferenceKey(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 240);
}

function normalizeIngredientReferenceText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeLimit(value, fallback = 10) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(50, Math.trunc(n)));
}

function mapIngredientReferenceRow(row) {
  if (!row) return null;
  return {
    record_id: row.record_id,
    canonical_inci_name: row.canonical_inci_name,
    canonical_display_name: row.canonical_display_name,
    ingredient_family: row.ingredient_family,
    us_label_name: row.us_label_name,
    eu_label_name: row.eu_label_name,
    us_label_variants_list: Array.isArray(row.us_label_variants_list) ? row.us_label_variants_list : [],
    eu_label_variants_list: Array.isArray(row.eu_label_variants_list) ? row.eu_label_variants_list : [],
    cross_market_notes: row.cross_market_notes || null,
    normalized_key: row.normalized_key,
    aliases_common_list: Array.isArray(row.aliases_common_list) ? row.aliases_common_list : [],
    parser_variants_list: Array.isArray(row.parser_variants_list) ? row.parser_variants_list : [],
    deprecated_aliases_list: Array.isArray(row.deprecated_aliases_list) ? row.deprecated_aliases_list : [],
    alias_quality: row.alias_quality || null,
    notes_for_parser: row.notes_for_parser || null,
    primary_bucket: row.primary_bucket || null,
    all_buckets_list: Array.isArray(row.all_buckets_list) ? row.all_buckets_list : [],
    function_tags_list: Array.isArray(row.function_tags_list) ? row.function_tags_list : [],
    benefit_tags_list: Array.isArray(row.benefit_tags_list) ? row.benefit_tags_list : [],
    risk_flags_list: Array.isArray(row.risk_flags_list) ? row.risk_flags_list : [],
    regulatory_bucket: row.regulatory_bucket || null,
    source_urls_list: Array.isArray(row.source_urls_list) ? row.source_urls_list : [],
    source_authorities_list: Array.isArray(row.source_authorities_list) ? row.source_authorities_list : [],
    source_types_list: Array.isArray(row.source_types_list) ? row.source_types_list : [],
    review_status: row.review_status || null,
    confidence: row.confidence || null,
    confidence_rank: Number(row.confidence_rank || 0),
    last_reviewed_at: row.last_reviewed_at || null,
    review_notes: row.review_notes || null,
    notes: row.notes || null,
    kb_version: row.kb_version || null,
    lookup_terms: Array.isArray(row.lookup_terms) ? row.lookup_terms : [],
    lookup_terms_normalized: Array.isArray(row.lookup_terms_normalized) ? row.lookup_terms_normalized : [],
    flags: {
      is_humectant: row.is_humectant_bool === null || row.is_humectant_bool === undefined ? null : Boolean(row.is_humectant_bool),
      is_barrier_support:
        row.is_barrier_support_bool === null || row.is_barrier_support_bool === undefined ? null : Boolean(row.is_barrier_support_bool),
      is_retinoid: row.is_retinoid_bool === null || row.is_retinoid_bool === undefined ? null : Boolean(row.is_retinoid_bool),
      is_exfoliant: row.is_exfoliant_bool === null || row.is_exfoliant_bool === undefined ? null : Boolean(row.is_exfoliant_bool),
      is_uv_filter: row.is_uv_filter_bool === null || row.is_uv_filter_bool === undefined ? null : Boolean(row.is_uv_filter_bool),
      is_preservative:
        row.is_preservative_bool === null || row.is_preservative_bool === undefined ? null : Boolean(row.is_preservative_bool),
      is_surfactant: row.is_surfactant_bool === null || row.is_surfactant_bool === undefined ? null : Boolean(row.is_surfactant_bool),
      is_fragrance_or_eo:
        row.is_fragrance_or_eo_bool === null || row.is_fragrance_or_eo_bool === undefined ? null : Boolean(row.is_fragrance_or_eo_bool),
    },
    provenance: {
      source_file: row.source_file || null,
      source_sheet: row.source_sheet || null,
      source_row_number: Number.isFinite(Number(row.source_row_number)) ? Number(row.source_row_number) : null,
      ingested_at: row.ingested_at || null,
    },
  };
}

function isMissingViewError(err) {
  const code = err && err.code ? String(err.code) : '';
  return code === 'NO_DATABASE' || code === '42P01' || code === '42883' || code === '3F000';
}

async function getIngredientReferenceByNormalizedKey(input) {
  const normalizedKey = normalizeIngredientReferenceKey(input);
  if (!normalizedKey) return null;
  try {
    const res = await queryIngredientReference(
      `
        SELECT *
        FROM ${VIEW_NAME}
        WHERE normalized_key = $1
        LIMIT 1
      `,
      [normalizedKey],
    );
    return mapIngredientReferenceRow(res && Array.isArray(res.rows) ? res.rows[0] : null);
  } catch (err) {
    if (isMissingViewError(err)) return null;
    throw err;
  }
}

async function lookupIngredientReferenceCandidates(input, options = {}) {
  const normalizedKey = normalizeIngredientReferenceKey(input);
  const normalizedText = normalizeIngredientReferenceText(input);
  const limit = normalizeLimit(options.limit, 10);
  if (!normalizedKey && !normalizedText) return [];

  try {
    const res = await queryIngredientReference(
      `
        WITH candidates AS (
          SELECT
            v.*,
            CASE
              WHEN $1 <> '' AND v.normalized_key = $1 THEN 100
              WHEN $1 <> '' AND $1 = ANY(v.lookup_terms_normalized) THEN 90
              WHEN $2 <> '' AND LOWER(v.canonical_inci_name) = LOWER($2) THEN 80
              WHEN $2 <> '' AND LOWER(v.canonical_display_name) = LOWER($2) THEN 75
              WHEN $2 <> '' AND LOWER(COALESCE(v.us_label_name, '')) = LOWER($2) THEN 74
              WHEN $2 <> '' AND LOWER(COALESCE(v.eu_label_name, '')) = LOWER($2) THEN 73
              ELSE 0
            END AS match_score
          FROM ${VIEW_NAME} v
          WHERE
            ($1 <> '' AND (v.normalized_key = $1 OR $1 = ANY(v.lookup_terms_normalized)))
            OR
            (
              $2 <> '' AND (
                LOWER(v.canonical_inci_name) = LOWER($2)
                OR LOWER(v.canonical_display_name) = LOWER($2)
                OR LOWER(COALESCE(v.us_label_name, '')) = LOWER($2)
                OR LOWER(COALESCE(v.eu_label_name, '')) = LOWER($2)
              )
            )
        )
        SELECT *
        FROM candidates
        WHERE match_score > 0
        ORDER BY match_score DESC, confidence_rank DESC, canonical_inci_name ASC
        LIMIT $3
      `,
      [normalizedKey, normalizedText, limit],
    );
    return (res && Array.isArray(res.rows) ? res.rows : []).map(mapIngredientReferenceRow);
  } catch (err) {
    if (isMissingViewError(err)) return [];
    throw err;
  }
}

async function getBestIngredientReferenceMatch(input) {
  const candidates = await lookupIngredientReferenceCandidates(input, { limit: 1 });
  return candidates[0] || null;
}

module.exports = {
  normalizeIngredientReferenceKey,
  normalizeIngredientReferenceText,
  getIngredientReferenceByNormalizedKey,
  lookupIngredientReferenceCandidates,
  getBestIngredientReferenceMatch,
  _internals: {
    mapIngredientReferenceRow,
    normalizeLimit,
    normalizeBooleanEnv,
    getIngredientReferenceDatabaseUrl,
    getIngredientReferencePool,
    queryIngredientReference,
    resetForTest() {
      if (ingredientReferencePool && typeof ingredientReferencePool.end === 'function') {
        Promise.resolve(ingredientReferencePool.end()).catch(() => {});
      }
      ingredientReferencePool = null;
      ingredientReferencePoolDatabaseUrl = '';
      ingredientReferencePoolCtor = null;
      ingredientReferencePoolCtorResolved = false;
    },
  },
};

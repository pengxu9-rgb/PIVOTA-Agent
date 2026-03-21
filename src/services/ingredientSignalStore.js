const VIEW_NAME = 'seed_preview.ingredient_signal_dictionary_candidate_v1';
const INGREDIENT_SIGNAL_DB_ENV_NAMES = [
  'INGREDIENT_SIGNAL_DATABASE_URL',
  'INGREDIENT_REFERENCE_DATABASE_URL',
  'PIVOTA_KB_DATABASE_URL',
  'DATABASE_URL',
];

let ingredientSignalPool = null;
let ingredientSignalPoolCtor = null;
let ingredientSignalPoolCtorResolved = false;
let ingredientSignalPoolDatabaseUrl = '';

function normalizeBooleanEnv(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  return null;
}

function getIngredientSignalDatabaseUrl() {
  for (const envName of INGREDIENT_SIGNAL_DB_ENV_NAMES) {
    const value = String(process.env[envName] || '').trim();
    if (value) return value;
  }
  return '';
}

function getIngredientSignalPoolConstructor() {
  if (ingredientSignalPoolCtorResolved) return ingredientSignalPoolCtor;
  ingredientSignalPoolCtorResolved = true;
  try {
    const mod = require('pg');
    ingredientSignalPoolCtor = mod && typeof mod.Pool === 'function' ? mod.Pool : null;
  } catch (_err) {
    ingredientSignalPoolCtor = null;
  }
  return ingredientSignalPoolCtor;
}

function shouldUseIngredientSignalSsl(databaseUrl) {
  const explicitSsl = normalizeBooleanEnv(process.env.INGREDIENT_SIGNAL_DB_SSL);
  if (explicitSsl !== null) return explicitSsl;

  const referenceSsl = normalizeBooleanEnv(process.env.INGREDIENT_REFERENCE_DB_SSL);
  if (referenceSsl !== null) return referenceSsl;

  const sharedSsl = normalizeBooleanEnv(process.env.DB_SSL);
  if (sharedSsl !== null) return sharedSsl;

  const url = String(databaseUrl || '');
  return (
    /[?&]sslmode=(require|verify-full|verify-ca)\b/i.test(url) ||
    /[?&]ssl=true\b/i.test(url)
  );
}

function shouldRejectIngredientSignalUnauthorized() {
  const explicit = normalizeBooleanEnv(process.env.INGREDIENT_SIGNAL_DB_SSL_REJECT_UNAUTHORIZED);
  if (explicit !== null) return explicit;

  const reference = normalizeBooleanEnv(process.env.INGREDIENT_REFERENCE_DB_SSL_REJECT_UNAUTHORIZED);
  if (reference !== null) return reference;

  const shared = normalizeBooleanEnv(process.env.DB_SSL_REJECT_UNAUTHORIZED);
  if (shared !== null) return shared;

  return true;
}

function getIngredientSignalPool() {
  const databaseUrl = getIngredientSignalDatabaseUrl();
  if (!databaseUrl) return null;

  const Pool = getIngredientSignalPoolConstructor();
  if (!Pool) return null;

  if (ingredientSignalPool && ingredientSignalPoolDatabaseUrl !== databaseUrl) {
    if (typeof ingredientSignalPool.end === 'function') {
      Promise.resolve(ingredientSignalPool.end()).catch(() => {});
    }
    ingredientSignalPool = null;
    ingredientSignalPoolDatabaseUrl = '';
  }

  if (!ingredientSignalPool) {
    const useSsl = shouldUseIngredientSignalSsl(databaseUrl);
    ingredientSignalPool = new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.INGREDIENT_SIGNAL_DB_POOL_MAX || process.env.DB_POOL_MAX || 3),
      idleTimeoutMillis: Number(
        process.env.INGREDIENT_SIGNAL_DB_IDLE_TIMEOUT_MS || process.env.DB_IDLE_TIMEOUT_MS || 30000,
      ),
      connectionTimeoutMillis: Number(
        process.env.INGREDIENT_SIGNAL_DB_CONN_TIMEOUT_MS || process.env.DB_CONN_TIMEOUT_MS || 10000,
      ),
      ssl: useSsl ? { rejectUnauthorized: shouldRejectIngredientSignalUnauthorized() } : undefined,
    });
    ingredientSignalPoolDatabaseUrl = databaseUrl;
  }

  return ingredientSignalPool;
}

async function queryIngredientSignal(text, params) {
  const pool = getIngredientSignalPool();
  if (!pool) {
    const err = new Error('Ingredient signal database not configured or pg driver unavailable');
    err.code = 'NO_DATABASE';
    throw err;
  }
  return pool.query(text, params);
}

function normalizeIngredientSignalKey(value) {
  const raw = String(value || '');
  if (!raw) return '';
  return raw
    .replace(/[™®©]/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 240);
}

function normalizeIngredientSignalText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/[™®©]/g, ' ').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeLimit(value, fallback = 10) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(50, Math.trunc(n)));
}

function splitSemicolonList(value, max = 20) {
  return String(value || '')
    .split(';')
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

function mapIngredientSignalRow(row) {
  if (!row) return null;
  return {
    signal_bucket: String(row.signal_bucket || '').trim() || null,
    signal_key: String(row.signal_key || '').trim() || null,
    display_signal_name: String(row.display_signal_name || '').trim() || null,
    raw_token_variants_list: splitSemicolonList(row.raw_token_variants, 32),
    normalized_token_variants_list: splitSemicolonList(row.normalized_token_variants, 32),
    source_packets_list: splitSemicolonList(row.source_packets, 12),
    source_decisions_list: splitSemicolonList(row.source_decisions, 12),
    confidence_levels_list: splitSemicolonList(row.confidence_levels, 12),
    row_count: Number.isFinite(Number(row.row_count)) ? Number(row.row_count) : 0,
    total_unmatched_count: Number.isFinite(Number(row.total_unmatched_count)) ? Number(row.total_unmatched_count) : 0,
    total_sku_row_count: Number.isFinite(Number(row.total_sku_row_count)) ? Number(row.total_sku_row_count) : 0,
    total_full_inci_count: Number.isFinite(Number(row.total_full_inci_count)) ? Number(row.total_full_inci_count) : 0,
    total_key_count: Number.isFinite(Number(row.total_key_count)) ? Number(row.total_key_count) : 0,
    top_categories_list: splitSemicolonList(row.top_categories, 12),
    example_brands_list: splitSemicolonList(row.example_brands, 12),
    example_products_list: splitSemicolonList(row.example_products, 12),
    example_urls_list: splitSemicolonList(row.example_urls, 12),
    resolution_rationales_list: splitSemicolonList(row.resolution_rationales, 12),
  };
}

function isMissingViewError(err) {
  const code = err && err.code ? String(err.code) : '';
  return code === 'NO_DATABASE' || code === '42P01' || code === '42883' || code === '3F000';
}

async function lookupIngredientSignalCandidates(input, options = {}) {
  const normalizedKey = normalizeIngredientSignalKey(input);
  const normalizedText = normalizeIngredientSignalText(input);
  const limit = normalizeLimit(options.limit, 10);
  if (!normalizedKey && !normalizedText) return [];

  try {
    const res = await queryIngredientSignal(
      `
        WITH candidates AS (
          SELECT
            v.*,
            CASE
              WHEN $1 <> '' AND regexp_replace(lower(COALESCE(v.signal_key, '')), '[^[:alnum:]]+', '', 'g') = $1 THEN 100
              WHEN $1 <> '' AND EXISTS (
                SELECT 1
                FROM unnest(string_to_array(COALESCE(v.normalized_token_variants, ''), ';')) AS token(value)
                WHERE BTRIM(token.value) = $1
              ) THEN 90
              WHEN $2 <> '' AND LOWER(v.display_signal_name) = LOWER($2) THEN 80
              WHEN $2 <> '' AND EXISTS (
                SELECT 1
                FROM unnest(string_to_array(COALESCE(v.raw_token_variants, ''), ';')) AS token(value)
                WHERE LOWER(BTRIM(token.value)) = LOWER($2)
              ) THEN 75
              ELSE 0
            END AS match_score,
            CASE
              WHEN LOWER(COALESCE(v.confidence_levels, '')) LIKE '%high%' THEN 3
              WHEN LOWER(COALESCE(v.confidence_levels, '')) LIKE '%medium%' THEN 2
              WHEN LOWER(COALESCE(v.confidence_levels, '')) LIKE '%low%' THEN 1
              ELSE 0
            END AS confidence_rank
          FROM ${VIEW_NAME} v
          WHERE
            ($1 <> '' AND (
              regexp_replace(lower(COALESCE(v.signal_key, '')), '[^[:alnum:]]+', '', 'g') = $1
              OR EXISTS (
                SELECT 1
                FROM unnest(string_to_array(COALESCE(v.normalized_token_variants, ''), ';')) AS token(value)
                WHERE BTRIM(token.value) = $1
              )
            ))
            OR
            ($2 <> '' AND (
              LOWER(v.display_signal_name) = LOWER($2)
              OR EXISTS (
                SELECT 1
                FROM unnest(string_to_array(COALESCE(v.raw_token_variants, ''), ';')) AS token(value)
                WHERE LOWER(BTRIM(token.value)) = LOWER($2)
              )
            ))
        )
        SELECT *
        FROM candidates
        WHERE match_score > 0
        ORDER BY match_score DESC, confidence_rank DESC, row_count DESC, total_sku_row_count DESC, display_signal_name ASC
        LIMIT $3
      `,
      [normalizedKey, normalizedText, limit],
    );
    return (res && Array.isArray(res.rows) ? res.rows : []).map(mapIngredientSignalRow);
  } catch (err) {
    if (isMissingViewError(err)) return [];
    throw err;
  }
}

async function getBestIngredientSignalMatch(input) {
  const candidates = await lookupIngredientSignalCandidates(input, { limit: 1 });
  return candidates[0] || null;
}

async function getIngredientSignalStoreHealth() {
  const databaseUrl = getIngredientSignalDatabaseUrl();
  if (!databaseUrl) {
    return {
      source: 'signal',
      configured: false,
      reachable: false,
      view_reachable: false,
      available: false,
      reason: 'database_url_missing',
      view_name: VIEW_NAME,
    };
  }
  try {
    const res = await queryIngredientSignal(`SELECT 1 AS ok FROM ${VIEW_NAME} LIMIT 1`);
    return {
      source: 'signal',
      configured: true,
      reachable: true,
      view_reachable: true,
      available: true,
      reason: null,
      view_name: VIEW_NAME,
      sample_row_count: Array.isArray(res?.rows) ? res.rows.length : 0,
    };
  } catch (err) {
    return {
      source: 'signal',
      configured: true,
      reachable: err?.code !== 'NO_DATABASE',
      view_reachable: false,
      available: false,
      reason: isMissingViewError(err) ? 'view_unavailable' : 'query_failed',
      error_code: String(err?.code || '').trim() || null,
      view_name: VIEW_NAME,
    };
  }
}

module.exports = {
  normalizeIngredientSignalKey,
  normalizeIngredientSignalText,
  lookupIngredientSignalCandidates,
  getBestIngredientSignalMatch,
  getIngredientSignalStoreHealth,
  _internals: {
    mapIngredientSignalRow,
    normalizeLimit,
    normalizeBooleanEnv,
    getIngredientSignalDatabaseUrl,
    getIngredientSignalPool,
    queryIngredientSignal,
    splitSemicolonList,
    resetForTest() {
      if (ingredientSignalPool && typeof ingredientSignalPool.end === 'function') {
        Promise.resolve(ingredientSignalPool.end()).catch(() => {});
      }
      ingredientSignalPool = null;
      ingredientSignalPoolDatabaseUrl = '';
      ingredientSignalPoolCtor = null;
      ingredientSignalPoolCtorResolved = false;
    },
  },
};

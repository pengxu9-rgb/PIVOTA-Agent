'use strict';

// Durable candidate-pool cache for the Aurora reco recall lane.
//
// WHY POSTGRES. Every cache on this path is in-process (routes.js keeps ~8 Maps), and this service
// deploys ~20 times a day, so none of them survives long enough to absorb a cold-search spike. The
// gateway already owns tables and runs its own migrations (src/db/migrations, applied at startup under
// an advisory lock by src/server.js), so a table here is the shipped pattern, not a new one.
//
// SEMANTICS: stale-while-revalidate.
//   * any row younger than SERVE_MAX_AGE_MS (24h) is served IMMEDIATELY
//   * a served row older than REVALIDATE_AFTER_MS (10min) also triggers an OFF-REQUEST refresh
//   * an EMPTY pool is never stored as fresh -- it gets a short negative lease
//     (EMPTY_SERVE_MAX_AGE_MS, 60s) so one bad minute cannot pin "no results" for a day
//
// SAFETY. This is a SHARED GLOBAL cache. The key is a SHA-256 of the normalized recall shape, so the
// caller's free text never reaches the table -- only its digest. The payload carries an ALLOWLIST of
// catalog fields (ids, titles, prices, urls): no buyer text, no uid, no session id, no auth header.
// Both are enforced here rather than at the call site, because a call site is easy to add.

const crypto = require('crypto');
const { formatRecoPriceCeilingCacheToken } = require('./recoPriceCeiling');

const RECO_RECALL_POOL_CACHE_TABLE = 'reco_recall_pool_cache';
// v2: v1 payloads were written WITHOUT prices — the sanitizer kept scalars only while the lane's
// price is an OBJECT ({amount, currency}) — so every pool served from cache produced "no price"
// items (live 2026-08-21: three grounded products, all price-less, all "not verified"). The version
// rides in the cache KEY, so bumping it orphans every v1 row at once; the purge sweep deletes them.
// v3: the pool now depends on the buyer's price ceiling — conforming-first selection changes WHICH 24
// candidates land in the payload — so the key gained a `ceil` dimension. Adding a dimension already
// changes every hash, orphaning v2 rows; the bump makes that intentional rather than incidental, and
// keeps the reason readable next to v2's.
// v4: the ceiling-carrying arm now requests ~18 rows instead of 6, so an existing ceiling'd key would
// otherwise keep serving its SHALLOW pool for the rest of its 24h window -- the exact pool whose
// thinness this change exists to fix. Bumping orphans them at once; the sweep deletes them.
const RECO_RECALL_POOL_CACHE_VERSION = 'reco_recall_pool_cache_v4';

// Belt-and-braces lazy DDL, byte-identical to src/db/migrations/059_reco_recall_pool_cache.sql. The
// migration is the primary mechanism; this only recovers a 42P01 on a deployment whose migrations have
// not run yet. A test asserts the two agree, so they cannot drift.
const RECO_RECALL_POOL_CACHE_TABLE_SQL = Object.freeze([
  `
  CREATE TABLE IF NOT EXISTS reco_recall_pool_cache (
    cache_key       text        PRIMARY KEY,
    step_family     text        NOT NULL DEFAULT '',
    lang            text        NOT NULL DEFAULT '',
    catalog_surface text        NOT NULL DEFAULT '',
    planner_mode    text        NOT NULL DEFAULT '',
    candidate_count integer     NOT NULL DEFAULT 0,
    payload         jsonb       NOT NULL,
    refreshed_at    timestamptz NOT NULL DEFAULT now()
  )
  `,
  `
  CREATE INDEX IF NOT EXISTS reco_recall_pool_cache_refreshed_at_idx
    ON reco_recall_pool_cache (refreshed_at DESC)
  `,
]);

function readBoolEnv(name, fallback) {
  const raw = String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y' || raw === 'on';
}

function readIntEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

// Kill switch for the whole cache. Default ON.
function isRecoRecallPoolCacheEnabled() {
  return readBoolEnv('AURORA_BFF_RECO_RECALL_POOL_CACHE_ENABLED', true);
}

function getServeMaxAgeMs() {
  return readIntEnv('AURORA_BFF_RECO_RECALL_POOL_CACHE_SERVE_MAX_AGE_MS', 86400000, 60000, 604800000);
}

function getRevalidateAfterMs() {
  return readIntEnv('AURORA_BFF_RECO_RECALL_POOL_CACHE_REVALIDATE_AFTER_MS', 600000, 5000, 86400000);
}

function getEmptyServeMaxAgeMs() {
  return readIntEnv('AURORA_BFF_RECO_RECALL_POOL_CACHE_EMPTY_SERVE_MAX_AGE_MS', 60000, 1000, 600000);
}

// The existing pool cap in buildRecoGenerateFromCatalog is 24; the payload must never exceed it.
const RECO_RECALL_POOL_CACHE_MAX_CANDIDATES = 24;
const RECO_RECALL_POOL_CACHE_MAX_KEY_PARTS = 8;
const RECO_RECALL_POOL_CACHE_MAX_QUERY_CHARS = 120;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKeyToken(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, RECO_RECALL_POOL_CACHE_MAX_QUERY_CHARS);
}

// Build the cache key. Case- and whitespace-folded, bounded in BOTH the number of query parts and the
// length of each, then hashed -- so an adversarial or simply very long need cannot blow up the key,
// and no free text is persisted.
function buildRecoRecallPoolCacheKey({
  queries = [],
  stepFamily = '',
  lang = '',
  catalogSurface = '',
  plannerMode = '',
  externalSeedStrategy = '',
  priceCeiling = null,
} = {}) {
  const normalizedQueries = [];
  const seen = new Set();
  for (const raw of Array.isArray(queries) ? queries : []) {
    const token = normalizeKeyToken(raw);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    normalizedQueries.push(token);
    if (normalizedQueries.length >= RECO_RECALL_POOL_CACHE_MAX_KEY_PARTS) break;
  }
  if (!normalizedQueries.length) return null;
  const dims = {
    v: RECO_RECALL_POOL_CACHE_VERSION,
    q: normalizedQueries,
    step: normalizeKeyToken(stepFamily),
    lang: normalizeKeyToken(lang),
    surface: normalizeKeyToken(catalogSurface),
    mode: normalizeKeyToken(plannerMode),
    seed: normalizeKeyToken(externalSeedStrategy),
    // The ceiling changes WHICH candidates survive into the 24-row payload (conforming-first
    // selection), so a constrained call and an unconstrained one must never share a row -- otherwise
    // one poisons the other for up to 24 hours, fleet-wide.
    ceil: formatRecoPriceCeilingCacheToken(priceCeiling),
  };
  return crypto.createHash('sha256').update(JSON.stringify(dims)).digest('hex');
}

// Catalog fields only. An allowlist, not a denylist: a field added upstream is NOT persisted until
// someone adds it here on purpose, so a future buyer-scoped field cannot leak into a shared cache by
// default.
const RECO_RECALL_POOL_CACHE_CANDIDATE_FIELDS = Object.freeze([
  'product_id', 'productId', 'merchant_id', 'merchantId', 'variant_id', 'variantId',
  'name', 'title', 'display_name', 'displayName', 'brand', 'brand_name', 'brandName',
  'category', 'category_name', 'categoryName', 'product_type', 'productType', 'type',
  'price', 'price_amount', 'priceAmount', 'currency', 'price_currency', 'priceCurrency',
  'image', 'image_url', 'imageUrl', 'canonical_pdp_url', 'canonicalPdpUrl', 'url',
  'purchase_path', 'purchasePath', 'source_system', 'sourceSystem',
  'retrieval_source', 'retrievalSource', 'retrieval_reason', 'retrievalReason',
  'candidate_step', 'candidate_step_source', 'candidate_step_confidence',
  'in_stock', 'inStock', 'availability', 'score', 'quality_score', 'qualityScore',
]);

function sanitizeRecoRecallPoolCandidate(candidate) {
  if (!isPlainObject(candidate)) return null;
  const out = {};
  for (const field of RECO_RECALL_POOL_CACHE_CANDIDATE_FIELDS) {
    const value = candidate[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      const trimmed = value.slice(0, 512);
      if (trimmed) out[field] = trimmed;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[field] = value;
      continue;
    }
    // The lane's price is an OBJECT ({amount, currency, unknown}) built by
    // extractCatalogCandidatePrice. Dropping it (the v1 behavior) served whole pools of price-less
    // products. It is flattened into the scalar fields the SAME extractor reads back
    // (price_amount + currency are both allowlisted and both extractor seeds), so a cached
    // candidate round-trips to the identical price. amount <= 0 is a broken offer row and is
    // skipped on purpose -- the reader must see "no price", never a fabricated zero.
    if (field === 'price' && isPlainObject(value)) {
      const amount = Number(value.amount);
      if (Number.isFinite(amount) && amount > 0 && out.price_amount === undefined) {
        out.price_amount = amount;
        const cur = String(value.currency == null ? '' : value.currency).trim().toUpperCase();
        if (cur && out.currency === undefined) out.currency = cur.slice(0, 8);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeRecoRecallPoolCandidates(pool) {
  const out = [];
  for (const candidate of Array.isArray(pool) ? pool : []) {
    const sanitized = sanitizeRecoRecallPoolCandidate(candidate);
    if (!sanitized) continue;
    out.push(sanitized);
    if (out.length >= RECO_RECALL_POOL_CACHE_MAX_CANDIDATES) break;
  }
  return out;
}

function normalizeRecoRecallPoolCacheEntry(row, nowMs = Date.now()) {
  if (!isPlainObject(row)) return null;
  const refreshedAtMs = new Date(row.refreshed_at).getTime();
  if (!Number.isFinite(refreshedAtMs)) return null;
  const payload = Array.isArray(row.payload) ? row.payload : [];
  return {
    pool: payload,
    candidate_count: payload.length,
    refreshed_at_ms: refreshedAtMs,
    age_ms: Math.max(0, nowMs - refreshedAtMs),
  };
}

// Serve any row inside its age window. An EMPTY pool gets a much shorter window: a negative result is
// worth caching for a minute to absorb a burst, and worth nothing after that.
function shouldServeRecoRecallPoolCacheEntry(entry, nowMs = Date.now()) {
  if (!isPlainObject(entry)) return false;
  const ageMs = Number.isFinite(Number(entry.age_ms))
    ? Number(entry.age_ms)
    : Math.max(0, nowMs - Number(entry.refreshed_at_ms || 0));
  const isEmpty = !Array.isArray(entry.pool) || entry.pool.length === 0;
  return ageMs <= (isEmpty ? getEmptyServeMaxAgeMs() : getServeMaxAgeMs());
}

function shouldRevalidateRecoRecallPoolCacheEntry(entry, nowMs = Date.now()) {
  if (!isPlainObject(entry)) return false;
  const ageMs = Number.isFinite(Number(entry.age_ms))
    ? Number(entry.age_ms)
    : Math.max(0, nowMs - Number(entry.refreshed_at_ms || 0));
  return ageMs > getRevalidateAfterMs();
}

function createRecoRecallPoolCache({ query, logger = null, now = () => Date.now() } = {}) {
  if (typeof query !== 'function') {
    throw new Error('createRecoRecallPoolCache requires a query function');
  }
  const state = {
    tableReady: false,
    tableInitPromise: null,
    dbUnavailableUntilMs: 0,
  };
  const DB_RETRY_COOLDOWN_MS = 60000;

  function markDbUnavailable(err) {
    const code = String(err?.code || '');
    if (code === 'NO_DATABASE' || code === '42P01') {
      state.dbUnavailableUntilMs = now() + DB_RETRY_COOLDOWN_MS;
    }
  }

  function shouldUseDbNow() {
    return now() >= Number(state.dbUnavailableUntilMs || 0);
  }

  async function ensureTable() {
    if (state.tableReady) return true;
    if (state.tableInitPromise) return state.tableInitPromise;
    state.tableInitPromise = (async () => {
      for (const stmt of RECO_RECALL_POOL_CACHE_TABLE_SQL) {
        await query(stmt);
      }
      state.tableReady = true;
      return true;
    })()
      .catch((err) => {
        markDbUnavailable(err);
        return false;
      })
      .finally(() => {
        state.tableInitPromise = null;
      });
    return state.tableInitPromise;
  }

  async function read(cacheKey) {
    if (!isRecoRecallPoolCacheEnabled()) return null;
    if (!cacheKey || !shouldUseDbNow()) return null;
    const sql =
      `SELECT payload, refreshed_at FROM ${RECO_RECALL_POOL_CACHE_TABLE} WHERE cache_key = $1 LIMIT 1`;
    try {
      const res = await query(sql, [cacheKey]);
      return normalizeRecoRecallPoolCacheEntry(res?.rows?.[0], now());
    } catch (err) {
      if (String(err?.code || '') === '42P01') {
        // The migration has not run on this deployment yet; create the table and retry ONCE.
        const ensured = await ensureTable();
        if (!ensured) return null;
        try {
          const res = await query(sql, [cacheKey]);
          return normalizeRecoRecallPoolCacheEntry(res?.rows?.[0], now());
        } catch (retryErr) {
          markDbUnavailable(retryErr);
          return null;
        }
      }
      markDbUnavailable(err);
      if (logger && typeof logger.debug === 'function') {
        logger.debug({ event: 'reco_recall_pool_cache_read_failed', code: String(err?.code || '') });
      }
      return null;
    }
  }

  async function write(cacheKey, { pool = [], stepFamily = '', lang = '', catalogSurface = '', plannerMode = '' } = {}) {
    if (!isRecoRecallPoolCacheEnabled()) return false;
    if (!cacheKey || !shouldUseDbNow()) return false;
    const sanitized = sanitizeRecoRecallPoolCandidates(pool);
    const sql = `
      INSERT INTO ${RECO_RECALL_POOL_CACHE_TABLE}
        (cache_key, step_family, lang, catalog_surface, planner_mode, candidate_count, payload, refreshed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
      ON CONFLICT (cache_key) DO UPDATE SET
        step_family = EXCLUDED.step_family,
        lang = EXCLUDED.lang,
        catalog_surface = EXCLUDED.catalog_surface,
        planner_mode = EXCLUDED.planner_mode,
        candidate_count = EXCLUDED.candidate_count,
        payload = EXCLUDED.payload,
        refreshed_at = now()
    `;
    const params = [
      cacheKey,
      normalizeKeyToken(stepFamily),
      normalizeKeyToken(lang),
      normalizeKeyToken(catalogSurface),
      normalizeKeyToken(plannerMode),
      sanitized.length,
      JSON.stringify(sanitized),
    ];
    try {
      await query(sql, params);
      return true;
    } catch (err) {
      if (String(err?.code || '') === '42P01') {
        const ensured = await ensureTable();
        if (!ensured) return false;
        try {
          await query(sql, params);
          return true;
        } catch (retryErr) {
          markDbUnavailable(retryErr);
          return false;
        }
      }
      markDbUnavailable(err);
      return false;
    }
  }

  // Opportunistic sweep. Rows past the serve window can never be served again, so they are dead
  // weight; without this the table grows without bound on an open key space.
  async function purgeExpired({ maxRows = 500 } = {}) {
    if (!isRecoRecallPoolCacheEnabled()) return 0;
    if (!shouldUseDbNow()) return 0;
    // ISO string + an explicit ::timestamptz cast rather than to_timestamp(epoch): one deduced type
    // per parameter, and no epoch-seconds rounding to reason about.
    const cutoffIso = new Date(now() - getServeMaxAgeMs()).toISOString();
    try {
      const res = await query(
        `DELETE FROM ${RECO_RECALL_POOL_CACHE_TABLE}
         WHERE cache_key IN (
           SELECT cache_key FROM ${RECO_RECALL_POOL_CACHE_TABLE}
           WHERE refreshed_at <= $1::timestamptz
           ORDER BY refreshed_at ASC
           LIMIT $2
         )`,
        [cutoffIso, Math.max(1, Math.min(5000, Math.trunc(Number(maxRows) || 500)))],
      );
      return Number(res?.rowCount || 0);
    } catch (err) {
      markDbUnavailable(err);
      return 0;
    }
  }

  return {
    read,
    write,
    purgeExpired,
    ensureTable,
    __state: state,
  };
}

module.exports = {
  RECO_RECALL_POOL_CACHE_TABLE,
  RECO_RECALL_POOL_CACHE_VERSION,
  RECO_RECALL_POOL_CACHE_TABLE_SQL,
  RECO_RECALL_POOL_CACHE_MAX_CANDIDATES,
  RECO_RECALL_POOL_CACHE_CANDIDATE_FIELDS,
  isRecoRecallPoolCacheEnabled,
  getServeMaxAgeMs,
  getRevalidateAfterMs,
  getEmptyServeMaxAgeMs,
  buildRecoRecallPoolCacheKey,
  sanitizeRecoRecallPoolCandidate,
  sanitizeRecoRecallPoolCandidates,
  normalizeRecoRecallPoolCacheEntry,
  shouldServeRecoRecallPoolCacheEntry,
  shouldRevalidateRecoRecallPoolCacheEntry,
  createRecoRecallPoolCache,
};

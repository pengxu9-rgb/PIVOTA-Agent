const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { query } = require('./db');
const { expandProductIdScope } = require('./utils/shopifyGid');

const STORE_PATH = path.join(__dirname, '..', 'data', 'promotions.json');

// Default demo merchant id for local promotion fixtures.
const DEFAULT_MERCHANT_ID = String(
  process.env.PIVOTA_DEFAULT_MERCHANT_ID ||
    process.env.DEFAULT_MERCHANT_ID ||
    '',
).trim();

// Remote backend configuration (pivota-backend internal API)
const PROMO_BACKEND_BASE =
  process.env.PROMOTIONS_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE || '';
const PROMO_ADMIN_KEY =
  process.env.PROMOTIONS_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
// Mode: 'remote' | 'local' | 'none'.
// - Default is remote when a backend base is configured, otherwise 'none' (serve
//   NO promotions). 'local' — the JSON-file store — is EXPLICIT opt-in only: an
//   unconfigured deployment must never invent discounts (fabrication-belt sweep
//   2026-08-11; previously the default was 'local' and the tracked fixture
//   carried a demo FLASH_SALE active through 2026).
const PROMO_MODE_RAW = String(process.env.PROMOTIONS_MODE || '').trim().toLowerCase();
let PROMO_MODE = PROMO_MODE_RAW || (PROMO_BACKEND_BASE ? 'remote' : 'none');
const USE_REMOTE_PROMO = !!PROMO_BACKEND_BASE && PROMO_MODE === 'remote';
const PROMO_DB_DIRECT_READ_ENABLED =
  String(process.env.PROMOTIONS_DB_DIRECT_READ_ENABLED || 'true').toLowerCase() !== 'false';

// Production safety: never allow local/demo promotions.
// We want promotions to be sourced from pivota-backend (/agent/internal/promotions),
// otherwise Deals UI can show fake discounts.
if (process.env.NODE_ENV === 'production') {
  if (PROMO_MODE !== 'remote') {
    throw new Error(
      `[promotionStore] PROMOTIONS_MODE must be "remote" in production (got "${PROMO_MODE}")`
    );
  }
  if (!PROMO_BACKEND_BASE) {
    throw new Error(
      '[promotionStore] PROMOTIONS_BACKEND_BASE_URL (or PIVOTA_API_BASE) must be set in production'
    );
  }
  if (!PROMO_ADMIN_KEY) {
    throw new Error(
      '[promotionStore] PROMOTIONS_ADMIN_KEY (or ADMIN_API_KEY) must be set in production'
    );
  }
} else if (PROMO_MODE === 'local') {
  // The Dockerfile does not set NODE_ENV, so the guard above can be inert on a
  // production Railway/Vercel deploy. Same detection as isProductionLikeAuroraBffEnv;
  // force-degrade to 'none' (loudly, without failing the boot the way the NODE_ENV
  // guard does) rather than serve file-store promotions to production traffic.
  const railwayEnv = String(process.env.RAILWAY_ENVIRONMENT || '').trim().toLowerCase();
  const vercelEnv = String(process.env.VERCEL_ENV || '').trim().toLowerCase();
  if (railwayEnv === 'production' || vercelEnv === 'production') {
    console.error(
      '[promotionStore] production-like environment detected (RAILWAY_ENVIRONMENT/VERCEL_ENV) with ' +
        `PROMOTIONS_MODE="${PROMO_MODE}"; forcing mode "none". Set PROMOTIONS_MODE=remote + backend base + admin key.`
    );
    PROMO_MODE = 'none';
  }
}

if (PROMO_MODE === 'none') {
  console.warn(
    '[promotionStore] promotions disabled (mode "none"): no PROMOTIONS_MODE set and no ' +
      'PROMOTIONS_BACKEND_BASE_URL/PIVOTA_API_BASE configured. Serving zero promotions.'
  );
}

function localModeEnabled() {
  return PROMO_MODE === 'local';
}

// Simple in-memory cache used when remote calls fail.
let lastKnownPromotions = [];
let lastKnownPromotionsFetchedAtMs = 0;
let remotePromotionsRefreshPromise = null;
const lastKnownPromotionsByMerchant = new Map();
const remotePromotionsRefreshByMerchant = new Map();
const PROMO_REMOTE_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.PROMO_REMOTE_CACHE_TTL_MS ?? 30_000) || 30_000
);
const PROMO_REMOTE_STALE_WHILE_REVALIDATE =
  String(process.env.PROMO_REMOTE_STALE_WHILE_REVALIDATE || 'true').toLowerCase() === 'true';

function setLastKnownPromotions(promos) {
  lastKnownPromotions = Array.isArray(promos) ? promos : [];
  lastKnownPromotionsFetchedAtMs = Date.now();
}

function hasRemotePromotionsCacheSnapshot() {
  return Array.isArray(lastKnownPromotions) && lastKnownPromotionsFetchedAtMs > 0;
}

function isRemotePromotionsCacheFresh() {
  if (!hasRemotePromotionsCacheSnapshot()) return false;
  return Date.now() - lastKnownPromotionsFetchedAtMs < PROMO_REMOTE_CACHE_TTL_MS;
}

function setLastKnownMerchantPromotions(merchantId, promos) {
  const mid = String(merchantId || '').trim();
  if (!mid) return;
  lastKnownPromotionsByMerchant.set(mid, {
    promotions: Array.isArray(promos) ? promos : [],
    fetchedAtMs: Date.now(),
  });
}

function getLastKnownMerchantPromotionsSnapshot(merchantId) {
  const mid = String(merchantId || '').trim();
  if (!mid) return null;
  return lastKnownPromotionsByMerchant.get(mid) || null;
}

function isMerchantPromotionsCacheFresh(merchantId) {
  const snapshot = getLastKnownMerchantPromotionsSnapshot(merchantId);
  if (!snapshot) return false;
  return Date.now() - snapshot.fetchedAtMs < PROMO_REMOTE_CACHE_TTL_MS;
}

function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function computePromotionStatusFromRecord(promo, now = new Date()) {
  if (promo?.deletedAt || promo?.deleted_at) return 'ENDED';
  const startAt = promo?.startAt || promo?.start_at;
  const endAt = promo?.endAt || promo?.end_at;
  const startMs = startAt ? Date.parse(startAt instanceof Date ? startAt.toISOString() : startAt) : null;
  const endMs = endAt ? Date.parse(endAt instanceof Date ? endAt.toISOString() : endAt) : null;
  const nowMs = now.getTime();
  if (Number.isFinite(startMs) && nowMs < startMs) return 'UPCOMING';
  if (Number.isFinite(endMs) && nowMs >= endMs) return 'ENDED';
  return 'ACTIVE';
}

function normalizeDbPromotionRow(row) {
  if (!row || typeof row !== 'object') return null;
  return normalizePromotionRecord({
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    type: row.type,
    description: row.description || '',
    startAt: isoOrNull(row.start_at),
    endAt: isoOrNull(row.end_at),
    channels: row.channels || [],
    scope: row.scope || {},
    config: row.config || {},
    exposeToCreators: row.expose_to_creators,
    allowedCreatorIds: row.allowed_creator_ids,
    humanReadableRule: row.human_readable_rule || '',
    status: row.status || computePromotionStatusFromRecord(row),
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
    deletedAt: isoOrNull(row.deleted_at),
  });
}

async function fetchMerchantPromotionsFromDb(merchantId) {
  const mid = String(merchantId || '').trim();
  if (!mid || !PROMO_DB_DIRECT_READ_ENABLED || !process.env.DATABASE_URL) return null;
  const result = await query(
    `
      SELECT
        id,
        merchant_id,
        name,
        type,
        description,
        start_at,
        end_at,
        channels,
        scope,
        config,
        expose_to_creators,
        allowed_creator_ids,
        human_readable_rule,
        created_at,
        updated_at,
        deleted_at
      FROM promotions
      WHERE merchant_id = $1
        AND deleted_at IS NULL
      ORDER BY start_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 200
    `,
    [mid]
  );
  return (result.rows || []).map(normalizeDbPromotionRow).filter(Boolean);
}

// Note: Each promotion belongs to exactly one merchant (merchantId at root).
// Scope only targets products/categories/brands; it should not carry merchantIds.
// The DEFAULT_PROMOTIONS demo seed (a global FLASH_SALE + a 15%-off MULTI_BUY,
// both "valid" through 2026) was removed in the 2026-08-11 fabrication-belt fix:
// a promotions store must start empty — demo discounts are test fixtures, not
// seed data. Local mode still persists real writes to STORE_PATH.

function ensureStoreDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadPromotionsLocal() {
  // Only explicit local mode may read the file store; 'none' serves nothing.
  if (!localModeEnabled()) return [];
  ensureStoreDir();
  if (!fs.existsSync(STORE_PATH)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map(normalizePromotionRecord);
  } catch (e) {
    console.error('[promotionStore] Failed to load local promotions:', e.message);
    return [];
  }
}

function savePromotionsLocal(promos) {
  ensureStoreDir();
  // strip any legacy scope.merchantIds before persisting
  const cleaned = promos.map((p) => ({
    ...p,
    scope: {
      ...(p.scope || {}),
      merchantIds: undefined,
    },
  }));
  fs.writeFileSync(STORE_PATH, JSON.stringify(cleaned, null, 2), 'utf-8');
}

async function fetchRemote(path, method = 'GET', body) {
  if (!USE_REMOTE_PROMO) {
    throw new Error('Remote promotions not enabled');
  }
  const url = `${PROMO_BACKEND_BASE.replace(/\/$/, '')}${path}`;
  const timeoutMs = Math.max(
    1000,
    Number(process.env.PROMO_UPSTREAM_TIMEOUT_MS ?? 8000) || 8000
  );
  const config = {
    method,
    url,
    headers: {
      'X-ADMIN-KEY': PROMO_ADMIN_KEY,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
  };
  if (body && method !== 'GET') {
    config.data = body;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios(config);
      return res.data;
    } catch (err) {
      const isTimeout = err && err.code === 'ECONNABORTED';
      if (isTimeout && attempt === 1) {
        continue;
      }
      throw err;
    }
  }
}

async function getAllPromotions() {
  console.log(
    '[promotionStore] getAllPromotions mode=%s backendBase=%s useRemote=%s',
    PROMO_MODE,
    PROMO_BACKEND_BASE,
    USE_REMOTE_PROMO
  );
  if (!USE_REMOTE_PROMO) {
    const promos = loadPromotionsLocal();
    setLastKnownPromotions(promos);
    return promos;
  }

  if (isRemotePromotionsCacheFresh()) {
    return lastKnownPromotions;
  }

  if (!remotePromotionsRefreshPromise) {
    remotePromotionsRefreshPromise = (async () => {
      try {
        const data = await fetchRemote('/agent/internal/promotions', 'GET');
        const promos = (data.promotions || []).map(normalizePromotionRecord);
        setLastKnownPromotions(promos);
        return promos;
      } catch (err) {
        console.error(
          '[promotionStore] Failed to fetch remote promotions, falling back to cache:',
          err.message
        );
        return lastKnownPromotions;
      } finally {
        remotePromotionsRefreshPromise = null;
      }
    })();
  }

  if (PROMO_REMOTE_STALE_WHILE_REVALIDATE && hasRemotePromotionsCacheSnapshot()) {
    return lastKnownPromotions;
  }

  return remotePromotionsRefreshPromise;
}

async function getPromotionsForMerchant(merchantId) {
  const mid = String(merchantId || '').trim();
  if (!mid) return [];

  if (!USE_REMOTE_PROMO) {
    const promos = loadPromotionsLocal().filter((promo) => String(promo?.merchantId || '').trim() === mid);
    setLastKnownMerchantPromotions(mid, promos);
    return promos;
  }

  const snapshot = getLastKnownMerchantPromotionsSnapshot(mid);
  if (isMerchantPromotionsCacheFresh(mid)) {
    return snapshot.promotions;
  }

  if (PROMO_DB_DIRECT_READ_ENABLED && process.env.DATABASE_URL) {
    try {
      const dbPromos = await fetchMerchantPromotionsFromDb(mid);
      if (Array.isArray(dbPromos)) {
        setLastKnownMerchantPromotions(mid, dbPromos);
        return dbPromos;
      }
    } catch (err) {
      console.warn(
        '[promotionStore] Failed to fetch merchant promotions from DB, falling back to remote:',
        mid,
        err.message
      );
    }
  }

  if (!remotePromotionsRefreshByMerchant.has(mid)) {
    const refresh = (async () => {
      try {
        const path =
          `/agent/internal/promotions?merchantId=${encodeURIComponent(mid)}&limit=200`;
        const data = await fetchRemote(path, 'GET');
        const promos = (data.promotions || []).map(normalizePromotionRecord);
        setLastKnownMerchantPromotions(mid, promos);
        return promos;
      } catch (err) {
        console.error(
          '[promotionStore] Failed to fetch remote merchant promotions, falling back to cache:',
          mid,
          err.message
        );
        return snapshot ? snapshot.promotions : [];
      } finally {
        remotePromotionsRefreshByMerchant.delete(mid);
      }
    })();
    remotePromotionsRefreshByMerchant.set(mid, refresh);
  }

  const refreshPromise = remotePromotionsRefreshByMerchant.get(mid);
  if (PROMO_REMOTE_STALE_WHILE_REVALIDATE && snapshot) {
    return snapshot.promotions;
  }
  return refreshPromise;
}

async function getPromotionById(id) {
  if (!USE_REMOTE_PROMO) {
    return loadPromotionsLocal().find((p) => p.id === id && !p.deletedAt);
  }
  try {
    const data = await fetchRemote(`/agent/internal/promotions/${id}`, 'GET');
    return normalizePromotionRecord(data.promotion);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return null;
    }
    console.error('[promotionStore] Failed to fetch remote promotion:', err.message);
    return null;
  }
}

async function upsertPromotion(promo) {
  const now = new Date().toISOString();

  if (!USE_REMOTE_PROMO) {
    if (!localModeEnabled()) {
      // 'none' mode: refuse loudly rather than write to a file no reader serves.
      throw new Error(
        '[promotionStore] promotions store not configured (mode "none"); set PROMOTIONS_MODE=remote with a backend base, or PROMOTIONS_MODE=local for the dev file store'
      );
    }
    const promos = loadPromotionsLocal();
    const idx = promos.findIndex((p) => p.id === promo.id);
    if (idx >= 0) {
      promos[idx] = normalizePromotionRecord({ ...promos[idx], ...promo, updatedAt: now });
    } else {
      promos.push(
        normalizePromotionRecord({
          ...promo,
          id: promo.id || randomUUID(),
          createdAt: now,
          updatedAt: now,
        })
      );
    }
    savePromotionsLocal(promos);
    setLastKnownPromotions(promos);
    return promo.id;
  }

  const payload = promo.id ? { ...promo } : { ...promo };
  try {
    const path = promo.id
      ? `/agent/internal/promotions/${promo.id}`
      : '/agent/internal/promotions';
    const method = promo.id ? 'PATCH' : 'POST';
    const data = await fetchRemote(path, method, payload);
    const saved = normalizePromotionRecord(data.promotion);
    // Update cache optimistically
    const idx = lastKnownPromotions.findIndex((p) => p.id === saved.id);
    if (idx >= 0) {
      lastKnownPromotions[idx] = saved;
    } else {
      lastKnownPromotions.push(saved);
    }
    lastKnownPromotionsFetchedAtMs = Date.now();
    return saved.id;
  } catch (err) {
    console.error('[promotionStore] Failed to upsert remote promotion:', err.message);
    throw err;
  }
}

async function softDeletePromotion(id) {
  if (!USE_REMOTE_PROMO) {
    if (!localModeEnabled()) return false; // 'none' mode: nothing exists to delete
    const promos = loadPromotionsLocal();
    const idx = promos.findIndex((p) => p.id === id);
    if (idx >= 0) {
      promos[idx].deletedAt = new Date().toISOString();
      savePromotionsLocal(promos);
      setLastKnownPromotions(promos);
      return true;
    }
    return false;
  }

  try {
    await fetchRemote(`/agent/internal/promotions/${id}`, 'DELETE');
    lastKnownPromotions = lastKnownPromotions.filter((p) => p.id !== id);
    lastKnownPromotionsFetchedAtMs = Date.now();
    return true;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return false;
    }
    console.error('[promotionStore] Failed to delete remote promotion:', err.message);
    return false;
  }
}

function normalizePromotionRecord(promo) {
  if (!promo || typeof promo !== 'object') return promo;
  const scopedMerchant =
    promo.merchantId ||
    promo.merchant_id ||
    (promo.scope?.merchantIds && promo.scope.merchantIds[0]) ||
    null;

  const rawScope = promo.scope && typeof promo.scope === 'object' ? promo.scope : {};
  // Expand productIds so both `gid://shopify/Product/X` and bare `X` forms are present.
  // Covers all existing DB rows on read without a backfill migration; matchesScope
  // already handles GID/numeric equivalence too, but expansion future-proofs any caller
  // that does verbatim .includes() against this field.
  const rawProductIds = rawScope.productIds || rawScope.product_ids || [];
  const normalizedScope = {
    ...rawScope,
    productIds: expandProductIdScope(rawProductIds),
    categoryIds: rawScope.categoryIds || rawScope.category_ids || [],
    brandIds: rawScope.brandIds || rawScope.brand_ids || [],
    global: rawScope.global === true,
  };
  delete normalizedScope.merchantIds;
  delete normalizedScope.merchant_ids;

  if (!scopedMerchant) {
    console.warn(
      '[promotionStore] promotion missing merchantId; leaving unscoped promotion inert',
      promo.id
    );
  }

  return {
    ...promo,
    merchantId: scopedMerchant || '',
    scope: normalizedScope,
  };
}

module.exports = {
  getAllPromotions,
  getPromotionsForMerchant,
  getPromotionById,
  upsertPromotion,
  softDeletePromotion,
  // Local helpers are exported for migration / debugging only
  savePromotions: savePromotionsLocal,
  loadPromotions: loadPromotionsLocal,
  STORE_PATH,
  DEFAULT_MERCHANT_ID,
  // Effective mode after defaulting + production-like degradation — the ONLY
  // truth /debug/promotions-config should report (it used to recompute the old
  // `|| 'local'` default independently and could disagree with the store).
  PROMO_MODE,
  USE_REMOTE_PROMO,
  normalizePromotionRecord,
  normalizeDbPromotionRow,
  fetchMerchantPromotionsFromDb,
};

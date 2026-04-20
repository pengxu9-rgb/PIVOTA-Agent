const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { query } = require('./db');

const STORE_PATH = path.join(__dirname, '..', 'data', 'promotions.json');

// Default demo merchant id for local promotion fixtures.
const DEFAULT_MERCHANT_ID = 'merch_208139f7600dbf42';

// Remote backend configuration (pivota-backend internal API)
const PROMO_BACKEND_BASE =
  process.env.PROMOTIONS_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE || '';
const PROMO_ADMIN_KEY =
  process.env.PROMOTIONS_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const PROMO_MODE = process.env.PROMOTIONS_MODE || 'local'; // 'local' | 'remote'
const USE_REMOTE_PROMO = !!PROMO_BACKEND_BASE && PROMO_MODE !== 'local';
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
const DEFAULT_PROMOTIONS = [
  {
    id: 'promo_flash_demo_001',
    name: 'Flash deal - Winter picks',
    type: 'FLASH_SALE',
    description: 'Limited-time flash sale on featured items',
    startAt: '2024-01-01T00:00:00Z',
    endAt: '2026-12-31T23:59:59Z',
    channels: ['creator_agents'],
    merchantId: DEFAULT_MERCHANT_ID,
    scope: {
      productIds: [],
      categoryIds: [],
      brandIds: [],
      global: true,
    },
    config: {
      kind: 'FLASH_SALE',
      flashPrice: 0,
      originalPrice: 0,
      stockLimit: undefined,
    },
    exposeToCreators: true,
    allowedCreatorIds: [],
    humanReadableRule: 'Flash deal',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  },
  {
    id: 'promo_bundle_demo_001',
    name: 'Bundle & Save 3+',
    type: 'MULTI_BUY_DISCOUNT',
    description: 'Buy 3 items, get 15% off',
    startAt: '2024-01-01T00:00:00Z',
    endAt: '2026-12-31T23:59:59Z',
    channels: ['creator_agents'],
    merchantId: DEFAULT_MERCHANT_ID,
    scope: {
      productIds: [],
      categoryIds: [],
      brandIds: [],
      global: true,
    },
    config: {
      kind: 'MULTI_BUY_DISCOUNT',
      thresholdQuantity: 3,
      discountPercent: 15,
    },
    exposeToCreators: true,
    allowedCreatorIds: [],
    humanReadableRule: 'Bundle & save',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  },
];

function ensureStoreDir() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadPromotionsLocal() {
  ensureStoreDir();
  if (!fs.existsSync(STORE_PATH)) {
    // Only seed demo data when explicitly running in local mode; production
    // should not silently create demo promotions.
    if (PROMO_MODE === 'local') {
      fs.writeFileSync(STORE_PATH, JSON.stringify(DEFAULT_PROMOTIONS, null, 2), 'utf-8');
      return [...DEFAULT_PROMOTIONS];
    }
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
  const normalizedScope = {
    ...rawScope,
    productIds: rawScope.productIds || rawScope.product_ids || [],
    categoryIds: rawScope.categoryIds || rawScope.category_ids || [],
    brandIds: rawScope.brandIds || rawScope.brand_ids || [],
    global: rawScope.global === true,
  };
  delete normalizedScope.merchantIds;
  delete normalizedScope.merchant_ids;

  if (!scopedMerchant) {
    console.warn(
      '[promotionStore] promotion missing merchantId; assigning default_merchant',
      promo.id
    );
  }

  return {
    ...promo,
    merchantId: scopedMerchant || DEFAULT_MERCHANT_ID,
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
  normalizePromotionRecord,
  normalizeDbPromotionRow,
  fetchMerchantPromotionsFromDb,
};

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'promotions.json');

// Default demo merchant id. This is aligned with the mock products merchant
// so that demo promotions apply to the same catalog in MOCK mode.
const DEFAULT_MERCHANT_ID = 'merch_208139f7600dbf42';

// Remote backend configuration (pivota-backend internal API)
const PROMO_BACKEND_BASE =
  process.env.PROMOTIONS_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE || '';
const PROMO_ADMIN_KEY =
  process.env.PROMOTIONS_ADMIN_KEY || process.env.ADMIN_API_KEY || '';
const PROMO_MODE = process.env.PROMOTIONS_MODE || 'local'; // 'local' | 'remote'
const USE_REMOTE_PROMO = !!PROMO_BACKEND_BASE && PROMO_MODE !== 'local';

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
    lastKnownPromotions = promos;
    return promos;
  }
  try {
    const data = await fetchRemote('/agent/internal/promotions', 'GET');
    const promos = (data.promotions || []).map(normalizePromotionRecord);
    lastKnownPromotions = promos;
    return promos;
  } catch (err) {
    console.error(
      '[promotionStore] Failed to fetch remote promotions, falling back to cache:',
      err.message
    );
    return lastKnownPromotions;
  }
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
    lastKnownPromotions = promos;
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
      lastKnownPromotions = promos;
      return true;
    }
    return false;
  }

  try {
    await fetchRemote(`/agent/internal/promotions/${id}`, 'DELETE');
    lastKnownPromotions = lastKnownPromotions.filter((p) => p.id !== id);
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

  const normalizedScope = {
    productIds: promo.scope?.productIds || promo.scope?.product_ids || [],
    categoryIds: promo.scope?.categoryIds || promo.scope?.category_ids || [],
    brandIds: promo.scope?.brandIds || promo.scope?.brand_ids || [],
    global: promo.scope?.global === true,
  };

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
  getPromotionById,
  upsertPromotion,
  softDeletePromotion,
  // Local helpers are exported for migration / debugging only
  savePromotions: savePromotionsLocal,
  loadPromotions: loadPromotionsLocal,
  STORE_PATH,
  DEFAULT_MERCHANT_ID,
  normalizePromotionRecord,
};

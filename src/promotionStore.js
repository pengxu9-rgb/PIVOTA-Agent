const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'promotions.json');

const DEFAULT_MERCHANT_ID = 'default_merchant';

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

function loadPromotions() {
  ensureStoreDir();
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(DEFAULT_PROMOTIONS, null, 2), 'utf-8');
    return [...DEFAULT_PROMOTIONS];
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map(normalizePromotionRecord);
  } catch (e) {
    return [];
  }
}

function savePromotions(promos) {
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

function getAllPromotions() {
  return loadPromotions();
}

function getPromotionById(id) {
  return loadPromotions().find((p) => p.id === id && !p.deletedAt);
}

function upsertPromotion(promo) {
  const now = new Date().toISOString();
  const promos = loadPromotions();
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
  savePromotions(promos);
  return promo.id;
}

function softDeletePromotion(id) {
  const promos = loadPromotions();
  const idx = promos.findIndex((p) => p.id === id);
  if (idx >= 0) {
    promos[idx].deletedAt = new Date().toISOString();
    savePromotions(promos);
    return true;
  }
  return false;
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
  savePromotions,
  loadPromotions,
  STORE_PATH,
  DEFAULT_MERCHANT_ID,
  normalizePromotionRecord,
};

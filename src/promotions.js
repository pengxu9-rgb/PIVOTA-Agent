/**
 * Minimal promotion config + helpers for deal enrichment.
 * This is intentionally static for now; later it can be backed by DB/portal.
 */

// Promotion seed data (demo)
const PROMOTIONS = [
  {
    id: 'promo_flash_demo_001',
    name: 'Flash deal - Winter picks',
    type: 'FLASH_SALE',
    description: 'Limited-time flash sale on featured items',
    startAt: '2024-01-01T00:00:00Z',
    endAt: '2026-12-31T23:59:59Z',
    scope: {
      global: true,
      productIds: [],
      categoryIds: [],
      brandIds: [],
    },
    config: {
      kind: 'FLASH_SALE',
      flashPrice: 0, // will be derived per product if set; keep zero to skip override
      originalPrice: 0,
      stockLimit: undefined,
    },
    humanReadableRule: 'Flash deal',
  },
  {
    id: 'promo_bundle_demo_001',
    name: 'Bundle & Save 3+',
    type: 'MULTI_BUY_DISCOUNT',
    description: 'Buy 3 items, get 15% off',
    startAt: '2024-01-01T00:00:00Z',
    endAt: '2026-12-31T23:59:59Z',
    scope: {
      global: true,
      productIds: [],
      categoryIds: [],
      brandIds: [],
    },
    config: {
      kind: 'MULTI_BUY_DISCOUNT',
      thresholdQuantity: 3,
      discountPercent: 15,
    },
    humanReadableRule: 'Bundle & save',
  },
];

function getActivePromotions(now = new Date()) {
  const ts = now.getTime();
  return PROMOTIONS.filter((promo) => {
    const start = new Date(promo.startAt).getTime();
    const end = new Date(promo.endAt).getTime();
    return ts >= start && ts <= end;
  });
}

module.exports = {
  PROMOTIONS,
  getActivePromotions,
};

const { randomUUID } = require('crypto');

const loggerBase = require('../../logger');
const {
  getAllPromotions: getAllPromotionsBase,
} = require('../../promotionStore');

const CHANNEL_CREATOR = 'creator_agents';

function isPromoActive(promo, nowTs) {
  const start = new Date(promo.startAt).getTime();
  const end = new Date(promo.endAt).getTime();
  return nowTs >= start && nowTs <= end && !promo.deletedAt;
}

function matchesScope(promo, product) {
  const scope = promo.scope || {};
  if (scope.global) return true;

  const productId = String(product.product_id || product.id || '');
  if (scope.productIds && scope.productIds.includes(productId)) return true;

  const category = (product.category || product.product_type || '').toLowerCase();
  if (
    scope.categoryIds &&
    scope.categoryIds.some((candidate) =>
      category && category.includes(String(candidate).toLowerCase()),
    )
  ) {
    return true;
  }

  const brand = (product.vendor || product.brand || '').toLowerCase();
  if (
    scope.brandIds &&
    scope.brandIds.some((candidate) =>
      brand && brand.includes(String(candidate).toLowerCase()),
    )
  ) {
    return true;
  }

  return false;
}

function allowedForCreator(promo, creatorId) {
  if (!creatorId) {
    return promo.exposeToCreators !== false;
  }
  if (promo.exposeToCreators === false) return false;
  if (promo.allowedCreatorIds && promo.allowedCreatorIds.length > 0) {
    return promo.allowedCreatorIds.includes(creatorId);
  }
  return true;
}

function findApplicablePromotionsForProduct(product, now, promotions, creatorId) {
  const nowTs = now.getTime();
  const productMerchant = String(product.merchant_id || product.merchantId || '');
  return promotions.filter(
    (promo) =>
      isPromoActive(promo, nowTs) &&
      (!promo.merchantId ||
        !productMerchant ||
        String(promo.merchantId) === productMerchant) &&
      matchesScope(promo, product) &&
      Array.isArray(promo.channels) &&
      promo.channels.includes(CHANNEL_CREATOR) &&
      allowedForCreator(promo, creatorId),
  );
}

function computeUrgency(endAt) {
  if (!endAt) return 'LOW';
  const end = new Date(endAt).getTime();
  const now = Date.now();
  const diffMs = end - now;
  if (diffMs <= 0) return 'LOW';
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours <= 1) return 'HIGH';
  if (diffHours <= 24) return 'MEDIUM';
  return 'LOW';
}

function promotionToDealPayload(promo, productPrice) {
  const base = {
    id: promo.id,
    type: promo.type,
    label: promo.humanReadableRule || promo.name || 'Deal',
  };

  if (promo.config?.kind === 'FLASH_SALE') {
    const flashPrice = promo.config.flashPrice || null;
    const originalPrice =
      promo.config.originalPrice || productPrice || (productPrice === 0 ? 0 : null);
    const discountPercent =
      originalPrice && originalPrice > 0 && flashPrice
        ? Math.round((1 - flashPrice / originalPrice) * 100)
        : undefined;

    return {
      ...base,
      discount_percent: discountPercent,
      flash_price: flashPrice || undefined,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  if (promo.config?.kind === 'MULTI_BUY_DISCOUNT') {
    return {
      ...base,
      discount_percent: promo.config.discountPercent,
      threshold_quantity: promo.config.thresholdQuantity,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  if (promo.config?.kind === 'FREE_SHIPPING' || promo.type === 'FREE_SHIPPING') {
    return {
      ...base,
      free_shipping: true,
      min_subtotal: promo.config?.minSubtotal,
      end_at: promo.endAt,
      urgency_level: computeUrgency(promo.endAt),
    };
  }

  return base;
}

function enrichProductsWithDeals(products, promotions, now = new Date(), creatorId = null) {
  if (!Array.isArray(products) || !products.length) return products;
  return products.map((product) => {
    const applicablePromotions = findApplicablePromotionsForProduct(
      product,
      now,
      promotions,
      creatorId,
    );
    const allDeals = applicablePromotions.map((promotion) =>
      promotionToDealPayload(
        promotion,
        product.price || product.price_cents || product.unit_price,
      ),
    );

    let bestDeal = null;
    if (allDeals.length) {
      bestDeal = allDeals.reduce((best, current) => {
        if (!best) return current;
        const bestDiscount = best.discount_percent || 0;
        const currentDiscount = current.discount_percent || 0;
        if (currentDiscount > bestDiscount) return current;
        if (currentDiscount === bestDiscount) {
          const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
          const bestUrgency = rank[best.urgency_level || 'LOW'];
          const currentUrgency = rank[current.urgency_level || 'LOW'];
          return currentUrgency > bestUrgency ? current : best;
        }
        return best;
      }, null);
    }

    return {
      ...product,
      best_deal: bestDeal || product.best_deal || null,
      all_deals: allDeals.length ? allDeals : product.all_deals,
    };
  });
}

function applyDealsToResponse(upstreamData, promotions, now = new Date(), creatorId = null) {
  if (!upstreamData || !promotions || !promotions.length) {
    return upstreamData;
  }

  const clone = JSON.parse(JSON.stringify(upstreamData));

  if (Array.isArray(clone.products)) {
    clone.products = enrichProductsWithDeals(clone.products, promotions, now, creatorId);
  }

  if (Array.isArray(clone.groups)) {
    clone.groups = clone.groups.map((group) => {
      if (Array.isArray(group.products)) {
        return {
          ...group,
          products: enrichProductsWithDeals(group.products, promotions, now, creatorId),
        };
      }
      return group;
    });
  }

  if (clone.results && typeof clone.results === 'object') {
    const nextResults = {};
    for (const key of Object.keys(clone.results)) {
      const items = clone.results[key];
      nextResults[key] = Array.isArray(items)
        ? enrichProductsWithDeals(items, promotions, now, creatorId)
        : items;
    }
    clone.results = nextResults;
  }

  if (clone.data && Array.isArray(clone.data.products)) {
    clone.data.products = enrichProductsWithDeals(
      clone.data.products,
      promotions,
      now,
      creatorId,
    );
  }

  if (Array.isArray(clone.items)) {
    clone.items = clone.items.map((item) => {
      if (!item || !item.product) return item;

      const enrichedProduct =
        enrichProductsWithDeals([item.product], promotions, now, creatorId)?.[0] ||
        item.product;

      return {
        ...item,
        product: enrichedProduct,
        best_deal: enrichedProduct.best_deal || item.best_deal || null,
        all_deals: enrichedProduct.all_deals || item.all_deals || [],
      };
    });
  }

  return clone;
}

function computeHumanReadableRule(promo) {
  if (promo.humanReadableRule) return promo.humanReadableRule;
  if (promo.config?.kind === 'MULTI_BUY_DISCOUNT') {
    const thresholdQuantity = promo.config.thresholdQuantity;
    const discountPercent = promo.config.discountPercent;
    if (thresholdQuantity && discountPercent) {
      return `Buy ${thresholdQuantity}, get ${discountPercent}% off`;
    }
    return 'Bundle & save';
  }
  if (promo.config?.kind === 'FLASH_SALE') {
    return 'Flash deal';
  }
  return promo.name || 'Deal';
}

function sanitizePromotionForResponse(promo) {
  if (!promo) return promo;
  const scope = promo.scope || {};
  return {
    ...promo,
    merchantId:
      promo.merchantId ||
      promo.merchant_id ||
      scope.merchantIds?.[0] ||
      scope.merchant_ids?.[0] ||
      null,
    scope: {
      productIds: scope.productIds || scope.product_ids || [],
      categoryIds: scope.categoryIds || scope.category_ids || [],
      brandIds: scope.brandIds || scope.brand_ids || [],
      global: scope.global === true,
    },
  };
}

function computePromotionStatus(promo, nowTs) {
  if (promo.deletedAt) return 'ENDED';
  const start = new Date(promo.startAt).getTime();
  const end = new Date(promo.endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 'UNKNOWN';
  if (nowTs < start) return 'UPCOMING';
  if (nowTs > end) return 'ENDED';
  return 'ACTIVE';
}

function validateAndNormalizePromotion(payload, existing = {}, { requireAll = false } = {}) {
  const body = payload?.promotion ?? payload ?? {};
  const merged = { ...existing, ...body };
  const errors = [];

  const type = merged.type || merged.config?.kind || merged.config?.type;
  if (!type && requireAll) errors.push('type is required');
  if (type && !['MULTI_BUY_DISCOUNT', 'FLASH_SALE'].includes(type)) {
    errors.push('type must be MULTI_BUY_DISCOUNT or FLASH_SALE');
  }

  if (!merged.name && requireAll) errors.push('name is required');

  const startTs = merged.startAt ? new Date(merged.startAt).getTime() : NaN;
  const endTs = merged.endAt ? new Date(merged.endAt).getTime() : NaN;
  if (requireAll && Number.isNaN(startTs)) errors.push('startAt is required and must be a date');
  if (requireAll && Number.isNaN(endTs)) errors.push('endAt is required and must be a date');
  if (!Number.isNaN(startTs) && !Number.isNaN(endTs) && endTs <= startTs) {
    errors.push('endAt must be after startAt');
  }

  const channels = Array.isArray(merged.channels) ? merged.channels : [];
  if (requireAll && channels.length === 0) {
    errors.push('channels must be a non-empty array');
  }

  const merchantId =
    merged.merchantId ||
    merged.merchant_id ||
    merged.scope?.merchantIds?.[0] ||
    merged.scope?.merchant_ids?.[0] ||
    null;
  if (requireAll && !merchantId) {
    errors.push('merchantId is required');
  }

  const scope = merged.scope || {};
  const normalizedScope = {
    productIds: scope.productIds || [],
    categoryIds: scope.categoryIds || [],
    brandIds: scope.brandIds || [],
    global: scope.global === true,
  };

  const config = merged.config || {};
  if (type === 'FLASH_SALE') {
    const flashPrice = Number(config.flashPrice ?? merged.flashPrice ?? 0);
    const originalPrice = Number(config.originalPrice ?? merged.originalPrice ?? 0);
    if (requireAll && Number.isNaN(flashPrice)) errors.push('flashPrice must be a number');
    if (requireAll && Number.isNaN(originalPrice)) errors.push('originalPrice must be a number');
    merged.config = {
      kind: 'FLASH_SALE',
      flashPrice,
      originalPrice,
      ...(config.stockLimit !== undefined ? { stockLimit: config.stockLimit } : {}),
    };
  } else if (type === 'MULTI_BUY_DISCOUNT') {
    const thresholdQuantity = Number(config.thresholdQuantity ?? merged.thresholdQuantity ?? 0);
    const discountPercent = Number(config.discountPercent ?? merged.discountPercent ?? 0);
    if (requireAll && (!thresholdQuantity || Number.isNaN(thresholdQuantity))) {
      errors.push('thresholdQuantity must be provided for MULTI_BUY_DISCOUNT');
    }
    if (
      requireAll &&
      (Number.isNaN(discountPercent) || discountPercent <= 0 || discountPercent > 100)
    ) {
      errors.push('discountPercent must be between 1 and 100');
    }
    merged.config = {
      kind: 'MULTI_BUY_DISCOUNT',
      thresholdQuantity,
      discountPercent,
    };
  }

  if (errors.length) {
    return { error: errors.join('; ') };
  }

  const promotion = {
    id: merged.id || merged.promotion_id || randomUUID(),
    name: merged.name,
    type,
    description: merged.description || '',
    startAt: merged.startAt,
    endAt: merged.endAt,
    merchantId,
    channels: channels.length ? channels : merged.channels || [],
    scope: normalizedScope,
    config: merged.config,
    exposeToCreators: merged.exposeToCreators !== false,
    allowedCreatorIds: merged.allowedCreatorIds || [],
    humanReadableRule: '',
    createdAt: merged.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: merged.deletedAt || null,
  };

  promotion.humanReadableRule = computeHumanReadableRule(promotion);
  return { promotion };
}

async function getActivePromotions(
  now = new Date(),
  creatorId = null,
  {
    getAllPromotions = getAllPromotionsBase,
    logger = loggerBase,
  } = {},
) {
  let promotions = [];
  try {
    promotions = await getAllPromotions();
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to load promotions');
    promotions = [];
  }

  return promotions
    .filter((promotion) => !promotion.deletedAt)
    .map((promotion) => ({
      ...promotion,
      humanReadableRule: computeHumanReadableRule(promotion),
    }));
}

module.exports = {
  CHANNEL_CREATOR,
  isPromoActive,
  matchesScope,
  allowedForCreator,
  findApplicablePromotionsForProduct,
  computeUrgency,
  promotionToDealPayload,
  enrichProductsWithDeals,
  applyDealsToResponse,
  computeHumanReadableRule,
  sanitizePromotionForResponse,
  computePromotionStatus,
  validateAndNormalizePromotion,
  getActivePromotions,
};

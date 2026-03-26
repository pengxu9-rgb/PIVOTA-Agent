const {
  recommendPdpProducts: recommendPdpProductsBase,
} = require('../pdp/runtime');
const {
  fetchProductDetailForOffers: fetchProductDetailForOffersBase,
} = require('./productDetailAdapters');
const {
  getActivePromotions: getActivePromotionsBase,
  applyDealsToResponse: applyDealsToResponseBase,
} = require('../promotions');

async function handleFindSimilarProductsInvoke({
  payload,
  metadata,
  creatorId,
  now,
  checkoutToken,
  hasDatabase,
  isCreatorUiSource,
  findSimilarCreatorFromCache,
  getActivePromotions = getActivePromotionsBase,
  applyDealsToResponse = applyDealsToResponseBase,
  fetchProductDetailForOffers = fetchProductDetailForOffersBase,
  recommendPdpProducts = recommendPdpProductsBase,
  logger,
} = {}) {
  const source = metadata?.source;
  const isCreatorUi = Boolean(
    typeof isCreatorUiSource === 'function' && isCreatorUiSource(source),
  );

  if (isCreatorUi && hasDatabase) {
    try {
      const sim = payload?.similar || {};
      const productId = sim.product_id || payload?.product_id;
      const limit = sim.limit || payload?.limit || 9;
      const cached = await findSimilarCreatorFromCache(creatorId, productId, limit);
      if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
        const promotions = await getActivePromotions(now, creatorId);
        return {
          handled: true,
          statusCode: 200,
          body: applyDealsToResponse(cached, promotions, now, creatorId),
        };
      }
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), creatorId, source },
        'Creator UI cache similarity failed; falling back to upstream',
      );
    }
  }

  try {
    const sim = payload?.similar || {};
    const productId = String(sim.product_id || payload?.product_id || '').trim();
    const merchantId = String(sim.merchant_id || payload?.merchant_id || '').trim();
    const limit = Math.max(1, Math.min(Number(sim.limit || payload?.limit || 6) || 6, 30));
    const bypassCache =
      payload?.options?.no_cache === true ||
      payload?.options?.cache_bypass === true ||
      payload?.options?.bypass_cache === true ||
      sim?.options?.no_cache === true ||
      sim?.options?.cache_bypass === true ||
      sim?.options?.bypass_cache === true;
    const debugEnabled =
      payload?.options?.debug === true ||
      sim?.options?.debug === true;

    if (productId) {
      const baseProduct =
        (merchantId
          ? await fetchProductDetailForOffers({
              merchantId,
              productId,
              checkoutToken,
            }).catch(() => null)
          : null) || { merchant_id: merchantId || null, product_id: productId };

      const rec = await recommendPdpProducts({
        pdp_product: baseProduct,
        k: limit,
        locale:
          payload?.context?.locale ||
          payload?.context?.language ||
          payload?.locale ||
          'en-US',
        currency: baseProduct.currency || baseProduct.price?.currency || 'USD',
        options: {
          debug: debugEnabled,
          no_cache: bypassCache,
          cache_bypass: bypassCache,
          bypass_cache: bypassCache,
        },
      });

      const products = Array.isArray(rec?.items) ? rec.items : [];
      const baseResponse = {
        status: 'success',
        strategy: 'related_products',
        products,
        total: products.length,
        page: 1,
        page_size: products.length,
      };

      return {
        handled: true,
        statusCode: 200,
        body: debugEnabled
          ? {
              ...baseResponse,
              debug: rec?.debug || null,
              cache: rec?.cache || null,
            }
          : baseResponse,
      };
    }
  } catch (err) {
    logger.warn(
      {
        err: err?.message || String(err),
        product_id: payload?.similar?.product_id || payload?.product_id,
      },
      'find_similar_products: local recommendations failed; falling back to upstream',
    );
  }

  const sim = payload?.similar || {};
  return {
    handled: false,
    requestBody: {
      operation: 'find_similar_products',
      payload: {
        product_id: sim.product_id || payload?.product_id,
        merchant_id: sim.merchant_id || payload?.merchant_id,
        limit: sim.limit || payload?.limit,
        strategy: sim.strategy || payload?.strategy,
        user: sim.user || payload?.user,
        creator_id:
          payload?.creator_id ||
          sim.creator_id ||
          metadata?.creator_id ||
          undefined,
        metadata,
      },
      metadata,
    },
  };
}

module.exports = {
  handleFindSimilarProductsInvoke,
};

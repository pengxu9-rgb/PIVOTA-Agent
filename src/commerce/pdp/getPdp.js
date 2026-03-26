const { getPdpOptions: getPdpOptionsBase } = require('./options');
const {
  buildPdpPayload: buildPdpPayloadBase,
  recommendPdpProducts: recommendPdpProductsBase,
} = require('./runtime');
const {
  extractUpstreamErrorCode: extractUpstreamErrorCodeBase,
} = require('../shared/extractUpstreamErrorCode');
const {
  fetchProductDetailFromUpstream: fetchProductDetailFromUpstreamBase,
} = require('../catalog/productDetailAdapters');

function shouldBypassRecommendationCache(payload) {
  return (
    payload?.options?.no_cache === true ||
    payload?.options?.cache_bypass === true ||
    payload?.options?.bypass_cache === true
  );
}

async function handleGetPdpOperation({
  operation,
  payload,
  checkoutToken,
  defaultMerchantId,
  getPdpOptions = getPdpOptionsBase,
  fetchProductDetailFromUpstream = fetchProductDetailFromUpstreamBase,
  recommendPdpProducts = recommendPdpProductsBase,
  buildPdpPayload = buildPdpPayloadBase,
  extractUpstreamErrorCode = extractUpstreamErrorCodeBase,
  logger,
} = {}) {
  if (String(operation || '').trim() !== 'get_pdp') {
    return { handled: false };
  }

  try {
    const productId = payload?.product?.product_id || payload?.product_id;
    const merchantId =
      payload?.product?.merchant_id ||
      payload?.merchant_id ||
      payload?.search?.merchant_id ||
      defaultMerchantId;

    if (!productId || !merchantId) {
      return {
        handled: true,
        statusCode: 400,
        body: {
          error: 'MISSING_PARAMETERS',
          message: 'merchant_id and product_id are required for get_pdp',
        },
      };
    }

    const pdpOptions = getPdpOptions(payload);
    const product = await fetchProductDetailFromUpstream({
      merchantId,
      productId,
      skuId: payload?.product?.sku_id,
      checkoutToken,
    });

    if (!product) {
      return {
        handled: true,
        statusCode: 404,
        body: {
          error: 'PRODUCT_NOT_FOUND',
          message: 'Product not found',
        },
      };
    }

    let relatedProducts = [];
    if (pdpOptions.includeRecommendations) {
      const bypassCache = shouldBypassRecommendationCache(payload);
      try {
        const rec = await recommendPdpProducts({
          pdp_product: product,
          k: payload?.recommendations?.limit || 6,
          locale:
            payload?.context?.locale ||
            payload?.context?.language ||
            payload?.locale ||
            'en-US',
          currency: product.currency || 'USD',
          options: {
            debug: pdpOptions.debug,
            no_cache: bypassCache,
            cache_bypass: bypassCache,
            bypass_cache: bypassCache,
          },
        });
        relatedProducts = Array.isArray(rec?.items) ? rec.items : [];
      } catch (err) {
        logger.warn(
          { err: err?.message || String(err), merchantId, productId },
          'PDP recommendations failed; returning without recommendations module',
        );
        relatedProducts = [];
      }
    }

    const pdpPayload = buildPdpPayload({
      product,
      relatedProducts,
      entryPoint: pdpOptions.entryPoint,
      experiment: pdpOptions.experiment,
      templateHint: pdpOptions.templateHint,
      includeEmptyReviews: pdpOptions.includeEmptyReviews,
      debug: pdpOptions.debug,
    });

    return {
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        product,
        pdp_payload: pdpPayload,
      },
    };
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 502;
    logger.error({ err: err?.message || String(err) }, 'get_pdp failed');
    return {
      handled: true,
      statusCode,
      body: {
        error: code || 'GET_PDP_FAILED',
        message: message || 'Failed to build pdp payload',
        details: data || null,
      },
    };
  }
}

module.exports = {
  handleGetPdpOperation,
};

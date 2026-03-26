const {
  extractUpstreamErrorCode: extractUpstreamErrorCodeBase,
} = require('../shared/extractUpstreamErrorCode');

function resolveProductGroupBypassCache(options) {
  return (
    options.no_cache === true ||
    options.cache_bypass === true ||
    options.bypass_cache === true ||
    String(options.no_cache || '').trim().toLowerCase() === 'true' ||
    String(options.cache_bypass || options.bypass_cache || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

async function handleResolveProductGroupOperation({
  operation,
  payload,
  checkoutToken,
  resolveProductGroupCached,
  extractUpstreamErrorCode = extractUpstreamErrorCodeBase,
  logger,
} = {}) {
  if (String(operation || '').trim() !== 'resolve_product_group') {
    return { handled: false };
  }

  try {
    const productRef = payload?.product_ref || payload?.productRef || payload?.product || {};
    const productId = String(
      productRef.product_id || productRef.productId || payload?.product_id || payload?.productId || '',
    ).trim();
    const merchantId = String(
      productRef.merchant_id || productRef.merchantId || payload?.merchant_id || payload?.merchantId || '',
    ).trim();
    const platform = String(productRef.platform || payload?.platform || '').trim() || null;
    const options = payload?.options || {};
    const debug =
      options.debug === true ||
      String(options.debug || '').trim().toLowerCase() === 'true';
    const bypassCache = resolveProductGroupBypassCache(options);

    if (!productId) {
      return {
        handled: true,
        statusCode: 400,
        body: {
          error: 'MISSING_PARAMETERS',
          message: 'product_ref.product_id is required',
        },
      };
    }

    const result = await resolveProductGroupCached({
      productId,
      merchantId,
      platform,
      checkoutToken,
      bypassCache,
      debug,
    });

    return {
      handled: true,
      statusCode: 200,
      body: result,
    };
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 502;
    logger.error({ err: err?.message || String(err) }, 'resolve_product_group failed');
    return {
      handled: true,
      statusCode,
      body: {
        error: code || 'RESOLVE_PRODUCT_GROUP_FAILED',
        message: message || 'Failed to resolve product group',
        details: data || null,
      },
    };
  }
}

module.exports = {
  handleResolveProductGroupOperation,
};

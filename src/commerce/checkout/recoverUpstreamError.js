async function recoverCheckoutUpstreamError({
  operation,
  err,
  response = null,
  requestBody,
  axiosConfig,
  checkoutToken,
  pivotaApiBase,
  checkoutRetryBaseMs = 120,
  callTrackedUpstream,
  extractUpstreamErrorCode,
  isRetryableQuoteError,
  isPydanticMissingBodyField,
  buildInvokeUpstreamAuthHeaders,
  getUpstreamTimeoutMs,
  sleep,
  randomFn = Math.random,
  onGatewayRetry,
  logger,
} = {}) {
  let nextResponse = response;
  let nextErr = err;

  if (
    !nextResponse &&
    operation === 'create_order' &&
    requestBody &&
    Object.keys(requestBody).length > 0 &&
    typeof isPydanticMissingBodyField === 'function' &&
    isPydanticMissingBodyField(nextErr, 'order_request')
  ) {
    try {
      axiosConfig.data = { order_request: requestBody };
      nextResponse = await callTrackedUpstream(operation, axiosConfig);
    } catch (wrappedErr) {
      nextErr = wrappedErr;
    }
  }

  if (!nextResponse && operation === 'create_order' && axiosConfig?.data) {
    const createOrderBody = axiosConfig.data;
    const normalizedOrderRequest =
      createOrderBody && createOrderBody.order_request
        ? createOrderBody.order_request
        : createOrderBody;
    const quoteId =
      normalizedOrderRequest && typeof normalizedOrderRequest === 'object'
        ? normalizedOrderRequest.quote_id
        : null;
    const { code } =
      typeof extractUpstreamErrorCode === 'function'
        ? extractUpstreamErrorCode(nextErr)
        : { code: null };

    if (quoteId && typeof isRetryableQuoteError === 'function' && isRetryableQuoteError(code)) {
      try {
        const quoteBody = {
          merchant_id: normalizedOrderRequest.merchant_id,
          items: Array.isArray(normalizedOrderRequest.items)
            ? normalizedOrderRequest.items.map((item) => ({
                product_id: item.product_id,
                variant_id: item.variant_id || undefined,
                quantity: item.quantity,
              }))
            : [],
          discount_codes: normalizedOrderRequest.discount_codes || [],
          customer_email: normalizedOrderRequest.customer_email || undefined,
          shipping_address: normalizedOrderRequest.shipping_address || undefined,
          ...(normalizedOrderRequest.selected_delivery_option
            ? {
                selected_delivery_option:
                  normalizedOrderRequest.selected_delivery_option,
              }
            : {}),
        };

        const quoteResp = await callTrackedUpstream('preview_quote', {
          method: 'POST',
          url: `${pivotaApiBase}/agent/v1/quotes/preview`,
          headers: {
            'Content-Type': 'application/json',
            ...(typeof buildInvokeUpstreamAuthHeaders === 'function'
              ? buildInvokeUpstreamAuthHeaders({ checkoutToken })
              : {}),
          },
          timeout:
            typeof getUpstreamTimeoutMs === 'function'
              ? getUpstreamTimeoutMs('preview_quote')
              : 0,
          data: quoteBody,
        });

        const newQuoteId = quoteResp && quoteResp.data ? quoteResp.data.quote_id : null;
        if (newQuoteId) {
          normalizedOrderRequest.quote_id = newQuoteId;
          axiosConfig.data =
            createOrderBody && createOrderBody.order_request
              ? { order_request: normalizedOrderRequest }
              : normalizedOrderRequest;
          nextResponse = await callTrackedUpstream(operation, axiosConfig);
        }
      } catch (_) {
        // Fall through and surface the original upstream error.
      }
    }
  }

  if (!nextResponse && operation === 'submit_payment' && axiosConfig?.data) {
    const { code } =
      typeof extractUpstreamErrorCode === 'function'
        ? extractUpstreamErrorCode(nextErr)
        : { code: null };
    if (code === 'TEMPORARY_UNAVAILABLE') {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          { operation, code },
          'Upstream reported temporary unavailability; retrying submit_payment once',
        );
      }
      const quickRetryDelayMs = Math.min(
        200,
        Math.max(
          120,
          Number(checkoutRetryBaseMs || 120) +
            Math.floor((typeof randomFn === 'function' ? randomFn() : 0) * 80),
        ),
      );
      if (typeof onGatewayRetry === 'function') {
        onGatewayRetry();
      }
      if (typeof sleep === 'function') {
        await sleep(quickRetryDelayMs);
      }
      nextResponse = await callTrackedUpstream(operation, axiosConfig);
    }
  }

  return {
    response: nextResponse,
    err: nextErr,
    axiosConfig,
  };
}

module.exports = {
  recoverCheckoutUpstreamError,
};

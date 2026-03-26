function resolveInvokeUpstreamTimeout({
  operation,
  queryParams,
  rawUserQuery,
  traceQueryClass,
  extractSearchQueryText,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  getUpstreamTimeoutMs,
  findProductsMultiUpstreamLookupTimeoutMs,
  findProductsMultiUpstreamDefaultTimeoutMs,
} = {}) {
  const baseTimeoutMs = Number(
    typeof getUpstreamTimeoutMs === 'function' ? getUpstreamTimeoutMs(operation) : 0,
  ) || 0;
  if (operation !== 'find_products_multi') {
    return baseTimeoutMs;
  }

  const primarySearchQueryText = String(
    (typeof extractSearchQueryText === 'function'
      ? extractSearchQueryText(queryParams)
      : queryParams?.query) || rawUserQuery || '',
  ).trim();
  const primarySearchAnchorTokens =
    typeof extractSearchAnchorTokens === 'function'
      ? extractSearchAnchorTokens(primarySearchQueryText)
      : [];
  const isLookupPolicyQuery =
    typeof isLookupStyleSearchQuery === 'function'
      ? isLookupStyleSearchQuery(primarySearchQueryText, primarySearchAnchorTokens)
      : false;
  const queryClassForBudget = String(traceQueryClass || '').trim().toLowerCase();
  const shouldUseShortSearchBudget =
    isLookupPolicyQuery || ['lookup', 'category', 'attribute'].includes(queryClassForBudget);
  const upstreamBudgetMsForSearch = shouldUseShortSearchBudget
    ? Number(findProductsMultiUpstreamLookupTimeoutMs || baseTimeoutMs)
    : Number(findProductsMultiUpstreamDefaultTimeoutMs || baseTimeoutMs);

  return Math.min(baseTimeoutMs, upstreamBudgetMsForSearch);
}

function buildInvokeAxiosConfig({
  operation,
  route,
  url,
  queryParams,
  requestBody,
  checkoutToken,
  buildQueryString,
  buildInvokeUpstreamAuthHeaders,
  getUpstreamTimeoutMs,
  rawUserQuery,
  traceQueryClass,
  extractSearchQueryText,
  extractSearchAnchorTokens,
  isLookupStyleSearchQuery,
  findProductsMultiUpstreamLookupTimeoutMs,
  findProductsMultiUpstreamDefaultTimeoutMs,
} = {}) {
  const queryString =
    typeof buildQueryString === 'function' ? buildQueryString(queryParams || {}) : '';
  const normalizedRequestBody =
    requestBody && typeof requestBody === 'object' && !Array.isArray(requestBody)
      ? requestBody
      : {};
  const timeout = resolveInvokeUpstreamTimeout({
    operation,
    queryParams,
    rawUserQuery,
    traceQueryClass,
    extractSearchQueryText,
    extractSearchAnchorTokens,
    isLookupStyleSearchQuery,
    getUpstreamTimeoutMs,
    findProductsMultiUpstreamLookupTimeoutMs,
    findProductsMultiUpstreamDefaultTimeoutMs,
  });

  return {
    method: route?.method,
    url: `${url}${queryString}`,
    headers: {
      ...(route?.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      ...(typeof buildInvokeUpstreamAuthHeaders === 'function'
        ? buildInvokeUpstreamAuthHeaders({ checkoutToken })
        : {}),
    },
    timeout,
    ...(route?.method !== 'GET' && Object.keys(normalizedRequestBody).length > 0
      ? { data: normalizedRequestBody }
      : {}),
  };
}

function createTrackedUpstreamCaller({
  callUpstreamWithOptionalRetry,
  checkoutTimingOps,
  onRetry,
  onElapsed,
  now = () => Date.now(),
} = {}) {
  return async (operation, axiosConfig) => {
    const normalizedOp = String(operation || '').trim().toLowerCase();
    const measureCheckout =
      checkoutTimingOps instanceof Set ? checkoutTimingOps.has(normalizedOp) : false;
    const disableTimeoutRetry = normalizedOp === 'find_products';
    const startedAt = measureCheckout ? Number(now()) || 0 : 0;
    try {
      return await callUpstreamWithOptionalRetry(operation, axiosConfig, {
        disableTimeoutRetry,
        onRetry: () => {
          if (measureCheckout && typeof onRetry === 'function') {
            onRetry();
          }
        },
      });
    } finally {
      if (measureCheckout && typeof onElapsed === 'function') {
        onElapsed(Math.max(0, (Number(now()) || 0) - startedAt));
      }
    }
  };
}

module.exports = {
  resolveInvokeUpstreamTimeout,
  buildInvokeAxiosConfig,
  createTrackedUpstreamCaller,
};

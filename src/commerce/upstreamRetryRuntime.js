const axios = require('axios');

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isRetryableQuoteError(code) {
  return code === 'QUOTE_EXPIRED' || code === 'QUOTE_MISMATCH';
}

function isPydanticMissingBodyField(err, fieldName) {
  const resp = err && err.response ? err.response : null;
  if (!resp || resp.status !== 422) return false;
  const data = resp.data;
  const detail = data && typeof data === 'object' ? data.detail : null;
  if (!Array.isArray(detail)) return false;
  return detail.some((item) => {
    const loc = item && typeof item === 'object' ? item.loc : null;
    return Array.isArray(loc) && loc.includes(fieldName);
  });
}

function createUpstreamRetryRuntime({
  axiosClient = axios,
  logger,
  upstreamRetryFindProductsMultiOnTimeout = false,
  upstreamTimeoutFindProductsMultiRetryMs = 18000,
  upstreamTimeoutFindProductsMultiMs = 12000,
  upstreamTimeoutFindProductsRetryMs = 12000,
  upstreamTimeoutFindProductsMs = 8000,
  upstreamTimeoutSearchRetryMs = 10000,
  checkoutRetryMaxAttempts = 2,
  checkoutRetryBaseMs = 120,
  checkoutRetryMaxMs = 800,
  sleep = sleepMs,
  randomFn = Math.random,
} = {}) {
  async function callUpstreamWithOptionalRetry(operation, axiosConfig, options = {}) {
    const disableTimeoutRetry = Boolean(options?.disableTimeoutRetry);
    const timeoutRetryableOps = ['find_products', 'find_similar_products'];
    if (upstreamRetryFindProductsMultiOnTimeout) {
      timeoutRetryableOps.push('find_products_multi');
    }
    timeoutRetryableOps.push('confirm_payment');

    const busyRetryableOps = [
      'find_products',
      'find_products_multi',
      'find_similar_products',
      'get_product_detail',
      'preview_quote',
      'create_order',
      'confirm_payment',
      'submit_payment',
      'get_order_status',
      'request_after_sales',
      'track_product_click',
      'offers.resolve',
    ];

    const checkoutOps = new Set([
      'preview_quote',
      'create_order',
      'confirm_payment',
      'submit_payment',
    ]);

    const normalizedOperation = String(operation || '').trim().toLowerCase();
    const isCheckoutOperation = checkoutOps.has(normalizedOperation);
    const maxBusyAttempts = isCheckoutOperation
      ? checkoutRetryMaxAttempts
      : Math.max(1, Math.min(5, Number(process.env.UPSTREAM_RETRY_MAX_ATTEMPTS || 3)));
    const baseDelayMs = isCheckoutOperation
      ? checkoutRetryBaseMs
      : Math.max(50, Number(process.env.UPSTREAM_RETRY_BASE_MS || 250));
    const capDelayMs = isCheckoutOperation
      ? Math.max(baseDelayMs, checkoutRetryMaxMs)
      : Math.max(baseDelayMs, Number(process.env.UPSTREAM_RETRY_MAX_MS || 2000));
    const onRetry = typeof options?.onRetry === 'function' ? options.onRetry : null;

    function parseRetryAfterMs(headers) {
      if (!headers || typeof headers !== 'object') return null;
      const value = headers['retry-after'] ?? headers['Retry-After'];
      if (!value) return null;
      const text = String(value).trim();
      if (!text) return null;

      const seconds = Number(text);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

      const dateMs = Date.parse(text);
      if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

      return null;
    }

    function isTemporaryUnavailable(err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      const message =
        (data && typeof data === 'object' && data.error && data.error.message) ||
        (data && typeof data === 'object' && data.message) ||
        null;
      const detailError =
        (data &&
          typeof data === 'object' &&
          data.error &&
          data.error.details &&
          data.error.details.error) ||
        null;

      return (
        status === 503 &&
        (message === 'TEMPORARY_UNAVAILABLE' || detailError === 'TEMPORARY_UNAVAILABLE')
      );
    }

    function retryDelayMs(attempt, err) {
      const exp = Math.min(capDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
      const jitter = Math.floor((typeof randomFn === 'function' ? randomFn() : 0) * Math.min(150, exp * 0.2));
      const computed = Math.min(capDelayMs, exp + jitter);
      const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
      if (retryAfterMs != null && Number.isFinite(retryAfterMs)) {
        return Math.min(capDelayMs, Math.max(computed, retryAfterMs));
      }
      return computed;
    }

    function getTimeoutRetryMs(previousTimeoutMs) {
      const prev = Number(previousTimeoutMs || 0) || 0;
      if (normalizedOperation === 'find_products_multi') {
        const bounded = Math.min(
          upstreamTimeoutFindProductsMultiRetryMs,
          Math.max(upstreamTimeoutFindProductsMultiMs, prev + 1200),
        );
        return Math.max(prev, bounded);
      }
      if (normalizedOperation === 'find_products') {
        const bounded = Math.min(
          upstreamTimeoutFindProductsRetryMs,
          Math.max(upstreamTimeoutFindProductsMs, prev + 1000),
        );
        return Math.max(prev, bounded);
      }
      return Math.max(prev, upstreamTimeoutSearchRetryMs);
    }

    const effectiveAxiosClient =
      (typeof options.axiosClient === 'function' && options.axiosClient) ||
      (typeof options.axios === 'function' && options.axios) ||
      axiosClient;

    let attempt = 0;
    while (true) {
      try {
        return await effectiveAxiosClient(axiosConfig);
      } catch (err) {
        attempt += 1;

        if (
          !disableTimeoutRetry &&
          err.code === 'ECONNABORTED' &&
          timeoutRetryableOps.includes(normalizedOperation) &&
          attempt === 1
        ) {
          const previousTimeoutMs = Number(axiosConfig?.timeout || 0) || null;
          const retryTimeoutMs = getTimeoutRetryMs(previousTimeoutMs);
          if (retryTimeoutMs && retryTimeoutMs !== previousTimeoutMs) {
            axiosConfig.timeout = retryTimeoutMs;
          }
          if (logger && typeof logger.warn === 'function') {
            logger.warn(
              {
                url: axiosConfig.url,
                operation: normalizedOperation,
                previous_timeout_ms: previousTimeoutMs,
                retry_timeout_ms: axiosConfig?.timeout || null,
              },
              'Upstream timeout, retrying once',
            );
          }
          if (onRetry) {
            onRetry({
              operation: normalizedOperation,
              reason: 'timeout',
              attempt,
              max_attempts: 2,
              delay_ms: 0,
            });
          }
          continue;
        }

        if (
          isTemporaryUnavailable(err) &&
          busyRetryableOps.includes(normalizedOperation) &&
          attempt < maxBusyAttempts
        ) {
          const delayMs = retryDelayMs(attempt, err);
          if (logger && typeof logger.warn === 'function') {
            logger.warn(
              {
                url: axiosConfig.url,
                operation: normalizedOperation,
                attempt,
                max_attempts: maxBusyAttempts,
                delay_ms: delayMs,
              },
              'Upstream temporary unavailable, retrying',
            );
          }
          if (onRetry) {
            onRetry({
              operation: normalizedOperation,
              reason: 'temporary_unavailable',
              attempt,
              max_attempts: maxBusyAttempts,
              delay_ms: delayMs,
            });
          }
          await sleep(delayMs);
          continue;
        }

        throw err;
      }
    }
  }

  return {
    callUpstreamWithOptionalRetry,
    isRetryableQuoteError,
    isPydanticMissingBodyField,
    sleepMs: sleep,
  };
}

module.exports = {
  createUpstreamRetryRuntime,
  isRetryableQuoteError,
  isPydanticMissingBodyField,
  sleepMs,
};

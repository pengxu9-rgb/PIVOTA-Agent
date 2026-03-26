const HYBRID_MOCK_OPERATIONS = new Set(['submit_payment', 'request_after_sales']);

function prepareInvokeExecutionMode({
  req,
  operation,
  payload,
  effectivePayload,
  metadata,
  apiMode,
  useMock = false,
  useHybrid = false,
  applyGatewayGuardrails,
  logger,
} = {}) {
  logger?.info?.({ api_mode: apiMode, operation }, `API Mode: ${apiMode}, Operation: ${operation}`);

  const checkoutToken =
    String(req?.header?.('X-Checkout-Token') || req?.header?.('x-checkout-token') || '').trim() ||
    null;

  const guardrails = applyGatewayGuardrails({
    req,
    operation,
    payload,
    effectivePayload,
    metadata,
  });
  if (guardrails?.blocked) {
    const retryAfterSec = Number(guardrails.blocked.retryAfterSec || 0) || 0;
    return {
      handled: true,
      statusCode: guardrails.blocked.status,
      body: guardrails.blocked.body,
      headers:
        retryAfterSec > 0
          ? {
              'Retry-After': String(Math.max(1, retryAfterSec)),
            }
          : null,
      checkoutToken,
      shouldUseMock: false,
    };
  }

  if (useHybrid) {
    logger?.info?.(
      { operation },
      HYBRID_MOCK_OPERATIONS.has(operation)
        ? 'Hybrid mode: Using mock for this operation'
        : 'Hybrid mode: Using real API for this operation',
    );
  }

  return {
    handled: false,
    statusCode: null,
    body: null,
    headers: null,
    checkoutToken,
    shouldUseMock: useMock || (useHybrid && HYBRID_MOCK_OPERATIONS.has(operation)),
  };
}

function sendInvokeOperationResponse({
  res,
  invokeResult,
  checkoutRuntime,
} = {}) {
  if (invokeResult?.headers && typeof invokeResult.headers === 'object') {
    Object.entries(invokeResult.headers).forEach(([headerName, headerValue]) => {
      if (headerValue != null) {
        res.setHeader(headerName, headerValue);
      }
    });
  }

  if (invokeResult?.checkoutRuntime && checkoutRuntime) {
    checkoutRuntime.checkoutTraceId = invokeResult.checkoutRuntime.checkoutTraceId;
    checkoutRuntime.paymentStatus = invokeResult.checkoutRuntime.paymentStatus;
    checkoutRuntime.confirmationOwner = invokeResult.checkoutRuntime.confirmationOwner;
    checkoutRuntime.requiresClientConfirmation =
      invokeResult.checkoutRuntime.requiresClientConfirmation;
  }

  return res.status(invokeResult?.statusCode || 200).json(invokeResult?.body);
}

function handleUnhandledInvokeRequestError({
  err,
  res,
  gatewayRequestId,
  logger,
} = {}) {
  if (res?.headersSent) {
    logger?.error?.(
      {
        gateway_request_id: gatewayRequestId,
        err: err?.message || String(err),
        stack: err?.stack || null,
      },
      'Unhandled invoke error after headers sent',
    );
    return null;
  }

  logger?.error?.(
    {
      gateway_request_id: gatewayRequestId,
      err: err?.message || String(err),
      stack: err?.stack || null,
    },
    'Unhandled invoke error',
  );
  return res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'Internal Server Error',
    gateway_request_id: gatewayRequestId,
  });
}

module.exports = {
  HYBRID_MOCK_OPERATIONS,
  prepareInvokeExecutionMode,
  sendInvokeOperationResponse,
  handleUnhandledInvokeRequestError,
};

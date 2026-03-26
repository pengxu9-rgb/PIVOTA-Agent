const {
  buildSearchDebugBundle: buildSearchDebugBundleBase,
  shouldExposeDebugBundle: shouldExposeDebugBundleBase,
  shouldLogDebugBundle: shouldLogDebugBundleBase,
} = require('../observability/debugBundle');

function normalizeFindProductsMultiResponseMetadata({
  body,
  routeContext,
} = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const existingMeta =
    body.metadata &&
    typeof body.metadata === 'object' &&
    !Array.isArray(body.metadata)
      ? body.metadata
      : {};
  const existingSearchDecision =
    existingMeta.search_decision &&
    typeof existingMeta.search_decision === 'object' &&
    !Array.isArray(existingMeta.search_decision)
      ? existingMeta.search_decision
      : {};
  const existingRouteDebugPolicy =
    existingMeta.route_debug &&
    typeof existingMeta.route_debug === 'object' &&
    !Array.isArray(existingMeta.route_debug) &&
    existingMeta.route_debug.policy &&
    typeof existingMeta.route_debug.policy === 'object' &&
    !Array.isArray(existingMeta.route_debug.policy)
      ? existingMeta.route_debug.policy
      : {};
  const defaultExternalFillGateReason =
    String(existingMeta.external_fill_gate_reason || '').trim() ||
    String(existingMeta.external_seed_skip_reason || '').trim() ||
    String(existingMeta.route_health?.external_seed_skip_reason || '').trim() ||
    null;
  const domainFilterDroppedExternal =
    Number(
      existingMeta.domain_filter_dropped_external ??
        existingSearchDecision.domain_filter_dropped_external ??
        existingRouteDebugPolicy?.ambiguity?.domain_filter_dropped_external ??
        0,
    ) || 0;

  return {
    ...body,
    metadata: {
      ...existingMeta,
      orchestrator_version: String(
        process.env.SEARCH_ORCHESTRATOR_VERSION || 'search_orchestrator_unified_v1',
      ),
      orchestrator_path:
        String(routeContext?.orchestrator_path || existingMeta.orchestrator_path || '').trim() ||
        'external_invoke_route',
      semantic_retry_applied: Boolean(existingMeta.semantic_retry_applied),
      semantic_retry_query: existingMeta.semantic_retry_query || null,
      semantic_retry_hits: Math.max(0, Number(existingMeta.semantic_retry_hits || 0) || 0),
      domain_filter_dropped_external: Math.max(0, domainFilterDroppedExternal),
      external_fill_gate_reason: defaultExternalFillGateReason,
    },
  };
}

function decorateInvokeJsonBody({
  req,
  body,
  routeContext,
  gatewayRequestId,
  invokeStartedAtMs,
  debugRuntime,
  buildSearchDebugBundle = buildSearchDebugBundleBase,
  shouldExposeDebugBundle = shouldExposeDebugBundleBase,
  shouldLogDebugBundle = shouldLogDebugBundleBase,
  logger,
} = {}) {
  let finalBody = body;
  try {
    const operation = String(debugRuntime.operation || req?.body?.operation || '')
      .trim()
      .toLowerCase();
    if (operation === 'find_products_multi') {
      const exposeDebugBundle = shouldExposeDebugBundle(req);
      const logDebugBundle = exposeDebugBundle || shouldLogDebugBundle(req);
      if (exposeDebugBundle || logDebugBundle) {
        debugRuntime.totalLatencyMs = Math.max(0, Date.now() - invokeStartedAtMs);
        const debugBundle = buildSearchDebugBundle({
          requestId: gatewayRequestId,
          req,
          responseBody: body,
          context: debugRuntime,
        });
        if (debugBundle) {
          if (
            exposeDebugBundle &&
            finalBody &&
            typeof finalBody === 'object' &&
            !Array.isArray(finalBody)
          ) {
            finalBody = {
              ...finalBody,
              debug_bundle: debugBundle,
            };
          }
          if (logDebugBundle) {
            logger?.info?.(
              {
                gateway_request_id: gatewayRequestId,
                debug_bundle: debugBundle,
              },
              'find_products_multi debug bundle',
            );
          }
        }
      }
    }
  } catch (debugErr) {
    logger?.warn?.(
      {
        gateway_request_id: gatewayRequestId,
        err: debugErr?.message || String(debugErr),
      },
      'failed to build/emit debug bundle',
    );
  }

  try {
    const operation = String(debugRuntime.operation || req?.body?.operation || '')
      .trim()
      .toLowerCase();
    if (operation === 'find_products_multi') {
      finalBody = normalizeFindProductsMultiResponseMetadata({
        body: finalBody,
        routeContext,
      });
    }
  } catch (metadataErr) {
    logger?.warn?.(
      {
        gateway_request_id: gatewayRequestId,
        err: metadataErr?.message || String(metadataErr),
      },
      'failed to normalize find_products_multi metadata',
    );
  }

  return finalBody;
}

function configureInvokeResponseShell({
  req,
  res,
  routeContext,
  gatewayRequestId,
  invokeStartedAtMs,
  clientChannel,
  routeKeyFingerprint,
  debugRuntime,
  checkoutRuntime,
  checkoutTimingOps,
  getUpstreamElapsedMs = () => 0,
  getGatewayRetryCount = () => 0,
  buildSearchDebugBundle = buildSearchDebugBundleBase,
  shouldExposeDebugBundle = shouldExposeDebugBundleBase,
  shouldLogDebugBundle = shouldLogDebugBundleBase,
  logger,
} = {}) {
  const setInvokePerfHeaders = (operationOverride = null) => {
    const op = String(operationOverride || debugRuntime.operation || '').trim().toLowerCase();
    if (!checkoutTimingOps.has(op)) return;
    const totalMs = Math.max(0, Date.now() - invokeStartedAtMs);
    const upstreamMs = Math.max(0, Math.round(getUpstreamElapsedMs()));
    const proxyMs = Math.max(0, totalMs - upstreamMs);
    res.setHeader(
      'Server-Timing',
      [`upstream;dur=${upstreamMs}`, `proxy;dur=${proxyMs}`, `gateway;dur=${totalMs}`].join(', '),
    );
    res.setHeader(
      'x-gateway-retries',
      String(Math.max(0, Number(getGatewayRetryCount() || 0) || 0)),
    );
  };

  res.on('finish', () => {
    logger?.info?.(
      {
        gateway_request_id: gatewayRequestId,
        client_channel: clientChannel,
        key_fingerprint: routeKeyFingerprint,
        operation: debugRuntime.operation,
        status: res.statusCode,
        latency_ms: Math.max(0, Date.now() - invokeStartedAtMs),
        upstream_ms: Math.max(0, Math.round(getUpstreamElapsedMs())),
        gateway_retries: Math.max(0, Number(getGatewayRetryCount() || 0) || 0),
        ...(debugRuntime.operation === 'submit_payment'
          ? {
              checkout_trace_id: checkoutRuntime.checkoutTraceId || gatewayRequestId,
              payment_status: checkoutRuntime.paymentStatus,
              confirmation_owner: checkoutRuntime.confirmationOwner,
              requires_client_confirmation: checkoutRuntime.requiresClientConfirmation,
            }
          : {}),
      },
      'invoke request complete',
    );
  });

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const finalBody = decorateInvokeJsonBody({
      req,
      body,
      routeContext,
      gatewayRequestId,
      invokeStartedAtMs,
      debugRuntime,
      buildSearchDebugBundle,
      shouldExposeDebugBundle,
      shouldLogDebugBundle,
      logger,
    });
    setInvokePerfHeaders();
    return originalJson(finalBody);
  };

  res.setHeader('X-Gateway-Request-Id', gatewayRequestId);

  return {
    setInvokePerfHeaders,
  };
}

module.exports = {
  normalizeFindProductsMultiResponseMetadata,
  decorateInvokeJsonBody,
  configureInvokeResponseShell,
};

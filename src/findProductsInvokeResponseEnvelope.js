function createFindProductsInvokeResponseEnvelopeRuntime(deps = {}) {
  const {
    shouldExposeDebugBundle,
    shouldLogDebugBundle,
    buildSearchDebugBundle,
    mergeInvokeGatewayAuditMetadata,
    normalizeGovernanceShadowBlockContract,
    finalizeInvokeFindProductsMultiResponse,
    finalizeInvokeAuthoritativeResponseEnvelope,
  } = deps;

  function finalizeInvokeResponseEnvelope({
    body,
    req,
    res,
    logger,
    routeContext,
    gatewayRequestId,
    debugRuntime,
    invokeStartedAtMs = 0,
    upstreamElapsedMs = 0,
    gatewayGovernanceAudit = null,
  } = {}) {
    let finalBody = body;
    const operation = String(debugRuntime?.operation || req?.body?.operation || '')
      .trim()
      .toLowerCase();

    try {
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
              logger.info(
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
      logger.warn(
        {
          gateway_request_id: gatewayRequestId,
          err: debugErr?.message || String(debugErr),
        },
        'failed to build/emit debug bundle',
      );
    }

    if (gatewayGovernanceAudit) {
      finalBody = mergeInvokeGatewayAuditMetadata(finalBody, gatewayGovernanceAudit);
      finalBody = normalizeGovernanceShadowBlockContract(finalBody);
      res.setHeader(
        'X-Gateway-Invocation-Surface',
        String(gatewayGovernanceAudit.invocation?.surface || 'unknown'),
      );
      res.setHeader(
        'X-Gateway-Governance-Mode',
        String(gatewayGovernanceAudit.mode || 'shadow'),
      );
      res.setHeader(
        'X-Gateway-Governance-Observed-Action',
        String(gatewayGovernanceAudit.observed_action || 'allow'),
      );
      res.setHeader(
        'X-Gateway-Governance-Effective-Action',
        String(gatewayGovernanceAudit.effective_action || 'allow'),
      );
      if (gatewayGovernanceAudit.would_enforce === true) {
        res.setHeader('X-Gateway-Governance-Would-Enforce', 'true');
      }
    }

    try {
      if (
        operation === 'find_products_multi' &&
        finalBody &&
        typeof finalBody === 'object' &&
        !Array.isArray(finalBody)
      ) {
        finalBody = finalizeInvokeFindProductsMultiResponse({
          response: finalBody,
          reqQuery: req?.query,
          routeContext,
          orchestratorVersion: process.env.SEARCH_ORCHESTRATOR_VERSION,
        });
      }
    } catch (metadataErr) {
      logger.warn(
        {
          gateway_request_id: gatewayRequestId,
          err: metadataErr?.message || String(metadataErr),
        },
        'failed to normalize find_products_multi metadata',
      );
    }

    try {
      finalBody = finalizeInvokeAuthoritativeResponseEnvelope({
        body: finalBody,
        operation,
        req,
        routeContext,
        gatewayRequestId,
        debugRuntime,
        invokeStartedAtMs,
        upstreamElapsedMs,
      });
    } catch (envelopeErr) {
      logger.warn(
        {
          gateway_request_id: gatewayRequestId,
          err: envelopeErr?.message || String(envelopeErr),
        },
        'failed to finalize authoritative invoke response envelope',
      );
    }

    return finalBody;
  }

  return {
    finalizeInvokeResponseEnvelope,
  };
}

module.exports = {
  createFindProductsInvokeResponseEnvelopeRuntime,
};

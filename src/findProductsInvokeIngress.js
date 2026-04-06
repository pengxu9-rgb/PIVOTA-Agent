function createFindProductsInvokeIngressRuntime(deps = {}) {
  const {
    normalizeMetadata,
    applyFindProductsMultiSourceContract,
    prepareGatewayGovernanceEnvelope,
    buildInvokeIngressGatewayInput,
    buildGatewayShadowAudit,
    shouldUseGatewayGovernanceShadowMode,
    applyGovernanceShadowRuntimeMetadata,
  } = deps;

  function prepareInvokeIngress({
    req,
    routeContext,
    operation,
    parsedPayload,
    gatewayRequestId,
    logger,
  } = {}) {
    let metadata = normalizeMetadata(req?.body?.metadata, parsedPayload);
    let payload = applyFindProductsMultiSourceContract(parsedPayload, metadata, operation);
    let gatewayGovernanceEnvelope = null;
    let gatewayGovernanceAudit = null;

    try {
      gatewayGovernanceEnvelope = prepareGatewayGovernanceEnvelope(
        buildInvokeIngressGatewayInput({
          req,
          routeContext,
          operation,
          payload,
          metadata,
          request_id: gatewayRequestId,
        }),
      );
      gatewayGovernanceAudit = buildGatewayShadowAudit(gatewayGovernanceEnvelope, {
        shadow_mode: shouldUseGatewayGovernanceShadowMode(routeContext),
      });
    } catch (gatewayGovernanceErr) {
      logger.warn(
        {
          gateway_request_id: gatewayRequestId,
          err: gatewayGovernanceErr?.message || String(gatewayGovernanceErr),
          operation,
        },
        'failed to prepare gateway governance audit for invoke ingress',
      );
      gatewayGovernanceEnvelope = null;
      gatewayGovernanceAudit = null;
    }

    metadata = applyGovernanceShadowRuntimeMetadata({
      metadata,
      gatewayGovernanceAudit,
      operation,
    });
    payload = applyFindProductsMultiSourceContract(parsedPayload, metadata, operation);

    return {
      metadata,
      payload,
      gatewayGovernanceEnvelope,
      gatewayGovernanceAudit,
    };
  }

  return {
    prepareInvokeIngress,
  };
}

module.exports = {
  createFindProductsInvokeIngressRuntime,
};

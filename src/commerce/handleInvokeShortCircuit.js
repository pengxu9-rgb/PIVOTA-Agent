const {
  getActivePromotions: getActivePromotionsBase,
  applyDealsToResponse: applyDealsToResponseBase,
} = require('./promotions');
const {
  handleMockInvokeOperation: handleMockInvokeOperationBase,
} = require('./mock/mockInvokeOperation');
const {
  handleGetPdpV2Operation: handleGetPdpV2OperationBase,
} = require('./pdp/getPdpV2');
const {
  handleGetPdpOperation: handleGetPdpOperationBase,
} = require('./pdp/getPdp');
const {
  handleResolveProductGroupOperation: handleResolveProductGroupOperationBase,
} = require('./pdp/resolveProductGroup');
const {
  handleResolveProductCandidatesOperation: handleResolveProductCandidatesOperationBase,
} = require('./pdp/resolveProductCandidates');

async function handleInvokeShortCircuit({
  operation,
  payload,
  effectivePayload,
  effectiveIntent,
  metadata,
  policyMetadata,
  rawUserQuery,
  creatorId,
  now = new Date(),
  shouldUseMock = false,
  defaultMerchantId,
  serviceGitSha,
  applyFindProductsMultiPolicy,
  getActivePromotions = getActivePromotionsBase,
  applyDealsToResponse = applyDealsToResponseBase,
  handleMockInvokeOperation = handleMockInvokeOperationBase,
  handleGetPdpV2Operation = handleGetPdpV2OperationBase,
  handleGetPdpOperation = handleGetPdpOperationBase,
  handleResolveProductGroupOperation = handleResolveProductGroupOperationBase,
  handleResolveProductCandidatesOperation = handleResolveProductCandidatesOperationBase,
  handleOffersResolveOperation,
  inferOffersResolveFailureReasonCode,
  buildOffersResolveResponse,
  pdpV2Args = {},
  getPdpArgs = {},
  resolveProductGroupArgs = {},
  resolveProductCandidatesArgs = {},
  logger,
} = {}) {
  if (operation === 'find_products_multi' && effectiveIntent?.scenario?.name === 'discovery') {
    const base = {
      status: 'success',
      success: true,
      products: [],
      total: 0,
      page: 1,
      page_size: 0,
      reply: null,
      metadata: {
        query_source: 'intent_discovery_short_circuit',
        fetched_at: new Date().toISOString(),
        ...(metadata?.creator_id ? { creator_id: metadata.creator_id } : {}),
        ...(metadata?.creator_name ? { creator_name: metadata.creator_name } : {}),
      },
    };

    const withPolicy = applyFindProductsMultiPolicy({
      response: base,
      intent: effectiveIntent,
      requestPayload: effectivePayload,
      metadata: policyMetadata,
      rawUserQuery,
    });

    const promotions = await getActivePromotions(now, creatorId);
    return {
      handled: true,
      statusCode: 200,
      body: applyDealsToResponse(withPolicy, promotions, now, creatorId),
    };
  }

  if (shouldUseMock) {
    logger?.info?.({ operation, mock: true }, 'Using internal mock data with rich product catalog');

    try {
      let mockResponse;
      const mockInvokeResult = await handleMockInvokeOperation({
        operation,
        payload,
        effectivePayload,
        metadata,
        defaultMerchantId,
        serviceGitSha,
      });
      if (mockInvokeResult?.handled) {
        if (Number(mockInvokeResult.statusCode || 200) !== 200) {
          return {
            handled: true,
            statusCode: mockInvokeResult.statusCode || 500,
            body: mockInvokeResult.body,
          };
        }
        mockResponse = mockInvokeResult.body;
      } else {
        return {
          handled: true,
          statusCode: 400,
          body: {
            error: 'UNSUPPORTED_OPERATION',
            message: `Operation ${operation} not implemented in mock mode`,
          },
        };
      }

      let maybePolicy = mockResponse;
      if (operation === 'find_products_multi' && effectiveIntent) {
        maybePolicy = applyFindProductsMultiPolicy({
          response: mockResponse,
          intent: effectiveIntent,
          requestPayload: effectivePayload,
          metadata: policyMetadata,
          rawUserQuery,
        });
      }

      const promotions = await getActivePromotions(now, creatorId);
      return {
        handled: true,
        statusCode: 200,
        body: applyDealsToResponse(maybePolicy, promotions, now, creatorId),
      };
    } catch (err) {
      logger?.error?.({ err: err?.message || String(err) }, 'Mock handler error');
      return {
        handled: true,
        statusCode: 503,
        body: { error: 'SERVICE_UNAVAILABLE' },
      };
    }
  }

  const pdpV2Result = await handleGetPdpV2Operation({
    operation,
    payload,
    ...pdpV2Args,
  });
  if (pdpV2Result?.handled) {
    return {
      handled: true,
      statusCode: pdpV2Result.statusCode,
      body: pdpV2Result.body,
    };
  }

  const getPdpResult = await handleGetPdpOperation({
    operation,
    payload,
    ...getPdpArgs,
  });
  if (getPdpResult?.handled) {
    return {
      handled: true,
      statusCode: getPdpResult.statusCode,
      body: getPdpResult.body,
    };
  }

  const resolveProductGroupResult = await handleResolveProductGroupOperation({
    operation,
    payload,
    ...resolveProductGroupArgs,
  });
  if (resolveProductGroupResult?.handled) {
    return {
      handled: true,
      statusCode: resolveProductGroupResult.statusCode,
      body: resolveProductGroupResult.body,
    };
  }

  const resolveProductCandidatesResult = await handleResolveProductCandidatesOperation({
    operation,
    payload,
    ...resolveProductCandidatesArgs,
  });
  if (resolveProductCandidatesResult?.handled) {
    return {
      handled: true,
      statusCode: resolveProductCandidatesResult.statusCode,
      body: resolveProductCandidatesResult.body,
    };
  }

  if (operation === 'offers.resolve') {
    try {
      const handled = await handleOffersResolveOperation({
        payload,
        metadata,
        checkoutToken: pdpV2Args.checkoutToken || getPdpArgs.checkoutToken || null,
      });
      if (
        handled &&
        typeof handled === 'object' &&
        handled.response &&
        typeof handled.response === 'object'
      ) {
        return {
          handled: true,
          statusCode: Number(handled.statusCode || 200) || 200,
          body: handled.response,
        };
      }
      return {
        handled: true,
        statusCode: 500,
        body: {
          error: 'OFFERS_RESOLVE_HANDLER_FAILED',
          message: 'offers.resolve returned an invalid response envelope',
        },
      };
    } catch (err) {
      const failReason = inferOffersResolveFailureReasonCode({ error: err });
      logger?.warn?.(
        { err: err?.message || String(err), fail_reason: failReason },
        'offers.resolve failed; returning fail-closed response',
      );
      return {
        handled: true,
        statusCode: 200,
        body: buildOffersResolveResponse({
          upstreamBody: {
            status: 'success',
            offers: [],
            offers_count: 0,
          },
          reasonCode: failReason,
          pdpTargetV1: null,
          sourceTrace: [
            {
              source: 'offers_resolve_handler',
              ok: false,
              attempts: 1,
              latency_ms: 0,
              reason: failReason,
            },
          ],
          queryText: '',
          startedAtMs: Date.now(),
          failReasonCode: failReason,
        }),
      };
    }
  }

  return {
    handled: false,
  };
}

module.exports = {
  handleInvokeShortCircuit,
};

const {
  attachSearchGateTrace,
  finalizeInvokeSuccessResponse,
} = require('../../src/commerce/finalizeInvokeSuccessResponse');

describe('attachSearchGateTrace', () => {
  test('attaches gate trace and summary to object responses', () => {
    const result = attachSearchGateTrace(
      {
        products: [],
        metadata: {
          query_source: 'agent_products_search',
        },
      },
      [
        { applied: true, decision: 'pass', cost_ms_estimate: 5 },
        { applied: false, decision: 'strict_empty', cost_ms_estimate: 20 },
      ],
    );

    expect(result).toEqual({
      products: [],
      metadata: {
        query_source: 'agent_products_search',
        gate_trace: [
          { applied: true, decision: 'pass', cost_ms_estimate: 5 },
          { applied: false, decision: 'strict_empty', cost_ms_estimate: 20 },
        ],
        gate_summary: {
          applied_count: 1,
          blocked_count: 1,
          total_cost_ms_estimate: 25,
        },
      },
    });
  });
});

describe('finalizeInvokeSuccessResponse', () => {
  test('routes search operations through search finalizer after gate-trace enrichment', async () => {
    const finalizeInvokeProductDetailResponse = jest.fn(async ({ upstreamData }) => upstreamData);
    const finalizeInvokeSearchResponse = jest.fn(async ({ upstreamData, promotions }) => ({
      upstreamData,
      promotions,
      finalized: true,
    }));
    const getActivePromotions = jest.fn(async () => [{ id: 'promo_1' }]);

    const result = await finalizeInvokeSuccessResponse({
      operation: 'find_products_multi',
      upstreamData: {
        products: [],
        metadata: { query_source: 'agent_products_search' },
      },
      responseStatus: 200,
      metadata: { source: 'shopping_agent' },
      now: new Date('2026-03-21T00:00:00.000Z'),
      fpmGateTrace: [{ applied: true, decision: 'pass', cost_ms_estimate: 5 }],
      fpmSkippedGatesDueToBudget: [],
      finalizeInvokeProductDetailResponse,
      finalizeInvokeSearchResponse,
      getActivePromotions,
      withSearchDiagnostics: (body) => body,
      buildSearchRouteHealth: (value) => value,
      buildSearchTrace: (value) => value,
      buildSearchRelevanceDebug: (value) => value,
      applyFindProductsMultiPolicy: ({ response }) => response,
      extractSearchQueryText: () => '',
      extractSearchAnchorTokens: () => [],
      isLookupStyleSearchQuery: () => false,
      isKnownLookupAliasQuery: () => false,
      buildPetFallbackQuery: () => '',
      searchCreatorSellableFromCache: jest.fn(),
      maybeRerankFindProductsMultiResponse: jest.fn(async () => ({ applied: false })),
    });

    expect(finalizeInvokeProductDetailResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamData: expect.objectContaining({
          metadata: expect.objectContaining({
            gate_trace: [{ applied: true, decision: 'pass', cost_ms_estimate: 5 }],
            gate_summary: {
              applied_count: 1,
              blocked_count: 0,
              total_cost_ms_estimate: 5,
            },
          }),
        }),
      }),
    );
    expect(getActivePromotions).toHaveBeenCalledWith(new Date('2026-03-21T00:00:00.000Z'), undefined);
    expect(finalizeInvokeSearchResponse).toHaveBeenCalled();
    expect(result).toEqual({
      handled: false,
      upstreamData: {
        products: [],
        metadata: {
          query_source: 'agent_products_search',
          gate_trace: [{ applied: true, decision: 'pass', cost_ms_estimate: 5 }],
          gate_summary: {
            applied_count: 1,
            blocked_count: 0,
            total_cost_ms_estimate: 5,
          },
        },
      },
      checkoutRuntime: null,
      body: {
        upstreamData: {
          products: [],
          metadata: {
            query_source: 'agent_products_search',
            gate_trace: [{ applied: true, decision: 'pass', cost_ms_estimate: 5 }],
            gate_summary: {
              applied_count: 1,
              blocked_count: 0,
              total_cost_ms_estimate: 5,
            },
          },
        },
        promotions: [{ id: 'promo_1' }],
        finalized: true,
      },
    });
  });

  test('returns early for handled checkout responses and skips promotions lookup', async () => {
    const finalizeCheckoutInvokeResponse = jest.fn(() => ({
      handled: true,
      body: { payment_status: 'processing' },
      upstreamData: { payment_status: 'processing' },
      checkoutRuntime: {
        checkoutTraceId: 'req_1',
        paymentStatus: 'processing',
        confirmationOwner: 'backend',
        requiresClientConfirmation: false,
      },
    }));
    const getActivePromotions = jest.fn();

    const result = await finalizeInvokeSuccessResponse({
      operation: 'submit_payment',
      upstreamData: { status: 'processing' },
      gatewayRequestId: 'req_1',
      finalizeInvokeProductDetailResponse: jest.fn(async ({ upstreamData }) => upstreamData),
      finalizeCheckoutInvokeResponse,
      getActivePromotions,
    });

    expect(getActivePromotions).not.toHaveBeenCalled();
    expect(result).toEqual({
      handled: true,
      body: { payment_status: 'processing' },
      upstreamData: { payment_status: 'processing' },
      checkoutRuntime: {
        checkoutTraceId: 'req_1',
        paymentStatus: 'processing',
        confirmationOwner: 'backend',
        requiresClientConfirmation: false,
      },
    });
  });

  test('prioritizes offers.resolve before downstream finalizers and applies deals for non-search responses', async () => {
    const prioritized = { offers: [{ id: 'offer_2' }], metadata: { prioritized: true } };
    const prioritizeOffersResolveResponse = jest.fn(() => prioritized);
    const finalizeInvokeProductDetailResponse = jest.fn(async ({ upstreamData }) => upstreamData);
    const applyDealsToResponse = jest.fn((upstreamData, promotions) => ({
      upstreamData,
      promotions,
      dealsApplied: true,
    }));

    const result = await finalizeInvokeSuccessResponse({
      operation: 'offers.resolve',
      upstreamData: { offers: [{ id: 'offer_1' }] },
      now: new Date('2026-03-21T00:00:00.000Z'),
      prioritizeOffersResolveResponse,
      finalizeInvokeProductDetailResponse,
      finalizeCheckoutInvokeResponse: jest.fn(() => ({
        handled: false,
        upstreamData: prioritized,
        checkoutRuntime: null,
      })),
      getActivePromotions: jest.fn(async () => [{ id: 'promo_1' }]),
      applyDealsToResponse,
    });

    expect(prioritizeOffersResolveResponse).toHaveBeenCalledWith({
      offers: [{ id: 'offer_1' }],
    });
    expect(finalizeInvokeProductDetailResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamData: prioritized,
      }),
    );
    expect(applyDealsToResponse).toHaveBeenCalledWith(
      prioritized,
      [{ id: 'promo_1' }],
      new Date('2026-03-21T00:00:00.000Z'),
      undefined,
    );
    expect(result).toEqual({
      handled: false,
      upstreamData: prioritized,
      checkoutRuntime: null,
      body: {
        upstreamData: prioritized,
        promotions: [{ id: 'promo_1' }],
        dealsApplied: true,
      },
    });
  });
});

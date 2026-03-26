const { handleInvokeShortCircuit } = require('../../src/commerce/handleInvokeShortCircuit');

describe('handleInvokeShortCircuit', () => {
  test('short-circuits discovery queries before upstream invoke', async () => {
    const applyFindProductsMultiPolicy = jest.fn(({ response }) => ({
      ...response,
      reply: 'tell me more',
    }));
    const getActivePromotions = jest.fn().mockResolvedValue([{ id: 'promo_1' }]);
    const applyDealsToResponse = jest.fn((response) => ({
      ...response,
      deals_applied: true,
    }));

    const result = await handleInvokeShortCircuit({
      operation: 'find_products_multi',
      effectivePayload: { search: { query: '随便看看' } },
      effectiveIntent: { scenario: { name: 'discovery' } },
      metadata: { creator_id: 'creator_1', creator_name: 'Nina' },
      policyMetadata: { source: 'shopping_agent' },
      rawUserQuery: '随便看看',
      creatorId: 'creator_1',
      now: new Date('2026-03-22T00:00:00.000Z'),
      applyFindProductsMultiPolicy,
      getActivePromotions,
      applyDealsToResponse,
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        statusCode: 200,
        body: expect.objectContaining({
          deals_applied: true,
          reply: 'tell me more',
        }),
      }),
    );
    expect(applyFindProductsMultiPolicy).toHaveBeenCalledTimes(1);
    expect(getActivePromotions).toHaveBeenCalledWith(expect.any(Date), 'creator_1');
    expect(applyDealsToResponse).toHaveBeenCalledTimes(1);
  });

  test('short-circuits mock invoke responses and enriches them', async () => {
    const handleMockInvokeOperation = jest.fn().mockResolvedValue({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        products: [],
      },
    });
    const applyFindProductsMultiPolicy = jest.fn(({ response }) => ({
      ...response,
      policy_applied: true,
    }));
    const getActivePromotions = jest.fn().mockResolvedValue([]);
    const applyDealsToResponse = jest.fn((response) => response);
    const logger = { info: jest.fn(), error: jest.fn() };

    const result = await handleInvokeShortCircuit({
      operation: 'find_products_multi',
      payload: { search: { query: 'brush' } },
      effectivePayload: { search: { query: 'brush' } },
      effectiveIntent: { scenario: { name: 'beauty_tools' } },
      metadata: { source: 'shopping_agent' },
      policyMetadata: { source: 'shopping_agent' },
      rawUserQuery: 'brush',
      creatorId: 'creator_1',
      shouldUseMock: true,
      defaultMerchantId: 'merchant_1',
      serviceGitSha: 'sha123',
      applyFindProductsMultiPolicy,
      handleMockInvokeOperation,
      getActivePromotions,
      applyDealsToResponse,
      logger,
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        statusCode: 200,
        body: expect.objectContaining({
          status: 'success',
          policy_applied: true,
        }),
      }),
    );
    expect(handleMockInvokeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'find_products_multi',
        defaultMerchantId: 'merchant_1',
        serviceGitSha: 'sha123',
      }),
    );
    expect(logger.info).toHaveBeenCalled();
  });

  test('returns mock unsupported operation envelope', async () => {
    const result = await handleInvokeShortCircuit({
      operation: 'unknown_mock_op',
      shouldUseMock: true,
      handleMockInvokeOperation: jest.fn().mockResolvedValue({ handled: false }),
      logger: { info: jest.fn(), error: jest.fn() },
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 400,
      body: {
        error: 'UNSUPPORTED_OPERATION',
        message: 'Operation unknown_mock_op not implemented in mock mode',
      },
    });
  });

  test('passes through handled direct operation response', async () => {
    const result = await handleInvokeShortCircuit({
      operation: 'get_pdp_v2',
      payload: { product_id: 'prod_1' },
      handleGetPdpV2Operation: jest.fn().mockResolvedValue({
        handled: true,
        statusCode: 200,
        body: { status: 'success', product_id: 'prod_1' },
      }),
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: { status: 'success', product_id: 'prod_1' },
    });
  });

  test('handles offers.resolve through extracted direct-operation path', async () => {
    const handleOffersResolveOperation = jest.fn().mockResolvedValue({
      statusCode: 200,
      response: { status: 'success', offers: [] },
    });

    const result = await handleInvokeShortCircuit({
      operation: 'offers.resolve',
      payload: { query: 'ipsa toner' },
      metadata: { source: 'shopping_agent' },
      handleOffersResolveOperation,
    });

    expect(handleOffersResolveOperation).toHaveBeenCalledWith({
      payload: { query: 'ipsa toner' },
      metadata: { source: 'shopping_agent' },
      checkoutToken: null,
    });
    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: { status: 'success', offers: [] },
    });
  });
});

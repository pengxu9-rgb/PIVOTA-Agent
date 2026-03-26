const {
  prepareInvokeUpstreamRequest,
} = require('../../src/commerce/prepareInvokeUpstreamRequest');

describe('prepareInvokeUpstreamRequest', () => {
  test('returns unsupported operation envelope when route is missing', async () => {
    const result = await prepareInvokeUpstreamRequest({
      operation: 'unknown_operation',
      getInvokeRoute: jest.fn().mockReturnValue(null),
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 400,
      body: {
        error: 'UNSUPPORTED_OPERATION',
        operation: 'unknown_operation',
      },
    });
  });

  test('builds route, url, query params, and product detail metadata from request builder', async () => {
    const buildCommerceInvokeUpstreamRequest = jest.fn().mockResolvedValue({
      url: 'https://search.pivota.test/agent/v1/products/search',
      queryParams: { query: 'toner', limit: 12 },
      resolvedOfferId: 'offer_1',
      resolvedMerchantId: 'merchant_1',
      productDetail: {
        merchantId: 'merchant_2',
        productId: 'product_2',
        cacheKey: 'detail:merchant_2:product_2',
        debug: true,
        bypassCache: true,
      },
    });
    const getProxySearchApiBase = jest.fn().mockReturnValue('https://search.pivota.test');

    const result = await prepareInvokeUpstreamRequest({
      operation: 'find_products',
      payload: { search: { query: 'toner' } },
      effectivePayload: { search: { query: 'toner' } },
      metadata: { source: 'AURORA-BFF' },
      creatorId: 'creator_1',
      checkoutToken: 'token_1',
      pivotaApiBase: 'https://api.pivota.test',
      searchLimitMax: 30,
      applyShoppingCatalogQueryGuards: jest.fn(),
      getCreatorConfig: jest.fn(),
      uniqueStrings: jest.fn(),
      isCreatorUiSource: jest.fn(),
      proxySearchCreatorScopeToConfig: true,
      getProxySearchApiBase,
      buildCommerceInvokeUpstreamRequest,
    });

    expect(getProxySearchApiBase).toHaveBeenCalledWith('aurora-bff');
    expect(buildCommerceInvokeUpstreamRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'find_products',
        url: 'https://search.pivota.test/agent/v1/products/search',
      }),
    );
    expect(result).toEqual({
      handled: false,
      route: {
        method: 'GET',
        path: '/agent/v1/products/search',
        paramType: 'query',
      },
      url: 'https://search.pivota.test/agent/v1/products/search',
      requestBody: {},
      queryParams: { query: 'toner', limit: 12 },
      resolvedOfferId: 'offer_1',
      resolvedMerchantId: 'merchant_1',
      productDetail: {
        merchantId: 'merchant_2',
        productId: 'product_2',
        cacheKey: 'detail:merchant_2:product_2',
        debug: true,
        bypassCache: true,
      },
    });
  });

  test('returns request validation envelope when request builder throws', async () => {
    const err = new Error('order_id is required');
    err.code = 'MISSING_PARAMETERS';
    err.statusCode = 422;

    const result = await prepareInvokeUpstreamRequest({
      operation: 'confirm_payment',
      payload: {},
      effectivePayload: {},
      metadata: {},
      pivotaApiBase: 'https://api.pivota.test',
      getProxySearchApiBase: jest.fn(),
      buildCommerceInvokeUpstreamRequest: jest.fn().mockRejectedValue(err),
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 422,
      body: {
        error: 'MISSING_PARAMETERS',
        message: 'order_id is required',
      },
    });
  });

  test('returns local find_similar_products response when helper handles it', async () => {
    const handleFindSimilarProductsInvoke = jest.fn().mockResolvedValue({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        products: [{ product_id: 'prod_1' }],
      },
    });

    const result = await prepareInvokeUpstreamRequest({
      operation: 'find_similar_products',
      payload: { similar: { product_id: 'prod_1' } },
      effectivePayload: { similar: { product_id: 'prod_1' } },
      metadata: { source: 'creator-agent-ui' },
      creatorId: 'creator_1',
      checkoutToken: 'token_1',
      pivotaApiBase: 'https://api.pivota.test',
      now: new Date('2026-03-22T00:00:00.000Z'),
      hasDatabase: true,
      findSimilarCreatorFromCache: jest.fn(),
      isCreatorUiSource: jest.fn().mockReturnValue(true),
      getProxySearchApiBase: jest.fn(),
      buildCommerceInvokeUpstreamRequest: jest.fn().mockResolvedValue(null),
      handleFindSimilarProductsInvoke,
      logger: { warn: jest.fn() },
    });

    expect(handleFindSimilarProductsInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorId: 'creator_1',
        checkoutToken: 'token_1',
      }),
    );
    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: {
        status: 'success',
        products: [{ product_id: 'prod_1' }],
      },
    });
  });
});

const { buildCommerceInvokeUpstreamRequest } = require('../../src/commerce/invokeUpstreamRequest');

describe('buildCommerceInvokeUpstreamRequest catalog builders', () => {
  test('builds find_products query params with guard application', async () => {
    const applyShoppingCatalogQueryGuards = jest.fn((params, source) => ({
      ...params,
      guarded_source: source,
    }));

    const result = await buildCommerceInvokeUpstreamRequest({
      operation: 'find_products',
      effectivePayload: {
        search: {
          merchant_id: 'merchant_1',
          query: 'shoes',
          page: 2,
          page_size: 99,
          min_price: 10,
        },
      },
      payload: {},
      metadata: { source: 'creator_ui' },
      searchLimitMax: 50,
      applyShoppingCatalogQueryGuards,
    });

    expect(applyShoppingCatalogQueryGuards).toHaveBeenCalledWith(
      expect.objectContaining({
        merchant_id: 'merchant_1',
        query: 'shoes',
        min_price: 10,
        in_stock_only: true,
        limit: 50,
        offset: 50,
      }),
      'creator_ui',
    );
    expect(result.queryParams).toMatchObject({
      merchant_id: 'merchant_1',
      query: 'shoes',
      min_price: 10,
      in_stock_only: true,
      limit: 50,
      offset: 50,
      guarded_source: 'creator_ui',
    });
    expect(result.queryParams.search_all_merchants).toBeUndefined();
  });

  test('builds products.recommendations query params', async () => {
    const result = await buildCommerceInvokeUpstreamRequest({
      operation: 'products.recommendations',
      effectivePayload: {
        search: {
          merchant_id: 'merchant_2',
          platform_product_id: 'prod_123',
          platform: 'shopify',
          limit: 75,
        },
      },
      payload: {},
    });

    expect(result).toEqual({
      queryParams: {
        merchant_id: 'merchant_2',
        platform_product_id: 'prod_123',
        platform: 'shopify',
        limit: 50,
      },
    });
  });

  test('builds find_products_multi creator-scoped query params from creator config', async () => {
    const applyShoppingCatalogQueryGuards = jest.fn((params) => params);
    const result = await buildCommerceInvokeUpstreamRequest({
      operation: 'find_products_multi',
      effectivePayload: {
        search: {
          query: 'lip tint',
          page: 1,
          limit: 20,
        },
      },
      payload: {},
      metadata: { source: 'creator_ui' },
      creatorId: 'creator_1',
      searchLimitMax: 50,
      applyShoppingCatalogQueryGuards,
      getCreatorConfig: () => ({ merchantIds: ['m1', 'm2', 'm1'] }),
      uniqueStrings: (values) => Array.from(new Set(values)),
      isCreatorUiSource: (source) => source === 'creator_ui',
      proxySearchCreatorScopeToConfig: true,
    });

    expect(result.queryParams).toMatchObject({
      merchant_ids: ['m1', 'm2'],
      query: 'lip tint',
      in_stock_only: true,
      limit: 20,
      offset: 0,
      source: 'creator_ui',
    });
    expect(result.queryParams.search_all_merchants).toBeUndefined();
  });

  test('preserves agent_api surface through guard application for eligible-only serving', async () => {
    const applyShoppingCatalogQueryGuards = jest.fn((params) => ({
      ...params,
      allow_external_seed: params.commerce_surface ? false : true,
    }));

    const result = await buildCommerceInvokeUpstreamRequest({
      operation: 'find_products_multi',
      effectivePayload: {
        search: {
          query: 'serum',
          page: 1,
          limit: 10,
          in_stock_only: true,
          commerce_surface: 'agent_api',
        },
      },
      payload: {},
      metadata: { source: 'shopping_agent' },
      searchLimitMax: 50,
      applyShoppingCatalogQueryGuards,
      getCreatorConfig: () => ({ merchantIds: [] }),
      uniqueStrings: (values) => Array.from(new Set(values)),
      isCreatorUiSource: () => false,
      proxySearchCreatorScopeToConfig: true,
    });

    expect(applyShoppingCatalogQueryGuards).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'serum',
        commerce_surface: 'agent_api',
        catalog_surface: 'agent_api',
        search_all_merchants: true,
        in_stock_only: true,
        limit: 10,
        offset: 0,
      }),
      'shopping_agent',
    );
    expect(result.queryParams).toMatchObject({
      query: 'serum',
      commerce_surface: 'agent_api',
      catalog_surface: 'agent_api',
      search_all_merchants: true,
      in_stock_only: true,
      allow_external_seed: false,
    });
  });

  test('builds get_product_detail url and product detail cache metadata', async () => {
    const result = await buildCommerceInvokeUpstreamRequest({
      operation: 'get_product_detail',
      payload: {
        product: {
          merchant_id: 'merchant 3',
          product_id: 'prod/456',
        },
        options: {
          debug: true,
          bypass_cache: true,
        },
      },
      url: 'http://pivota.test/agent/v1/merchants/{merchant_id}/products/{product_id}',
      checkoutToken: 'checkout-token',
    });

    expect(result.url).toBe(
      'http://pivota.test/agent/v1/merchants/merchant%203/products/prod%2F456',
    );
    expect(result.productDetail).toEqual({
      merchantId: 'merchant 3',
      productId: 'prod/456',
      cacheKey: JSON.stringify({
        merchantId: 'merchant 3',
        productId: 'prod/456',
        hasCheckoutToken: true,
      }),
      debug: true,
      bypassCache: true,
    });
  });

  test('builds track_product_click request body', async () => {
    const result = await buildCommerceInvokeUpstreamRequest({
      operation: 'track_product_click',
      payload: {
        product: {
          merchant_id: 'merchant_4',
          platform: 'shopify',
          product_id: 'prod_789',
          position: 2,
          ranking_score: 0.93,
          cq: 0.88,
          mr: 0.77,
          query: 'red dress',
          action: 'open',
        },
      },
    });

    expect(result.requestBody).toEqual({
      merchant_id: 'merchant_4',
      platform: 'shopify',
      platform_product_id: 'prod_789',
      position: 2,
      ranking_score: 0.93,
      quality_content_score: 0.88,
      quality_model_readiness: 0.77,
      query: 'red dress',
      event_type: 'open',
    });
  });

  test('rejects track_product_click without merchant and product identifiers', async () => {
    await expect(
      buildCommerceInvokeUpstreamRequest({
        operation: 'track_product_click',
        payload: {
          product: {
            platform: 'shopify',
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'MISSING_PARAMETERS',
      statusCode: 400,
    });
  });
});

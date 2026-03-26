const { buildInvokeErrorResponse } = require('../../src/commerce/buildInvokeErrorResponse');

describe('buildInvokeErrorResponse', () => {
  test('returns search outer-catch response when search finalizer handles it', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const buildInvokeSearchOuterCatchResponse = jest.fn().mockReturnValue({
      handled: true,
      statusCode: 200,
      body: { status: 'success', products: [] },
    });

    const result = buildInvokeErrorResponse({
      operation: 'find_products_multi',
      err: new Error('search failed'),
      gatewayRequestId: 'req_1',
      buildInvokeSearchOuterCatchResponse,
      logger,
    });

    expect(buildInvokeSearchOuterCatchResponse).toHaveBeenCalled();
    expect(result).toEqual({
      handled: true,
      statusCode: 200,
      body: { status: 'success', products: [] },
      headers: null,
    });
  });

  test('preserves upstream request id on upstream response errors', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const buildInvokeSearchOuterCatchResponse = jest.fn().mockReturnValue({
      handled: false,
    });
    const err = {
      response: {
        status: 502,
        headers: {
          'x-request-id': 'up_req_1',
        },
        data: {
          error: 'UPSTREAM_ERROR',
        },
      },
      config: {
        url: 'http://pivota.test/agent/v1/products/search',
      },
    };

    const result = buildInvokeErrorResponse({
      operation: 'find_products',
      err,
      gatewayRequestId: 'req_2',
      buildInvokeSearchOuterCatchResponse,
      logger,
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 502,
      headers: { 'X-Upstream-Request-Id': 'up_req_1' },
      body: { error: 'UPSTREAM_ERROR' },
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  test('returns timeout envelope for ECONNABORTED', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    const buildInvokeSearchOuterCatchResponse = jest.fn().mockReturnValue({
      handled: false,
    });
    const err = {
      code: 'ECONNABORTED',
      config: {
        url: 'http://pivota.test/agent/v1/products/search',
        timeout: 6500,
      },
    };

    const result = buildInvokeErrorResponse({
      operation: 'find_products_multi',
      err,
      buildInvokeSearchOuterCatchResponse,
      logger,
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 504,
      headers: null,
      body: {
        error: 'UPSTREAM_TIMEOUT',
        operation: 'find_products_multi',
        upstream_url: 'http://pivota.test/agent/v1/products/search',
        timeout_ms: 6500,
      },
    });
    expect(logger.error).toHaveBeenCalled();
  });
});

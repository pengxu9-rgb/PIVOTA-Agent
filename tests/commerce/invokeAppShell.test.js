const {
  HYBRID_MOCK_OPERATIONS,
  prepareInvokeExecutionMode,
  sendInvokeOperationResponse,
  handleUnhandledInvokeRequestError,
} = require('../../src/commerce/invokeAppShell');

describe('invokeAppShell', () => {
  test('prepareInvokeExecutionMode returns blocked envelope with retry header', () => {
    const req = {
      header: jest.fn(() => ''),
    };
    const applyGatewayGuardrails = jest.fn(() => ({
      blocked: {
        status: 429,
        body: { error: 'RATE_LIMITED' },
        retryAfterSec: 5,
      },
    }));
    const logger = { info: jest.fn() };

    const result = prepareInvokeExecutionMode({
      req,
      operation: 'find_products_multi',
      payload: {},
      effectivePayload: {},
      metadata: {},
      apiMode: 'REAL',
      useMock: false,
      useHybrid: false,
      applyGatewayGuardrails,
      logger,
    });

    expect(result).toEqual({
      handled: true,
      statusCode: 429,
      body: { error: 'RATE_LIMITED' },
      headers: { 'Retry-After': '5' },
      checkoutToken: null,
      shouldUseMock: false,
    });
    expect(applyGatewayGuardrails).toHaveBeenCalledWith({
      req,
      operation: 'find_products_multi',
      payload: {},
      effectivePayload: {},
      metadata: {},
    });
    expect(logger.info).toHaveBeenCalledWith(
      { api_mode: 'REAL', operation: 'find_products_multi' },
      'API Mode: REAL, Operation: find_products_multi',
    );
  });

  test('prepareInvokeExecutionMode selects hybrid mock operations and returns checkout token', () => {
    const req = {
      header: jest.fn((name) => (String(name).toLowerCase() === 'x-checkout-token' ? ' checkout_1 ' : '')),
    };
    const applyGatewayGuardrails = jest.fn(() => null);
    const logger = { info: jest.fn() };

    const result = prepareInvokeExecutionMode({
      req,
      operation: 'submit_payment',
      payload: {},
      effectivePayload: {},
      metadata: {},
      apiMode: 'HYBRID',
      useMock: false,
      useHybrid: true,
      applyGatewayGuardrails,
      logger,
    });

    expect(HYBRID_MOCK_OPERATIONS.has('submit_payment')).toBe(true);
    expect(result).toEqual({
      handled: false,
      statusCode: null,
      body: null,
      headers: null,
      checkoutToken: 'checkout_1',
      shouldUseMock: true,
    });
    expect(logger.info).toHaveBeenNthCalledWith(
      2,
      { operation: 'submit_payment' },
      'Hybrid mode: Using mock for this operation',
    );
  });

  test('sendInvokeOperationResponse applies headers, updates checkout runtime, and sends body', () => {
    const checkoutRuntime = {
      checkoutTraceId: null,
      paymentStatus: null,
      confirmationOwner: null,
      requiresClientConfirmation: null,
    };
    const res = {
      setHeader: jest.fn(),
      status: jest.fn(function status() {
        return this;
      }),
      json: jest.fn(function json(body) {
        return body;
      }),
    };

    const result = sendInvokeOperationResponse({
      res,
      invokeResult: {
        statusCode: 202,
        headers: {
          'X-Upstream-Request-Id': 'up_req_1',
        },
        body: { status: 'processing' },
        checkoutRuntime: {
          checkoutTraceId: 'trace_1',
          paymentStatus: 'processing',
          confirmationOwner: 'backend',
          requiresClientConfirmation: false,
        },
      },
      checkoutRuntime,
    });

    expect(res.setHeader).toHaveBeenCalledWith('X-Upstream-Request-Id', 'up_req_1');
    expect(checkoutRuntime).toEqual({
      checkoutTraceId: 'trace_1',
      paymentStatus: 'processing',
      confirmationOwner: 'backend',
      requiresClientConfirmation: false,
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ status: 'processing' });
    expect(result).toEqual({ status: 'processing' });
  });

  test('handleUnhandledInvokeRequestError logs and returns 500 when headers not sent', () => {
    const res = {
      headersSent: false,
      status: jest.fn(function status() {
        return this;
      }),
      json: jest.fn(function json(body) {
        return body;
      }),
    };
    const logger = {
      error: jest.fn(),
    };
    const err = new Error('boom');

    const result = handleUnhandledInvokeRequestError({
      err,
      res,
      gatewayRequestId: 'req_1',
      logger,
    });

    expect(logger.error).toHaveBeenCalledWith(
      {
        gateway_request_id: 'req_1',
        err: 'boom',
        stack: expect.any(String),
      },
      'Unhandled invoke error',
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
      gateway_request_id: 'req_1',
    });
    expect(result).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
      gateway_request_id: 'req_1',
    });
  });

  test('handleUnhandledInvokeRequestError only logs when headers already sent', () => {
    const res = {
      headersSent: true,
      status: jest.fn(),
      json: jest.fn(),
    };
    const logger = {
      error: jest.fn(),
    };

    const result = handleUnhandledInvokeRequestError({
      err: new Error('late failure'),
      res,
      gatewayRequestId: 'req_2',
      logger,
    });

    expect(logger.error).toHaveBeenCalledWith(
      {
        gateway_request_id: 'req_2',
        err: 'late failure',
        stack: expect.any(String),
      },
      'Unhandled invoke error after headers sent',
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

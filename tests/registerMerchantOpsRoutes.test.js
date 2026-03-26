const {
  createFetchBackendAdmin,
  createProxyPhotosToBackend,
  registerMerchantOpsRoutes,
} = require('../src/registerMerchantOpsRoutes');

function createJsonRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
}

function createApp() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  };
}

function getRouteHandler(app, method, path, index = 0) {
  const calls = app[method].mock.calls.filter((call) => call[0] === path);
  const routeCall = calls[index];
  if (!routeCall) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  return routeCall[routeCall.length - 1];
}

describe('registerMerchantOpsRoutes', () => {
  test('createFetchBackendAdmin sends admin auth and payload to backend', async () => {
    const axiosClient = jest.fn().mockResolvedValue({ status: 200, data: { ok: true } });
    const fetchBackendAdmin = createFetchBackendAdmin({
      adminApiKey: 'admin_key',
      pivotaApiBase: 'http://pivota.test',
      axiosClient,
      upstreamTimeoutAdminMs: 4321,
    });

    await expect(
      fetchBackendAdmin({
        method: 'POST',
        path: '/agent/internal/disputes/sync',
        params: { orderId: 'ord_1' },
        data: { limit: 5 },
      }),
    ).resolves.toEqual({ status: 200, data: { ok: true } });

    expect(axiosClient).toHaveBeenCalledWith({
      method: 'POST',
      url: 'http://pivota.test/agent/internal/disputes/sync',
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-KEY': 'admin_key',
      },
      timeout: 4321,
      params: { orderId: 'ord_1' },
      data: { limit: 5 },
    });
  });

  test('createFetchBackendAdmin fails closed when admin key is missing', async () => {
    const fetchBackendAdmin = createFetchBackendAdmin({
      adminApiKey: '',
      pivotaApiBase: 'http://pivota.test',
      axiosClient: jest.fn(),
      upstreamTimeoutAdminMs: 2000,
    });

    await expect(
      fetchBackendAdmin({
        method: 'GET',
        path: '/agent/internal/disputes',
      }),
    ).rejects.toMatchObject({
      message: 'ADMIN_API_KEY_NOT_CONFIGURED',
      status: 500,
    });
  });

  test('createProxyPhotosToBackend proxies POST requests with checkout auth', async () => {
    const axiosClient = jest.fn().mockResolvedValue({
      status: 201,
      data: { ok: true, upload_id: 'upl_1' },
    });
    const proxyPhotosToBackend = createProxyPhotosToBackend({
      pivotaApiBase: 'http://pivota.test',
      axiosClient,
      buildInvokeUpstreamAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer checkout' })),
      upstreamTimeoutAdminMs: 3456,
      extractUpstreamErrorCode: jest.fn(() => ({ code: null, message: null, data: null })),
    });
    const res = createJsonRes();

    await proxyPhotosToBackend(
      {
        method: 'POST',
        path: '/photos/presign',
        body: { filename: 'img.jpg' },
        query: {},
        header: jest.fn((name) => (String(name).toLowerCase() === 'x-checkout-token' ? 'tok_1' : '')),
      },
      res,
    );

    expect(axiosClient).toHaveBeenCalledWith({
      method: 'POST',
      url: 'http://pivota.test/photos/presign',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer checkout',
      },
      timeout: 3456,
      data: { filename: 'img.jpg' },
      validateStatus: expect.any(Function),
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true, upload_id: 'upl_1' });
  });

  test('registers merchant ops routes and preserves validation behavior', async () => {
    const app = createApp();
    const logger = { error: jest.fn() };
    const requireAdmin = jest.fn((req, res, next) => next());
    const getAllPromotions = jest.fn().mockResolvedValue([]);
    const getPromotionById = jest.fn();
    const upsertPromotion = jest.fn();
    const softDeletePromotion = jest.fn();
    const computeHumanReadableRule = jest.fn(() => 'rule');
    const sanitizePromotionForResponse = jest.fn((promotion) => promotion);
    const computePromotionStatus = jest.fn(() => 'draft');
    const validateAndNormalizePromotion = jest.fn(() => ({
      promotion: null,
      error: 'name is required',
    }));
    const extractUpstreamErrorCode = jest.fn(() => ({
      code: 'UPSTREAM_ERROR',
      message: 'upstream failed',
      data: { status: 'bad' },
    }));
    const createFetchBackendAdminImpl = jest.fn(() => jest.fn());
    const proxyPhotosToBackend = jest.fn();
    const createProxyPhotosToBackendImpl = jest.fn(() => proxyPhotosToBackend);

    registerMerchantOpsRoutes({
      app,
      logger,
      requireAdmin,
      getAllPromotions,
      getPromotionById,
      upsertPromotion,
      softDeletePromotion,
      computeHumanReadableRule,
      sanitizePromotionForResponse,
      computePromotionStatus,
      validateAndNormalizePromotion,
      extractUpstreamErrorCode,
      adminApiKey: 'admin_key',
      pivotaApiBase: 'http://pivota.test',
      axiosClient: jest.fn(),
      upstreamTimeoutAdminMs: 2000,
      buildInvokeUpstreamAuthHeaders: jest.fn(() => ({ Authorization: 'Bearer checkout' })),
      createFetchBackendAdminImpl,
      createProxyPhotosToBackendImpl,
    });

    expect(app.get).toHaveBeenCalledWith('/api/merchant/promotions', requireAdmin, expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/merchant/promotions/:id', requireAdmin, expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/merchant/disputes', requireAdmin, expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/merchant/returns', requireAdmin, expect.any(Function));
    expect(app.post).toHaveBeenCalledWith('/photos/presign', proxyPhotosToBackend);
    expect(app.post).toHaveBeenCalledWith('/photos/confirm', proxyPhotosToBackend);
    expect(app.get).toHaveBeenCalledWith('/photos/qc', proxyPhotosToBackend);
    expect(app.delete).toHaveBeenCalledWith('/photos', proxyPhotosToBackend);

    const createPromotionHandler = getRouteHandler(app, 'post', '/api/merchant/promotions');
    const createPromotionRes = createJsonRes();
    await createPromotionHandler({ body: { description: 'missing name' } }, createPromotionRes);
    expect(createPromotionRes.statusCode).toBe(400);
    expect(createPromotionRes.body).toEqual({
      error: 'INVALID_PROMOTION',
      message: 'name is required',
    });

    const syncDisputesHandler = getRouteHandler(app, 'post', '/api/merchant/disputes/sync');
    const syncDisputesRes = createJsonRes();
    await syncDisputesHandler({ body: {} }, syncDisputesRes);
    expect(syncDisputesRes.statusCode).toBe(400);
    expect(syncDisputesRes.body).toEqual({
      error: 'MISSING_ORDER_ID',
      message: 'orderId is required',
    });

    const syncReturnsHandler = getRouteHandler(app, 'post', '/api/merchant/returns/sync');
    const syncReturnsRes = createJsonRes();
    await syncReturnsHandler({ body: {} }, syncReturnsRes);
    expect(syncReturnsRes.statusCode).toBe(400);
    expect(syncReturnsRes.body).toEqual({
      error: 'MISSING_MERCHANT_ID',
      message: 'merchantId is required',
    });
  });
});

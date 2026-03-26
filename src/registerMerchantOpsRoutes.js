function createFetchBackendAdmin({
  adminApiKey,
  pivotaApiBase,
  axiosClient,
  upstreamTimeoutAdminMs,
} = {}) {
  return async function fetchBackendAdmin({ method, path, params, data }) {
    if (!adminApiKey) {
      const err = new Error('ADMIN_API_KEY_NOT_CONFIGURED');
      err.status = 500;
      throw err;
    }
    const url = `${pivotaApiBase}${path}`;
    return await axiosClient({
      method,
      url,
      headers: {
        ...(method !== 'GET' && { 'Content-Type': 'application/json' }),
        'X-ADMIN-KEY': adminApiKey,
      },
      timeout: upstreamTimeoutAdminMs,
      ...(params ? { params } : {}),
      ...(data ? { data } : {}),
    });
  };
}

function createProxyPhotosToBackend({
  pivotaApiBase,
  axiosClient,
  buildInvokeUpstreamAuthHeaders,
  upstreamTimeoutAdminMs,
  extractUpstreamErrorCode,
} = {}) {
  return async function proxyPhotosToBackend(req, res) {
    const checkoutToken =
      String(req.header('X-Checkout-Token') || req.header('x-checkout-token') || '').trim() || null;

    const url = `${pivotaApiBase}${req.path}`;
    const method = String(req.method || 'GET').toUpperCase();

    try {
      const resp = await axiosClient({
        method,
        url,
        headers: {
          ...(method !== 'GET' && method !== 'HEAD' && method !== 'DELETE'
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
        },
        timeout: upstreamTimeoutAdminMs,
        ...(method === 'GET' || method === 'DELETE' ? { params: req.query } : { data: req.body }),
        validateStatus: () => true,
      });

      return res.status(resp.status).json(resp.data);
    } catch (err) {
      const { code, message, data } = extractUpstreamErrorCode(err);
      const statusCode = err?.response?.status || err?.status || 500;
      return res.status(statusCode).json({
        error: code || 'FAILED_TO_PROXY_PHOTOS',
        message: message || 'Failed to proxy photo upload request',
        details: data || null,
      });
    }
  };
}

function registerMerchantOpsRoutes({
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
  adminApiKey,
  pivotaApiBase,
  axiosClient,
  upstreamTimeoutAdminMs,
  buildInvokeUpstreamAuthHeaders,
  createFetchBackendAdminImpl = createFetchBackendAdmin,
  createProxyPhotosToBackendImpl = createProxyPhotosToBackend,
} = {}) {
  const fetchBackendAdmin = createFetchBackendAdminImpl({
    adminApiKey,
    pivotaApiBase,
    axiosClient,
    upstreamTimeoutAdminMs,
  });
  const proxyPhotosToBackend = createProxyPhotosToBackendImpl({
    pivotaApiBase,
    axiosClient,
    buildInvokeUpstreamAuthHeaders,
    upstreamTimeoutAdminMs,
    extractUpstreamErrorCode,
  });

  app.get('/api/merchant/promotions', requireAdmin, async (req, res) => {
    try {
      const { status, type, channel, creatorId, search } = req.query;
      const nowTs = Date.now();
      const allPromos = await getAllPromotions();
      const promotions = allPromos
        .filter((p) => !p.deletedAt)
        .filter((p) => {
          if (type && p.type !== type) return false;
          if (channel && (!Array.isArray(p.channels) || !p.channels.includes(channel))) return false;
          if (creatorId) {
            if (p.exposeToCreators === false) return false;
            if (p.allowedCreatorIds?.length && !p.allowedCreatorIds.includes(creatorId)) {
              return false;
            }
          }
          if (search) {
            const s = String(search).toLowerCase();
            const name = (p.name || '').toLowerCase();
            const desc = (p.description || '').toLowerCase();
            if (!name.includes(s) && !desc.includes(s)) return false;
          }
          if (status) {
            const currentStatus = computePromotionStatus(p, nowTs);
            if (currentStatus !== status) return false;
          }
          return true;
        })
        .map((p) => ({
          ...sanitizePromotionForResponse(p),
          humanReadableRule: computeHumanReadableRule(p),
          status: computePromotionStatus(p, nowTs),
        }));

      res.json({ promotions, total: promotions.length });
    } catch (err) {
      logger.error(
        { err: err?.message || String(err) },
        'Failed to list merchant promotions',
      );
      return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE' });
    }
  });

  app.get('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
    try {
      const promo = await getPromotionById(req.params.id);
      if (!promo || promo.deletedAt) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      const nowTs = Date.now();
      return res.json({
        promotion: {
          ...sanitizePromotionForResponse(promo),
          humanReadableRule: computeHumanReadableRule(promo),
          status: computePromotionStatus(promo, nowTs),
        },
      });
    } catch (err) {
      logger.error(
        { err: err?.message || String(err), promoId: req.params.id },
        'Failed to fetch merchant promotion',
      );
      return res.status(502).json({ error: 'UPSTREAM_UNAVAILABLE' });
    }
  });

  app.post('/api/merchant/promotions', requireAdmin, async (req, res) => {
    try {
      const { promotion, error } = validateAndNormalizePromotion(req.body, {}, { requireAll: true });
      if (error) {
        return res.status(400).json({ error: 'INVALID_PROMOTION', message: error });
      }
      const nowTs = Date.now();
      await upsertPromotion(promotion);
      return res.status(201).json({
        promotion: {
          ...sanitizePromotionForResponse(promotion),
          status: computePromotionStatus(promotion, nowTs),
        },
      });
    } catch (err) {
      const { code, message } = extractUpstreamErrorCode(err);
      const status = (err && err.response && err.response.status) || err?.status || 502;
      logger.error(
        { status, code, err: message || err?.message || String(err) },
        'Failed to create merchant promotion',
      );
      return res.status(status).json({ error: code || 'UPSTREAM_UNAVAILABLE', message });
    }
  });

  app.patch('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
    try {
      const existing = await getPromotionById(req.params.id);
      if (!existing || existing.deletedAt) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      const { promotion, error } = validateAndNormalizePromotion(
        { ...req.body, id: existing.id },
        existing,
        { requireAll: true },
      );
      if (error) {
        return res.status(400).json({ error: 'INVALID_PROMOTION', message: error });
      }
      const nowTs = Date.now();
      await upsertPromotion(promotion);
      return res.json({
        promotion: {
          ...sanitizePromotionForResponse(promotion),
          status: computePromotionStatus(promotion, nowTs),
        },
      });
    } catch (err) {
      const { code, message } = extractUpstreamErrorCode(err);
      const status = (err && err.response && err.response.status) || err?.status || 502;
      logger.error(
        { status, code, err: message || err?.message || String(err), promoId: req.params.id },
        'Failed to update merchant promotion',
      );
      return res.status(status).json({ error: code || 'UPSTREAM_UNAVAILABLE', message });
    }
  });

  app.delete('/api/merchant/promotions/:id', requireAdmin, async (req, res) => {
    try {
      const ok = await softDeletePromotion(req.params.id);
      if (!ok) {
        return res.status(404).json({ error: 'NOT_FOUND' });
      }
      return res.json({ ok: true });
    } catch (err) {
      const { code, message } = extractUpstreamErrorCode(err);
      const status = (err && err.response && err.response.status) || err?.status || 502;
      logger.error(
        { status, code, err: message || err?.message || String(err), promoId: req.params.id },
        'Failed to delete merchant promotion',
      );
      return res.status(status).json({ error: code || 'UPSTREAM_UNAVAILABLE', message });
    }
  });

  app.get('/api/merchant/disputes', requireAdmin, async (req, res) => {
    const { merchantId, orderId, status, source, limit, offset } = req.query;
    try {
      const resp = await fetchBackendAdmin({
        method: 'GET',
        path: '/agent/internal/disputes',
        params: {
          ...(merchantId ? { merchantId } : {}),
          ...(orderId ? { orderId } : {}),
          ...(status ? { status } : {}),
          ...(source ? { source } : {}),
          ...(limit ? { limit } : {}),
          ...(offset ? { offset } : {}),
        },
      });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      const { code, message, data } = extractUpstreamErrorCode(err);
      const statusCode = err?.response?.status || err?.status || 500;
      return res.status(statusCode).json({
        error: code || 'FAILED_TO_FETCH_DISPUTES',
        message: message || 'Failed to fetch disputes',
        details: data || null,
      });
    }
  });

  app.post('/api/merchant/disputes/sync', requireAdmin, async (req, res) => {
    const orderId = req.body?.orderId || req.body?.order_id;
    const limit = req.body?.limit;

    if (!orderId) {
      return res.status(400).json({ error: 'MISSING_ORDER_ID', message: 'orderId is required' });
    }

    try {
      const resp = await fetchBackendAdmin({
        method: 'POST',
        path: '/agent/internal/disputes/sync',
        params: {
          orderId,
          ...(limit ? { limit } : {}),
        },
      });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      const { code, message, data } = extractUpstreamErrorCode(err);
      const statusCode = err?.response?.status || err?.status || 500;
      return res.status(statusCode).json({
        error: code || 'FAILED_TO_SYNC_DISPUTES',
        message: message || 'Failed to sync disputes',
        details: data || null,
      });
    }
  });

  app.get('/api/merchant/returns', requireAdmin, async (req, res) => {
    const { merchantId, status, limit, offset } = req.query;
    try {
      const resp = await fetchBackendAdmin({
        method: 'GET',
        path: '/agent/internal/returns',
        params: {
          ...(merchantId ? { merchantId } : {}),
          ...(status ? { status } : {}),
          ...(limit ? { limit } : {}),
          ...(offset ? { offset } : {}),
        },
      });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      const { code, message, data } = extractUpstreamErrorCode(err);
      const statusCode = err?.response?.status || err?.status || 500;
      return res.status(statusCode).json({
        error: code || 'FAILED_TO_FETCH_RETURNS',
        message: message || 'Failed to fetch returns',
        details: data || null,
      });
    }
  });

  app.post('/api/merchant/returns/sync', requireAdmin, async (req, res) => {
    const merchantId = req.body?.merchantId || req.body?.merchant_id;
    const limit = req.body?.limit;
    const apiVersion = req.body?.apiVersion || req.body?.api_version;

    if (!merchantId) {
      return res.status(400).json({ error: 'MISSING_MERCHANT_ID', message: 'merchantId is required' });
    }

    try {
      const resp = await fetchBackendAdmin({
        method: 'POST',
        path: '/agent/internal/returns/sync',
        params: {
          merchantId,
          ...(limit ? { limit } : {}),
          ...(apiVersion ? { apiVersion } : {}),
        },
      });
      return res.status(resp.status).json(resp.data);
    } catch (err) {
      const { code, message, data } = extractUpstreamErrorCode(err);
      const statusCode = err?.response?.status || err?.status || 500;
      return res.status(statusCode).json({
        error: code || 'FAILED_TO_SYNC_RETURNS',
        message: message || 'Failed to sync returns',
        details: data || null,
      });
    }
  });

  app.post('/photos/presign', proxyPhotosToBackend);
  app.post('/photos/confirm', proxyPhotosToBackend);
  app.get('/photos/qc', proxyPhotosToBackend);
  app.delete('/photos', proxyPhotosToBackend);

  return {
    fetchBackendAdmin,
    proxyPhotosToBackend,
  };
}

module.exports = {
  createFetchBackendAdmin,
  createProxyPhotosToBackend,
  registerMerchantOpsRoutes,
};

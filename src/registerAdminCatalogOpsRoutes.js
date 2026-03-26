function registerAdminCatalogOpsRoutes({
  app,
  requireAdmin,
  listMissingCatalogProducts,
  missingCatalogProductsToCsv,
  creatorCatalogAutoSyncEnabled,
  adminApiKey,
  creatorCatalogCacheTtlSeconds,
  creatorCatalogAutoSyncTimeoutMs,
  pivotaApiBase,
  axiosClient,
  parsePositiveInt,
  getCreatorCatalogAutoSyncLimitConfig,
  resolveCatalogSyncMerchantIds,
  getCatalogSyncSuppressionStatus,
  catalogSyncState,
  isCatalogSyncTimeoutError,
  isCatalogSyncInvalidMerchantError,
} = {}) {
  app.get('/api/admin/missing-catalog-products', requireAdmin, async (req, res) => {
    const format = String(req.query.format || '').trim().toLowerCase() || 'json';
    const limit = req.query.limit;
    const offset = req.query.offset;
    const sort = req.query.sort;
    const since = req.query.since;

    const out = await listMissingCatalogProducts({
      limit,
      offset,
      sort,
      since,
    });

    if (!out.ok) {
      return res.status(500).json({
        error: 'MISSING_CATALOG_PRODUCTS_UNAVAILABLE',
        reason: out.reason || 'unknown',
        ...(out.error ? { message: out.error } : {}),
      });
    }

    if (format === 'csv') {
      const csv = missingCatalogProductsToCsv(out.rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="missing_catalog_products_${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.status(200).send(csv);
    }

    return res.json({ ok: true, rows: out.rows });
  });

  app.post('/api/admin/catalog-sync/run', requireAdmin, async (req, res) => {
    if (!creatorCatalogAutoSyncEnabled) {
      return res.status(409).json({
        ok: false,
        error: 'CATALOG_SYNC_DISABLED',
        message: 'Creator catalog auto-sync is disabled',
      });
    }

    const syncAdminKey = process.env.CREATOR_CATALOG_SYNC_ADMIN_KEY || adminApiKey;
    if (!syncAdminKey) {
      return res.status(500).json({
        ok: false,
        error: 'SYNC_ADMIN_KEY_NOT_CONFIGURED',
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const merchantId = String(body.merchant_id || body.merchantId || '').trim();
    const ignoreSuppression =
      body.ignore_suppression === true || body.ignoreSuppression === true;
    const limitOverride = parsePositiveInt(
      body.limit_override ?? body.limitOverride,
      null,
      { min: 1, max: 5000 },
    );
    const limitConfig = getCreatorCatalogAutoSyncLimitConfig();
    const limitEffective = limitOverride ?? limitConfig.limitEffective;
    const target = merchantId
      ? { merchantIds: [merchantId], source: 'manual_merchant_id' }
      : await resolveCatalogSyncMerchantIds();
    const targetMerchantIds = Array.isArray(target?.merchantIds) ? target.merchantIds : [];
    const nowMs = Date.now();
    const eligibleMerchantIds = [];
    const suppressedMerchants = [];

    for (const candidateMerchantId of targetMerchantIds) {
      const suppression = getCatalogSyncSuppressionStatus(candidateMerchantId, nowMs);
      if (!ignoreSuppression && suppression.suppressed) {
        suppressedMerchants.push({
          merchant_id: candidateMerchantId,
          reason: suppression.reason,
          blocked_until: suppression.blocked_until,
          invalid_merchant: suppression.invalid_merchant,
        });
        continue;
      }
      eligibleMerchantIds.push(candidateMerchantId);
    }

    catalogSyncState.target_source = target?.source || null;
    catalogSyncState.target_count = targetMerchantIds.length;
    catalogSyncState.target_eligible_count = eligibleMerchantIds.length;
    catalogSyncState.target_suppressed_count = suppressedMerchants.length;
    catalogSyncState.target_sample = targetMerchantIds.slice(0, 20);
    catalogSyncState.target_suppressed_sample = suppressedMerchants.slice(0, 20);
    catalogSyncState.last_run_at = new Date().toISOString();
    catalogSyncState.last_error = null;

    const results = [];
    for (const candidateMerchantId of eligibleMerchantIds) {
      const url = `${pivotaApiBase}/agent/internal/shopify/products/sync/${encodeURIComponent(
        candidateMerchantId,
      )}?limit=${encodeURIComponent(String(limitEffective))}&ttl_seconds=${encodeURIComponent(
        String(creatorCatalogCacheTtlSeconds),
      )}`;
      try {
        const upstream = await axiosClient.post(url, null, {
          headers: { 'X-ADMIN-KEY': syncAdminKey },
          timeout: creatorCatalogAutoSyncTimeoutMs,
        });
        const summary =
          upstream?.data && upstream.data.summary ? upstream.data.summary : upstream?.data || null;
        catalogSyncState.per_merchant[candidateMerchantId] = {
          ok: true,
          skipped: false,
          last_run_at: new Date().toISOString(),
          attempts: 1,
          duration_ms: 0,
          summary,
          status: Number.isFinite(Number(upstream?.status)) ? Number(upstream.status) : 200,
          timeout_ms: creatorCatalogAutoSyncTimeoutMs,
          timeout_streak: 0,
          invalid_merchant: false,
          error: null,
          blocked_until_ms: null,
          blocked_until: null,
        };
        catalogSyncState.last_success_at = new Date().toISOString();
        results.push({
          merchant_id: candidateMerchantId,
          ok: true,
          status: Number.isFinite(Number(upstream?.status)) ? Number(upstream.status) : 200,
          summary,
        });
      } catch (err) {
        const status = Number.isFinite(Number(err?.response?.status))
          ? Number(err.response.status)
          : null;
        const message =
          err?.response?.data?.detail?.message ||
          (typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : null) ||
          err?.message ||
          'catalog_sync_failed';
        catalogSyncState.per_merchant[candidateMerchantId] = {
          ok: false,
          skipped: false,
          last_run_at: new Date().toISOString(),
          attempts: 1,
          duration_ms: 0,
          status,
          timeout_ms: creatorCatalogAutoSyncTimeoutMs,
          timeout_streak: isCatalogSyncTimeoutError(err) ? 1 : 0,
          invalid_merchant: isCatalogSyncInvalidMerchantError(err),
          error: message,
          blocked_until_ms: null,
          blocked_until: null,
        };
        catalogSyncState.last_error = `${candidateMerchantId}: ${message}`;
        results.push({
          merchant_id: candidateMerchantId,
          ok: false,
          status,
          error: message,
        });
      }
    }

    const ok = results.every((item) => item.ok === true);
    return res.status(ok ? 200 : 502).json({
      ok,
      requested: {
        merchant_id: merchantId || null,
        limit_override: limitOverride,
        ignore_suppression: ignoreSuppression,
      },
      result: {
        ok,
        trigger_source: 'admin_manual',
        target_source: target?.source || null,
        target_count: targetMerchantIds.length,
        target_eligible_count: eligibleMerchantIds.length,
        target_suppressed_count: suppressedMerchants.length,
        limit_effective: limitEffective,
        target_sample: targetMerchantIds.slice(0, 20),
        target_suppressed_sample: suppressedMerchants.slice(0, 20),
        results,
      },
    });
  });
}

module.exports = {
  registerAdminCatalogOpsRoutes,
};

function registerGatewaySupportRoutes({
  app,
  logger,
  env = process.env,
  healthRouteHandler,
  queryDb,
  serviceName,
  serviceGitShaShort,
  serviceGitSha,
  serviceBuildId,
  serviceGitBranch,
  serviceDeploymentId,
  serviceStartedAt,
  mountLookReplicatorRoutes,
  lookReplicatorCommerceClient,
  mountOutcomeTelemetryRoutes,
  mountLookReplicatorEventRoutes,
  mountUiEventRoutes,
  mountExternalOfferRoutes,
  mountRecommendationRoutes,
  mountAuroraBffRoutes,
  auroraRoutesReady,
  auroraRoutesLoadError,
  isAuroraDegradedPath,
  createRequestId,
  mountLayer1CompatibilityRoutes,
  mountLayer1BundleRoutes,
  buildCreatorCategoryTree,
  getCreatorCategoryProducts,
  requireAdmin,
  getAllPromotions,
} = {}) {
  app.get('/healthz', healthRouteHandler);
  app.get('/health', healthRouteHandler);

  app.get('/version', (req, res) => {
    return res.json({
      ok: true,
      service: serviceName,
      commit: serviceGitShaShort,
      full_sha: serviceGitSha || null,
      build_id: serviceBuildId,
      branch: serviceGitBranch || null,
      deployment_id: serviceDeploymentId || null,
      started_at: serviceStartedAt,
    });
  });

  app.get('/healthz/db', async (req, res) => {
    if (!env.DATABASE_URL) {
      return res.status(200).json({ ok: true, db_ready: false, reason: 'DATABASE_URL not configured' });
    }
    try {
      await queryDb('SELECT 1');
      return res.status(200).json({ ok: true, db_ready: true });
    } catch (err) {
      return res.status(200).json({ ok: true, db_ready: false, error: err.message });
    }
  });

  mountLookReplicatorRoutes(app, {
    logger,
    commerceClient: lookReplicatorCommerceClient,
  });

  mountOutcomeTelemetryRoutes(app, { logger });
  mountLookReplicatorEventRoutes(app, { logger });
  mountUiEventRoutes(app, { logger });
  mountExternalOfferRoutes(app);
  mountRecommendationRoutes(app);

  mountAuroraBffRoutes(app, { logger });
  if (!auroraRoutesReady) {
    app.use((req, res, next) => {
      if (!isAuroraDegradedPath(req.path)) return next();
      const requestId = String(req.get('x-request-id') || req.get('x-requestid') || createRequestId()).trim();
      const traceId = String(req.get('x-trace-id') || req.query.trace_id || requestId).trim();
      logger.error(
        {
          request_id: requestId,
          trace_id: traceId,
          path: req.path,
          aurora_routes_error: auroraRoutesLoadError,
        },
        'aurora_routes_degraded',
      );
      return res.status(503).json({
        request_id: requestId,
        trace_id: traceId,
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${requestId}`,
            type: 'error',
            payload: {
              error_code: 'AURORA_ROUTES_UNAVAILABLE',
              message: 'Aurora service is temporarily unavailable. Please retry shortly.',
            },
          },
        ],
        session_patch: {
          meta: {
            aurora_routes_ready: false,
            gate_policy_version: 'aurora_gate_policy_answer_first_v1',
          },
        },
        events: [
          {
            event_name: 'aurora_routes_degraded',
            timestamp: Date.now(),
            request_id: requestId,
            trace_id: traceId,
            data: {
              path: req.path,
              error: auroraRoutesLoadError || 'routes_unavailable',
            },
          },
        ],
      });
    });
  }

  mountLayer1CompatibilityRoutes(app, { logger });
  mountLayer1BundleRoutes(app, { logger });

  app.get('/creator/:creatorId/categories', async (req, res) => {
    const creatorId = req.params.creatorId;
    const includeCounts =
      req.query.includeCounts === undefined ? true : req.query.includeCounts !== 'false';
    const includeEmpty = req.query.includeEmpty === 'true';
    const dealsOnly = req.query.dealsOnly === 'true';
    const locale = req.query.locale ? String(req.query.locale) : undefined;
    const viewId = req.query.view ? String(req.query.view) : undefined;

    try {
      const tree = await buildCreatorCategoryTree(creatorId, {
        includeCounts,
        includeEmpty,
        dealsOnly,
        ...(locale ? { locale } : {}),
        ...(viewId ? { viewId } : {}),
      });
      return res.json(tree);
    } catch (err) {
      if (err.code === 'UNKNOWN_CREATOR') {
        return res.status(404).json({ error: 'Unknown creator' });
      }
      logger.error({ err: err.message, creatorId }, 'Failed to build creator category tree');
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  app.get('/creator/:creatorId/categories/:categorySlug/products', async (req, res) => {
    const creatorId = req.params.creatorId;
    const categorySlug = req.params.categorySlug;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const locale = req.query.locale ? String(req.query.locale) : undefined;
    const viewId = req.query.view ? String(req.query.view) : undefined;

    try {
      const result = await getCreatorCategoryProducts(creatorId, categorySlug, {
        page,
        limit,
        ...(locale ? { locale } : {}),
        ...(viewId ? { viewId } : {}),
      });
      return res.json(result);
    } catch (err) {
      if (err.code === 'UNKNOWN_CREATOR') {
        return res.status(404).json({ error: 'Unknown creator' });
      }
      if (err.code === 'UNKNOWN_CATEGORY') {
        return res.status(404).json({ error: 'Unknown category' });
      }
      logger.error(
        { err: err.message, creatorId, categorySlug },
        'Failed to load creator category products',
      );
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  app.get('/debug/promotions-config', (req, res) => {
    const promoBackendBase =
      env.PROMOTIONS_BACKEND_BASE_URL || env.PIVOTA_API_BASE || '';
    const promoMode = env.PROMOTIONS_MODE || 'local';
    const useRemotePromo = !!promoBackendBase && promoMode !== 'local';
    const promoAdminKeyPresent =
      !!(env.PROMOTIONS_ADMIN_KEY || env.ADMIN_API_KEY);

    res.json({
      promoMode,
      promoBackendBase,
      useRemotePromo,
      promoAdminKeyPresent,
    });
  });

  app.get('/debug/promotions', requireAdmin, async (req, res) => {
    try {
      const promos = await getAllPromotions();
      res.json(promos);
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to load promotions in debug endpoint');
      res.status(500).json({ error: 'FAILED_TO_LOAD_PROMOTIONS', message: err.message });
    }
  });
}

module.exports = {
  registerGatewaySupportRoutes,
};

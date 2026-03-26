const {
  parseQueryBoolean: parseQueryBooleanBase,
  parseQueryNumber: parseQueryNumberBase,
} = require('./commerce/catalog/searchQueryParams');
const {
  buildSellableStatusPredicate: buildSellableStatusPredicateBase,
} = require('./commerce/catalog/sellability');

function registerAdminDiagnosticsRoutes({
  app,
  requireAdmin,
  parseQueryNumber = parseQueryNumberBase,
  parseQueryBoolean = parseQueryBooleanBase,
  shouldUseResolverFirstSearch,
  isStrongResolverFirstQuery,
  resolveProductRef,
  proxySearchResolverTimeoutMs,
  pivotaApiBase,
  pivotaApiKey,
  hasDatabase,
  creatorCatalogAutoSyncEnabled,
  buildCatalogSyncSnapshot,
  searchCrossMerchantFromCache,
  getCreatorCatalogMerchantIds,
  resolveCatalogSyncMerchantIds,
  queryDb,
  buildSellableStatusPredicate = buildSellableStatusPredicateBase,
  createHashFn,
  proxySearchResolverFirstEnabled,
  proxySearchResolverFirstStrongOnly,
  proxySearchResolverFirstDisableAurora,
} = {}) {
  app.get('/api/admin/search-diagnostics', requireAdmin, async (req, res) => {
    const queryText = String(req.query.q || req.query.query || '').trim();
    if (!queryText) {
      return res.status(400).json({
        error: 'MISSING_QUERY',
        message: 'Provide q or query parameter',
      });
    }

    const lang = String(req.query.lang || 'en').trim().toLowerCase() || 'en';
    const source = String(req.query.source || 'shopping_agent').trim().toLowerCase() || 'shopping_agent';
    const requestedLimit = parseQueryNumber(req.query.limit);
    const limit = Math.min(Math.max(1, Number(requestedLimit || 10)), 50);
    const inStockOnlyRaw = parseQueryBoolean(req.query.in_stock_only ?? req.query.inStockOnly);
    const inStockOnly = inStockOnlyRaw !== false;
    const startedAt = Date.now();

    const resolverFirstWouldApply = shouldUseResolverFirstSearch({
      operation: 'find_products_multi',
      metadata: null,
      queryText,
      allowBroadCatalog: true,
    });
    const strongResolverQuery = isStrongResolverFirstQuery(queryText);

    const buildResolverView = (result) => ({
      resolved: Boolean(result?.resolved),
      reason: result?.reason || null,
      product_ref: result?.product_ref || null,
      confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : null,
      latency_ms: Number.isFinite(Number(result?.metadata?.latency_ms))
        ? Number(result.metadata.latency_ms)
        : null,
      sources: Array.isArray(result?.metadata?.sources) ? result.metadata.sources : [],
    });

    let resolverWithAlias = null;
    let resolverWithoutAlias = null;
    try {
      resolverWithAlias = await resolveProductRef({
        query: queryText,
        lang,
        hints: null,
        options: {
          search_all_merchants: true,
          timeout_ms: Math.max(proxySearchResolverTimeoutMs, 1600),
          upstream_retries: 0,
          stable_alias_short_circuit: true,
        },
        pivotaApiBase,
        pivotaApiKey,
        checkoutToken: null,
      });
    } catch (err) {
      resolverWithAlias = {
        resolved: false,
        reason: 'resolver_exception',
        metadata: { sources: [], error: err?.message || String(err) },
      };
    }

    try {
      resolverWithoutAlias = await resolveProductRef({
        query: queryText,
        lang,
        hints: null,
        options: {
          search_all_merchants: true,
          timeout_ms: Math.max(proxySearchResolverTimeoutMs, 1600),
          upstream_retries: 0,
          stable_alias_short_circuit: false,
        },
        pivotaApiBase,
        pivotaApiKey,
        checkoutToken: null,
      });
    } catch (err) {
      resolverWithoutAlias = {
        resolved: false,
        reason: 'resolver_exception',
        metadata: { sources: [], error: err?.message || String(err) },
      };
    }

    let crossMerchantCache = {
      ok: false,
      reason: 'db_not_configured',
      total: 0,
      products_count: 0,
      retrieval_sources: [],
      sample_products: [],
    };
    if (hasDatabase) {
      try {
        const fromCache = await searchCrossMerchantFromCache(queryText, 1, limit, { inStockOnly });
        crossMerchantCache = {
          ok: true,
          reason: null,
          total: Number(fromCache.total || 0),
          products_count: Array.isArray(fromCache.products) ? fromCache.products.length : 0,
          retrieval_sources: fromCache.retrieval_sources || [],
          sample_products: (fromCache.products || []).slice(0, 3).map((item) => ({
            product_id: item?.product_id || item?.id || null,
            merchant_id: item?.merchant_id || item?.merchantId || null,
            title: item?.title || item?.name || null,
            status: item?.status || null,
          })),
        };
      } catch (err) {
        crossMerchantCache = {
          ok: false,
          reason: 'cache_query_failed',
          error: err?.message || String(err),
          total: 0,
          products_count: 0,
          retrieval_sources: [],
          sample_products: [],
        };
      }
    }

    const aliasDependency =
      Boolean(resolverWithAlias?.resolved) &&
      !Boolean(resolverWithoutAlias?.resolved);

    return res.json({
      ok: true,
      query: queryText,
      language: lang,
      source,
      timing_ms: Math.max(0, Date.now() - startedAt),
      config: {
        resolver_first_enabled: Boolean(proxySearchResolverFirstEnabled),
        resolver_first_strong_only: Boolean(proxySearchResolverFirstStrongOnly),
        resolver_first_disable_aurora: Boolean(proxySearchResolverFirstDisableAurora),
        resolver_first_would_apply: resolverFirstWouldApply,
        resolver_query_is_strong: strongResolverQuery,
        resolver_timeout_ms: proxySearchResolverTimeoutMs,
        db_configured: Boolean(hasDatabase),
        catalog_auto_sync_enabled: creatorCatalogAutoSyncEnabled,
      },
      catalog_sync: buildCatalogSyncSnapshot(),
      resolver: {
        alias_dependency: aliasDependency,
        with_stable_alias: buildResolverView(resolverWithAlias),
        without_stable_alias: buildResolverView(resolverWithoutAlias),
      },
      cross_merchant_cache: crossMerchantCache,
    });
  });

  app.get('/api/admin/catalog-cache-diagnostics', requireAdmin, async (req, res) => {
    if (!hasDatabase) {
      return res.status(503).json({
        ok: false,
        error: 'DB_NOT_CONFIGURED',
        message: 'DATABASE_URL is not configured on gateway',
      });
    }

    const queryText = String(req.query.q || req.query.query || '').trim();
    const merchantId = String(req.query.merchant_id || req.query.merchantId || '').trim();
    const requestedLimit = parseQueryNumber(req.query.limit_merchants ?? req.query.limitMerchants);
    const limitMerchants = Math.min(Math.max(1, Number(requestedLimit || 20)), 200);
    const startedAt = Date.now();

    const creatorMerchantIds = getCreatorCatalogMerchantIds();
    let syncTargetMerchants = { merchantIds: [], source: 'not_resolved' };
    const matchFields = [
      "lower(coalesce(product_data->>'title',''))",
      "lower(coalesce(product_data->>'description',''))",
      "lower(coalesce(product_data->>'product_type',''))",
      "lower(coalesce(product_data->>'sku',''))",
      "lower(coalesce(product_data->>'vendor',''))",
      "lower(coalesce(product_data->>'brand',''))",
    ];

    const parseCount = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    try {
      syncTargetMerchants = await resolveCatalogSyncMerchantIds();

      const idRes = await queryDb(
        `
          SELECT
            current_database() AS database_name,
            current_schema() AS schema_name,
            current_user AS user_name,
            inet_server_addr()::text AS server_addr,
            inet_server_port()::text AS server_port
        `,
        [],
      );
      const idRow = idRes.rows?.[0] || {};
      const dbIdentity = {
        database_name: idRow.database_name || null,
        schema_name: idRow.schema_name || null,
        user_name: idRow.user_name || null,
        server_addr: idRow.server_addr || null,
        server_port: idRow.server_port || null,
      };
      const dbFingerprint = createHashFn('sha256')
        .update(
          [
            dbIdentity.database_name || '',
            dbIdentity.schema_name || '',
            dbIdentity.server_addr || '',
            dbIdentity.server_port || '',
            dbIdentity.user_name || '',
          ].join('|'),
        )
        .digest('hex')
        .slice(0, 16);

      const globalTotalsRes = await queryDb(
        `
          SELECT
            COUNT(*)::bigint AS total_rows,
            COUNT(*) FILTER (WHERE (expires_at IS NULL OR expires_at > now()))::bigint AS not_expired_rows,
            COUNT(*) FILTER (
              WHERE (expires_at IS NULL OR expires_at > now())
                AND ${buildSellableStatusPredicate("product_data->>'status'")}
                AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
            )::bigint AS sellable_rows,
            MAX(cached_at) AS latest_cached_at,
            MAX(expires_at) AS latest_expires_at
          FROM products_cache
        `,
        [],
      );
      const globalTotalsRow = globalTotalsRes.rows?.[0] || {};

      const byMerchantRes = await queryDb(
        `
          SELECT
            merchant_id,
            COUNT(*)::bigint AS total_rows,
            COUNT(*) FILTER (WHERE (expires_at IS NULL OR expires_at > now()))::bigint AS not_expired_rows,
            COUNT(*) FILTER (
              WHERE (expires_at IS NULL OR expires_at > now())
                AND ${buildSellableStatusPredicate("product_data->>'status'")}
                AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
            )::bigint AS sellable_rows,
            MAX(cached_at) AS latest_cached_at,
            MAX(expires_at) AS latest_expires_at
          FROM products_cache
          GROUP BY merchant_id
          ORDER BY sellable_rows DESC, total_rows DESC, merchant_id ASC
          LIMIT $1
        `,
        [limitMerchants],
      );

      const creatorMerchantStats = creatorMerchantIds.length
        ? await queryDb(
            `
              SELECT
                merchant_id,
                COUNT(*)::bigint AS total_rows,
                COUNT(*) FILTER (WHERE (expires_at IS NULL OR expires_at > now()))::bigint AS not_expired_rows,
                COUNT(*) FILTER (
                  WHERE (expires_at IS NULL OR expires_at > now())
                    AND ${buildSellableStatusPredicate("product_data->>'status'")}
                    AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
                )::bigint AS sellable_rows,
                MAX(cached_at) AS latest_cached_at
              FROM products_cache
              WHERE merchant_id = ANY($1)
              GROUP BY merchant_id
              ORDER BY merchant_id ASC
            `,
            [creatorMerchantIds],
          )
        : { rows: [] };

      const onboardingByCreator = creatorMerchantIds.length
        ? await queryDb(
            `
              SELECT merchant_id, status, psp_connected
              FROM merchant_onboarding
              WHERE merchant_id = ANY($1)
              ORDER BY merchant_id ASC
            `,
            [creatorMerchantIds],
          )
        : { rows: [] };

      const scopedWhereParts = [];
      const scopedParams = [];
      let scopedIdx = 1;
      if (merchantId) {
        scopedWhereParts.push(`merchant_id = $${scopedIdx}`);
        scopedParams.push(merchantId);
        scopedIdx += 1;
      }
      const scopedWhere = scopedWhereParts.length ? `WHERE ${scopedWhereParts.join(' AND ')}` : '';

      let queryProbe = null;
      if (queryText) {
        const qValue = `%${String(queryText).toLowerCase()}%`;
        const fieldOrs = matchFields.map((field) => `${field} LIKE $${scopedIdx}`).join(' OR ');

        const fieldLikeSql = `
          SELECT COUNT(*)::bigint AS field_like_rows
          FROM products_cache
          ${scopedWhere}
          ${scopedWhere ? 'AND' : 'WHERE'} (${fieldOrs})
        `;
        const jsonLikeSql = `
          SELECT COUNT(*)::bigint AS json_like_rows
          FROM products_cache
          ${scopedWhere}
          ${scopedWhere ? 'AND' : 'WHERE'} lower(CAST(product_data AS TEXT)) LIKE $${scopedIdx}
        `;
        const sampleSql = `
          SELECT
            merchant_id,
            product_data->>'title' AS title,
            product_data->>'status' AS status,
            COALESCE(product_data->>'product_id', product_data->>'id') AS product_id,
            cached_at,
            expires_at
          FROM products_cache
          ${scopedWhere}
          ${scopedWhere ? 'AND' : 'WHERE'} lower(CAST(product_data AS TEXT)) LIKE $${scopedIdx}
          ORDER BY cached_at DESC NULLS LAST, id DESC
          LIMIT 5
        `;

        const queryParams = [...scopedParams, qValue];
        const [fieldLikeRes, jsonLikeRes, sampleRes] = await Promise.all([
          queryDb(fieldLikeSql, queryParams),
          queryDb(jsonLikeSql, queryParams),
          queryDb(sampleSql, queryParams),
        ]);

        queryProbe = {
          query: queryText,
          merchant_scope: merchantId || null,
          field_like_rows: parseCount(fieldLikeRes.rows?.[0]?.field_like_rows),
          json_like_rows: parseCount(jsonLikeRes.rows?.[0]?.json_like_rows),
          sample_rows: (sampleRes.rows || []).map((row) => ({
            merchant_id: row.merchant_id || null,
            product_id: row.product_id || null,
            title: row.title || null,
            status: row.status || null,
            cached_at: row.cached_at || null,
            expires_at: row.expires_at || null,
          })),
        };
      }

      return res.json({
        ok: true,
        timing_ms: Math.max(0, Date.now() - startedAt),
        db: {
          ...dbIdentity,
          fingerprint: dbFingerprint,
        },
        gateway: {
          api_base: pivotaApiBase,
          catalog_auto_sync_enabled: creatorCatalogAutoSyncEnabled,
        },
        catalog_sync: buildCatalogSyncSnapshot(),
        totals: {
          total_rows: parseCount(globalTotalsRow.total_rows),
          not_expired_rows: parseCount(globalTotalsRow.not_expired_rows),
          sellable_rows: parseCount(globalTotalsRow.sellable_rows),
          latest_cached_at: globalTotalsRow.latest_cached_at || null,
          latest_expires_at: globalTotalsRow.latest_expires_at || null,
        },
        creator_merchants: {
          configured: creatorMerchantIds,
          cache_rows: (creatorMerchantStats.rows || []).map((row) => ({
            merchant_id: row.merchant_id || null,
            total_rows: parseCount(row.total_rows),
            not_expired_rows: parseCount(row.not_expired_rows),
            sellable_rows: parseCount(row.sellable_rows),
            latest_cached_at: row.latest_cached_at || null,
          })),
          onboarding: (onboardingByCreator.rows || []).map((row) => ({
            merchant_id: row.merchant_id || null,
            status: row.status || null,
            psp_connected: row.psp_connected === true,
          })),
        },
        sync_targets: {
          source: syncTargetMerchants.source || null,
          merchants: Array.isArray(syncTargetMerchants.merchantIds)
            ? syncTargetMerchants.merchantIds
            : [],
        },
        merchants_top: (byMerchantRes.rows || []).map((row) => ({
          merchant_id: row.merchant_id || null,
          total_rows: parseCount(row.total_rows),
          not_expired_rows: parseCount(row.not_expired_rows),
          sellable_rows: parseCount(row.sellable_rows),
          latest_cached_at: row.latest_cached_at || null,
          latest_expires_at: row.latest_expires_at || null,
        })),
        query_probe: queryProbe,
      });
    } catch (err) {
      const code = String(err?.code || '').trim() || null;
      if (code === '42P01') {
        return res.status(500).json({
          ok: false,
          error: 'PRODUCTS_CACHE_TABLE_MISSING',
          message: err?.message || 'products_cache table does not exist',
        });
      }
      return res.status(500).json({
        ok: false,
        error: 'CATALOG_CACHE_DIAGNOSTIC_FAILED',
        code,
        message: err?.message || String(err),
      });
    }
  });
}

module.exports = {
  registerAdminDiagnosticsRoutes,
};

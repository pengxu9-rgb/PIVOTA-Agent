const {
  firstQueryParamValue: firstQueryParamValueBase,
  parseQueryNumber: parseQueryNumberBase,
} = require('./commerce/catalog/searchQueryParams');

function normalizeResolveLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'en';
  if (s === 'cn' || s === 'zh' || s === 'zh-cn' || s === 'zh_hans') return 'cn';
  return 'en';
}

function pickResolveOptions(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const prefer =
    o.prefer_merchants ||
    o.preferMerchants ||
    o.prefer_merchant_ids ||
    o.preferMerchantIds ||
    undefined;
  return {
    ...(prefer ? { prefer_merchants: prefer } : {}),
    ...(o.search_all_merchants !== undefined ? { search_all_merchants: o.search_all_merchants } : {}),
    ...(o.searchAllMerchants !== undefined ? { search_all_merchants: o.searchAllMerchants } : {}),
    ...(o.allow_external_seed !== undefined ? { allow_external_seed: o.allow_external_seed } : {}),
    ...(o.allowExternalSeed !== undefined ? { allow_external_seed: o.allowExternalSeed } : {}),
    ...(o.timeout_ms !== undefined ? { timeout_ms: o.timeout_ms } : {}),
    ...(o.timeoutMs !== undefined ? { timeout_ms: o.timeoutMs } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
    ...(o.candidates_limit !== undefined ? { candidates_limit: o.candidates_limit } : {}),
    ...(o.candidatesLimit !== undefined ? { candidates_limit: o.candidatesLimit } : {}),
    ...(o.min_confidence !== undefined ? { min_confidence: o.min_confidence } : {}),
    ...(o.minConfidence !== undefined ? { min_confidence: o.minConfidence } : {}),
    ...(o.upstream_retries !== undefined ? { upstream_retries: o.upstream_retries } : {}),
    ...(o.upstreamRetries !== undefined ? { upstream_retries: o.upstreamRetries } : {}),
    ...(o.upstream_retry_backoff_ms !== undefined
      ? { upstream_retry_backoff_ms: o.upstream_retry_backoff_ms }
      : {}),
    ...(o.upstreamRetryBackoffMs !== undefined
      ? { upstream_retry_backoff_ms: o.upstreamRetryBackoffMs }
      : {}),
    ...(o.stable_alias_short_circuit !== undefined
      ? { stable_alias_short_circuit: o.stable_alias_short_circuit }
      : {}),
    ...(o.stableAliasShortCircuit !== undefined
      ? { stable_alias_short_circuit: o.stableAliasShortCircuit }
      : {}),
    ...(o.allow_stable_alias_for_uuid !== undefined
      ? { allow_stable_alias_for_uuid: o.allow_stable_alias_for_uuid }
      : {}),
    ...(o.allowStableAliasForUuid !== undefined
      ? { allow_stable_alias_for_uuid: o.allowStableAliasForUuid }
      : {}),
  };
}

function normalizeResolveFailureCode(raw, fallback = 'no_candidates') {
  const code = String(raw || '').trim().toLowerCase();
  if (code === 'db_error' || code === 'upstream_timeout' || code === 'no_candidates') return code;
  return fallback;
}

function inferResolveFailureCode({ result, err } = {}) {
  const explicit = normalizeResolveFailureCode(
    result?.reason_code || result?.reasonCode || result?.metadata?.resolve_reason_code,
    '',
  );
  if (explicit) return explicit;

  const reason = String(result?.reason || '').trim().toLowerCase();
  if (reason === 'no_candidates' || reason === 'low_confidence' || reason === 'empty_query') {
    return 'no_candidates';
  }
  if (reason.startsWith('db_') || reason === 'products_cache_missing') return 'db_error';
  if (
    reason.includes('timeout') ||
    reason.startsWith('upstream_') ||
    reason === 'upstream_error'
  ) {
    return 'upstream_timeout';
  }

  const sourceReasons = Array.isArray(result?.metadata?.sources)
    ? result.metadata.sources
        .map((item) => String(item && item.reason ? item.reason : '').trim().toLowerCase())
        .filter(Boolean)
    : [];
  if (sourceReasons.some((r) => r.startsWith('db_') || r === 'products_cache_missing')) {
    return 'db_error';
  }
  if (sourceReasons.some((r) => r.includes('timeout') || r.startsWith('upstream_'))) {
    return 'upstream_timeout';
  }

  const errText = String(err?.code || err?.message || err || '').trim().toLowerCase();
  if (
    errText.includes('timeout') ||
    errText.includes('econnaborted') ||
    errText.includes('etimedout')
  ) {
    return 'upstream_timeout';
  }
  if (
    errText.includes('db_') ||
    errText.includes('database') ||
    errText.includes('postgres')
  ) {
    return 'db_error';
  }
  return 'no_candidates';
}

function createProductResolveRouteHandler({
  logger,
  resolveProductRef,
  parseQueryNumber = parseQueryNumberBase,
  firstQueryParamValue = firstQueryParamValueBase,
  resolveCatalogSyncMerchantIds,
  upsertMissingCatalogProduct,
  pivotaApiBase,
  pivotaApiKey,
  proxySearchAuroraViewDetailsExternalSeedEnabled,
  proxySearchAuroraViewDetailsExternalSeedStrategy,
  proxySearchAuroraViewDetailsMinTimeoutMs,
} = {}) {
  const safeLogger =
    logger && typeof logger === 'object'
      ? logger
      : {
          info() {},
          warn() {},
        };
  const resolveCatalogSyncMerchantIdsSafe =
    typeof resolveCatalogSyncMerchantIds === 'function'
      ? resolveCatalogSyncMerchantIds
      : async () => ({ merchantIds: [] });
  const upsertMissingCatalogProductSafe =
    typeof upsertMissingCatalogProduct === 'function'
      ? upsertMissingCatalogProduct
      : async () => {};

  return async function handleProductResolveRoute(req, res) {
    const checkoutToken =
      String(req.header('X-Checkout-Token') || req.header('x-checkout-token') || '').trim() ||
      null;

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const queryText = String(
      body.query || body.product_id || body.productId || body.sku_id || body.skuId || '',
    ).trim();
    const lang = normalizeResolveLang(body.lang);
    let options = pickResolveOptions(body.options);
    const hints =
      body.hints && typeof body.hints === 'object' && !Array.isArray(body.hints) ? body.hints : null;

    if (!queryText) {
      return res.status(400).json({
        error: 'MISSING_PARAMETERS',
        message: 'query is required',
      });
    }

    const callerHint = String(body.caller || '').trim().toLowerCase();
    const hasAuroraUid = Boolean(
      String(req.header('X-Aurora-Uid') || req.header('x-aurora-uid') || '').trim(),
    );
    const origin = String(req.headers.origin || '').trim();
    const shouldDefaultPreferMerchants =
      callerHint === 'aurora_chatbox' ||
      callerHint === 'aurora-chatbox' ||
      hasAuroraUid ||
      origin === 'https://aurora.pivota.cc';
    if (shouldDefaultPreferMerchants) {
      if (options.stable_alias_short_circuit === undefined) {
        options = { ...options, stable_alias_short_circuit: true };
      }
      if (options.allow_stable_alias_for_uuid === undefined) {
        options = { ...options, allow_stable_alias_for_uuid: true };
      }
    }

    const isAuroraViewDetailsResolve = shouldDefaultPreferMerchants;
    if (
      isAuroraViewDetailsResolve &&
      proxySearchAuroraViewDetailsExternalSeedEnabled
    ) {
      const requestedTimeoutMs = parseQueryNumber(options.timeout_ms ?? options.timeoutMs);
      options = {
        ...options,
        allow_external_seed: true,
        ...(firstQueryParamValue(
          options.external_seed_strategy ?? options.externalSeedStrategy,
        )
          ? {}
          : {
              external_seed_strategy:
                proxySearchAuroraViewDetailsExternalSeedStrategy,
            }),
        ...(requestedTimeoutMs != null &&
        requestedTimeoutMs >= proxySearchAuroraViewDetailsMinTimeoutMs
          ? {}
          : { timeout_ms: proxySearchAuroraViewDetailsMinTimeoutMs }),
        ...(options.search_all_merchants === undefined
          ? { search_all_merchants: true }
          : {}),
      };
    }

    const preferMerchantsRaw = options?.prefer_merchants;
    const hasPreferMerchants =
      (Array.isArray(preferMerchantsRaw) && preferMerchantsRaw.length > 0) ||
      (typeof preferMerchantsRaw === 'string' && preferMerchantsRaw.trim().length > 0);
    if (shouldDefaultPreferMerchants && !hasPreferMerchants) {
      const defaultMerchantsResult = await resolveCatalogSyncMerchantIdsSafe();
      const defaultMerchants = defaultMerchantsResult.merchantIds;
      if (defaultMerchants.length) {
        options = {
          ...options,
          prefer_merchants: defaultMerchants,
          ...(options.search_all_merchants === undefined
            ? { search_all_merchants: true }
            : {}),
          ...(options.upstream_retries === undefined ? { upstream_retries: 0 } : {}),
        };
      }
    }

    try {
      const result = await resolveProductRef({
        query: queryText,
        lang,
        hints,
        options,
        pivotaApiBase,
        pivotaApiKey,
        checkoutToken,
      });

      const unresolvedReasonCode = !result?.resolved
        ? inferResolveFailureCode({ result })
        : null;
      let responsePayload =
        !result?.resolved && unresolvedReasonCode
          ? {
              ...result,
              reason_code: unresolvedReasonCode,
              metadata: {
                ...(result?.metadata && typeof result.metadata === 'object'
                  ? result.metadata
                  : {}),
                resolve_reason_code: unresolvedReasonCode,
              },
            }
          : result;

      if (isAuroraViewDetailsResolve) {
        responsePayload = {
          ...(responsePayload && typeof responsePayload === 'object' ? responsePayload : {}),
          metadata: {
            ...(responsePayload?.metadata &&
            typeof responsePayload.metadata === 'object'
              ? responsePayload.metadata
              : {}),
            view_details_external_seed_enabled: Boolean(
              options?.allow_external_seed === true,
            ),
            view_details_external_seed_strategy:
              firstQueryParamValue(
                options?.external_seed_strategy ?? options?.externalSeedStrategy,
              ) || null,
            view_details_timeout_ms:
              parseQueryNumber(options?.timeout_ms ?? options?.timeoutMs) ||
              proxySearchAuroraViewDetailsMinTimeoutMs,
          },
        };
      }

      if (!responsePayload?.resolved) {
        const caller =
          String(body.caller || req.header('X-Caller') || req.header('User-Agent') || '')
            .trim()
            .slice(0, 120) || null;
        const sessionId =
          String(
            body.session_id ||
              body.sessionId ||
              req.header('X-Session-Id') ||
              req.header('x-session-id') ||
              '',
          )
            .trim()
            .slice(0, 120) || null;
        const event = {
          query: queryText,
          normalized_query: responsePayload?.normalized_query || null,
          lang,
          hints,
          caller,
          session_id: sessionId,
          reason: responsePayload?.reason || 'unresolved',
          reason_code: unresolvedReasonCode || null,
          timestamp: new Date().toISOString(),
        };
        safeLogger.info(
          { event_name: 'missing_catalog_product', ...event },
          'missing_catalog_product',
        );
        upsertMissingCatalogProductSafe(event).catch((err) => {
          safeLogger.warn(
            { err: err?.message || String(err) },
            'missing_catalog_product upsert failed',
          );
        });
      }

      return res.json(responsePayload);
    } catch (err) {
      const reasonCode = inferResolveFailureCode({ err });
      safeLogger.warn(
        { err: err?.message || String(err) },
        'products.resolve failed; returning unresolved',
      );
      return res.json({
        resolved: false,
        product_ref: null,
        confidence: 0,
        reason: 'internal_error',
        reason_code: reasonCode,
        candidates: [],
        normalized_query: queryText,
        metadata: {
          lang,
          error: 'internal_error',
          resolve_reason_code: reasonCode,
        },
      });
    }
  };
}

function registerProductResolveRoute({
  app,
  ...config
} = {}) {
  const handleProductResolveRoute = createProductResolveRouteHandler(config);
  app.post('/agent/v1/products/resolve', handleProductResolveRoute);
  return { handleProductResolveRoute };
}

module.exports = {
  normalizeResolveLang,
  pickResolveOptions,
  normalizeResolveFailureCode,
  inferResolveFailureCode,
  createProductResolveRouteHandler,
  registerProductResolveRoute,
};

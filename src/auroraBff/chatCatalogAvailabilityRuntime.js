function createChatCatalogAvailabilityRuntime(options = {}) {
  const {
    logger = null,
    AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED = false,
    detectCatalogAvailabilityIntent,
    shouldAllowCatalogAvailabilityShortCircuit,
    detectCatalogAvailabilityShortCircuitBlockReason,
    recordCatalogAvailabilityShortCircuit = () => {},
    buildAvailabilityCatalogQuery,
    isSpecificAvailabilityQuery,
    buildBrandPlaceholderProduct,
    PIVOTA_BACKEND_BASE_URL,
    searchPivotaBackendProducts,
    CATALOG_AVAIL_SEARCH_TIMEOUT_MS,
    CATALOG_AVAIL_RESOLVE_FALLBACK_ENABLED = false,
    CATALOG_AVAIL_RESOLVE_FALLBACK_ON_TRANSIENT = false,
    resolveAvailabilityProductByQuery,
    RECO_PDP_STRICT_INTERNAL_FIRST = false,
    resolveAvailabilityProductByLocalResolver,
    isSkincareCatalogProduct,
    recordCatalogPoisonBlock = () => {},
    applyOfferItemPdpOpenContract,
    summarizeOfferPdpOpen,
    applyCommerceMedicalClaimGuard,
    stateChangeAllowed,
    recordSessionPatchProfileEmitted,
  } = options;

  function requireFunction(name, value) {
    if (typeof value === 'function') return value;
    throw new Error(`aurora chat catalog availability runtime missing dependency: ${name}`);
  }

  async function maybeBuildCatalogAvailabilityEnvelope({
    ctx,
    message = '',
    shouldBypassAvailabilityShortCircuit = false,
    nextStateOverride = null,
    profile = null,
    appliedProfilePatch = null,
    buildEnvelope,
    makeChatAssistantMessage,
    makeEvent,
    summarizeChatProfileForContext,
  } = {}) {
    const detectCatalogAvailabilityIntentFn = requireFunction(
      'detectCatalogAvailabilityIntent',
      detectCatalogAvailabilityIntent,
    );
    const shouldAllowCatalogAvailabilityShortCircuitFn = requireFunction(
      'shouldAllowCatalogAvailabilityShortCircuit',
      shouldAllowCatalogAvailabilityShortCircuit,
    );
    const detectCatalogAvailabilityShortCircuitBlockReasonFn = requireFunction(
      'detectCatalogAvailabilityShortCircuitBlockReason',
      detectCatalogAvailabilityShortCircuitBlockReason,
    );
    const buildAvailabilityCatalogQueryFn = requireFunction(
      'buildAvailabilityCatalogQuery',
      buildAvailabilityCatalogQuery,
    );
    const isSpecificAvailabilityQueryFn = requireFunction(
      'isSpecificAvailabilityQuery',
      isSpecificAvailabilityQuery,
    );
    const buildBrandPlaceholderProductFn = requireFunction(
      'buildBrandPlaceholderProduct',
      buildBrandPlaceholderProduct,
    );
    const searchPivotaBackendProductsFn = requireFunction(
      'searchPivotaBackendProducts',
      searchPivotaBackendProducts,
    );
    const resolveAvailabilityProductByQueryFn = requireFunction(
      'resolveAvailabilityProductByQuery',
      resolveAvailabilityProductByQuery,
    );
    const resolveAvailabilityProductByLocalResolverFn = requireFunction(
      'resolveAvailabilityProductByLocalResolver',
      resolveAvailabilityProductByLocalResolver,
    );
    const isSkincareCatalogProductFn = requireFunction(
      'isSkincareCatalogProduct',
      isSkincareCatalogProduct,
    );
    const applyOfferItemPdpOpenContractFn = requireFunction(
      'applyOfferItemPdpOpenContract',
      applyOfferItemPdpOpenContract,
    );
    const summarizeOfferPdpOpenFn = requireFunction(
      'summarizeOfferPdpOpen',
      summarizeOfferPdpOpen,
    );
    const applyCommerceMedicalClaimGuardFn = requireFunction(
      'applyCommerceMedicalClaimGuard',
      applyCommerceMedicalClaimGuard,
    );
    const stateChangeAllowedFn = requireFunction('stateChangeAllowed', stateChangeAllowed);
    const recordSessionPatchProfileEmittedFn = requireFunction(
      'recordSessionPatchProfileEmitted',
      recordSessionPatchProfileEmitted,
    );
    const summarizeChatProfileForContextFn = requireFunction(
      'summarizeChatProfileForContext',
      summarizeChatProfileForContext,
    );
    const buildEnvelopeFn = requireFunction('buildEnvelope', buildEnvelope);
    const makeChatAssistantMessageFn = requireFunction(
      'makeChatAssistantMessage',
      makeChatAssistantMessage,
    );
    const makeEventFn = requireFunction('makeEvent', makeEvent);

    const availabilityIntent = detectCatalogAvailabilityIntentFn(message, ctx && (ctx.match_lang || ctx.lang));
    if (!availabilityIntent || shouldBypassAvailabilityShortCircuit) {
      return null;
    }

    const allowCatalogShortCircuit = AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED
      ? shouldAllowCatalogAvailabilityShortCircuitFn(message)
      : true;
    const catalogShortCircuitBlockReason = AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED
      ? detectCatalogAvailabilityShortCircuitBlockReasonFn(message)
      : '';
    if (!allowCatalogShortCircuit && catalogShortCircuitBlockReason) {
      if (logger && typeof logger.info === 'function') {
        logger.info(
          {
            request_id: ctx && ctx.request_id,
            trace_id: ctx && ctx.trace_id,
            catalog_availability_shortcircuit_block_reason: catalogShortCircuitBlockReason,
          },
          'aurora bff: catalog availability short-circuit blocked',
        );
      }
      return null;
    }

    recordCatalogAvailabilityShortCircuit({
      brandId: availabilityIntent.brand_id,
      reason: availabilityIntent.reason,
    });

    const availabilityQuery =
      String(availabilityIntent.query_hint || '').trim() ||
      buildAvailabilityCatalogQueryFn(message, availabilityIntent);
    const specificAvailabilityQuery = isSpecificAvailabilityQueryFn(availabilityQuery, availabilityIntent);
    const availabilityLabel = String(
      (specificAvailabilityQuery
        ? availabilityQuery
        : availabilityIntent.brand_name ||
          availabilityIntent.matched_alias ||
          availabilityQuery) ||
        (ctx && ctx.lang === 'CN' ? '目标商品' : 'target product'),
    )
      .trim()
      .slice(0, 120);

    const brandProduct = buildBrandPlaceholderProductFn({
      brandId: availabilityIntent.brand_id,
      brandName: availabilityLabel,
      lang: ctx && ctx.lang,
    });

    const resolveAliasCandidates = [
      availabilityIntent.brand_name,
      availabilityIntent.matched_alias,
      availabilityQuery,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    const resolveAliases = [...new Set(resolveAliasCandidates)].slice(0, 8);
    const resolveHints = {
      ...(availabilityIntent.brand_name ? { brand: availabilityIntent.brand_name } : {}),
      ...(resolveAliases.length ? { aliases: resolveAliases } : {}),
    };

    let catalogResult = { ok: false, products: [], reason: 'unknown' };
    let products = [];
    let availabilityResolveFallback = null;
    let availabilityLocalResolveFallback = null;
    let availabilityLocalResolveAttempted = false;
    if (PIVOTA_BACKEND_BASE_URL) {
      catalogResult = await searchPivotaBackendProductsFn({
        query: availabilityQuery || availabilityLabel || availabilityIntent.brand_id,
        limit: 8,
        logger,
        timeoutMs: CATALOG_AVAIL_SEARCH_TIMEOUT_MS,
      });
      products = Array.isArray(catalogResult.products) ? catalogResult.products : [];
    } else {
      catalogResult = { ok: false, products: [], reason: 'pivota_backend_not_configured' };
    }

    if (!products.length && CATALOG_AVAIL_RESOLVE_FALLBACK_ENABLED && PIVOTA_BACKEND_BASE_URL) {
      const reason = String(catalogResult.reason || '').trim().toLowerCase();
      const neutralCatalogMiss =
        !reason || reason === 'empty' || reason === 'no_candidates' || reason === 'not_found';
      const transientCatalogMiss =
        reason === 'upstream_timeout' || reason === 'upstream_error' || reason === 'rate_limited';
      const shouldRunResolveFallback =
        specificAvailabilityQuery &&
        (neutralCatalogMiss || (transientCatalogMiss && CATALOG_AVAIL_RESOLVE_FALLBACK_ON_TRANSIENT));
      if (shouldRunResolveFallback) {
        availabilityResolveFallback = await resolveAvailabilityProductByQueryFn({
          query: availabilityQuery || availabilityIntent.brand_name,
          lang: ctx && ctx.lang,
          hints: Object.keys(resolveHints).length ? resolveHints : null,
          logger,
        });
        if (availabilityResolveFallback && availabilityResolveFallback.ok && availabilityResolveFallback.product) {
          products = [availabilityResolveFallback.product];
        }
      }
    }

    if (!products.length && specificAvailabilityQuery && RECO_PDP_STRICT_INTERNAL_FIRST) {
      availabilityLocalResolveAttempted = true;
      availabilityLocalResolveFallback = await resolveAvailabilityProductByLocalResolverFn({
        query: availabilityQuery || availabilityIntent.brand_name,
        lang: ctx && ctx.lang,
        hints: Object.keys(resolveHints).length ? resolveHints : null,
        logger,
      });
      if (availabilityLocalResolveFallback && availabilityLocalResolveFallback.ok && availabilityLocalResolveFallback.product) {
        products = [availabilityLocalResolveFallback.product];
      }
    }

    let catalogPoisonBlockedCount = 0;
    if (AURORA_CATALOG_DOMAIN_GUARD_V1_ENABLED && Array.isArray(products) && products.length > 0) {
      const filteredProducts = products.filter((item) => isSkincareCatalogProductFn(item));
      catalogPoisonBlockedCount = Math.max(0, products.length - filteredProducts.length);
      products = filteredProducts;
      if (catalogPoisonBlockedCount > 0) {
        recordCatalogPoisonBlock(catalogPoisonBlockedCount);
      }
    }

    const offersItems = (products.length ? products : [brandProduct])
      .slice(0, 8)
      .map((product) => applyOfferItemPdpOpenContractFn({ product, offer: null }, { timeToPdpMs: 0 }));
    const offersPdpMeta = summarizeOfferPdpOpenFn(offersItems);

    const marketRaw = profile && typeof profile.region === 'string' ? profile.region.trim() : '';
    const market = marketRaw ? marketRaw.slice(0, 8).toUpperCase() : 'US';
    const hasResults = products.length > 0;
    const resolvedVia =
      availabilityResolveFallback && availabilityResolveFallback.ok
        ? 'products_resolve'
        : availabilityLocalResolveFallback && availabilityLocalResolveFallback.ok
          ? 'local_resolver'
          : hasResults
            ? 'products_search'
            : 'none';
    const assistantRaw =
      ctx && ctx.lang === 'CN'
        ? hasResults
          ? `我在商品库里找到了「${availabilityLabel || '该商品'}」的相关商品（见下方卡片）。你想查官方旗舰/自营，还是某个具体单品名？`
          : `我可以帮你查商品库，但当前没能拉到「${availabilityLabel || '该商品'}」的商品列表。你想查的是官方旗舰/自营，还是某个具体单品名？`
        : hasResults
          ? `I found ${products.length} items for "${availabilityLabel || 'this product'}" (see the cards below). Are you looking for an official store, major retailers, or a specific product name?`
          : `I can help check our catalog, but I couldn't fetch items for "${availabilityLabel || 'this product'}" right now. Are you looking for an official store, major retailers, or a specific product name?`;
    const assistantText = applyCommerceMedicalClaimGuardFn(assistantRaw, ctx && ctx.lang);

    const profileSummary = summarizeChatProfileForContextFn(profile);
    const sessionPatch = {
      ...(nextStateOverride && stateChangeAllowedFn(ctx && ctx.trigger_source) ? { next_state: nextStateOverride } : {}),
      ...(profileSummary ? { profile: profileSummary } : {}),
    };
    if (profileSummary) {
      recordSessionPatchProfileEmittedFn({ changed: Boolean(appliedProfilePatch) });
    }

    const fieldMissing = [];
    if (!hasResults && catalogResult.reason) {
      fieldMissing.push({ field: 'catalog.products', reason: String(catalogResult.reason).slice(0, 60) });
      if (catalogPoisonBlockedCount > 0) {
        fieldMissing.push({ field: 'catalog.domain_guard', reason: 'catalog_poison_block' });
      }
      if (availabilityResolveFallback && availabilityResolveFallback.resolve_reason_code) {
        fieldMissing.push({
          field: 'catalog.resolve',
          reason: String(availabilityResolveFallback.resolve_reason_code).slice(0, 60),
        });
      }
      if (availabilityLocalResolveFallback && availabilityLocalResolveFallback.resolve_reason_code) {
        fieldMissing.push({
          field: 'catalog.local_resolver',
          reason: String(availabilityLocalResolveFallback.resolve_reason_code).slice(0, 60),
        });
      }
    }

    return buildEnvelopeFn(ctx, {
      assistant_message: makeChatAssistantMessageFn(assistantText),
      suggested_chips: [],
      cards: [
        {
          card_id: `parse_${ctx.request_id}`,
          type: 'product_parse',
          payload: {
            product: hasResults && products[0] ? products[0] : brandProduct,
            confidence: 1,
            missing_info: [],
            intent: 'availability',
            brand_id: availabilityIntent.brand_id,
            brand_name: availabilityLabel,
          },
        },
        {
          card_id: `offers_${ctx.request_id}`,
          type: 'offers_resolved',
          payload: {
            items: offersItems,
            market,
            metadata: {
              pdp_open_path_stats: offersPdpMeta.path_stats,
              fail_reason_counts: offersPdpMeta.fail_reason_counts,
              time_to_pdp_ms_stats: offersPdpMeta.time_to_pdp_ms_stats,
            },
          },
          ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
        },
      ],
      session_patch: sessionPatch,
      events: [
        makeEventFn(ctx, 'catalog_availability_shortcircuit', {
          brand_id: availabilityIntent.brand_id,
          reason: availabilityIntent.reason,
          ok: Boolean(hasResults),
          count: products.length,
          query: String(availabilityQuery || '').slice(0, 120),
          resolved_via: resolvedVia,
          specific_query: specificAvailabilityQuery,
          catalog_reason: catalogResult.reason || null,
          resolve_reason_code: availabilityResolveFallback && availabilityResolveFallback.resolve_reason_code
            ? availabilityResolveFallback.resolve_reason_code
            : null,
          local_resolve_attempted: availabilityLocalResolveAttempted,
          local_resolve_reason_code: availabilityLocalResolveFallback && availabilityLocalResolveFallback.resolve_reason_code
            ? availabilityLocalResolveFallback.resolve_reason_code
            : null,
          catalog_poison_blocked_count: catalogPoisonBlockedCount,
        }),
      ],
    });
  }

  return {
    maybeBuildCatalogAvailabilityEnvelope,
  };
}

module.exports = {
  createChatCatalogAvailabilityRuntime,
};

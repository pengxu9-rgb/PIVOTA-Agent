const { normalizeOfferMoney } = require('./offerMoney');
const {
  buildOfferId: buildOfferIdBase,
  buildProductGroupId: buildProductGroupIdBase,
} = require('../../offers/offerIds');
const {
  extractUpstreamErrorCode: extractUpstreamErrorCodeBase,
} = require('../shared/extractUpstreamErrorCode');
const {
  fetchProductDetailForOffers: fetchProductDetailForOffersBase,
} = require('../catalog/productDetailAdapters');
const {
  resolveProductGroupCached: resolveProductGroupCachedBase,
  buildOffersFromGroupMembers: buildOffersFromGroupMembersBase,
} = require('./groupHelpers');

function normalizeGroupMembers(rawMembers) {
  return (Array.isArray(rawMembers) ? rawMembers : [])
    .map((member) => ({
      merchant_id: String(member?.merchant_id || member?.merchantId || '').trim(),
      merchant_name: member?.merchant_name || member?.merchantName || undefined,
      product_id: String(member?.product_id || member?.productId || '').trim(),
      platform: member?.platform ? String(member.platform).trim() : undefined,
      is_primary: Boolean(member?.is_primary || member?.isPrimary),
    }))
    .filter((member) => Boolean(member.merchant_id) && Boolean(member.product_id));
}

function shouldBypassResolveProductCandidatesCache(options) {
  return (
    options.no_cache === true ||
    options.cache_bypass === true ||
    options.bypass_cache === true ||
    String(options.no_cache || '').trim().toLowerCase() === 'true' ||
    String(options.cache_bypass || options.bypass_cache || '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function buildResolveProductCandidatesCacheKey({
  productId,
  requestedMerchantId,
  country,
  postalCode,
  limit,
  includeOffers,
  checkoutToken,
}) {
  return JSON.stringify({
    productId,
    merchantId: requestedMerchantId || null,
    country,
    postalCode,
    limit,
    includeOffers,
    hasCheckoutToken: Boolean(checkoutToken),
  });
}

function computeOfferTotal(offer) {
  return Number(offer?.price?.amount || 0) + Number(offer?.shipping?.cost?.amount || 0);
}

function dropOffersFromResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const { offers, ...rest } = result;
  return rest;
}

function maybeLogResolveProductCandidatesDebug({
  debug,
  nodeEnv,
  logger,
  operation,
  productId,
  cacheHit,
  cacheAgeMs,
  offersCount,
}) {
  if (!debug || String(nodeEnv || '').trim().toLowerCase() === 'production') {
    return;
  }
  logger.info(
    {
      operation,
      product_id: productId,
      cache_hit: Boolean(cacheHit),
      ...(Number.isFinite(Number(cacheAgeMs)) ? { cache_age_ms: Number(cacheAgeMs) } : {}),
      offers_count: offersCount,
    },
    'resolve_product_candidates debug',
  );
}

function buildOffersFromProducts({
  offerProducts,
  groupMembers,
  productGroupId,
  requestedMerchantId,
  productId,
  anchor,
  buildOfferId,
}) {
  const merchantNameById = new Map(
    (Array.isArray(groupMembers) ? groupMembers : [])
      .map((member) => [String(member.merchant_id || '').trim(), member.merchant_name])
      .filter(([merchantId]) => Boolean(merchantId)),
  );

  const offers = (Array.isArray(offerProducts) ? offerProducts : []).map((product) => {
    const merchantId = String(product?.merchant_id || '').trim();
    const offerProductId = String(product?.product_id || '').trim() || undefined;
    const currency = product?.currency || 'USD';
    const shippingCost = product?.shipping?.cost || product?.shipping_cost || null;
    const shippingCostAmount =
      shippingCost == null
        ? undefined
        : Number(typeof shippingCost === 'object' ? shippingCost.amount : shippingCost);
    const shippingCostCurrency =
      shippingCost && typeof shippingCost === 'object'
        ? String(shippingCost.currency || currency)
        : currency;
    const etaRaw = product?.shipping?.eta_days_range || product?.shipping?.etaDaysRange || null;
    const etaRange =
      Array.isArray(etaRaw) && etaRaw.length >= 2
        ? [Number(etaRaw[0]) || 0, Number(etaRaw[1]) || 0]
        : undefined;

    return {
      offer_id:
        buildOfferId({
          merchant_id: merchantId,
          product_group_id: productGroupId,
          fulfillment_type: product?.fulfillment_type || 'merchant',
          tier: 'default',
        }) ||
        `of:v1:${merchantId}:${productGroupId}:${product?.fulfillment_type || 'merchant'}:default`,
      product_group_id: productGroupId,
      product_id: offerProductId,
      merchant_id: merchantId,
      merchant_name:
        product?.merchant_name || product?.store_name || merchantNameById.get(merchantId) || undefined,
      price: normalizeOfferMoney(product?.price, currency),
      shipping:
        product?.shipping || etaRange || shippingCostAmount != null
          ? {
              method_label:
                product?.shipping?.method_label || product?.shipping?.methodLabel || undefined,
              eta_days_range: etaRange,
              ...(shippingCostAmount != null && Number.isFinite(shippingCostAmount)
                ? {
                    cost: normalizeOfferMoney(shippingCostAmount, shippingCostCurrency),
                  }
                : {}),
            }
          : undefined,
      returns: product?.returns || undefined,
      inventory: {
        in_stock: typeof product?.in_stock === 'boolean' ? product.in_stock : undefined,
      },
      fulfillment_type: product?.fulfillment_type || undefined,
      risk_tier: 'standard',
    };
  });

  const sortedByTotal = [...offers].sort((left, right) => computeOfferTotal(left) - computeOfferTotal(right));
  const bestPriceOfferId = sortedByTotal[0]?.offer_id || null;
  const anchorByProductIdMerchantId =
    !requestedMerchantId && Array.isArray(groupMembers) && groupMembers.length > 0
      ? String(
          groupMembers.find((member) => String(member.product_id || '').trim() === productId)?.merchant_id || '',
        ).trim() || null
      : null;
  const preferredMerchantId =
    (requestedMerchantId ? String(requestedMerchantId).trim() : null) ||
    anchorByProductIdMerchantId ||
    (anchor ? String(anchor.merchant_id || '').trim() : null) ||
    null;
  const preferredOfferId = preferredMerchantId
    ? offers.find((offer) => offer.merchant_id === preferredMerchantId)?.offer_id || null
    : null;
  const defaultOfferId = preferredOfferId || bestPriceOfferId;
  const canonicalMember =
    (Array.isArray(groupMembers) ? groupMembers : []).find((member) => member.is_primary) ||
    (Array.isArray(groupMembers) ? groupMembers : [])[0] ||
    null;
  const canonicalProductRef = canonicalMember
    ? {
        merchant_id: canonicalMember.merchant_id,
        product_id: canonicalMember.product_id,
        ...(canonicalMember.platform ? { platform: canonicalMember.platform } : {}),
      }
    : null;

  return {
    status: 'success',
    product_group_id: productGroupId,
    canonical_product_ref: canonicalProductRef,
    offers_count: offers.length,
    offers,
    default_offer_id: defaultOfferId,
    best_price_offer_id: bestPriceOfferId,
  };
}

async function handleResolveProductCandidatesOperation({
  operation,
  payload,
  checkoutToken,
  pivotaApiBase,
  resolveCatalogSyncMerchantIds,
  buildQueryString,
  buildInvokeUpstreamAuthHeaders,
  getUpstreamTimeoutMs,
  callUpstreamWithOptionalRetry,
  normalizeAgentProductsListResponse,
  resolveProductGroupCached = resolveProductGroupCachedBase,
  fetchProductDetailForOffers = fetchProductDetailForOffersBase,
  buildOffersFromGroupMembers = buildOffersFromGroupMembersBase,
  buildProductGroupId = buildProductGroupIdBase,
  buildOfferId = buildOfferIdBase,
  getResolveProductCandidatesCacheEntry,
  setResolveProductCandidatesCache,
  resolveProductCandidatesCacheEnabled,
  resolveProductCandidatesCacheMetrics,
  resolveProductCandidatesTtlMs,
  extractUpstreamErrorCode = extractUpstreamErrorCodeBase,
  logger,
  nodeEnv,
} = {}) {
  if (String(operation || '').trim() !== 'resolve_product_candidates') {
    return { handled: false };
  }

  try {
    const productRef = payload?.product_ref || payload?.productRef || payload?.product || {};
    const context = payload?.context || {};
    const options = payload?.options || {};

    const productId = String(
      productRef.product_id || productRef.productId || payload?.product_id || payload?.productId || '',
    ).trim();
    const requestedMerchantId = String(
      productRef.merchant_id || productRef.merchantId || payload?.merchant_id || payload?.merchantId || '',
    ).trim();
    const country = String(context.country || context.country_code || '').trim().toUpperCase() || null;
    const postalCode = String(context.postal_code || context.postalCode || '').trim() || null;
    const limit = Math.min(Math.max(1, Number(options.limit || payload?.limit || 10) || 10), 50);
    const includeOffers = options.include_offers !== false;
    const debug =
      options.debug === true || String(options.debug || '').trim().toLowerCase() === 'true';
    const bypassCache = shouldBypassResolveProductCandidatesCache(options);

    if (!productId) {
      return {
        handled: true,
        statusCode: 400,
        body: {
          error: 'MISSING_PARAMETERS',
          message: 'product_ref.product_id is required',
        },
      };
    }

    const cacheKey = buildResolveProductCandidatesCacheKey({
      productId,
      requestedMerchantId,
      country,
      postalCode,
      limit,
      includeOffers,
      checkoutToken,
    });
    const cacheEnabled = resolveProductCandidatesCacheEnabled && !bypassCache;
    if (!cacheEnabled && resolveProductCandidatesCacheMetrics) {
      resolveProductCandidatesCacheMetrics.bypasses += 1;
    }
    const cachedEntry = cacheEnabled ? getResolveProductCandidatesCacheEntry(cacheKey) : null;
    if (cachedEntry?.value) {
      const ageMs =
        typeof cachedEntry.storedAtMs === 'number'
          ? Math.max(0, Date.now() - cachedEntry.storedAtMs)
          : 0;
      const response = debug
        ? {
            ...cachedEntry.value,
            cache: { hit: true, age_ms: ageMs, ttl_ms: resolveProductCandidatesTtlMs },
          }
        : cachedEntry.value;
      maybeLogResolveProductCandidatesDebug({
        debug,
        nodeEnv,
        logger,
        operation,
        productId,
        cacheHit: true,
        cacheAgeMs: ageMs,
        offersCount: response?.offers_count,
      });
      return {
        handled: true,
        statusCode: 200,
        body: response,
      };
    }

    let productGroupId = null;
    let groupMembers = [];
    if (!requestedMerchantId) {
      try {
        const resolvedByProductId = await resolveProductGroupCached({
          productId,
          merchantId: null,
          platform: null,
          checkoutToken,
          bypassCache,
          debug: false,
        });
        const resolvedProductGroupId =
          resolvedByProductId?.product_group_id || resolvedByProductId?.productGroupId || null;
        if (typeof resolvedProductGroupId === 'string' && resolvedProductGroupId.trim()) {
          productGroupId = resolvedProductGroupId.trim();
        }
        groupMembers = normalizeGroupMembers(resolvedByProductId?.members).slice(0, limit);
      } catch {
        productGroupId = null;
        groupMembers = [];
      }
    }

    let deduped = [];
    let anchor = null;
    const shouldSkipSearch = !requestedMerchantId && groupMembers.length > 0;
    if (!shouldSkipSearch) {
      const searchUrl = `${pivotaApiBase}/agent/v1/products/search`;
      const configuredMerchantTarget = await resolveCatalogSyncMerchantIds();
      const configuredMerchantIds = configuredMerchantTarget.merchantIds;
      const queryParams = {
        ...(requestedMerchantId ? { merchant_id: requestedMerchantId } : {}),
        ...(!requestedMerchantId && configuredMerchantIds.length > 0
          ? { merchant_ids: configuredMerchantIds }
          : {}),
        ...(!requestedMerchantId && configuredMerchantIds.length === 0
          ? { search_all_merchants: true }
          : {}),
        query: productId,
        in_stock_only: false,
        limit,
        offset: 0,
      };
      const axiosConfig = {
        method: 'GET',
        url: `${searchUrl}${buildQueryString(queryParams)}`,
        headers: {
          ...buildInvokeUpstreamAuthHeaders({ checkoutToken }),
        },
        timeout: getUpstreamTimeoutMs('find_products_multi'),
      };
      const resp = await callUpstreamWithOptionalRetry('find_products_multi', axiosConfig);
      const normalizedList = normalizeAgentProductsListResponse(resp.data, {
        limit: queryParams.limit,
        offset: queryParams.offset,
      });
      const products = Array.isArray(normalizedList?.products) ? normalizedList.products : [];
      const matches = products.filter(
        (product) => String(product?.product_id || '').trim() === productId,
      );
      deduped = Array.from(
        new Map(
          matches
            .map((product) => [String(product?.merchant_id || '').trim(), product])
            .filter(([merchantId]) => Boolean(merchantId)),
        ).values(),
      ).slice(0, limit);
      anchor =
        (requestedMerchantId
          ? deduped.find(
              (product) => String(product?.merchant_id || '').trim() === requestedMerchantId,
            ) || (deduped.length === 0 ? { merchant_id: requestedMerchantId } : null)
          : null) ||
        deduped[0] ||
        null;
    }

    if (
      requestedMerchantId &&
      (!anchor ||
        String(anchor?.merchant_id || '').trim() !== requestedMerchantId ||
        !anchor?.platform)
    ) {
      try {
        const anchorDetail = await fetchProductDetailForOffers({
          merchantId: requestedMerchantId,
          productId,
          checkoutToken,
        });
        if (anchorDetail) {
          anchor = {
            ...anchorDetail,
            merchant_id: requestedMerchantId,
            product_id: productId,
          };
          const hasRequestedMerchant = deduped.some(
            (product) => String(product?.merchant_id || '').trim() === requestedMerchantId,
          );
          if (!hasRequestedMerchant) {
            deduped = [anchor, ...deduped].slice(0, limit);
          }
        }
      } catch {
        // Best-effort: do not block candidate resolution on anchor enrichment failures.
      }
    }

    if (!productGroupId && groupMembers.length === 0) {
      try {
        const anchorMerchantId = String(anchor?.merchant_id || '').trim();
        if (anchorMerchantId) {
          const platform = anchor?.platform ? String(anchor.platform).trim() : null;
          const resolvedGroup = await resolveProductGroupCached({
            productId,
            merchantId: anchorMerchantId,
            platform,
            checkoutToken,
            bypassCache,
            debug: false,
          });
          const resolvedProductGroupId =
            resolvedGroup?.product_group_id || resolvedGroup?.productGroupId || null;
          if (typeof resolvedProductGroupId === 'string' && resolvedProductGroupId.trim()) {
            productGroupId = resolvedProductGroupId.trim();
          }
          groupMembers = normalizeGroupMembers(resolvedGroup?.members).slice(0, limit);
        }
      } catch {
        groupMembers = [];
        productGroupId = null;
      }
    }

    if (!productGroupId) {
      const platform = anchor ? String(anchor.platform || '').trim() : '';
      const platformProductId = anchor ? String(anchor.platform_product_id || '').trim() : '';
      productGroupId =
        (platform && platformProductId
          ? buildProductGroupId({ platform, platform_product_id: platformProductId })
          : buildProductGroupId({ merchant_id: 'pid', product_id: productId })) ||
        `pg:pid:${productId}`;
    }

    const anchorByProductIdMerchantId =
      !requestedMerchantId && groupMembers.length > 0
        ? String(
            groupMembers.find((member) => String(member.product_id || '').trim() === productId)
              ?.merchant_id || '',
          ).trim() || null
        : null;
    const preferredMerchantId =
      (requestedMerchantId ? String(requestedMerchantId).trim() : null) ||
      anchorByProductIdMerchantId ||
      (anchor ? String(anchor.merchant_id || '').trim() : null) ||
      null;

    let result = null;
    if (groupMembers.length > 0) {
      result = await buildOffersFromGroupMembers({
        productGroupId,
        members: groupMembers,
        checkoutToken,
        limit,
        preferredMerchantId,
      });
    }

    if (!result) {
      result = buildOffersFromProducts({
        offerProducts: deduped,
        groupMembers,
        productGroupId,
        requestedMerchantId,
        productId,
        anchor,
        buildOfferId,
      });
    }

    const cacheValue = includeOffers ? result : dropOffersFromResult(result);
    if (cacheEnabled) {
      setResolveProductCandidatesCache(cacheKey, cacheValue);
    }
    const response = debug
      ? {
          ...cacheValue,
          cache: { hit: false, age_ms: 0, ttl_ms: resolveProductCandidatesTtlMs },
        }
      : cacheValue;
    maybeLogResolveProductCandidatesDebug({
      debug,
      nodeEnv,
      logger,
      operation,
      productId,
      cacheHit: false,
      offersCount: result?.offers_count,
    });
    return {
      handled: true,
      statusCode: 200,
      body: response,
    };
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 502;
    logger.error({ err: err?.message || String(err) }, 'resolve_product_candidates failed');
    return {
      handled: true,
      statusCode,
      body: {
        error: code || 'RESOLVE_PRODUCT_CANDIDATES_FAILED',
        message: message || 'Failed to resolve product candidates',
        details: data || null,
      },
    };
  }
}

module.exports = {
  handleResolveProductCandidatesOperation,
};

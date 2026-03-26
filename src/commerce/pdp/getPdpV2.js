const { normalizeOfferMoney } = require('./offerMoney');
const { getPdpOptions: getPdpOptionsBase } = require('./options');
const {
  buildOfferId: buildOfferIdBase,
  buildProductGroupId: buildProductGroupIdBase,
  extractMerchantIdFromOfferId: extractMerchantIdFromOfferIdBase,
  parseOfferId: parseOfferIdBase,
} = require('../../offers/offerIds');
const { buildPdpPayload: buildPdpPayloadBase } = require('./runtime');
const {
  extractUpstreamErrorCode: extractUpstreamErrorCodeBase,
} = require('../shared/extractUpstreamErrorCode');
const {
  fetchVariantDetailFromUpstream: fetchVariantDetailFromUpstreamBase,
  fetchProductGroupMembersFromUpstream: fetchProductGroupMembersFromUpstreamBase,
  fetchReviewSummaryCached: fetchReviewSummaryCachedBase,
  fetchSimilarProductsDeduped: fetchSimilarProductsDedupedBase,
} = require('./upstreamAdapters');
const {
  fetchProductDetailForOffers: fetchProductDetailForOffersBase,
  getProductDetailSource: getProductDetailSourceBase,
} = require('../catalog/productDetailAdapters');
const {
  resolveProductGroupCached: resolveProductGroupCachedBase,
  buildOffersFromGroupMembers: buildOffersFromGroupMembersBase,
} = require('./groupHelpers');

function parseIncludeList(includeRaw) {
  if (Array.isArray(includeRaw)) {
    return includeRaw.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  }
  if (typeof includeRaw === 'string') {
    return includeRaw
      .split(',')
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

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

function toCanonicalProductRef(member) {
  if (!member) return null;
  return {
    merchant_id: member.merchant_id,
    product_id: member.product_id,
    ...(member.platform ? { platform: member.platform } : {}),
  };
}

function resolvePdpBypassCache(options, payload) {
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

function buildFallbackOffersData({
  productGroupId,
  canonicalProduct,
  canonicalProductRef,
  productId,
  buildProductGroupId,
  buildOfferId,
}) {
  const fallbackProductGroupId =
    productGroupId ||
    (canonicalProduct.platform && canonicalProduct.platform_product_id
      ? buildProductGroupId({
          platform: String(canonicalProduct.platform || '').trim(),
          platform_product_id: String(canonicalProduct.platform_product_id || '').trim(),
        })
      : null) ||
    `pg:pid:${String(canonicalProductRef.product_id || productId).trim()}`;
  const merchantId = String(canonicalProductRef.merchant_id || '').trim();
  const fallbackOfferId =
    buildOfferId({
      merchant_id: merchantId,
      product_group_id: fallbackProductGroupId,
      fulfillment_type: canonicalProduct.fulfillment_type || 'merchant',
      tier: 'default',
    }) ||
    `of:v1:${merchantId}:${fallbackProductGroupId}:${canonicalProduct.fulfillment_type || 'merchant'}:default`;

  return {
    status: 'success',
    product_group_id: fallbackProductGroupId,
    canonical_product_ref: canonicalProductRef,
    offers_count: 1,
    offers: [
      {
        offer_id: fallbackOfferId,
        product_group_id: fallbackProductGroupId,
        product_id: canonicalProductRef.product_id,
        merchant_id: canonicalProductRef.merchant_id,
        merchant_name:
          canonicalProduct.merchant_name || canonicalProduct.store_name || undefined,
        price: normalizeOfferMoney(canonicalProduct.price, canonicalProduct.currency || 'USD'),
        shipping: canonicalProduct.shipping || undefined,
        returns: canonicalProduct.returns || undefined,
        inventory: {
          in_stock:
            typeof canonicalProduct.in_stock === 'boolean'
              ? canonicalProduct.in_stock
              : undefined,
        },
        fulfillment_type: canonicalProduct.fulfillment_type || undefined,
        risk_tier: 'standard',
      },
    ],
    default_offer_id: null,
    best_price_offer_id: null,
  };
}

async function handleGetPdpV2Operation({
  operation,
  payload,
  metadata,
  checkoutToken,
  gatewayRequestId,
  defaultMerchantId,
  serviceGitSha,
  parseOfferId = parseOfferIdBase,
  extractMerchantIdFromOfferId = extractMerchantIdFromOfferIdBase,
  fetchVariantDetailFromUpstream = fetchVariantDetailFromUpstreamBase,
  normalizeAgentProductDetailResponse,
  fetchProductGroupMembersFromUpstream = fetchProductGroupMembersFromUpstreamBase,
  fetchProductDetailForOffers = fetchProductDetailForOffersBase,
  resolveProductGroupCached = resolveProductGroupCachedBase,
  getPdpOptions = getPdpOptionsBase,
  fetchReviewSummaryCached = fetchReviewSummaryCachedBase,
  fetchSimilarProductsDeduped = fetchSimilarProductsDedupedBase,
  buildPdpPayload = buildPdpPayloadBase,
  buildProductGroupId = buildProductGroupIdBase,
  buildOffersFromGroupMembers = buildOffersFromGroupMembersBase,
  buildOfferId = buildOfferIdBase,
  getProductDetailSource = getProductDetailSourceBase,
  extractUpstreamErrorCode = extractUpstreamErrorCodeBase,
  logger,
} = {}) {
  if (String(operation || '').trim() !== 'get_pdp_v2') {
    return { handled: false };
  }

  const pdpV2StartedAt = Date.now();
  const pdpV2PhaseTimings = {};
  const pdpV2ModuleTimings = {};
  const markPdpV2Phase = (name, startedAt) => {
    pdpV2PhaseTimings[name] = Date.now() - startedAt;
  };
  const markPdpV2Module = (name, startedAt) => {
    pdpV2ModuleTimings[name] = Date.now() - startedAt;
  };

  try {
    const parseRequestStartedAt = Date.now();
    const productRef = payload.product_ref || payload.productRef || payload.product || {};
    let productId = String(
      productRef.product_id || productRef.productId || payload.product_id || payload.productId || '',
    ).trim();
    let requestedMerchantId = String(
      productRef.merchant_id || productRef.merchantId || payload.merchant_id || payload.merchantId || '',
    ).trim();
    const offerId = String(
      productRef.offer_id || productRef.offerId || payload.offer_id || payload.offerId || '',
    ).trim();
    const variantId = String(
      productRef.variant_id ||
        productRef.variantId ||
        productRef.sku_id ||
        productRef.skuId ||
        payload.variant_id ||
        payload.variantId ||
        payload.sku_id ||
        payload.skuId ||
        '',
    ).trim();
    const parsedOffer = offerId ? parseOfferId(offerId) : null;
    if (!requestedMerchantId && parsedOffer?.merchant_id) {
      requestedMerchantId = String(parsedOffer.merchant_id || '').trim();
    }
    if (!requestedMerchantId && offerId) {
      const inferred = extractMerchantIdFromOfferId(offerId);
      if (inferred) requestedMerchantId = inferred;
    }
    const platform = String(productRef.platform || payload.platform || '').trim() || null;
    const options = payload.options || payload.product?.options || {};
    const debug =
      options.debug === true ||
      String(options.debug || '').trim().toLowerCase() === 'true' ||
      payload.debug === true;
    const bypassCache = resolvePdpBypassCache(options, payload);

    const includeList = parseIncludeList(payload.include);
    const includeAll = includeList.includes('all');
    const wantsOffers = includeAll || includeList.includes('offers');
    const wantsReviewsPreview = includeAll || includeList.includes('reviews_preview');
    const wantsSimilar =
      includeAll ||
      includeList.includes('similar') ||
      includeList.includes('recommendations');
    markPdpV2Phase('parse_request', parseRequestStartedAt);

    let productGroupId = null;
    let groupMembers = [];
    let canonicalProductRef = null;

    const subject = payload.subject && typeof payload.subject === 'object' ? payload.subject : null;
    const subjectType = subject ? String(subject.type || '').trim().toLowerCase() : '';
    const subjectId = subject ? String(subject.id || '').trim() : '';
    const offerProductGroupId = String(parsedOffer?.product_group_id || '').trim() || null;
    const hasExplicitProductGroup = subjectType === 'product_group' && subjectId;

    if (!productId && !variantId && !offerProductGroupId && !hasExplicitProductGroup) {
      return {
        handled: true,
        statusCode: 400,
        body: {
          error: 'MISSING_PARAMETERS',
          message:
            'product_ref.product_id (or product_ref.variant_id + merchant_id, or product_ref.offer_id, or subject=product_group) is required for get_pdp_v2',
        },
      };
    }

    const entryProductId = productId;
    const shouldResolveVariantToProduct =
      Boolean(variantId) &&
      Boolean(requestedMerchantId) &&
      (!productId || productId === variantId);
    const resolveVariantStartedAt = Date.now();
    if (shouldResolveVariantToProduct) {
      try {
        const rawVariant = await fetchVariantDetailFromUpstream({
          merchantId: requestedMerchantId,
          variantId,
          checkoutToken,
        }).catch(() => null);
        const normalizedVariant = normalizeAgentProductDetailResponse(rawVariant);
        const variantProduct =
          normalizedVariant && typeof normalizedVariant === 'object'
            ? normalizedVariant.product
            : null;
        const resolvedProductId = variantProduct
          ? String(
              variantProduct.id ||
                variantProduct.product_id ||
                variantProduct.productId ||
                '',
            ).trim()
          : '';
        if (resolvedProductId) productId = resolvedProductId;
      } catch {
        // Ignore and fall back to product_id/offer_id flow.
      }
    }
    markPdpV2Phase('resolve_variant_to_product', resolveVariantStartedAt);

    if (!productId && !offerProductGroupId && !hasExplicitProductGroup) {
      if (variantId && requestedMerchantId && !entryProductId) {
        return {
          handled: true,
          statusCode: 404,
          body: {
            error: 'PRODUCT_NOT_FOUND',
            message: 'Variant not found',
          },
        };
      }
      return {
        handled: true,
        statusCode: 400,
        body: {
          error: 'MISSING_PARAMETERS',
          message:
            'product_ref.product_id is required unless you provide product_ref.offer_id or subject=product_group',
        },
      };
    }

    const resolveSubjectGroupStartedAt = Date.now();
    if (subjectType === 'product_group' && subjectId) {
      try {
        const fetchedGroup = await fetchProductGroupMembersFromUpstream({
          productGroupId: subjectId,
          checkoutToken,
        }).catch(() => null);
        const members = normalizeGroupMembers(
          Array.isArray(fetchedGroup?.members)
            ? fetchedGroup.members
            : Array.isArray(fetchedGroup?.items)
              ? fetchedGroup.items
              : [],
        );
        if (members.length) {
          productGroupId = subjectId;
          groupMembers = members;
          canonicalProductRef = toCanonicalProductRef(
            members.find((member) => member.is_primary) || members[0] || null,
          );
        }
      } catch {
        // Ignore and fall back to resolve-by-product-id.
      }
    }
    markPdpV2Phase('resolve_subject_group', resolveSubjectGroupStartedAt);

    const resolveOfferGroupStartedAt = Date.now();
    if (!canonicalProductRef && offerProductGroupId) {
      try {
        const fetchedGroup = await fetchProductGroupMembersFromUpstream({
          productGroupId: offerProductGroupId,
          checkoutToken,
        }).catch(() => null);
        const members = normalizeGroupMembers(
          Array.isArray(fetchedGroup?.members)
            ? fetchedGroup.members
            : Array.isArray(fetchedGroup?.items)
              ? fetchedGroup.items
              : [],
        );
        if (members.length) {
          productGroupId = offerProductGroupId;
          groupMembers = members;
          canonicalProductRef = toCanonicalProductRef(
            members.find((member) => member.is_primary) || members[0] || null,
          );
        }
      } catch {
        // Ignore and fall back to resolve-by-product-id.
      }
    }
    markPdpV2Phase('resolve_offer_group', resolveOfferGroupStartedAt);

    if (!productId && canonicalProductRef?.product_id) {
      productId = String(canonicalProductRef.product_id || '').trim();
    }

    let precheckedMerchantProduct = null;
    let precheckEntryProductMissing = false;
    const shouldPrecheckMerchantScoped =
      Boolean(requestedMerchantId) &&
      Boolean(productId) &&
      !offerProductGroupId &&
      !hasExplicitProductGroup;
    const precheckEntryProductStartedAt = Date.now();
    if (shouldPrecheckMerchantScoped) {
      precheckedMerchantProduct = await fetchProductDetailForOffers({
        merchantId: requestedMerchantId,
        productId,
        checkoutToken,
      });
      precheckEntryProductMissing = !precheckedMerchantProduct;
      if (precheckEntryProductMissing) {
        logger.info(
          {
            requested_merchant_id: requestedMerchantId,
            product_id: productId,
            has_product_group_hint: hasExplicitProductGroup || Boolean(offerProductGroupId),
          },
          'get_pdp_v2 entry precheck miss; continuing with canonical/group resolution',
        );
      }
    }
    markPdpV2Phase('precheck_entry_product', precheckEntryProductStartedAt);

    const resolveGroupCachedStartedAt = Date.now();
    if (!canonicalProductRef) {
      const resolvedGroup = await resolveProductGroupCached({
        productId,
        merchantId: requestedMerchantId || null,
        platform,
        checkoutToken,
        bypassCache,
        debug: false,
      }).catch(() => null);
      const pgid = resolvedGroup?.product_group_id || null;
      productGroupId =
        typeof pgid === 'string' && pgid.trim() ? pgid.trim() : productGroupId;
      groupMembers = Array.isArray(resolvedGroup?.members) ? resolvedGroup.members : groupMembers;
      if (resolvedGroup?.canonical_product_ref) {
        canonicalProductRef = resolvedGroup.canonical_product_ref;
      }
    }
    markPdpV2Phase('resolve_group_cached', resolveGroupCachedStartedAt);

    if (!canonicalProductRef) {
      canonicalProductRef = {
        merchant_id: requestedMerchantId || defaultMerchantId,
        product_id: productId,
        ...(platform ? { platform } : {}),
      };
    }

    const fetchCanonicalProductStartedAt = Date.now();
    const canonicalProduct =
      precheckedMerchantProduct &&
      canonicalProductRef.merchant_id === requestedMerchantId &&
      canonicalProductRef.product_id === productId
        ? precheckedMerchantProduct
        : await fetchProductDetailForOffers({
            merchantId: canonicalProductRef.merchant_id,
            productId: canonicalProductRef.product_id,
            checkoutToken,
          });
    markPdpV2Phase('fetch_canonical_product', fetchCanonicalProductStartedAt);

    if (!canonicalProduct) {
      return {
        handled: true,
        statusCode: 404,
        body: {
          error: 'PRODUCT_NOT_FOUND',
          message: 'Product not found',
        },
      };
    }

    const entryProductRef = {
      product_id: entryProductId || productId || canonicalProductRef.product_id,
      ...(requestedMerchantId ? { merchant_id: requestedMerchantId } : {}),
      ...(variantId ? { variant_id: variantId } : {}),
      ...(offerId ? { offer_id: offerId } : {}),
      ...(platform ? { platform } : {}),
    };

    const pdpOptions = getPdpOptions(payload);
    let canonicalProductForPdp = canonicalProduct;
    const reviewSummaryPromise = wantsReviewsPreview
      ? (async () => {
          const moduleStartedAt = Date.now();
          try {
            const reviewPlatform = String(
              canonicalProduct.platform || canonicalProductRef.platform || '',
            ).trim();
            const reviewPlatformProductId = String(
              canonicalProduct.platform_product_id ||
                canonicalProduct.platformProductId ||
                canonicalProduct.shopify_id ||
                canonicalProduct.product_id ||
                canonicalProduct.id ||
                canonicalProductRef.product_id ||
                '',
            ).trim();
            if (!reviewPlatform || !reviewPlatformProductId) return null;
            return fetchReviewSummaryCached({
              merchantId: canonicalProductRef.merchant_id,
              platform: reviewPlatform,
              platformProductId: reviewPlatformProductId,
              checkoutToken,
              bypassCache,
            }).catch(() => null);
          } finally {
            markPdpV2Module('reviews_preview', moduleStartedAt);
          }
        })()
      : Promise.resolve(null);

    const relatedProductsPromise = wantsSimilar
      ? (async () => {
          const moduleStartedAt = Date.now();
          try {
            const limit = payload?.similar?.limit || payload?.recommendations?.limit || 6;
            return fetchSimilarProductsDeduped({
              pdp_product: canonicalProduct,
              k: limit,
              locale:
                payload?.context?.locale ||
                payload?.context?.language ||
                payload?.locale ||
                'en-US',
              currency: canonicalProduct.currency || 'USD',
              options: {
                debug,
                no_cache: bypassCache,
                cache_bypass: bypassCache,
                bypass_cache: bypassCache,
              },
            });
          } finally {
            markPdpV2Module('similar', moduleStartedAt);
          }
        })()
      : Promise.resolve([]);

    const fetchOptionalModulesStartedAt = Date.now();
    const [reviewSummaryResult, relatedProductsResult] = await Promise.allSettled([
      reviewSummaryPromise,
      relatedProductsPromise,
    ]);
    markPdpV2Phase('fetch_optional_modules_parallel', fetchOptionalModulesStartedAt);

    if (
      reviewSummaryResult.status === 'fulfilled' &&
      reviewSummaryResult.value &&
      typeof reviewSummaryResult.value === 'object'
    ) {
      canonicalProductForPdp = {
        ...canonicalProductForPdp,
        review_summary: reviewSummaryResult.value,
      };
    }

    let relatedProducts = [];
    if (relatedProductsResult.status === 'fulfilled') {
      relatedProducts = Array.isArray(relatedProductsResult.value)
        ? relatedProductsResult.value
        : [];
    } else if (wantsSimilar) {
      logger.warn(
        {
          err:
            relatedProductsResult?.reason?.message ||
            String(relatedProductsResult?.reason || 'unknown'),
          product_id: canonicalProductRef.product_id,
        },
        'PDP recommendations failed; returning without similar module',
      );
    }

    const pdpPayload = buildPdpPayload({
      product: canonicalProductForPdp,
      relatedProducts,
      entryPoint: pdpOptions.entryPoint,
      experiment: pdpOptions.experiment,
      templateHint: pdpOptions.templateHint,
      includeEmptyReviews: wantsReviewsPreview || pdpOptions.includeEmptyReviews,
      debug: pdpOptions.debug,
    });

    const reviewsModule = Array.isArray(pdpPayload.modules)
      ? pdpPayload.modules.find((module) => module?.type === 'reviews_preview')
      : null;
    const recModule = Array.isArray(pdpPayload.modules)
      ? pdpPayload.modules.find((module) => module?.type === 'recommendations')
      : null;

    const canonicalPayload = {
      ...pdpPayload,
      modules: Array.isArray(pdpPayload.modules)
        ? pdpPayload.modules.filter(
            (module) =>
              module?.type !== 'reviews_preview' && module?.type !== 'recommendations',
          )
        : [],
    };

    const modules = [
      {
        type: 'canonical',
        required: true,
        data: {
          product_group_id: productGroupId,
          canonical_product_ref: canonicalProductRef,
          entry_product_ref: entryProductRef,
          pdp_payload: canonicalPayload,
          ...(precheckEntryProductMissing ? { entry_precheck_missing: true } : {}),
        },
      },
    ];

    const missing = [];

    if (wantsOffers) {
      const offersModuleStartedAt = Date.now();
      let offersData = null;
      try {
        offersData =
          groupMembers.length > 0
            ? await buildOffersFromGroupMembers({
                productGroupId,
                members: groupMembers,
                checkoutToken,
                limit: payload?.offers?.limit || 10,
                preferredMerchantId: requestedMerchantId || null,
              })
            : buildFallbackOffersData({
                productGroupId,
                canonicalProduct,
                canonicalProductRef,
                productId,
                buildProductGroupId,
                buildOfferId,
                normalizeOfferMoney,
              });
      } catch {
        offersData = null;
      }

      if (offersData) {
        const offers = Array.isArray(offersData.offers) ? offersData.offers : [];
        const fallbackOfferId = offers[0]?.offer_id || null;
        if (fallbackOfferId) {
          if (!offersData.default_offer_id) offersData.default_offer_id = fallbackOfferId;
          if (!offersData.best_price_offer_id) offersData.best_price_offer_id = fallbackOfferId;
        }
        modules.push({
          type: 'offers',
          required: false,
          data: offersData,
        });
      } else {
        modules.push({
          type: 'offers',
          required: false,
          data: null,
          reason: 'unavailable',
        });
        missing.push({ type: 'offers', reason: 'unavailable' });
      }
      markPdpV2Module('offers', offersModuleStartedAt);
    }

    if (wantsReviewsPreview) {
      const data = reviewsModule?.data || null;
      modules.push({
        type: 'reviews_preview',
        required: false,
        data,
        ...(data ? {} : { reason: 'unavailable' }),
      });
      if (!data) missing.push({ type: 'reviews_preview', reason: 'unavailable' });
    }

    if (wantsSimilar) {
      const data = recModule?.data || null;
      modules.push({
        type: 'similar',
        required: false,
        data,
        ...(data ? {} : { reason: 'unavailable' }),
      });
      if (!data) missing.push({ type: 'similar', reason: 'unavailable' });
    }

    const buildId = serviceGitSha ? serviceGitSha.slice(0, 12) : null;
    const capabilities = {
      client:
        payload?.capabilities?.client ||
        payload?.capabilities?.client_name ||
        metadata?.source ||
        null,
      client_version:
        payload?.capabilities?.client_version ||
        payload?.capabilities?.clientVersion ||
        null,
    };

    const responsePayload = {
      status: 'success',
      pdp_version: '2.0',
      request_id: gatewayRequestId,
      build_id: buildId,
      generated_at: new Date().toISOString(),
      subject: productGroupId
        ? {
            type: 'product_group',
            id: productGroupId,
            canonical_product_ref: canonicalProductRef,
          }
        : {
            type: 'product',
            id: canonicalProductRef.product_id,
            canonical_product_ref: canonicalProductRef,
          },
      capabilities,
      modules,
      warnings: debug ? [] : [],
      missing,
      metadata: {
        detail_source: getProductDetailSource(canonicalProduct) || null,
        module_degrade: {
          applied: missing.length > 0,
          modules: missing.map((item) => ({
            type: item?.type || 'unknown',
            reason: item?.reason || 'unavailable',
          })),
        },
      },
    };

    logger.info(
      {
        gateway_request_id: gatewayRequestId,
        operation: 'get_pdp_v2',
        requested_product_id: entryProductId || null,
        resolved_product_id: canonicalProductRef?.product_id || null,
        requested_merchant_id: requestedMerchantId || null,
        resolved_merchant_id: canonicalProductRef?.merchant_id || null,
        include: includeList,
        modules_returned: modules.map((module) => module.type),
        missing_modules: missing.map((module) => module.type),
        timing_ms: {
          total: Date.now() - pdpV2StartedAt,
          phases: pdpV2PhaseTimings,
          modules: pdpV2ModuleTimings,
        },
      },
      'get_pdp_v2 completed',
    );

    return {
      handled: true,
      statusCode: 200,
      body: responsePayload,
    };
  } catch (err) {
    const { code, message, data } = extractUpstreamErrorCode(err);
    const statusCode = err?.response?.status || err?.status || 502;
    logger.error(
      {
        gateway_request_id: gatewayRequestId,
        operation: 'get_pdp_v2',
        status_code: statusCode,
        err: err?.message || String(err),
        timing_ms: {
          total: Date.now() - pdpV2StartedAt,
          phases: pdpV2PhaseTimings,
          modules: pdpV2ModuleTimings,
        },
      },
      'get_pdp_v2 failed',
    );
    return {
      handled: true,
      statusCode,
      body: {
        error: code || 'GET_PDP_V2_FAILED',
        message: message || 'Failed to build pdp payload',
        details: data || null,
      },
    };
  }
}

module.exports = {
  handleGetPdpV2Operation,
};

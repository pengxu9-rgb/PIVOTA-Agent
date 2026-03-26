const { resolveProductCandidatesTtlMs } = require('../pdp/hotCaches');
const { normalizeOfferMoney } = require('../pdp/offerMoney');
const {
  shouldIncludePdp: shouldIncludePdpBase,
  getPdpOptions: getPdpOptionsBase,
} = require('../pdp/options');
const {
  buildPdpPayload: buildPdpPayloadBase,
  recommendPdpProducts: recommendPdpProductsBase,
} = require('../pdp/runtime');
const { getProductById: getProductByIdBase } = require('../../mockProducts');
const {
  buildOfferId: buildOfferIdBase,
  buildProductGroupId: buildProductGroupIdBase,
} = require('../../offers/offerIds');

function shouldBypassCache(payload) {
  return (
    payload?.options?.no_cache === true ||
    payload?.options?.cache_bypass === true ||
    payload?.options?.bypass_cache === true
  );
}

async function loadMockRelatedProducts({
  product,
  payload,
  includeRecommendations,
  pdpOptions,
  recommendPdpProducts,
}) {
  if (!includeRecommendations) {
    return [];
  }

  const bypassCache = shouldBypassCache(payload);
  try {
    const rec = await recommendPdpProducts({
      pdp_product: product,
      k: payload?.recommendations?.limit || 6,
      locale:
        payload?.context?.locale ||
        payload?.context?.language ||
        payload?.locale ||
        'en-US',
      currency: product.currency || 'USD',
      options: {
        debug: pdpOptions.debug,
        no_cache: bypassCache,
        cache_bypass: bypassCache,
        bypass_cache: bypassCache,
      },
    });
    return Array.isArray(rec?.items) ? rec.items : [];
  } catch {
    return [];
  }
}

function toMoney(amount, currency) {
  return { amount: Number(amount) || 0, currency: currency || 'USD' };
}

function buildMockProductGroupId({
  product,
  merchantId,
  productId,
  defaultMerchantId,
  buildProductGroupId,
}) {
  const platform = String(product?.platform || '').trim();
  const platformProductId = String(product?.platform_product_id || '').trim();
  return (
    (platform && platformProductId
      ? buildProductGroupId({ platform, platform_product_id: platformProductId })
      : productId === 'BOTTLE_001'
        ? buildProductGroupId({ platform: 'mock', platform_product_id: productId })
        : buildProductGroupId({
            merchant_id: merchantId || defaultMerchantId,
            product_id: productId,
          })) ||
    (platform && platformProductId
      ? `pg:${platform}:${platformProductId}`
      : productId === 'BOTTLE_001'
        ? `pg:mock:${productId}`
        : `pg:${merchantId || defaultMerchantId}:${productId}`)
  );
}

function buildMockOffersBundle({
  product,
  merchantId,
  productGroupId,
  buildOfferId,
}) {
  const productId = String(product?.product_id || product?.id || '').trim();
  if (productId === 'BOTTLE_001') {
    const currency = product.currency || 'USD';
    const offers = [
      {
        tier: 'cheap_slow',
        merchant_id: 'merch_demo_cheap_slow',
        merchant_name: 'Budget Seller',
        fulfillment_type: 'merchant',
        inventory: { in_stock: true },
        price: toMoney(19.99, currency),
        shipping: {
          method_label: 'Standard',
          eta_days_range: [7, 10],
          cost: toMoney(1.99, currency),
        },
        returns: { return_window_days: 30, free_returns: true },
      },
      {
        tier: 'fast_premium',
        merchant_id: 'merch_demo_fast_premium',
        merchant_name: 'FastShip Plus',
        fulfillment_type: 'merchant',
        inventory: { in_stock: true },
        price: toMoney(25.99, currency),
        shipping: {
          method_label: 'Express',
          eta_days_range: [1, 2],
          cost: toMoney(8.99, currency),
        },
        returns: { return_window_days: 30, free_returns: true },
      },
      {
        tier: 'bad_returns',
        merchant_id: 'merch_demo_bad_returns',
        merchant_name: 'Strict Returns Co.',
        fulfillment_type: 'merchant',
        inventory: { in_stock: true },
        price: toMoney(23.49, currency),
        shipping: {
          method_label: 'Standard',
          eta_days_range: [3, 5],
          cost: toMoney(4.49, currency),
        },
        returns: { return_window_days: 7, free_returns: false },
      },
    ].map((offer) => ({
      offer_id:
        buildOfferId({
          merchant_id: offer.merchant_id,
          product_group_id: productGroupId,
          fulfillment_type: offer.fulfillment_type,
          tier: offer.tier,
        }) ||
        `of:v1:${offer.merchant_id}:${productGroupId}:${offer.fulfillment_type || 'merchant'}:${offer.tier || 'default'}`,
      product_group_id: productGroupId,
      ...offer,
    }));

    const bestPriceOfferId =
      offers.find((offer) => offer.tier === 'cheap_slow')?.offer_id || offers[0]?.offer_id;
    const defaultOfferId =
      offers.find((offer) => offer.tier === 'fast_premium')?.offer_id || bestPriceOfferId;

    return { offers, defaultOfferId, bestPriceOfferId };
  }

  const currency = product.currency || 'USD';
  const single = {
    offer_id:
      buildOfferId({
        merchant_id: merchantId,
        product_group_id: productGroupId,
        fulfillment_type: 'merchant',
        tier: 'single',
      }) || `of:v1:${merchantId}:${productGroupId}:merchant:single`,
    product_group_id: productGroupId,
    tier: 'single',
    merchant_id: merchantId,
    merchant_name: product.merchant_name || product.store_name || null,
    fulfillment_type: 'merchant',
    inventory: { in_stock: Boolean(product.in_stock) },
    price: toMoney(product.price, currency),
    shipping: product.shipping || undefined,
    returns: product.returns || undefined,
  };
  return {
    offers: [single],
    defaultOfferId: single.offer_id,
    bestPriceOfferId: single.offer_id,
  };
}

async function buildMockGetProductDetailResponse({
  payload,
  defaultMerchantId,
  getProductById,
  buildProductGroupId,
  buildOfferId,
  getPdpOptions,
  shouldIncludePdp,
  recommendPdpProducts,
  buildPdpPayload,
}) {
  const requestedMerchantId =
    payload?.product?.merchant_id || defaultMerchantId;
  const requestedProductId = payload?.product?.product_id;
  const product = getProductById(requestedMerchantId, requestedProductId);

  if (!product) {
    return {
      handled: true,
      statusCode: 404,
      body: {
        error: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      },
    };
  }

  const merchantId = product.merchant_id || requestedMerchantId || defaultMerchantId;
  const productId = product.product_id || requestedProductId;
  const productGroupId = buildMockProductGroupId({
    product,
    merchantId,
    productId,
    defaultMerchantId,
    buildProductGroupId,
  });
  const offerBundle = buildMockOffersBundle({
    product,
    merchantId,
    productGroupId,
    buildOfferId,
  });
  const pdpOptions = getPdpOptions(payload);
  const includePdp = shouldIncludePdp(payload);
  const relatedProducts = await loadMockRelatedProducts({
    product,
    payload,
    includeRecommendations: pdpOptions.includeRecommendations,
    pdpOptions,
    recommendPdpProducts,
  });

  return {
    handled: true,
    statusCode: 200,
    body: {
      status: 'success',
      product,
      product_group_id: productGroupId,
      offers: offerBundle.offers,
      offers_count: offerBundle.offers.length,
      default_offer_id: offerBundle.defaultOfferId,
      best_price_offer_id: offerBundle.bestPriceOfferId,
      ...(includePdp
        ? {
            pdp_payload: buildPdpPayload({
              product,
              relatedProducts,
              entryPoint: pdpOptions.entryPoint,
              experiment: pdpOptions.experiment,
              templateHint: pdpOptions.templateHint,
              includeEmptyReviews: pdpOptions.includeEmptyReviews,
              debug: pdpOptions.debug,
            }),
          }
        : {}),
    },
  };
}

async function buildMockGetPdpResponse({
  payload,
  defaultMerchantId,
  getProductById,
  getPdpOptions,
  recommendPdpProducts,
  buildPdpPayload,
}) {
  const product = getProductById(
    payload?.product?.merchant_id || defaultMerchantId,
    payload?.product?.product_id,
  );

  if (!product) {
    return {
      handled: true,
      statusCode: 404,
      body: {
        error: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      },
    };
  }

  const pdpOptions = getPdpOptions(payload);
  const relatedProducts = await loadMockRelatedProducts({
    product,
    payload,
    includeRecommendations: pdpOptions.includeRecommendations,
    pdpOptions,
    recommendPdpProducts,
  });

  return {
    handled: true,
    statusCode: 200,
    body: {
      status: 'success',
      product,
      pdp_payload: buildPdpPayload({
        product,
        relatedProducts,
        entryPoint: pdpOptions.entryPoint,
        experiment: pdpOptions.experiment,
        templateHint: pdpOptions.templateHint,
        includeEmptyReviews: pdpOptions.includeEmptyReviews,
        debug: pdpOptions.debug,
      }),
    },
  };
}

async function buildMockGetPdpV2Response({
  payload,
  metadata,
  defaultMerchantId,
  serviceGitSha,
  getProductById,
  getPdpOptions,
  recommendPdpProducts,
  buildPdpPayload,
}) {
  const product = getProductById(
    payload?.product?.merchant_id || defaultMerchantId,
    payload?.product?.product_id,
  );

  if (!product) {
    return {
      handled: true,
      statusCode: 404,
      body: {
        error: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      },
    };
  }

  const includeList = Array.isArray(payload?.include)
    ? payload.include.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const includeAll = includeList.includes('all');
  const wantsSimilar =
    includeAll ||
    includeList.includes('similar') ||
    includeList.includes('recommendations');
  const wantsOffers = includeAll || includeList.includes('offers');
  const wantsReviews = includeAll || includeList.includes('reviews_preview');

  const pdpOptions = getPdpOptions(payload);
  const relatedProducts = await loadMockRelatedProducts({
    product,
    payload,
    includeRecommendations: wantsSimilar,
    pdpOptions,
    recommendPdpProducts,
  });

  const pdpPayload = buildPdpPayload({
    product,
    relatedProducts,
    entryPoint: pdpOptions.entryPoint,
    experiment: pdpOptions.experiment,
    templateHint: pdpOptions.templateHint,
    includeEmptyReviews: wantsReviews || pdpOptions.includeEmptyReviews,
    debug: pdpOptions.debug,
  });

  const reviewsModule = Array.isArray(pdpPayload.modules)
    ? pdpPayload.modules.find((module) => module?.type === 'reviews_preview')
    : null;
  const recModule = Array.isArray(pdpPayload.modules)
    ? pdpPayload.modules.find((module) => module?.type === 'recommendations')
    : null;

  const modules = [
    {
      type: 'canonical',
      required: true,
      data: { pdp_payload: pdpPayload },
    },
  ];

  if (wantsOffers) {
    modules.push({
      type: 'offers',
      required: false,
      data: {
        offers_count: 1,
        offers: [
          {
            offer_id: `of:mock:${product.merchant_id || defaultMerchantId}:${product.id || product.product_id}`,
            merchant_id: product.merchant_id || defaultMerchantId,
            merchant_name: product.merchant_name || product.store_name || undefined,
            price: normalizeOfferMoney(product.price, product.currency || 'USD'),
          },
        ],
      },
    });
  }

  if (wantsReviews) {
    modules.push({
      type: 'reviews_preview',
      required: false,
      data: reviewsModule?.data || null,
      ...(reviewsModule?.data ? {} : { reason: 'unavailable' }),
    });
  }

  if (wantsSimilar) {
    modules.push({
      type: 'similar',
      required: false,
      data: recModule?.data || null,
      ...(recModule?.data ? {} : { reason: 'unavailable' }),
    });
  }

  const missing = [];
  if (wantsReviews && !reviewsModule?.data) {
    missing.push({ type: 'reviews_preview', reason: 'unavailable' });
  }
  if (wantsSimilar && !recModule?.data) {
    missing.push({ type: 'similar', reason: 'unavailable' });
  }

  return {
    handled: true,
    statusCode: 200,
    body: {
      status: 'success',
      pdp_version: '2.0',
      request_id: `mock_${Date.now()}`,
      build_id: serviceGitSha ? serviceGitSha.slice(0, 12) : null,
      generated_at: new Date().toISOString(),
      subject: { type: 'product', id: String(product.id || product.product_id || '') },
      capabilities: { client: metadata?.source || 'mock' },
      modules,
      warnings: [],
      missing,
      metadata: {
        detail_source: 'mock',
        module_degrade: {
          applied: missing.length > 0,
          modules: missing.map((item) => ({
            type: item?.type || 'unknown',
            reason: item?.reason || 'unavailable',
          })),
        },
      },
    },
  };
}

function buildMockResolveProductCandidatesResponse({
  payload,
  defaultMerchantId,
  getProductById,
  buildProductGroupId,
  buildOfferId,
}) {
  const productRef = payload?.product_ref || payload?.productRef || payload?.product || {};
  const productId = String(
    productRef.product_id || productRef.productId || payload?.product_id || payload?.productId || '',
  ).trim();
  const requestedMerchantId = String(
    productRef.merchant_id || productRef.merchantId || payload?.merchant_id || payload?.merchantId || '',
  ).trim();
  const options = payload?.options || {};
  const limit = Math.min(Math.max(1, Number(options.limit || payload?.limit || 10) || 10), 50);
  const includeOffers = options.include_offers !== false;
  const debug =
    options.debug === true || String(options.debug || '').trim().toLowerCase() === 'true';

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

  const currency = 'USD';
  const productGroupId =
    (productId === 'BOTTLE_001'
      ? buildProductGroupId({ platform: 'mock', platform_product_id: productId })
      : buildProductGroupId({
          merchant_id: requestedMerchantId || defaultMerchantId,
          product_id: productId,
        })) ||
    (productId === 'BOTTLE_001'
      ? `pg:mock:${productId}`
      : `pg:${requestedMerchantId || defaultMerchantId}:${productId}`);

  const buildBottleOffers = () => {
    const offers = [
      {
        tier: 'cheap_slow',
        risk_tier: 'standard',
        merchant_id: 'merch_demo_cheap_slow',
        merchant_name: 'Budget Seller',
        fulfillment_type: 'merchant',
        inventory: { in_stock: true },
        price: { amount: 19.99, currency },
        shipping: {
          method_label: 'Standard',
          eta_days_range: [7, 10],
          cost: { amount: 1.99, currency },
        },
        returns: { return_window_days: 30, free_returns: true },
      },
      {
        tier: 'fast_premium',
        risk_tier: 'preferred',
        merchant_id: 'merch_demo_fast_premium',
        merchant_name: 'FastShip Plus',
        fulfillment_type: 'merchant',
        inventory: { in_stock: true },
        price: { amount: 25.99, currency },
        shipping: {
          method_label: 'Express',
          eta_days_range: [1, 2],
          cost: { amount: 8.99, currency },
        },
        returns: { return_window_days: 30, free_returns: true },
      },
      {
        tier: 'bad_returns',
        risk_tier: 'high_risk',
        merchant_id: 'merch_demo_bad_returns',
        merchant_name: 'Strict Returns Co.',
        fulfillment_type: 'merchant',
        inventory: { in_stock: true },
        price: { amount: 23.49, currency },
        shipping: {
          method_label: 'Standard',
          eta_days_range: [3, 5],
          cost: { amount: 4.49, currency },
        },
        returns: { return_window_days: 7, free_returns: false },
      },
    ]
      .slice(0, limit)
      .map((offer) => ({
        offer_id:
          buildOfferId({
            merchant_id: offer.merchant_id,
            product_group_id: productGroupId,
            fulfillment_type: offer.fulfillment_type,
            tier: offer.tier,
          }) ||
          `of:v1:${offer.merchant_id}:${productGroupId}:${offer.fulfillment_type || 'merchant'}:${offer.tier || 'default'}`,
        product_group_id: productGroupId,
        ...offer,
      }));

    const bestPriceOfferId =
      offers.find((offer) => offer.tier === 'cheap_slow')?.offer_id || offers[0]?.offer_id || null;
    const defaultOfferId =
      offers.find((offer) => offer.tier === 'fast_premium')?.offer_id || bestPriceOfferId;

    return {
      offers,
      bestPriceOfferId,
      defaultOfferId,
    };
  };

  let offers = [];
  let bestPriceOfferId = null;
  let defaultOfferId = null;

  if (productId === 'BOTTLE_001') {
    const bundle = buildBottleOffers();
    offers = bundle.offers;
    bestPriceOfferId = bundle.bestPriceOfferId;
    defaultOfferId = bundle.defaultOfferId;
  } else {
    const merchantId = requestedMerchantId || defaultMerchantId;
    const product = getProductById(merchantId, productId);
    if (!product) {
      return {
        handled: true,
        statusCode: 404,
        body: {
          error: 'PRODUCT_NOT_FOUND',
          message: 'Product not found',
        },
      };
    }
    const single = {
      offer_id:
        buildOfferId({
          merchant_id: merchantId,
          product_group_id: productGroupId,
          fulfillment_type: 'merchant',
          tier: 'single',
        }) || `of:v1:${merchantId}:${productGroupId}:merchant:single`,
      product_group_id: productGroupId,
      tier: 'single',
      risk_tier: 'standard',
      merchant_id: merchantId,
      merchant_name: product.merchant_name || product.store_name || null,
      fulfillment_type: 'merchant',
      inventory: { in_stock: Boolean(product.in_stock) },
      price: normalizeOfferMoney(product.price, product.currency || currency),
      shipping: product.shipping || undefined,
      returns: product.returns || undefined,
    };
    offers = [single];
    bestPriceOfferId = single.offer_id;
    defaultOfferId = single.offer_id;
  }

  return {
    handled: true,
    statusCode: 200,
    body: {
      status: 'success',
      success: true,
      product_group_id: productGroupId,
      offers_count: offers.length,
      ...(includeOffers ? { offers } : {}),
      default_offer_id: defaultOfferId,
      best_price_offer_id: bestPriceOfferId,
      ...(debug
        ? { cache: { hit: false, age_ms: 0, ttl_ms: resolveProductCandidatesTtlMs } }
        : {}),
    },
  };
}

async function handleMockProductDetailOperation({
  operation,
  payload,
  metadata,
  defaultMerchantId,
  serviceGitSha,
  getProductById = getProductByIdBase,
  buildProductGroupId = buildProductGroupIdBase,
  buildOfferId = buildOfferIdBase,
  getPdpOptions = getPdpOptionsBase,
  shouldIncludePdp = shouldIncludePdpBase,
  recommendPdpProducts = recommendPdpProductsBase,
  buildPdpPayload = buildPdpPayloadBase,
} = {}) {
  switch (String(operation || '').trim()) {
    case 'get_product_detail':
      return buildMockGetProductDetailResponse({
        payload,
        defaultMerchantId,
        getProductById,
        buildProductGroupId,
        buildOfferId,
        getPdpOptions,
        shouldIncludePdp,
        recommendPdpProducts,
        buildPdpPayload,
      });
    case 'get_pdp':
      return buildMockGetPdpResponse({
        payload,
        defaultMerchantId,
        getProductById,
        getPdpOptions,
        recommendPdpProducts,
        buildPdpPayload,
      });
    case 'get_pdp_v2':
      return buildMockGetPdpV2Response({
        payload,
        metadata,
        defaultMerchantId,
        serviceGitSha,
        getProductById,
        getPdpOptions,
        recommendPdpProducts,
        buildPdpPayload,
      });
    case 'resolve_product_candidates':
      return buildMockResolveProductCandidatesResponse({
        payload,
        defaultMerchantId,
        getProductById,
        buildProductGroupId,
        buildOfferId,
      });
    default:
      return { handled: false };
  }
}

module.exports = {
  handleMockProductDetailOperation,
};

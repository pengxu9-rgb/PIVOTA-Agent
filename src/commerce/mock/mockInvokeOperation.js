const { handleMockProductDetailOperation } = require('../catalog/mockProductDetail');
const { buildOrderLineSnapshots: buildOrderLineSnapshotsBase } = require('../shared/orderLineSnapshots');
const { pickSimilarProducts: pickSimilarProductsBase } = require('../shared/pickSimilarProducts');
const { buildPdpPayload: buildPdpPayloadBase, recommendPdpProducts: recommendPdpProductsBase } = require('../pdp/runtime');
const { mockProducts: mockProductsBase, searchProducts: searchProductsBase, getProductById: getProductByIdBase } = require('../../mockProducts');
const {
  buildOfferId: buildOfferIdBase,
  buildProductGroupId: buildProductGroupIdBase,
  extractMerchantIdFromOfferId: extractMerchantIdFromOfferIdBase,
} = require('../../offers/offerIds');

async function handleMockInvokeOperation({
  operation,
  payload,
  effectivePayload,
  metadata,
  defaultMerchantId,
  serviceGitSha,
  getProductById = getProductByIdBase,
  buildProductGroupId = buildProductGroupIdBase,
  buildOfferId = buildOfferIdBase,
  getPdpOptions,
  shouldIncludePdp,
  recommendPdpProducts = recommendPdpProductsBase,
  buildPdpPayload = buildPdpPayloadBase,
  searchProducts = searchProductsBase,
  mockProducts = mockProductsBase,
  extractMerchantIdFromOfferId = extractMerchantIdFromOfferIdBase,
  pickSimilarProducts = pickSimilarProductsBase,
  buildOrderLineSnapshots = buildOrderLineSnapshotsBase,
} = {}) {
  const detailResult = await handleMockProductDetailOperation({
    operation,
    payload,
    metadata,
    defaultMerchantId,
    serviceGitSha,
    getProductById,
    buildProductGroupId,
    buildOfferId,
    getPdpOptions,
    shouldIncludePdp,
    recommendPdpProducts,
    buildPdpPayload,
  });
  if (detailResult?.handled) {
    return detailResult;
  }

  switch (String(operation || '').trim()) {
    case 'find_products': {
      const search = effectivePayload?.search || effectivePayload || {};
      const products = searchProducts(
        search.merchant_id || defaultMerchantId,
        search.query,
        search.price_max,
        search.price_min,
        search.category,
      );

      return {
        handled: true,
        statusCode: 200,
        body: {
          status: 'success',
          success: true,
          products,
          results: products,
          data: { products },
          total: products.length,
          count: products.length,
          page: 1,
          page_size: products.length,
        },
      };
    }

    case 'find_similar_products': {
      const similar = payload?.similar || {};
      const productId =
        similar.product_id || payload?.product?.product_id || payload?.product_id;
      const limit = similar.limit || 8;
      const merchantId =
        similar.merchant_id || payload?.search?.merchant_id || defaultMerchantId;
      const excludeIds = similar.exclude_ids || [productId].filter(Boolean);

      const all = searchProducts(merchantId, similar.query, undefined, undefined, undefined);
      const picked = pickSimilarProducts(all, productId, limit, excludeIds);

      return {
        handled: true,
        statusCode: 200,
        body: {
          status: 'success',
          products: picked,
          total: picked.length,
          page: 1,
          page_size: picked.length,
        },
      };
    }

    case 'find_products_multi': {
      const search = effectivePayload?.search || effectivePayload || {};
      const merchantId = String(search.merchant_id || search.merchantId || '').trim();
      const merchantIdsRaw = search.merchant_ids || search.merchantIds;
      const merchantIds = Array.isArray(merchantIdsRaw)
        ? merchantIdsRaw.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      const searchAllMerchants =
        search.search_all_merchants === true || search.searchAllMerchants === true;
      const resolvedMerchantIds = merchantId
        ? [merchantId]
        : merchantIds.length
          ? merchantIds
          : searchAllMerchants
            ? Object.keys(mockProducts)
            : Object.keys(mockProducts);

      const products = resolvedMerchantIds.flatMap((merchant) =>
        searchProducts(
          merchant,
          search.query,
          search.price_max,
          search.price_min,
          search.category,
        ),
      );

      return {
        handled: true,
        statusCode: 200,
        body: {
          status: 'success',
          success: true,
          products,
          results: products,
          data: { products },
          total: products.length,
          count: products.length,
          page: 1,
          page_size: products.length,
          metadata: {
            query_source: 'mock_multi',
            merchants_searched: resolvedMerchantIds.length,
          },
        },
      };
    }

    case 'create_order': {
      const order = payload?.order || {};
      const offerIdRaw =
        order.offer_id || order.offerId || payload?.offer_id || payload?.offerId || null;
      const offerId = String(offerIdRaw || '').trim() || null;
      const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
      const items = Array.isArray(order.items) ? order.items : [];
      const merchantId =
        merchantFromOffer ||
        items[0]?.merchant_id ||
        order.merchant_id ||
        payload?.merchant_id ||
        null;

      const body = {
        status: 'success',
        order_id: `ORD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase(),
        total: items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0) || 0,
        currency: 'USD',
        status_text: 'pending',
        ...(offerId ? { resolved_offer_id: offerId } : {}),
        ...(merchantId ? { resolved_merchant_id: merchantId } : {}),
      };
      const orderLines = buildOrderLineSnapshots(order, {
        orderId: body.order_id,
        resolvedOfferId: offerId,
        resolvedMerchantId: merchantId,
      });
      if (orderLines.length) {
        body.order_lines = orderLines;
      }
      return {
        handled: true,
        statusCode: 200,
        body: {
          ...body,
          status: 'success',
          order_status: 'pending',
        },
      };
    }

    case 'preview_quote': {
      const quote = payload?.quote || {};
      const offerIdRaw =
        quote.offer_id || quote.offerId || payload?.offer_id || payload?.offerId || null;
      const offerId = String(offerIdRaw || '').trim() || null;
      const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
      const resolvedMerchantId =
        merchantFromOffer || quote.merchant_id || payload?.merchant_id || null;
      const items = quote.items || [];
      const subtotal = items.reduce(
        (sum, item) =>
          sum + Number(item.unit_price || item.price || 0) * Number(item.quantity || 0),
        0,
      );

      return {
        handled: true,
        statusCode: 200,
        body: {
          quote_id: `q_${Date.now().toString(36)}`,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          engine: 'mock',
          currency: 'USD',
          pricing: {
            subtotal,
            discount_total: 0,
            shipping_fee: 0,
            tax: 0,
            total: subtotal,
          },
          promotion_lines: [],
          line_items: items.map((item) => ({
            variant_id: item.variant_id || item.sku_id || item.sku || item.product_id,
            quantity: item.quantity,
            unit_price_original: item.unit_price || item.price || 0,
            unit_price_effective: item.unit_price || item.price || 0,
            line_discount_total: 0,
            compare_at_savings: 0,
          })),
          ...(offerId ? { resolved_offer_id: offerId } : {}),
          ...(resolvedMerchantId ? { resolved_merchant_id: resolvedMerchantId } : {}),
        },
      };
    }

    case 'submit_payment':
      return {
        handled: true,
        statusCode: 200,
        body: {
          status: 'success',
          payment_id: `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.toUpperCase(),
          payment_status: 'processing',
          message: 'Payment is being processed',
        },
      };

    case 'get_order_status':
      return {
        handled: true,
        statusCode: 200,
        body: {
          status: 'success',
          order: {
            order_id: payload?.order?.order_id,
            status: 'processing',
            created_at: new Date().toISOString(),
            total: 50.0,
            currency: 'USD',
          },
        },
      };

    default:
      return { handled: false };
  }
}

module.exports = {
  handleMockInvokeOperation,
};

const { createHash } = require('crypto');
const { extractMerchantIdFromOfferId } = require('../offers/offerIds');
const {
  CATALOG_REQUEST_BUILDER_OPERATIONS,
  buildCatalogInvokeUpstreamRequest,
} = require('./catalog/requestBuilders');
const {
  rewriteCheckoutItemsForOfferSelection: rewriteCheckoutItemsForOfferSelectionBase,
} = require('./catalog/productDetailAdapters');

const HANDLED_OPERATIONS = new Set([
  'preview_quote',
  'create_order',
  'confirm_payment',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
  'offers.resolve',
  ...CATALOG_REQUEST_BUILDER_OPERATIONS,
]);

function buildRequestError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

async function buildPreviewQuoteRequest({
  payload,
  checkoutToken,
  rewriteCheckoutItemsForOfferSelection = rewriteCheckoutItemsForOfferSelectionBase,
}) {
  const quote = payload.quote || {};
  const offerIdRaw =
    quote.offer_id || quote.offerId || payload.offer_id || payload.offerId || null;
  const offerId = String(offerIdRaw || '').trim() || null;
  const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
  const effectiveMerchantId = merchantFromOffer || quote.merchant_id;

  if (!effectiveMerchantId || !Array.isArray(quote.items) || quote.items.length === 0) {
    throw buildRequestError(
      'MISSING_PARAMETERS',
      'quote.merchant_id (or quote.offer_id) and quote.items[] are required',
    );
  }

  const normalizedQuote = { ...quote, merchant_id: effectiveMerchantId };
  delete normalizedQuote.offer_id;
  delete normalizedQuote.offerId;

  if (offerId) {
    try {
      const rewritten = await rewriteCheckoutItemsForOfferSelection({
        offerId,
        merchantId: effectiveMerchantId,
        items: normalizedQuote.items,
        checkoutToken,
      });
      if (Array.isArray(rewritten?.items) && rewritten.items.length > 0) {
        normalizedQuote.items = rewritten.items;
      }
    } catch (err) {
      throw buildRequestError(
        err?.code || 'CHECKOUT_ITEM_REWRITE_FAILED',
        err?.message || 'Failed to map selected offer to merchant catalog items',
      );
    }
  }

  return {
    requestBody: normalizedQuote,
    resolvedOfferId: offerId,
    resolvedMerchantId: offerId ? String(effectiveMerchantId || '').trim() || null : null,
  };
}

async function buildCreateOrderRequest({
  payload,
  checkoutToken,
  rewriteCheckoutItemsForOfferSelection = rewriteCheckoutItemsForOfferSelectionBase,
}) {
  const order = payload.order || {};
  const offerIdRaw =
    order.offer_id || order.offerId || payload.offer_id || payload.offerId || null;
  const offerId = String(offerIdRaw || '').trim() || null;
  const items = Array.isArray(order.items) ? order.items : [];
  const merchantFromOffer = offerId ? extractMerchantIdFromOfferId(offerId) : null;
  const merchantId = merchantFromOffer || items[0]?.merchant_id;

  if (!merchantId) {
    throw buildRequestError(
      'MISSING_PARAMETERS',
      'merchant_id is required in items (or provide order.offer_id)',
    );
  }

  let rewrittenItems = items;
  if (offerId && items.length > 0) {
    try {
      const rewritten = await rewriteCheckoutItemsForOfferSelection({
        offerId,
        merchantId,
        items,
        checkoutToken,
      });
      if (Array.isArray(rewritten?.items) && rewritten.items.length > 0) {
        rewrittenItems = rewritten.items;
      }
    } catch (err) {
      throw buildRequestError(
        err?.code || 'CHECKOUT_ITEM_REWRITE_FAILED',
        err?.message || 'Failed to map selected offer to merchant catalog items',
      );
    }
  }

  const preferredPsp = order.preferred_psp || payload.preferred_psp || undefined;

  return {
    requestBody: {
      merchant_id: merchantId,
      customer_email: order.customer_email || 'agent@pivota.cc',
      ...(order.currency ? { currency: order.currency } : {}),
      ...(order.quote_id ? { quote_id: order.quote_id } : {}),
      ...(order.selected_delivery_option
        ? { selected_delivery_option: order.selected_delivery_option }
        : {}),
      items: rewrittenItems.map((item) => ({
        merchant_id: merchantId,
        product_id: item.product_id,
        ...(item.variant_id ? { variant_id: item.variant_id } : {}),
        ...(item.sku ? { sku: item.sku } : {}),
        ...(item.selected_options ? { selected_options: item.selected_options } : {}),
        product_title: item.product_title || item.title || 'Product',
        quantity: item.quantity,
        unit_price: item.unit_price || item.price,
        subtotal: (item.unit_price || item.price) * item.quantity,
      })),
      ...(order.discount_codes ? { discount_codes: order.discount_codes } : {}),
      shipping_address: {
        name: order.shipping_address?.recipient_name || order.shipping_address?.name,
        address_line1: order.shipping_address?.address_line1,
        address_line2: order.shipping_address?.address_line2 || '',
        city: order.shipping_address?.city,
        ...(order.shipping_address?.state
          ? { state: order.shipping_address.state }
          : order.shipping_address?.province
            ? { state: order.shipping_address.province }
            : order.shipping_address?.state_code
              ? { state: order.shipping_address.state_code }
              : order.shipping_address?.province_code
                ? { state: order.shipping_address.province_code }
                : {}),
        country: order.shipping_address?.country,
        postal_code: order.shipping_address?.postal_code,
        phone: order.shipping_address?.phone || '',
      },
      customer_notes: order.notes || '',
      metadata: order.metadata || {},
      ...(preferredPsp ? { preferred_psp: preferredPsp } : {}),
      ...(payload.acp_state ? { acp_state: payload.acp_state } : {}),
    },
    resolvedOfferId: offerId,
    resolvedMerchantId: offerId ? String(merchantId || '').trim() || null : null,
  };
}

function buildConfirmPaymentRequest({ payload, url }) {
  const order = payload.order || {};
  const orderId =
    order.order_id ||
    order.orderId ||
    payload.order_id ||
    payload.orderId ||
    payload.payment?.order_id ||
    payload.payment?.orderId ||
    payload.status?.order_id ||
    payload.status?.orderId;
  if (!orderId) {
    throw buildRequestError('MISSING_PARAMETERS', 'order_id is required');
  }

  return {
    url: String(url || '').replace('{order_id}', encodeURIComponent(orderId)),
    requestBody: {},
  };
}

function buildSubmitPaymentRequest({ payload }) {
  const payment = payload.payment || {};
  const methodHint =
    payment.payment_method_hint ||
    (typeof payment.payment_method === 'string' ? payment.payment_method : undefined);

  let idempotencyKey =
    payment.idempotency_key ||
    payment.idempotencyKey ||
    payload.idempotency_key ||
    payload.idempotencyKey ||
    undefined;

  if (!idempotencyKey && payment.order_id) {
    const basis = JSON.stringify({
      order_id: payment.order_id,
      method: methodHint || '',
      expected_amount: payment.expected_amount || null,
      currency: payment.currency || null,
    });
    idempotencyKey = `pivota_gateway:${createHash('sha256')
      .update(basis)
      .digest('hex')
      .slice(0, 24)}`;
  }

  return {
    requestBody: {
      order_id: payment.order_id,
      total_amount: payment.expected_amount,
      currency: payment.currency,
      payment_method: methodHint
        ? {
            type: methodHint,
            ...(methodHint === 'card' ? { card: {} } : {}),
          }
        : undefined,
      redirect_url: payment.return_url,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(payload.ap2_state ? { ap2_state: payload.ap2_state } : {}),
    },
  };
}

function buildGetOrderStatusRequest({ payload, url }) {
  const orderId = payload.status?.order_id;
  if (!orderId) {
    throw buildRequestError('MISSING_PARAMETERS', 'order_id is required');
  }

  return {
    url: String(url || '').replace('{order_id}', orderId),
  };
}

function buildRequestAfterSalesRequest({ payload, url, pivotaApiBase }) {
  const orderId = payload.status?.order_id;
  if (!orderId) {
    throw buildRequestError('MISSING_PARAMETERS', 'order_id is required');
  }

  const requestedActionRaw =
    payload.status.requested_action ||
    payload.status.requestedAction ||
    payload.status.action;
  const requestedAction =
    typeof requestedActionRaw === 'string' ? requestedActionRaw.trim().toLowerCase() : '';

  if (requestedAction && requestedAction !== 'refund' && requestedAction !== 'cancel') {
    throw buildRequestError(
      'UNSUPPORTED_ACTION',
      `Unsupported requested_action: ${requestedAction}`,
    );
  }

  if (requestedAction === 'cancel') {
    return {
      url: `${pivotaApiBase}/agent/v1/orders/${encodeURIComponent(orderId)}/cancel`,
    };
  }

  return {
    url: String(url || '').replace('{order_id}', orderId),
    requestBody: payload.status.reason ? { reason: payload.status.reason } : {},
  };
}

function buildOffersResolveRequest({ payload, metadata }) {
  const offersPayload = payload.offers || payload || {};
  const offersProduct =
    offersPayload && typeof offersPayload.product === 'object' && !Array.isArray(offersPayload.product)
      ? { ...offersPayload.product }
      : {};
  const productId = String(
    offersProduct.product_id ||
      offersProduct.productId ||
      offersPayload.product_id ||
      offersPayload.productId ||
      '',
  ).trim();
  const skuId = String(
    offersProduct.sku_id ||
      offersProduct.skuId ||
      offersPayload.sku_id ||
      offersPayload.skuId ||
      '',
  ).trim();

  const normalizedOffersPayload = {
    ...offersPayload,
    product: {
      ...offersProduct,
      ...(productId ? { product_id: productId } : {}),
      ...(skuId ? { sku_id: skuId } : {}),
    },
    ...(productId ? { product_id: productId } : {}),
    ...(skuId ? { sku_id: skuId } : {}),
  };

  return {
    requestBody: {
      operation: 'offers.resolve',
      payload: normalizedOffersPayload,
      metadata,
    },
  };
}

async function buildCommerceInvokeUpstreamRequest({
  operation,
  effectivePayload,
  payload,
  metadata,
  creatorId,
  checkoutToken,
  url,
  pivotaApiBase,
  rewriteCheckoutItemsForOfferSelection = rewriteCheckoutItemsForOfferSelectionBase,
  buildRequestError: customBuildRequestError,
  searchLimitMax,
  applyShoppingCatalogQueryGuards,
  getCreatorConfig,
  uniqueStrings,
  isCreatorUiSource,
  proxySearchCreatorScopeToConfig,
} = {}) {
  const normalizedOperation = String(operation || '').trim();
  if (!HANDLED_OPERATIONS.has(normalizedOperation)) {
    return null;
  }

  switch (normalizedOperation) {
    case 'preview_quote':
      return buildPreviewQuoteRequest({
        payload,
        checkoutToken,
        rewriteCheckoutItemsForOfferSelection,
      });
    case 'create_order':
      return buildCreateOrderRequest({
        payload,
        checkoutToken,
        rewriteCheckoutItemsForOfferSelection,
      });
    case 'confirm_payment':
      return buildConfirmPaymentRequest({ payload, url });
    case 'submit_payment':
      return buildSubmitPaymentRequest({ payload });
    case 'get_order_status':
      return buildGetOrderStatusRequest({ payload, url });
    case 'request_after_sales':
      return buildRequestAfterSalesRequest({ payload, url, pivotaApiBase });
    case 'offers.resolve':
      return buildOffersResolveRequest({ payload, metadata });
    default:
      return buildCatalogInvokeUpstreamRequest({
        operation: normalizedOperation,
        effectivePayload,
        payload,
        metadata,
        creatorId,
        url,
        checkoutToken,
        buildRequestError: customBuildRequestError || buildRequestError,
        searchLimitMax,
        applyShoppingCatalogQueryGuards,
        getCreatorConfig,
        uniqueStrings,
        isCreatorUiSource,
        proxySearchCreatorScopeToConfig,
      });
  }
}

module.exports = {
  buildCommerceInvokeUpstreamRequest,
  buildRequestError,
  HANDLED_OPERATIONS,
};

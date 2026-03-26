const { createHash } = require('crypto');

const { buildProductGroupId } = require('../../offers/offerIds');

function buildOrderLineSnapshots(orderRequest, options = {}) {
  const req = orderRequest && typeof orderRequest === 'object' ? orderRequest : {};
  const items = Array.isArray(req.items) ? req.items : [];
  const orderId = options.orderId || req.order_id || req.orderId || null;
  const resolvedOfferId = options.resolvedOfferId || null;
  const resolvedMerchantId = options.resolvedMerchantId || null;
  const currency = req.currency || null;
  const selectedDelivery = req.selected_delivery_option || req.selectedDeliveryOption || null;
  const shippingSnapshot = selectedDelivery
    ? {
        method_label: selectedDelivery.method_label || selectedDelivery.label || selectedDelivery.name || null,
        eta_days_range: selectedDelivery.eta_days_range || selectedDelivery.etaDaysRange || null,
        cost: selectedDelivery.cost || selectedDelivery.price || null,
      }
    : null;
  const returnsSnapshotRaw = req.returns_snapshot || req.returns || req.returns_policy || null;
  const returnsSnapshot = returnsSnapshotRaw
    ? {
        return_window_days:
          returnsSnapshotRaw.return_window_days ||
          returnsSnapshotRaw.returnWindowDays ||
          returnsSnapshotRaw.window_days ||
          returnsSnapshotRaw.windowDays ||
          null,
        free_returns:
          typeof returnsSnapshotRaw.free_returns === 'boolean'
            ? returnsSnapshotRaw.free_returns
            : typeof returnsSnapshotRaw.freeReturns === 'boolean'
              ? returnsSnapshotRaw.freeReturns
              : null,
      }
    : null;
  const policyHash = returnsSnapshot
    ? createHash('sha256')
        .update(JSON.stringify(returnsSnapshot))
        .digest('hex')
        .slice(0, 16)
    : null;

  return items.map((item, idx) => {
    const merchantId =
      item.merchant_id ||
      item.merchantId ||
      resolvedMerchantId ||
      req.merchant_id ||
      req.merchantId ||
      null;
    const productId = item.product_id || item.productId || null;
    const productGroupId =
      buildProductGroupId({ merchant_id: merchantId, product_id: productId }) || null;
    const variantId = item.variant_id || item.variantId || null;
    const unitPrice = Number(item.unit_price || item.price || 0);
    const quantity = Number(item.quantity || 0) || 1;
    const subtotal =
      typeof item.subtotal === 'number' && Number.isFinite(item.subtotal)
        ? item.subtotal
        : unitPrice * quantity;
    const lineId =
      item.line_id || item.lineId || (orderId ? `line_${orderId}_${idx + 1}` : `line_${idx + 1}`);

    return {
      line_id: lineId,
      offer_id: resolvedOfferId || item.offer_id || item.offerId || null,
      merchant_id: merchantId,
      product_id: productId,
      product_group_id: productGroupId,
      variant_id: variantId,
      quantity,
      price_snapshot: {
        unit_price: unitPrice,
        subtotal,
        currency,
      },
      ...(shippingSnapshot ? { shipping_snapshot: shippingSnapshot } : {}),
      ...(returnsSnapshot
        ? { returns_snapshot: { ...returnsSnapshot, policy_hash: policyHash } }
        : {}),
      created_at: new Date().toISOString(),
    };
  });
}

module.exports = {
  buildOrderLineSnapshots,
};

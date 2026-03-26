const INVOKE_ROUTE_MAP = Object.freeze({
  find_products: {
    // Use the stable Agent Search endpoint (GET) to avoid upstream /agent/shop/v1/invoke timeouts.
    method: 'GET',
    path: '/agent/v1/products/search',
    paramType: 'query',
  },
  find_similar_products: {
    // Delegate to Python shopping gateway for multi-merchant similarity.
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body',
  },
  find_products_multi: {
    // Prefer the stable Agent Search endpoint (GET). We can opt into cross-merchant
    // search via merchant_ids[] or search_all_merchants=true.
    method: 'GET',
    path: '/agent/v1/products/search',
    paramType: 'query',
  },
  products_recommendations: {
    method: 'GET',
    path: '/agent/v1/products/recommendations',
    paramType: 'query',
  },
  'products.recommendations': {
    method: 'GET',
    path: '/agent/v1/products/recommendations',
    paramType: 'query',
  },
  get_product_detail: {
    method: 'GET',
    // Use the agent-facing product detail endpoint (legacy but stable).
    // The newer `/agent/v1/products/merchants/{merchant_id}/product/{product_id}` shape
    // can differ by identifier type and has shown PRODUCT_NOT_FOUND for ids returned by search.
    path: '/agent/v1/products/{merchant_id}/{product_id}',
    paramType: 'path',
  },
  preview_quote: {
    method: 'POST',
    path: '/agent/v1/quotes/preview',
    paramType: 'body',
  },
  create_order: {
    method: 'POST',
    path: '/agent/v1/orders/create',
    paramType: 'body',
  },
  confirm_payment: {
    method: 'POST',
    path: '/agent/v1/orders/{order_id}/confirm-payment',
    paramType: 'path',
  },
  submit_payment: {
    method: 'POST',
    path: '/agent/v1/payments',
    paramType: 'body',
  },
  get_order_status: {
    method: 'GET',
    path: '/agent/v1/orders/{order_id}/track',
    paramType: 'path',
  },
  request_after_sales: {
    method: 'POST',
    path: '/agent/v1/orders/{order_id}/refund',
    paramType: 'mixed',
  },
  track_product_click: {
    method: 'POST',
    path: '/agent/v1/events/product-click',
    paramType: 'body',
  },
  'offers.resolve': {
    // Offer resolution is implemented in the Python shopping gateway (POST /agent/shop/v1/invoke).
    method: 'POST',
    path: '/agent/shop/v1/invoke',
    paramType: 'body',
  },
});

function getInvokeRoute(operation) {
  const normalizedOperation = String(operation || '').trim();
  return INVOKE_ROUTE_MAP[normalizedOperation] || null;
}

module.exports = {
  INVOKE_ROUTE_MAP,
  getInvokeRoute,
};

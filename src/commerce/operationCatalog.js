const PUBLIC_TOOL_OPERATIONS = Object.freeze([
  'find_products',
  'find_products_multi',
  'get_product_detail',
  'offers.resolve',
  'preview_quote',
  'create_order',
  'confirm_payment',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
  'track_product_click',
]);

const INTERNAL_RUNTIME_OPERATIONS = Object.freeze([
  'resolve_product_candidates',
  'resolve_product_group',
  'find_similar_products',
  'products.recommendations',
  'find_promotions',
  'create_promotion',
  'update_promotion',
  'get_pdp',
  'get_pdp_v2',
]);

const RUNTIME_OPERATIONS = Object.freeze([
  ...PUBLIC_TOOL_OPERATIONS,
  ...INTERNAL_RUNTIME_OPERATIONS,
]);

const PUBLIC_AFTER_SALES_ACTIONS = Object.freeze([
  'refund',
  'cancel',
]);

const CANONICAL_TO_LEGACY_OPERATION = Object.freeze({
  'catalog.search': 'find_products_multi',
  'catalog.detail': 'get_pdp_v2',
  'offers.resolve': 'offers.resolve',
  'quote.preview': 'preview_quote',
  'order.create': 'create_order',
  'payment.submit': 'submit_payment',
  'payment.confirm': 'confirm_payment',
  'order.status': 'get_order_status',
  'after_sales.create': 'request_after_sales',
});

const LEGACY_TO_CANONICAL_OPERATION = Object.freeze(
  Object.entries(CANONICAL_TO_LEGACY_OPERATION).reduce((acc, [canonicalOperation, legacyOperation]) => {
    acc[legacyOperation] = canonicalOperation;
    return acc;
  }, {}),
);

const CANONICAL_V2_OPERATIONS = Object.freeze(
  Object.keys(CANONICAL_TO_LEGACY_OPERATION),
);

module.exports = {
  PUBLIC_TOOL_OPERATIONS,
  INTERNAL_RUNTIME_OPERATIONS,
  RUNTIME_OPERATIONS,
  PUBLIC_AFTER_SALES_ACTIONS,
  CANONICAL_TO_LEGACY_OPERATION,
  LEGACY_TO_CANONICAL_OPERATION,
  CANONICAL_V2_OPERATIONS,
};

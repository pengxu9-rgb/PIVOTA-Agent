const { z } = require('zod');

const OperationEnum = z.enum([
  'find_products',
  // Cross-merchant search (backend gateway)
  'find_products_multi',
  'find_similar_products',
  'find_promotions', // admin list (optional routing guard)
  'create_promotion',
  'update_promotion',
  'get_product_detail',
  'create_order',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
]);

// Request shape from LLM/gateway caller to the invoke endpoint.
// The gateway maintains the same external interface while internally adapting to real Pivota API.
const InvokeRequestSchema = z.object({
  operation: OperationEnum,
  payload: z.object({
    // ACP / AP2 states are opaque; pass through without inspection.
    acp_state: z.record(z.any()).optional(),
    ap2_state: z.record(z.any()).optional(),

    // Business payload fields; different operations use different keys.
    // See docs/pivota-api-mapping.md for detailed field requirements.
    
    // find_products: { merchant_id?, query?, price_min?, price_max?, category?, in_stock_only?, page?, page_size? }
    search: z.any().optional(),
    
    // get_product_detail: { merchant_id, product_id, sku_id? }
    product: z.any().optional(),

    // find_similar_products: { product_id, creator_id?, limit?, exclude_ids?, query? }
    similar: z.any().optional(),

    // promotions admin payloads
    promotion: z.any().optional(),
    promotion_id: z.string().optional(),
    
    // create_order: { items[], shipping_address, notes? }
    order: z.any().optional(),
    
    // submit_payment: { order_id, expected_amount, currency, payment_method_hint?, return_url? }
    payment: z.any().optional(),
    
    // get_order_status / request_after_sales: { order_id, requested_action?, reason? }
    status: z.any().optional(),
  }).passthrough(),
});

module.exports = {
  InvokeRequestSchema,
  OperationEnum,
};

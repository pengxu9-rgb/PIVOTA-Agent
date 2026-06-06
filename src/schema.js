const { z } = require('zod');

const OperationEnum = z.enum([
  'find_products',
  // Cross-merchant search (backend gateway)
  'find_products_multi',
  'get_discovery_feed',
  'get_product_entity_index_feed',
  // Lightweight product->offer candidates resolver (multi-offer Phase 2)
  'resolve_product_candidates',
  // Resolve product group membership (canonical PDP)
  'resolve_product_group',
  'find_similar_products',
  'products.recommendations',
  // Resolve external/internal offers for a SKU (implemented in python shop gateway)
  'offers.resolve',
  'preview_quote',
  'find_promotions', // admin list (optional routing guard)
  'create_promotion',
  'update_promotion',
  'get_product_detail',
  'get_pdp',
  'get_pdp_v2',
  'get_product_intel_v1',
  'get_product_feedback_v1',
  'get_product_recommendation_intents_v1',
  'prepare_pivota_insights_coverage_v1',
  // Quote-first (locked pricing)
  'create_order',
  'confirm_payment',
  'submit_payment',
  'get_order_status',
  'request_after_sales',
]);

const OpaqueStateSchema = z.record(z.string(), z.any());

const IdempotencyKeySchema = z.string().min(8);

const ShippingAddressSchema = z.object({
  country: z.string().min(1),
  city: z.string().min(1),
  postal_code: z.string().optional(),
  address_line1: z.string().min(1),
  address_line2: z.string().optional(),
  recipient_name: z.string().min(1),
  phone: z.string().optional(),
}).strict();

const DeliveryPreferencesSchema = z.object({
  max_eta_days: z.number().int().min(1).optional(),
  preferred_carriers: z.array(z.string()).optional(),
}).strict();

const CreateOrderPayloadSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  acp_state: OpaqueStateSchema.optional(),
  order: z.object({
    quote_id: z.string().min(1),
    shipping_address: ShippingAddressSchema,
    delivery_preferences: DeliveryPreferencesSchema.optional(),
    notes: z.string().optional(),
  }).strict(),
}).strict();

const SubmitPaymentPayloadSchema = z.object({
  idempotency_key: IdempotencyKeySchema,
  confirmation_token: z.string().min(1),
  ap2_state: OpaqueStateSchema.optional(),
  payment: z.object({
    order_id: z.string().min(1),
    expected_amount: z.number(),
    currency: z.string().min(1),
    payment_method_hint: z.string().optional(),
    payment_handler_id: z.string().optional(),
    payment_handler_type: z.string().optional(),
    return_url: z.string().optional(),
  }).strict(),
}).strict();

const STRICT_PAYLOAD_SCHEMAS_BY_OPERATION = Object.freeze({
  create_order: CreateOrderPayloadSchema,
  submit_payment: SubmitPaymentPayloadSchema,
});

// Request shape from LLM/gateway caller to the invoke endpoint.
// The gateway maintains the same external interface while internally adapting to real Pivota API.
const BaseInvokeRequestSchema = z.object({
  operation: OperationEnum,
  payload: z.object({
    // ACP / AP2 states are opaque; pass through without inspection.
    acp_state: OpaqueStateSchema.optional(),
    ap2_state: OpaqueStateSchema.optional(),
    idempotency_key: IdempotencyKeySchema.optional(),
    confirmation_token: z.string().optional(),

    // Business payload fields; different operations use different keys.
    // See docs/pivota-api-mapping.md for detailed field requirements.
    
    // find_products: { merchant_id?, query?, price_min?, price_max?, category?, in_stock_only?, page?, page_size? }
    search: z.any().optional(),
    
    // get_product_detail: { merchant_id, product_id, sku_id? }
    product: z.any().optional(),

    // find_similar_products: { product_id, creator_id?, limit?, exclude_ids?, query? }
    similar: z.any().optional(),

    // offers.resolve: { product: { sku_id?, product_id? }, market?, tool?, limit? }
    offers: z.any().optional(),

    // promotions admin payloads
    promotion: z.any().optional(),
    promotion_id: z.string().optional(),

    // preview_quote: { merchant_id, items[], discount_codes?, customer_email?, shipping_address?, selected_delivery_option? }
    quote: z.any().optional(),
    
    // create_order: { quote_id, shipping_address, delivery_preferences?, notes? } plus payload.idempotency_key
    order: z.any().optional(),
    
    // submit_payment: { order_id, expected_amount echo, currency, payment_method_hint?, payment_handler_id?, payment_handler_type?, return_url? } plus payload.idempotency_key and payload.confirmation_token
    payment: z.any().optional(),
    
    // get_order_status / request_after_sales: { order_id, requested_action?, reason? }
    status: z.any().optional(),
  }).passthrough(),
});

const StrictInvokeRequestSchema = BaseInvokeRequestSchema.superRefine((value, ctx) => {
  const strictPayloadSchema = STRICT_PAYLOAD_SCHEMAS_BY_OPERATION[value.operation];
  if (!strictPayloadSchema) return;

  const parsed = strictPayloadSchema.safeParse(value.payload);
  if (parsed.success) return;

  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      ...issue,
      path: ['payload', ...issue.path],
    });
  }
});

const InvokeRequestSchema = BaseInvokeRequestSchema;

module.exports = {
  CreateOrderPayloadSchema,
  InvokeRequestSchema,
  OperationEnum,
  StrictInvokeRequestSchema,
  SubmitPaymentPayloadSchema,
};

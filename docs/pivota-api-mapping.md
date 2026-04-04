# Pivota Agent ↔ Pivota API Mapping

This doc tracks how the Pivota Shopping Agent gateway and tool schema map to the real Pivota API. Use it when switching from mock to production.

## 1) Endpoints

Gateway entry: `POST /agent/shop/v1/invoke`

Real production routing (gateway -> upstream):
- `operation = "find_products"` → `GET {PIVOTA_API_BASE}/agent/v1/products/search`
- `operation = "get_discovery_feed"` → gateway-owned discovery contract; internally recalls one or more `GET {PIVOTA_BACKEND_BASE_URL | PIVOTA_API_BASE}/agent/v1/products/search` browse/search pools and applies server-side discovery scoring
- `operation = "get_product_detail"` → `GET {PIVOTA_API_BASE}/agent/v1/products/{merchant_id}/{product_id}`
- `operation = "preview_quote"` → `POST {PIVOTA_API_BASE}/agent/v1/quotes/preview`
- `operation = "create_order"` → `POST {PIVOTA_API_BASE}/agent/v1/orders/create`
- `operation = "submit_payment"` → `POST {PIVOTA_API_BASE}/agent/v1/payments`
- `operation = "get_order_status"` → `GET {PIVOTA_API_BASE}/agent/v1/orders/{order_id}/track`
- `operation = "request_after_sales"` → `POST {PIVOTA_API_BASE}/agent/v1/orders/{order_id}/refund`

Note: The gateway maintains the unified `POST /agent/shop/v1/invoke` interface for all operations, 
internally converting to appropriate HTTP methods and paths.

## 2) Request payload mapping

Tool schema (`docs/tool-schema.json`) -> gateway schema (`src/schema.js`) -> upstream Pivota API.

For each operation, align required/optional fields and note any differences.

### 2.1 find_products
- Gateway receives: `payload.search` (JSON body)
- Upstream expects: Query parameters (GET request)
- Parameter mapping:
  - `payload.search.query` → `?query=`
  - `payload.search.price_min` → `?min_price=`
  - `payload.search.price_max` → `?max_price=`
  - `payload.search.page` → `?offset=` (calculate: (page-1) * page_size)
  - `payload.search.page_size` → `?limit=` (max: 100, default: 20)
  - `payload.search.city` → `?merchant_id=` (if merchant-specific search needed)
- Additional upstream params:
  - `?in_stock_only=true` (default)
  - `?category=` (optional filter)

### 2.1.1 get_discovery_feed
- Gateway receives: `payload.surface`, `payload.page`, `payload.limit`, `payload.context`
- Upstream does not currently expose a dedicated discovery endpoint
- Gateway-owned mapping:
  - `payload.context.recent_views` and `payload.context.recent_queries` stay inside the gateway and are used to build the discovery profile
  - Gateway recalls candidates from `GET /agent/v1/products/search`
    - `browse_products` uses empty-query browse recall first
    - `home_hot_deals` uses an interest query when available, then browse recall fill
  - Gateway applies surface-specific ranking, suppression, and metadata before responding
- Notes:
  - Public callers should keep using `POST /agent/shop/v1/invoke`
  - External callers should not bind directly to raw `/agent/v1/products/search` semantics for discovery

### 2.2 get_product_detail
- Gateway receives: `payload.product` (JSON body)
- Upstream expects: Path parameters (GET request)
- Parameter mapping:
  - `payload.product.merchant_id` → `{merchant_id}` in path (required)
  - `payload.product.product_id` → `{product_id}` in path (required)
  - `payload.product.sku_id` → Not used in upstream (SKU handled at product level)
- Notes:
  - Both merchant_id and product_id are required
  - Response includes all SKUs/variants for the product

### 2.3 create_order
- Gateway receives: `payload.order` (JSON body)
- Upstream expects: Request body (POST)
- Parameter mapping (direct pass-through with structure adjustment):
  - `payload.order.items` → `items` array
    - Each item needs: `merchant_id`, `product_id`, `quantity`, `price`
  - `payload.order.shipping_address` → `shipping_address`
    - Required: `recipient_name`, `address_line1`, `city`, `country`, `postal_code`
    - Optional: `address_line2`, `phone`
  - `payload.order.notes` → `customer_notes`
  - `payload.acp_state` → Pass through as-is
- Additional fields added by gateway:
  - `agent_id` (from auth context)
  - `currency` (from items or default)

### 2.3.1 preview_quote (quote-first)
- Gateway receives: `payload.quote` (JSON body)
- Upstream expects: Request body (POST)
- Parameter mapping (direct pass-through with structure adjustment):
  - `payload.quote.merchant_id` → `merchant_id` (required)
  - `payload.quote.items[]` → `items[]` (required)
  - `payload.quote.discount_codes[]` → `discount_codes[]` (optional)
  - `payload.quote.customer_email` → `customer_email` (optional)
  - `payload.quote.shipping_address` → `shipping_address` (recommended for authoritative shipping/tax)
- Notes:
  - quote-first flow expects: preview quote → create order with `quote_id`
  - `create_order` should forward `quote_id` when provided (gateway supports `payload.order.quote_id`)

### 2.4 submit_payment
- Gateway receives: `payload.payment` (JSON body)
- Upstream expects: Request body (POST)
- Parameter mapping:
  - `payload.payment.order_id` → `order_id` (required)
  - `payload.payment.expected_amount` → `total_amount` (required) ⚠️ Note: Pivota uses 'total_amount' not 'amount'
  - `payload.payment.currency` → `currency` (required)
  - `payload.payment.payment_method_hint` → `payment_method` (object format: `{type: "card"}`)
  - `payload.payment.return_url` → `redirect_url` (for 3DS/redirects)
  - `payload.ap2_state` → Pass through as-is
- Response handling:
  - `payment_id` returned on success
  - `payment_status`: "succeeded", "failed", "requires_action"
  - If `requires_action`: check `redirect_url` or `instructions`

### 2.5 get_order_status
- Gateway receives: `payload.status` (JSON body)
- Upstream expects: Path parameter (GET request)
- Parameter mapping:
  - `payload.status.order_id` → `{order_id}` in path (required)
- Response includes:
  - `order_id`
  - `status`: "pending", "processing", "shipped", "delivered", "cancelled"
  - `tracking_number` (if shipped)
  - `carrier` (if shipped)
  - `estimated_delivery` (ISO date)
  - `shipment_updates` array with timestamps

### 2.6 request_after_sales
- Gateway receives: `payload.status` (JSON body)
- Upstream expects: Path parameter + optional body (POST request)
- Parameter mapping:
  - `payload.status.order_id` → `{order_id}` in path (required)
  - `payload.status.requested_action` → Determines refund type (full/partial)
  - `payload.status.reason` → `reason` in body (optional but recommended)
- Notes:
  - Current endpoint only supports refunds (not exchanges/returns)
  - Response includes refund status and processing timeline
  - Agent must own the order to request refund

## 3) Response mapping

For each operation, list expected fields from upstream and any fields not to expose/log.

### Example: submit_payment
- Expect: `payment_status`, `ap2_state`, `order_id`, possibly `redirect_url` / `qr_code` / `instructions`.
- Constraints: never fabricate payment URLs/status; always pass latest `ap2_state` to follow-up calls; avoid logging sensitive payment data.

### Example: request_after_sales
- Expect: `request_id`, `requested_action`, `status`, `message`, and any SLA/next-step instructions.
- Constraints: do not promise outcomes; reflect tool response verbatim on limitations.

TODO: Fill per-operation details once production API docs are in hand.

## 4) Production switch checklist

Before pointing `{PIVOTA_API_BASE}` to production:
- [x] Paths/verbs verified against production Pivota API (from OpenAPI spec)
- [ ] Request payload fields/naming/types aligned; gateway routing logic updated
- [ ] Response fields understood; sensitive data not logged (check pino configuration)
- [ ] `OPENAI_API_KEY` and `PIVOTA_API_KEY` set via environment variables only
- [ ] Test with dedicated test merchant account to avoid real transactions
- [ ] Gateway internal routing logic implemented for GET/POST conversion
- [ ] Path parameter extraction logic added for {merchant_id}, {product_id}, {order_id}
- [ ] Query parameter conversion for GET requests (find_products)
- [ ] Error handling for upstream API failures with proper status codes

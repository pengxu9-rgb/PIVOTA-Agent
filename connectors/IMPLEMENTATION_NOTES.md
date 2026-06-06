# Implementation Notes

## Interface Rationale

`MerchantConnector` separates discovery reads from money-path writes. Catalog
sync can return cached or eventually consistent product data, but `previewQuote`
is explicitly the live merchant price lock required by INV-5.

The interface returns normalized shapes that match the safety-kernel quote
snapshot fields:

- `locked_totals`
- `currency`
- `merchant_of_record`
- `line_items`

`quoteRef` remains opaque connector state. The kernel can store it alongside the
snapshot or pass it to `createOrder`, but should not inspect or rewrite provider
internals.

## Shopify Mapping Assumptions

The reference Shopify connector maps:

- catalog sync to Shopify Admin GraphQL product queries
- product detail to Shopify Admin REST product reads
- live quote preview to Shopify Storefront GraphQL `cartCreate`
- order creation to Shopify Admin draft-order shape
- refunds to Shopify Admin refund creation shape
- webhooks to Shopify HMAC-SHA256 verification with
  `x-shopify-hmac-sha256`

Shop Pay is exposed as the payment handler through:

- `payment_handler_id: "shop_pay"`
- `payment_handler_type: "dev.shopify.shop_pay"`

For production Shopify checkout, the draft-order step can be replaced with a
merchant-approved checkout/order handoff. The invariant is that Pivota must keep
using the locked quote snapshot and merchant of record produced by
`previewQuote`.

## SafetyKernel Quote Snapshot Wiring

`previewQuote` returns data that can feed `QuoteRegistry.issue(...)` directly:

```js
const liveQuote = await connector.previewQuote(input);
quoteRegistry.issue({
  user_ref,
  acp_session_id,
  merchant_of_record: liveQuote.merchant_of_record,
  currency: liveQuote.currency,
  locked_totals: liveQuote.locked_totals,
  line_items: liveQuote.line_items,
});
```

The registry snapshot becomes the server-side source of truth for amount,
currency, tax, shipping, and merchant of record. `createOrder` receives the
connector `quoteRef`; payment still uses the SafetyKernel snapshot for amount
validation, not model-provided numbers.

## Operational Notes

- `previewQuote` throws `LIVE_QUOTE_INCOMPLETE` if Shopify does not return all
  required price-lock fields.
- The custom REST connector intentionally throws `NOT_SUPPORTED` for money-path
  operations until a merchant-specific mapping is supplied.
- Webhook parsing does not verify signatures by itself. Call
  `verifyWebhook(headers, rawBody)` before `parseWebhook(rawBody)`.

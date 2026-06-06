# Merchant Connectors

This directory defines a self-contained merchant connector layer for Pivota.
Connectors translate the Pivota commerce contract into merchant-specific rails
without changing the safety kernel, agent gateway, or catalog code.

## Model

- `MerchantConnector.js` is the abstract interface every connector implements.
- `shopify/ShopifyConnector.js` is the reference implementation for Shopify
  Admin and Storefront API shapes.
- `registry.js` resolves a merchant registry record to a connector instance.
  It supports `shopify` and a `custom` REST fallback stub.

Each connector instance is merchant-scoped and carries:

- `merchant_id`
- `merchant_of_record`
- provider-specific config such as shop domain, API version, and webhook secret

Secrets are only used in request headers or HMAC checks. Connector code should
not log tokens, webhook secrets, or payment state.

## Catalog Sync vs Live Quote Revalidation

Catalog sync is for discovery and cache population only:

```js
await connector.syncCatalog({ since })
```

Returned products include provenance metadata so downstream systems know the
data came from Shopify Admin catalog sync and may be stale.

Quote preview is different:

```js
await connector.previewQuote({
  merchant_id,
  items,
  shipping_address,
  discount_codes,
})
```

`previewQuote` is the INV-5 price lock. It must call the live merchant rail and
must never use a catalog cache. The result includes:

- `locked_totals.subtotal`
- `locked_totals.tax`
- `locked_totals.shipping`
- `locked_totals.total`
- `currency`
- `merchant_of_record`
- `line_items`
- opaque `quoteRef`

The safety kernel can store those values as the quote snapshot and use the
snapshot, not model-provided prices, for order and payment.

## Shopify Mapping

The Shopify connector uses Storefront GraphQL `cartCreate` for live quote
preview. The cart response supplies locked cart totals, shipping option cost,
line items, checkout URL, and Shop Pay as an available payment handler.

Order creation uses Shopify Admin draft-order shape as a reference integration
point. Production deployments may replace that with a merchant-specific checkout
handoff, but they must preserve the locked `quoteRef` and merchant of record.

Refunds use the Shopify Admin refunds endpoint shape and return normalized
refund status.

## Webhook to Status

`verifyWebhook(headers, rawBody)` verifies Shopify's `x-shopify-hmac-sha256`
header with HMAC-SHA256 over the exact raw body and the configured webhook
secret.

`parseWebhook(rawBody)` parses the JSON body into a normalized event with:

- `provider`
- `merchant_id`
- `event_type`
- `event_id`
- `order_id`
- `status`
- tracking/carrier when present

Adapters should verify first, then parse, then route order/refund events into
the Pivota order-status update path.

## Refund and After-Sales Support Matrix

| Connector | Refund | Return | Exchange | Support |
| --- | --- | --- | --- | --- |
| Shopify | Supported through Admin refunds | Not implemented | Not implemented | Not implemented |
| Custom REST stub | Not supported until mapped | Not supported | Not supported | Not supported |

Unsupported actions must throw `ConnectorError` with code `NOT_SUPPORTED` so the
agent never promises a return, exchange, or support flow that the connector
cannot execute.

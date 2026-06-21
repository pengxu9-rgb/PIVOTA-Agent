# Pivota ChatGPT Apps Adapter

This directory contains the additive ChatGPT Apps SDK presentation and checkout-conversion layer for the existing Pivota MCP server. It does not duplicate tool validation or commerce logic; the canonical server still exposes the five tools from `mcp-server/src/operationMap.js` and sends every call to `POST /agent/shop/v1/invoke`.

## What This Layer Does

- `components.js` maps Pivota tool results into serializable inline component descriptors.
- `checkoutFlow.js` helps a host or render layer decide the next checkout step and refuses payment before quote confirmation.
- `acpMapping.js` translates Pivota quote/order responses to a best-effort Agentic Commerce Protocol checkout shape and back.

## Registering the ChatGPT App

ChatGPT Apps are MCP based. The production registration should keep the existing MCP tools as the data and mutation tools, then register widget resources that render these descriptors.

1. Expose the MCP server over HTTPS with the existing auth path and canonical invoke backend.
2. Register a component template resource with MIME type `text/html;profile=mcp-app`.
3. Point each render-capable tool descriptor at the template URI with `_meta.ui.resourceUri`. ChatGPT also honors `_meta["openai/outputTemplate"]` as a compatibility alias.
4. Return concise `structuredContent` for the model and keep any large widget-only payload in `_meta`.
5. Use MCP Inspector first, then register the HTTPS connector in ChatGPT developer mode.

Official Apps SDK reference:

- https://developers.openai.com/apps-sdk/build/mcp-server

## Checkout Conversion Flow

The intended flow is:

```text
pivota_search -> pivota_quote -> quote card confirm -> pivota_create_order -> pivota_pay -> pivota_orders
```

The quote card confirm action carries only `quote_id`. The host or Safety Kernel turns the user's click into a `confirmation_token`; the model and this presentation layer never mint that token.

`checkoutFlow.nextStep(state)` returns the expected next tool and whether user confirmation is still required before pay. `checkoutFlow.assertConfirmedBeforePay(state)` throws a shared `PivotaCommerceError` with code `CONFIRMATION_REQUIRED` when the confirmation step is missing.

## Composition With Existing MCP Server And Auth

The existing `mcp-server/src/server.js` should continue to:

- list the five canonical Pivota tools from `operationMap.js`;
- run `prepareToolCall()` from `safety.js`;
- call `invokePivota()` on the canonical `/agent/shop/v1/invoke` rail;
- attach OAuth-derived `user_ref` before write calls when the auth module is wired.

After `invokePivota()` returns, the ChatGPT-specific server wrapper would convert the result to a component descriptor when a widget should render:

- search results -> `productListComponent(result)`;
- detail results -> `productDetailComponent(result)`;
- quote results -> `quoteCardComponent(result)`;
- create order results -> `orderConfirmationComponent(result)`;
- payment results -> `paymentResultComponent(result)`;
- order/after-sales results -> `afterSalesComponent(result)`.

The raw Pivota response remains the authoritative data for state continuation. Opaque `acp_state` and `ap2_state` should be passed through in subsequent tool payloads by the host/tool layer, not displayed inside component props.

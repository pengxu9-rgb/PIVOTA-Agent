# ChatGPT Adapter Implementation Notes

## Files

- `components.js`: Pure functions that convert Pivota tool results into plain Apps SDK component descriptors. Quote cards include locked totals, `expires_at`, and a `Confirm` action carrying `quote_id`. Payment components surface backend `requires_action` data without fabricating redirects or instructions.
- `checkoutFlow.js`: Checkout state helper that reuses `operationMap.js` for tool/operation names and `PivotaCommerceError` for `CONFIRMATION_REQUIRED`.
- `acpMapping.js`: Best-effort Pivota canonical response to ACP checkout mapping plus reverse mapping.
- `README.md`: Registration, checkout conversion, and existing MCP/auth composition notes.
- `../test/chatgpt.test.js`: Offline `node --test` coverage for the required X3 behavior.

## ACP Mapping Assumptions

- ACP state remains opaque. The mapper copies `acp_state` through unchanged and does not inspect session internals.
- Pivota `locked_totals` are mapped to the ACP checkout amount summary because the quote is the authoritative amount source.
- Pivota canonical quote/order payloads are preserved under `extensions.pivota.canonical` for lossless round-trips until final ACP field names are fixed.
- `merchant_of_record`, `expires_at`, `quote_id`, `order_id`, `line_items`, and `currency` are mapped by field name where present.

## Where `server.js` Would Call This

Do not edit `mcp-server/src/server.js` for X3. The integration point is after this existing line of responsibility:

```js
const response = await invokePivota(prepared);
```

A ChatGPT-specific MCP server wrapper would then choose a component mapper based on `prepared.operation`:

- `find_products`, `find_products_multi`, `get_discovery_feed` -> `productListComponent(response)`
- `get_product_detail`, `offers.resolve` -> `productDetailComponent(response)`
- `preview_quote` -> `quoteCardComponent(response)`
- `create_order` -> `orderConfirmationComponent(response)`
- `submit_payment` -> `paymentResultComponent(response)`
- `get_order_status`, `request_after_sales` -> `afterSalesComponent(response)`

The wrapper should return the component descriptor in the Apps SDK response shape while preserving the canonical response for state continuation. `ap2_state`, payment tokens, and confirmation tokens should not be logged or rendered.

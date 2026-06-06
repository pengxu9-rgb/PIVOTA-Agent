# AP2 (Agent Payments Protocol) Specification Bridge

This document describes how Pivota Shopping Agent handles AP2 state and payment flows.

## Overview

AP2 (Agent Payments Protocol) manages payment authorization, processing, and settlement on behalf of users. The Pivota Agent gateway treats AP2 state as an opaque pass-through object while understanding key payment statuses.

## Payment Flow States

### 1. Payment Initiation
- **Operation**: `submit_payment`
- **Required Input**:
  - `idempotency_key` - Stable client-generated key for write dedupe
  - `confirmation_token` - Server-minted token proving the user confirmed the quote UI
  - `payment.order_id` - From previous `create_order` response
  - `payment.expected_amount` - Verification echo of the amount the user confirmed; not the authoritative charge source
  - `payment.currency` - Verification echo currency (e.g., "USD", "CNY")
  - `payment_method_hint` - Optional hint ("card", "bank_transfer", etc.)
  - `payment_handler_id` - Optional selected payment handler from quote preview (for example, `shop_pay`)
  - `payment_handler_type` - Optional selected payment handler type (for example, `dev.shopify.shop_pay`)
  - `return_url` - For redirects/3DS flows
- **AP2 State**: May contain mandate/session from previous transactions
- **Amount authority**: The server reads the charge amount from the locked order/quote snapshot. A mismatched `expected_amount` hard-fails before charge.

### 2. Payment Status Response

The gateway recognizes three primary payment statuses:

#### `succeeded`
- Payment completed successfully
- No further action required
- AP2 state may contain settlement details

#### `failed`
- Payment was declined or errored
- Check response for specific error codes
- May retry with different payment method

#### `requires_action`
- User intervention needed (3DS, bank redirect, etc.)
- Response includes one of:
  - `redirect_url` - Send user to this URL
  - `qr_code` - Display for scanning
  - `instructions` - Show to user
- Must poll or wait for webhook callback

### 3. State Continuity
```javascript
// Example: Handling requires_action
const paymentResponse = await invoke({
  operation: "submit_payment",
  payload: {
    idempotency_key,
    confirmation_token,
    payment: { order_id, expected_amount, currency },
    ap2_state: previousAp2State // From prior payments
  }
});

if (paymentResponse.payment_status === "requires_action") {
  // Handle based on response type
  if (paymentResponse.redirect_url) {
    // Redirect user
  } else if (paymentResponse.instructions) {
    // Display instructions
  }
}
```

## Implementation Guidelines

### State Management
- Never modify or parse `ap2_state` contents
- Always include `ap2_state` from previous payment operations
- Missing `ap2_state` is valid for first-time payments

### Error Handling
- Payment errors return standard HTTP status codes
- Business logic errors (insufficient funds, risk blocks) in response body
- Always preserve `ap2_state` even on errors for retry scenarios

### Security Considerations
- Never log payment amounts or sensitive payment data
- `ap2_state` may contain tokens - treat as sensitive
- Use HTTPS for all payment operations

## Mandate and Authorization

AP2 supports payment mandates for recurring/saved payment methods:
- Mandates are created implicitly during successful payments
- `mandate_id` returned in `ap2_state` for future use
- Pass existing `ap2_state` to reuse saved payment methods

## Testing Payments

In test mode (`MODE=test`):
- Use test card numbers provided by PSPs
- Amounts may trigger specific test scenarios
- Never use real payment credentials

## Future Considerations

As AP2 evolves, the following may be added:
- Explicit mandate management operations
- Multi-PSP routing hints
- Enhanced fraud signals
- Cryptocurrency payment support

The gateway's pass-through design ensures compatibility with future AP2 versions without code changes.

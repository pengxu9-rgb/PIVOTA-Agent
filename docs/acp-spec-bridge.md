# ACP (Agentic Commerce Protocol) Specification Bridge

This document describes how Pivota Shopping Agent handles ACP state and protocol requirements.

## Overview

ACP (Agentic Commerce Protocol) manages the commerce lifecycle from discovery to fulfillment. The Pivota Agent gateway treats ACP state as an opaque pass-through object to maintain protocol flexibility.

## ACP State Lifecycle

### 1. Discovery Phase
- **Operation**: `find_products`
- **ACP State**: Initial state may be empty or contain session context
- **Response**: Returns products with `acp_state` containing:
  - `acp_session_id` - Unique session identifier
  - Additional merchant/catalog metadata (opaque to gateway)

### 2. Quote/Cart Building
- **Operation**: `get_product_detail`, `create_order`
- **ACP State**: Must pass previous `acp_state` to maintain session
- **Flow**:
  1. Product details may update pricing/availability in `acp_state`
  2. Order creation transitions to quote/cart state
  3. Response includes updated `acp_state` with order context

### 3. Order Confirmation
- **Operation**: `create_order` (finalization)
- **ACP State**: Contains quote/cart data from previous steps
- **Response**: Order ID with finalized `acp_state`

### 4. Fulfillment Tracking
- **Operation**: `get_order_status`
- **ACP State**: Optional, but maintains session continuity
- **Response**: Fulfillment status and tracking information

## Implementation Guidelines

### State Passing Rules
```javascript
// Always pass acp_state from previous responses
const nextRequest = {
  operation: "create_order",
  payload: {
    acp_state: previousResponse.acp_state, // Pass through unchanged
    order: { /* order details */ }
  }
};
```

### Gateway Behavior
- The gateway NEVER modifies or inspects `acp_state` contents
- Always forwards `acp_state` to upstream Pivota API
- Always returns `acp_state` from upstream responses
- Missing `acp_state` is valid for initial requests

### Error Handling
- If upstream returns ACP-specific errors, pass them through
- Do not retry requests that fail due to ACP state issues
- Let the client/agent handle ACP state recovery

## Future Considerations

As ACP evolves, the following may be added:
- State versioning indicators
- Explicit state transition validation
- Multi-merchant session handling
- State compression for large carts

The gateway's pass-through design ensures compatibility with future ACP versions without code changes.

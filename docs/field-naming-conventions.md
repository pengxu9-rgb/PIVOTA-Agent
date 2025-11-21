# Pivota Field Naming Conventions Guide

**Version**: 1.0  
**Purpose**: Document the field naming differences between Pivota Agent Gateway and Pivota Infrastructure

## Overview

The Pivota Agent Gateway acts as an adapter between LLM tools and Pivota Infrastructure APIs. This document clarifies the field naming conventions and mappings.

## Key Principle

**The Gateway adapts, Pivota Infra stays stable.**

- Gateway (External): Uses LLM-friendly, consistent field names
- Pivota Infra (Internal): Maintains existing field names for backward compatibility
- Mapping happens in the gateway layer

## Field Mapping Reference

### 1. Money/Amount Fields

| Context | Gateway (LLM Tool) | Pivota Infra | Notes |
|---------|-------------------|--------------|-------|
| Order Total | `expected_amount` | `total` | Order creation response |
| Payment Amount | `expected_amount` | `total_amount` | Payment submission |
| Item Price | `unit_price` | `unit_price` | Same in both |
| Line Total | `subtotal` | `subtotal` | Same in both |
| Discount | `discount` | `discount_amount` | Context-dependent |

### 2. Identification Fields

| Context | Gateway (LLM Tool) | Pivota Infra | Notes |
|---------|-------------------|--------------|-------|
| Product ID | `product_id` | `id` or `product_id` | Depends on endpoint |
| Order ID | `order_id` | `order_id` | Consistent |
| Payment ID | `payment_id` | `payment_id` | Consistent |
| Merchant | `merchant_id` | `merchant_id` | Consistent |

### 3. Address Fields

| Context | Gateway (LLM Tool) | Pivota Infra | Notes |
|---------|-------------------|--------------|-------|
| Name | `recipient_name` | `name` | Shipping address |
| Street | `address_line1` | `address_line1` | Consistent |
| Phone | `phone` | `phone_number` | May vary by context |

### 4. Status Fields

| Context | Gateway (LLM Tool) | Pivota Infra | Notes |
|---------|-------------------|--------------|-------|
| Order Status | `status` | `fulfillment_status` | Order tracking |
| Payment Status | `payment_status` | `status` | Payment response |
| Delivery | `delivery_status` | `shipping_status` | May vary |

## Implementation Guidelines

### For Gateway Development

```javascript
// Example: Payment field mapping
case 'submit_payment': {
  requestBody = {
    order_id: payload.payment?.order_id,
    total_amount: payload.payment?.expected_amount,  // Map to Pivota's field
    currency: payload.payment?.currency,
    // ... other mappings
  };
  break;
}
```

### For Documentation

Always document both names:
```markdown
- `payload.payment.expected_amount` → `total_amount` (required)
```

## Why These Differences Exist

1. **Historical Evolution**
   - Pivota Infra evolved over time with different teams
   - Gateway designed for LLM consistency

2. **Context Clarity**
   - `total` makes sense in order context
   - `total_amount` makes sense in payment context
   - `expected_amount` is clear for LLMs in all contexts

3. **Backward Compatibility**
   - Changing Pivota Infra would break existing integrations
   - Gateway provides a stable interface for new LLM integrations

## Best Practices

### DO ✅
- Document all field mappings clearly
- Test with real API responses
- Keep mappings in one place (gateway)
- Update this document when adding new operations

### DON'T ❌
- Change Pivota Infra field names without strong justification
- Assume field names are consistent across all endpoints
- Skip validation when field names differ
- Mix internal and external field names in documentation

## Common Pitfalls

1. **Assuming Consistency**
   ```javascript
   // Wrong: Assuming 'amount' works everywhere
   amount: payload.payment?.expected_amount
   
   // Right: Map to specific field per operation
   total_amount: payload.payment?.expected_amount  // for payments
   total: payload.order?.expected_amount          // for orders
   ```

2. **Missing Context**
   - Same concept may have different field names in different APIs
   - Always check the specific endpoint documentation

3. **Direct Pass-through**
   ```javascript
   // Wrong: Direct pass-through
   requestBody = payload.payment
   
   // Right: Explicit mapping
   requestBody = {
     order_id: payload.payment?.order_id,
     total_amount: payload.payment?.expected_amount,
     // ... explicit mappings
   }
   ```

## Future Considerations

### If Pivota Infra Standardizes

If Pivota Infra decides to standardize field names:
1. Gateway can gradually adopt new names
2. Support both old and new during transition
3. Version the gateway API for breaking changes

### Adding New Operations

When adding new operations:
1. Check existing Pivota endpoints first
2. Document field mappings immediately
3. Prefer consistency in gateway layer
4. Update this guide

## Appendix: Current Mappings

See `docs/pivota-api-mapping.md` for complete current mappings.

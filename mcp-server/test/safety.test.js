import assert from "node:assert/strict";
import test from "node:test";

import { operationMap } from "../src/operationMap.js";
import {
  assertAllowedOperation,
  prepareToolCall,
  redact,
  requiresIdempotency
} from "../src/safety.js";

test("operationMap exposes the contract tool operation allow-lists", () => {
  assert.deepEqual(operationMap.pivota_search, [
    "find_products",
    "find_products_multi",
    "get_discovery_feed",
    "get_product_detail",
    "offers.resolve",
    "track_product_click"
  ]);
  assert.deepEqual(operationMap.pivota_quote, ["preview_quote"]);
  assert.deepEqual(operationMap.pivota_create_order, ["create_order"]);
  assert.deepEqual(operationMap.pivota_pay, ["submit_payment"]);
  assert.deepEqual(operationMap.pivota_orders, [
    "get_order_status",
    "request_after_sales"
  ]);
});

test("assertAllowedOperation rejects operation/tool mismatches", () => {
  assert.doesNotThrow(() =>
    assertAllowedOperation("pivota_search", "find_products")
  );

  assert.throws(
    () => assertAllowedOperation("pivota_pay", "create_order"),
    {
      code: "OPERATION_NOT_ALLOWED"
    }
  );
});

test("prepareToolCall leaves read-only discovery calls without idempotency", () => {
  const prepared = prepareToolCall("pivota_search", {
    operation: "find_products",
    payload: {
      search: {
        query: "running shoes",
        page: 1
      }
    }
  });

  assert.equal(prepared.operation, "find_products");
  assert.equal(prepared.idempotencyKey, undefined);
  assert.equal(prepared.idempotencyKeyGenerated, false);
  assert.equal(prepared.payload.idempotency_key, undefined);
});

test("prepareToolCall rejects missing idempotency for writes", () => {
  const cases = [
    {
      tool: "pivota_create_order",
      operation: "create_order",
      payload: {
        order: {
          quote_id: "quote_123",
          shipping_address: {
            country: "US",
            city: "New York",
            address_line1: "1 Main St",
            recipient_name: "Ada Lovelace"
          }
        }
      }
    },
    {
      tool: "pivota_pay",
      operation: "submit_payment",
      payload: {
        confirmation_token: "ct_123",
        payment: {
          order_id: "order_123",
          expected_amount: 42,
          currency: "USD"
        }
      }
    },
    {
      tool: "pivota_orders",
      operation: "request_after_sales",
      payload: {
        status: {
          order_id: "order_123",
          requested_action: "refund",
          reason: "Wrong size"
        }
      }
    }
  ];

  for (const { tool, operation, payload } of cases) {
    assert.throws(
      () => prepareToolCall(tool, { operation, payload }),
      {
        code: "IDEMPOTENCY_KEY_REQUIRED"
      }
    );
  }
});

test("prepareToolCall rejects blank idempotency for writes", () => {
  assert.throws(
    () =>
      prepareToolCall("pivota_create_order", {
        operation: "create_order",
        payload: {
          idempotency_key: "   ",
          order: {
            quote_id: "quote_123"
          }
        }
      }),
    {
      code: "IDEMPOTENCY_KEY_REQUIRED"
    }
  );
});

test("prepareToolCall preserves caller-supplied stable idempotency for write calls", () => {
  const prepared = prepareToolCall(
    "pivota_create_order",
    {
      operation: "create_order",
      payload: {
        idempotency_key: "caller-key-1234",
        order: {
          quote_id: "quote_123"
        }
      }
    },
    {
      idempotencyKeyFactory: () => {
        throw new Error("idempotency factory must not run for writes");
      }
    }
  );

  assert.equal(prepared.idempotencyKey, "caller-key-1234");
  assert.equal(prepared.payload.idempotency_key, "caller-key-1234");
  assert.equal(prepared.idempotencyKeyGenerated, false);
});

test("prepareToolCall rejects create_order without a locked quote_id", () => {
  assert.throws(
    () =>
      prepareToolCall("pivota_create_order", {
        operation: "create_order",
        payload: {
          idempotency_key: "caller-key-1234",
          order: {}
        }
      }),
    {
      code: "QUOTE_ID_REQUIRED"
    }
  );
});

test("prepareToolCall rejects malformed idempotency keys on writes", () => {
  assert.equal(requiresIdempotency("submit_payment"), true);
  assert.equal(requiresIdempotency("get_order_status"), false);

  assert.throws(
    () =>
      prepareToolCall("pivota_create_order", {
        operation: "create_order",
        payload: {
          idempotency_key: "short",
          order: {
            quote_id: "quote_123"
          }
        }
      }),
    {
      code: "INVALID_IDEMPOTENCY_KEY"
    }
  );
});

test("prepareToolCall requires confirmation_token for submit_payment", () => {
  assert.throws(
    () =>
      prepareToolCall("pivota_pay", {
        operation: "submit_payment",
        payload: {
          idempotency_key: "caller-key-1234",
          payment: {
            order_id: "order_123",
            expected_amount: 42,
            currency: "USD"
          }
        }
      }),
    {
      code: "CONFIRMATION_TOKEN_REQUIRED"
    }
  );
});

test("prepareToolCall requires payment.order_id for submit_payment", () => {
  assert.throws(
    () =>
      prepareToolCall("pivota_pay", {
        operation: "submit_payment",
        payload: {
          idempotency_key: "caller-key-1234",
          confirmation_token: "ct_123",
          payment: {
            expected_amount: 42,
            currency: "USD"
          }
        }
      }),
    {
      code: "PAYMENT_ORDER_ID_REQUIRED"
    }
  );
});

test("prepareToolCall preserves caller idempotency for submit_payment without changing payment", () => {
  const prepared = prepareToolCall("pivota_pay", {
    operation: "submit_payment",
    payload: {
      idempotency_key: "caller-payment-1234",
      confirmation_token: "ct_123",
      ap2_state: {
        opaque: true
      },
      payment: {
        order_id: "order_123",
        expected_amount: 42,
        currency: "USD",
        payment_method_hint: "card"
      }
    }
  });

  assert.equal(prepared.idempotencyKey, "caller-payment-1234");
  assert.equal(prepared.payload.idempotency_key, "caller-payment-1234");
  assert.deepEqual(prepared.payload.payment, {
    order_id: "order_123",
    expected_amount: 42,
    currency: "USD",
    payment_method_hint: "card"
  });
});

test("prepareToolCall preserves caller idempotency for request_after_sales", () => {
  const prepared = prepareToolCall("pivota_orders", {
    operation: "request_after_sales",
    payload: {
      idempotency_key: "caller-after-sales-1234",
      status: {
        order_id: "order_123",
        requested_action: "refund",
        reason: "Wrong size"
      }
    }
  });

  assert.equal(prepared.idempotencyKey, "caller-after-sales-1234");
  assert.equal(prepared.payload.idempotency_key, "caller-after-sales-1234");
});

test("redact removes sensitive payment and token data without mutating input", () => {
  const input = {
    operation: "submit_payment",
    payload: {
      confirmation_token: "ct_secret",
      ap2_state: {
        mandate_id: "mandate_secret"
      },
      payment: {
        order_id: "order_123",
        expected_amount: 42,
        currency: "USD",
        card_token: "card_secret"
      },
      nested: {
        access_token: "access_secret",
        acp_state: {
          session_id: "acp_ok"
        }
      }
    }
  };

  const redacted = redact(input);

  assert.equal(redacted.payload.confirmation_token, "[REDACTED]");
  assert.equal(redacted.payload.ap2_state, "[REDACTED]");
  assert.equal(redacted.payload.payment, "[REDACTED_PAYMENT_BODY]");
  assert.equal(redacted.payload.nested.access_token, "[REDACTED]");
  assert.deepEqual(redacted.payload.nested.acp_state, {
    session_id: "acp_ok"
  });

  assert.equal(input.payload.confirmation_token, "ct_secret");
  assert.deepEqual(input.payload.payment, {
    order_id: "order_123",
    expected_amount: 42,
    currency: "USD",
    card_token: "card_secret"
  });
});

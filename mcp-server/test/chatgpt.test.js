import assert from "node:assert/strict";
import test from "node:test";

import {
  paymentResultComponent,
  quoteCardComponent
} from "../unwired/chatgpt/components.js";
import {
  assertConfirmedBeforePay,
  nextStep
} from "../unwired/chatgpt/checkoutFlow.js";
import {
  fromAcpEvent,
  toAcpCheckout
} from "../unwired/chatgpt/acpMapping.js";

test("quoteCardComponent includes locked total, expiry, and confirm action with quote_id", () => {
  const component = quoteCardComponent({
    quote_id: "quote_123",
    expires_at: "2026-06-01T12:00:00Z",
    currency: "USD",
    merchant_of_record: "Pivota Demo",
    locked_totals: {
      subtotal: 40,
      tax: 3,
      shipping: 2,
      total: 45
    },
    line_items: [{ product_id: "prod_1", quantity: 1 }]
  });

  assert.equal(component.type, "component");
  assert.equal(component.component, "quote_card");
  assert.equal(component.props.locked_totals.total, 45);
  assert.equal(component.props.expires_at, "2026-06-01T12:00:00Z");
  assert.deepEqual(component.props.actions, [
    {
      type: "confirm",
      label: "Confirm",
      action: "confirm_quote",
      quote_id: "quote_123",
      payload: { quote_id: "quote_123" }
    }
  ]);
});

test("paymentResultComponent surfaces requires_action fields verbatim", () => {
  const requiresAction = {
    redirect_url: "https://payments.example.test/3ds",
    instructions: "Complete authentication in the bank window.",
    qr_code: "data:image/png;base64,abc123"
  };

  const component = paymentResultComponent({
    status: "requires_action",
    order_id: "order_123",
    currency: "USD",
    requires_action: requiresAction
  });

  assert.equal(component.component, "payment_result");
  assert.deepEqual(component.props.requires_action, requiresAction);
});

test("checkoutFlow refuses payment before quote confirmation", () => {
  const state = {
    quote: { quote_id: "quote_123" },
    order: { order_id: "order_123" }
  };

  assert.deepEqual(nextStep(state), {
    stage: "confirm",
    tool: null,
    operation: null,
    requiresConfirmationBeforePay: true,
    userConfirmationRequired: true,
    context: {
      quote_id: "quote_123",
      order_id: "order_123"
    }
  });

  assert.throws(() => assertConfirmedBeforePay(state), {
    name: "PivotaCommerceError",
    code: "CONFIRMATION_REQUIRED"
  });
});

test("checkoutFlow refuses payment when state only has a boolean confirmation flag", () => {
  const state = {
    confirmed: true,
    quote_confirmed: true,
    quote: { quote_id: "quote_123" },
    order: { order_id: "order_123" }
  };

  assert.deepEqual(nextStep(state), {
    stage: "confirm",
    tool: null,
    operation: null,
    requiresConfirmationBeforePay: true,
    userConfirmationRequired: true,
    context: {
      quote_id: "quote_123",
      order_id: "order_123"
    }
  });

  assert.throws(() => assertConfirmedBeforePay(state), {
    name: "PivotaCommerceError",
    code: "CONFIRMATION_REQUIRED"
  });
});

test("checkoutFlow allows payment when a host-minted confirmation token is present", () => {
  const state = {
    confirmation_token: "ct_host_123",
    quote: { quote_id: "quote_123" },
    order: { order_id: "order_123" }
  };

  assert.deepEqual(nextStep(state), {
    stage: "pay",
    tool: "pivota_pay",
    operation: "submit_payment",
    requiresConfirmationBeforePay: false,
    userConfirmationRequired: false,
    context: {
      quote_id: "quote_123",
      order_id: "order_123"
    }
  });

  assert.equal(assertConfirmedBeforePay(state), true);
});

test("acpMapping round-trips a checkout while preserving opaque ACP state", () => {
  const quote = {
    quote_id: "quote_123",
    expires_at: "2026-06-01T12:00:00Z",
    currency: "USD",
    merchant_of_record: "Pivota Demo",
    locked_totals: {
      subtotal: 40,
      tax: 3,
      shipping: 2,
      total: 45
    },
    line_items: [{ product_id: "prod_1", quantity: 1 }],
    acp_state: { opaque: { session: "acp_sess_1" } }
  };
  const order = {
    order_id: "order_123",
    quote_id: "quote_123",
    amount_total: 45,
    currency: "USD",
    acp_state: { opaque: { session: "acp_sess_1" } }
  };

  const acpCheckout = toAcpCheckout(quote, order);
  const canonical = fromAcpEvent({ checkout: acpCheckout });

  assert.equal(acpCheckout.type, "checkout");
  assert.equal(acpCheckout.quote.locked_totals.total, 45);
  assert.equal(acpCheckout.acp_state.opaque.session, "acp_sess_1");
  assert.deepEqual(canonical.quote, quote);
  assert.deepEqual(canonical.order, order);
  assert.deepEqual(canonical.acp_state, order.acp_state);
});

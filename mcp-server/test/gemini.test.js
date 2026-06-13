import assert from "node:assert/strict";
import test from "node:test";

import {
  geminiCallToCommerceTool,
  geminiCallToInvoke,
  invokeResultToGeminiResponse
} from "../gemini/adapter.js";
import { createCommerceToolSurface } from "../src/commerceToolSurface.js";
import {
  GEMINI_FUNCTION_DECLARATIONS,
  toGeminiSchema
} from "../gemini/functionDeclarations.js";

const CLAIMS = Object.freeze({
  iss: "https://idp.example.test",
  sub: "gemini-user-123"
});

test("toGeminiSchema uppercases types and strips additionalProperties/oneOf", () => {
  const converted = toGeminiSchema({
    type: "object",
    additionalProperties: false,
    properties: {
      query: {
        type: "string",
        oneOf: [{ const: "ignored" }]
      },
      price: {
        type: "number"
      },
      quantity: {
        type: "integer"
      },
      in_stock_only: {
        type: "boolean"
      },
      tags: {
        type: "array",
        items: {
          type: "string",
          additionalProperties: true
        }
      }
    }
  });

  assert.equal(converted.type, "OBJECT");
  assert.equal(converted.additionalProperties, undefined);
  assert.equal(converted.properties.query.type, "STRING");
  assert.equal(converted.properties.query.oneOf, undefined);
  assert.equal(converted.properties.price.type, "NUMBER");
  assert.equal(converted.properties.quantity.type, "INTEGER");
  assert.equal(converted.properties.in_stock_only.type, "BOOLEAN");
  assert.equal(converted.properties.tags.type, "ARRAY");
  assert.equal(converted.properties.tags.items.type, "STRING");
  assert.equal(converted.properties.tags.items.additionalProperties, undefined);
});

test("GEMINI_FUNCTION_DECLARATIONS exposes canonical safe-checkout tools, not legacy direct money tools", () => {
  assert.deepEqual(
    GEMINI_FUNCTION_DECLARATIONS.map((declaration) => declaration.name),
    [
      "search_catalog",
      "get_product",
      "get_alternatives",
      "get_offers",
      "create_checkout_session",
      "update_checkout_session",
      "get_checkout_session",
      "complete_checkout_session",
      "create_payment_link",
      "cancel_checkout_session",
      "get_order",
      "request_after_sales"
    ]
  );

  assert.equal(GEMINI_FUNCTION_DECLARATIONS[0].parameters.type, "OBJECT");
  assert.ok(!GEMINI_FUNCTION_DECLARATIONS.some((d) => d.name === "pivota_pay"));
  const complete = GEMINI_FUNCTION_DECLARATIONS.find((d) => d.name === "complete_checkout_session");
  assert.equal(complete.parameters.properties.payment_authorization.type, "OBJECT");
  assert.equal(complete.parameters.properties.operation, undefined);
  assert.equal(complete.parameters.properties.payload, undefined);
});

test("geminiCallToCommerceTool executes the canonical surface with verified session binding", async () => {
  let seen;
  const surface = createCommerceToolSurface({
    async execute(opId, params, ctx) {
      seen = { opId, params, ctx };
      return { session_id: "quote_gemini", status: "ready_for_payment" };
    }
  });

  const part = await geminiCallToCommerceTool(
    {
      name: "create_checkout_session",
      args: {
        idempotency_key: "idem-gemini-safe-001",
        user_ref: "user_model",
        quote: {
          merchant_id: "m1",
          items: [{ product_id: "p1", quantity: 1, amount: 999999 }]
        }
      }
    },
    surface,
    { user_ref: "user_verified", acp_session_id: "sess_gemini" }
  );

  assert.equal(part.functionResponse.name, "create_checkout_session");
  assert.equal(part.functionResponse.response.session_id, "quote_gemini");
  assert.deepEqual(seen.ctx, { user_ref: "user_verified", acp_session_id: "sess_gemini" });
  assert.equal(seen.params.user_ref, undefined);
  assert.equal(seen.params.quote.items[0].amount, undefined);
});

test("geminiCallToInvoke rejects operations not allowed for the tool", () => {
  assert.throws(
    () =>
      geminiCallToInvoke({
        name: "pivota_pay",
        args: {
          operation: "create_order",
          payload: {}
        }
      }),
    {
      code: "OPERATION_NOT_ALLOWED"
    }
  );
});

test("geminiCallToInvoke binds trusted user_ref and preserves a HOST idempotency key (no minting)", () => {
  const envelope = geminiCallToInvoke(
    {
      name: "pivota_create_order",
      args: {
        operation: "create_order",
        payload: {
          idempotency_key: "gemini-create-key-1234", // host-supplied; secure boundary never mints
          user_ref: "usr_model_supplied_value",      // must be stripped + replaced
          order: {
            quote_id: "quote_123",
            shipping_address: {
              country: "US",
              city: "New York",
              postal_code: "10001",
              address_line1: "1 Main St",
              recipient_name: "Ada Lovelace"
            }
          }
        }
      }
    },
    { deriveUserRefFromClaims: CLAIMS }
  );

  assert.equal(envelope.operation, "create_order");
  assert.equal(envelope.payload.idempotency_key, "gemini-create-key-1234");
  assert.match(envelope.payload.user_ref, /^usr_[A-Za-z0-9_-]+$/);
  assert.notEqual(envelope.payload.user_ref, "usr_model_supplied_value");
});

test("geminiCallToInvoke ignores non-derived direct user_ref in favor of verified claims", () => {
  const envelope = geminiCallToInvoke(
    {
      name: "pivota_create_order",
      args: {
        operation: "create_order",
        payload: {
          idempotency_key: "gemini-create-key-5678",
          order: {
            quote_id: "quote_123",
            shipping_address: {
              country: "US",
              city: "New York",
              postal_code: "10001",
              address_line1: "1 Main St",
              recipient_name: "Ada Lovelace"
            }
          }
        }
      }
    },
    { user_ref: "model-supplied-user", deriveUserRefFromClaims: CLAIMS }
  );

  assert.match(envelope.payload.user_ref, /^usr_[A-Za-z0-9_-]+$/);
  assert.notEqual(envelope.payload.user_ref, "model-supplied-user");
});

test("FWBC-P1: verified claims take precedence over a usr_-shaped direct user_ref (no injection)", () => {
  const envelope = geminiCallToInvoke(
    {
      name: "pivota_create_order",
      args: {
        operation: "create_order",
        payload: {
          idempotency_key: "gemini-prec-key-1",
          order: {
            quote_id: "quote_123",
            shipping_address: { country: "US", city: "NY", postal_code: "10001", address_line1: "1", recipient_name: "A" }
          }
        }
      }
    },
    // attacker forwards a usr_-shaped direct value alongside REAL claims — claims must win
    { user_ref: "usr_attacker_supplied", claims: CLAIMS }
  );
  assert.match(envelope.payload.user_ref, /^usr_[A-Za-z0-9_-]+$/);
  assert.notEqual(envelope.payload.user_ref, "usr_attacker_supplied");
});

test("geminiCallToInvoke (Codex P1-3): a write with NO idempotency key is rejected, not minted", () => {
  assert.throws(
    () => geminiCallToInvoke(
      {
        name: "pivota_pay",
        args: {
          operation: "submit_payment",
          payload: {
            confirmation_token: "ct_123",
            payment: { order_id: "order_123", expected_amount: 42, currency: "USD" }
          }
        }
      },
      { deriveUserRefFromClaims: CLAIMS }
    ),
    (e) => e.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
});

test("geminiCallToInvoke routes submit_payment through validateCanonical (rejects extra money field)", () => {
  assert.throws(
    () => geminiCallToInvoke(
      {
        name: "pivota_pay",
        args: {
          operation: "submit_payment",
          payload: {
            idempotency_key: "gemini-pay-key-1234",
            confirmation_token: "ct_123",
            payment: { order_id: "order_123", expected_amount: 42, currency: "USD", quote_id: "q_evil" }
          }
        }
      },
      { deriveUserRefFromClaims: CLAIMS }
    ),
    (e) => e.code === "PRICE_CHANGED"
  );
});

test("geminiCallToInvoke rejects submit_payment without confirmation_token via shared guard", () => {
  assert.throws(
    () =>
      geminiCallToInvoke(
        {
          name: "pivota_pay",
          args: {
            operation: "submit_payment",
            payload: {
              payment: {
                order_id: "order_123",
                expected_amount: 42,
                currency: "USD"
              }
            }
          }
        },
        {
          deriveUserRefFromClaims: CLAIMS
        }
      ),
    {
      code: "CONFIRMATION_TOKEN_REQUIRED"
    }
  );
});

test("invokeResultToGeminiResponse returns a functionResponse part with requires_action verbatim", () => {
  const requiresAction = Object.freeze({
    redirect_url: "https://payments.example.test/3ds",
    instructions: "Complete bank authentication.",
    qr_code: "data:image/png;base64,abc123"
  });

  const part = invokeResultToGeminiResponse("pivota_pay", {
    payment_status: "requires_action",
    requires_action: requiresAction
  });

  assert.deepEqual(part, {
    functionResponse: {
      name: "pivota_pay",
      response: {
        payment_status: "requires_action",
        requires_action: requiresAction
      }
    }
  });
});

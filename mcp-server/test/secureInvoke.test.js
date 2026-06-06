// Fix-Wave A tests — the secure adapter boundary (X-P0-1 identity, X-P2-4 strict validation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSecureEnvelope, resolveTrustedUserRef, IdentityRequiredError } from "../src/secureInvoke.js";

const CLAIMS = { iss: "https://issuer.example", sub: "subject-123" };
const ADDR = { country: "US", city: "NY", postal_code: "10001", address_line1: "1", recipient_name: "A" };

// X-P0-1: writes require trusted identity.
test("X-P0-1: create_order without trusted identity is refused", () => {
  assert.throws(
    () => buildSecureEnvelope("pivota_create_order", {
      operation: "create_order",
      payload: { idempotency_key: "host-key-12345", order: { quote_id: "q1", shipping_address: ADDR } },
    }, {}),
    (e) => e instanceof IdentityRequiredError && e.code === "USER_AUTH_REQUIRED",
  );
});

test("X-P0-1: a model-supplied payload.user_ref is stripped and replaced by the trusted one", () => {
  const env = buildSecureEnvelope("pivota_create_order", {
    operation: "create_order",
    payload: {
      idempotency_key: "host-key-12345",
      user_ref: "usr_ATTACKER",            // model-supplied — must be dropped
      order: { quote_id: "q1", shipping_address: ADDR },
    },
  }, { claims: CLAIMS });
  const expected = resolveTrustedUserRef({ claims: CLAIMS });
  assert.equal(env.payload.user_ref, expected);
  assert.notEqual(env.payload.user_ref, "usr_ATTACKER");
});

test("X-P0-1: a read op does NOT require identity", () => {
  const env = buildSecureEnvelope("pivota_search", {
    operation: "find_products",
    payload: { search: { query: "shoes" } },
  }, {});
  assert.equal(env.operation, "find_products");
});

// X-P2-4: the kernel's strict validator runs at the adapter boundary.
test("X-P2-4: an extra money field on submit_payment is rejected at the boundary", () => {
  assert.throws(
    () => buildSecureEnvelope("pivota_pay", {
      operation: "submit_payment",
      payload: {
        idempotency_key: "host-key-12345",
        confirmation_token: "ct_abc",
        payment: { order_id: "o1", expected_amount: 1, currency: "USD", quote_id: "q_evil" },
      },
    }, { claims: CLAIMS }),
    (e) => e.code === "PRICE_CHANGED",
  );
});

test("X-P2-4: submit_payment without a confirmation_token is rejected at the boundary", () => {
  // Two layers may catch this: the adapter guard (CONFIRMATION_TOKEN_REQUIRED) or the kernel
  // validator (CONFIRMATION_REQUIRED). Either is a correct refusal — what matters is it never passes.
  assert.throws(
    () => buildSecureEnvelope("pivota_pay", {
      operation: "submit_payment",
      payload: {
        idempotency_key: "host-key-12345",
        payment: { order_id: "o1", expected_amount: 1, currency: "USD" },
      },
    }, { claims: CLAIMS }),
    (e) => e.code === "CONFIRMATION_REQUIRED" || e.code === "CONFIRMATION_TOKEN_REQUIRED",
  );
});

test("resolveTrustedUserRef: derives a stable usr_ from claims, rejects missing sub/iss", () => {
  const ref = resolveTrustedUserRef({ claims: CLAIMS });
  assert.match(ref, /^usr_/);
  assert.equal(resolveTrustedUserRef({ claims: CLAIMS }), ref); // stable
  assert.throws(() => resolveTrustedUserRef({ claims: { sub: "only-sub" } }));
  assert.equal(resolveTrustedUserRef({}), undefined);
});

test("a happy-path create_order with trusted claims yields a valid envelope", () => {
  const env = buildSecureEnvelope("pivota_create_order", {
    operation: "create_order",
    payload: { idempotency_key: "host-key-12345", order: { quote_id: "q1", shipping_address: ADDR } },
  }, { claims: CLAIMS });
  assert.equal(env.operation, "create_order");
  assert.match(env.payload.user_ref, /^usr_/);
  assert.equal(env.payload.order.quote_id, "q1");
});

// "The merchant is temporarily unreachable. Please try again shortly." was returned for a PERSISTENT data
// condition: a product id with no servable offer behind it. Agents chaining search -> get_product read that
// as transient and retried forever; operators read it as an outage. These pin the honest classification.

import test from "node:test";
import assert from "node:assert/strict";

import { ERROR_CATALOG, PivotaCommerceError, isPivotaErrorCode } from "../../safety-kernel/src/errors.js";
import { toToolError } from "../src/commerceToolSurface.js";

test("NO_MERCHANT_OFFER is a real code and is NOT retriable", () => {
  assert.ok(isPivotaErrorCode("NO_MERCHANT_OFFER"));
  assert.equal(ERROR_CATALOG.NO_MERCHANT_OFFER.retriable, false);
});

test("its message does not promise a retry", () => {
  const msg = ERROR_CATALOG.NO_MERCHANT_OFFER.userMessage.toLowerCase();
  assert.ok(!msg.includes("try again"), "must not tell an agent to try again");
  assert.ok(!msg.includes("temporarily"), "must not describe a transient outage");
});

test("it is distinct from MERCHANT_UNAVAILABLE, which stays retriable", () => {
  assert.equal(ERROR_CATALOG.MERCHANT_UNAVAILABLE.retriable, true);
  assert.notEqual(
    ERROR_CATALOG.NO_MERCHANT_OFFER.userMessage,
    ERROR_CATALOG.MERCHANT_UNAVAILABLE.userMessage,
  );
});

test("the MCP tool error body carries the retry classification, not just a code", () => {
  const body = JSON.parse(toToolError(new PivotaCommerceError("NO_MERCHANT_OFFER", {})).content[0].text);
  assert.equal(body.error.code, "NO_MERCHANT_OFFER");
  assert.equal(body.error.retriable, false, "an agent must be able to see this is terminal");

  const transient = JSON.parse(toToolError(new PivotaCommerceError("MERCHANT_UNAVAILABLE", {})).content[0].text);
  assert.equal(transient.error.retriable, true);
});

test("a bare 404 is terminal on READ ops but stays a retriable outage on money ops", async () => {
  // The money ops share this upstream. A 404 there is far more likely to be a missing or mid-deploy backend
  // route than a statement about the product, and telling a checkout agent "never retry" during a transient
  // blip is the mirror image of the bug this change fixes.
  const { createHttpBackendUpstream } = await import("../../safety-kernel/src/protocol/productionWiring.js");
  const upstream = createHttpBackendUpstream({
    baseUrl: "https://example.test",
    authToken: "tok",
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  const codeFor = async (op) => {
    try {
      await upstream(op, {});
      return null;
    } catch (e) {
      return { code: e.code, retriable: e.retriable };
    }
  };

  for (const op of ["get_product_detail", "find_products", "find_products_multi"]) {
    assert.deepEqual(await codeFor(op), { code: "NO_MERCHANT_OFFER", retriable: false }, op);
  }
  for (const op of ["preview_quote", "create_order", "submit_payment"]) {
    assert.deepEqual(await codeFor(op), { code: "MERCHANT_UNAVAILABLE", retriable: true }, op);
  }
});

test("errors that declare no retry classification keep their exact previous body", () => {
  const body = JSON.parse(toToolError(new Error("boom")).content[0].text);
  assert.deepEqual(body, {
    error: { code: "UNEXPECTED_ERROR", message: "The request could not be completed." },
  });
});

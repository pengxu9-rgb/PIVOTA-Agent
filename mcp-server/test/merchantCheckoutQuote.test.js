import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMerchantCheckoutQuoteService,
  merchantCheckoutQuoteAllowedSellers,
  merchantCheckoutQuoteEnabled,
} from "../src/merchantCheckoutQuote.js";

const sellerHost = "romandbeauty.com";
const endpoint = "https://xyf8uj-w2.myshopify.com/api/ucp/mcp";
const sessionId = "gid://shopify/Checkout/test-session?key=test-secret";
const shippingAllocation = '$.totals[?@.type == "fulfillment"]';
const env = {
  AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED: "1",
  AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON: JSON.stringify({ [sellerHost]: endpoint }),
};
const request = {
  sellerHost,
  market: "US",
  expectedCurrency: "USD",
  lineItems: [{ variantId: "41341731438667", quantity: 2 }, { variantId: "41341731635275", quantity: 1 }],
  shippingAddress: {
    name: "Test Buyer",
    address_line1: "11 Test Street",
    city: "San Francisco",
    state: "CA",
    postal_code: "94105",
    country: "US",
    phone: "4155550130",
  },
};
const checkoutAt = Date.parse("2026-11-14T10:00:00Z");

function rpc(payload, isError = false) {
  return { status: 200, response: { result: { isError, structuredContent: { checkout: payload } } } };
}

function checkoutFixture(overrides = {}) {
  const lines = request.lineItems.map((line, index) => ({
    id: `gid://shopify/CartLine/fixture-line-${index + 1}`,
    item: { id: `gid://shopify/ProductVariant/${line.variantId}`, price: 1400 },
    quantity: line.quantity,
  }));
  return {
    id: sessionId,
    continue_url: "https://romandbeauty.com/checkout/private",
    status: "incomplete",
    currency: "USD",
    expires_at: "2026-11-14T10:10:00Z",
    line_items: lines,
    totals: [
      { type: "subtotal", amount: 4200 },
      { type: "discount", amount: -500 },
      { type: "fulfillment", amount: 500 },
      { type: "tax", amount: 363 },
      { type: "total", amount: 4563 },
    ],
    fulfillment: {
      methods: [{
        type: "shipping",
        line_item_ids: lines.map(line => line.id),
        selected_destination_id: "fixture-address",
        destinations: [{
          id: "fixture-address", street_address: request.shippingAddress.address_line1,
          address_locality: request.shippingAddress.city, address_region: request.shippingAddress.state,
          postal_code: request.shippingAddress.postal_code, address_country: request.shippingAddress.country,
        }],
        groups: [{
          line_item_ids: lines.map(line => line.id),
          selected_option_id: "priority", options: [{ id: "priority", totals: [{ type: "total", amount: 500 }] }],
        }],
      }],
    },
    discounts: { codes: [], applied: [{
      automatic: true, amount: 500, allocations: [{ path: shippingAllocation, amount: 500 }],
    }] },
    messages: [{ code: "buyer_identity_contact_method_required", type: "error", severity: "recoverable" }],
    ...overrides,
  };
}

function merchantFixture({
  discoveredEndpoint = endpoint, created = checkoutFixture(), readback = checkoutFixture(),
  tools = ["create_checkout", "get_checkout", "cancel_checkout"], cancellation = "canceled",
  transport = "signed", isError = false,
} = {}) {
  const calls = [];
  return {
    calls,
    tier: transport,
    async discoverEndpoint(url) {
      calls.push(["discover", url]);
      return { mcpEndpoint: discoveredEndpoint };
    },
    async listTools(url) {
      calls.push(["tools/list", url]);
      const fulfillment = {
        properties: { methods: { items: { properties: { destinations: {}, selected_destination_id: {} } } } },
      };
      return { response: { result: { tools: tools.map(name => ({
        name, inputSchema: { properties: { checkout: { properties: { fulfillment, discounts: {} } } } },
      })) } } };
    },
    async createCheckout(url, input) {
      calls.push(["create_checkout", url, input]);
      return rpc(created, isError);
    },
    async callTool(url, operation, args) {
      calls.push([operation, url, args]);
      assert.equal(args.id, sessionId);
      assert.ok(operation === "get_checkout" || operation === "cancel_checkout");
      return rpc(operation === "get_checkout" ? readback : { id: sessionId, status: cancellation });
    },
  };
}

function createService(client, options = {}) {
  return createMerchantCheckoutQuoteService({ client, env, clock: () => checkoutAt, ...options });
}

test("default off and invalid shop config perform no merchant calls", async () => {
  const client = merchantFixture();
  assert.equal(merchantCheckoutQuoteEnabled({}), false);
  assert.equal((await createService(client, { env: {} }).quote(request)).reason, "merchant_checkout_quote_disabled");
  const malformed = {
    ...env,
    AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON: JSON.stringify({ [sellerHost]: endpoint.replace(".com/", ".com.evil.test/") }),
  };
  assert.deepEqual(merchantCheckoutQuoteAllowedSellers(malformed), {});
  assert.equal((await createService(client, { env: malformed }).quote(request)).reason, "merchant_checkout_quote_seller_unavailable");
  assert.deepEqual(client.calls, []);
});

test("native chosen variants, address, merchant and currency are required before merchant I/O", async () => {
  for (const overrides of [
    { sellerHost: "other-shop.example" },
    { expectedCurrency: "CAD" },
    { shippingAddress: { ...request.shippingAddress, country: "CA" } },
    { shippingAddress: { ...request.shippingAddress, name: null } },
    { lineItems: [{ variantId: "bad-variant", quantity: 1 }] },
    { lineItems: [request.lineItems[0], request.lineItems[0]] },
    { lineItems: [{ variantId: request.lineItems[0].variantId, quantity: "1" }] },
    { discountCodes: ["first", "second"] },
  ]) {
    const client = merchantFixture();
    const result = await createService(client).quote({ ...request, ...overrides });
    assert.equal(result.state, "checkout_unverified");
    assert.deepEqual(client.calls, []);
  }
});

test("signed tier, tenant profile and negotiated tool safety are independent gates", async () => {
  for (const options of [
    { transport: "anonymous" },
    { discoveredEndpoint: "https://unapproved.myshopify.com/api/ucp/mcp" },
    { tools: ["create_checkout", "get_checkout"] },
  ]) {
    const client = merchantFixture(options);
    const result = await createService(client).quote(request);
    assert.equal(result.state, "checkout_unverified");
    assert.ok(!client.calls.some(([op]) => op === "create_checkout"));
  }
});

test("temporary Shopify discovery failure is retryable before a create attempt", async () => {
  for (const [stage, details] of [["discoverEndpoint", { status: 503 }], ["listTools", { status: 429 }]]) {
    const client = merchantFixture();
    client[stage] = async () => details;
    await assert.rejects(createService(client).quote(request, {
      async beforeCreate() { assert.fail("no checkout creation is permitted after failed discovery"); },
    }), { code: "MERCHANT_UNAVAILABLE", retriable: true });
  }
});

test("Shopify quote verifies exact quantities, tax and allocation and hides all session identifiers", async () => {
  const readback = checkoutFixture();
  readback.line_items.reverse();
  readback.totals.reverse();
  readback.fulfillment.methods[0].groups[0].line_item_ids.reverse();
  const client = merchantFixture({ readback });
  const result = await createService(client).quote(request);
  assert.equal(result.state, "verified_quote_with_buyer_requirements");
  assert.equal(result.verifiedQuotedTotalMinor, 4563);
  assert.equal(result.payableMinor, null);
  assert.equal(result.checkoutCancelled, true);
  assert.equal(result.merchantExpiresAt, "2026-11-14T10:10:00.000Z");
  assert.deepEqual(result.buyerRequirements, ["buyer_identity_contact_method_required"]);
  assert.deepEqual(result.discounts, {
    codeOutcome: "not_requested",
    applied: [{ automatic: true, amount: 500, allocations: [{ target: "shipping", amount: 500 }] }],
  });
  assert.deepEqual(client.calls.map(([op]) => op), ["discover", "tools/list", "create_checkout", "get_checkout", "cancel_checkout"]);
  const sent = client.calls[2][2];
  assert.equal(sent.checkout.fulfillment.methods[0].destinations[0].street_address, request.shippingAddress.address_line1);
  assert.deepEqual(sent.lineItems.map(line => line.quantity), [2, 1]);
  assert.doesNotMatch(JSON.stringify(sent), /payment|4155550130/);
  assert.doesNotMatch(JSON.stringify(result), /private|test-session|test-secret|fixture-line-|11 Test Street|priority/);
});

test("the shipping method and selected group each cover every distinct priced line in both snapshots", async () => {
  const reject = async (snapshot, label) => {
    for (const reply of ["created", "readback"]) {
      const result = await createService(merchantFixture({ [reply]: snapshot })).quote(request);
      assert.equal(result.state, "checkout_unverified", `${reply}: ${label}`);
      assert.equal(result.verifiedQuotedTotalMinor, null);
      assert.equal(result.checkoutCancelled, true);
    }
  };
  for (const target of ["shipping method", "selected group"]) {
    for (const [label, change] of [
      ["missing IDs", () => undefined],
      ["partial coverage", ([first]) => [first]],
      ["repeated ID", ([first]) => [first, first]],
      ["unknown ID", ([first]) => [first, "unknown-line"]],
    ]) {
      const snapshot = checkoutFixture();
      const method = snapshot.fulfillment.methods[0];
      const assignment = target === "shipping method" ? method : method.groups[0];
      assignment.line_item_ids = change(assignment.line_item_ids);
      await reject(snapshot, `${target} has ${label}`);
    }
  }
  for (const [label, invalidId] of [
    ["missing priced line ID", () => undefined],
    ["duplicate priced line ID", lines => lines[0].id],
  ]) {
    const snapshot = checkoutFixture();
    snapshot.line_items[1].id = invalidId(snapshot.line_items);
    await reject(snapshot, label);
  }
});

test("money drift, selected delivery drift, unknown checkout errors and elapsed expiry never produce a quote", async () => {
  const badTax = checkoutFixture();
  badTax.totals.find(row => row.type === "tax").amount += 1;
  badTax.totals.find(row => row.type === "total").amount += 1;
  const badDelivery = checkoutFixture();
  badDelivery.fulfillment.methods[0].groups[0].selected_option_id = "a-different-rate";
  badDelivery.fulfillment.methods[0].groups[0].options[0].id = "a-different-rate";
  const badAmount = checkoutFixture();
  badAmount.discounts.applied[0].amount = 501;
  const wrongVariant = checkoutFixture();
  wrongVariant.line_items[0].item.id = "gid://shopify/ProductVariant/12345678901234";
  for (const readback of [
    badTax, badDelivery, badAmount, wrongVariant, checkoutFixture({ currency: "CAD" }),
    checkoutFixture({ expires_at: "2026-11-14T09:59:00Z" }),
    checkoutFixture({ status: "incomplete", messages: [{ code: "stock_changed", type: "error", severity: "recoverable" }] }),
    checkoutFixture({ status: "ready_for_complete", messages: [{ code: "insufficient_inventory", type: "warning" }] }),
  ]) {
    const result = await createService(merchantFixture({ readback })).quote(request);
    assert.equal(result.state, "checkout_unverified");
    assert.equal(result.verifiedQuotedTotalMinor, null);
    assert.equal(result.checkoutCancelled, true);
  }
});

test("stock warning aliases suppress a quote with otherwise complete prices and shipping", async () => {
  for (const code of ["sold_out", "SOLD-OUT", "discontinued", "back-order", "pre order"]) {
    const readback = checkoutFixture({ status: "ready_for_complete", messages: [{ code, type: "warning" }] });
    const result = await createService(merchantFixture({ readback })).quote(request);
    assert.equal(result.state, "checkout_unverified", code);
    assert.equal(result.verifiedQuotedTotalMinor, null);
    assert.equal(result.checkoutCancelled, true);
  }
});

test("coupon rejection only counts when Shopify echoes and explicitly rejects that code", async () => {
  const response = checkoutFixture();
  response.discounts.codes = ["FIXTURE-QA"];
  response.messages.push({ code: "discount_code_invalid", type: "warning", path: "$.discounts.codes[0]" });
  const input = { ...request, discountCodes: ["fixture-qa"] };
  const client = merchantFixture({ created: response, readback: response });
  const allowed = await createService(client).quote(input);
  assert.equal(allowed.state, "verified_quote_with_buyer_requirements");
  assert.equal(allowed.discounts.codeOutcome, "rejected");
  assert.doesNotMatch(JSON.stringify(allowed), /fixture-qa/i);
  assert.deepEqual(client.calls[2][2].discountCodes, ["fixture-qa"]);
  const unknown = await createService(merchantFixture({ readback: response })).quote(input);
  assert.equal(unknown.verifiedQuotedTotalMinor, null);
});

test("unverified merchant cleanup suppresses the quote and a tool error never triggers another create", async () => {
  const transportError = merchantFixture({ isError: true });
  const errored = await createService(transportError).quote(request);
  assert.equal(errored.verifiedQuotedTotalMinor, null);
  assert.deepEqual(transportError.calls.map(([op]) => op), ["discover", "tools/list", "create_checkout", "cancel_checkout"]);
  const unableToCancel = await createService(merchantFixture({ cancellation: "incomplete" })).quote(request);
  assert.equal(unableToCancel.reason, "merchant_checkout_quote_cleanup_unverified");
  assert.equal(unableToCancel.verifiedQuotedTotalMinor, null);
  assert.equal(unableToCancel.checkoutCancelled, false);
});

test("an ambiguous create stays unknown after recording the signed request key", async () => {
  const client = merchantFixture();
  const checkpoint = [];
  client.createCheckout = async (_endpoint, _input, { idempotencyKey }) => {
    assert.deepEqual(checkpoint, [idempotencyKey]);
    assert.match(idempotencyKey, /^[a-f0-9-]{36}$/);
    throw new Error("response lost after dispatch");
  };
  const result = await createService(client).quote(request, {
    async beforeCreate(attempt) {
      assert.equal(attempt.sellerHost, sellerHost);
      assert.equal(attempt.endpoint, endpoint);
      checkpoint.push(attempt.createKey);
    },
    async checkoutCreated() { assert.fail("no Shopify checkout ID was received"); },
  });
  assert.equal(result.state, "checkout_outcome_unknown");
  assert.equal(result.verifiedQuotedTotalMinor, null);
  assert.deepEqual(client.calls.map(([op]) => op), ["discover", "tools/list"]);
});

test("ambiguous cancellation is confirmed by a matched read of the same checkout", async () => {
  const client = merchantFixture();
  let attempted = false;
  let recorded;
  client.callTool = async (_endpoint, operation, { id }, options) => {
    assert.equal(id, sessionId);
    if (operation === "cancel_checkout") {
      assert.deepEqual(recorded, { sellerHost, endpoint, checkoutId: sessionId, cancelKey: options.idempotencyKey });
      attempted = true;
      throw new Error("cancellation response lost");
    }
    assert.equal(operation, "get_checkout");
    return rpc(attempted ? { status: "canceled", id } : checkoutFixture());
  };
  const result = await createService(client).quote(request, {
    async checkoutCreated(checkout) { recorded = checkout; },
  });
  assert.equal(result.checkoutCancelled, true);
  assert.equal(result.verifiedQuotedTotalMinor, 4563);
});

test("cleanup recovery reads the bound checkout and reuses its cancel key", async () => {
  const client = merchantFixture();
  const cancelKey = "12345678-1234-4321-8234-123456789abc";
  const service = createService(client);
  assert.equal(await service.recoverCleanup({ sellerHost, endpoint: endpoint.replace("xyf8uj", "other"),
    checkoutId: sessionId, cancelKey }), false);
  const calls = [];
  client.callTool = async (_endpoint, operation, { id }, options) => {
    calls.push([operation, id]);
    if (operation === "get_checkout") return rpc(checkoutFixture());
    assert.deepEqual(options, { idempotencyKey: cancelKey });
    return rpc({ id, status: "canceled" });
  };
  assert.equal(await service.recoverCleanup({ sellerHost, endpoint, checkoutId: sessionId, cancelKey }), true);
  assert.deepEqual(calls, [["get_checkout", sessionId], ["cancel_checkout", sessionId]]);
});

test("readback with an order or a terminal lifecycle never sends a cancel", async () => {
  for (const readback of [
    checkoutFixture({ order: { id: "example-order" } }),
    checkoutFixture({ status: "completed" }),
    checkoutFixture({ status: "canceled" }),
  ]) {
    const client = merchantFixture({ readback });
    const result = await createService(client).quote(request);
    assert.equal(result.verifiedQuotedTotalMinor, null);
    assert.equal(result.checkoutCancelled === true, readback.status === "canceled");
    assert.ok(!client.calls.some(([tool]) => tool === "cancel_checkout"));
  }
});

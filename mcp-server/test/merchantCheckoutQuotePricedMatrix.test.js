// Priced-path matrix for the merchant quote preview: every verified price is in the market's currency, and
// every other market or currency is refused by name before any merchant call. Placeholder names only.
// The tool half pins the catalog proof to the market's currency (it fails if that proof is pinned to USD).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMerchantCheckoutQuoteService } from "../src/merchantCheckoutQuote.js";
import { InMemoryKvStore } from "../../safety-kernel/src/stores.js";
import { createCommerceToolSurface, ucpDialectSurface } from "../src/commerceToolSurface.js";
import { MERCHANT_QUOTE_TOOL } from "../src/merchantCheckoutQuoteTool.js";
import { encodeUcpVariantItemId } from "../src/ucpVariantIds.js";
import { marketCurrencyOf } from "../src/ucpCheckoutEscalation.js";

const sellerHost = "quote-seller.example";
const endpoint = "https://placeholder-shop.myshopify.com/api/ucp/mcp";
const sessionId = "gid://shopify/Checkout/rv-session";
const env = {
  AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED: "1",
  AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON: JSON.stringify({ [sellerHost]: endpoint }),
};
const ADDR = {
  US: { city: "Springfield", state: "CA", postal_code: "94105" },
  SG: { city: "Singapore", postal_code: "018989" },
  GB: { city: "London", postal_code: "SW1A 1AA" },
  DE: { city: "Berlin", postal_code: "10115" },
};
const EXPECTED = { US: "USD", SG: "SGD", GB: "GBP" }; // DE: no serving currency in buyerMarket -> refused
const now = Date.parse("2026-11-17T10:00:00Z");
const DOOR_FLAGS = ["AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED", "AGENT_CHECKOUT_STRICT", "AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED"];
// A two-letter market with no serving currency is named as unpriced; anything else malformed is a mismatch.
const wellFormed = market => typeof market === "string" && /^[A-Z]{2}$/.test(market);

function address(country) {
  const a = ADDR[country] || ADDR.US;
  return { name: "Test Buyer", address_line1: "1 Test Road", city: a.city, ...(a.state ? { state: a.state } : {}),
    postal_code: a.postal_code, country: country ?? "" };
}

function fixture(country, currency) {
  const a = ADDR[country] || ADDR.US;
  const lines = [{ id: "line-1", item: { id: "gid://shopify/ProductVariant/1234567", price: 1000 }, quantity: 2 }];
  return {
    id: sessionId, status: "incomplete", currency, expires_at: "2026-11-17T10:30:00Z", line_items: lines,
    totals: [{ type: "subtotal", amount: 2000 }, { type: "fulfillment", amount: 300 }, { type: "tax", amount: 0 },
      { type: "total", amount: 2300 }],
    fulfillment: { methods: [{ type: "shipping", line_item_ids: ["line-1"], selected_destination_id: "d",
      destinations: [{ id: "d", street_address: "1 Test Road", address_locality: a.city,
        ...(a.state ? { address_region: a.state } : {}), postal_code: a.postal_code, address_country: country }],
      groups: [{ line_item_ids: ["line-1"], selected_option_id: "o", options: [{ id: "o", totals: [{ type: "total", amount: 300 }] }] }] }] },
    discounts: { codes: [], applied: [] },
    messages: [{ code: "buyer_identity_contact_method_required", type: "error", severity: "recoverable" }],
  };
}

function client(country, currency) {
  const calls = [];
  return {
    calls, tier: "signed",
    // The real client's self-report (public values only); the quote refuses a client without one.
    describeTier() { return { signing_key_published: true }; },
    async discoverEndpoint(url) { calls.push(["discover", url]); return { mcpEndpoint: endpoint }; },
    async listTools() {
      calls.push(["tools/list"]);
      const fulfillment = { properties: { methods: { items: { properties: { destinations: {}, selected_destination_id: {} } } } } };
      return { response: { result: { tools: ["create_checkout", "get_checkout", "cancel_checkout"].map(name => ({
        name, inputSchema: { properties: { checkout: { properties: { fulfillment, discounts: {} } } } } })) } } };
    },
    async createCheckout(url, input) {
      calls.push(["create_checkout", input]);
      return { status: 200, response: { result: { structuredContent: { checkout: fixture(country, currency) } } } };
    },
    async callTool(url, op) {
      calls.push([op]);
      return { status: 200, response: { result: { structuredContent: { checkout:
        op === "get_checkout" ? fixture(country, currency) : { id: sessionId, status: "canceled" } } } } };
    },
  };
}

const MARKETS = ["US", "SG", "GB", "DE", undefined, "ZZ", "gb"];
const STORE_CURRENCIES = ["USD", "SGD", "GBP", "EUR", "CAD"];

test("service priced-path matrix: every verified price is in the market's currency; others refused by name", async () => {
  for (const market of MARKETS) {
    const expectedCurrency = marketCurrencyOf(market);
    assert.equal(expectedCurrency, EXPECTED[market] ?? null, `marketCurrencyOf(${market})`);
    for (const storeCurrency of STORE_CURRENCIES) {
      const c = client(market, storeCurrency);
      const service = createMerchantCheckoutQuoteService({ client: c, env, clock: () => now });
      const result = await service.quote({ sellerHost, market, expectedCurrency, shippingAddress: address(market),
        lineItems: [{ variantId: "1234567", quantity: 2 }] });
      if (!EXPECTED[market]) {
        assert.equal(result.verifiedQuotedTotalMinor, null);
        if (wellFormed(market)) {
          assert.equal(result.reason, "merchant_checkout_quote_market_unpriced");
          assert.equal(result.market, market);
        } else {
          assert.equal(result.reason, "merchant_checkout_quote_currency_mismatch");
        }
        assert.equal(c.calls.length, 0, "no merchant I/O for unknown market");
        continue;
      }
      const create = c.calls.find(call => call[0] === "create_checkout")[1];
      assert.equal(create.context.address_country, market);
      assert.equal(create.context.currency, EXPECTED[market]);
      assert.equal(create.checkout.currency, EXPECTED[market]);
      if (storeCurrency === EXPECTED[market]) {
        assert.equal(result.state, "verified_quote_with_buyer_requirements");
        assert.equal(result.currency, EXPECTED[market]);
        assert.equal(result.market, market);
        assert.equal(result.verifiedQuotedTotalMinor, 2300);
      } else {
        assert.equal(result.verifiedQuotedTotalMinor, null);
        assert.equal(result.reason, "merchant_checkout_quote_shopify_unverified");
        assert.equal(result.checkoutCancelled, true, "temporary checkout cancelled on refusal");
      }
    }
    // a caller-supplied currency other than the market's is refused before any I/O
    for (const wrong of ["USD", "EUR", "", undefined]) {
      if (wrong === EXPECTED[market]) continue;
      const c = client(market, wrong);
      const r = await createMerchantCheckoutQuoteService({ client: c, env, clock: () => now })
        .quote({ sellerHost, market, expectedCurrency: wrong, shippingAddress: address(market), lineItems: [{ variantId: "1234567", quantity: 2 }] });
      const expected = !EXPECTED[market] && wellFormed(market)
        ? "merchant_checkout_quote_market_unpriced" : "merchant_checkout_quote_currency_mismatch";
      assert.equal(r.reason, expected, `${market}/${wrong}`);
      assert.equal(c.calls.length, 0);
    }
    // address country must equal the market
    if (EXPECTED[market]) {
      const other = market === "US" ? "GB" : "US";
      const c = client(market, EXPECTED[market]);
      const r = await createMerchantCheckoutQuoteService({ client: c, env, clock: () => now })
        .quote({ sellerHost, market, expectedCurrency: EXPECTED[market], shippingAddress: address(other), lineItems: [{ variantId: "1234567", quantity: 2 }] });
      assert.equal(r.reason, "merchant_checkout_quote_invalid_request");
      assert.equal(c.calls.length, 0);
    }
  }
});

test("tool priced-path matrix: market none/ZZ/lowercase refused by name before state or merchant I/O; valid markets pass market currency", async t => {
  const saved = Object.fromEntries(DOOR_FLAGS.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const name of DOOR_FLAGS) process.env[name] = "1";
  const productId = "sig_00000000000000000000000000000001";
  for (const market of MARKETS) {
    const passed = [];
    const proofs = [];
    const reads = [];
    const store = new InMemoryKvStore({ now: () => now });
    Object.defineProperty(store, "durable", { value: true });
    const surface = createCommerceToolSurface({
      async execute(op, params) {
        reads.push(params.payload.market);
        return { product: { product_id: productId, product_key: "prod::merch_obs_rv::external_seed::x", merchant_id: "merch_obs_rv",
          source_domain: sellerHost, external_redirect_url: `https://${sellerHost}/products/x`, variants: [{ variant_id: "1234567" }] } };
      },
    }, { cache: false, merchantQuote: {
      now: () => now, stateStore: store, partnerPrincipal: () => ({ kind: "oauth", iss: "t", cid: "c" }),
      confirmCatalogVariant: async (input) => { proofs.push(input); return true; },
      env: { AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON: JSON.stringify({ [sellerHost]: endpoint }),
        AGENT_MERCHANT_CHECKOUT_QUOTE_IDEMPOTENCY_SECRET: "rv-test-key-0123456789-0123456789-01",
        AGENT_MERCHANT_CHECKOUT_QUOTE_OAUTH_PARTNERS: JSON.stringify(["oauth:t#c"]), MERCHANT_PURCHASABILITY_GATE_ENABLED: "0" },
      service: { async quote(input) { passed.push(input); return { state: "verified_checkout_quote", sellerHost: input.sellerHost,
        currency: input.expectedCurrency, market: input.market, verifiedQuotedTotalMinor: 2300, payableMinor: null,
        quotedAt: new Date(now).toISOString(), merchantExpiresAt: null }; } },
    } });
    const a = ADDR[market] || ADDR.US;
    const args = { consent_to_share_shipping_address: true, meta: { "idempotency-key": `rv-key-${market}-000001` },
      checkout: { ...(market === undefined ? { context: {} } : { context: { address_country: market } }),
        line_items: [{ item: { id: encodeUcpVariantItemId(productId, "1234567") }, quantity: 1 }],
        fulfillment: { methods: [{ type: "shipping", destinations: [{ first_name: "T", last_name: "B", street_address: "1 Test Road",
          address_locality: a.city, ...(a.state ? { address_region: a.state } : {}), postal_code: a.postal_code,
          address_country: market ?? "US" }] }] } } };
    let outcome;
    try {
      const r = await ucpDialectSurface(surface).callTool(MERCHANT_QUOTE_TOOL, args, { user_ref: "u", acp_session_id: "s" });
      outcome = { ok: true, currency: r.currency, total: r.verifiedQuotedTotalMinor };
    } catch (e) { outcome = { ok: false, code: e.code, reason: e.detail?.reason ?? e.message }; }
    if (EXPECTED[market]) {
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      assert.equal(passed[0].expectedCurrency, EXPECTED[market]);
      assert.equal(passed[0].market, market);
      assert.ok(reads.every(m => m === market));
      assert.ok(proofs.every(p => p.market === market && p.currency === EXPECTED[market]));
      assert.equal(outcome.currency, EXPECTED[market]);
    } else {
      assert.equal(outcome.ok, false);
      assert.equal(passed.length, 0, "no merchant call");
      assert.equal(outcome.reason, wellFormed(market) ? "merchant_quote_market_unpriced" : "merchant_quote_market_address_required");
    }
  }
});

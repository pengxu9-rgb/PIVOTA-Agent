import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryKvStore } from "../../safety-kernel/src/stores.js";
import { createCommerceToolSurface, ucpDialectSurface } from "../src/commerceToolSurface.js";
import { createMerchantQuoteCatalogVerifier, MERCHANT_QUOTE_TOOL } from "../src/merchantCheckoutQuoteTool.js";
import { encodeUcpVariantItemId } from "../src/ucpVariantIds.js";

const productId = "prod::merch_obs_test::external_seed::ext_123";
const host = "amuseseoulmakeup.com";
const key = "test-merchant-quote-601";
const buyer = { user_ref: "test-buyer", acp_session_id: "test-session" };
const args = {
  consent_to_share_shipping_address: true,
  meta: { "idempotency-key": key },
  checkout: {
    context: { address_country: "US" },
    line_items: [
      { item: { id: encodeUcpVariantItemId(productId, "52547428942138") }, quantity: 2 },
      { item: { id: encodeUcpVariantItemId(productId, "52547429007674") }, quantity: 1 },
    ],
    fulfillment: { methods: [{ type: "shipping", destinations: [{
      first_name: "Pivota", last_name: "QA", street_address: "1 Market Street", address_locality: "San Francisco",
      address_region: "CA", postal_code: "94105", address_country: "US",
    }] }] },
  },
};

const now = Date.parse("2026-11-14T12:00:00Z");

function setup({ proof = true, source = host, clock = () => now, expiry = null, persist = true } = {}) {
  const store = new InMemoryKvStore();
  Object.defineProperty(store, "durable", { value: true });
  if (!persist) store.compareAndSet = async () => false;
  const passed = [];
  const surface = createCommerceToolSurface({
    async execute(op, params) {
      assert.equal(op, "get_product");
      assert.equal(params.payload.product.product_id, productId);
      assert.equal(params.payload.market, "US");
      return { product: { product_id: productId, product_key: productId, merchant_id: "merch_obs_test",
        source_domain: source, external_redirect_url: `https://${host}/products/example`, variants: [
          { variant_id: "52547428942138" }, { variant_id: "52547429007674" },
        ] } };
    },
  }, {
    cache: false,
    merchantQuote: {
      now: clock,
      stateStore: store,
      partnerPrincipal: () => ({ kind: "oauth", iss: "test", cid: "test-client" }),
      confirmCatalogVariant: async () => proof,
      env: {
        AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON: JSON.stringify({ [host]: "https://sample.myshopify.com/api/ucp/mcp" }),
        AGENT_MERCHANT_CHECKOUT_QUOTE_IDEMPOTENCY_SECRET: "stage-test-key-1234567890-012345678901",
      },
      service: { async quote(input) {
        passed.push(input);
        return { state: "verified_quote_with_buyer_requirements", verifiedQuotedTotalMinor: 5688, payableMinor: null,
          quotedAt: new Date(now).toISOString(), merchantExpiresAt: expiry };
      } },
    },
  });
  return { surface, passed };
}

test("merchant preview is dark by default, then shared by native and UCP with an explicit signed-in purchaser", async t => {
  const { surface, passed } = setup();
  const ucp = ucpDialectSurface(surface);
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  assert.equal(ucp.tools.some(tool => tool.name === MERCHANT_QUOTE_TOOL), false);
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  assert.equal(ucp.tools.some(tool => tool.name === MERCHANT_QUOTE_TOOL), true);
  await assert.rejects(ucp.callTool(MERCHANT_QUOTE_TOOL, args, {}), { code: "USER_AUTH_REQUIRED" });
  await assert.rejects(ucp.callTool(MERCHANT_QUOTE_TOOL, { ...args, consent_to_share_shipping_address: false }, buyer),
    error => error.detail.reason === "merchant_quote_address_consent_required");
  const result = await ucp.callTool(MERCHANT_QUOTE_TOOL, args, buyer);
  assert.equal(result.verifiedQuotedTotalMinor, 5688);
  assert.equal(result.payableMinor, null);
  assert.deepEqual(await surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), result);
  assert.equal(passed.length, 1);
  assert.deepEqual(passed[0].lineItems, [{ variantId: "52547428942138", quantity: 2 }, { variantId: "52547429007674", quantity: 1 }]);
  assert.equal(passed[0].shippingAddress.postal_code, "94105");
  const other = structuredClone(args);
  other.checkout.fulfillment.methods[0].destinations[0].postal_code = "94107";
  await assert.rejects(ucp.callTool(MERCHANT_QUOTE_TOOL, other, buyer), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(passed.length, 1);
});

test("checkout preview refuses missing source identity and a row seller disagreement before Shopify", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  for (const [settings, reason] of [
    [{ proof: false }, "merchant_quote_native_variant_unverified"],
    [{ source: "different.example" }, "merchant_quote_seller_unverified"],
  ]) {
    const { surface, passed } = setup(settings);
    const result = await ucpDialectSurface(surface).callTool(MERCHANT_QUOTE_TOOL, args, buyer);
    assert.equal(result.reason, reason);
    assert.equal(passed.length, 0);
  }
});

test("native ID proof checks the exact product, observed seller, variant, market and currency", async () => {
  const verify = createMerchantQuoteCatalogVerifier(async (sql, params) => {
    assert.match(sql, /offer_payload->>'variant_id'=\$3/);
    assert.match(sql, /s\.suppressed_at IS NULL AND o\.suppressed_at IS NULL/);
    assert.deepEqual(params, [productId, "merch_obs_test", "52547428942138", "US", "USD"]);
    return { rows: [{ sku_key: "sku-exact" }] };
  });
  assert.equal(await verify({ row: { product_key: productId, merchant_id: "merch_obs_test" },
    variantId: "52547428942138", market: "US", currency: "USD" }), true);
});

test("a stale quote or failed ledger write cannot replay as a verified quote", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);

  for (const expiry of [null, new Date(now + 5_000).toISOString()]) {
    let instant = now;
    const { surface, passed } = setup({ clock: () => instant, expiry });
    await surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer);
    instant += expiry ? 5_000 : 60_000;
    await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "QUOTE_EXPIRED" });
    assert.equal(passed.length, 1);
  }
  const { surface, passed } = setup({ persist: false });
  await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "CHECKOUT_OUTCOME_UNKNOWN" });
  await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "CHECKOUT_OUTCOME_UNKNOWN" });
  assert.equal(passed.length, 1);
});

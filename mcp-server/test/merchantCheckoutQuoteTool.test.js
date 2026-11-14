import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryKvStore } from "../../safety-kernel/src/stores.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";
import { createCommerceToolSurface, toToolError, ucpDialectSurface } from "../src/commerceToolSurface.js";
import { createMerchantQuoteCatalogVerifier, MERCHANT_QUOTE_TOOL } from "../src/merchantCheckoutQuoteTool.js";
import { encodeUcpVariantItemId } from "../src/ucpVariantIds.js";

const productId = "sig_f574469185cec88071f23f7080adaeb2";
const productKey = "prod::merch_obs_test::external_seed::ext_123";
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
const variants = [{ variant_id: "52547428942138" }, { variant_id: "52547429007674" }];

function setup({ proof = async () => true, source = host, clock = () => now, expiry = null, persist = true,
  catalogVariants = variants, beforeRead, shouldOfferPurchase, service, store = new InMemoryKvStore({ now: clock }) } = {}) {
  Object.defineProperty(store, "durable", { value: true });
  if (!persist) store.compareAndSet = async () => false;
  if (persist === "throws") store.compareAndSet = async () => { throw new Error("ledger response lost"); };
  const passed = [];
  const surface = createCommerceToolSurface({
    async execute(op, params) {
      assert.equal(op, "get_product");
      assert.equal(params.payload.product.product_id, productId);
      assert.equal(params.payload.market, "US");
      await beforeRead?.();
      return { product: { product_id: productId, product_key: productKey, merchant_id: "merch_obs_test",
        source_domain: source, external_redirect_url: `https://${host}/products/example`, variants: catalogVariants } };
    },
  }, {
    cache: false,
    merchantQuote: {
      now: clock,
      stateStore: store,
      partnerPrincipal: () => ({ kind: "oauth", iss: "test", cid: "test-client" }),
      confirmCatalogVariant: proof,
      shouldOfferPurchase,
      env: {
        AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON: JSON.stringify({ [host]: "https://sample.myshopify.com/api/ucp/mcp" }),
        AGENT_MERCHANT_CHECKOUT_QUOTE_IDEMPOTENCY_SECRET: "stage-test-key-1234567890-012345678901",
        MERCHANT_PURCHASABILITY_GATE_ENABLED: shouldOfferPurchase ? "1" : "0",
      },
      service: service ?? { async quote(input) {
        passed.push(input);
        return { state: "verified_quote_with_buyer_requirements", sellerHost: input.sellerHost,
          verifiedQuotedTotalMinor: 5688, payableMinor: null,
          quotedAt: new Date(now).toISOString(), merchantExpiresAt: expiry };
      } },
    },
  });
  return { surface, passed, store };
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
  const retry = { ...args, meta: { "idempotency-key": ` ${key} ` } };
  assert.deepEqual(await surface.callTool(MERCHANT_QUOTE_TOOL, retry, buyer), result);
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
    [{ proof: async () => false }, "merchant_quote_native_variant_unverified"],
    [{ source: "different.example" }, "merchant_quote_seller_unverified"],
  ]) {
    const { surface, passed } = setup(settings);
    const result = await ucpDialectSurface(surface).callTool(MERCHANT_QUOTE_TOOL, args, buyer);
    assert.equal(result.reason, reason);
    assert.equal(passed.length, 0);
  }
});

test("native ID proof checks the exact product, observed seller, variant, market and currency", async () => {
  let matchingSkus = [{ sku_key: "sku-exact", selected: true }];
  let expectedSingle = false;
  const verify = createMerchantQuoteCatalogVerifier(async (sql, params) => {
    assert.match(sql, /s\.source_variant_id IN \(\$3, \$6\)/);
    assert.match(sql, /offer_payload->>'variant_id' IN \(s.source_variant_id,/);
    assert.match(sql, /\(\$7 OR s\.source_variant_id IN/);
    assert.match(sql, /s\.suppressed_at IS NULL AND o\.suppressed_at IS NULL/);
    assert.match(sql, /s\.suppression_reason IS NULL AND o\.suppression_reason IS NULL/);
    assert.deepEqual(params, [productKey, "merch_obs_test", "52547428942138", "US", "USD",
      "gid://shopify/ProductVariant/52547428942138", expectedSingle]);
    return { rows: matchingSkus };
  });
  const input = { row: { product_key: productKey, merchant_id: "merch_obs_test" },
    variantId: "52547428942138", market: "US", currency: "USD" };
  assert.equal(await verify(input), true);
  matchingSkus = [...matchingSkus, { sku_key: "sku-alias", selected: true }];
  assert.equal(await verify(input), false);
  expectedSingle = true;
  matchingSkus = [{ sku_key: "different-variant", selected: false }];
  assert.equal(await verify({ ...input, requireSingle: true }), false);
});

test("a plain product ID needs exactly one real canonical variant and a market-scoped proof", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  const plain = structuredClone(args);
  plain.checkout.line_items = [{ item: { id: productId }, quantity: 2 }];
  const { surface, passed } = setup({
    catalogVariants: variants.slice(0, 1),
    async proof({ variantId, market, currency, requireSingle }) {
      assert.deepEqual({ variantId, market, currency }, { variantId: "52547428942138", market: "US", currency: "USD" });
      assert.equal(requireSingle, true);
      return true;
    },
  });
  assert.equal((await surface.callTool(MERCHANT_QUOTE_TOOL, plain, buyer)).verifiedQuotedTotalMinor, 5688);
  assert.deepEqual(passed[0].lineItems, [{ variantId: "52547428942138", quantity: 2 }]);

  for (const [catalogVariants, expected] of [
    [[...variants.slice(0, 1), { ...variants[1], price: { amount: 10, currency: "CAD" } }], "merchant_quote_exact_variants_required"],
    [[{ variant_id: productId }], "merchant_quote_exact_variants_required"],
    [variants.slice(0, 1), "merchant_quote_native_variant_unverified"],
  ]) {
    const { surface, passed } = setup({ catalogVariants, proof: async () => false });
    assert.equal((await surface.callTool(MERCHANT_QUOTE_TOOL, plain, buyer)).reason, expected);
    assert.equal(passed.length, 0);
  }
});

test("a browse-only merchant market never reaches the checkout service", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  const calls = [];
  const { surface, passed } = setup({ async shouldOfferPurchase(input) {
    calls.push(input);
    return { offer: false, source: "gate" };
  } });
  const result = await surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer);
  assert.equal(result.reason, "merchant_quote_seller_browse_only");
  assert.deepEqual(calls, [{ domain: host, market: "US", budgetMs: 800, rail: "human" }]);
  assert.equal(passed.length, 0);
  let shouldOffer = true;
  const previouslyAllowed = setup({ shouldOfferPurchase: async () => ({ offer: shouldOffer, source: "gate" }) });
  assert.equal((await previouslyAllowed.surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer)).verifiedQuotedTotalMinor, 5688);
  shouldOffer = false;
  const replay = await previouslyAllowed.surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer);
  assert.equal(replay.verifiedQuotedTotalMinor, null);
  assert.equal(previouslyAllowed.passed.length, 1);
});

test("a transient product read or SKU proof failure allows retry with the same key", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  for (const stage of ["beforeRead", "proof"]) {
    let available = false;
    const { surface, passed } = setup({ [stage]: async () => {
      if (!available) throw new Error("temporary catalog failure");
      return true;
    } });
    await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "MERCHANT_UNAVAILABLE", retriable: true });
    assert.equal(passed.length, 0);
    available = true;
    assert.equal((await surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer)).verifiedQuotedTotalMinor, 5688);
    assert.equal(passed.length, 1);
  }
});

test("a terminal product refusal does not solicit a transient retry", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  const { surface, passed } = setup({ async beforeRead() { throw new PivotaCommerceError("PRODUCT_NOT_SERVABLE"); } });
  const result = await surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer);
  assert.equal(result.reason, "PRODUCT_NOT_SERVABLE");
  assert.equal(result.verifiedQuotedTotalMinor, null);
  assert.equal(passed.length, 0);
});

test("a transient Shopify discovery failure releases a pre-create claim", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  let calls = 0;
  const { surface } = setup({ service: {
    async quote() {
      calls += 1;
      if (calls === 1) throw new PivotaCommerceError("MERCHANT_UNAVAILABLE");
      return { verifiedQuotedTotalMinor: null, state: "checkout_unverified" };
    },
  } });
  await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "MERCHANT_UNAVAILABLE" });
  await surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer);
  assert.equal(calls, 2);
});

test("a pickup or selected delivery request cannot be quoted as default shipping", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  const { surface, passed } = setup();
  for (const fields of [{ type: "pickup" }, { groups: [{ selected_option_id: "express" }] },
    { selected_destination_id: "other" }, { line_item_ids: ["a-subset"] }]) {
    const input = structuredClone(args);
    Object.assign(input.checkout.fulfillment.methods[0], fields);
    await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, input, buyer),
      error => error.detail.reason === "merchant_quote_default_shipping_required");
  }
  assert.equal(passed.length, 0);
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
  for (const persist of [false, "throws"]) {
    const { surface, passed } = setup({ persist });
    await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "CHECKOUT_OUTCOME_UNKNOWN" });
    await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "CHECKOUT_OUTCOME_UNKNOWN" });
    assert.equal(passed.length, 1);
  }
});

test("unknown create is retained across the normal TTL and an instance restart", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  let instant = now;
  let creates = 0;
  const service = {
    async quote(_input, { beforeCreate }) {
      await beforeCreate({ sellerHost: host, createKey: "store-create-key" });
      creates += 1;
      return { state: "checkout_outcome_unknown" };
    },
  };
  const clock = () => instant;
  const { surface, store } = setup({ service, clock });
  await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), error => {
    const wire = JSON.parse(toToolError(error).content[0].text).error;
    assert.equal(wire.code, "CHECKOUT_OUTCOME_UNKNOWN");
    assert.equal(wire.detail.reason, "merchant_quote_outcome_pending");
    return true;
  });
  instant += 11 * 60 * 1000;
  const replacement = setup({ service, clock, store }).surface;
  await assert.rejects(replacement.callTool(MERCHANT_QUOTE_TOOL, args, { ...buyer, acp_session_id: "new-session" }),
    { code: "CHECKOUT_OUTCOME_UNKNOWN" });
  assert.equal(creates, 1);
});

test("a later retry recovers only the existing checkout after a failed cancellation", async t => {
  const old = process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED;
  process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = "1";
  t.after(() => old === undefined ? delete process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED
    : process.env.AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED = old);
  let instant = now;
  let creates = 0;
  let repairs = 0;
  const cleanup = {
    sellerHost: host, endpoint: "https://sample.myshopify.com/api/ucp/mcp",
    checkoutId: "gid://shopify/Checkout/example?key=test-private", cancelKey: "store-cancel-key",
  };
  const service = {
    async quote(_input, { beforeCreate, checkoutCreated }) {
      await beforeCreate({ sellerHost: host, endpoint: cleanup.endpoint, createKey: "store-create-key" });
      await checkoutCreated(cleanup);
      creates += 1;
      return { state: "checkout_outcome_unknown", checkoutCancelled: false };
    },
    async recoverCleanup(input) {
      assert.deepEqual(input, cleanup);
      repairs += 1;
      return true;
    },
  };
  const clock = () => instant;
  const { surface, store } = setup({ service, clock });
  await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "CHECKOUT_OUTCOME_UNKNOWN" });
  assert.doesNotMatch(JSON.stringify([...store._m.values()]), /test-private|1 Market Street/);
  const retry = setup({ service, clock, store }).surface;
  await assert.rejects(retry.callTool(MERCHANT_QUOTE_TOOL, args, buyer), { code: "CHECKOUT_OUTCOME_UNKNOWN" });
  instant += 11 * 60 * 1000;
  const results = await Promise.allSettled([1, 2].map(() => retry.callTool(MERCHANT_QUOTE_TOOL, args, buyer)));
  assert.ok(results.some(result => result.status === "fulfilled" && result.value.checkoutCancelled));
  const recovered = await retry.callTool(MERCHANT_QUOTE_TOOL, args, buyer);
  assert.equal(recovered.checkoutCancelled, true);
  assert.equal(recovered.verifiedQuotedTotalMinor, null);
  assert.equal(creates, 1);
  assert.equal(repairs, 1);
});

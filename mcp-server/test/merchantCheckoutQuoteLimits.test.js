import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryKvStore } from "../../safety-kernel/src/stores.js";
import { createCommerceToolSurface, toToolError, ucpDialectSurface } from "../src/commerceToolSurface.js";
import { MERCHANT_QUOTE_TOOL } from "../src/merchantCheckoutQuoteTool.js";
import { MERCHANT_QUOTE_RATE_LIMITED, merchantQuoteRateLimits } from "../src/merchantCheckoutQuoteRateLimit.js";
import { encodeUcpVariantItemId } from "../src/ucpVariantIds.js";

// Placeholder sellers, products and buyers only.
const sellerA = "alpha-seller.example";
const sellerB = "beta-seller.example";
const sellerA2 = "gamma-seller.example";
const endpoints = {
  [sellerA]: "https://alpha-shop.myshopify.com/api/ucp/mcp",
  [sellerB]: "https://beta-shop.myshopify.com/api/ucp/mcp",
  // A second storefront host configured onto the first seller's store.
  [sellerA2]: "https://alpha-shop.myshopify.com/api/ucp/mcp",
};
const products = {
  sig_a0000000000000000000000000000001: { seller: sellerA, variant: "61000000000101" },
  sig_b0000000000000000000000000000002: { seller: sellerB, variant: "62000000000101" },
  sig_c0000000000000000000000000000003: { seller: sellerA, variant: "63000000000101" },
  sig_d0000000000000000000000000000004: { seller: sellerA2, variant: "64000000000101" },
};
const [productA, productB, productA2, productSameStore] = Object.keys(products);
const buyer = { user_ref: "test-buyer", acp_session_id: "test-session" };
const start = Date.parse("2026-11-17T12:00:10Z");
const DOOR_FLAGS = ["AGENT_MERCHANT_CHECKOUT_QUOTE_ENABLED", "AGENT_CHECKOUT_STRICT", "AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED"];

const ENV_NAMES = [...DOOR_FLAGS, "MCP_CALLER_LIMITS_MODE"];
const restoring = new WeakSet();

// Opens the quote door (all three flags on, as in prod) and applies `values`. The environment as it was
// before the test's first call is restored once, when the test ends.
function withEnv(t, values) {
  if (!restoring.has(t)) {
    restoring.add(t);
    const saved = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
    t.after(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    });
  }
  for (const name of ENV_NAMES) delete process.env[name];
  for (const name of DOOR_FLAGS) process.env[name] = "1";
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function argsFor(key, { lines = [[productA, 1]], market = "US" } = {}) {
  return {
    consent_to_share_shipping_address: true,
    meta: { "idempotency-key": key },
    checkout: {
      context: { address_country: market },
      line_items: lines.map(([id, quantity]) => ({ item: { id: encodeUcpVariantItemId(id, products[id].variant) }, quantity })),
      fulfillment: { methods: [{ type: "shipping", destinations: [{
        first_name: "Test", last_name: "Buyer", street_address: "1 Test Road", address_locality: "Springfield",
        address_region: "CA", postal_code: "94105", address_country: market,
      }] }] },
    },
  };
}

function setup({ limits = {}, store = undefined, clock } = {}) {
  const time = { now: start };
  const now = clock ?? (() => time.now);
  const kv = store ?? new InMemoryKvStore({ now });
  Object.defineProperty(kv, "durable", { value: true });
  const quoted = [];
  // `subject`, when set, replaces the API-key agent subject (an OAuth client, say).
  const caller = { partner: "partner-one", subject: null };
  const surface = createCommerceToolSurface({
    async execute(op, params) {
      assert.equal(op, "get_product");
      const id = params.payload.product.product_id;
      const { seller, variant } = products[id];
      return { product: { product_id: id, product_key: `prod::merch_obs_test::external_seed::${id}`,
        merchant_id: "merch_obs_test", source_domain: seller, external_redirect_url: `https://${seller}/products/example`,
        variants: [{ variant_id: variant }] } };
    },
  }, {
    cache: false,
    merchantQuote: {
      now,
      stateStore: kv,
      partnerPrincipal: () => caller.subject ?? { kind: "agent", sub: caller.partner },
      confirmCatalogVariant: async () => true,
      env: {
        AGENT_MERCHANT_CHECKOUT_QUOTE_SELLERS_JSON: JSON.stringify(endpoints),
        AGENT_MERCHANT_CHECKOUT_QUOTE_IDEMPOTENCY_SECRET: "limits-test-key-0123456789-0123456789",
        MERCHANT_PURCHASABILITY_GATE_ENABLED: "0",
        ...limits,
      },
      service: { async quote(input) {
        quoted.push(input);
        return { state: "verified_checkout_quote", sellerHost: input.sellerHost, currency: input.expectedCurrency,
          market: input.market, verifiedQuotedTotalMinor: 2300, payableMinor: null,
          quotedAt: new Date(now()).toISOString(), merchantExpiresAt: null, checkoutCancelled: true };
      } },
    },
  });
  return { surface, ucp: ucpDialectSurface(surface), quoted, caller, time, store: kv };
}

async function rateLimited(promise) {
  let refusal;
  await assert.rejects(promise, error => {
    refusal = error;
    return error.code === "MERCHANT_UNAVAILABLE" && error.retriable === true
      && error.detail?.reason === MERCHANT_QUOTE_RATE_LIMITED;
  });
  return refusal;
}

test("each partner has its own enforced quote budget; a refusal makes no seller call and is named on the wire", async t => {
  withEnv(t, { MCP_CALLER_LIMITS_MODE: "observe" });
  const { ucp, quoted, caller, time } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "2", AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "50",
  } });
  const first = await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-one-key-0001"), buyer);
  assert.equal(first.verifiedQuotedTotalMinor, 2300);
  await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-one-key-0002"), buyer);
  assert.equal(quoted.length, 2);

  const refusal = await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-one-key-0003"), buyer));
  assert.equal(quoted.length, 2, "no seller call once the partner is over its limit");
  // 12:00:10 in a 60 s window that ends at 12:01:00.
  assert.equal(refusal.detail.retry_after_seconds, 50);
  const wire = JSON.parse(toToolError(refusal).content[0].text).error;
  assert.equal(wire.code, "MERCHANT_UNAVAILABLE");
  assert.equal(wire.retriable, true);
  assert.deepEqual(wire.detail, { reason: MERCHANT_QUOTE_RATE_LIMITED, retry_after_seconds: 50 });
  assert.match(wire.recovery, /same idempotency_key/);

  // A replay of a key that was already quoted is served from the ledger and uses no budget.
  assert.deepEqual(await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-one-key-0001"), buyer), first);
  // The refused key was released, not left pending: it is refused again as rate limited, not as unknown.
  await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-one-key-0003"), buyer));

  caller.partner = "partner-two";
  assert.equal((await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-two-key-0001"), buyer)).verifiedQuotedTotalMinor, 2300);
  assert.equal(quoted.length, 3, "another partner still has its own budget");

  caller.partner = "partner-one";
  time.now = Date.parse("2026-11-17T12:01:00Z");
  assert.equal((await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-one-key-0003"), buyer)).verifiedQuotedTotalMinor, 2300);
  assert.equal(quoted.length, 4, "the same request succeeds in the next window");
});

test("each seller has one budget shared by all partners and enforced on the native door too", async t => {
  withEnv(t, { MCP_CALLER_LIMITS_MODE: "off" });
  const { surface, quoted, caller } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "50", AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "2",
  } });
  for (const partner of ["partner-one", "partner-two"]) {
    caller.partner = partner;
    await surface.callTool(MERCHANT_QUOTE_TOOL, argsFor(`${partner}-key-0001`), buyer);
  }
  caller.partner = "partner-three";
  await rateLimited(surface.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-three-key-0001"), buyer));
  assert.deepEqual(quoted.map(input => input.sellerHost), [sellerA, sellerA]);
  // A different seller is not affected.
  const other = await surface.callTool(MERCHANT_QUOTE_TOOL, argsFor("partner-three-key-0002", { lines: [[productB, 1]] }), buyer);
  assert.equal(other.sellerHost, sellerB);
  assert.equal(quoted.length, 3);
});

test("the limit is enforced whatever MCP_CALLER_LIMITS_MODE says", async t => {
  for (const mode of [undefined, "off", "observe", "enforce"]) {
    withEnv(t, { MCP_CALLER_LIMITS_MODE: mode });
    const { ucp, quoted } = setup({ limits: { AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "1" } });
    await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("mode-key-000001"), buyer);
    await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("mode-key-000002"), buyer));
    assert.equal(quoted.length, 1, String(mode));
  }
});

test("a limit cannot be switched off and an unreadable value uses the default", () => {
  const names = ["RATE_WINDOW_SEC", "PER_PARTNER_LIMIT", "UNREGISTERED_OAUTH_LIMIT", "PER_SELLER_LIMIT", "PER_SELLER_DAILY_LIMIT"];
  const read = (...values) => merchantQuoteRateLimits(Object.fromEntries(
    names.map((name, index) => [`AGENT_MERCHANT_CHECKOUT_QUOTE_${name}`, values[index]])));
  const defaults = { windowMs: 60_000, perPartner: 12, pooledOauth: 6, perSeller: 6, perSellerDaily: 200 };
  assert.deepEqual(merchantQuoteRateLimits({}), defaults);
  assert.deepEqual(read("0", "-3", "0", "0", "-1"), { windowMs: 10_000, perPartner: 1, pooledOauth: 1, perSeller: 1, perSellerDaily: 1 });
  assert.deepEqual(read("1.5", "off", "", "x", "2e3"), defaults);
  assert.deepEqual(read("100000", "100000", "100000", "100000", "100000"),
    { windowMs: 3_600_000, perPartner: 240, pooledOauth: 240, perSeller: 120, perSellerDaily: 5000 });
});

test("a counter store failure, or a store without atomic counters, refuses before any seller call", async t => {
  withEnv(t, {});
  const failing = new InMemoryKvStore({ now: () => start });
  const increment = failing.incrementCounterBelow.bind(failing);
  let broken = true;
  failing.incrementCounterBelow = async (...input) => {
    if (broken) throw new Error("counter store unavailable");
    return increment(...input);
  };
  const down = setup({ store: failing });
  await assert.rejects(down.ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("store-down-key-01"), buyer),
    { code: "MERCHANT_UNAVAILABLE", retriable: true, detail: { reason: "merchant_quote_unavailable" } });
  assert.equal(down.quoted.length, 0);
  broken = false;
  assert.equal((await down.ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("store-down-key-01"), buyer)).verifiedQuotedTotalMinor, 2300);

  const plain = new InMemoryKvStore({ now: () => start });
  plain.incrementCounterBelow = undefined;
  const missing = setup({ store: plain });
  await assert.rejects(missing.ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("no-counter-key-01"), buyer),
    { code: "MERCHANT_UNAVAILABLE", detail: { reason: "merchant_quote_unavailable" } });
  assert.equal(missing.quoted.length, 0);
});

test("concurrent new quotes never pass a limit, and none under it is refused for racing", async t => {
  withEnv(t, {});
  const { ucp, quoted } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "240", AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "5",
  } });
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
    ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor(`burst-key-${String(index).padStart(6, "0")}`), buyer)));
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 5);
  assert.ok(outcomes.filter(outcome => outcome.status === "rejected")
    .every(outcome => outcome.reason.detail?.reason === MERCHANT_QUOTE_RATE_LIMITED));
  assert.equal(quoted.length, 5);
});

test("OAuth clients without a caller-limit override share one pooled partner budget", async t => {
  withEnv(t, {});
  const provisioned = { kind: "oauth", iss: "https://login.test", cid: "provisioned-client" };
  const { ucp, quoted, caller } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_UNREGISTERED_OAUTH_LIMIT: "2",
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "3",
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "100",
    MCP_CALLER_LIMITS_OVERRIDES_JSON: JSON.stringify({ [`oauth:${provisioned.iss}#${provisioned.cid}`]: { rpm: 600 } }),
  } });
  // Each self-registered client is a new client id, yet together they get the pooled 2.
  for (const [index, cid] of ["minted-client-1", "minted-client-2"].entries()) {
    caller.subject = { kind: "oauth", iss: "https://login.test", cid };
    await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor(`minted-key-00000${index}`), buyer);
  }
  caller.subject = { kind: "oauth", iss: "https://login.test", cid: "minted-client-3" };
  await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("minted-key-000002"), buyer));
  assert.equal(quoted.length, 2);
  // A provisioned client and an API-key agent each keep their own partner budget.
  caller.subject = provisioned;
  for (const index of [0, 1, 2]) await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor(`provisioned-key-0${index}`), buyer);
  await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("provisioned-key-03"), buyer));
  caller.subject = null;
  await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("agent-key-0000001"), buyer);
  assert.equal(quoted.length, 6);
});

test("a malformed overrides value pools every OAuth client", async t => {
  withEnv(t, {});
  const { ucp, quoted, caller } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_UNREGISTERED_OAUTH_LIMIT: "1",
    MCP_CALLER_LIMITS_OVERRIDES_JSON: "{not json",
  } });
  caller.subject = { kind: "oauth", iss: "https://login.test", cid: "listed-client" };
  await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("malformed-key-0001"), buyer);
  caller.subject = { kind: "oauth", iss: "https://login.test", cid: "other-client" };
  await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("malformed-key-0002"), buyer));
  assert.equal(quoted.length, 1);
});

test("each seller has a daily cap across windows, refused until the next UTC day", async t => {
  withEnv(t, {});
  const { ucp, quoted, time } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_DAILY_LIMIT: "3", AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "100",
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "240",
  } });
  for (const minute of [0, 1, 2]) {
    time.now = Date.parse(`2026-11-17T12:0${minute}:10Z`);
    await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor(`daily-key-00000${minute}`), buyer);
  }
  // 23:58:30: the minute window ends in 30 s, the UTC day in 90 s. The wait is the day's.
  time.now = Date.parse("2026-11-17T23:58:30Z");
  const refusal = await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("daily-key-000003"), buyer));
  assert.equal(refusal.detail.retry_after_seconds, 90, "until the UTC day ends");
  // Another seller still has its own daily cap.
  await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("daily-key-other-1", { lines: [[productB, 1]] }), buyer);
  time.now = Date.parse("2026-11-18T00:00:00Z");
  await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("daily-key-000003"), buyer);
  assert.equal(quoted.length, 5);
});

test("a refusal by a later counter gives back the units already taken", async t => {
  withEnv(t, {});
  const { ucp, quoted } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "2", AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "1",
  } });
  await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("refund-key-000001"), buyer);
  // The seller is full: refused, and the partner unit this attempt took is returned.
  await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("refund-key-000002"), buyer));
  await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("refund-key-000003"), buyer));
  // So the partner still has its second unit for another seller.
  const other = await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("refund-key-000004", { lines: [[productB, 1]] }), buyer);
  assert.equal(other.sellerHost, sellerB);
  assert.equal(quoted.length, 2);

  // The daily cap refusing gives back both window units.
  const daily = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "2", AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "2",
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_DAILY_LIMIT: "1",
  } });
  await daily.ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("daily-refund-key-1"), buyer);
  await rateLimited(daily.ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("daily-refund-key-2"), buyer));
  await daily.ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("daily-refund-key-3", { lines: [[productB, 1]] }), buyer);
  assert.equal(daily.quoted.length, 2);
});

test("two storefront hosts configured onto one store share that store's budget", async t => {
  withEnv(t, {});
  const { ucp, quoted } = setup({ limits: {
    AGENT_MERCHANT_CHECKOUT_QUOTE_PER_SELLER_LIMIT: "1", AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "240",
  } });
  await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("same-store-key-01"), buyer);
  await rateLimited(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("same-store-key-02", { lines: [[productSameStore, 1]] }), buyer));
  assert.deepEqual(quoted.map(input => input.sellerHost), [sellerA]);
});

test("a cart that spans two sellers is refused before any seller call", async t => {
  withEnv(t, {});
  const { ucp, quoted } = setup();
  const mixed = await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("mixed-seller-key-1", {
    lines: [[productA, 1], [productB, 1]],
  }), buyer);
  assert.equal(mixed.reason, "merchant_quote_mixed_sellers");
  assert.equal(mixed.verifiedQuotedTotalMinor, null);
  assert.equal(quoted.length, 0);
  // Control: two products from one seller are quoted together.
  const single = await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("one-seller-key-01", {
    lines: [[productA, 1], [productA2, 2]],
  }), buyer);
  assert.equal(single.sellerHost, sellerA);
  assert.deepEqual(quoted[0].lineItems.map(line => line.variantId).sort(), ["61000000000101", "63000000000101"]);
});

test("a well-formed market Pivota does not price is refused by name, with the market", async t => {
  withEnv(t, {});
  const { ucp, quoted } = setup();
  for (const market of ["DE", "ZZ"]) {
    let refusal;
    await assert.rejects(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor(`unpriced-${market}-key`, { market }), buyer), error => {
      refusal = error;
      return error.code === "QUOTE_REQUIRED" && error.detail?.reason === "merchant_quote_market_unpriced";
    });
    const wire = JSON.parse(toToolError(refusal).content[0].text).error;
    assert.deepEqual(wire.detail, { reason: "merchant_quote_market_unpriced", market });
    assert.equal(wire.retriable, false);
  }
  // A malformed market is still a market/address problem, not an unpriced market.
  await assert.rejects(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("malformed-gb-key", { market: "gb" }), buyer),
    error => error.detail?.reason === "merchant_quote_market_address_required");
  assert.equal(quoted.length, 0);
});

test("native /mcp lists and serves the tool only with the same flags as the HTTP route", async t => {
  for (const off of DOOR_FLAGS) {
    withEnv(t, { [off]: "0" });
    const { surface, ucp, quoted } = setup();
    assert.equal(surface.tools.some(tool => tool.name === MERCHANT_QUOTE_TOOL), false, off);
    assert.equal(ucp.tools.some(tool => tool.name === MERCHANT_QUOTE_TOOL), false, off);
    assert.equal(surface.isCommerceTool(MERCHANT_QUOTE_TOOL), false, off);
    await assert.rejects(surface.callTool(MERCHANT_QUOTE_TOOL, argsFor("dark-door-key-01"), buyer));
    assert.equal(quoted.length, 0, off);
  }
  withEnv(t, {});
  const { surface, ucp } = setup();
  assert.equal(surface.tools.some(tool => tool.name === MERCHANT_QUOTE_TOOL), true);
  assert.equal(ucp.tools.some(tool => tool.name === MERCHANT_QUOTE_TOOL), true);
});

test("an address in another country than the market is refused at the tool, before state or a seller call", async t => {
  withEnv(t, {});
  const { ucp, quoted } = setup();
  const args = argsFor("cross-country-key-1");
  args.checkout.fulfillment.methods[0].destinations[0].address_country = "CA";
  await assert.rejects(ucp.callTool(MERCHANT_QUOTE_TOOL, args, buyer),
    error => error.code === "QUOTE_REQUIRED" && error.detail?.reason === "merchant_quote_market_address_required");
  assert.equal(quoted.length, 0);
});

test("a store error on a later counter gives back the units already taken", async t => {
  withEnv(t, {});
  const store = new InMemoryKvStore({ now: () => start });
  const increment = store.incrementCounterBelow.bind(store);
  let calls = 0;
  let failSecond = true;
  store.incrementCounterBelow = async (...input) => {
    calls += 1;
    if (failSecond && calls === 2) throw new Error("seller counter unavailable");
    return increment(...input);
  };
  const { ucp, quoted } = setup({ store, limits: { AGENT_MERCHANT_CHECKOUT_QUOTE_PER_PARTNER_LIMIT: "1" } });
  await assert.rejects(ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("store-error-key-1"), buyer),
    { code: "MERCHANT_UNAVAILABLE", detail: { reason: "merchant_quote_unavailable" } });
  failSecond = false;
  // The partner's only unit was given back, so the retry is admitted.
  assert.equal((await ucp.callTool(MERCHANT_QUOTE_TOOL, argsFor("store-error-key-1"), buyer)).verifiedQuotedTotalMinor, 2300);
  assert.equal(quoted.length, 1);
});

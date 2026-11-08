// DECISION D-10 (2026-11-08): a request that names no market is answered as US, the answer says so
// (`market_assumed`), and the reads behind it run as US. A request that names a market is answered exactly as before.
//
// Every door is exercised through its real entry point (the native /mcp surface, the UCP dialect view, the public
// tier, the storefront escalation lane) over a recording executor, so the market each lane is SENT is what is
// asserted, not what a helper returns.
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import requestMarket from "../../src/services/requestMarket.js";

// get_product declares `market` while the live product read is on at all (read once at load; prod runs it at
// enforce), so the surface is loaded under it: the declared-market half of this file needs the argument accepted.
process.env.UCP_LIVE_PRODUCT_READ = process.env.UCP_LIVE_PRODUCT_READ || "shadow";
const {
  createCommerceToolSurface,
  ucpDialectSurface,
  commerceToolMarketAssumed,
  commerceToolParamsKey,
} = await import("../src/commerceToolSurface.js");
const { createPublicReadToolSurface } = await import("../src/publicReadToolSurface.js");
const {
  encodeEscalationId,
  decodeEscalationId,
  escalationMarketOf,
  escalationRequestMarket,
  tryEscalateUcpCheckout,
  refuseUnservedStorefrontCheckout,
  UCP_ESCALATION_FLAG,
} = await import("../src/ucpCheckoutEscalation.js");

const META = { "ucp-agent": { profile: "https://agent.example/.well-known/ucp-agent" } };
const SESSION = { user_ref: "buyer_1", acp_session_id: "sess_1" };
const ROW = { product_id: "sig_1", merchant_id: "m1", title: "Serum", price: 12.5, currency: "USD", variants: [{ variant_id: "v_1", price: 12.5 }] };

function recordingExecutor() {
  const calls = [];
  return {
    calls,
    async execute(op, params) {
      calls.push({ op, params: structuredClone(params) });
      if (op === "search_catalog") return { status: "success", products: [{ ...ROW }], total: 1 };
      if (op === "get_product") return { product: { ...ROW } };
      if (op === "get_offers") return { subject: { kind: "product", id: "sig_1" }, best_offer: null, signals: [], metadata: { offer_count: 0 } };
      if (op === "get_alternatives") return { subject: { kind: "product", id: "sig_1" }, signals: [], metadata: {} };
      if (op === "recommend_products") return { signals: [], metadata: {} };
      return {};
    },
  };
}
const marketSent = (call) => (call.op === "search_catalog" ? call.params.payload.search.market : call.params.payload.market);

const NATIVE_READS = [
  ["search_catalog", { query: "serum" }],
  ["get_product", { merchant_id: "m1", product_id: "sig_1" }],
  ["get_offers", { product_id: "sig_1" }],
  ["get_alternatives", { product_id: "sig_1" }],
];

describe("the shared rule (src/services/requestMarket.js)", () => {
  test("only absent, null or blank names no market; anything else is passed through untouched", () => {
    for (const raw of [undefined, null, "", "   "]) {
      assert.deepEqual(requestMarket.resolveRequestMarket(raw), { market: "US", assumed: true }, JSON.stringify(raw));
    }
    for (const raw of ["US", "SG", "sg", " JP ", "USA", "en-US", "ZZ", 840]) {
      assert.deepEqual(requestMarket.resolveRequestMarket(raw), { market: raw, assumed: false }, JSON.stringify(raw));
    }
    const a = requestMarket.marketAssumedLabel();
    assert.deepEqual(Object.keys(a), ["code", "message"]);
    assert.equal(a.code, "US");
    assert.notEqual(requestMarket.marketAssumedLabel(), a, "a fresh object per answer");
  });
});

describe("native /mcp: every read is answered for one market", () => {
  for (const [tool, args] of NATIVE_READS) {
    test(`${tool}: no market -> US is sent downstream and the answer says US assumed`, async () => {
      for (const unnamed of [undefined, null, "  "]) {
        const ex = recordingExecutor();
        const surface = createCommerceToolSurface(ex, { cache: false });
        const out = await surface.callTool(tool, unnamed === undefined ? args : { ...args, market: unnamed }, SESSION);
        assert.equal(marketSent(ex.calls[0]), "US", `${tool} market=${JSON.stringify(unnamed)}`);
        assert.deepEqual(out.market_assumed, requestMarket.marketAssumedLabel());
      }
    });

    test(`${tool}: a declared market (valid or not) is sent exactly as given and the answer carries no label`, async () => {
      for (const declared of ["US", "SG", "sg", "USA", "en-US", "ZZ"]) {
        const ex = recordingExecutor();
        const surface = createCommerceToolSurface(ex, { cache: false });
        const out = await surface.callTool(tool, { ...args, market: declared }, SESSION);
        assert.equal(marketSent(ex.calls[0]), declared, `${tool} market=${declared}`);
        assert.equal("market_assumed" in out, false, `${tool} market=${declared}`);
      }
    });
  }

  test("recommend_products takes no market: always answered for the US, and says so; nothing new is sent", async () => {
    const ex = recordingExecutor();
    const out = await createCommerceToolSurface(ex, { cache: false }).callTool("recommend_products", { need: "a gentle serum" }, SESSION);
    assert.equal(JSON.stringify(ex.calls[0].params.payload), JSON.stringify({ need: "a gentle serum" }));
    assert.equal(out.market_assumed.code, "US");
  });

  test("get_intel and the checkout tools are not market reads: no label", async () => {
    const ex = recordingExecutor();
    const out = await createCommerceToolSurface(ex, { cache: false }).callTool("get_intel", { product_id: "sig_1" }, SESSION);
    assert.equal("market_assumed" in out, false);
    assert.equal(commerceToolMarketAssumed("get_checkout_session", { session_id: "q_1" }), false);
  });

  test("the search cache: a no-market and a declared-US search share ONE entry, and only the no-market answer is labelled", async () => {
    const ex = recordingExecutor();
    const surface = createCommerceToolSurface(ex, { cache: true });
    const assumed = await surface.callTool("search_catalog", { query: "serum" }, SESSION);
    const declared = await surface.callTool("search_catalog", { query: "serum", market: "US" }, SESSION);
    const assumedAgain = await surface.callTool("search_catalog", { query: "serum" }, SESSION);
    assert.equal(ex.calls.length, 1, "the same params: one upstream call");
    assert.equal(assumed.market_assumed.code, "US");
    assert.equal("market_assumed" in declared, false, "the label never enters the cache");
    assert.equal(assumedAgain.market_assumed.code, "US");
    assert.equal(
      commerceToolParamsKey("search_catalog", { query: "serum" }),
      commerceToolParamsKey("search_catalog", { query: "serum", market: "US" }),
    );
  });
});

describe("UCP dialect", () => {
  const ucp = (ex) => ucpDialectSurface(createCommerceToolSurface(ex, { cache: false }));

  test("search_catalog with no address_country: US is sent, and the envelope says so in market_assumed AND messages", async () => {
    const ex = recordingExecutor();
    const out = await ucp(ex).callTool("search_catalog", { meta: META, catalog: { query: "serum" } }, SESSION);
    assert.equal(ex.calls[0].params.payload.search.market, "US");
    assert.equal(out.market_assumed.code, "US");
    const notice = out.messages.find((m) => m.code === "market_assumed");
    assert.deepEqual(notice, { type: "info", code: "market_assumed", path: "$", content: requestMarket.MARKET_ASSUMED_MESSAGE, content_type: "plain" });
  });

  test("search_catalog with address_country SG: SG is sent, no label, no notice", async () => {
    const ex = recordingExecutor();
    const out = await ucp(ex).callTool("search_catalog", { meta: META, catalog: { query: "serum", context: { address_country: "SG" } } }, SESSION);
    assert.equal(ex.calls[0].params.payload.search.market, "SG");
    assert.equal("market_assumed" in out, false);
    assert.equal(out.messages, undefined);
  });

  test("get_product with the forward dial OFF: a NAMED address_country is not forwarded and is never answered as assumed", async () => {
    const prior = process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
    delete process.env.UCP_GET_PRODUCT_FORWARD_MARKET;
    try {
      const ex = recordingExecutor();
      const out = await ucp(ex).callTool("get_product", { meta: META, catalog: { id: "sig_1", context: { address_country: "SG" } } }, SESSION);
      assert.deepEqual(ex.calls[0].params.payload, { product: { product_id: "sig_1" } }, "byte-identical to before");
      assert.equal("market_assumed" in out, false);
      // ...while a get_product that names none is answered as US even with the dial off
      const ex2 = recordingExecutor();
      const out2 = await ucp(ex2).callTool("get_product", { meta: META, catalog: { id: "sig_1" } }, SESSION);
      assert.equal(ex2.calls[0].params.payload.market, "US");
      assert.equal(out2.market_assumed.code, "US");
    } finally {
      if (prior === undefined) delete process.env.UCP_GET_PRODUCT_FORWARD_MARKET; else process.env.UCP_GET_PRODUCT_FORWARD_MARKET = prior;
    }
  });

  test("get_offers / get_alternatives: insights.market absent -> US; present -> exactly as sent", async () => {
    for (const tool of ["get_offers", "get_alternatives"]) {
      const ex = recordingExecutor();
      const out = await ucp(ex).callTool(tool, { meta: META, insights: { id: "sig_1" } }, SESSION);
      assert.equal(ex.calls[0].params.payload.market, "US", tool);
      assert.equal(out.market_assumed.code, "US", tool);
      const ex2 = recordingExecutor();
      const out2 = await ucp(ex2).callTool(tool, { meta: META, insights: { id: "sig_1", market: "JP" } }, SESSION);
      assert.equal(ex2.calls[0].params.payload.market, "JP", tool);
      assert.equal("market_assumed" in out2, false, tool);
    }
  });
});

describe("public tier", () => {
  test("no market -> labelled; a declared US read of the SAME cache entry is not", async () => {
    const ex = recordingExecutor();
    const pub = createPublicReadToolSurface(ex, {});
    const assumed = await pub.callTool("search_catalog", { query: "serum" });
    const declared = await pub.callTool("search_catalog", { query: "serum", market: "US" });
    assert.equal(ex.calls.length, 1, "one entry for both");
    assert.equal(ex.calls[0].params.payload.search.market, "US");
    assert.equal(assumed.market_assumed.code, "US");
    assert.equal("market_assumed" in declared, false);
    const sg = await pub.callTool("get_product", { product_id: "sig_1", market: "SG" });
    assert.equal("market_assumed" in sg, false);
    const none = await pub.callTool("get_product", { product_id: "sig_1" });
    assert.equal(none.market_assumed.code, "US");
  });
});

// ---- the storefront escalation ----------------------------------------------------------------------------------
const SEED = Object.freeze({
  product_id: "sig_seed_a", title: "Vitamin C Serum", price: 131, currency: "USD",
  external_redirect_url: "https://store.example/products/vitamin-c-serum",
  variants: [{ variant_id: "sig_seed_a", source_variant_id: "44012345678901" }],
});
const ESC = { [UCP_ESCALATION_FLAG]: "1", MERCHANT_PURCHASABILITY_GATE_ENABLED: "1" };
const CREATE = { id: "create_checkout_session", capability: "checkout" };
const GET = { id: "get_checkout_session", capability: "checkout" };
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const seedExecutor = { async execute(op) { return op === "get_product" ? { product: { ...SEED } } : {}; } };
const create = (ucpArgs, gate, env = ESC) => tryEscalateUcpCheckout({
  op: CREATE, params: { idempotency_key: "k", quote: { items: [{ product_id: SEED.product_id, quantity: 1 }] } },
  ctx: {}, executor: seedExecutor, ucpArgs, env, now: NOW, shouldOfferPurchase: gate,
});
const reread = (id, gate, declines, env = ESC) => tryEscalateUcpCheckout({
  op: GET, params: { session_id: id }, ctx: {}, executor: seedExecutor, ucpArgs: { id }, env, now: NOW, shouldOfferPurchase: gate, declines,
});
function recordingGate(answer = () => ({ offer: true, source: "test" })) {
  const asked = [];
  const gate = async (a) => { asked.push(a.market); return answer(a); };
  gate.asked = asked;
  return gate;
}
const ITEMS = [{ product_id: SEED.product_id, quantity: 1 }];
const idBody = (id) => JSON.parse(Buffer.from(id.slice(4), "base64url").toString("utf8"));
const forge = (body) => "esc_" + Buffer.from(JSON.stringify(body), "utf8").toString("base64url");

describe("storefront escalation: the create's market, and the re-read carries it", () => {
  test("escalationRequestMarket: absent/null/blank -> US assumed; anything else is the old reading", () => {
    for (const ctx of [undefined, {}, { address_country: null }, { address_country: "  " }]) {
      assert.deepEqual(escalationRequestMarket(ctx === undefined ? {} : { checkout: { context: ctx } }), { market: "US", assumed: true });
    }
    assert.deepEqual(escalationRequestMarket({ checkout: { context: { address_country: "sg" } } }), { market: "SG", assumed: false });
    assert.deepEqual(escalationRequestMarket({ checkout: { context: { address_country: "USA" } } }), { market: null, assumed: false });
  });

  test("no market: the gate is asked about US, the id carries `a`, and both create and re-read say US assumed", async () => {
    const gate = recordingGate();
    const out = await create({}, gate);
    assert.deepEqual(gate.asked, ["US"]);
    assert.equal(out.market_assumed.code, "US");
    assert.ok(out.messages.some((m) => m.code === "market_assumed"));
    assert.deepEqual(idBody(out.id), { v: 1, i: [[SEED.product_id, 1]], a: 1 });
    const again = await reread(out.id, gate);
    assert.deepEqual(gate.asked, ["US", "US"], "the re-read asks about the market the checkout was created for");
    assert.equal(again.id, out.id);
    assert.equal(again.market_assumed.code, "US");
  });

  test("declared US: the id is byte-identical to the one minted before this change, and the re-read asks about US", async () => {
    const gate = recordingGate();
    const out = await create({ checkout: { context: { address_country: "US" } } }, gate);
    assert.equal(out.id, encodeEscalationId(ITEMS), "no market member for a US create");
    assert.equal("market_assumed" in out, false);
    assert.equal(out.messages.some((m) => m.code === "market_assumed"), false);
    const again = await reread(out.id, gate);
    assert.deepEqual(gate.asked, ["US", "US"]);
    assert.equal("market_assumed" in again, false);
  });

  test("declared SG: the id carries `m: SG` and the re-read asks the gate about SG, not US", async () => {
    const gate = recordingGate();
    const out = await create({ checkout: { context: { address_country: "SG" } } }, gate);
    assert.deepEqual(idBody(out.id), { v: 1, i: [[SEED.product_id, 1]], m: "SG" });
    await reread(out.id, gate);
    assert.deepEqual(gate.asked, ["SG", "SG"]);
    assert.deepEqual(escalationMarketOf(out.id), { market: "SG", assumed: false });
  });

  test("C-03: under an ENFORCING gate a re-read is keyable, so a checkout that passed at create re-reads; one that would not, declines", async () => {
    // The enforcing backend's own rule for a missing market: unkeyable -> decline. Before the id carried the market,
    // every re-read was unkeyable and declined.
    const enforcing = recordingGate((a) => (a.market ? { offer: a.market !== "JP", source: "fact" } : { offer: false, source: "unkeyable_enforced" }));
    const made = await create({ checkout: { context: { address_country: "SG" } } }, enforcing);
    const again = await reread(made.id, enforcing);
    assert.equal(again.status, "requires_escalation");
    const declines = [];
    assert.equal(await reread(forge({ v: 1, i: [[SEED.product_id, 1]], m: "JP" }), enforcing, declines), null);
    assert.deepEqual(declines, ["merchant_not_purchasable"]);
    const err = await refuseUnservedStorefrontCheckout({ op: GET, params: { session_id: forge({ v: 1, i: [[SEED.product_id, 1]], m: "JP" }) }, ctx: {}, executor: seedExecutor, declined: true }).then(() => null, (e) => e);
    assert.equal(err.detail.acp_detail.reason, "ucp_escalation_reread_unconfirmed");
    assert.match(err.detail.acp_message || err.message, /market this checkout was created for/);
  });

  test("an id from before this change (no market member) re-reads as US; a forged market member is no id of ours", () => {
    assert.deepEqual(escalationMarketOf(encodeEscalationId(ITEMS)), { market: "US", assumed: false });
    for (const bad of [{ m: "US" }, { m: "sg" }, { m: "SGP" }, { m: 65 }, { a: 2 }, { a: true }, { a: 1, m: "SG" }]) {
      const id = forge({ v: 1, i: [[SEED.product_id, 1]], ...bad });
      assert.equal(decodeEscalationId(id), null, JSON.stringify(bad));
      assert.equal(escalationMarketOf(id), null, JSON.stringify(bad));
    }
    // a seller-priced (v2) id carries the market the same way
    const v2 = encodeEscalationId(ITEMS, "gid://shopify/Cart/c1", "store.example", { code: "JP", assumed: false });
    assert.deepEqual(escalationMarketOf(v2), { market: "JP", assumed: false });
    assert.deepEqual(decodeEscalationId(v2), ITEMS);
  });
});

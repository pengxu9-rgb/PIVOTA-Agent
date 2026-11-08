import test from "node:test";
import assert from "node:assert/strict";

import { createCommerceToolSurface } from "../src/commerceToolSurface.js";
import { createCanonicalExecutor } from "../../safety-kernel/src/protocol/canonicalExecutor.js";
import { SafetyKernel } from "../../safety-kernel/src/kernel.js";

// FIX_PLAN O-04: `attributeSearchResult`, the commerce surface's per-response hook. The cache stores one
// caller-independent answer; the hook runs on THIS response's own copy, after the cache, so a link minted
// for one caller can never be served to the next. These tests pin the surface's side of that contract
// through a real canonical executor and kernel; the gateway's hook (src/server.js) is driven end to end in
// tests/partner_identity_forwarding_mcp_door.node.test.cjs.

function realSurface({ upstreamResult, hook, cache = true }) {
  const upstreamCalls = [];
  const kernel = new SafetyKernel({
    upstream: async () => ({}),
    secret: "commerce-cache-secret-0123456789",
    log: { info() {}, warn() {}, error() {} },
  });
  const executor = createCanonicalExecutor({
    kernel,
    upstream: async (...args) => {
      upstreamCalls.push(args[0]);
      return structuredClone(upstreamResult);
    },
  });
  const surface = createCommerceToolSurface(executor, { attributeSearchResult: hook, cache });
  return { surface, upstreamCalls };
}

const PAGE = {
  status: "success",
  products: [{ product_id: "ext_1", title: "Serum", destination_url: "https://shop-a.example.com/p/1" }],
};
const ARGS = { query: "serum per response probe" };
const CALLER_A = { user_ref: "user-a", acp_session_id: "sess-a", agent_id: "agent-a" };
const CALLER_B = { user_ref: "user-b", acp_session_id: "sess-b", agent_id: "agent-b" };

function stampingHook() {
  const calls = [];
  let n = 0;
  const hook = async (value, params) => {
    n += 1;
    calls.push({ params: structuredClone(params), before: structuredClone(value) });
    value.products[0].tracking = { click_id: `clk_${n}` };
    // A query secret the sanitizer must scrub: what the hook adds takes the same pass a fresh result took.
    value.products[0].destination_url = `https://shop-a.example.com/p/1?pvt_click_id=clk_${n}&token=leak${n}`;
    return true;
  };
  return { hook, calls };
}

test("cached: each response is stamped on its own copy, and the cache entry stays unstamped", async () => {
  const { hook, calls } = stampingHook();
  const { surface, upstreamCalls } = realSurface({ upstreamResult: PAGE, hook });
  const a = await surface.callTool("search_catalog", ARGS, CALLER_A);
  const b = await surface.callTool("search_catalog", ARGS, CALLER_B);
  assert.equal(upstreamCalls.length, 1, "the second call is a cache hit");
  assert.equal(calls.length, 2, "the hook runs once per response, hit included");
  assert.equal(a.products[0].tracking.click_id, "clk_1");
  assert.equal(b.products[0].tracking.click_id, "clk_2");
  assert.equal(calls[1].before.products[0].tracking, undefined, "the hit's copy was never stamped for caller A");
  assert.equal(calls[0].params.payload.search.query, ARGS.query, "the hook sees the allowlisted params");
  for (const [r, n] of [[a, 1], [b, 2]]) {
    assert.ok(!r.products[0].destination_url.includes(`leak${n}`), "the stamped value is sanitized again");
    assert.ok(r.products[0].destination_url.includes(`pvt_click_id=clk_${n}`));
  }
});

test("uncached: the fresh result is stamped too", async () => {
  const { hook, calls } = stampingHook();
  const { surface, upstreamCalls } = realSurface({ upstreamResult: PAGE, hook, cache: false });
  const a = await surface.callTool("search_catalog", ARGS, CALLER_A);
  const b = await surface.callTool("search_catalog", ARGS, CALLER_B);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual([a.products[0].tracking.click_id, b.products[0].tracking.click_id], ["clk_1", "clk_2"]);
});

test("a hook that changes nothing (false) leaves the answer exactly as without a hook", async () => {
  const none = realSurface({ upstreamResult: PAGE });
  const noop = realSurface({ upstreamResult: PAGE, hook: async () => false });
  assert.deepEqual(
    await noop.surface.callTool("search_catalog", ARGS, CALLER_A),
    await none.surface.callTool("search_catalog", ARGS, CALLER_A),
  );
});

test("a hook that throws costs the caller nothing but its stamp", async () => {
  const none = realSurface({ upstreamResult: PAGE });
  const boom = realSurface({ upstreamResult: PAGE, hook: async () => { throw new Error("mint down"); } });
  assert.deepEqual(
    await boom.surface.callTool("search_catalog", ARGS, CALLER_A),
    await none.surface.callTool("search_catalog", ARGS, CALLER_A),
  );
});

test("only search_catalog is handed to the hook", async () => {
  const seen = [];
  const { surface } = realSurface({
    upstreamResult: { status: "success", products: [{ product_id: "p1" }], product: { product_id: "p1" } },
    hook: async (value) => { seen.push(value); return false; },
  });
  await surface.callTool("get_product", { product_id: "p1", merchant_id: "m1" }, CALLER_A).catch(() => {});
  assert.equal(seen.length, 0);
  await surface.callTool("search_catalog", ARGS, CALLER_A);
  assert.equal(seen.length, 1);
});

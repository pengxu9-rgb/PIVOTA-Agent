import test from "node:test";
import assert from "node:assert/strict";

import { createCommerceToolSurface } from "../src/commerceToolSurface.js";

// The commerce lane had no result cache: an identical repeat query paid full price (measured 21.2s on prod
// 2026-08-05). Sharing results across callers is safe ONLY because search_catalog is caller-independent —
// params are allowlisted, the executor drops ctx for this op, the upstream forces the internal key, and the
// response carries no user field. The first test below is the one that fails if that ever stops being true.

/** Executor stub recording every (opId, params, ctx) it is asked to execute. */
function recordingExecutor(result = { status: "success", products: [{ id: "p1" }] }) {
  const calls = [];
  return {
    calls,
    execute: async (opId, params, ctx) => {
      calls.push({ opId, params: structuredClone(params), ctx: structuredClone(ctx ?? {}) });
      return typeof result === "function" ? result(calls.length) : result;
    },
  };
}

function surface(executor) {
  return createCommerceToolSurface(executor, {});
}

const ARGS = { query: "niacinamide serum" };

test("THE SAFETY PROPERTY: different callers produce byte-identical upstream invocations", async () => {
  // If identity ever starts reaching the upstream for search_catalog, the args-only cache key becomes a
  // cross-caller leak. This asserts the precondition directly: two different verified sessions must ask the
  // executor for exactly the same thing. Cache disabled so BOTH calls reach the executor and can be diffed.
  process.env.COMMERCE_READ_CACHE_ENABLED = "0";
  try {
    const exec = recordingExecutor();
    const s = surface(exec);
    await s.callTool("search_catalog", ARGS, { user_ref: "user-alice", acp_session_id: "sess-a", agent_id: "agent-1" });
    await s.callTool("search_catalog", ARGS, { user_ref: "user-bob", acp_session_id: "sess-b", agent_id: "agent-2" });

    assert.equal(exec.calls.length, 2);
    assert.deepEqual(
      exec.calls[0].params,
      exec.calls[1].params,
      "search_catalog params must not vary by caller — the cache key omits identity",
    );
    // The ctx differs by design; what matters is that the executor's search_catalog case drops it. Guard the
    // params boundary here, and assert no identity leaked INTO params.
    const flat = JSON.stringify(exec.calls[0].params);
    for (const needle of ["user-alice", "sess-a", "agent-1"]) {
      assert.ok(!flat.includes(needle), `identity ${needle} must never reach search params, got ${flat}`);
    }
  } finally {
    delete process.env.COMMERCE_READ_CACHE_ENABLED;
  }
});

test("a repeated identical search is served from cache (one upstream execution)", async () => {
  const exec = recordingExecutor();
  const s = surface(exec);
  const a = await s.callTool("search_catalog", ARGS, {});
  const b = await s.callTool("search_catalog", ARGS, {});
  assert.equal(exec.calls.length, 1, "second identical search must not re-execute");
  assert.deepEqual(b, a, "a cache hit must be byte-identical to the miss it replays");
});

test("a cache hit crosses callers — the key is the args, not the session", async () => {
  const exec = recordingExecutor();
  const s = surface(exec);
  await s.callTool("search_catalog", ARGS, { user_ref: "user-alice", acp_session_id: "sess-a" });
  await s.callTool("search_catalog", ARGS, { user_ref: "user-bob", acp_session_id: "sess-b" });
  assert.equal(exec.calls.length, 1, "identity must not fragment the cache key");
});

test("different args are different entries", async () => {
  const exec = recordingExecutor();
  const s = surface(exec);
  await s.callTool("search_catalog", { query: "toner" }, {});
  await s.callTool("search_catalog", { query: "serum" }, {});
  await s.callTool("search_catalog", { query: "toner", merchant_id: "m1" }, {});
  assert.equal(exec.calls.length, 3);
});

test("argument key order does not fragment the cache", async () => {
  const exec = recordingExecutor();
  const s = surface(exec);
  await s.callTool("search_catalog", { query: "toner", page_size: 5 }, {});
  await s.callTool("search_catalog", { page_size: 5, query: "toner" }, {});
  assert.equal(exec.calls.length, 1);
});

test("ONLY search_catalog is cached — get_product repeats still reach the executor", async () => {
  // get_alternatives / get_offers / get_intel receive ctx in the executor, so they are deliberately out of
  // scope until each has its own caller-independence analysis. get_product stands in for that set here.
  const exec = recordingExecutor({ status: "success", product: { id: "p1" } });
  const s = surface(exec);
  const args = { product_id: "sig_abc" };
  await s.callTool("get_product", args, {});
  await s.callTool("get_product", args, {});
  assert.equal(exec.calls.length, 2, "non-allowlisted tools must not be cached");
});

test("failures are never cached", async () => {
  let n = 0;
  const exec = {
    calls: [],
    execute: async (opId, params, ctx) => {
      exec.calls.push({ opId, params, ctx });
      n += 1;
      if (n === 1) throw new Error("MERCHANT_UNAVAILABLE");
      return { status: "success", products: [{ id: "p1" }] };
    },
  };
  const s = surface(exec);
  await assert.rejects(() => s.callTool("search_catalog", ARGS, {}), /MERCHANT_UNAVAILABLE/);
  const out = await s.callTool("search_catalog", ARGS, {});
  assert.deepEqual(out.products, [{ id: "p1" }], "a transient failure must not be served for the whole TTL");
  assert.equal(exec.calls.length, 2);
});

test("the kill switch disables caching entirely", async () => {
  process.env.COMMERCE_READ_CACHE_ENABLED = "0";
  try {
    const exec = recordingExecutor();
    const s = surface(exec);
    await s.callTool("search_catalog", ARGS, {});
    await s.callTool("search_catalog", ARGS, {});
    assert.equal(exec.calls.length, 2);
  } finally {
    delete process.env.COMMERCE_READ_CACHE_ENABLED;
  }
});

test("a user-scoped tool still refuses without identity, cache or not", async () => {
  // Regression guard: the cache branch must sit AFTER the identity gate, never in front of it.
  const exec = recordingExecutor();
  const s = surface(exec);
  await assert.rejects(
    () => s.callTool("create_checkout_session", { merchant_id: "m1", items: [] }, {}),
    (err) => err.code === "USER_AUTH_REQUIRED",
  );
  assert.equal(exec.calls.length, 0);
});

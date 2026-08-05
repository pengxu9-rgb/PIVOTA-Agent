import test from "node:test";
import assert from "node:assert/strict";

import { createCommerceToolSurface } from "../src/commerceToolSurface.js";
import { createCanonicalExecutor } from "../../safety-kernel/src/protocol/canonicalExecutor.js";
import { SafetyKernel } from "../../safety-kernel/src/kernel.js";

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

test("THE SAFETY PROPERTY: different callers produce byte-identical UPSTREAM invocations", async () => {
  // This is the assertion the whole cache rests on. It runs through a REAL canonical executor and records
  // at the UPSTREAM seam — the last point before the request leaves this process — because that is where
  // the property has to hold. Asserting against a stubbed executor instead would stub out the very layer
  // that can break it: the executor's search_catalog case is what drops ctx, and a one-line change there
  // (`{...payload, buyer_ref: ctx.user_ref}`) is the most plausible way this cache becomes a leak.
  // Cache disabled so BOTH calls reach the upstream and can be diffed.
  process.env.COMMERCE_READ_CACHE_ENABLED = "0";
  try {
    const seen = [];
    const kernel = new SafetyKernel({
      upstream: async () => ({}),
      secret: "commerce-cache-secret-0123456789",
      log: { info() {}, warn() {}, error() {} },
    });
    const executor = createCanonicalExecutor({
      kernel,
      upstream: async (op, payload) => {
        seen.push({ op, payload: structuredClone(payload) });
        return { status: "success", products: [{ id: "p1" }] };
      },
    });
    const s = createCommerceToolSurface(executor, {});

    await s.callTool("search_catalog", ARGS, { user_ref: "user-alice", acp_session_id: "sess-a", agent_id: "agent-1" });
    await s.callTool("search_catalog", ARGS, { user_ref: "user-bob", acp_session_id: "sess-b", agent_id: "agent-2" });

    assert.equal(seen.length, 2);
    assert.equal(seen[0].op, seen[1].op, "both callers must hit the same upstream op");
    assert.deepEqual(
      seen[0].payload,
      seen[1].payload,
      "upstream payload must not vary by caller — the cache key omits identity",
    );
    const flat = JSON.stringify(seen[0]);
    for (const needle of ["user-alice", "sess-a", "agent-1"]) {
      assert.ok(!flat.includes(needle), `identity ${needle} must never reach the upstream, got ${flat}`);
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

test("junk arguments cannot mint cache keys or evict real entries", async () => {
  // Nothing rejects unknown argument properties, so keying on the RAW tool args would let any caller mint
  // unlimited distinct keys for one identical upstream call — a 0% hit rate, and enough junk requests to
  // evict every real entry. The key is the allowlisted params, so junk is already gone by then.
  const exec = recordingExecutor();
  const s = surface(exec);
  for (let i = 0; i < 5; i += 1) {
    await s.callTool("search_catalog", { ...ARGS, _cb: `nonce-${i}`, tracking: i }, {});
  }
  assert.equal(exec.calls.length, 1, "unknown args must not fragment the cache key");
});

test("a degraded upstream envelope is not pinned for the TTL", async () => {
  // The upstream returns its body UNTHROWN when ok !== true, so "errors are never cached" is not enough:
  // a soft failure would otherwise be replayed to every caller for the full window.
  let n = 0;
  const exec = {
    calls: [],
    execute: async (opId, params, ctx) => {
      exec.calls.push({ opId, params, ctx });
      n += 1;
      return n === 1
        ? { ok: false, error: { code: "SEARCH_DEGRADED" }, products: [] }
        : { status: "success", products: [{ id: "p1" }] };
    },
  };
  const s = surface(exec);
  const first = await s.callTool("search_catalog", ARGS, {});
  assert.equal(first.ok, false, "the degraded answer is still returned to the caller who caused it");
  const second = await s.callTool("search_catalog", ARGS, {});
  assert.deepEqual(second.products, [{ id: "p1" }], "the next caller must not be served the degraded body");
  assert.equal(exec.calls.length, 2);
});

test("a legitimately empty result IS still cached", async () => {
  // Absence of an error, not presence of products, is the test — a real search that matched nothing is a
  // valid answer and re-running it costs the same seconds as any other.
  const exec = recordingExecutor({ status: "success", success: true, products: [], total: 0 });
  const s = surface(exec);
  await s.callTool("search_catalog", { query: "no such product xyzzy" }, {});
  await s.callTool("search_catalog", { query: "no such product xyzzy" }, {});
  assert.equal(exec.calls.length, 1);
});

test("one caller cannot mutate another caller's cached result", async () => {
  // Cached values are handed to every later caller. If they shared one object reference, a consumer
  // editing a row in place would serve the edit to everyone for the rest of the TTL.
  const exec = recordingExecutor();
  const s = surface(exec);
  const a = await s.callTool("search_catalog", ARGS, {});
  a.products[0].title = "ATTACKER CONTROLLED";
  a.injected = true;
  const b = await s.callTool("search_catalog", ARGS, {});
  assert.notEqual(b, a, "a hit must not be the same object reference as a previous caller's result");
  assert.equal(b.injected, undefined, "a later caller must not see a field another caller added");
  assert.notEqual(b.products[0].title, "ATTACKER CONTROLLED");
});

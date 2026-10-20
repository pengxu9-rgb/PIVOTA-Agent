// The measurement fields a tools/call hands the gateway's completion line (src/toolCallOutcome.js), and the
// cache's per-call state observer they rely on. The door-level wiring is pinned end to end by
// tests/mcp_tool_call_outcome_log.node.test.cjs; this file pins the pure pieces and the stale branch, which a
// route test cannot reach without a clock.

import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadCache } from "../src/publicReadCache.js";
import { createRemoteMcpAdapter } from "../src/remoteMcpAdapter.js";
import { ToolValidationError, UnknownToolError } from "../src/commerceToolSurface.js";
import {
  cacheHitField,
  describeToolError,
  describeUpstreamEnvelope,
  noteToolCall,
  resultCountOf,
  toolErrorFieldsOf,
} from "../src/toolCallOutcome.js";

test("cache onState reports miss, hit and stale, in that order, and never changes what is served", async () => {
  let t = 0;
  let calls = 0;
  const cache = createPublicReadCache({ ttlMs: 1000, staleMs: 5000, now: () => t });
  const compute = async () => { calls += 1; return { n: calls }; };
  const states = [];
  const onState = (s) => states.push(s);
  assert.deepEqual(await cache.getOrCompute("k", compute, { onState }), { n: 1 });
  t += 500;
  assert.deepEqual(await cache.getOrCompute("k", compute, { onState }), { n: 1 });
  t += 1000;
  assert.deepEqual(await cache.getOrCompute("k", compute, { onState }), { n: 1 }, "stale serves the old value");
  assert.deepEqual(states, ["miss", "hit", "stale"]);
});

test("a throwing cache observer is ignored", async () => {
  const cache = createPublicReadCache({});
  const value = await cache.getOrCompute("k", async () => 7, { onState: () => { throw new Error("observer"); } });
  assert.equal(value, 7);
});

test("cacheHitField maps the cache's words onto the log field", () => {
  assert.deepEqual(cacheHitField("hit"), { cache_hit: true });
  assert.deepEqual(cacheHitField("stale"), { cache_hit: "stale" });
  assert.deepEqual(cacheHitField("miss"), { cache_hit: false });
  assert.deepEqual(cacheHitField("other"), {});
});

test("resultCountOf counts the primary list and omits non-list results", () => {
  assert.deepEqual(resultCountOf({ products: [1, 2, 3] }), { result_count: 3 });
  assert.deepEqual(resultCountOf({ products: [] }), { result_count: 0 });
  assert.deepEqual(resultCountOf({ offers: [1] }), { result_count: 1 });
  assert.deepEqual(resultCountOf({ alternatives: [1, 2] }), { result_count: 2 });
  assert.deepEqual(resultCountOf({ products: [1], offers: [1, 2] }), { result_count: 1 }, "products wins");
  assert.deepEqual(resultCountOf({ product_id: "p" }), {});
  assert.deepEqual(resultCountOf(null), {});
});

test("describeUpstreamEnvelope reports degradation markers and lane tokens, never free text", () => {
  assert.deepEqual(
    describeUpstreamEnvelope({
      status: "success", success: true, products: [1],
      metadata: { primary_lane: "lane_a", query_source: "source_b", route_health: { fallback_triggered: false } },
    }),
    { lane: "lane_a", lane_source: "source_b" },
  );
  assert.deepEqual(
    describeUpstreamEnvelope({ status: "failed", success: false, products: [1, 2] }),
    { upstream_degraded: true, upstream_status: "failed" },
  );
  assert.deepEqual(describeUpstreamEnvelope({ status: "success", success: false }), { upstream_degraded: true });
  assert.deepEqual(describeUpstreamEnvelope({ ok: false }), { upstream_degraded: true });
  assert.deepEqual(describeUpstreamEnvelope({ error: "boom" }), { upstream_degraded: true });
  assert.deepEqual(describeUpstreamEnvelope({ error: "" }), {}, "an empty error is not degradation");
  for (const metadata of [
    { route_health: { fallback_triggered: true } },
    { family_fallback_used: true },
    { source_breakdown: { stale_cache_used: true } },
  ]) {
    assert.equal(describeUpstreamEnvelope({ status: "success", metadata }).fallback_used, true, JSON.stringify(metadata));
  }
  // A lane value that is not a short token (a sentence, a query) is dropped, not truncated.
  const free = describeUpstreamEnvelope({ metadata: { primary_lane: "a query with spaces", query_source: "x".repeat(65) } });
  assert.deepEqual(free, {});
  // A status that is not a token still marks degradation but is not echoed.
  assert.deepEqual(describeUpstreamEnvelope({ status: "went very wrong" }), { upstream_degraded: true });
});

test("describeToolError reads only the upstream timeout flag", () => {
  assert.deepEqual(describeToolError({ detail: { upstream_timeout: true, message: "secret" } }), { upstream_timeout: true });
  assert.deepEqual(describeToolError({ detail: { upstream_timeout: "yes" } }), {});
  assert.deepEqual(describeToolError(new Error("x")), {});
});

test("toolErrorFieldsOf reads the code, and the retriable flag when declared, back off the formatted result", () => {
  const text = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });
  assert.deepEqual(toolErrorFieldsOf(text({ code: "UNKNOWN_PRODUCT_ID", retriable: false })), {
    error_code: "UNKNOWN_PRODUCT_ID", error_retriable: false,
  });
  assert.deepEqual(toolErrorFieldsOf(text({ code: "MERCHANT_UNAVAILABLE", retriable: true })), {
    error_code: "MERCHANT_UNAVAILABLE", error_retriable: true,
  });
  assert.deepEqual(toolErrorFieldsOf(text({ code: "UNKNOWN_TOOL" })), { error_code: "UNKNOWN_TOOL" });
  assert.deepEqual(toolErrorFieldsOf({ content: [{ text: "not json" }] }), { error_code: "UNEXPECTED_ERROR" });
  assert.deepEqual(toolErrorFieldsOf(text({ code: "lower case", retriable: "yes" })), { error_code: "UNEXPECTED_ERROR" });
});

test("noteToolCall swallows a throwing sink and ignores a missing one", () => {
  noteToolCall(() => { throw new Error("sink"); }, { a: 1 });
  noteToolCall(undefined, { a: 1 });
});

test("noteToolCall evaluates a field thunk inside its guard, and not at all without a sink", () => {
  let evaluated = 0;
  noteToolCall(undefined, () => { evaluated += 1; return { a: 1 }; });
  assert.equal(evaluated, 0);
  const seen = [];
  noteToolCall((f) => seen.push(f), () => { throw new Error("derivation"); });
  noteToolCall((f) => seen.push(f), () => ({ a: 2 }));
  assert.deepEqual(seen, [{ a: 2 }]);
});

// ---- the adapter hands the sink the caller-visible facts, and passes nothing when there is no sink ----

function surfaceReturning(fn) {
  const seen = [];
  return {
    seen,
    tools: [{ name: "t", inputSchema: { type: "object" } }],
    callTool: async (...args) => { seen.push(args); return fn(...args); },
  };
}

const rpc = (name) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

test("adapter: success reports the result count; the surface may add its own fields through the forwarded sink", async () => {
  const surface = surfaceReturning((_n, _a, _c, opts) => {
    opts.observe({ cache_hit: true });
    return { products: [1, 2] };
  });
  const adapter = createRemoteMcpAdapter(surface, { allowUnauthenticated: true });
  const fields = [];
  await adapter.handleJsonRpc({ body: rpc("t"), observe: (f) => fields.push(f) });
  assert.deepEqual(Object.assign({}, ...fields), { cache_hit: true, tool_registered: true, result_count: 2 });
});

test("adapter: a thrown tool error reports the wire code and the timeout flag", async () => {
  const err = new ToolValidationError("bad", "INVALID_ARGUMENTS");
  err.detail = { upstream_timeout: true };
  const surface = surfaceReturning(() => { throw err; });
  const adapter = createRemoteMcpAdapter(surface, { allowUnauthenticated: true });
  const fields = [];
  const out = await adapter.handleJsonRpc({ body: rpc("t"), observe: (f) => fields.push(f) });
  assert.equal(out.body.result.isError, true);
  assert.deepEqual(Object.assign({}, ...fields), {
    tool_registered: true, error_code: "INVALID_ARGUMENTS", upstream_timeout: true,
  });
});

test("adapter: a non-curated error is logged as the generic code the caller saw", async () => {
  const surface = surfaceReturning(() => { throw new Error("raw upstream detail"); });
  const adapter = createRemoteMcpAdapter(surface, { allowUnauthenticated: true });
  const fields = [];
  await adapter.handleJsonRpc({ body: rpc("t"), observe: (f) => fields.push(f) });
  assert.deepEqual(Object.assign({}, ...fields), { tool_registered: true, error_code: "UNEXPECTED_ERROR" });
});

test("adapter: an unknown tool is reported as not registered", async () => {
  const surface = surfaceReturning((name) => { throw new UnknownToolError(name); });
  const adapter = createRemoteMcpAdapter(surface, { allowUnauthenticated: true });
  const fields = [];
  await adapter.handleJsonRpc({ body: rpc("made_up"), observe: (f) => fields.push(f) });
  assert.deepEqual(Object.assign({}, ...fields), { tool_registered: false, error_code: "UNKNOWN_TOOL" });
});

test("adapter: without a sink the surface is called with exactly the three arguments it always got", async () => {
  const surface = surfaceReturning(() => ({ products: [] }));
  const adapter = createRemoteMcpAdapter(surface, { allowUnauthenticated: true });
  await adapter.handleJsonRpc({ body: rpc("t") });
  assert.equal(surface.seen[0].length, 3);
});

test("adapter: a throwing sink never changes the answer", async () => {
  const surface = surfaceReturning(() => ({ products: [1] }));
  const adapter = createRemoteMcpAdapter(surface, { allowUnauthenticated: true });
  const out = await adapter.handleJsonRpc({ body: rpc("t"), observe: () => { throw new Error("sink"); } });
  assert.equal(out.status, 200);
  assert.ok(out.body.result);
});

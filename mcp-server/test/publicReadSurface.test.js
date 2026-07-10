import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadToolSurface, PUBLIC_READ_TOOL_NAMES } from "../src/publicReadToolSurface.js";
import { createRemoteMcpAdapter } from "../src/remoteMcpAdapter.js";

function fakeExecutor(calls) {
  return {
    async execute(opId, params, ctx) {
      calls.push({ opId, params, ctx });
      return { ok: true, op: opId };
    },
  };
}

function publicAdapter(surface) {
  return createRemoteMcpAdapter(surface, {
    allowUnauthenticated: true,
    serverInfo: { name: "pivota", version: "1.0.0" },
    supportedProtocolVersions: ["2025-03-26", "2025-06-18"],
    resolveSessionContext: () => ({}),
  });
}

test("public surface exposes exactly the four read tools", () => {
  const surface = createPublicReadToolSurface(fakeExecutor([]));
  assert.deepEqual(
    surface.tools.map((t) => t.name).sort(),
    [...PUBLIC_READ_TOOL_NAMES].sort()
  );
  for (const tool of surface.tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === "object");
  }
});

test("tools outside the allowlist do not exist on the public surface", async () => {
  const calls = [];
  const surface = createPublicReadToolSurface(fakeExecutor(calls));
  const refused = [
    "create_checkout_session",
    "update_checkout_session",
    "get_checkout_session",
    "complete_checkout_session",
    "create_payment_link",
    "cancel_checkout_session",
    "get_order",
    "request_after_sales",
    "get_offers", // deliberately off the v1 surface (reseller-sourced offers)
    "not_a_tool",
  ];
  for (const name of refused) {
    await assert.rejects(surface.callTool(name, {}), (err) => err.code === "UNKNOWN_TOOL");
  }
  assert.equal(calls.length, 0, "refused tools must never reach the executor");
});

test("read calls run anonymously and strip model-supplied identity", async () => {
  const calls = [];
  const surface = createPublicReadToolSurface(fakeExecutor(calls));
  const result = await surface.callTool("search_catalog", {
    query: "niacinamide serum",
    user_ref: "model-supplied-identity",
    acp_session_id: "model-supplied-session",
  });
  assert.deepEqual(result, { ok: true, op: "search_catalog" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opId, "search_catalog");
  assert.equal(calls[0].ctx.user_ref, undefined);
  assert.equal(calls[0].ctx.acp_session_id, undefined);
  const search = calls[0].params?.payload?.search || {};
  assert.equal(search.query, "niacinamide serum");
  assert.ok(!("user_ref" in search));
  assert.ok(!("acp_session_id" in search));
});

test("unauthenticated initialize negotiates the protocol version", async () => {
  const adapter = publicAdapter(createPublicReadToolSurface(fakeExecutor([])));
  const echoed = await adapter.handleJsonRpc({
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
  });
  assert.equal(echoed.status, 200);
  assert.equal(echoed.body.result.protocolVersion, "2025-06-18");
  assert.equal(echoed.body.result.serverInfo.name, "pivota");

  const fallback = await adapter.handleJsonRpc({
    body: { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
  });
  assert.equal(fallback.body.result.protocolVersion, "2025-03-26");
});

test("unauthenticated tools/list and tools/call work; commerce tool call errors clean", async () => {
  const calls = [];
  const adapter = publicAdapter(createPublicReadToolSurface(fakeExecutor(calls)));

  const list = await adapter.handleJsonRpc({ body: { jsonrpc: "2.0", id: 3, method: "tools/list" } });
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.result.tools.map((t) => t.name).sort(),
    [...PUBLIC_READ_TOOL_NAMES].sort()
  );

  const call = await adapter.handleJsonRpc({
    body: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_product", arguments: { merchant_id: "m1", product_id: "p1" } },
    },
  });
  assert.equal(call.status, 200);
  assert.notEqual(call.body.result.isError, true);
  assert.deepEqual(JSON.parse(call.body.result.content[0].text), { ok: true, op: "get_product" });

  const refused = await adapter.handleJsonRpc({
    body: {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "create_checkout_session", arguments: {} },
    },
  });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.result.isError, true);
  assert.equal(JSON.parse(refused.body.result.content[0].text).error.code, "UNKNOWN_TOOL");

  assert.deepEqual(calls.map((c) => c.opId), ["get_product"]);
});

test("notifications/initialized is accepted without auth", async () => {
  const adapter = publicAdapter(createPublicReadToolSurface(fakeExecutor([])));
  const out = await adapter.handleJsonRpc({
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.equal(out.status, 202);
  assert.equal(out.body, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { createCommerceToolSurface } from "../src/commerceToolSurface.js";
import { createRemoteMcpAdapter } from "../src/remoteMcpAdapter.js";

function rpc(method, params = {}, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

function toolText(out) {
  return JSON.parse(out.body.result.content[0].text);
}

test("remote MCP tools/call binds identity/session from verified request context, never tool args", async () => {
  let seen;
  const surface = createCommerceToolSurface({
    async execute(opId, params, ctx) {
      seen = { opId, params, ctx };
      return { session_id: "quote_1", status: "ready_for_payment" };
    },
  });
  const adapter = createRemoteMcpAdapter(surface, {
    allowUnauthenticated: true,
    resolveSessionContext: (req) => req.sessionContext,
  });

  const out = await adapter.handleJsonRpc({
    sessionContext: { user_ref: "user_verified", acp_session_id: "sess_verified", agent_id: "gemini" },
    body: rpc("tools/call", {
      name: "create_checkout_session",
      arguments: {
        idempotency_key: "idem-remote-001",
        user_ref: "user_attacker",
        acp_session_id: "sess_attacker",
        quote: {
          merchant_id: "m1",
          items: [{ product_id: "p1", quantity: 1, amount: 999999 }],
        },
      },
    }),
  });

  assert.equal(out.status, 200);
  assert.equal(toolText(out).session_id, "quote_1");
  assert.equal(seen.opId, "create_checkout_session");
  assert.deepEqual(seen.ctx, { user_ref: "user_verified", acp_session_id: "sess_verified", agent_id: "gemini" });
  assert.equal(seen.params.user_ref, undefined);
  assert.equal(seen.params.acp_session_id, undefined);
  assert.equal(seen.params.quote.items[0].amount, undefined, "model-set money fields must not enter canonical params");
});

test("remote MCP write without verified buyer/session returns a non-leaky tool error result", async () => {
  let called = false;
  const surface = createCommerceToolSurface({
    async execute() {
      called = true;
      return {};
    },
  });
  const adapter = createRemoteMcpAdapter(surface, {
    allowUnauthenticated: true,
    resolveSessionContext: () => ({}),
  });

  const out = await adapter.handleJsonRpc({
    body: rpc("tools/call", {
      name: "create_checkout_session",
      arguments: {
        idempotency_key: "idem-remote-002",
        quote: { merchant_id: "m1", items: [{ product_id: "p1", quantity: 1 }] },
      },
    }),
  });

  assert.equal(out.status, 200);
  assert.equal(out.body.result.isError, true);
  assert.match(out.body.result.content[0].text, /USER_AUTH_REQUIRED/);
  assert.equal(called, false);
});

test("remote MCP adapter refuses unauthenticated construction unless explicitly allowed", () => {
  const surface = createCommerceToolSurface({ async execute() { return {}; } });
  assert.throws(() => createRemoteMcpAdapter(surface), /authenticate\(\) or allowUnauthenticated/);
});

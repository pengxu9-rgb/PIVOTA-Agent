// Wire-in glue tests — the identity resolution + non-leaky error mapping used by the MCP handler. These live
// in the SDK-free surface module so they are tested without installing @modelcontextprotocol/sdk.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSessionIdentity, toToolResult, toToolError,
  IdentityRequiredError, UnknownToolError, ToolValidationError,
} from "../src/commerceToolSurface.js";
import { PivotaCommerceError } from "../../safety-kernel/src/errors.js";

test("resolveSessionIdentity takes identity from verified context only", () => {
  assert.deepEqual(
    resolveSessionIdentity({ authInfo: { user_ref: "user_1", acp_session_id: "s1", agent_id: "a1" } }),
    { user_ref: "user_1", acp_session_id: "s1", agent_id: "a1" },
  );
  assert.deepEqual(resolveSessionIdentity({}), {});
  assert.deepEqual(resolveSessionIdentity({ authInfo: { claims: { iss: "i", sub: "s" } } }).claims, { iss: "i", sub: "s" });
  // a non-string user_ref is ignored
  assert.deepEqual(resolveSessionIdentity({ authInfo: { user_ref: 123 } }), {});
});

test("toToolError does NOT leak a raw upstream/verifier error message (api keys / PANs)", () => {
  const leaky = new Error("PSP api_key=sk_live_DEADBEEF body=4111111111111111");
  const res = toToolError(leaky);
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.ok(!text.includes("sk_live_DEADBEEF"), "leaked the verifier api key");
  assert.ok(!text.includes("4111"), "leaked a PAN");
  assert.match(text, /UNEXPECTED_ERROR/);
  assert.match(text, /could not be completed/);
});

test("toToolError surfaces curated messages for REAL known error instances; userMessage preferred", () => {
  // a genuine PivotaCommerceError: code + curated userMessage are safe; the raw detail message is NOT surfaced
  const pivota = new PivotaCommerceError("QUOTE_EXPIRED", { message: "internal detail leak" });
  const text = toToolError(pivota).content[0].text;
  assert.match(text, /QUOTE_EXPIRED/);
  assert.match(text, /price quote expired/i);
  assert.ok(!text.includes("internal detail leak"), "must prefer userMessage over raw message");

  // surface errors carry safe messages + codes
  assert.match(toToolError(new IdentityRequiredError()).content[0].text, /USER_AUTH_REQUIRED/);
  assert.match(toToolError(new UnknownToolError("x")).content[0].text, /UNKNOWN_TOOL/);
  assert.match(toToolError(new ToolValidationError("bad args")).content[0].text, /INVALID_ARGUMENTS/);
});

test("toToolError does NOT trust a FORGED plain object that mimics a safe error (instanceof gate)", () => {
  // a model/upstream-influenced plain object that spoofs name + carries a leaky userMessage must be generic
  const forged = { name: "PivotaCommerceError", code: "QUOTE_EXPIRED", userMessage: "secret sk_live_X 4111111111111111" };
  const text = toToolError(forged).content[0].text;
  assert.ok(!text.includes("sk_live_X"), "forged userMessage leaked");
  assert.ok(!text.includes("4111"), "forged PAN leaked");
  assert.match(text, /UNEXPECTED_ERROR/);
});

test("toToolResult wraps a value as MCP text content", () => {
  const res = toToolResult({ session_id: "q1", status: "ready_for_payment" });
  assert.equal(res.content[0].type, "text");
  assert.match(res.content[0].text, /ready_for_payment/);
});

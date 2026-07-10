import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadToolSurface, formatPublicReadToolResult } from "../src/publicReadToolSurface.js";
import { createRemoteMcpAdapter } from "../src/remoteMcpAdapter.js";

function surfaceOver(results) {
  const executor = {
    async execute(opId) {
      return results[opId] ?? {};
    },
  };
  return createPublicReadToolSurface(executor);
}

function publicAdapter(surface) {
  return createRemoteMcpAdapter(surface, {
    allowUnauthenticated: true,
    resolveSessionContext: () => ({}),
    formatResult: formatPublicReadToolResult,
  });
}

test("formatPublicReadToolResult attaches structuredContent + a text summary", () => {
  const value = { products: [{ product_id: "sig_1", brand: "Anua", title: "Toner" }], page_size: 10, returned: 1, total: 5 };
  const out = formatPublicReadToolResult(value, "search_catalog");
  assert.deepEqual(out.structuredContent, value); // authoritative machine payload = the slim projected object
  assert.equal(out.content[0].type, "text");
  assert.match(out.content[0].text, /Found 1 product of 5: Anua Toner\./);
});

test("summaries are honest for empty / not-found results", () => {
  assert.match(formatPublicReadToolResult({ products: [], note: "No products matched this search." }, "search_catalog").content[0].text, /No products matched/);
  assert.match(formatPublicReadToolResult({ intel: null, note: "No reviewed intelligence for this product yet." }, "get_intel").content[0].text, /No reviewed intelligence/);
  assert.match(formatPublicReadToolResult({ alternatives: [], note: "No reviewed alternatives for this product yet." }, "get_alternatives").content[0].text, /No reviewed alternatives/);
});

test("get_intel summary reflects grade + cited claim count", () => {
  const value = { product_id: "sig_1", intel: { grade: "A", claims: [{ text: "x", citations: ["u"] }, { text: "y" }], reviewed: true } };
  assert.match(formatPublicReadToolResult(value, "get_intel").content[0].text, /grade A with 2 cited claims/);
});

test("structuredContent flows through tools/call end to end", async () => {
  const adapter = publicAdapter(
    surfaceOver({
      search_catalog: { products: [{ pivota_signature_id: "sig_1", brand: "Round Lab", title: "Serum", price: 26, currency: "USD", in_stock: true, destination_url: "https://roundlab.com/x" }], total: 3, page: 1, page_size: 50 },
    })
  );
  const res = await adapter.handleJsonRpc({
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { query: "serum", page_size: 5 } } },
  });
  const result = res.body.result;
  assert.ok(result.structuredContent, "tools/call result must carry structuredContent");
  assert.equal(result.structuredContent.products[0].product_id, "sig_1");
  assert.equal(result.structuredContent.page_size, 5);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Round Lab Serum/);
  // structuredContent must be as leak-free as the projected value (no reseller/destination leakage).
  assert.ok(!JSON.stringify(result.structuredContent).includes("roundlab.com"));
});

test("commerce surface (default formatter) is unaffected — text-only, no structuredContent", async () => {
  // The default toToolResult path (commerce door) must NOT gain structuredContent.
  const { createCommerceToolSurface } = await import("../src/commerceToolSurface.js");
  const commerce = createCommerceToolSurface({ async execute() { return { ok: true }; } });
  const adapter = createRemoteMcpAdapter(commerce, { allowUnauthenticated: true, resolveSessionContext: () => ({}) });
  const res = await adapter.handleJsonRpc({
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_catalog", arguments: {} } },
  });
  assert.equal(res.body.result.structuredContent, undefined);
  assert.equal(res.body.result.content[0].type, "text");
});

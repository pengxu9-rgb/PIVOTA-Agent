// search_catalog refuses an over-long query at the tool surface, with an argument error the agent can act on.
//
// The invoke route rejects the same query with 400 QUERY_TOO_LONG (src/findProductsMulti/queryLengthCap.js),
// but a 400 that reaches the kernel's upstream mapping surfaces as MERCHANT_UNAVAILABLE / retriable:true, and a
// retried over-long query is refused identically, forever. So every MCP door (native, public read, UCP — all
// three build their params through commerceToolSurface's toParams) refuses it before the executor runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { SafetyKernel } from "../../safety-kernel/src/kernel.js";
import { createCanonicalExecutor } from "../../safety-kernel/src/protocol/canonicalExecutor.js";
import { createCommerceToolSurface, commerceToolDefinitions } from "../src/commerceToolSurface.js";

const require = createRequire(import.meta.url);
const { DEFAULT_MAX_CHARS } = require("../../src/findProductsMulti/queryLengthLimit.js");

const quiet = { info() {}, warn() {}, error() {} };

function setup() {
  const kernel = new SafetyKernel({ upstream: async () => ({}), secret: "query-length-secret-0123456789ab", log: quiet });
  const reads = [];
  const executor = createCanonicalExecutor({
    kernel,
    upstream: async (op, payload) => { reads.push({ op, payload }); return { ok: true, products: [] }; },
    localReads: {},
    verifyPaymentAuthorization: async () => ({ ok: false }),
  });
  return { surface: createCommerceToolSurface(executor, { cache: false }), reads };
}

test("an over-long search_catalog query is refused before any search call, naming the limit", async () => {
  const { surface, reads } = setup();
  await assert.rejects(
    surface.callTool("search_catalog", { query: "a".repeat(DEFAULT_MAX_CHARS + 1) }, {}),
    (e) =>
      e.name === "ToolValidationError" &&
      e.code === "INVALID_ARGUMENTS" &&
      e.message.includes(`${DEFAULT_MAX_CHARS + 1} characters`) &&
      e.message.includes(`the limit is ${DEFAULT_MAX_CHARS}`),
  );
  assert.equal(reads.length, 0);
});

test("a query at the limit is searched", async () => {
  const { surface, reads } = setup();
  await surface.callTool("search_catalog", { query: `lip gloss ${"a".repeat(DEFAULT_MAX_CHARS - 10)}` }, {});
  assert.equal(reads.length, 1);
});

test("the advertised schema states the limit it enforces", () => {
  const searchCatalog = commerceToolDefinitions.find((t) => t.name === "search_catalog");
  assert.equal(searchCatalog.inputSchema.properties.query.maxLength, DEFAULT_MAX_CHARS);
});

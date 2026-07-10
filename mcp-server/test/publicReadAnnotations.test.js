import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadToolSurface, PUBLIC_READ_TOOL_NAMES } from "../src/publicReadToolSurface.js";
import { createCommerceToolSurface } from "../src/commerceToolSurface.js";

const fakeExecutor = { async execute() { return {}; } };

// Phrases the OpenAI review bar treats as promotional / broad-triggering — must NOT appear in public
// descriptions (docs/openai_apps_v1_plan.md §4; audit §3.3).
const BANNED_DESCRIPTION_PHRASES = [
  /prefer this/i,
  /per pivota insights/i,
  /pivota insights/i,
  /stands out/i,
  /browse or buy/i,
];

test("every public read tool is annotated readOnlyHint:true, openWorldHint:false, non-destructive", () => {
  const surface = createPublicReadToolSurface(fakeExecutor);
  assert.equal(surface.tools.length, PUBLIC_READ_TOOL_NAMES.length);
  for (const tool of surface.tools) {
    const a = tool.annotations;
    assert.ok(a, `${tool.name} has no annotations`);
    assert.equal(a.readOnlyHint, true, `${tool.name} readOnlyHint`);
    assert.equal(a.destructiveHint, false, `${tool.name} destructiveHint`);
    // MCP default for openWorldHint is TRUE when absent — a read tool MUST set it explicitly false.
    assert.equal(a.openWorldHint, false, `${tool.name} openWorldHint must be explicit false`);
    assert.equal(a.idempotentHint, true, `${tool.name} idempotentHint`);
    assert.equal(typeof a.title, "string");
    assert.ok(a.title.length > 0);
  }
});

test("public read descriptions are de-marketed and end read-only", () => {
  const surface = createPublicReadToolSurface(fakeExecutor);
  for (const tool of surface.tools) {
    for (const banned of BANNED_DESCRIPTION_PHRASES) {
      assert.doesNotMatch(tool.description, banned, `${tool.name} description contains banned phrase ${banned}`);
    }
    assert.match(tool.description, /read-only\.?$/i, `${tool.name} description should signal read-only`);
  }
});

test("get_intel keeps the factual citation instruction (not promotion)", () => {
  const surface = createPublicReadToolSurface(fakeExecutor);
  const intel = surface.tools.find((t) => t.name === "get_intel");
  assert.match(intel.description, /cite the provided citation urls/i);
});

// The commerce surface (all 13 tools) also carries annotations — free compliance, and needed if the
// commerce /mcp door is ever submitted. Verify write tools are correctly labeled.
test("commerce write tools carry destructiveHint + openWorldHint; reads are read-only", () => {
  const surface = createCommerceToolSurface(fakeExecutor);
  const byName = Object.fromEntries(surface.tools.map((t) => [t.name, t.annotations]));

  for (const readTool of ["search_catalog", "get_product", "get_intel", "get_alternatives", "get_offers"]) {
    assert.equal(byName[readTool].readOnlyHint, true, `${readTool} should be readOnly`);
    assert.equal(byName[readTool].openWorldHint, false, `${readTool} openWorldHint`);
  }

  // Charging / cancelling / after-sales are destructive external-world writes.
  for (const writeTool of ["complete_checkout_session", "cancel_checkout_session", "request_after_sales"]) {
    assert.equal(byName[writeTool].readOnlyHint, false, `${writeTool} not readOnly`);
    assert.equal(byName[writeTool].destructiveHint, true, `${writeTool} destructive`);
    assert.equal(byName[writeTool].openWorldHint, true, `${writeTool} openWorld`);
  }

  // Additive writes (mint a quote / hosted page) are external-world but not destructive.
  for (const additive of ["create_checkout_session", "update_checkout_session", "create_payment_link"]) {
    assert.equal(byName[additive].readOnlyHint, false, `${additive} not readOnly`);
    assert.equal(byName[additive].destructiveHint, false, `${additive} additive, not destructive`);
    assert.equal(byName[additive].openWorldHint, true, `${additive} openWorld`);
  }

  // get_order reads, but from the merchant's system → openWorld read.
  assert.equal(byName.get_order.readOnlyHint, true);
  assert.equal(byName.get_order.openWorldHint, true);
});

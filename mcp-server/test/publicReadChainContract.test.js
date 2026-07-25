// The search -> get_product chain contract: an id the public surface advertises must be one get_product can
// resolve. Measured broken on prod 2026-07-25 (22 of 99 results across 14 queries were unresolvable ids; for
// "serum", 9 of the top 10), which also made pivota-protocol's conformance suite red.

import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadToolSurface } from "../src/publicReadToolSurface.js";

// A search row shaped like the raw find_products_multi rows the filter sees (pre-projection).
function row(id, extra = {}) {
  return {
    pivota_signature_id: id,
    product_id: id,
    title: `Title ${id}`,
    brand: "Brand",
    price: 10,
    currency: "USD",
    ...extra,
  };
}

function executorReturning(products, { onCall } = {}) {
  return {
    async execute(opId, params) {
      if (onCall) onCall(opId, params);
      return { products, total: 75, page: 1 };
    },
  };
}

// Resolvable = anything whose id starts with sig_live. Everything else is a dead id.
const filterLiveOnly = async (rows) => {
  const kept = rows.filter((r) => String(r.pivota_signature_id || "").startsWith("sig_live"));
  return { kept, droppedCount: rows.length - kept.length };
};

test("search_catalog drops ids that detail cannot resolve", async () => {
  const surface = createPublicReadToolSurface(
    executorReturning([row("sig_live_a"), row("sig_dead_b"), row("sig_live_c")]),
    { filterChainResolvableRows: filterLiveOnly },
  );
  const out = await surface.callTool("search_catalog", { query: "serum", page_size: 10 });
  assert.deepEqual(
    out.products.map((p) => p.product_id),
    ["sig_live_a", "sig_live_c"],
    "the unresolvable id must not be advertised",
  );
});

test("filtering backfills the page from the deeper pool instead of shrinking it", async () => {
  // 9 dead rows ranked above 11 live ones — the measured "serum" shape. A filter applied after the page was
  // already cut to 10 would return 1 result; applied before the slice it must return a full page of 10.
  const products = [
    ...Array.from({ length: 9 }, (_, i) => row(`sig_dead_${i}`)),
    ...Array.from({ length: 11 }, (_, i) => row(`sig_live_${i}`)),
  ];
  const surface = createPublicReadToolSurface(executorReturning(products), {
    filterChainResolvableRows: filterLiveOnly,
  });
  const out = await surface.callTool("search_catalog", { query: "serum", page_size: 10 });
  assert.equal(out.products.length, 10, "page must backfill to the requested size");
  assert.ok(
    out.products.every((p) => p.product_id.startsWith("sig_live")),
    "no dead id may survive the backfill",
  );
});

test("upstream is asked for the over-fetch ceiling, not the caller's page_size", async () => {
  const seen = [];
  const surface = createPublicReadToolSurface(
    executorReturning([row("sig_live_a")], { onCall: (_op, params) => seen.push(params) }),
    { filterChainResolvableRows: filterLiveOnly },
  );
  await surface.callTool("search_catalog", { query: "serum", page_size: 3 });
  assert.equal(
    seen[0]?.payload?.search?.page_size,
    20,
    "must over-fetch so the filter has rows to backfill from",
  );
});

test("caller's page_size still bounds the returned page", async () => {
  const surface = createPublicReadToolSurface(
    executorReturning(Array.from({ length: 20 }, (_, i) => row(`sig_live_${i}`))),
    { filterChainResolvableRows: filterLiveOnly },
  );
  const out = await surface.callTool("search_catalog", { query: "serum", page_size: 3 });
  assert.equal(out.products.length, 3, "over-fetch must not leak into the caller's page size");
});

test("no filter injected leaves the result exactly as before", async () => {
  const surface = createPublicReadToolSurface(
    executorReturning([row("sig_live_a"), row("sig_dead_b")]),
  );
  const out = await surface.callTool("search_catalog", { query: "serum", page_size: 10 });
  assert.equal(out.products.length, 2, "the filter is opt-in; without it behaviour is unchanged");
});

test("a filter that throws must not blank the search (fail-open is the caller's job, errors propagate)", async () => {
  // The injected production filter swallows per-row errors and keeps the row. This pins that the surface does
  // not silently turn a filter fault into an empty page by catching it here.
  const surface = createPublicReadToolSurface(executorReturning([row("sig_live_a")]), {
    filterChainResolvableRows: async () => {
      throw new Error("db down");
    },
  });
  await assert.rejects(
    () => surface.callTool("search_catalog", { query: "serum", page_size: 10 }),
    /db down/,
  );
});

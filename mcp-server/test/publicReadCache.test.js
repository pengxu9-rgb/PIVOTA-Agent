import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadCache, stableStringify } from "../src/publicReadCache.js";
import { createPublicReadToolSurface } from "../src/publicReadToolSurface.js";

test("stableStringify is key-order independent and array-order sensitive", () => {
  assert.equal(stableStringify({ a: 1, b: [2, { c: 3 }] }), stableStringify({ b: [2, { c: 3 }], a: 1 }));
  assert.notEqual(stableStringify({ a: [1, 2] }), stableStringify({ a: [2, 1] }));
});

test("fresh hit serves from cache without recompute", async () => {
  let t = 0;
  let calls = 0;
  const cache = createPublicReadCache({ ttlMs: 1000, staleMs: 5000, now: () => t });
  const compute = async () => { calls += 1; return { n: calls }; };
  assert.deepEqual(await cache.getOrCompute("k", compute), { n: 1 });
  t += 500;
  assert.deepEqual(await cache.getOrCompute("k", compute), { n: 1 });
  assert.equal(calls, 1);
});

test("stale hit serves stale immediately and revalidates once in background", async () => {
  let t = 0;
  let calls = 0;
  const cache = createPublicReadCache({ ttlMs: 1000, staleMs: 5000, now: () => t });
  const compute = async () => { calls += 1; return { n: calls }; };
  await cache.getOrCompute("k", compute); // n:1 cached at t=0
  t = 2000; // stale window
  const [a, b] = await Promise.all([
    cache.getOrCompute("k", compute),
    cache.getOrCompute("k", compute),
  ]);
  assert.deepEqual(a, { n: 1 }, "stale served immediately");
  assert.deepEqual(b, { n: 1 });
  await new Promise((r) => setTimeout(r, 10)); // let background revalidation land
  assert.equal(calls, 2, "single-flight: exactly one background refresh");
  assert.deepEqual(await cache.getOrCompute("k", compute), { n: 2 }, "refreshed value now fresh");
});

test("failed background revalidation keeps the stale entry", async () => {
  let t = 0;
  let failures = 0;
  const cache = createPublicReadCache({
    ttlMs: 1000, staleMs: 5000, now: () => t,
    onRevalidateError: () => { failures += 1; },
  });
  let shouldFail = false;
  const compute = async () => { if (shouldFail) throw new Error("upstream down"); return { ok: true }; };
  await cache.getOrCompute("k", compute);
  t = 2000;
  shouldFail = true;
  assert.deepEqual(await cache.getOrCompute("k", compute), { ok: true }, "stale served");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(failures, 1);
  assert.deepEqual(await cache.getOrCompute("k", compute), { ok: true }, "stale entry survived the failed refresh");
});

test("expired entry recomputes inline; compute errors propagate and are never cached", async () => {
  let t = 0;
  let calls = 0;
  const cache = createPublicReadCache({ ttlMs: 1000, staleMs: 5000, now: () => t });
  const compute = async () => { calls += 1; if (calls === 2) throw new Error("boom"); return { n: calls }; };
  await cache.getOrCompute("k", compute);
  t = 10_000; // beyond staleMs
  await assert.rejects(cache.getOrCompute("k", compute), /boom/);
  assert.deepEqual(await cache.getOrCompute("k", compute), { n: 3 }, "error was not cached");
});

test("LRU bounds the map", async () => {
  const cache = createPublicReadCache({ ttlMs: 1000, staleMs: 5000, maxEntries: 3, now: () => 0 });
  for (let i = 0; i < 10; i += 1) await cache.getOrCompute(`k${i}`, async () => i);
  assert.ok(cache.size() <= 3);
});

test("surface integration: identical search args hit the cache, different args do not", async () => {
  let executions = 0;
  const surface = createPublicReadToolSurface({
    async execute() {
      executions += 1;
      return { products: [{ pivota_signature_id: "sig_1", brand: "Anua", title: "Toner", destination_url: "https://anua.com/x" }] };
    },
  });
  await surface.callTool("search_catalog", { query: "toner", page_size: 5 });
  await surface.callTool("search_catalog", { page_size: 5, query: "toner" }); // same args, different key order
  assert.equal(executions, 1, "second identical call served from cache");
  await surface.callTool("search_catalog", { query: "serum", page_size: 5 });
  assert.equal(executions, 2, "different query recomputes");
});

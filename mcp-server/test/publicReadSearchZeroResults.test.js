// Regression suite for the two mechanisms that made ordinary searches answer
// "No products matched this search." on the public read tier (measured live on
// prod 2026-08-20 against mcp.pivota.cc).
//
// MECHANISM 2 (this file): the projected-result cache keyed on the RAW tool
// arguments and stored empty pages. `{"query":"makeup remover"}` returned 0
// products in 0.17s while `"makeup remover "` and `"MAKEUP REMOVER"` returned
// the same ten products in the same second — three cache entries for one
// question, any of which could be pinned to a transient zero for 10 minutes
// fresh and 60 minutes stale.
//
// MECHANISM 1 (category browse discarding the query text) lives in the SQL
// helper and is pinned in tests/canonical_catalog_search.test.js.
//
// Every test here drives BOTH sides of the contract: the variant that used to
// work AND the variant that used to fail, so a fix that only special-cases one
// spelling cannot pass.

import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadToolSurface } from "../src/publicReadToolSurface.js";
import { EMPTY_SEARCH_NOTES } from "../src/publicReadProjection.js";

const ROW = {
  pivota_signature_id: "sig_makeup_remover_1",
  brand: "Missha",
  title: "Perfect Lip & Eye Makeup Remover",
  price: 12,
  currency: "USD",
  in_stock: true,
  canonical_url: "https://www.missha.com/products/lip-eye-remover",
};

// An executor that records the query string it was actually asked for, so a
// test can assert what crossed the boundary rather than only what came back.
function recordingExecutor(seen, resultFor = () => ({ products: [ROW] })) {
  return {
    async execute(opId, params) {
      const query = params?.payload?.search?.query;
      seen.push(query);
      return resultFor(query, seen.length);
    },
  };
}

function productTitles(value) {
  return (value.products || []).map((p) => p.title);
}

test("whitespace and case variants of one query return the SAME non-empty result set", async () => {
  const seen = [];
  const surface = createPublicReadToolSurface(recordingExecutor(seen));

  const variants = [
    "makeup remover",
    "makeup remover ",
    " makeup remover",
    "  makeup   remover  ",
    "MAKEUP REMOVER",
    "Makeup Remover",
  ];

  const results = [];
  for (const query of variants) {
    results.push(await surface.callTool("search_catalog", { query }));
  }

  const baseline = productTitles(results[0]);
  assert.ok(baseline.length > 0, "the fixture must return products, or this test proves nothing");
  for (let i = 0; i < variants.length; i += 1) {
    assert.deepEqual(
      productTitles(results[i]),
      baseline,
      `variant ${JSON.stringify(variants[i])} returned a different result set`,
    );
    assert.equal(results[i].returned, baseline.length);
    assert.ok(!("note" in results[i]), "a non-empty page must carry no empty-note");
  }

  // The whole point of collapsing the key: one upstream call serves them all.
  // Six entries would mean six independent chances to pin a transient zero.
  assert.equal(seen.length, 1, `expected one upstream call, got ${seen.length}: ${JSON.stringify(seen)}`);
});

test("the query crossing the boundary is whitespace-canonical, with case preserved", async () => {
  const seen = [];
  const surface = createPublicReadToolSurface(recordingExecutor(seen));

  await surface.callTool("search_catalog", { query: "  Vitamin   C   Serum  " });
  assert.equal(
    seen[0],
    "Vitamin C Serum",
    "leading/trailing/doubled whitespace must be collapsed before the lane sees the query",
  );

  // Case is deliberately NOT lowercased upstream — it reaches lanes this tier
  // does not own. Only the cache KEY folds case.
  assert.ok(/[A-Z]/.test(seen[0]), "upstream query must keep the caller's casing");
});

test("an empty search page decays fast — a transient zero cannot outlive the shopper", async () => {
  process.env.PUBLIC_READ_EMPTY_TTL_MS = "1";
  const seen = [];
  // First call answers empty (a transient lane failure), every later call answers normally.
  const surface = createPublicReadToolSurface(
    recordingExecutor(seen, (_query, n) => (n === 1 ? { products: [] } : { products: [ROW] })),
  );
  delete process.env.PUBLIC_READ_EMPTY_TTL_MS;

  const first = await surface.callTool("search_catalog", { query: "makeup remover" });
  assert.equal(first.returned, 0, "fixture precondition: the first call is the transient zero");

  await new Promise((r) => setTimeout(r, 15)); // past the 1ms empty TTL
  const second = await surface.callTool("search_catalog", { query: "makeup remover" });
  assert.deepEqual(
    productTitles(second),
    [ROW.title],
    "the empty was still being served after its TTL — a zero must never be pinned",
  );
  assert.equal(seen.length, 2, "an expired empty must recompute");

  // And the good answer IS cached on the normal clock, so this is a targeted short lease and not a cache
  // that stopped working.
  const third = await surface.callTool("search_catalog", { query: "makeup remover" });
  assert.deepEqual(productTitles(third), [ROW.title]);
  assert.equal(seen.length, 2, "a non-empty page must still be served from cache");
});

test("within its short TTL an empty IS reused — a zero-result flood collapses to one lane run", async () => {
  // The other half of the contract. Refusing to cache empties outright removes caching from the ~27-33%
  // of live queries that currently return nothing, and hands an anonymous caller a free recompute of an
  // 8-15s lane on every request. The lease must be SHORT, not absent.
  const seen = [];
  const surface = createPublicReadToolSurface(recordingExecutor(seen, () => ({ products: [] })));
  for (let i = 0; i < 5; i += 1) await surface.callTool("search_catalog", { query: "no such product" });
  assert.equal(seen.length, 1, `5 identical zero-result calls ran the lane ${seen.length} times`);
});

test("an empty is never served STALE — that is the confident false negative itself", async () => {
  // publicReadCache serves a stale entry immediately and revalidates in the background. For an empty page
  // that means answering "no products exist" from an expired guess. The empty policy sets staleMs === ttlMs
  // so the stale window is zero-width and an expired empty always recomputes inline.
  const { createPublicReadCache } = await import("../src/publicReadCache.js");
  let t = 0;
  let computes = 0;
  const cache = createPublicReadCache({
    ttlMs: 1000,
    staleMs: 60_000,
    now: () => t,
    cachePolicy: (v) => (v.empty ? { ttlMs: 100, staleMs: 100 } : { ttlMs: 1000, staleMs: 60_000 }),
  });
  const compute = async () => { computes += 1; return { empty: true }; };
  await cache.getOrCompute("k", compute);
  t = 500; // past the empty ttl AND past its stale window, but well inside the global stale window
  await cache.getOrCompute("k", compute);
  assert.equal(computes, 2, "an expired empty was served stale instead of recomputed");
});

test("a degraded upstream envelope is never cached, even carrying products", async () => {
  const seen = [];
  const surface = createPublicReadToolSurface(
    recordingExecutor(seen, (_query, n) =>
      n === 1 ? { ok: false, error: "STAGE_TIMEOUT", products: [ROW] } : { products: [ROW] },
    ),
  );

  await surface.callTool("search_catalog", { query: "toner" });
  await surface.callTool("search_catalog", { query: "toner" });
  assert.equal(seen.length, 2, "a degraded (ok:false) answer must not be pinned for the TTL");
});

// ---- honest empties --------------------------------------------------------------------------------------
// "No products matched this search." is a claim about the CATALOG. An agent
// relays it to the shopper as "no such products exist". It may only be emitted
// when the lane ran and genuinely matched nothing.

test("a genuine zero still says so, and labels itself no_match", async () => {
  const surface = createPublicReadToolSurface(recordingExecutor([], () => ({ products: [] })));
  const out = await surface.callTool("search_catalog", { query: "obviously nonexistent product" });
  assert.equal(out.returned, 0);
  assert.equal(out.empty_reason, "no_match");
  assert.equal(out.note, EMPTY_SEARCH_NOTES.no_match);
  assert.match(out.note, /No products matched this search\./);
});

test("a degraded lane must NOT be renderable as a definitive negative", async () => {
  const surface = createPublicReadToolSurface(
    recordingExecutor([], () => ({ ok: false, error: "STAGE_TIMEOUT", products: [] })),
  );
  const out = await surface.callTool("search_catalog", { query: "hyaluronic acid" });
  assert.equal(out.returned, 0);
  assert.equal(out.empty_reason, "upstream_degraded");
  // The mutant this kills: falling back to the generic note for any empty page.
  assert.notEqual(out.note, EMPTY_SEARCH_NOTES.no_match);
  assert.doesNotMatch(
    out.note,
    /No products matched this search\./,
    "a lane failure must never assert that nothing matched",
  );
  assert.match(out.note, /could not be completed/i);
});

test("an empty caused by this tier's OWN filters says so, not that nothing matched", async () => {
  // Reseller-sourced rows: the upstream matched, the first-party sourcing
  // filter removes every one of them. The products exist; this tier will not
  // show them. Saying "no products matched" here is a false negative.
  const resellerRow = {
    ...ROW,
    pivota_signature_id: "sig_reseller_1",
    canonical_url: "https://www.yesstyle.com/en/missha-remover/info.html/pid.1",
  };
  const surface = createPublicReadToolSurface(recordingExecutor([], () => ({ products: [resellerRow] })));

  const out = await surface.callTool("search_catalog", { query: "makeup remover" });
  assert.equal(out.returned, 0, "fixture precondition: the sourcing filter must empty this page");
  assert.equal(out.empty_reason, "filtered_out");
  assert.notEqual(out.note, EMPTY_SEARCH_NOTES.no_match);
  assert.doesNotMatch(
    out.note,
    /No products matched this search\./,
    "rows this tier filtered out must not be reported as an absence in the catalog",
  );
  assert.match(out.note, /coverage limit of this surface/i);
});

// ---- gaps found by review: predicates that were correct but freely mutable ---------------------------------

test("degradation OUTRANKS filtering when a degraded lane still carries rows", async () => {
  // The ternary order in computeTool is load-bearing and was asserted only by its own comment: no fixture
  // set both conditions, so swapping the branches passed the whole suite. A degraded lane carrying rows
  // must not be reported as "products matched, we removed them" — the lane never answered.
  const surface = createPublicReadToolSurface(
    recordingExecutor([], () => ({
      ok: false,
      error: "STAGE_TIMEOUT",
      products: [{ ...ROW, canonical_url: "https://www.yesstyle.com/en/x/info.html/pid.1" }],
    })),
  );
  const out = await surface.callTool("search_catalog", { query: "toner" });
  assert.equal(out.returned, 0);
  assert.equal(out.empty_reason, "upstream_degraded");
});

// Every degraded fixture used {ok:false, error:"..."} — two flags at once, so no single disjunct was
// pinned and `success:false` was entirely dead. One case per envelope flavour, the disjunctive twin of
// the repo's "audit EVERY conjunct in a gating predicate" rule.
for (const [label, envelope] of [
  ["status not success", { status: "error", products: [] }],
  ["success:false", { success: false, products: [] }],
  ["ok:false", { ok: false, products: [] }],
  ["truthy error", { error: "STAGE_TIMEOUT", products: [] }],
]) {
  test(`degradation is detected from ${label} on its own`, async () => {
    const surface = createPublicReadToolSurface(recordingExecutor([], () => envelope));
    const out = await surface.callTool("search_catalog", { query: "toner" });
    assert.equal(out.empty_reason, "upstream_degraded", `${label} was not read as degraded`);
  });
}

// The real live envelope is {status:"success", success:true} with NO ok and NO error key. If this stops
// being read as healthy, the whole tier stops caching and every search runs cold.
test("the REAL live envelope shape is healthy, and falsy error fields are not degradation", async () => {
  for (const envelope of [
    { status: "success", success: true, products: [ROW] },
    { status: "SUCCESS", products: [ROW] },
    { error: null, products: [ROW] },
    { error: "", products: [ROW] },
    { error: false, products: [ROW] },
  ]) {
    const seen = [];
    const surface = createPublicReadToolSurface(recordingExecutor(seen, () => envelope));
    const out = await surface.callTool("search_catalog", { query: "serum" });
    assert.equal(out.returned, 1, `${JSON.stringify(envelope)} was misread as degraded`);
    await surface.callTool("search_catalog", { query: "serum" });
    assert.equal(seen.length, 1, `${JSON.stringify(envelope)} was not cached — misread as degraded`);
  }
});

test("junk arguments cannot mint a fresh cache entry", async () => {
  // The key is derived from the executor's own allowlist, so a field the lane never sees cannot split the
  // key. Before this, {query:"serum", __nonce:i} bought a full cold lane run per call.
  const seen = [];
  const surface = createPublicReadToolSurface(recordingExecutor(seen));
  for (let i = 0; i < 5; i += 1) {
    await surface.callTool("search_catalog", { query: "serum", __nonce: i, tracking_id: `t${i}` });
  }
  assert.equal(seen.length, 1, `junk args minted ${seen.length} entries`);
});

test("the key's NEGATIVE half: meaningfully different queries must NOT share an entry", async () => {
  // Every other key test asserts that variants COLLAPSE. Without this, over-normalizing the key (stripping
  // punctuation, say) would pass everything while serving one query's products for another.
  const seen = [];
  const surface = createPublicReadToolSurface(recordingExecutor(seen));
  for (const query of ["vitamin c", "vitamin-c", "vitaminc", "l'oreal", "loreal", "vitamin b"]) {
    await surface.callTool("search_catalog", { query });
  }
  assert.equal(seen.length, 6, `distinct queries collapsed: ${JSON.stringify(seen)}`);

  // Paging must stay distinct too — a shared entry here would serve the wrong slice.
  const paged = [];
  const s2 = createPublicReadToolSurface(recordingExecutor(paged));
  await s2.callTool("search_catalog", { query: "serum", page_size: 5 });
  await s2.callTool("search_catalog", { query: "serum", page_size: 10 });
  await s2.callTool("search_catalog", { query: "serum", page: 2, page_size: 10 });
  assert.equal(paged.length, 3, "page/page_size must remain part of the key");
});

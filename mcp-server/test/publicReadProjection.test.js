import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  projectSearchCatalog,
  projectGetProduct,
  projectGetIntel,
  projectGetAlternatives,
  projectPublicReadResult,
  findLeakedFields,
  DENYLIST_FIELDS,
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_RESULTS,
} from "../src/publicReadProjection.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");

// ---- a real live search response (8 real products incl. reseller rows, full internal fields) -------------
// Trimmed from the 698 KB / 50-product prod capture (docs/openai_apps_audit.md §5) to keep the fixture light
// while preserving every internal field name and the reseller (ulta.com) rows the denylist must catch.

const liveSearchRaw = JSON.parse(readFileSync(join(HERE, "fixtures/live_search_raw.json"), "utf8"));

test("projected live search carries NO denylisted field and NO timestamp", () => {
  const projected = projectSearchCatalog(liveSearchRaw, { limit: 10 });
  const leaks = findLeakedFields(projected);
  assert.deepEqual(leaks, [], `leaked: ${leaks.join(", ")}`);
});

test("projected live search collapses a bloated multi-product response within budget and cap", () => {
  const rawBytes = bytes(liveSearchRaw);
  const projected = projectSearchCatalog(liveSearchRaw, { limit: 10 });
  assert.ok(rawBytes > 100_000, `sanity: fixture should be the bloated raw response, got ${rawBytes}`);
  assert.ok(projected.products.length <= 10);
  assert.ok(bytes(projected) <= MAX_RESPONSE_BYTES, `projected ${bytes(projected)} > ${MAX_RESPONSE_BYTES}`);
  // Real slimming: at least a 90% cut versus the raw response.
  assert.ok(bytes(projected) < rawBytes * 0.1, `expected >90% cut; ${bytes(projected)} vs ${rawBytes}`);
});

test("projected search product exposes only the allowlisted keys", () => {
  const projected = projectSearchCatalog(liveSearchRaw, { limit: 5 });
  const allowed = new Set([
    "product_id", "brand", "title", "category", "price", "availability",
    "image_url", "key_actives", "pivota_url",
  ]);
  for (const p of projected.products) {
    for (const k of Object.keys(p)) {
      assert.ok(allowed.has(k), `unexpected key on product: ${k}`);
    }
    // price, when present, is exactly {amount, currency?}
    if (p.price) {
      assert.equal(typeof p.price.amount, "number");
      for (const k of Object.keys(p.price)) assert.ok(["amount", "currency"].includes(k));
    }
    assert.ok(["in_stock", "out_of_stock", "unknown"].includes(p.availability));
  }
});

test("search honors the requested limit and hard-caps at MAX_SEARCH_RESULTS", () => {
  const available = (liveSearchRaw.products || []).length;
  assert.equal(projectSearchCatalog(liveSearchRaw, { limit: 3 }).products.length, 3);
  // Default is min(available, 10); the fixture has fewer than the default.
  assert.equal(projectSearchCatalog(liveSearchRaw, {}).products.length, Math.min(available, 10));
  assert.ok(projectSearchCatalog(liveSearchRaw, { limit: 999 }).products.length <= MAX_SEARCH_RESULTS);
});

test("pivota_url is always a Pivota canonical URL, never a reseller/merchant URL", () => {
  const projected = projectSearchCatalog(liveSearchRaw, { limit: 10 });
  for (const p of projected.products) {
    if (p.pivota_url) {
      assert.doesNotMatch(p.pivota_url, /ulta\.com|shopify|myshopify/i, `reseller URL leaked: ${p.pivota_url}`);
    }
  }
});

test("empty search returns a note, not an error shape", () => {
  const projected = projectSearchCatalog({ products: [] });
  assert.deepEqual(projected.products, []);
  assert.equal(typeof projected.note, "string");
});

// ---- get_product -----------------------------------------------------------------------------------------

test("get_product projects detail + decision, drops merchant routing + diagnostics", () => {
  const raw = {
    product: {
      pivota_signature_id: "sig_abc",
      merchant_id: "external_seed", // must be dropped
      brand: "Anua",
      title: "Heartleaf Toner",
      product_type: "Toner",
      price: 18,
      currency: "USD",
      in_stock: true,
      image_url: "https://anua.com/a.jpg",
      images: ["https://anua.com/a.jpg", "https://anua.com/b.jpg"],
      description: "x".repeat(2000), // must be clamped
      active_ingredients: ["Heartleaf Extract", "Panthenol"],
      pivota_canonical_url: "https://agent.pivota.cc/products/sig_abc",
      catalog_source: "canonical_citation", // diagnostic; must be dropped
      readiness_tier: "referral_only", // diagnostic; must be dropped
      decision: {
        why_it_stands_out: [{ headline: "Soothing", body: "Calms redness" }],
        best_for: [{ label: "sensitive skin" }],
        evidence_profile: "moderate",
        evidence: { grade: "b", claims: [{ claim_text: "reduces redness", evidence_grade: "B", source_refs: ["https://pubmed.example/1"] }] },
      },
    },
  };
  const p = projectGetProduct(raw);
  assert.equal(p.product_id, "sig_abc");
  assert.ok(!("merchant_id" in p));
  assert.deepEqual(p.price, { amount: 18, currency: "USD" });
  assert.ok(p.description.length <= 600);
  assert.equal(p.decision.grade, "B");
  assert.equal(p.decision.claims[0].text, "reduces redness");
  assert.deepEqual(findLeakedFields(p), []);
});

test("get_product not-found returns a note", () => {
  assert.equal(typeof projectGetProduct({}).note, "string");
});

// ---- get_intel -------------------------------------------------------------------------------------------

test("get_intel projects the decision signal with claims; strips envelope diagnostics", () => {
  const raw = {
    subject: { kind: "product", id: "sig_xyz" },
    signals: [
      {
        signal_type: "decision",
        subject: { kind: "product", id: "sig_xyz" },
        value: {
          why_it_stands_out: [{ headline: "High niacinamide", body: "5% concentration" }],
          best_for: [{ label: "dark spots", tag: "hyperpigmentation" }],
          evidence_profile: "strong",
        },
        evidence: {
          grade: "A",
          claims: [{ claim_text: "niacinamide fades dark spots", evidence_grade: "A", source_refs: ["https://pubmed.ncbi.nlm.nih.gov/1"] }],
        },
        freshness: { observed_at: "2026-07-01T00:00:00Z" }, // timestamp must NOT survive
        review_state: "human_approved",
        visibility: "buyer_safe",
      },
    ],
    metadata: { kb_key: "product:sig_xyz", source: "kb" }, // must be dropped
  };
  const out = projectGetIntel(raw);
  assert.equal(out.product_id, "sig_xyz");
  assert.equal(out.intel.reviewed, true);
  assert.equal(out.intel.grade, "A");
  assert.equal(out.intel.claims[0].citations[0], "https://pubmed.ncbi.nlm.nih.gov/1");
  assert.equal(out.pivota_url, "https://agent.pivota.cc/products/sig_xyz");
  assert.deepEqual(findLeakedFields(out), [], "no diagnostics/timestamps survive");
});

test("get_intel with no signal returns intel:null + honest note", () => {
  const out = projectGetIntel({ subject: { kind: "product", id: "sig_none" }, signals: [], metadata: { reason: "not_found" } });
  assert.equal(out.intel, null);
  assert.equal(typeof out.note, "string");
  assert.deepEqual(findLeakedFields(out), []);
});

// ---- get_alternatives ------------------------------------------------------------------------------------

test("get_alternatives projects alternatives with price comparison; strips edge internals", () => {
  const raw = {
    subject: { kind: "product", id: "sig_anchor" },
    signals: [
      {
        signal_type: "alternative",
        subject: { kind: "product", id: "sig_anchor" },
        value: {
          related: { ref: "sig_alt", title: "Cheaper Serum", brand: "Good Molecules", price: 12, currency: "USD", image_url: "https://x/y.jpg" },
          relation: "competitive_alternative",
          score: 0.9,
          price_comparison: { price_ratio: 0.75 },
          tradeoffs: ["lower concentration"],
          watchouts: ["contains fragrance"],
          why: "similar actives, lower price",
        },
        label: "Budget pick",
        evidence: { grade: "B", sources: ["https://roundlab.com/x"], confidence: null, method: "crawled" },
        freshness: { observed_at: "2026-07-01T00:00:00Z", fresh_until: "2026-08-01T00:00:00Z" },
        review_state: "human_approved",
        visibility: "buyer_safe",
      },
    ],
    metadata: { relation_types: ["competitive_alternative"], edge_count: 1 },
  };
  const out = projectGetAlternatives(raw);
  assert.equal(out.anchor.product_id, "sig_anchor");
  assert.equal(out.alternatives.length, 1);
  const a = out.alternatives[0];
  assert.equal(a.product_id, "sig_alt");
  assert.deepEqual(a.price, { amount: 12, currency: "USD" });
  assert.equal(a.price_vs_anchor, "-25%");
  assert.equal(a.grade, "B");
  assert.equal(a.citations[0], "https://roundlab.com/x");
  assert.deepEqual(findLeakedFields(out), [], "no score/candidate_snapshot/timestamps survive");
});

test("get_alternatives empty returns a note", () => {
  const out = projectGetAlternatives({ subject: { kind: "product", id: "s" }, signals: [] });
  assert.deepEqual(out.alternatives, []);
  assert.equal(typeof out.note, "string");
});

test("get_alternatives never serves an amount without its currency (verified live 2026-08-25)", () => {
  // Prod served a $49 alternative as {amount: 49} beside a currency-carrying anchor price — a bare amount
  // invites the reader to assume the anchor's currency, which fabricates a price when they differ. The
  // amount is withheld (the currency-free ratio survives), never served half-dressed.
  const altSignal = (related) => ({
    signal_type: "alternative",
    subject: { kind: "product", id: "sig_anchor" },
    value: { related, relation: "competitive_alternative", price_comparison: { price_ratio: 8.17 } },
    evidence: { grade: "B", sources: [] },
  });
  const out = projectGetAlternatives({
    subject: { kind: "product", id: "sig_anchor" },
    signals: [
      altSignal({ ref: "sig_bare", title: "Currency-less", price: 49 }),
      altSignal({ ref: "sig_paired", title: "Paired", price: 49, currency: "USD" }),
    ],
  });
  const bare = out.alternatives.find((a) => a.product_id === "sig_bare");
  assert.equal(bare.price, undefined, "an amount with no known currency must not surface");
  assert.equal(bare.price_vs_anchor, "+717%", "the currency-free comparison still serves");
  const paired = out.alternatives.find((a) => a.product_id === "sig_paired");
  assert.deepEqual(paired.price, { amount: 49, currency: "USD" });
  // The surface invariant itself: every price object on the alternatives surface is a complete pair.
  for (const a of out.alternatives) {
    if (a.price !== undefined) {
      assert.equal(typeof a.price.amount, "number");
      assert.equal(typeof a.price.currency, "string");
      assert.ok(a.price.currency.length > 0);
    }
  }
});

// ---- dispatcher + denylist integrity ---------------------------------------------------------------------

test("dispatcher routes each tool and returns {} for an unknown tool", () => {
  assert.ok(Array.isArray(projectPublicReadResult("search_catalog", liveSearchRaw, { limit: 2 }).products));
  assert.deepEqual(projectPublicReadResult("get_offers", { anything: true }), {});
});

test("denylist covers the internal field names seen in the live response", () => {
  // Every top-level envelope key and every internal per-product field from the real response must be caught.
  for (const k of ["assistant_text", "metadata", "beauty_expert_v1"]) {
    assert.ok(DENYLIST_FIELDS.includes(k), `denylist missing envelope key ${k}`);
  }
  for (const k of ["external_seed_id", "catalog_source", "readiness_tier", "truth_tier", "merchant_id", "platform_product_id"]) {
    assert.ok(DENYLIST_FIELDS.includes(k), `denylist missing product field ${k}`);
  }
});

// ---- availability projection: string wins over stale boolean (Class 7) -----------------------------------
// Verified on prod 2026-08-01: rows whose catalog_offers were all in_stock served
// `availability: "in_stock", in_stock: false` (the boolean aggregates per-variant states captured at
// seed-scrape time), and this surface projected them as out_of_stock. The availability string is the
// fresher projection; the boolean is the fallback, not the authority.
test("availability: string beats a stale disagreeing boolean, boolean fills in when string is absent or unknown", () => {
  const project = (row) =>
    projectSearchCatalog({ products: [{ product_id: "sig_x", title: "T", brand: "B", ...row }] }, { limit: 1 })
      .products[0].availability;

  // The prod-observed stale shape: offers say in stock, variant boolean says false.
  assert.equal(project({ availability: "in_stock", in_stock: false }), "in_stock");
  assert.equal(project({ availability: "out_of_stock", in_stock: true }), "out_of_stock");
  // Common upstream spellings normalize.
  assert.equal(project({ availability: "In Stock" }), "in_stock");
  assert.equal(project({ availability: "sold out" }), "out_of_stock");
  // Unrecognized / absent string falls back to the boolean...
  assert.equal(project({ availability: "unknown", in_stock: true }), "in_stock");
  assert.equal(project({ in_stock: false }), "out_of_stock");
  // ...and to unknown when neither field is usable.
  assert.equal(project({}), "unknown");
});

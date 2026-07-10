import test from "node:test";
import assert from "node:assert/strict";

import { createPublicReadToolSurface } from "../src/publicReadToolSurface.js";

// Guards the assumption that the PUBLIC surface projects the shapes the REAL canonical executor emits on the
// MCP path (not just the REST-twin fixture). The shapes below are the documented backend/handler contracts:
//   - search_catalog → read('find_products')      → { products:[…], total, page, page_size }
//       (routes/agent_shop_gateway.py _handle_find_products: "Output: { products, total, page, page_size }")
//   - get_product    → read('get_product_detail') → { product: {…} }
//   - get_intel      → localReads.get_intel       → { subject, signals:[decision Signal], metadata }
//   - get_alternatives → localReads.get_alternatives → { subject, signals:[alternative Signal], metadata }
// If a future contract change nested `products` or reshaped a Signal, the allowlist projector would silently
// return empty — these tests fail loudly first.

function contractExecutor() {
  return {
    async execute(opId) {
      switch (opId) {
        case "search_catalog":
          return {
            products: [
              { pivota_signature_id: "sig_1", brand: "Round Lab", title: "Vita Serum", price: 26, currency: "USD", in_stock: true, image_url: "https://roundlab.com/a.jpg", destination_url: "https://roundlab.com/p/1", active_ingredients: ["Niacinamide"] },
              { pivota_signature_id: "sig_2", brand: "Anua", title: "Toner", price: 18, currency: "USD", in_stock: true, destination_url: "https://anua.com/p/2" },
            ],
            total: 42,
            page: 1,
            page_size: 50,
          };
        case "get_product": // the canonical op id the executor receives (it maps to read('get_product_detail') internally)
          return { product: { pivota_signature_id: "sig_1", brand: "Round Lab", title: "Vita Serum", price: 26, currency: "USD", in_stock: true, description: "A niacinamide serum.", destination_url: "https://roundlab.com/p/1", active_ingredients: ["Niacinamide"] } };
        case "get_intel":
          return {
            subject: { kind: "product", id: "sig_1" },
            signals: [
              {
                signal_type: "decision",
                subject: { kind: "product", id: "sig_1" },
                value: { why_it_stands_out: [{ headline: "High niacinamide", body: "5%" }], best_for: [{ label: "dark spots" }], evidence_profile: "strong" },
                evidence: { grade: "A", claims: [{ claim_text: "fades dark spots", evidence_grade: "A", source_refs: ["https://pubmed.ncbi.nlm.nih.gov/1"] }] },
                review_state: "human_approved",
              },
            ],
            metadata: { kb_key: "product:sig_1" },
          };
        case "get_alternatives":
          return {
            subject: { kind: "product", id: "sig_1" },
            signals: [
              {
                signal_type: "alternative",
                value: { related: { ref: "sig_9", title: "Cheaper Serum", brand: "Good Molecules", price: 12, currency: "USD" }, relation: "competitive_alternative", score: 0.9, price_comparison: { price_ratio: 0.75 }, tradeoffs: ["lower %"], watchouts: [] },
                evidence: { grade: "B", sources: ["https://roundlab.com/x"] },
              },
            ],
            metadata: { edge_count: 1 },
          };
        default:
          return {};
      }
    },
  };
}

test("search_catalog projects the backend {products,total,page,page_size} contract to non-empty output", async () => {
  const surface = createPublicReadToolSurface(contractExecutor());
  const out = await surface.callTool("search_catalog", { query: "niacinamide", page_size: 5 });
  assert.ok(out.products.length > 0, "projected products must not be empty for a populated backend response");
  assert.equal(out.total, 42);
  assert.equal(out.page_size, 5, "page_size reflects the requested/effective page size, not the item count");
  assert.equal(out.returned, out.products.length);
  assert.equal(out.products[0].product_id, "sig_1");
});

test("get_product projects the backend { product } contract", async () => {
  const surface = createPublicReadToolSurface(contractExecutor());
  const out = await surface.callTool("get_product", { product_id: "sig_1" });
  assert.equal(out.product_id, "sig_1");
  assert.equal(out.description, "A niacinamide serum.");
});

test("get_intel projects the decision Signal envelope to non-null intel", async () => {
  const surface = createPublicReadToolSurface(contractExecutor());
  const out = await surface.callTool("get_intel", { product_id: "sig_1" });
  assert.notEqual(out.intel, null);
  assert.equal(out.intel.grade, "A");
  assert.equal(out.intel.claims[0].citations[0], "https://pubmed.ncbi.nlm.nih.gov/1");
});

test("get_alternatives projects the alternative Signal envelope to a non-empty list", async () => {
  const surface = createPublicReadToolSurface(contractExecutor());
  const out = await surface.callTool("get_alternatives", { product_id: "sig_1" });
  assert.ok(out.alternatives.length > 0);
  assert.equal(out.alternatives[0].product_id, "sig_9");
  assert.equal(out.alternatives[0].price_vs_anchor, "-25%");
});

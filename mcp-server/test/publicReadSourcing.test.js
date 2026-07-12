import test from "node:test";
import assert from "node:assert/strict";

import {
  hostOf,
  hostMatches,
  isResellerRow,
  filterFirstPartyRows,
  resellerHostSet,
  isFirstPartyOnlyEnabled,
} from "../src/publicReadSourcing.js";
import { createPublicReadToolSurface } from "../src/publicReadToolSurface.js";

const DENY = resellerHostSet();

test("hostOf normalizes and strips www; bad input → null", () => {
  assert.equal(hostOf("https://www.ulta.com/p/x?sku=1"), "ulta.com");
  assert.equal(hostOf("https://shop.roundlab.com/a"), "shop.roundlab.com");
  assert.equal(hostOf("not a url"), null);
  assert.equal(hostOf(""), null);
});

test("hostMatches is suffix-scoped and not fooled by lookalikes", () => {
  assert.ok(hostMatches("ulta.com", "ulta.com"));
  assert.ok(hostMatches("shop.ulta.com", "ulta.com"));
  assert.ok(!hostMatches("notulta.com", "ulta.com"));
  assert.ok(!hostMatches("ulta.com.evil.com", "ulta.com"));
});

test("isResellerRow: reseller host → true, brand host → false", () => {
  assert.equal(isResellerRow({ destination_url: "https://www.ulta.com/p/x" }, DENY), true);
  assert.equal(isResellerRow({ destination_url: "https://jumiso.us/products/x" }, DENY), false);
  assert.equal(isResellerRow({ destination_url: "https://roundlab.com/a" }, DENY), false);
});

test("isResellerRow drops the retailer hosts synced from offerSellerIdentity", () => {
  // Parity guard: every host offerSellerIdentity classifies 'retailer' must also
  // be dropped by the public-read denylist. These were the gaps (Fix Plan C
  // read-review follow-up): extra Amazon TLDs/shortlinks, BestBuy, OY Korea, and
  // the dept-store additions.
  for (const host of [
    "amazon.ca", "amazon.de", "amzn.to", "amzn.com", "bestbuy.com", "oliveyoung.co.kr",
    "selfridges.com", "harrods.com", "spacenk.com", "coupang.com", "gmarket.co.kr",
  ]) {
    assert.equal(
      isResellerRow({ destination_url: `https://www.${host}/p/x` }, DENY),
      true,
      `${host} should be excluded from the first-party public tier`,
    );
  }
});

test("isResellerRow honors explicit backend signals over host", () => {
  // offer_type wins → reseller even if host looks brandy
  assert.equal(isResellerRow({ offer_type: "retailer", destination_url: "https://brand.com/x" }, DENY), true);
  // is_first_party wins → kept even if the destination were a marketplace mirror
  assert.equal(isResellerRow({ is_first_party: true, destination_url: "https://ulta.com/x" }, DENY), false);
});

test("isResellerRow does not over-reject unknown/absent hosts", () => {
  assert.equal(isResellerRow({}, DENY), false);
  assert.equal(isResellerRow({ destination_url: "garbage" }, DENY), false);
  // pivota canonical url is NOT a destination signal (always a Pivota host) → not used for classification
  assert.equal(isResellerRow({ pivota_canonical_url: "https://agent.pivota.cc/products/sig_1" }, DENY), false);
});

test("filterFirstPartyRows drops resellers, keeps brand-official, counts drops", () => {
  const rows = [
    { title: "A", destination_url: "https://jumiso.us/a" },
    { title: "B", destination_url: "https://www.ulta.com/b" },
    { title: "C", destination_url: "https://roundlab.com/c" },
    { title: "D", destination_url: "https://www.sephora.com/d" },
  ];
  const { kept, droppedCount } = filterFirstPartyRows(rows);
  assert.deepEqual(kept.map((r) => r.title), ["A", "C"]);
  assert.equal(droppedCount, 2);
});

test("extra reseller hosts can be added via csv", () => {
  const rows = [{ destination_url: "https://someshop.example/x" }];
  assert.equal(filterFirstPartyRows(rows).droppedCount, 0);
  assert.equal(filterFirstPartyRows(rows, { extraHostsCsv: "someshop.example" }).droppedCount, 1);
});

test("isFirstPartyOnlyEnabled defaults ON; only explicit off disables", () => {
  assert.equal(isFirstPartyOnlyEnabled({}), true);
  assert.equal(isFirstPartyOnlyEnabled({ PUBLIC_READ_FIRST_PARTY_ONLY: "" }), true);
  assert.equal(isFirstPartyOnlyEnabled({ PUBLIC_READ_FIRST_PARTY_ONLY: "1" }), true);
  for (const off of ["0", "false", "off", "no"]) {
    assert.equal(isFirstPartyOnlyEnabled({ PUBLIC_READ_FIRST_PARTY_ONLY: off }), false);
  }
});

// ---- surface integration ---------------------------------------------------------------------------------

function surfaceWith(searchProducts, getProductRow) {
  const executor = {
    async execute(opId) {
      if (opId === "search_catalog") return { products: searchProducts };
      if (opId === "get_product_detail" || opId === "get_product") return { product: getProductRow };
      return {};
    },
  };
  return createPublicReadToolSurface(executor);
}

test("search_catalog drops reseller rows before projection", async () => {
  const surface = surfaceWith([
    { pivota_signature_id: "sig_brand", brand: "Jumiso", title: "Serum", destination_url: "https://jumiso.us/x" },
    { pivota_signature_id: "sig_reseller", brand: "First Aid Beauty", title: "Serum", destination_url: "https://www.ulta.com/p/x" },
  ]);
  const out = await surface.callTool("search_catalog", { query: "serum" });
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].product_id, "sig_brand");
});

test("get_product withholds a reseller product with an honest note", async () => {
  const surface = surfaceWith([], { pivota_signature_id: "sig_r", title: "X", destination_url: "https://www.ulta.com/p/x" });
  const out = await surface.callTool("get_product", { product_id: "sig_r" });
  assert.equal(typeof out.note, "string");
  assert.ok(!("product_id" in out));
});

test("get_product returns a brand-official product normally", async () => {
  const surface = surfaceWith([], { pivota_signature_id: "sig_b", title: "X", brand: "Anua", destination_url: "https://anua.com/x" });
  const out = await surface.callTool("get_product", { product_id: "sig_b" });
  assert.equal(out.product_id, "sig_b");
});

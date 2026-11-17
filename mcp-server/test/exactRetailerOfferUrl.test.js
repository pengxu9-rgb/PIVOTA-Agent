import assert from "node:assert/strict";
import { test } from "node:test";
import intelligenceReads from "../../src/agentSignals/intelligenceReads.js";

process.env.GET_OFFERS_VARIANT_ID = "on";
const { createCommerceToolSurface } = await import("../src/commerceToolSurface.js");

const canonicalVariant = "51665757438317";
const retailerVariant = "54646142992457";
const productId = "sig_stila";
const pdp = "https://imagebeauty.com/products/stila-stay-all-day-liquid-lipstick";
const exactUrl = `${pdp}?variant=${retailerVariant}`;
const signedUrl = "https://api.example/r?token=registry.signed";
const syntheticPan = "4111111111111111";

function exactOffer() {
  return {
    offer_id: "of:catalog_offer:offer_exact",
    merchant_id: "merch_image",
    price: 25,
    currency: "USD",
    in_stock: true,
    url: exactUrl,
    affiliate_url: signedUrl,
    purchase_route: "affiliate_outbound",
    cart_prefilled: false,
    source: {
      type: "catalog_offer",
      offer_id: "offer_exact",
      merchant_id: "merch_image",
      variant_match: "exact",
      variant_id: canonicalVariant,
      retailer_variant_id: retailerVariant,
      destination_url: exactUrl,
    },
  };
}

function surfaceFor(offer, expectedVariant) {
  const getOffers = intelligenceReads.makeGetOffers({
    variantIdEnabled: true,
    async fetchOffers(args) {
      assert.equal(args.product_id, productId);
      assert.equal(args.variant_id, expectedVariant);
      assert.equal(args.market, "US");
      return intelligenceReads.mapOffersResolveResponse({ offers: [offer] });
    },
  });
  return createCommerceToolSurface({
    async execute(op, params) {
      assert.equal(op, "get_offers");
      return getOffers(params);
    },
  });
}

test("get_offers preserves exact retailer selectors on default and localized storefront paths", async () => {
  const cases = [
    [exactUrl, canonicalVariant, retailerVariant],
    ["https://kiokii.com/en-us/products/amuse-banana-lip-oil-4-5ml?variant=52547429007674",
      "51896079974720", "52547429007674"],
  ];
  for (const [url, canonical, retailer] of cases) {
    const offer = exactOffer();
    offer.url = url;
    Object.assign(offer.source, { destination_url: url, variant_id: canonical, retailer_variant_id: retailer });
    const result = await surfaceFor(offer, canonical).callTool("get_offers", {
      product_id: productId,
      variant_id: canonical,
      market: "US",
    });
    assert.equal(result.signals.length, 1);
    for (const { value } of [result.best_offer, result.signals[0]]) {
      assert.equal(value.url, url);
      assert.equal(value.affiliate_url, signedUrl);
      assert.equal(value.cart_prefilled, false);
      assert.equal(value.execution_spec, null);
      assert.deepEqual(Object.getOwnPropertySymbols(value), []);
    }
  }
});

test("get_offers still sanitizes unproven URLs and URLs with extra selectors or secrets", async () => {
  const cases = [
    ["other retail variant", { retailer_variant_id: "other" }],
    ["other seller", { merchant_id: "merch_other" }],
    ["other source offer", { offer_id: "offer_other" }],
    ["other destination", { destination_url: pdp }],
    ["fallback match", { variant_match: "fallback" }],
    ["raw merchant source", { type: "merchant" }],
    ["duplicate selector", {}, `${exactUrl}&variant=${syntheticPan}`],
    ["extra secret", {}, `${exactUrl}&token=merchant-secret&note=${syntheticPan}`],
  ];
  for (const [label, source, url] of cases) {
    const offer = exactOffer();
    if (url) {
      offer.url = url;
      offer.source.destination_url = url;
    }
    Object.assign(offer.source, source);
    const { best_offer } = await surfaceFor(offer).callTool("get_offers", {
      product_id: productId,
      market: "US",
    });
    assert.match(best_offer.value.url, /\[REDACTED_PAN\]/, label);
    assert.ok(!best_offer.value.url.includes(retailerVariant), label);
    assert.ok(!best_offer.value.url.includes(syntheticPan), label);
    assert.ok(!best_offer.value.url.includes("merchant-secret"), label);
  }
});

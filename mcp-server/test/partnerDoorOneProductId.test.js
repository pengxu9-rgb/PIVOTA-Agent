// PARTNER_DOOR_ONE_PRODUCT_ID, the `/mcp` door's own half (mcp-server/src/partnerDoorOneProductId.js): the wrapped
// surface and the three error codes. The chained door test (tests/partner_door_one_product_id_chain.node.test.cjs)
// drives the same code through the real route; these pin each rule on its own.

import test from "node:test";
import assert from "node:assert/strict";

import { ERROR_CATALOG, PivotaCommerceError, isPivotaErrorCode } from "../../safety-kernel/src/errors.js";
import { toToolError } from "../src/commerceToolSurface.js";
import { dropOtherSigFields, partnerDoorSurface, partnerDoorToolDefinition, PARTNER_DOOR_ONE_PRODUCT_ID } from "../src/partnerDoorOneProductId.js";
import { createCommerceToolSurface } from "../src/commerceToolSurface.js";

const SIG = `sig_${"a".repeat(32)}`;
const OTHER_SIG = `sig_${"b".repeat(32)}`;
const GROUP = `sig_${"1".repeat(24)}`;

const surfaceAnswering = (answers, calls = []) => ({
  get tools() { return [{ name: "get_product" }]; },
  isCommerceTool: (name) => name === "get_product",
  async callTool(name, args, ...rest) {
    calls.push([name, args, ...rest]);
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return answer;
  },
});
const errorBody = (error) => JSON.parse(toToolError(error).content[0].text).error;

test("the flag is off unless the environment sets it", () => {
  assert.equal(PARTNER_DOOR_ONE_PRODUCT_ID, /^(1|true|yes|on|enabled)$/i.test(String(process.env.PARTNER_DOOR_ONE_PRODUCT_ID || "").trim()));
});

test("off, the surface is handed back as is", () => {
  const surface = surfaceAnswering({});
  assert.equal(partnerDoorSurface(surface, { enabled: false }), surface);
});

test("a row keeps one sig_ value: its own product_id", () => {
  const row = {
    id: SIG, product_id: SIG, pivota_signature_id: SIG, signature_id: SIG, title: "Calm Serum",
    sellable_item_group_id: GROUP, product_group_id: GROUP, canonical_route_sig_id: OTHER_SIG,
    canonical_product_ref: { merchant_id: "merch_obs_brandx", product_id: "brand-x:0123456789abcdef", pivota_signature_id: SIG },
    product_ref: { merchant_id: "merch_obs_brandx", product_id: SIG },
    selected_commerce_ref: { product_id: OTHER_SIG },
    offers: [{ offer_id: "of:1", product_id: SIG, product_group_id: GROUP }],
    member_ids: [SIG, "ext_1", GROUP],
    url: `https://example.com/products/${SIG}`,
    price: 30,
  };
  assert.deepEqual(dropOtherSigFields(row), {
    product_id: SIG, title: "Calm Serum",
    canonical_product_ref: { merchant_id: "merch_obs_brandx", product_id: "brand-x:0123456789abcdef" },
    product_ref: { merchant_id: "merch_obs_brandx", product_id: SIG },
    selected_commerce_ref: {},
    offers: [{ offer_id: "of:1", product_id: SIG }],
    member_ids: ["ext_1"],
    url: `https://example.com/products/${SIG}`,
    price: 30,
  });
  // The input is not edited.
  assert.equal(row.id, SIG);
});

test("a row whose product_id is not a signature keeps it, and loses every sig_ value", () => {
  assert.deepEqual(dropOtherSigFields({ product_id: "9001", id: "9001", product_group_id: GROUP }), { product_id: "9001", id: "9001" });
  assert.deepEqual(dropOtherSigFields({ id: SIG, title: "No product_id" }), { title: "No product_id" });
});

test("on: search rows and the product are projected; other tools pass through", async () => {
  const product = { product_id: SIG, merchant_id: "merch_obs_brandx", price: 30, currency: "USD", product_group_id: GROUP, pivota_signature_id: SIG };
  const offers = { subject: { kind: "product", id: SIG }, signals: [] };
  const door = partnerDoorSurface(surfaceAnswering({
    search_catalog: { status: "success", products: [{ id: SIG, product_id: SIG, product_group_id: GROUP }], total: 1 },
    get_product: { product },
    get_offers: offers,
  }), { enabled: true });
  assert.deepEqual(await door.callTool("search_catalog", { query: "serum" }), { status: "success", products: [{ product_id: SIG }], total: 1 });
  assert.deepEqual(await door.callTool("get_product", { product_id: SIG }), { product: { product_id: SIG, merchant_id: "merch_obs_brandx", price: 30, currency: "USD" } });
  assert.equal(await door.callTool("get_offers", { product_id: SIG }), offers);
  assert.deepEqual(door.tools, [{ name: "get_product" }]);
  assert.equal(door.isCommerceTool("get_product"), true);
});

test("on: the tool list declares the two read tools the door's way, and nothing else differently", () => {
  const surface = createCommerceToolSurface({ async execute() { return {}; } }, { cache: false });
  const before = JSON.stringify(surface.tools);
  const door = partnerDoorSurface(surface, { enabled: true });
  const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
  const off = byName(surface.tools);
  const on = byName(door.tools);
  assert.deepEqual(Object.keys(on), Object.keys(off));
  for (const name of Object.keys(off)) {
    if (name === "get_product" || name === "get_offers") continue;
    assert.equal(on[name], off[name], `${name} is the surface's own definition`);
  }
  // get_product: the product_id from search; merchant_id optional; the rest of the description is kept.
  assert.deepEqual(off.get_product.inputSchema.required, ["merchant_id", "product_id"]);
  assert.deepEqual(on.get_product.inputSchema.required, ["product_id"]);
  assert.deepEqual(Object.keys(on.get_product.inputSchema.properties), Object.keys(off.get_product.inputSchema.properties));
  assert.match(on.get_product.description, /^Get full detail for one product\. Pass `product_id`: the product_id of a search_catalog row/);
  assert.match(on.get_product.description, /`merchant_id` is optional/);
  assert.ok(!on.get_product.description.includes("(merchant_id + product_id)"));
  const lead = "Get full detail for one product (merchant_id + product_id).";
  assert.ok(off.get_product.description.startsWith(lead));
  assert.ok(on.get_product.description.endsWith(off.get_product.description.slice(lead.length)));
  assert.match(on.get_product.inputSchema.properties.merchant_id.description, /^Optional\./);
  // get_offers: product_group_id is not declared; everything else is.
  assert.ok("product_group_id" in off.get_offers.inputSchema.properties);
  assert.deepEqual(Object.keys(on.get_offers.inputSchema.properties), Object.keys(off.get_offers.inputSchema.properties).filter((k) => k !== "product_group_id"));
  assert.equal(on.get_offers.description, off.get_offers.description);
  // The surface's own definitions (which the public and UCP doors read) are not edited.
  assert.equal(JSON.stringify(surface.tools), before);
  // A definition with no schema, or another tool, is returned as is.
  const other = { name: "search_catalog", inputSchema: { properties: { product_group_id: {} } } };
  assert.equal(partnerDoorToolDefinition(other), other);
  assert.equal(partnerDoorToolDefinition({ name: "get_product" }).description, undefined);
});

test("on: every argument reaches the surface unchanged", async () => {
  const calls = [];
  const door = partnerDoorSurface(surfaceAnswering({ get_product: { product: { product_id: SIG, price: 1 } } }, calls), { enabled: true });
  const args = { product_id: SIG };
  const session = { user_ref: "u" };
  const options = { observe() {} };
  await door.callTool("get_product", args, session, options);
  assert.deepEqual(calls, [["get_product", args, session, options]]);
  assert.equal(calls[0][1], args);
});

test("on: the seller named must be the product's, or the shared seed seller name for a seed-supply product", async () => {
  const answer = (merchant) => partnerDoorSurface(
    surfaceAnswering({ get_product: { product: { product_id: SIG, merchant_id: merchant, price: 30 } } }), { enabled: true });
  // The seller the door returned is accepted.
  assert.ok((await answer("merch_obs_brandx").callTool("get_product", { merchant_id: "merch_obs_brandx", product_id: SIG })).product);
  assert.ok((await answer("merch_shop_a").callTool("get_product", { merchant_id: "merch_shop_a", product_id: SIG })).product);
  // The shared seed seller name, for a seed-supply product only.
  assert.ok((await answer("merch_obs_brandx").callTool("get_product", { merchant_id: "external_seed", product_id: SIG })).product);
  // No seller named: nothing to check.
  assert.ok((await answer("merch_obs_brandx").callTool("get_product", { product_id: SIG })).product);
  for (const [productSeller, named] of [
    ["merch_obs_brandx", "merch_obs_brandy"],
    ["merch_obs_brandx", "merch_shop_a"],
    ["merch_shop_a", "merch_shop_b"],
    ["merch_shop_a", "external_seed"],
    ["merch_shop_a", "merch_obs_brandx"],
  ]) {
    await assert.rejects(
      answer(productSeller).callTool("get_product", { merchant_id: named, product_id: SIG }),
      (e) => e instanceof PivotaCommerceError && e.code === "MERCHANT_PRODUCT_MISMATCH" && e.detail.reason === "merchant_not_seller_of_product",
      `${named} is not ${productSeller}`,
    );
  }
});

test("on: a product with no price says so; a priced one, or one that already says why, is left alone", async () => {
  const door = (product) => partnerDoorSurface(surfaceAnswering({ get_product: { product } }), { enabled: true });
  assert.equal((await door({ product_id: SIG, price: null }).callTool("get_product", { product_id: SIG })).product.price_unavailable_reason, "no_servable_price_in_market");
  assert.equal((await door({ product_id: SIG }).callTool("get_product", { product_id: SIG })).product.price_unavailable_reason, "no_servable_price_in_market");
  assert.equal(Object.prototype.hasOwnProperty.call((await door({ product_id: SIG, price: 0 }).callTool("get_product", { product_id: SIG })).product, "price_unavailable_reason"), false);
  assert.equal((await door({ product_id: SIG, price: null, price_unavailable_reason: "other_currency" }).callTool("get_product", { product_id: SIG })).product.price_unavailable_reason, "other_currency");
});

test("on: an answer with no product is a named refusal, not { product: null }", async () => {
  const door = partnerDoorSurface(surfaceAnswering({ get_product: { product: null } }), { enabled: true });
  await assert.rejects(door.callTool("get_product", { product_id: SIG }),
    (e) => e instanceof PivotaCommerceError && e.code === "PRODUCT_NOT_SERVABLE" && e.detail.reason === "product_detail_unavailable");
});

test("on: get_offers refuses product_group_id by name, before the surface is called", async () => {
  const calls = [];
  const door = partnerDoorSurface(surfaceAnswering({ get_offers: {} }, calls), { enabled: true });
  await assert.rejects(door.callTool("get_offers", { product_group_id: GROUP }),
    (e) => e instanceof PivotaCommerceError && e.code === "PRODUCT_GROUP_ID_NOT_PRODUCT_ID" && e.detail.reason === "product_group_id_argument");
  assert.deepEqual(calls, []);
});

test("on: the surface's own errors pass through untouched", async () => {
  const failure = new PivotaCommerceError("MERCHANT_UNAVAILABLE", { reason: "backend_unreachable" });
  const door = partnerDoorSurface(surfaceAnswering({ get_product: failure }), { enabled: true });
  await assert.rejects(door.callTool("get_product", { product_id: SIG }), (e) => e === failure);
});

test("the three codes are terminal, and each names its one fact", () => {
  for (const code of ["PRODUCT_NOT_SERVABLE", "PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "MERCHANT_PRODUCT_MISMATCH"]) {
    assert.ok(isPivotaErrorCode(code));
    assert.equal(ERROR_CATALOG[code].retriable, false);
    assert.ok(!/try again|temporarily/i.test(ERROR_CATALOG[code].userMessage), code);
    assert.ok(!/no purchasable merchant offer/i.test(ERROR_CATALOG[code].userMessage), code);
  }
  assert.match(ERROR_CATALOG.PRODUCT_GROUP_ID_NOT_PRODUCT_ID.userMessage, /group id/);
  assert.match(ERROR_CATALOG.MERCHANT_PRODUCT_MISMATCH.userMessage, /merchant_id does not match/);
  assert.match(ERROR_CATALOG.PRODUCT_NOT_SERVABLE.userMessage, /known/);
});

test("the meaning of the existing read codes is unchanged", () => {
  assert.equal(ERROR_CATALOG.NO_MERCHANT_OFFER.userMessage, "This product has no purchasable merchant offer attached, so no detail is available. This will not change on retry.");
  assert.equal(ERROR_CATALOG.UNKNOWN_PRODUCT_ID.userMessage, "No product matches that id. Retrying will not change this — search again to get a valid product_id.");
  assert.equal(ERROR_CATALOG.MERCHANT_UNAVAILABLE.retriable, true);
});

test("the tool error carries the reason for the three codes, and only a reason in our own vocabulary", () => {
  assert.deepEqual(errorBody(new PivotaCommerceError("PRODUCT_NOT_SERVABLE", { reason: "not_serving_eligible", upstream_status: 404 })), {
    code: "PRODUCT_NOT_SERVABLE", message: ERROR_CATALOG.PRODUCT_NOT_SERVABLE.userMessage, retriable: false, detail: { reason: "not_serving_eligible" },
  });
  assert.deepEqual(errorBody(new PivotaCommerceError("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", { reason: "group_has_several_products" })).detail, { reason: "group_has_several_products" });
  assert.deepEqual(errorBody(new PivotaCommerceError("MERCHANT_PRODUCT_MISMATCH", { reason: "merchant_not_seller_of_product" })).detail, { reason: "merchant_not_seller_of_product" });
  // Not a snake_case reason (it could be a request value or upstream text): nothing is surfaced.
  for (const reason of ["Seller A <a@example.com>", "x".repeat(65), "", 7, null]) {
    assert.equal(errorBody(new PivotaCommerceError("PRODUCT_NOT_SERVABLE", { reason })).detail, undefined, String(reason));
  }
  // The codes that existed before keep their body: no detail.
  for (const code of ["NO_MERCHANT_OFFER", "UNKNOWN_PRODUCT_ID", "MERCHANT_UNAVAILABLE"]) {
    assert.equal(errorBody(new PivotaCommerceError(code, { reason: "product_id_not_found" })).detail, undefined, code);
  }
});

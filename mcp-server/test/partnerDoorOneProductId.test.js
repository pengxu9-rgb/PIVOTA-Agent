// PARTNER_DOOR_ONE_PRODUCT_ID, the `/mcp` door's view of the surface (mcp-server/src/partnerDoorOneProductId.js)
// and the three error codes. The chained door test (tests/partner_door_one_product_id_chain.node.test.cjs)
// drives the same code through the real route; these pin each rule on its own.

import test from "node:test";
import assert from "node:assert/strict";

import { ERROR_CATALOG, PivotaCommerceError, isPivotaErrorCode } from "../../safety-kernel/src/errors.js";
import { ERROR_OBSERVABILITY } from "../../safety-kernel/src/invokeHandler.js";
import { AUDIT_EVENTS } from "../../safety-kernel/src/audit.js";
import { createCommerceToolSurface, toToolError } from "../src/commerceToolSurface.js";
import { dropGroupIdFields, partnerDoorSurface, partnerDoorToolDefinition, PARTNER_DOOR_ONE_PRODUCT_ID } from "../src/partnerDoorOneProductId.js";

const SIG = `sig_${"a".repeat(32)}`;
const OTHER_SIG = `sig_${"b".repeat(32)}`;
const GROUP = `sig_${"1".repeat(24)}`;

const surfaceAnswering = (answers, calls = []) => ({
  get tools() { return [{ name: "get_product" }]; },
  isCommerceTool: (name) => name === "get_product",
  async callTool(name, args, ...rest) {
    calls.push([name, args, ...rest]);
    const answer = typeof answers[name] === "function" ? answers[name](args) : answers[name];
    if (answer instanceof Error) throw answer;
    return answer;
  },
});
// The door's lookups, answered here. `sellers`: signature -> seller list (absent: could not ask).
const lookupsFor = ({ groups = {}, sellers = {}, asked = [] } = {}) => ({
  async resolveGroupIdToProductId({ groupId }) { asked.push(["group", groupId]); return groups[groupId] || { status: "none" }; },
  async listSignatureSellerIds({ productId }) { asked.push(["sellers", productId]); return Object.prototype.hasOwnProperty.call(sellers, productId) ? sellers[productId] : null; },
});
const door = (answers, { calls, ...lookups } = {}) => partnerDoorSurface(surfaceAnswering(answers, calls), { enabled: true, lookups: lookupsFor(lookups) });
const errorBody = (error) => JSON.parse(toToolError(error).content[0].text).error;
const isRefusal = (code, reason) => (e) => e instanceof PivotaCommerceError && e.code === code && e.detail.reason === reason;

test("the flag is off unless the environment sets it", () => {
  assert.equal(PARTNER_DOOR_ONE_PRODUCT_ID, /^(1|true|yes|on|enabled)$/i.test(String(process.env.PARTNER_DOOR_ONE_PRODUCT_ID || "").trim()));
});

test("off, the surface is handed back as is", () => {
  const surface = surfaceAnswering({});
  assert.equal(partnerDoorSurface(surface, { enabled: false }), surface);
});

// --- the field drop ---------------------------------------------------------------------------------------

test("a row loses its group id fields and nothing else", () => {
  const row = {
    id: SIG, product_id: SIG, pivota_signature_id: SIG, signature_id: SIG, title: "Calm Serum",
    sellable_item_group_id: GROUP, product_group_id: GROUP, canonical_sig_id: GROUP,
    default_variant_id: SIG,
    variants: [{ variant_id: SIG, sku_id: SIG, title: "Default" }, { variant_id: `${SIG}-2`, product_group_id: GROUP }],
    canonical_product_ref: { merchant_id: "merch_obs_brandx", product_id: "brand-x:0123456789abcdef", pivota_signature_id: SIG },
    group_members: [{ merchant_id: "merch_obs_brandx", product_id: "p1", pivota_signature_id: SIG }, { merchant_id: "merch_shop_a", pivota_signature_id: OTHER_SIG }],
    other_seller_listings: [{ merchant_id: "merch_shop_a", pivota_signature_id: OTHER_SIG, product_key: "prod::shop-a::1", product_group_id: GROUP }],
    offers: [{ offer_id: "of:1", product_id: OTHER_SIG, product_group_id: GROUP }],
    member_ids: [SIG, "ext_1", GROUP],
    url: `https://example.com/products/${SIG}`,
    price: 30,
  };
  const { sellable_item_group_id: _a, product_group_id: _b, canonical_sig_id: _c, ...expected } = row;
  const out = dropGroupIdFields(row);
  assert.deepEqual(out, expected);
  // Nothing nested was copied or edited, and the input is untouched.
  for (const key of ["variants", "canonical_product_ref", "group_members", "other_seller_listings", "offers", "member_ids"]) assert.equal(out[key], row[key], key);
  assert.equal(row.product_group_id, GROUP);
});

test("a variant keeps a sig_-valued variant_id; group members and other sellers keep their own signatures", () => {
  const out = dropGroupIdFields({
    product_id: SIG, variants: [{ variant_id: SIG, sku_id: SIG }],
    group_members: [{ merchant_id: "merch_shop_a", pivota_signature_id: OTHER_SIG }],
    other_seller_listings: [{ merchant_id: "merch_shop_a", pivota_signature_id: OTHER_SIG }],
  });
  assert.deepEqual(out.variants, [{ variant_id: SIG, sku_id: SIG }]);
  assert.deepEqual(out.group_members, [{ merchant_id: "merch_shop_a", pivota_signature_id: OTHER_SIG }]);
  assert.deepEqual(out.other_seller_listings, [{ merchant_id: "merch_shop_a", pivota_signature_id: OTHER_SIG }]);
});

test("by key: `id` always stays; a signature alias stays when it is the row's own id and goes when it is another", () => {
  // The row's own signature under every name.
  const own = { product_id: SIG, id: SIG, pivota_signature_id: SIG, signature_id: SIG, canonical_sig_id: SIG, canonical_route_sig_id: SIG, product_group_id: SIG.toUpperCase().replace("SIG_", "sig_") };
  assert.deepEqual(dropGroupIdFields(own), own);
  // Another product's signature under an alias, and a group id under any top-level name.
  assert.deepEqual(dropGroupIdFields({
    product_id: SIG, id: OTHER_SIG, pivota_signature_id: OTHER_SIG, signature_id: GROUP, canonical_route_sig_id: OTHER_SIG, group_ref: GROUP,
    variant_id: GROUP, sku_id: OTHER_SIG, keeper: OTHER_SIG, product_group_id: "pg_catalog_1",
  }), { product_id: SIG, id: OTHER_SIG, variant_id: GROUP, sku_id: OTHER_SIG, keeper: OTHER_SIG, product_group_id: "pg_catalog_1" });
  // A group id field holding a 32-hex signature that is not the row's own (the catalog-group lane's shape).
  assert.deepEqual(dropGroupIdFields({ product_id: SIG, product_group_id: OTHER_SIG, sellable_item_group_id: OTHER_SIG, canonical_sig_id: OTHER_SIG }), { product_id: SIG });
  // A row whose product_id is not a signature: only the group id goes.
  assert.deepEqual(dropGroupIdFields({ product_id: "9001", id: "9001", pivota_signature_id: SIG, product_group_id: GROUP }), { product_id: "9001", id: "9001" });
  assert.deepEqual(dropGroupIdFields({ id: SIG, title: "No product_id", sellable_item_group_id: GROUP }), { id: SIG, title: "No product_id" });
  for (const notARow of [null, "x", 7, [GROUP]]) assert.equal(dropGroupIdFields(notARow), notARow);
});

// --- the surface ------------------------------------------------------------------------------------------

test("on: search rows and the product lose the group id; other tools pass through untouched", async () => {
  const product = { product_id: SIG, merchant_id: "merch_obs_brandx", price: 30, currency: "USD", product_group_id: GROUP, pivota_signature_id: SIG };
  const alternatives = { related: [{ product_group_id: GROUP }] };
  const d = door({
    search_catalog: { status: "success", products: [{ id: SIG, product_id: SIG, product_group_id: GROUP }], total: 1 },
    get_product: { product },
    get_alternatives: alternatives,
  });
  assert.deepEqual(await d.callTool("search_catalog", { query: "serum" }), { status: "success", products: [{ id: SIG, product_id: SIG }], total: 1 });
  assert.deepEqual(await d.callTool("get_product", { product_id: SIG }), { product: { product_id: SIG, merchant_id: "merch_obs_brandx", price: 30, currency: "USD", pivota_signature_id: SIG } });
  assert.equal(await d.callTool("get_alternatives", { product_id: SIG }), alternatives);
  assert.deepEqual(d.tools, [{ name: "get_product" }]);
  assert.equal(d.isCommerceTool("get_product"), true);
  // A search answer that is not a product page is returned as is.
  const odd = { status: "success" };
  assert.equal(await door({ search_catalog: odd }).callTool("search_catalog", {}), odd);
});

test("on: every argument reaches the surface unchanged when the id is not a group id", async () => {
  const calls = [];
  const d = door({ get_product: { product: { product_id: SIG, price: 1 } }, get_offers: { best_offer: {}, signals: [{}], metadata: {} } }, { calls });
  const args = { product_id: SIG };
  const session = { user_ref: "u" };
  const options = { observe() {} };
  await d.callTool("get_product", args, session, options);
  await d.callTool("get_offers", args, session, options);
  assert.deepEqual(calls, [["get_product", args, session, options], ["get_offers", args, session, options]]);
  assert.equal(calls[0][1], args);
  assert.equal(calls[1][1], args);
  // Arguments that are not an object are the surface's to refuse.
  await d.callTool("get_product", "nope", session);
  assert.equal(calls[2][1], "nope");
});

test("on: a group id is answered as the product the lookup elects, on both read tools, with the other arguments kept", async () => {
  const calls = [];
  const asked = [];
  const d = door(
    { get_product: (a) => ({ product: { product_id: a.product_id, merchant_id: "merch_obs_brandx", price: 9 } }), get_offers: { best_offer: {}, signals: [{}], metadata: {} } },
    { calls, asked, groups: { [GROUP]: { status: "resolved", productId: SIG } }, sellers: {} },
  );
  const answer = await d.callTool("get_product", { merchant_id: "merch_obs_brandx", product_id: GROUP, market: "US" }, { s: 1 });
  assert.equal(answer.product.product_id, SIG);
  assert.deepEqual(calls[0], ["get_product", { merchant_id: "merch_obs_brandx", product_id: SIG, market: "US" }, { s: 1 }]);
  await d.callTool("get_offers", { product_id: GROUP, limit: 3 });
  assert.deepEqual(calls[1], ["get_offers", { product_id: SIG, limit: 3 }]);
  assert.deepEqual(asked, [["group", GROUP], ["group", GROUP]]);
});

test("on: a group id with nothing servable is refused by name; a failed lookup is retriable; nothing is read", async () => {
  for (const tool of ["get_product", "get_offers"]) {
    const calls = [];
    await assert.rejects(door({}, { calls, groups: { [GROUP]: { status: "none" } } }).callTool(tool, { product_id: GROUP }), isRefusal("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "group_has_no_servable_product"));
    await assert.rejects(door({}, { calls, groups: { [GROUP]: { status: "no_database" } } }).callTool(tool, { product_id: GROUP }), isRefusal("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "group_id_not_resolvable"));
    await assert.rejects(door({}, { calls, groups: { [GROUP]: { status: "unavailable" } } }).callTool(tool, { product_id: GROUP }), isRefusal("MERCHANT_UNAVAILABLE", "group_id_lookup_unavailable"));
    assert.deepEqual(calls, []);
  }
});

test("on: the answer's product_id is the signature that was asked with; the answered id is kept as source_product_id", async () => {
  const backend = { product_id: "9001", merchant_id: "merch_shop_a", price: 18, pivota_signature_id: SIG, product_group_id: GROUP };
  const answer = await door({ get_product: { status: "success", product: backend } }).callTool("get_product", { merchant_id: "merch_shop_a", product_id: SIG });
  assert.deepEqual(answer, { status: "success", product: { product_id: SIG, merchant_id: "merch_shop_a", price: 18, pivota_signature_id: SIG, source_product_id: "9001" } });
  assert.equal(backend.product_id, "9001", "the surface's value is not edited");
  // An existing source_product_id is not overwritten; a missing answered id adds none.
  const kept = await door({ get_product: { product: { product_id: "9001", source_product_id: "src-1", price: 1 } } }).callTool("get_product", { product_id: SIG });
  assert.equal(kept.product.source_product_id, "src-1");
  const none = await door({ get_product: { product: { title: "No id", price: 1 } } }).callTool("get_product", { product_id: SIG });
  assert.deepEqual(none.product, { title: "No id", price: 1, product_id: SIG });
  // Asked with an id that is not a signature: the answer's id stands.
  const platform = await door({ get_product: { product: { product_id: "9001", merchant_id: "merch_shop_a", price: 1 } } }).callTool("get_product", { merchant_id: "merch_shop_a", product_id: "9001" });
  assert.equal(platform.product.product_id, "9001");
  assert.equal("source_product_id" in platform.product, false);
});

test("on: a seller the answered product names, or its seed counterpart, is accepted without a lookup", async () => {
  const asked = [];
  const answering = (product) => door({ get_product: { product: { product_id: SIG, price: 30, ...product } } }, { asked, sellers: {} });
  for (const [named, product] of [
    ["merch_obs_brandx", { merchant_id: "merch_obs_brandx" }],
    ["merch_shop_a", { merchant_id: "merch_shop_a" }],
    ["external_seed", { merchant_id: "merch_obs_brandx" }],
    ["merch_obs_brandx", { merchant_id: "external_seed" }],
    ["merch_shop_a", { merchant_id: "merch_obs_brandw", group_members: [{ merchant_id: "merch_shop_a" }] }],
    ["merch_obs_brandv", { merchant_id: "merch_obs_brandu", canonical_product_ref: { merchant_id: "merch_obs_brandv" } }],
    [undefined, { merchant_id: "merch_obs_brandx" }],
    ["merch_obs_brandx", {}],
  ]) {
    assert.ok((await answering(product).callTool("get_product", { ...(named ? { merchant_id: named } : {}), product_id: SIG })).product, `${named} / ${JSON.stringify(product)}`);
  }
  assert.deepEqual(asked, []);
});

test("on: a seller the answer does not name is checked against the signature's own rows before it is refused", async () => {
  const answering = (sellers, asked = []) => door({ get_product: { product: { product_id: SIG, merchant_id: "merch_obs_brandu", price: 30 } } }, { asked, sellers });
  // The canonical-group fallback: the answer is another seller's, the signature's row is the caller's.
  const asked = [];
  assert.ok((await answering({ [SIG]: ["merch_obs_brandv"] }, asked).callTool("get_product", { merchant_id: "merch_obs_brandv", product_id: SIG })).product);
  assert.deepEqual(asked, [["sellers", SIG]]);
  // A seller that belongs to neither, a signature with no row, and a lookup that could not be asked: refused.
  for (const sellers of [{ [SIG]: ["merch_obs_brandv"] }, { [SIG]: [] }, {}]) {
    await assert.rejects(answering(sellers).callTool("get_product", { merchant_id: "merch_obs_brandz", product_id: SIG }), isRefusal("MERCHANT_PRODUCT_MISMATCH", "merchant_not_seller_of_product"), JSON.stringify(sellers));
  }
  for (const [productSeller, named] of [["merch_obs_brandx", "merch_obs_brandy"], ["merch_obs_brandx", "merch_shop_a"], ["merch_shop_a", "merch_shop_b"], ["merch_shop_a", "external_seed"], ["external_seed", "merch_shop_a"]]) {
    await assert.rejects(
      door({ get_product: { product: { product_id: SIG, merchant_id: productSeller, price: 1 } } }, { sellers: { [SIG]: [productSeller] } }).callTool("get_product", { merchant_id: named, product_id: SIG }),
      isRefusal("MERCHANT_PRODUCT_MISMATCH", "merchant_not_seller_of_product"), `${named} is not ${productSeller}`,
    );
  }
  // Asked with an id that is not a signature there are no rows to ask about: the answer alone decides.
  const asked2 = [];
  await assert.rejects(door({ get_product: { product: { product_id: "9001", merchant_id: "merch_shop_a", price: 1 } } }, { asked: asked2 }).callTool("get_product", { merchant_id: "merch_shop_b", product_id: "9001" }),
    isRefusal("MERCHANT_PRODUCT_MISMATCH", "merchant_not_seller_of_product"));
  assert.deepEqual(asked2, []);
});

test("on: a product with no price says so (null, absent or the catalog's 0); a priced one, or one that already says why, is left alone", async () => {
  const reasonOf = async (product) => (await door({ get_product: { product } }).callTool("get_product", { product_id: SIG })).product.price_unavailable_reason;
  assert.equal(await reasonOf({ product_id: SIG, price: null }), "no_servable_price_in_market");
  assert.equal(await reasonOf({ product_id: SIG }), "no_servable_price_in_market");
  assert.equal(await reasonOf({ product_id: SIG, price: 0 }), "no_servable_price_in_market");
  assert.equal(await reasonOf({ product_id: SIG, price: 0.5 }), undefined);
  assert.equal(await reasonOf({ product_id: SIG, price: 30 }), undefined);
  assert.equal(await reasonOf({ product_id: SIG, price: null, price_unavailable_reason: "other_currency" }), "other_currency");
});

test("on: an answer with no product is a named refusal, not { product: null }", async () => {
  await assert.rejects(door({ get_product: { product: null } }).callTool("get_product", { product_id: SIG }), isRefusal("PRODUCT_NOT_SERVABLE", "product_detail_unavailable"));
  const bare = { status: "success" };
  assert.equal(await door({ get_product: bare }).callTool("get_product", { product_id: SIG }), bare);
  assert.equal(await door({ get_product: null }).callTool("get_product", { product_id: SIG }), null);
});

// --- a get_product the kernel refused ---------------------------------------------------------------------

const RESOLVED_BODY = { error: "PRODUCT_NOT_SERVABLE", details: { reason: "not_serving_eligible" }, metadata: { identity_resolution: { canonicalization_applied: true, resolution_source: "catalog_products_signature_exact" } } };
const kernelRefusal = (upstreamDetail) => new PivotaCommerceError("NO_MERCHANT_OFFER", { operation: "get_product_detail", upstream_status: 404, upstream_code: null, upstream_detail: upstreamDetail });

test("on: the kernel's NO_MERCHANT_OFFER is re-read: withheld, or unknown; the kernel's code and detail ride along unseen", async () => {
  const withheld = kernelRefusal(RESOLVED_BODY);
  withheld.marketAssumed = true;
  await assert.rejects(door({ get_product: withheld }).callTool("get_product", { product_id: SIG }), (e) => {
    assert.equal(e.code, "PRODUCT_NOT_SERVABLE");
    assert.equal(e.retriable, false);
    assert.equal(e.detail.reason, "not_serving_eligible");
    assert.equal(e.detail.kernel_code, "NO_MERCHANT_OFFER");
    assert.equal(e.detail.upstream_status, 404);
    assert.equal(e.marketAssumed, true, "the market label is kept");
    assert.deepEqual(Object.keys(errorBody(e)).sort(), ["code", "detail", "market_assumed", "message", "retriable"]);
    assert.deepEqual(errorBody(e).detail, { reason: "not_serving_eligible" });
    return true;
  });
  await assert.rejects(door({ get_product: kernelRefusal({ error: "PRODUCT_NOT_FOUND" }) }).callTool("get_product", { product_id: SIG }), (e) => {
    assert.equal(e.code, "UNKNOWN_PRODUCT_ID");
    assert.equal(e.marketAssumed, undefined);
    assert.deepEqual(errorBody(e), { code: "UNKNOWN_PRODUCT_ID", message: ERROR_CATALOG.UNKNOWN_PRODUCT_ID.userMessage, retriable: false });
    return true;
  });
});

test("on: \"this merchant has no such product\" is a wrong seller when the signature is known under other sellers only", async () => {
  const refused = (sellers, args) => door({ get_product: kernelRefusal("PRODUCT_NOT_FOUND") }, { sellers }).callTool("get_product", args);
  await assert.rejects(refused({ [SIG]: ["merch_obs_brandx"] }, { merchant_id: "merch_shop_b", product_id: SIG }), isRefusal("MERCHANT_PRODUCT_MISMATCH", "merchant_not_seller_of_product"));
  // The signature IS that merchant's, has no row, or could not be asked about: the id is what is unknown.
  for (const sellers of [{ [SIG]: ["merch_shop_b"] }, { [SIG]: [] }, {}]) {
    await assert.rejects(refused(sellers, { merchant_id: "merch_shop_b", product_id: SIG }), isRefusal("UNKNOWN_PRODUCT_ID", "product_id_not_found"), JSON.stringify(sellers));
  }
  // No seller named, or an id that is not a signature: nothing to ask.
  const asked = [];
  await assert.rejects(door({ get_product: kernelRefusal("PRODUCT_NOT_FOUND") }, { asked, sellers: { [SIG]: ["merch_obs_brandx"] } }).callTool("get_product", { product_id: SIG }), isRefusal("UNKNOWN_PRODUCT_ID", "product_id_not_found"));
  await assert.rejects(door({ get_product: kernelRefusal("PRODUCT_NOT_FOUND") }, { asked }).callTool("get_product", { merchant_id: "merch_shop_b", product_id: "9001" }), isRefusal("UNKNOWN_PRODUCT_ID", "product_id_not_found"));
  assert.deepEqual(asked, []);
});

test("on: every other error passes through as the very same object", async () => {
  for (const failure of [
    new PivotaCommerceError("MERCHANT_UNAVAILABLE", { operation: "get_product_detail", upstream_status: 503 }),
    new PivotaCommerceError("UNKNOWN_PRODUCT_ID", { operation: "get_product_detail", upstream_code: "MISSING_MERCHANT_CONTEXT" }),
    new PivotaCommerceError("NO_MERCHANT_OFFER", { reason: "merchant_not_purchasable" }),
    new Error("boom"),
    Object.assign(new Error("forged"), { code: "NO_MERCHANT_OFFER", detail: { operation: "get_product_detail" } }),
  ]) {
    await assert.rejects(door({ get_product: failure }).callTool("get_product", { product_id: SIG }), (e) => e === failure);
  }
  const offersFailure = kernelRefusal(RESOLVED_BODY);
  await assert.rejects(door({ get_offers: offersFailure }).callTool("get_offers", { product_id: SIG }), (e) => e === offersFailure);
});

// --- get_offers -------------------------------------------------------------------------------------------

test("on: get_offers refuses product_group_id by name, before anything is read", async () => {
  const calls = [];
  const asked = [];
  await assert.rejects(door({ get_offers: {} }, { calls, asked }).callTool("get_offers", { product_group_id: GROUP }), isRefusal("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "product_group_id_argument"));
  await assert.rejects(door({ get_offers: {} }, { calls, asked }).callTool("get_offers", { product_id: SIG, product_group_id: "" }), isRefusal("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "product_group_id_argument"));
  assert.deepEqual([calls, asked], [[], []]);
});

test("on: an empty get_offers answer says why, and no sig_ group id is echoed in its metadata", async () => {
  const offer = { signal_type: "offer" };
  const answer = (value) => door({ get_offers: value }).callTool("get_offers", { product_id: SIG });
  assert.deepEqual((await answer({ subject: {}, best_offer: offer, signals: [offer], metadata: { offer_count: 1, product_group_id: GROUP } })).metadata, { offer_count: 1, product_group_id: null });
  assert.equal((await answer({ best_offer: offer, signals: [offer], metadata: { product_group_id: "pg_1" } })).metadata.product_group_id, "pg_1");
  assert.equal((await answer({ best_offer: null, signals: [], metadata: { offer_count: 0 } })).metadata.reason, "no_offer_for_product");
  assert.equal((await answer({ best_offer: null, signals: [] })).metadata.reason, "no_offer_for_product");
  assert.equal((await answer({ best_offer: null, signals: [], metadata: { reason: "market_not_priced" } })).metadata.reason, "market_not_priced");
  assert.equal((await answer({ best_offer: offer, signals: [offer], metadata: {} })).metadata.reason, undefined);
  assert.equal((await answer({ best_offer: null, signals: [offer], metadata: {} })).metadata.reason, undefined);
  assert.equal(await answer(null), null);
});

// --- tools/list -------------------------------------------------------------------------------------------

test("on: the tool list declares the two read tools the door's way, and nothing else differently", () => {
  const surface = createCommerceToolSurface({ async execute() { return {}; } }, { cache: false });
  const before = JSON.stringify(surface.tools);
  const d = partnerDoorSurface(surface, { enabled: true });
  const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
  const off = byName(surface.tools);
  const on = byName(d.tools);
  assert.deepEqual(Object.keys(on), Object.keys(off));
  for (const name of Object.keys(off)) {
    if (name === "get_product" || name === "get_offers") continue;
    assert.equal(on[name], off[name], `${name} is the surface's own definition`);
  }
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
  assert.ok("product_group_id" in off.get_offers.inputSchema.properties);
  assert.deepEqual(Object.keys(on.get_offers.inputSchema.properties), Object.keys(off.get_offers.inputSchema.properties).filter((k) => k !== "product_group_id"));
  assert.equal(on.get_offers.description, off.get_offers.description);
  // The surface's own definitions (which the public and UCP doors read) are not edited.
  assert.equal(JSON.stringify(surface.tools), before);
  const other = { name: "search_catalog", inputSchema: { properties: { product_group_id: {} } } };
  assert.equal(partnerDoorToolDefinition(other), other);
  assert.equal(partnerDoorToolDefinition({ name: "get_product" }).description, undefined);
});

// --- the codes --------------------------------------------------------------------------------------------

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

test("each of the three codes has its own audit event and metric", () => {
  const seen = new Set();
  for (const code of ["PRODUCT_NOT_SERVABLE", "PRODUCT_GROUP_ID_NOT_PRODUCT_ID", "MERCHANT_PRODUCT_MISMATCH"]) {
    const entry = ERROR_OBSERVABILITY[code];
    assert.ok(entry, code);
    assert.ok(AUDIT_EVENTS.includes(entry.event), entry.event);
    assert.ok(!["no_merchant_offer", "unknown_product_id", "merchant_unavailable"].includes(entry.metric), `${code} is not folded into an existing metric`);
    seen.add(entry.event).add(entry.metric);
  }
  assert.equal(seen.size, 3);
});

test("a withheld product is HTTP 404 on the ACP adapter and on the invoke route alike", async () => {
  const { readFileSync } = await import("node:fs");
  const acp = readFileSync(new URL("../../safety-kernel/src/protocol/acpRestAdapter.js", import.meta.url), "utf8");
  const statusTable = acp.slice(acp.indexOf("const STATUS_BY_CODE = Object.freeze({"), acp.indexOf("});", acp.indexOf("const STATUS_BY_CODE = Object.freeze({")));
  assert.match(statusTable, /\n  PRODUCT_NOT_SERVABLE: 404,\n/);
  const server = readFileSync(new URL("../../src/server.js", import.meta.url), "utf8");
  const fn = server.slice(server.indexOf("function statusForCommerceKernelError(code) {"));
  assert.match(fn.slice(0, 1600), /case 'PRODUCT_NOT_SERVABLE':\n\s+return 404;/);
  assert.match(fn.slice(0, 1600), /case 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID':\n\s+case 'MERCHANT_PRODUCT_MISMATCH':\n\s+return 400;/);
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
  assert.deepEqual(errorBody(new PivotaCommerceError("PRODUCT_GROUP_ID_NOT_PRODUCT_ID", { reason: "group_has_no_servable_product" })).detail, { reason: "group_has_no_servable_product" });
  assert.deepEqual(errorBody(new PivotaCommerceError("MERCHANT_PRODUCT_MISMATCH", { reason: "merchant_not_seller_of_product" })).detail, { reason: "merchant_not_seller_of_product" });
  for (const reason of ["Seller A <a@example.com>", "x".repeat(65), "", 7, null]) {
    assert.equal(errorBody(new PivotaCommerceError("PRODUCT_NOT_SERVABLE", { reason })).detail, undefined, String(reason));
  }
  for (const code of ["NO_MERCHANT_OFFER", "UNKNOWN_PRODUCT_ID", "MERCHANT_UNAVAILABLE"]) {
    assert.equal(errorBody(new PivotaCommerceError(code, { reason: "product_id_not_found" })).detail, undefined, code);
  }
});

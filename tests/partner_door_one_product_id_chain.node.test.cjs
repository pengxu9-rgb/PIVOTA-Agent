'use strict';

// PARTNER_DOOR_ONE_PRODUCT_ID, THROUGH THE REAL /mcp DOOR (partner-door design rule 5: every check starts from a
// search result and passes only ids a partner receives).
//
//   search_catalog -> get_product (the row's ids) -> get_offers (the ids of the get_product answer)
//                  -> get_product again (those same ids) -> get_product (the product_id alone)
//
// over a minted external-seed product, a mirror row and a connected-merchant row, then every refusal the flag
// introduces. The child (tests/_support/partnerDoorChainChild.cjs) runs once with the flag on and once without
// it, each in its own process (the tool surface reads the flag when it loads); its header lists what is real and
// what is stubbed.
//
// Flag on:
//   - a search row and a product answer carry no group id field, and no signature other than their own under the
//     signature's other names; `id`, variant ids, group members and other sellers' listings are left as they are;
//   - no id search served is ever answered NO_MERCHANT_OFFER or UNKNOWN_PRODUCT_ID, with the seller the door
//     itself returned, with the shared seed seller name, or with no seller;
//   - the answer's product_id is the signature that was asked with, on the connected merchant's lane too (whose
//     backend is asked by, and answers, its platform id);
//   - a group id resolves to the member get_pdp_v2's group lookup elects (one product listed by two sellers
//     included), or is refused as a group id when nothing servable is in it;
//   - a seller the product is not known under is refused, not dropped; one it IS known under is accepted even
//     when get_pdp_v2 answered another seller of it;
//   - a withheld product, an unknown id and a temporarily unavailable read are three codes.
// Flag off: the door answers as it did (the differential against origin/main is run outside this suite; here
// the same chain shows the old answers, so each flag-on assertion is seen to depend on the flag).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { IDS } = require('./_support/partnerDoorFixture.cjs');
const CHILD = path.join(__dirname, '_support', 'partnerDoorChainChild.cjs');
const CATALOG_SIGNATURE = /^sig_[0-9a-f]{32}$/;

function runChild(env, port) {
  const childEnv = { ...process.env };
  delete childEnv.PARTNER_DOOR_ONE_PRODUCT_ID;
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, String(port)], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err.slice(-2000)}`));
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        reject(new Error(`unreadable child output: ${e.message}; ${out.slice(-500)}`));
      }
    });
  });
}

const errorOf = (c) => (c && c.isError && c.value && c.value.error) || null;
const codeOf = (c) => (errorOf(c) ? errorOf(c).code : null);
const productOf = (c) => (c && !c.isError && c.value && c.value.product) || null;
const NEVER_FOR_A_SERVED_ID = ['NO_MERCHANT_OFFER', 'UNKNOWN_PRODUCT_ID'];

let ON;
let OFF;
test.before(async () => {
  [ON, OFF] = await Promise.all([
    runChild({ PARTNER_DOOR_ONE_PRODUCT_ID: 'on' }, 4393),
    runChild({}, 4394),
  ]);
});

const SERVED = [IDS.SIG_MINTED, IDS.SIG_MIRROR, IDS.SIG_CONNECTED];

test('the fixture reaches the door: a minted, a mirror and a connected row, and one served under a group-shaped id', () => {
  for (const run of [ON, OFF]) {
    assert.equal(run.search.isError, false);
    assert.deepEqual(run.search.value.products.slice(0, 3).map((r) => r.product_id), SERVED);
    assert.deepEqual(run.search.value.products.map((r) => r.merchant_id), [IDS.SELLER_MINTED, IDS.SELLER_MIRROR, IDS.SELLER_CONNECTED, IDS.SELLER_EMITTED]);
    assert.equal(run.chains.length, 4);
    assert.equal(run.merchant_calls, 0, 'no merchant is contacted');
  }
  // The fourth row is the production-shaped one: flag off, its own product_id is the 24-hex id.
  assert.equal(OFF.search.value.products[3].product_id, IDS.GROUP_EMITTED);
  assert.equal(OFF.search.value.products[3].pivota_signature_id, IDS.SIG_EMITTED);
});

// The fields that put a second product-looking id on a row: a group id under its two names (or any other
// top-level name), and a signature that is not the row's own under the signature's other names.
const GROUP_ID_KEYS = ['product_group_id', 'sellable_item_group_id', 'canonical_sig_id'];
const SIGNATURE_ALIAS_KEYS = ['pivota_signature_id', 'signature_id', 'canonical_route_sig_id'];
const GROUP_ID = /^sig_[0-9a-f]{24}$/;
function secondIds(row) {
  const out = [];
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string' || key === 'product_id' || value === row.product_id) continue;
    if (GROUP_ID.test(value)) out.push(key);
    else if ((GROUP_ID_KEYS.includes(key) || SIGNATURE_ALIAS_KEYS.includes(key)) && /^sig_/.test(value)) out.push(key);
  }
  return out;
}

test('flag on: every search row has a 36-character product_id, no group id field, and keeps its other ids', () => {
  for (const row of ON.search.value.products) {
    assert.match(row.product_id, CATALOG_SIGNATURE);
    assert.deepEqual(secondIds(row), []);
    for (const key of GROUP_ID_KEYS) assert.equal(Object.prototype.hasOwnProperty.call(row, key), false, key);
    // The same id under its other names is the same id, and stays; so does `id`.
    assert.equal(row.id, row.product_id);
    assert.equal(row.pivota_signature_id, row.product_id);
    assert.equal(row.signature_id, row.product_id);
    // Another seller's listing keeps ITS signature: that is the id a partner passes for that listing.
    assert.deepEqual(row.other_seller_listings, [{ merchant_id: IDS.SELLER_OTHER_CONNECTED, pivota_signature_id: `sig_${'0'.repeat(32)}`, product_key: 'prod::shop-b::1' }]);
  }
  // Nothing but the group id fields left the rows that were already served under their signature.
  const withoutGroup = OFF.search.value.products.slice(0, 3).map(({ product_group_id: _g, sellable_item_group_id: _s, ...rest }) => rest);
  assert.deepEqual(ON.search.value.products.slice(0, 3), withoutGroup);
});

test('flag on: a row served under a group-shaped id is re-stamped to its signature, and keeps its signature fields', () => {
  const off = OFF.search.value.products[3];
  const on = ON.search.value.products[3];
  assert.equal(off.id, IDS.GROUP_EMITTED);
  assert.equal(on.product_id, IDS.SIG_EMITTED);
  assert.equal(on.id, IDS.SIG_EMITTED, '`id` moves with product_id');
  assert.equal(on.pivota_signature_id, IDS.SIG_EMITTED);
  assert.equal(on.signature_id, IDS.SIG_EMITTED);
  // The group id is gone under every top-level name, and nothing else changed.
  const { id: _i, product_id: _p, canonical_entity_id: _c, product_group_id: _g, sellable_item_group_id: _s, ...rest } = off;
  assert.deepEqual(on, { id: IDS.SIG_EMITTED, product_id: IDS.SIG_EMITTED, ...rest });
  assert.equal(JSON.stringify(on).includes(IDS.GROUP_EMITTED), false);
});

test('AN ID THE DOOR EMITTED KEEPS WORKING: flag on is never worse than flag off for the group-shaped row', () => {
  const priced = (c) => { const p = productOf(c); return Boolean(p) && typeof p.price === 'number' && p.price > 0 && p.currency === 'USD'; };
  const offered = (c) => Boolean(c) && !c.isError && Boolean(c.value.best_offer);
  // The chain from the row, each flag with the ids IT served.
  const on = ON.chains[3];
  const off = OFF.chains[3];
  assert.equal(off.get_product.args.product_id, IDS.GROUP_EMITTED);
  assert.equal(on.get_product.args.product_id, IDS.SIG_EMITTED);
  for (const step of ['get_product', 'get_product_again', 'get_product_no_merchant']) {
    assert.equal(priced(off[step]), true, `flag off ${step}`);
    assert.equal(priced(on[step]), true, `flag on ${step}`);
    assert.equal(productOf(on[step]).price, productOf(off[step]).price);
    assert.equal(productOf(on[step]).merchant_id, productOf(off[step]).merchant_id);
  }
  assert.equal(offered(off.get_offers), true);
  assert.equal(offered(on.get_offers), true);
  // The 24-hex id itself, as a partner that received it before the flag went on sends it back: every call that
  // answers with the flag off answers with it on, by the SAME upstream call, and nothing is refused.
  for (const name of ['gp_emitted_id', 'gp_emitted_id_no_merchant']) {
    assert.equal(priced(OFF.cases[name]), true, name);
    assert.equal(priced(ON.cases[name]), true, name);
    assert.deepEqual(ON.cases[name].upstream, OFF.cases[name].upstream);
    assert.deepEqual(ON.cases[name].upstream, [{ op: 'get_pdp_v2', product_id: IDS.GROUP_EMITTED }], 'asked with the id as sent');
    // The answer comes back under the signature (and `id` with it), the group id gone.
    assert.equal(productOf(ON.cases[name]).product_id, IDS.SIG_EMITTED);
    assert.equal(productOf(OFF.cases[name]).product_id, IDS.GROUP_EMITTED);
    assert.deepEqual(secondIds(productOf(ON.cases[name])), []);
  }
  for (const name of ['go_emitted_id', 'go_emitted_id_no_signature_offer']) {
    assert.equal(offered(OFF.cases[name]), true, name);
    assert.equal(offered(ON.cases[name]), true, name);
    // ONE offers.resolve call, with the id the partner sent: the id is not swapped for the signature.
    assert.deepEqual(ON.cases[name].upstream, OFF.cases[name].upstream);
    assert.equal(ON.cases[name].upstream.length, 1);
    assert.equal(ON.cases[name].upstream[0].product_id, ON.cases[name].args.product_id);
    assert.deepEqual(ON.cases[name].value.best_offer, OFF.cases[name].value.best_offer);
  }
  // No case that answers with the flag off is an error with it on, except the ones the flag exists to refuse.
  const refusedOnPurpose = new Set(['go_group_argument', 'gp_wrong_observed_seller', 'gp_shared_seed_seller_of_connected', 'gp_fallback_other_seller', 'gp_sibling_seller_of_group']);
  for (const [name, c] of Object.entries(OFF.cases)) {
    if (c.isError || refusedOnPurpose.has(name)) continue;
    assert.equal(ON.cases[name].isError, false, `${name} answers with the flag off and must with it on`);
  }
});

test('flag off: the same rows carry the 24-hex group id under two names', () => {
  const row = OFF.search.value.products[0];
  assert.deepEqual(secondIds(row).sort(), ['product_group_id', 'sellable_item_group_id']);
  assert.equal(row.product_group_id, IDS.GROUP_MINTED);
});

test('flag on: get_product with exactly the row\'s ids answers the product, priced in USD, under the id it was asked with', () => {
  for (const chain of ON.chains) {
    const call = chain.get_product;
    assert.deepEqual(call.args, { merchant_id: chain.row.merchant_id, product_id: chain.row.product_id, market: 'US' });
    assert.ok(!NEVER_FOR_A_SERVED_ID.includes(codeOf(call)), `${chain.row.product_id}: ${codeOf(call)}`);
    const product = productOf(call);
    assert.ok(product, `${chain.row.product_id}: ${JSON.stringify(call.value)}`);
    assert.equal(product.product_id, chain.row.product_id);
    assert.equal(product.merchant_id, chain.row.merchant_id);
    assert.equal(typeof product.price, 'number');
    assert.equal(product.currency, 'USD');
    assert.equal(product.price_unavailable_reason, undefined);
    assert.deepEqual(secondIds(product), [], 'no group id, no other signature');
    assert.equal(product.pivota_signature_id, chain.row.product_id);
  }
});

test('flag on: the product keeps its variant ids and its group members, whatever they hold', () => {
  for (const chain of ON.chains.slice(0, 2)) {
    const product = productOf(chain.get_product);
    const before = productOf(OFF.chains.find((c) => c.row.product_id === chain.row.product_id).get_product);
    // The implicit default variant's id IS the product's signature (src/pdpBuilder.js): it is not "another id".
    assert.equal(product.variants[0].variant_id, chain.row.product_id);
    assert.equal(product.variants[0].sku_id, chain.row.product_id);
    assert.equal(product.default_variant_id, chain.row.product_id);
    assert.deepEqual(product.variants, before.variants);
    assert.deepEqual(product.group_members, before.group_members);
    assert.equal(product.group_members[0].pivota_signature_id, chain.row.product_id);
    // Only the two group id fields left the product.
    const { product_group_id: _g, sellable_item_group_id: _s, ...rest } = before;
    assert.deepEqual(product, rest);
  }
  const shared = productOf(ON.cases.gp_group_shared);
  assert.deepEqual(shared.group_members, [
    { merchant_id: IDS.SELLER_SHARED_BRAND, product_id: IDS.SEED_SHARED_BRAND, pivota_signature_id: IDS.SIG_SHARED_BRAND },
    { merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SOURCE_SHARED_RETAILER, pivota_signature_id: IDS.SIG_SHARED_RETAILER },
    { merchant_id: IDS.SELLER_SHARED_SIBLING, product_id: 'ext_sibling', pivota_signature_id: `sig_${'2'.repeat(32)}` },
  ], 'the other sellers keep their own signatures');
});

test('flag on: a connected merchant\'s product comes back under the signature, though its backend answers the platform id', () => {
  const chain = ON.chains.find((c) => c.row.product_id === IDS.SIG_CONNECTED);
  for (const step of ['get_product', 'get_product_again']) {
    // The kernel hop translated the signature and asked the backend by the merchant's platform id.
    assert.deepEqual(chain[step].upstream, [{ op: 'get_product_detail', merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SOURCE_CONNECTED }]);
    const product = productOf(chain[step]);
    assert.equal(product.product_id, IDS.SIG_CONNECTED);
    assert.equal(product.source_product_id, IDS.SOURCE_CONNECTED, 'the platform id is kept, under its own name');
    assert.equal(product.pivota_signature_id, IDS.SIG_CONNECTED);
    assert.equal(product.variants[0].variant_id, 'v-9001-1');
  }
  // The next call in the chain was made with the signature, not a platform id.
  assert.equal(chain.get_offers.args.product_id, IDS.SIG_CONNECTED);
  // Flag off, the same call hands the partner the platform id as product_id.
  const off = OFF.chains.find((c) => c.row.product_id === IDS.SIG_CONNECTED);
  assert.equal(productOf(off.get_product).product_id, IDS.SOURCE_CONNECTED);
  assert.deepEqual(off.get_product.upstream, chain.get_product.upstream);
});

test('flag on: get_offers with the ids get_product returned answers an offer', () => {
  for (const chain of ON.chains) {
    const served = productOf(chain.get_product);
    const call = chain.get_offers;
    assert.deepEqual(call.args, { merchant_id: served.merchant_id, product_id: served.product_id, market: 'US' });
    assert.equal(call.isError, false, JSON.stringify(call.value));
    assert.ok(call.value.best_offer, 'an offer');
    assert.equal(call.value.best_offer.value.currency, 'USD');
    assert.equal(call.value.metadata.offer_count, 1);
    // What the backend was asked: the same two ids, nothing else to resolve by.
    assert.deepEqual(call.upstream, [{ op: 'offers.resolve', merchant_id: served.merchant_id, product_id: served.product_id }]);
  }
});

test('flag on: get_product again with the RETURNED merchant_id, and with none, answers the same product', () => {
  for (const chain of ON.chains) {
    const first = productOf(chain.get_product);
    for (const step of ['get_product_again', 'get_product_no_merchant']) {
      const again = productOf(chain[step]);
      assert.ok(again, `${step} ${chain.row.product_id}: ${JSON.stringify(chain[step].value)}`);
      assert.equal(again.product_id, first.product_id);
      assert.equal(again.merchant_id, first.merchant_id);
      assert.equal(again.price, first.price);
    }
    assert.equal(chain.get_product_again.args.merchant_id, first.merchant_id);
    assert.equal(Object.prototype.hasOwnProperty.call(chain.get_product_no_merchant.args, 'merchant_id'), false);
  }
});

test('flag on: the shared seed seller name beside a seed product\'s signature is still accepted', () => {
  const product = productOf(ON.cases.gp_shared_seed_seller);
  assert.ok(product, JSON.stringify(ON.cases.gp_shared_seed_seller.value));
  assert.equal(product.product_id, IDS.SIG_MINTED);
  assert.equal(product.merchant_id, IDS.SELLER_MINTED);
});

test('flag on: a group id on get_product is the product get_pdp_v2\'s group lookup elects, or the group-id refusal', () => {
  for (const name of ['gp_group_minted', 'gp_group_minted_with_seller']) {
    const product = productOf(ON.cases[name]);
    assert.ok(product, `${name}: ${JSON.stringify(ON.cases[name].value)}`);
    assert.equal(product.product_id, IDS.SIG_MINTED);
    // The read took the signature lane with the member's signature.
    assert.deepEqual(ON.cases[name].upstream, [{ op: 'get_pdp_v2', product_id: IDS.SIG_MINTED }]);
  }
  // ONE PRODUCT, TWO SELLERS: the group's canonical (brand) member answers; it is not refused as "several".
  const shared = productOf(ON.cases.gp_group_shared);
  assert.ok(shared, JSON.stringify(ON.cases.gp_group_shared.value));
  assert.equal(shared.product_id, IDS.SIG_SHARED_BRAND);
  assert.equal(shared.merchant_id, IDS.SELLER_SHARED_BRAND);
  assert.deepEqual(ON.cases.gp_group_shared.upstream, [{ op: 'get_pdp_v2', product_id: IDS.SIG_SHARED_BRAND }]);
  // A group id beside a connected seller: the resolved signature is what gets translated and asked for.
  const connected = productOf(ON.cases.gp_group_connected_with_seller);
  assert.ok(connected, JSON.stringify(ON.cases.gp_group_connected_with_seller.value));
  assert.equal(connected.product_id, IDS.SIG_CONNECTED);
  // The id is tried as sent first (the backend knows no group id), then once more as the signature it resolves to.
  assert.deepEqual(ON.cases.gp_group_connected_with_seller.upstream, [
    { op: 'get_product_detail', merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.GROUP_CONNECTED },
    { op: 'get_product_detail', merchant_id: IDS.SELLER_CONNECTED, product_id: IDS.SOURCE_CONNECTED },
  ]);
  // Nothing servable in the group, and today's path cannot serve the id either: refused as a group id.
  for (const name of ['gp_group_unsigned', 'gp_group_unknown']) {
    const error = errorOf(ON.cases[name]);
    assert.equal(error.code, 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID');
    assert.equal(error.retriable, false);
    assert.deepEqual(error.detail, { reason: 'group_has_no_servable_product' });
    assert.match(error.message, /group id/);
    assert.match(error.message, /product_id from a search_catalog row/);
    assert.equal(codeOf(OFF.cases[name]), 'UNKNOWN_PRODUCT_ID', 'today\'s path cannot serve it either');
  }
});

test('flag on: get_offers asks with the id as sent, and only when that finds no offer tries the signature once', () => {
  for (const [name, signature] of [['go_group_minted', IDS.SIG_MINTED], ['go_group_shared', IDS.SIG_SHARED_BRAND]]) {
    assert.equal(ON.cases[name].isError, false);
    assert.equal(OFF.cases[name].value.best_offer, null, 'flag off, this id finds no offer');
    assert.equal(ON.cases[name].value.subject.id, signature);
    assert.ok(ON.cases[name].value.best_offer);
    assert.deepEqual(ON.cases[name].upstream, [
      { op: 'offers.resolve', merchant_id: null, product_id: ON.cases[name].args.product_id },
      { op: 'offers.resolve', merchant_id: null, product_id: signature },
    ]);
  }
  // A group with nothing servable is not refused on get_offers: the empty answer says why.
  assert.equal(ON.cases.go_group_unsigned.isError, false);
  assert.equal(ON.cases.go_group_unsigned.value.best_offer, null);
  assert.equal(ON.cases.go_group_unsigned.value.metadata.reason, 'no_offer_for_product');
  assert.deepEqual(ON.cases.go_group_unsigned.upstream, [{ op: 'offers.resolve', merchant_id: null, product_id: IDS.GROUP_UNSIGNED }]);
  const refused = errorOf(ON.cases.go_group_argument);
  assert.equal(refused.code, 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID');
  assert.deepEqual(refused.detail, { reason: 'product_group_id_argument' });
  assert.deepEqual(ON.cases.go_group_argument.upstream, []);
  assert.equal(ON.tools.get_offers.properties.includes('product_group_id'), false);
  assert.equal(OFF.tools.get_offers.properties.includes('product_group_id'), true);
});

test('flag on: a merchant_id the product is not known under is refused, not dropped', () => {
  for (const name of ['gp_wrong_observed_seller', 'gp_wrong_connected_seller', 'gp_wrong_seller_of_connected', 'gp_shared_seed_seller_of_connected', 'gp_fallback_other_seller',
    'gp_sibling_seller_of_group', 'gp_connected_sibling_of_group']) {
    const error = errorOf(ON.cases[name]);
    assert.ok(error, `${name}: ${JSON.stringify(ON.cases[name].value)}`);
    assert.equal(error.code, 'MERCHANT_PRODUCT_MISMATCH');
    assert.equal(error.retriable, false);
    assert.deepEqual(error.detail, { reason: 'merchant_not_seller_of_product' });
    assert.match(error.message, /merchant_id does not match/);
  }
});

test('flag on: a SIBLING seller of the same group is refused on both lanes, not served the other seller\'s row', () => {
  // The answered product lists the sibling among its group members; it is still another seller's product.
  assert.equal(ON.cases.gp_sibling_seller_of_group.args.merchant_id, IDS.SELLER_SHARED_SIBLING);
  assert.deepEqual(ON.cases.gp_sibling_seller_of_group.upstream, [{ op: 'get_pdp_v2', product_id: IDS.SIG_SHARED_BRAND }], 'the observed lane');
  assert.equal(ON.cases.gp_connected_sibling_of_group.upstream[0].op, 'get_product_detail', 'the connected lane');
  assert.equal(codeOf(ON.cases.gp_sibling_seller_of_group), codeOf(ON.cases.gp_connected_sibling_of_group));
  assert.equal(codeOf(ON.cases.gp_sibling_seller_of_group), 'MERCHANT_PRODUCT_MISMATCH');
  // Flag off, the observed lane serves the other seller's row under the sibling's name.
  assert.equal(productOf(OFF.cases.gp_sibling_seller_of_group).merchant_id, IDS.SELLER_SHARED_BRAND);
});

test('flag on: a seller the product IS known under is accepted, even when get_pdp_v2 answered another seller of it', () => {
  // The signature's catalog row is one seller's (the one search would name); get_pdp_v2 answered the group's
  // canonical member, another seller. Both are the product's sellers; so is the shared seed seller name.
  for (const name of ['gp_fallback_row_seller', 'gp_fallback_canonical_seller', 'gp_fallback_shared_seed_seller']) {
    const product = productOf(ON.cases[name]);
    assert.ok(product, `${name}: ${JSON.stringify(ON.cases[name].value)}`);
    assert.equal(product.product_id, IDS.SIG_FALLBACK);
    assert.equal(product.merchant_id, IDS.SELLER_FALLBACK_CANONICAL);
  }
  assert.equal(ON.cases.gp_fallback_row_seller.args.merchant_id, IDS.SELLER_FALLBACK_ROW);
});

test('flag off: the same wrong seller is dropped and another seller\'s row is served', () => {
  const product = productOf(OFF.cases.gp_wrong_observed_seller);
  assert.equal(product.merchant_id, IDS.SELLER_MINTED);
  assert.equal(OFF.cases.gp_wrong_observed_seller.args.merchant_id, IDS.SELLER_OTHER_OBSERVED);
});

test('flag on: a withheld product, an unknown id and an empty offer answer each say one thing', () => {
  const withheld = errorOf(ON.cases.gp_not_servable);
  assert.equal(withheld.code, 'PRODUCT_NOT_SERVABLE');
  assert.equal(withheld.retriable, false);
  assert.deepEqual(withheld.detail, { reason: 'not_serving_eligible' }, 'the serving gate\'s own reason');
  assert.equal(errorOf(ON.cases.gp_resolved_no_content).code, 'PRODUCT_NOT_SERVABLE');
  assert.deepEqual(errorOf(ON.cases.gp_resolved_no_content).detail, { reason: 'product_detail_not_found' });
  for (const name of ['gp_unknown_signature', 'gp_unknown_at_connected']) {
    assert.equal(codeOf(ON.cases[name]), 'UNKNOWN_PRODUCT_ID', name);
    assert.equal(errorOf(ON.cases[name]).retriable, false);
  }
  assert.equal(ON.cases.go_unknown_signature.isError, false);
  assert.equal(ON.cases.go_unknown_signature.value.best_offer, null);
  assert.equal(ON.cases.go_unknown_signature.value.metadata.reason, 'no_offer_for_product');
  // None of them is the "no offer" code.
  for (const [name, c] of Object.entries(ON.cases)) assert.notEqual(codeOf(c), 'NO_MERCHANT_OFFER', name);
});

test('flag on: a product with no price it may show says why; a read that cannot answer now is retriable', () => {
  const unpriced = productOf(ON.cases.gp_unpriced);
  assert.ok(unpriced, JSON.stringify(ON.cases.gp_unpriced.value));
  assert.equal(unpriced.price, null);
  assert.equal(unpriced.price_unavailable_reason, 'no_servable_price_in_market');
  assert.equal(productOf(OFF.cases.gp_unpriced).price_unavailable_reason, undefined);
  for (const run of [ON, OFF]) {
    const error = errorOf(run.cases.gp_temporarily_unavailable);
    assert.equal(error.code, 'MERCHANT_UNAVAILABLE');
    assert.equal(error.retriable, true);
  }
});

test('flag off: the withheld product and the per-merchant not-found both read NO_MERCHANT_OFFER', () => {
  for (const name of ['gp_not_servable', 'gp_resolved_no_content', 'gp_unknown_at_connected']) {
    assert.equal(codeOf(OFF.cases[name]), 'NO_MERCHANT_OFFER', name);
  }
  for (const name of ['gp_group_minted', 'gp_group_shared', 'gp_group_unknown']) assert.equal(codeOf(OFF.cases[name]), 'UNKNOWN_PRODUCT_ID', name);
  assert.equal(OFF.cases.go_unknown_signature.value.metadata.reason, undefined);
});

test('the tool list says what to pass: product_id from search, merchant_id optional (flag on only)', () => {
  assert.deepEqual(ON.tools.get_product.required, ['product_id']);
  assert.match(ON.tools.get_product.description, /product_id of a search_catalog row/);
  assert.match(ON.tools.get_product.description, /`merchant_id` is optional/);
  assert.deepEqual(OFF.tools.get_product.required, ['merchant_id', 'product_id']);
  assert.match(OFF.tools.get_product.description, /^Get full detail for one product \(merchant_id \+ product_id\)\. Read-only\./);
});

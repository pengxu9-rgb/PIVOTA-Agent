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
//   - a search row carries ONE `sig_` value, its `product_id`; so does a product answer;
//   - no id search served is ever answered NO_MERCHANT_OFFER or UNKNOWN_PRODUCT_ID, with the seller the door
//     itself returned, with the shared seed seller name, or with no seller;
//   - a group id resolves to its product, or is refused as a group id;
//   - a seller that is not the product's is refused, not dropped;
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

// Every string in `value` that starts with `sig_`, as [path, string].
function sigValues(value, at = '', out = []) {
  if (typeof value === 'string') {
    if (/^sig_/i.test(value.trim())) out.push([at, value]);
  } else if (Array.isArray(value)) {
    value.forEach((el, i) => sigValues(el, `${at}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) sigValues(v, at ? `${at}.${k}` : k, out);
  }
  return out;
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

test('the fixture reaches the door: three rows, a minted, a mirror and a connected one', () => {
  for (const run of [ON, OFF]) {
    assert.equal(run.search.isError, false);
    assert.deepEqual(run.search.value.products.map((r) => r.product_id), [IDS.SIG_MINTED, IDS.SIG_MIRROR, IDS.SIG_CONNECTED]);
    assert.deepEqual(run.search.value.products.map((r) => r.merchant_id), [IDS.SELLER_MINTED, IDS.SELLER_MIRROR, IDS.SELLER_CONNECTED]);
    assert.equal(run.chains.length, 3);
    assert.equal(run.merchant_calls, 0, 'no merchant is contacted');
  }
});

test('flag on: every search row has a 36-character product_id and no other sig_ value', () => {
  for (const row of ON.search.value.products) {
    assert.match(row.product_id, CATALOG_SIGNATURE);
    assert.deepEqual(sigValues(row), [['product_id', row.product_id]]);
  }
});

test('flag off: the same rows carry the signature under other names and the 24-hex group id', () => {
  const row = OFF.search.value.products[0];
  const fields = sigValues(row).map(([at]) => at).sort();
  assert.deepEqual(fields, ['id', 'pivota_signature_id', 'product_group_id', 'product_id', 'sellable_item_group_id', 'signature_id']);
  assert.equal(row.product_group_id, IDS.GROUP_MINTED);
});

test('flag on: get_product with exactly the row\'s ids answers the product, priced in USD', () => {
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
    assert.deepEqual(sigValues(product).filter(([at]) => at !== 'product_id'), [], 'the product answer carries one sig_ value');
  }
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

test('flag on: a group id on get_product is the product it names, or the group-id refusal', () => {
  for (const name of ['gp_group_minted', 'gp_group_minted_with_seller']) {
    const product = productOf(ON.cases[name]);
    assert.ok(product, `${name}: ${JSON.stringify(ON.cases[name].value)}`);
    assert.equal(product.product_id, IDS.SIG_MINTED);
    // The read re-entered the signature lane with the member's signature.
    assert.deepEqual(ON.cases[name].upstream, [{ op: 'get_pdp_v2', product_id: IDS.SIG_MINTED }]);
  }
  for (const [name, reason] of [['gp_group_several', 'group_has_several_products'], ['gp_group_unknown', 'group_has_no_servable_product']]) {
    const error = errorOf(ON.cases[name]);
    assert.equal(error.code, 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID');
    assert.equal(error.retriable, false);
    assert.deepEqual(error.detail, { reason });
    assert.match(error.message, /group id/);
    assert.match(error.message, /product_id from a search_catalog row/);
    assert.deepEqual(ON.cases[name].upstream, [], 'nothing was read for it');
  }
});

test('flag on: get_offers takes a group id the same way, and product_group_id is no longer an input', () => {
  assert.equal(ON.cases.go_group_minted.isError, false);
  assert.equal(ON.cases.go_group_minted.value.subject.id, IDS.SIG_MINTED);
  assert.ok(ON.cases.go_group_minted.value.best_offer);
  assert.deepEqual(ON.cases.go_group_minted.upstream, [{ op: 'offers.resolve', merchant_id: null, product_id: IDS.SIG_MINTED }]);
  assert.equal(codeOf(ON.cases.go_group_several), 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID');
  const refused = errorOf(ON.cases.go_group_argument);
  assert.equal(refused.code, 'PRODUCT_GROUP_ID_NOT_PRODUCT_ID');
  assert.deepEqual(refused.detail, { reason: 'product_group_id_argument' });
  assert.deepEqual(ON.cases.go_group_argument.upstream, []);
  assert.equal(ON.tools.get_offers.properties.includes('product_group_id'), false);
  assert.equal(OFF.tools.get_offers.properties.includes('product_group_id'), true);
});

test('flag on: a merchant_id that is not the product\'s seller is refused, not dropped', () => {
  for (const name of ['gp_wrong_observed_seller', 'gp_wrong_connected_seller', 'gp_wrong_seller_of_connected', 'gp_shared_seed_seller_of_connected']) {
    const error = errorOf(ON.cases[name]);
    assert.ok(error, `${name}: ${JSON.stringify(ON.cases[name].value)}`);
    assert.equal(error.code, 'MERCHANT_PRODUCT_MISMATCH');
    assert.equal(error.retriable, false);
    assert.deepEqual(error.detail, { reason: 'merchant_not_seller_of_product' });
    assert.match(error.message, /merchant_id does not match/);
  }
  // A connected seller that has no row under the signature is never sent to the per-merchant catalog.
  assert.deepEqual(ON.cases.gp_wrong_connected_seller.upstream, []);
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
  assert.equal(codeOf(OFF.cases.gp_group_minted), 'UNKNOWN_PRODUCT_ID');
  assert.equal(OFF.cases.go_unknown_signature.value.metadata.reason, undefined);
});

test('the tool list says what to pass: product_id from search, merchant_id optional (flag on only)', () => {
  assert.deepEqual(ON.tools.get_product.required, ['product_id']);
  assert.match(ON.tools.get_product.description, /product_id of a search_catalog row/);
  assert.match(ON.tools.get_product.description, /`merchant_id` is optional/);
  assert.deepEqual(OFF.tools.get_product.required, ['merchant_id', 'product_id']);
  assert.match(OFF.tools.get_product.description, /^Get full detail for one product \(merchant_id \+ product_id\)\. Read-only\./);
});

'use strict';

// THE THREE `/mcp` VIEWS TOGETHER: AGENT_CHECKOUT_MCP_STOREFRONT_ESCALATION_ENABLED under every combination of
// PARTNER_DOOR_ONE_PRODUCT_ID and GET_OFFERS_EMPTY_REASON (src/server.js wraps the surface in all three).
//
// One child process per combination of the two load-time flags; each runs the whole request set with the
// storefront flag off and then on (tests/_support/mcpStorefrontCartDoorChild.cjs). So all eight combinations
// of the three flags are answered by the real doors. Pinned:
//   - the checkout answers do not depend on the other two views (they pass checkout tools through untouched);
//   - the other two views still do their own work with the storefront flag on (their reads are the same on and off);
//   - an id exactly as each combination's own search returns it gets the store's cart.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { IDS, STORE_PRICE } = require('./_support/mcpStorefrontCartDoor.cjs');

const CHILD = path.join(__dirname, '_support', 'mcpStorefrontCartDoorChild.cjs');

function runChild(port, env) {
  const res = spawnSync(process.execPath, [CHILD, String(port)], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 240000,
  });
  const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('DOOR_RESULT '));
  assert.ok(line, `the door child printed no result (exit ${res.status}): ${String(res.stderr || '').slice(-2000)}`);
  return JSON.parse(line.slice('DOOR_RESULT '.length));
}

const COMBOS = [
  { name: 'neither', partnerDoor: false, emptyReason: false, port: 4422 },
  { name: 'partner door', partnerDoor: true, emptyReason: false, port: 4423 },
  { name: 'empty reason', partnerDoor: false, emptyReason: true, port: 4424 },
  { name: 'both', partnerDoor: true, emptyReason: true, port: 4425 },
];
for (const combo of COMBOS) {
  combo.result = runChild(combo.port, { COMBO_PARTNER_DOOR: combo.partnerDoor ? '1' : '', COMBO_EMPTY_REASON: combo.emptyReason ? '1' : '' });
}
const BASE = COMBOS[0];

const mask = (text) => String(text)
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<time>')
  .replace(/q_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'q_<random>');
const codesOf = (answer) => ((answer.value && answer.value.messages) || []).map((m) => m.code);
const toolsOf = (answer) => answer.body.result.tools;
const READ_KEYS = ['mcp.initialize', 'mcp.search', 'mcp.search_no_market', 'mcp.get_product', 'mcp.get_product_emitted', 'mcp.get_offers'];
// Every checkout request on /mcp. `create_from_search_row` is compared on its own: the id it passes is whatever
// that combination's search returned.
const CHECKOUT_KEYS = Object.keys(BASE.result.on).filter((k) => /^mcp\.(create|get|update|complete|cancel|payment_link)_/.test(k)
  && !['mcp.get_product', 'mcp.get_product_emitted', 'mcp.get_offers', 'mcp.get_order_unknown', 'mcp.create_from_search_row'].includes(k));

test('the request set covers the checkout tools', () => {
  assert.ok(CHECKOUT_KEYS.length >= 45, String(CHECKOUT_KEYS.length));
});

for (const combo of COMBOS.slice(1)) {
  test(`${combo.name}: every /mcp checkout answer is the one given with neither view on, flag off and flag on`, () => {
    for (const phase of ['off', 'on']) {
      for (const key of CHECKOUT_KEYS) {
        assert.equal(mask(combo.result[phase][key].raw), mask(BASE.result[phase][key].raw), `${phase} ${key}`);
        assert.deepEqual(combo.result[phase][key].store, BASE.result[phase][key].store, `${phase} ${key}`);
      }
    }
  });
}

for (const combo of COMBOS) {
  test(`${combo.name}: the storefront path is live with the flag on and dark with it off`, () => {
    const { off, on } = combo.result;
    assert.deepEqual(codesOf(on['mcp.create_priced']), ['checkout.priced_by_seller_storefront']);
    assert.equal(on['mcp.create_priced'].value.status, 'completes_on_seller_storefront');
    assert.equal(on['mcp.get_own_created'].value.session_id, on['mcp.create_priced'].value.session_id);
    assert.equal(off['mcp.create_no_market'].value.error.detail.reason, 'ucp_storefront_checkout_unavailable');
    for (const key of Object.keys(off).filter((k) => k.startsWith('mcp.'))) assert.deepEqual(off[key].store, [], key);
  });

  test(`${combo.name}: the other two views' own answers are the same with the storefront flag on as off`, () => {
    const { off, on } = combo.result;
    for (const key of READ_KEYS) assert.equal(mask(on[key].raw), mask(off[key].raw), key);
    // And each view is doing its own work in this combination.
    const getProduct = toolsOf(on['mcp.tools_list']).find((t) => t.name === 'get_product');
    assert.deepEqual(getProduct.inputSchema.required, combo.partnerDoor ? ['product_id'] : ['merchant_id', 'product_id']);
    const getOffers = toolsOf(on['mcp.tools_list']).find((t) => t.name === 'get_offers');
    assert.equal(getOffers.description.includes('reason_retriable'), combo.emptyReason);
    assert.equal(typeof on['mcp.get_offers'].value.metadata.reason_retriable === 'boolean', combo.emptyReason);
    const row = on['mcp.search'].value.products.find((p) => p.title === 'Lip Oil');
    assert.equal(row.product_id, combo.partnerDoor ? IDS.SIG_EMITTED : IDS.GROUP_EMITTED);
  });

  test(`${combo.name}: tools/list changes for the six checkout tools only, and only with the flag on`, () => {
    const { off, on } = combo.result;
    const offTools = toolsOf(off['mcp.tools_list']);
    const onTools = toolsOf(on['mcp.tools_list']);
    const changed = onTools.filter((t, i) => JSON.stringify(t) !== JSON.stringify(offTools[i])).map((t) => t.name).sort();
    assert.deepEqual(changed, ['cancel_checkout_session', 'complete_checkout_session', 'create_checkout_session', 'create_payment_link', 'get_checkout_session', 'update_checkout_session']);
    assert.equal(off['mcp.tools_list'].raw.includes('completes_on_seller_storefront'), false);
    // The checkout declarations are the same in every combination.
    const checkoutTools = (tools) => JSON.stringify(tools.filter((t) => changed.includes(t.name)));
    assert.equal(checkoutTools(onTools), checkoutTools(toolsOf(BASE.result.on['mcp.tools_list'])));
    assert.equal(checkoutTools(offTools), checkoutTools(toolsOf(BASE.result.off['mcp.tools_list'])));
  });

  test(`${combo.name}: the id this combination's own search returned gets the store's cart`, () => {
    const { on } = combo.result;
    const row = on['mcp.search'].value.products.find((p) => p.title === 'Lip Oil');
    const a = on['mcp.create_from_search_row'];
    assert.equal(a.isError, false, a.raw);
    assert.deepEqual(codesOf(a), ['checkout.priced_by_seller_storefront']);
    assert.equal(a.value.line_items[0].product_id, row.product_id);
    assert.equal(a.value.totals.find((t) => t.type === 'total').amount, STORE_PRICE[IDS.VARIANT_EMITTED]);
  });

  test(`${combo.name}: the UCP door, the public door and the invoke route do not move`, () => {
    const { off, on } = combo.result;
    const keys = Object.keys(on).filter((k) => !k.startsWith('mcp.'));
    for (const key of keys) {
      assert.equal(mask(on[key].raw), mask(off[key].raw), key);
      assert.equal(mask(on[key].raw), mask(BASE.result.on[key].raw), key);
    }
  });
}

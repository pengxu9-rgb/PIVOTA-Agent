// The verifier's DEFAULT door, end to end through the real buyer-agent client and the real public transport, with
// node:https replaced by a recorder (review of gw#2552, T2-T4). A bearer credential is configured in env, as a buyer
// checkout lane would have it. Pinned:
//   - no request the verifier makes carries an Authorization header (its client is capped below the TOKEN tier),
//     while the checkout door built from the SAME env does carry it (so the absence is the cap, not a missing env);
//   - a failed profile fetch is not retried (the checkout door's client retries it);
//   - create_cart is sent exactly once.
// Its own file: the default door is a process-wide singleton built on first use, after the env below is set.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const TOKEN = 'fixture-bearer-token-never-sent-by-the-verifier';
process.env.UCP_AGENT_CREDENTIAL = TOKEN;
process.env.UCP_AGENT_PROFILE_URL = 'https://agent.example/.well-known/ucp-agent';

const { verifyCodeOnMerchantDoor, createMerchantDoor } = await import('../src/ucpMerchantDoorPricing.js');

const V = '44012345678901';
const CODE = 'SAVE15';
const requests = [];
let realRequest;

function profileFor(host) {
  return {
    ucp: {
      version: '2026-04-08',
      services: { 'dev.ucp.shopping': [{ version: '2026-04-08', transport: 'mcp', endpoint: `https://${host}/api/ucp/mcp` }] },
      capabilities: { 'dev.ucp.shopping.discount': [{ version: '2026-04-08', extends: ['dev.ucp.shopping.cart', 'dev.ucp.shopping.checkout'] }] },
    },
  };
}

function cartFor(host) {
  const payload = {
    id: 'gid://shopify/Cart/c1', currency: 'USD', continue_url: `https://${host}/cart/c/abc?key=k`,
    line_items: [{ id: 'l0', item: { id: `gid://shopify/ProductVariant/${V}`, title: 't', price: 2500 }, quantity: 1,
      totals: [{ type: 'subtotal', amount: 2500 }, { type: 'total', amount: 2500 }] }],
    totals: [{ type: 'subtotal', amount: 2500 }, { type: 'items_discount', amount: -375 }, { type: 'total', amount: 2125 }],
    discounts: { codes: [CODE], applied: [{ code: CODE, amount: 375, allocations: [{ path: '$.line_items[0]', amount: 375 }] }] },
  };
  return { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

// Hosts whose profile fetch answers 503 (the no-retry check).
const DOWN = new Set();

before(() => {
  realRequest = https.request;
  https.request = (url, options, callback) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (chunk) => { body += chunk; };
    req.destroy = () => {};
    req.end = () => {
      const host = url.hostname;
      const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      let tool = null;
      try { tool = JSON.parse(body || '{}').params?.name || null; } catch { tool = null; }
      requests.push({ method: options.method || 'GET', host, path: url.pathname, headers, tool });
      let status = 200;
      let json;
      if (url.pathname === '/.well-known/ucp') {
        if (DOWN.has(host)) { status = 503; json = { error: 'down' }; } else json = profileFor(host);
      } else json = cartFor(host);
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = { 'content-type': 'application/json' };
        res.resume = () => {};
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(json)));
        res.emit('end');
      });
    };
    return req;
  };
});

after(() => { https.request = realRequest; });

const hasAuth = (r) => Object.keys(r.headers).includes('authorization');

describe("the verifier's default door, through the real client and transport", () => {
  test('no Authorization header on any request; create_cart sent once; the code reads as applied', async () => {
    const host = 'brand-one.example';
    const out = await verifyCodeOnMerchantDoor({ sellerHost: host, variantGid: V, market: 'US', code: CODE, expectedCurrency: 'USD' });
    assert.equal(out.result, 'applied', JSON.stringify(out));
    const mine = requests.filter((r) => r.host === host);
    assert.ok(mine.length >= 2, 'the profile fetch and the cart call went through the recorder');
    assert.equal(mine.filter(hasAuth).length, 0, 'no Authorization header');
    assert.equal(mine.filter((r) => r.tool === 'create_cart').length, 1);
    assert.equal(JSON.stringify(mine).includes(TOKEN), false);
  });

  test('control: the checkout door built from the same env DOES carry the bearer, so the absence above is the cap', async () => {
    const host = 'brand-two.example';
    const door = createMerchantDoor();
    const ep = await door.endpointFor(host);
    await door.createCart(ep.mcpEndpoint, { lineItems: [{ item: { id: `gid://shopify/ProductVariant/${V}` }, quantity: 1 }] });
    const cart = requests.find((r) => r.host === host && r.tool === 'create_cart');
    assert.equal(cart.headers.authorization, `Bearer ${TOKEN}`);
  });

  test('a failed profile fetch is not retried by the verifier (the checkout door would retry it)', async () => {
    const host = 'brand-down.example';
    DOWN.add(host);
    const out = await verifyCodeOnMerchantDoor({ sellerHost: host, variantGid: V, market: 'US', code: CODE, expectedCurrency: 'USD' });
    assert.deepEqual(out, { result: 'not_priced', reason: 'no_seller_door' });
    assert.equal(requests.filter((r) => r.host === host).length, 1, 'exactly one profile fetch');
    const control = 'brand-down-control.example';
    DOWN.add(control);
    await createMerchantDoor({ clientOptions: { retryBaseDelayMs: 1, retryMaxDelayMs: 1 } }).endpointFor(control);
    assert.ok(requests.filter((r) => r.host === control).length > 1, 'the checkout door retries the same failure');
  });
});

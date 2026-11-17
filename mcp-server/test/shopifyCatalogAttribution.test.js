// Shopify Promoted Placements attribution on the storefront escalation's store cart.
//
// What is pinned here, and why each matters:
//   - OFF (the default) makes no catalog call and leaves every cart byte for byte as before;
//   - only an id attributed to OUR catalog, for the SAME variant, is ever sent (anchored parse, exact parameters);
//   - the tracked id rides only in the create_cart body; matching the seller's lines still uses the bare gid, so a
//     store that echoes the bare id is still priced (the silent fall-back the review found);
//   - a cart with a tracked line carries none of our own attribution (cart.attribution, utm/pvt on the cart URL);
//   - every failure (no token, 429, timeout, `unauthorized`, a non-US buyer) builds today's cart;
//   - shadow never makes the cart wait, and never sends a tracked id;
//   - no id, click id, token or secret ever reaches a log line, and the token exchange never runs per call;
//   - the coupon verifier never asks the catalog.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  CATALOG_ATTRIBUTION_FLAG,
  CATALOG_ENDPOINT,
  TOKEN_ENDPOINT,
  catalogAttributionMode,
  modeForStore,
  isTrackedIdFor,
  createCatalogAttribution,
  attributionOutcomes,
  resetAttributionOutcomes,
} from '../src/shopifyCatalogAttribution.js';
import {
  MERCHANT_PRICING_FLAG,
  CART_ATTRIBUTION_FLAG,
  priceOnMerchantDoor,
  verifyCodeOnMerchantDoor,
} from '../src/ucpMerchantDoorPricing.js';

const require = createRequire(import.meta.url);
const { buildUcpCatalogDraftProfile, buildUcpBuyerAgentProfile } = require('../../src/services/ucpBuyerAgentProfile.js');

const CATALOG_ID = '01testcatalogid000000000000';
const DRAFT_PROFILE = 'https://agent.example/.well-known/ucp-agent-catalog-draft';
const CONFIG = {
  SHOPIFY_CATALOG_CLIENT_ID: 'client-id-value',
  SHOPIFY_CATALOG_CLIENT_SECRET: 'client-secret-value',
  SHOPIFY_CATALOG_ID: CATALOG_ID,
  SHOPIFY_CATALOG_DRAFT_PROFILE_URL: DRAFT_PROFILE,
};
const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const TRACKED = (n, click = 'clk_abc123') => `${GID(n)}?shcgid=${CATALOG_ID}&shclid=${click}`;
const V1 = '44012345678901';
const V2 = '44012345678902';
const ENDPOINT = 'https://store.example/api/ucp/mcp';
const CART_URL = 'https://store.example/cart/c/abc123?key=k';

// A JWT whose payload says it expires at `expSec`. Never a real token.
function fakeJwt(expSec) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: expSec, scopes: 'read_global_api_catalog_search' })}.sig`;
}

/** A fake fetch for the token endpoint and the catalog. `lookup(ids)` returns the variant objects to answer with. */
function fakeShopify({ lookup = (ids) => ids.map((id) => ({ id: TRACKED(id.split('/').pop()), seller: { domain: 'store.example' } })), tokenStatus = 200, catalogStatus = 200, messages, expSec, delayMs = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init.headers, body });
    if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); init.signal?.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    if (url === TOKEN_ENDPOINT) {
      return { status: tokenStatus, json: async () => (tokenStatus === 200 ? { access_token: fakeJwt(expSec ?? Math.floor(Date.now() / 1000) + 3600) } : {}) };
    }
    const ids = body.params.arguments.catalog.ids;
    const payload = { products: [{ title: 'x', variants: lookup(ids) }], ...(messages ? { messages } : {}) };
    return { status: catalogStatus, json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) };
  };
  return { calls, fetchImpl };
}

function sellerCart({ lines = [[GID(V1), 2, 12900]], continueUrl = CART_URL } = {}) {
  const sub = lines.reduce((a, [, q, p]) => a + q * p, 0);
  const payload = {
    id: 'gid://shopify/Cart/c1', currency: 'USD', continue_url: continueUrl,
    line_items: lines.map(([gid, quantity, price], i) => ({
      id: `line_${i}`, item: { id: gid, title: `Seller title ${i}`, price }, quantity,
      totals: [{ type: 'subtotal', amount: quantity * price }, { type: 'total', amount: quantity * price }],
    })),
    totals: [{ type: 'subtotal', amount: sub }, { type: 'total', amount: sub }],
  };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}
function fakeDoor({ create = () => sellerCart() } = {}) {
  const calls = [];
  return {
    calls,
    async endpointFor(host) { calls.push(['discover', host]); return ENDPOINT; },
    async createCart(ep, args) { calls.push(['create_cart', ep, structuredClone(args)]); return create(args); },
    async getCart(ep, cartId) { calls.push(['get_cart', ep, cartId]); return sellerCart(); },
  };
}
const ROW = Object.freeze({
  product_id: 'sig_a', title: 'Serum', price: 129, currency: 'USD',
  external_redirect_url: 'https://store.example/products/serum?utm_source=pivota&pvt_click_id=clk_ours',
  variants: [{ variant_id: 'sig_a', source_variant_id: V1 }],
});
function recordingLog() {
  const lines = [];
  return { lines, info: (o) => lines.push(o), warn: (o) => lines.push(o), error: (o) => lines.push(o) };
}
const doorArgs = (over = {}) => ({
  items: [{ product_id: 'sig_a', quantity: 2 }], rows: new Map([[ROW.product_id, ROW]]), sellerHost: 'store.example',
  catalogLink: ROW.external_redirect_url, market: 'US',
  env: { [MERCHANT_PRICING_FLAG]: '1', ...over.env }, ...over, env: { [MERCHANT_PRICING_FLAG]: '1', ...(over.env || {}) },
});

beforeEach(() => resetAttributionOutcomes());

describe('the switch', () => {
  test('off unless shadow or enforce', () => {
    for (const v of [undefined, '', '0', '1', 'true', 'on', 'ENFORCE_ME']) assert.equal(catalogAttributionMode({ [CATALOG_ATTRIBUTION_FLAG]: v }), 'off', String(v));
    assert.equal(catalogAttributionMode({ [CATALOG_ATTRIBUTION_FLAG]: ' Shadow ' }), 'shadow');
    assert.equal(catalogAttributionMode({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce' }), 'enforce');
  });
  test('the denylist turns a store off; a pilot list limits enforce, others shadow', () => {
    const env = { [CATALOG_ATTRIBUTION_FLAG]: 'enforce', SHOPIFY_CATALOG_ATTRIBUTION_DENY_HOSTS: 'bad.example', SHOPIFY_CATALOG_ATTRIBUTION_STORES: 'pilot.example' };
    assert.equal(modeForStore(env, 'www.bad.example'), 'off');
    assert.equal(modeForStore(env, 'pilot.example'), 'enforce');
    assert.equal(modeForStore(env, 'other.example'), 'shadow');
    assert.equal(modeForStore({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce' }, 'other.example'), 'enforce');
    assert.equal(modeForStore({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce' }, ''), 'off');
  });
});

describe('isTrackedIdFor — only our catalog, only the same variant', () => {
  test('accepts the exact shape', () => assert.equal(isTrackedIdFor(TRACKED(V1), V1, CATALOG_ID), true));
  for (const [label, id] of [
    ['another catalog', `${GID(V1)}?shcgid=someoneelse&shclid=clk_1`],
    ['another variant', TRACKED(V2)],
    ['no click id', `${GID(V1)}?shcgid=${CATALOG_ID}`],
    ['a repeated parameter', `${TRACKED(V1)}&shclid=clk_2`],
    ['an unsafe click id', `${GID(V1)}?shcgid=${CATALOG_ID}&shclid=a%20b`],
    ['a bare id', GID(V1)],
    ['text before the gid', `x${TRACKED(V1)}`],
    ['too long', `${TRACKED(V1)}&pad=${'a'.repeat(600)}`],
    ['not a string', 42],
  ]) test(`refuses ${label}`, () => assert.equal(isTrackedIdFor(id, V1, CATALOG_ID), false));
});

describe('lookupTracked — the client', () => {
  test('one token exchange, then the draft lookup with our catalog and the bearer token', async () => {
    const s = fakeShopify();
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
    const out = await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    assert.equal(out.reason, null);
    assert.equal(out.tracked.get(GID(V1)), TRACKED(V1));
    assert.equal(s.calls[0].url, TOKEN_ENDPOINT);
    assert.deepEqual(s.calls[0].body, { client_id: 'client-id-value', client_secret: 'client-secret-value', grant_type: 'client_credentials' });
    const lookup = s.calls[1];
    assert.equal(lookup.url, CATALOG_ENDPOINT);
    assert.match(lookup.headers.authorization, /^Bearer /);
    assert.equal(lookup.body.params.name, 'lookup_catalog');
    assert.equal(lookup.body.params.arguments.meta['ucp-agent'].profile, DRAFT_PROFILE);
    assert.deepEqual(lookup.body.params.arguments.catalog, { ids: [GID(V1)], catalog_id: CATALOG_ID, context: { address_country: 'US', currency: 'USD' } });
    await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    assert.equal(s.calls.filter((x) => x.url === TOKEN_ENDPOINT).length, 1, 'the token is cached, not exchanged per call');
  });

  test('the token is refreshed before its own expiry', async () => {
    let clock = 1_000_000_000_000;
    const s = fakeShopify({ expSec: Math.floor(clock / 1000) + 600 });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl, now: () => clock });
    await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    clock += 6 * 60 * 1000; // past exp - 5 min
    await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    assert.equal(s.calls.filter((x) => x.url === TOKEN_ENDPOINT).length, 2);
  });

  test('more than 10 lines are looked up in batches of 10', async () => {
    const s = fakeShopify();
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
    const gids = Array.from({ length: 12 }, (_, i) => GID(String(44012345670000 + i)));
    const out = await c.lookupTracked(gids, { market: 'US', sellerHost: 'store.example' });
    const lookups = s.calls.filter((x) => x.url === CATALOG_ENDPOINT);
    assert.deepEqual(lookups.map((x) => x.body.params.arguments.catalog.ids.length), [10, 2]);
    assert.equal(out.tracked.size, 12);
  });

  test('only valid ids for the asked variants are kept', async () => {
    const s = fakeShopify({ lookup: () => [
      { id: `${GID(V1)}?shcgid=othercatalog&shclid=clk_1` },
      { id: TRACKED(V2) },
      { id: GID(V1) },
    ] });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
    const out = await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    assert.equal(out.tracked.size, 0);
  });

  for (const [label, shopify, reason] of [
    ['an unauthorized message', { messages: [{ code: 'unauthorized', type: 'error' }] }, 'failed:unauthorized'],
    ['a 429', { catalogStatus: 429 }, 'failed:rate_limited'],
    ['a 500', { catalogStatus: 500 }, 'failed:http'],
    ['a failed token exchange', { tokenStatus: 401 }, 'failed:no_token'],
  ]) {
    test(`${label}: no tracked ids, and why`, async () => {
      const s = fakeShopify(shopify);
      const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
      const out = await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
      assert.equal(out.tracked.size, 0);
      assert.equal(out.reason, reason);
    });
  }

  test('a slow catalog runs out of budget: nothing tracked', async () => {
    const s = fakeShopify();
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
    await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' }); // warm the token
    const slow = fakeShopify({ delayMs: 500 });
    const c2 = createCatalogAttribution({ env: CONFIG, fetchImpl: slow.fetchImpl });
    const started = Date.now();
    const out = await c2.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example', budgetMs: 100 });
    assert.equal(out.tracked.size, 0);
    assert.ok(Date.now() - started < 450, 'the budget, not the catalog, ends the wait');
  });

  test('a failed exchange is not retried on every call (backoff)', async () => {
    const s = fakeShopify({ tokenStatus: 500 });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
    for (let i = 0; i < 3; i += 1) await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    assert.equal(s.calls.filter((x) => x.url === TOKEN_ENDPOINT).length, 1);
  });

  for (const market of ['GB', 'SG', 'DE', '', null, 'us']) {
    test(`market ${JSON.stringify(market)}: never asked`, async () => {
      const s = fakeShopify();
      const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
      const out = await c.lookupTracked([GID(V1)], { market, sellerHost: 'store.example' });
      assert.equal(out.reason, 'skipped:market');
      assert.equal(s.calls.length, 0);
    });
  }

  test('missing configuration: never asked', async () => {
    for (const drop of Object.keys(CONFIG)) {
      const s = fakeShopify();
      const env = { ...CONFIG, [drop]: '' };
      const out = await createCatalogAttribution({ env, fetchImpl: s.fetchImpl }).lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
      assert.equal(out.tracked.size, 0, drop);
      assert.equal(s.calls.filter((x) => x.url === CATALOG_ENDPOINT).length, 0, drop);
    }
  });
});

describe('the store cart', () => {
  const clientWith = (shopify) => createCatalogAttribution({ env: CONFIG, fetchImpl: shopify.fetchImpl });

  test('OFF: no catalog call; the cart is exactly today\'s', async () => {
    const s = fakeShopify();
    const door = fakeDoor();
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: clientWith(s) }));
    assert.ok(out);
    assert.equal(s.calls.length, 0);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
  });

  test('ENFORCE: the tracked id is sent; the seller echoing the bare id is still priced', async () => {
    const s = fakeShopify();
    const door = fakeDoor(); // the seller answers with the BARE gid
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: clientWith(s), env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce' } }));
    assert.ok(out, 'priced, not fallen back');
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: TRACKED(V1) }, quantity: 2 }], 'byte for byte as the catalog returned it');
    assert.equal(out.lineItems[0].item.id, 'sig_a');
  });

  test('ENFORCE: a seller echoing the TRACKED id is priced too', async () => {
    const s = fakeShopify();
    const door = fakeDoor({ create: (args) => sellerCart({ lines: [[args.lineItems[0].item.id, 2, 12900]] }) });
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: clientWith(s), env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce' } }));
    assert.ok(out);
  });

  test('ENFORCE with a tracked line: none of our attribution rides on the cart or its URL', async () => {
    const s = fakeShopify();
    const door = fakeDoor();
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: door, catalogAttribution: clientWith(s),
      env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce', [CART_ATTRIBUTION_FLAG]: '1' },
    }));
    assert.ok(out);
    assert.equal('cartAttribution' in door.calls[1][2], false);
    assert.equal(out.continueUrl, CART_URL, 'no utm/pvt members carried onto the cart URL');
  });

  test('ENFORCE, nothing tracked: our attribution is sent exactly as before', async () => {
    const s = fakeShopify({ lookup: () => [] });
    const door = fakeDoor();
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: door, catalogAttribution: clientWith(s),
      env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce', [CART_ATTRIBUTION_FLAG]: '1' },
    }));
    assert.ok(out);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
    assert.deepEqual(door.calls[1][2].cartAttribution, { utm_source: 'pivota', pvt_click_id: 'clk_ours' });
    assert.match(out.continueUrl, /utm_source=pivota/);
  });

  test('ENFORCE, the lookup throws: today\'s cart', async () => {
    const door = fakeDoor();
    const broken = { lookupTracked: async () => { throw new Error('boom'); } };
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: broken, env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce' } }));
    assert.ok(out);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
  });

  test('ENFORCE, a GB buyer: no catalog call, today\'s cart', async () => {
    const s = fakeShopify();
    const door = fakeDoor();
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, market: 'GB', catalogAttribution: clientWith(s), env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce' } }));
    assert.ok(out);
    assert.equal(s.calls.length, 0);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
  });

  test('SHADOW: the cart never waits for the lookup and never sends a tracked id', { timeout: 3000 }, async () => {
    const door = fakeDoor();
    const never = { lookupTracked: () => new Promise(() => {}) };
    const started = Date.now();
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: never, env: { [CATALOG_ATTRIBUTION_FLAG]: 'shadow' } }));
    assert.ok(out);
    assert.ok(Date.now() - started < 200);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
  });

  test('a re-read (get_cart) never asks the catalog', async () => {
    const s = fakeShopify();
    const door = fakeDoor();
    await priceOnMerchantDoor(doorArgs({ merchantDoor: door, cartId: 'gid://shopify/Cart/c1', catalogAttribution: clientWith(s), env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce' } }));
    assert.equal(s.calls.length, 0);
  });

  test('the log line carries counts only: no variant id, click id, token or secret', async () => {
    const s = fakeShopify();
    const log = recordingLog();
    await priceOnMerchantDoor(doorArgs({ merchantDoor: fakeDoor(), log, catalogAttribution: clientWith(s), env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce' } }));
    const line = log.lines.find((l) => l.event === 'ucp_shopify_catalog_attribution');
    assert.ok(line);
    assert.equal(line.tracked, 1);
    assert.equal(line.sent, true);
    const text = JSON.stringify(log.lines);
    for (const leak of [V1, 'shclid', 'clk_abc123', CATALOG_ID, 'client-secret-value', 'client-id-value', 'Bearer']) {
      assert.equal(text.includes(leak), false, leak);
    }
    assert.ok(attributionOutcomes().tracked >= 1);
  });

  test('the coupon verifier never asks the catalog, even with enforce on', async () => {
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => { seen.push(String(url)); throw new Error('no network in tests'); };
    try {
      const door = fakeDoor();
      await verifyCodeOnMerchantDoor({
        sellerHost: 'store.example', variantGid: GID(V1), market: 'US', code: 'SAVE10', expectedCurrency: 'USD',
        merchantDoor: door, env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce', ...CONFIG },
      });
      assert.equal(seen.some((u) => u.includes('catalog.shopify.com') || u.includes('api.shopify.com')), false);
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('the catalog draft profile', () => {
  test('draft version, catalog capabilities only, no cart and no checkout', () => {
    const p = buildUcpCatalogDraftProfile({ profileUrl: DRAFT_PROFILE });
    assert.equal(p.ucp.version, 'draft');
    assert.deepEqual(Object.keys(p.ucp.capabilities).sort(), ['dev.shopify.catalog.global', 'dev.ucp.shopping.catalog.lookup', 'dev.ucp.shopping.catalog.search']);
    for (const entries of Object.values(p.ucp.capabilities)) for (const e of entries) assert.equal(e.version, 'draft');
    assert.equal(p.ucp.profile_url, DRAFT_PROFILE);
    assert.deepEqual(p.ucp.payment_handlers, {});
    assert.equal(p.agent.completes_payment, false);
  });
  test('the store profile is untouched by it', () => {
    assert.notEqual(buildUcpBuyerAgentProfile({}).ucp.version, 'draft');
  });
  test('refuses a non-https self-reference', () => {
    assert.throws(() => buildUcpCatalogDraftProfile({ profileUrl: 'http://agent.example/x' }));
  });
});

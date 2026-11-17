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
const ENFORCE = Object.freeze({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce', SHOPIFY_CATALOG_ATTRIBUTION_STORES: 'store.example' });
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
    assert.equal(catalogAttributionMode({ ...ENFORCE }), 'enforce');
  });
  test('the denylist turns a store off; a pilot list limits enforce, others shadow', () => {
    const env = { [CATALOG_ATTRIBUTION_FLAG]: 'enforce', SHOPIFY_CATALOG_ATTRIBUTION_DENY_HOSTS: 'bad.example', SHOPIFY_CATALOG_ATTRIBUTION_STORES: 'pilot.example' };
    assert.equal(modeForStore(env, 'www.bad.example'), 'off');
    assert.equal(modeForStore(env, 'pilot.example'), 'enforce');
    assert.equal(modeForStore(env, 'other.example'), 'shadow');
    assert.equal(modeForStore({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce' }, 'other.example'), 'shadow', 'no pilot list: shadow, never fleet-wide');
    assert.equal(modeForStore({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce', SHOPIFY_CATALOG_ATTRIBUTION_STORES: '  ' }, 'other.example'), 'shadow');
    assert.equal(modeForStore({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce', SHOPIFY_CATALOG_ATTRIBUTION_STORES: '*' }, 'other.example'), 'enforce');
    assert.equal(modeForStore({ [CATALOG_ATTRIBUTION_FLAG]: 'enforce', SHOPIFY_CATALOG_ATTRIBUTION_STORES: '*', SHOPIFY_CATALOG_ATTRIBUTION_DENY_HOSTS: 'other.example' }, 'other.example'), 'off');
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
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: clientWith(s), env: { ...ENFORCE } }));
    assert.ok(out, 'priced, not fallen back');
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: TRACKED(V1) }, quantity: 2 }], 'byte for byte as the catalog returned it');
    assert.equal(out.lineItems[0].item.id, 'sig_a');
  });

  test('ENFORCE: a seller echoing the TRACKED id is priced too', async () => {
    const s = fakeShopify();
    const door = fakeDoor({ create: (args) => sellerCart({ lines: [[args.lineItems[0].item.id, 2, 12900]] }) });
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: clientWith(s), env: { ...ENFORCE } }));
    assert.ok(out);
  });

  test('ENFORCE with a tracked line: none of our attribution rides on the cart or its URL', async () => {
    const s = fakeShopify();
    const door = fakeDoor();
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: door, catalogAttribution: clientWith(s),
      env: { ...ENFORCE, [CART_ATTRIBUTION_FLAG]: '1' },
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
      env: { ...ENFORCE, [CART_ATTRIBUTION_FLAG]: '1' },
    }));
    assert.ok(out);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
    assert.deepEqual(door.calls[1][2].cartAttribution, { utm_source: 'pivota', pvt_click_id: 'clk_ours' });
    assert.match(out.continueUrl, /utm_source=pivota/);
  });

  test('ENFORCE, the lookup throws: today\'s cart', async () => {
    const door = fakeDoor();
    const broken = { lookupTracked: async () => { throw new Error('boom'); } };
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: broken, env: { ...ENFORCE } }));
    assert.ok(out);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
  });

  test('ENFORCE, a GB buyer: no catalog call, today\'s cart', async () => {
    const s = fakeShopify();
    const door = fakeDoor();
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, market: 'GB', catalogAttribution: clientWith(s), env: { ...ENFORCE } }));
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
    await priceOnMerchantDoor(doorArgs({ merchantDoor: door, cartId: 'gid://shopify/Cart/c1', catalogAttribution: clientWith(s), env: { ...ENFORCE } }));
    assert.equal(s.calls.length, 0);
  });

  test('the log line carries counts only: no variant id, click id, token or secret', async () => {
    const s = fakeShopify();
    const log = recordingLog();
    await priceOnMerchantDoor(doorArgs({ merchantDoor: fakeDoor(), log, catalogAttribution: clientWith(s), env: { ...ENFORCE } }));
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
        merchantDoor: door, env: { ...ENFORCE, ...CONFIG },
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

// ---- review round 1 (69f7eec1a): each block pins a finding -------------------------------------------------------

import {
  encodeEscalationId,
  decodeEscalationId,
  escalationCatalogTrackedOf,
} from '../src/ucpCheckoutEscalation.js';
import { CART_REFERRAL_FLAG } from '../src/ucpMerchantDoorPricing.js';

describe('review: the tracked id carries exactly Shopify\'s two members', () => {
  for (const [label, id] of [
    ['an extra parameter', `${TRACKED(V1)}&evil=x`],
    ['an encoded control character', `${TRACKED(V1)}&evil=%0D%0Ax`],
    ['an upper-case key', `${GID(V1)}?SHCGID=${CATALOG_ID}&shclid=clk_1`],
    ['a second catalog key', `${TRACKED(V1)}&shcgid2=y`],
    ['an empty key', `${TRACKED(V1)}&=x`],
    ['a percent-encoded click id', `${GID(V1)}?shcgid=${CATALOG_ID}&shclid=%6b`],
    ['a key without a value', `${GID(V1)}?shcgid=${CATALOG_ID}&shclid`],
  ]) test(`refuses ${label}`, () => assert.equal(isTrackedIdFor(id, V1, CATALOG_ID), false));
  test('either order of the two members is fine', () => {
    assert.equal(isTrackedIdFor(`${GID(V1)}?shclid=clk_1&shcgid=${CATALOG_ID}`, V1, CATALOG_ID), true);
  });
});

describe('review: the token', () => {
  const look = (c) => c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
  const exchanges = (s) => s.calls.filter((x) => x.url === TOKEN_ENDPOINT).length;

  test('an already expired token is never used, and the exchange backs off', async () => {
    const s = fakeShopify({ expSec: Math.floor(Date.now() / 1000) - 60 });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
    const a = await look(c);
    const b = await look(c);
    assert.equal(a.reason, 'failed:no_token');
    assert.equal(b.reason, 'failed:no_token');
    assert.equal(s.calls.filter((x) => x.url === CATALOG_ENDPOINT).length, 0);
    assert.equal(exchanges(s), 1);
  });

  test('an expiry written in milliseconds is read as one', async () => {
    let clock = 1_000_000_000_000;
    const s = fakeShopify({ expSec: clock + 10 * 60 * 1000 }); // a millisecond timestamp, 10 min out
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl, now: () => clock });
    await look(c);
    clock += 6 * 60 * 1000;
    await look(c);
    assert.equal(exchanges(s), 2, 'refreshed 5 min before the real expiry');
  });

  test('a claimed lifetime longer than an hour is capped', async () => {
    let clock = 1_000_000_000_000;
    const s = fakeShopify({ expSec: Math.floor(clock / 1000) + 5 * 3600 });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl, now: () => clock });
    await look(c);
    clock += 56 * 60 * 1000;
    await look(c);
    assert.equal(exchanges(s), 2);
  });

  test('a token about to expire is not re-exchanged on every call', async () => {
    let clock = 1_000_000_000_000;
    const s = fakeShopify({ expSec: Math.floor(clock / 1000) + 120 });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl, now: () => clock });
    for (let i = 0; i < 5; i += 1) { await look(c); clock += 1000; }
    assert.equal(exchanges(s), 1);
  });

  test('a 401 from the catalog drops the token; the next call exchanges a new one', async () => {
    let status = 401;
    const base = fakeShopify();
    const fetchImpl = async (url, init) => {
      const r = await base.fetchImpl(url, init);
      return url === CATALOG_ENDPOINT ? { status, json: r.json } : r;
    };
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl });
    const first = await look(c);
    assert.equal(first.reason, 'failed:token_refused');
    status = 200;
    const second = await look(c);
    assert.equal(second.reason, null);
    assert.equal(exchanges(base), 2);
  });

  test('two calls at once share one exchange', async () => {
    const s = fakeShopify({ delayMs: 30 });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl });
    await Promise.all([look(c), look(c)]);
    assert.equal(exchanges(s), 1);
  });

  test('no request ever follows a redirect', async () => {
    const seen = [];
    const s = fakeShopify();
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: (url, init) => { seen.push(init.redirect); return s.fetchImpl(url, init); } });
    await look(c);
    assert.deepEqual(seen, ['error', 'error']);
  });

  test('no budget: not tried, and said so', async () => {
    const s = fakeShopify();
    const out = await createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl }).lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example', budgetMs: 0 });
    assert.equal(out.reason, 'skipped:no_budget');
    assert.equal(s.calls.length, 0);
  });

  test('a failed lookup is not counted as untracked', async () => {
    const s = fakeShopify({ catalogStatus: 500 });
    await look(createCatalogAttribution({ env: CONFIG, fetchImpl: s.fetchImpl }));
    const o = attributionOutcomes();
    assert.equal(o.untracked || 0, 0);
    assert.equal(o['failed:http'], 1);
  });
});

describe('review: the door', () => {
  const clientWith = (shopify) => createCatalogAttribution({ env: CONFIG, fetchImpl: shopify.fetchImpl });
  const spy = (answer = new Map()) => {
    const calls = [];
    return { calls, lookupTracked: async (gids, opts) => { calls.push({ gids, ...opts }); return { tracked: answer, reason: null }; } };
  };

  test('SHADOW looks up and logs, without sending', async () => {
    const s = spy(new Map([[GID(V1), TRACKED(V1)]]));
    const log = recordingLog();
    const door = fakeDoor();
    await priceOnMerchantDoor(doorArgs({ merchantDoor: door, log, catalogAttribution: s, env: { [CATALOG_ATTRIBUTION_FLAG]: 'shadow' } }));
    await new Promise((r) => setImmediate(r));
    assert.equal(s.calls.length, 1);
    const line = log.lines.find((l) => l.event === 'ucp_shopify_catalog_attribution');
    assert.deepEqual([line.mode, line.tracked, line.sent], ['shadow', 1, false]);
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
  });

  test('the lookup budget leaves the cart call its reserve', async () => {
    for (const [budgetMs, expected] of [[5000, 800], [4000, 500], [3000, 0]]) {
      const s = spy();
      await priceOnMerchantDoor(doorArgs({ merchantDoor: fakeDoor(), budgetMs, catalogAttribution: s, env: { ...ENFORCE } }));
      assert.ok(s.calls[0].budgetMs <= expected && s.calls[0].budgetMs >= expected - 50, `${budgetMs}: ${s.calls[0].budgetMs}`);
    }
  });

  test('an assumed or unnamed market is never looked up', async () => {
    for (const referralSkip of ['market_assumed', 'market_unnamed']) {
      const s = spy();
      await priceOnMerchantDoor(doorArgs({ merchantDoor: fakeDoor(), referralSkip, catalogAttribution: s, env: { ...ENFORCE } }));
      assert.equal(s.calls.length, 0, referralSkip);
    }
  });

  test('ENFORCE: a tracked cart mints NO referral (a click no link carries would be orphaned), and is marked', async () => {
    let mints = 0;
    const minted = { kind: 'minted', clickId: 'clk_minted_1', pairs: [['utm_source', 'pivota'], ['pvt_click_id', 'clk_minted_1']], attributed: true };
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: fakeDoor(), catalogLink: 'https://store.example/products/serum',
      mintReferral: async () => { mints += 1; return minted; }, catalogAttribution: clientWith(fakeShopify()),
      env: { ...ENFORCE, [CART_REFERRAL_FLAG]: '1' },
    }));
    assert.ok(out);
    assert.equal(mints, 0);
    assert.equal(out.continueUrl, CART_URL);
    assert.equal(out.referral, undefined);
    assert.equal(out.catalogTracked, true);
  });
  test('ENFORCE, nothing tracked: the referral is minted exactly as today', async () => {
    let mints = 0;
    const minted = { kind: 'minted', clickId: 'clk_minted_1', pairs: [['utm_source', 'pivota'], ['pvt_click_id', 'clk_minted_1']], attributed: true };
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: fakeDoor(), catalogLink: 'https://store.example/products/serum',
      mintReferral: async () => { mints += 1; return minted; }, catalogAttribution: clientWith(fakeShopify({ lookup: () => [] })),
      env: { ...ENFORCE, [CART_REFERRAL_FLAG]: '1' },
    }));
    assert.equal(mints, 1);
    assert.match(out.continueUrl, /pvt_click_id=clk_minted_1/);
  });

  test('a RE-READ of a catalog-tracked cart gets none of our members back', async () => {
    const reread = (catalogTracked) => priceOnMerchantDoor(doorArgs({
      merchantDoor: fakeDoor(), cartId: 'gid://shopify/Cart/c1', catalogTracked,
      referralPairs: [['pvt_click_id', 'clk_minted_1']],
      env: { ...ENFORCE, [CART_REFERRAL_FLAG]: '1' },
    }));
    const tracked = await reread(true);
    assert.equal(tracked.continueUrl, CART_URL);
    const untracked = await reread(false);
    assert.match(untracked.continueUrl, /utm_source=pivota&pvt_click_id=clk_ours/, 'an ordinary cart keeps today\'s behaviour');
    // A plain catalog link: the re-read's referral pairs are what an ordinary cart carries, and a tracked one does not.
    const plainReread = (catalogTracked) => priceOnMerchantDoor(doorArgs({
      merchantDoor: fakeDoor(), cartId: 'gid://shopify/Cart/c1', catalogTracked, catalogLink: 'https://store.example/products/serum',
      referralPairs: [['pvt_click_id', 'clk_minted_1']],
      env: { ...ENFORCE, [CART_REFERRAL_FLAG]: '1' },
    }));
    assert.equal((await plainReread(true)).continueUrl, CART_URL);
    assert.match((await plainReread(false)).continueUrl, /pvt_click_id=clk_minted_1/);
  });

  test('a store refusing the tracked cart is named sent_rejected, and the bare retry prices it', async () => {
    const door = fakeDoor({ create: (args) => (String(args.lineItems[0].item.id).includes('?')
      ? { ok: true, status: 200, error: { message: 'Variant not found' } } : sellerCart()) });
    const signals = [];
    const log = recordingLog();
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, signals, log, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } }));
    assert.ok(out, 'the buyer still gets the store cart');
    assert.deepEqual(signals, [], 'no variant_invalid on a variant the store took bare');
    const creates = door.calls.filter((c) => c[0] === 'create_cart');
    assert.deepEqual(creates.map((c) => c[2].lineItems[0].item.id), [TRACKED(V1), GID(V1)]);
    const outcomes = log.lines.filter((l) => l.event === 'ucp_shopify_catalog_attribution').map((l) => l.outcome).filter(Boolean);
    assert.deepEqual(outcomes, ['sent_rejected', 'sent_fallback']);
    assert.equal(log.lines.find((l) => l.outcome === 'sent_fallback').retry, 'priced');
  });
});

describe('review: the escalation id remembers a catalog-tracked cart', () => {
  const items = [{ product_id: 'sig_a', quantity: 1 }];
  test('k is written only when asked, only on a seller-priced id', () => {
    const tracked = encodeEscalationId(items, 'gid://shopify/Cart/c1', 'store.example', { code: 'US' }, undefined, undefined, undefined, true);
    const plain = encodeEscalationId(items, 'gid://shopify/Cart/c1', 'store.example', { code: 'US' });
    const catalogueOnly = encodeEscalationId(items, undefined, undefined, { code: 'US' }, undefined, undefined, undefined, true);
    assert.equal(escalationCatalogTrackedOf(tracked), true);
    assert.equal(escalationCatalogTrackedOf(plain), false);
    assert.equal(escalationCatalogTrackedOf(catalogueOnly), false);
    assert.ok(decodeEscalationId(tracked));
    assert.equal(plain.length < tracked.length, true);
  });
  test('a forged k is no id of ours', () => {
    const forge = (body) => `esc_${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
    assert.equal(decodeEscalationId(forge({ v: 2, i: [['sig_a', 1]], c: 'gid://shopify/Cart/c1', h: 'store.example', k: 2 })), null);
    assert.equal(decodeEscalationId(forge({ v: 1, i: [['sig_a', 1]], k: 1 })), null);
  });
});

import { UCP_ESCALATION_FLAG, tryEscalateUcpCheckout } from '../src/ucpCheckoutEscalation.js';
import { resetDefaultCatalogAttribution } from '../src/shopifyCatalogAttribution.js';

describe('review: through the storefront escalation, create then re-read', () => {
  // The escalation builds the door's client itself (defaultCatalogAttribution: process.env + global fetch), so this
  // test sets the catalog configuration on process.env and answers Shopify through a fake global fetch.
  const ESC_ROW = Object.freeze({
    product_id: 'sig_esc', title: 'Serum', price: 129, currency: 'USD',
    external_redirect_url: 'https://store.example/products/serum?utm_source=pivota&pvt_click_id=clk_ours',
    variants: [{ variant_id: 'sig_esc', source_variant_id: V1 }],
  });
  const executor = {
    async execute(op, params) {
      if (op === 'get_product') return { product: params.payload.product.product_id === ESC_ROW.product_id ? structuredClone(ESC_ROW) : null };
      return { session_id: 'q_kernel' };
    },
  };
  const env = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1', ...ENFORCE };
  const NOW_MS = Date.UTC(2026, 10, 17, 12, 0, 0);

  test('a cart sent tracked is handed out clean on create AND on get_checkout', async () => {
    const saved = Object.fromEntries(Object.keys(CONFIG).map((k) => [k, process.env[k]]));
    const realFetch = globalThis.fetch;
    Object.assign(process.env, CONFIG);
    globalThis.fetch = fakeShopify().fetchImpl;
    resetDefaultCatalogAttribution();
    const records = [];
    const handoffRecorder = { async record(fields) { records.push(structuredClone(fields)); return { kind: 'recorded' }; } };
    try {
      const door = fakeDoor();
      const created = await tryEscalateUcpCheckout({
        op: { id: 'create_checkout_session', capability: 'checkout' },
        params: { idempotency_key: 'idem-0001', quote: { items: [{ product_id: ESC_ROW.product_id, quantity: 2 }] } },
        ctx: {}, executor, ucpArgs: { checkout: { context: { address_country: 'US' } } },
        env: { ...env, UCP_STOREFRONT_HANDOFF_RECORD_ENABLED: '1', PARTNER_IDENTITY_FORWARDING_ENABLED: '1' },
        now: NOW_MS, merchantDoor: door, handoffRecorder,
      });
      // P2-1: the record says it was catalog-attributed, and names no click of ours (the link carries none).
      assert.equal(records.length, 1);
      assert.equal(records[0].catalog_attributed, true);
      assert.equal('referral_click_id' in records[0], false);
      assert.ok(created && created.continue_url, 'seller-priced');
      assert.deepEqual(door.calls.find((c) => c[0] === 'create_cart')[2].lineItems, [{ item: { id: TRACKED(V1) }, quantity: 2 }]);
      assert.equal(created.continue_url, CART_URL);
      assert.equal(escalationCatalogTrackedOf(created.id), true);
      assert.equal(created.id.includes('shclid') || Buffer.from(created.id.slice(4), 'base64url').toString().includes('shclid'), false, 'no tracked id in the esc id');
      const again = await tryEscalateUcpCheckout({
        op: { id: 'get_checkout_session', capability: 'checkout' }, params: { session_id: created.id },
        ctx: {}, executor, ucpArgs: {}, env, now: NOW_MS, merchantDoor: door,
      });
      assert.equal(again.continue_url, CART_URL, 'the re-read does not put utm/pvt back');
    } finally {
      globalThis.fetch = realFetch;
      resetDefaultCatalogAttribution();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

// ---- the enforce follow-up (controller review of 272a063b8: P2-1, P2-2, P3s) ------------------------------------

import { BARE_RETRY_MIN_MS } from '../src/ucpMerchantDoorPricing.js';
import { BREAKER_FAILURES } from '../src/shopifyCatalogAttribution.js';

describe('follow-up: the bare retry after a tracked send', () => {
  const clientWith = (shopify) => createCatalogAttribution({ env: CONFIG, fetchImpl: shopify.fetchImpl });
  const outcomesOf = (log) => log.lines.filter((l) => l.event === 'ucp_shopify_catalog_attribution' && l.outcome).map((l) => l.outcome);

  for (const [label, refuse] of [
    ['an HTTP error', { ok: false, status: 500, error: { message: 'Internal Server Error' } }],
    ['a cart that does not match', sellerCart({ lines: [[GID(V1), 1, 12900]] })],
  ]) {
    test(`${label} on the tracked cart: one bare retry prices it, and both are logged`, async () => {
      const door = fakeDoor({ create: (args) => (String(args.lineItems[0].item.id).includes('?') ? refuse : sellerCart()) });
      const log = recordingLog();
      const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, log, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } }));
      assert.ok(out);
      assert.deepEqual(door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[2].lineItems[0].item.id), [TRACKED(V1), GID(V1)]);
      assert.deepEqual(outcomesOf(log), ['sent_fallback']);
      assert.equal(log.lines.find((l) => l.outcome === 'sent_fallback').retry, 'priced');
      assert.equal(out.catalogTracked, undefined, 'the cart handed out is the bare one');
    });
  }

  test('the retry carries today\'s attribution; the referral is minted once, by the retry', async () => {
    let mints = 0;
    const minted = { kind: 'minted', clickId: 'clk_minted_1', pairs: [['utm_source', 'pivota'], ['pvt_click_id', 'clk_minted_1']], attributed: true };
    const door = fakeDoor({ create: (args) => (String(args.lineItems[0].item.id).includes('?') ? { ok: false, status: 500, error: { message: 'x' } } : sellerCart()) });
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: door, catalogLink: 'https://store.example/products/serum', mintReferral: async () => { mints += 1; return minted; },
      catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE, [CART_REFERRAL_FLAG]: '1', [CART_ATTRIBUTION_FLAG]: '1' },
    }));
    assert.equal(mints, 1);
    const creates = door.calls.filter((c) => c[0] === 'create_cart');
    assert.equal('cartAttribution' in creates[0][2], false, 'the tracked attempt sent none of ours');
    assert.deepEqual(creates[1][2].cartAttribution, { utm_source: 'pivota', pvt_click_id: 'clk_minted_1' });
    assert.match(out.continueUrl, /pvt_click_id=clk_minted_1/);
    assert.deepEqual(out.referral.pairs, minted.pairs);
  });

  test('not enough budget left: no retry, and the fallback is marked', { timeout: 10000 }, async () => {
    const door = fakeDoor({ create: (args) => new Promise((r) => setTimeout(() => r(String(args.lineItems[0].item.id).includes('?') ? { ok: false, status: 500, error: { message: 'x' } } : sellerCart()), 3900)) });
    const log = recordingLog();
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, log, budgetMs: 4300, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } }));
    assert.equal(out, null);
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
    const line = log.lines.find((l) => l.outcome === 'sent_fallback');
    assert.equal(line.retried, false);
    assert.ok(BARE_RETRY_MIN_MS >= 500);
  });

  test('a priced tracked send is logged sent_priced; an out-of-stock refusal is logged and rethrown', async () => {
    const log = recordingLog();
    await priceOnMerchantDoor(doorArgs({ merchantDoor: fakeDoor(), log, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } }));
    assert.deepEqual(outcomesOf(log), ['sent_priced']);
    const log2 = recordingLog();
    const soldOut = fakeDoor({ create: () => ({ ok: true, status: 200, error: { message: 'Out of stock' } }) });
    await assert.rejects(priceOnMerchantDoor(doorArgs({ merchantDoor: soldOut, log: log2, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } })));
    assert.deepEqual(outcomesOf(log2), ['sent_threw']);
  });

  test('an early fallback logs the lookup as unused', async () => {
    const log = recordingLog();
    const noDoor = { ...fakeDoor(), async endpointFor() { return null; } };
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: noDoor, log, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } }));
    assert.equal(out, null);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(outcomesOf(log), ['unused']);
  });

  test('shadow never retries anything', async () => {
    const door = fakeDoor({ create: () => ({ ok: false, status: 500, error: { message: 'x' } }) });
    await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: clientWith(fakeShopify()), env: { [CATALOG_ATTRIBUTION_FLAG]: 'shadow' } }));
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
  });

  test('enforce without a pilot list runs as shadow: nothing tracked is sent', async () => {
    const door = fakeDoor();
    await priceOnMerchantDoor(doorArgs({ merchantDoor: door, catalogAttribution: clientWith(fakeShopify()), env: { [CATALOG_ATTRIBUTION_FLAG]: 'enforce' } }));
    assert.deepEqual(door.calls[1][2].lineItems, [{ item: { id: GID(V1) }, quantity: 2 }]);
  });
});

describe('follow-up: the breaker and the token', () => {
  test('after consecutive failures, lookups are skipped for a while; an answer closes it again', async () => {
    let clock = 1_000_000_000_000;
    let status = 500;
    const base = fakeShopify();
    const fetchImpl = async (url, init) => {
      const r = await base.fetchImpl(url, init);
      return url === CATALOG_ENDPOINT ? { status, json: r.json } : r;
    };
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl, now: () => clock });
    const look = () => c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    for (let i = 0; i < BREAKER_FAILURES; i += 1) assert.equal((await look()).reason, 'failed:http');
    const lookups = () => base.calls.filter((x) => x.url === CATALOG_ENDPOINT).length;
    const before = lookups();
    assert.equal((await look()).reason, 'skipped:breaker');
    assert.equal(lookups(), before, 'no call while open');
    clock += 61 * 1000;
    status = 200;
    assert.equal((await look()).reason, null);
    assert.equal((await look()).reason, null);
    // An answer resets the count: failures that are not consecutive never open it.
    for (const next of [500, 500, 200, 500, 500, 200]) {
      status = next;
      assert.notEqual((await look()).reason, 'skipped:breaker', `after ${next}`);
    }
  });

  test('a token from a non-200 exchange is never used (mutant M30)', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (url === TOKEN_ENDPOINT) return { status: 400, json: async () => ({ access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600) }) };
      return { status: 200, json: async () => ({}) };
    };
    const out = await createCatalogAttribution({ env: CONFIG, fetchImpl }).lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' });
    assert.equal(out.reason, 'failed:no_token');
    assert.equal(calls.includes(CATALOG_ENDPOINT), false);
  });

  test('a catalogue-only id with the catalog bit still decodes, and is not marked (mutant M13)', () => {
    const id = encodeEscalationId([{ product_id: 'sig_a', quantity: 1 }], undefined, undefined, { code: 'US' }, undefined, undefined, undefined, true);
    assert.ok(decodeEscalationId(id));
    assert.equal(escalationCatalogTrackedOf(id), false);
  });
});

// ---- review round 2 of the follow-up (48dec607a): one block per finding or surviving mutant ---------------------

import { SELLER_DISCOUNT_CODES_FLAG } from '../src/ucpMerchantDoorPricing.js';

describe('round 2: the door', () => {
  const clientWith = (shopify) => createCatalogAttribution({ env: CONFIG, fetchImpl: shopify.fetchImpl });
  const tracked500 = (args) => (String(args.lineItems[0].item.id).includes('?') ? { ok: false, status: 500, error: { message: 'x' } } : sellerCart());
  const lines = (log) => log.lines.filter((l) => l.event === 'ucp_shopify_catalog_attribution');

  test('SHADOW with a lookup slower than the cart logs it exactly once (P2-1)', async () => {
    const log = recordingLog();
    const slow = { lookupTracked: () => new Promise((r) => setTimeout(() => r({ tracked: new Map([[GID(V1), TRACKED(V1)]]), reason: null }), 30)) };
    await priceOnMerchantDoor(doorArgs({ merchantDoor: fakeDoor(), log, catalogAttribution: slow, env: { [CATALOG_ATTRIBUTION_FLAG]: 'shadow' } }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(lines(log).length, 1);
    assert.equal(lines(log)[0].outcome, undefined);
  });

  test('a store answering in another currency is not retried bare (P2-2)', async () => {
    const cad = () => {
      const r = sellerCart();
      const body = JSON.parse(r.response.result.content[0].text);
      body.currency = 'CAD';
      r.response.result.content[0].text = JSON.stringify(body);
      return r;
    };
    const door = fakeDoor({ create: cad });
    const storeAnswer = {};
    const log = recordingLog();
    let recalls = 0;
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: door, log, marketCurrency: 'USD', storeAnswer, recallStoreCurrency: () => { recalls += 1; return null; },
      catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE },
    }));
    assert.equal(out, null);
    assert.equal(storeAnswer.currency, 'CAD');
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
    assert.equal(recalls, 1);
    assert.equal(lines(log).find((l) => l.outcome === 'sent_fallback').why, 'not_retryable');
  });

  test('the retry runs inside what is LEFT of the budget, not a fresh one (M1)', { timeout: 15000 }, async () => {
    const door = fakeDoor({ create: (args) => new Promise((r) => setTimeout(() => r(tracked500(args)),
      String(args.lineItems[0].item.id).includes('?') ? 4000 : 1500)) });
    const log = recordingLog();
    const out = await priceOnMerchantDoor(doorArgs({ merchantDoor: door, log, budgetMs: 5000, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } }));
    assert.equal(out, null, 'a 1.5 s bare cart does not fit in the ~1 s left');
    const line = lines(log).find((l) => l.outcome === 'sent_fallback');
    assert.deepEqual([line.retried, line.retry], [true, 'fallback']);
  });

  test('a retry that throws is logged as such and rethrown (M4)', async () => {
    const door = fakeDoor({ create: (args) => (String(args.lineItems[0].item.id).includes('?')
      ? { ok: false, status: 500, error: { message: 'x' } } : { ok: true, status: 200, error: { message: 'Out of stock' } }) });
    const log = recordingLog();
    await assert.rejects(priceOnMerchantDoor(doorArgs({ merchantDoor: door, log, catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE } })));
    const line = lines(log).find((l) => l.outcome === 'sent_fallback');
    assert.equal(line.retry, 'threw');
  });

  test('the retry sends the buyer\'s discount code again (M6)', async () => {
    const door = {
      ...fakeDoor({ create: tracked500 }),
      async endpointFor() { return { mcpEndpoint: ENDPOINT, acceptsDiscountCodes: true }; },
    };
    door.calls = [];
    const inner = fakeDoor({ create: tracked500 });
    door.createCart = inner.createCart;
    await priceOnMerchantDoor(doorArgs({ merchantDoor: door, discountCode: 'SAVE10', catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE, [SELLER_DISCOUNT_CODES_FLAG]: '1' } }));
    const creates = inner.calls.filter((c) => c[0] === 'create_cart');
    assert.equal(creates.length, 2);
    assert.deepEqual(creates.map((c) => c[2].discountCodes), [['SAVE10'], ['SAVE10']]);
  });
});

describe('round 2: the breaker', () => {
  function rig({ catalogStatus = 500, tokenStatus = 200 } = {}) {
    let clock = 1_000_000_000_000;
    const state = { catalogStatus, tokenStatus };
    const base = fakeShopify();
    const fetchImpl = async (url, init) => {
      if (url === TOKEN_ENDPOINT && state.tokenStatus !== 200) return { status: state.tokenStatus, json: async () => ({}) };
      const r = await base.fetchImpl(url, init);
      return url === CATALOG_ENDPOINT ? { status: state.catalogStatus, json: r.json } : r;
    };
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl, now: () => clock });
    return { state, base, advance: (ms) => { clock += ms; }, look: (gids = [GID(V1)], budgetMs) => c.lookupTracked(gids, { market: 'US', sellerHost: 'store.example', ...(budgetMs ? { budgetMs } : {}) }) };
  }

  test('half-open: after the window one failure reopens it (P3-1)', async () => {
    const r = rig();
    for (let i = 0; i < BREAKER_FAILURES; i += 1) await r.look();
    assert.equal((await r.look()).reason, 'skipped:breaker');
    r.advance(30 * 1000);
    assert.equal((await r.look()).reason, 'skipped:breaker', 'still open 30 s in (M5)');
    r.advance(31 * 1000);
    assert.equal((await r.look()).reason, 'failed:http');
    assert.equal((await r.look()).reason, 'skipped:breaker');
  });

  test('a failed token exchange counts toward it (M2)', async () => {
    const r = rig({ tokenStatus: 500 });
    for (let i = 0; i < BREAKER_FAILURES; i += 1) assert.equal((await r.look()).reason, 'failed:no_token');
    assert.equal((await r.look()).reason, 'skipped:breaker');
  });

  test('a batch that partly answered does not count (M7)', async () => {
    const r = rig({ catalogStatus: 200 });
    let n = 0;
    r.state.catalogStatus = 200;
    const gids = Array.from({ length: 12 }, (_, i) => GID(String(44012345670000 + i)));
    const fetchCounter = r.base.fetchImpl;
    void fetchCounter; void n;
    // first batch answers, second fails: a partial answer
    const partial = rig();
    let calls = 0;
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: async (url, init) => {
      const res = await partial.base.fetchImpl(url, init);
      if (url !== CATALOG_ENDPOINT) return res;
      calls += 1;
      return calls % 2 === 1 ? res : { status: 500, json: async () => ({}) };
    } });
    for (let i = 0; i < BREAKER_FAILURES + 1; i += 1) {
      const out = await c.lookupTracked(gids, { market: 'US', sellerHost: 'store.example' });
      assert.notEqual(out.reason, 'skipped:breaker', `call ${i}`);
    }
  });

  test('a timeout on a caller\'s short budget does not count', async () => {
    const slow = fakeShopify({ delayMs: 200 });
    const c = createCatalogAttribution({ env: CONFIG, fetchImpl: slow.fetchImpl });
    await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example' }); // warm the token (200 ms is inside 800)
    for (let i = 0; i < BREAKER_FAILURES + 1; i += 1) {
      const out = await c.lookupTracked([GID(V1)], { market: 'US', sellerHost: 'store.example', budgetMs: 50 });
      assert.equal(out.reason, 'failed:timeout', `call ${i}`);
    }
  });
});

describe('round 2: the retry and the currency memo', () => {
  test('a retried cart reads the caller\'s currency memo once, not twice', async () => {
    const clientWith = (shopify) => createCatalogAttribution({ env: CONFIG, fetchImpl: shopify.fetchImpl });
    let recalls = 0;
    const door = fakeDoor({ create: (args) => (String(args.lineItems[0].item.id).includes('?') ? { ok: false, status: 500, error: { message: 'x' } } : sellerCart()) });
    const out = await priceOnMerchantDoor(doorArgs({
      merchantDoor: door, marketCurrency: 'USD', storeAnswer: {}, recallStoreCurrency: () => { recalls += 1; return null; },
      catalogAttribution: clientWith(fakeShopify()), env: { ...ENFORCE },
    }));
    assert.ok(out, 'the bare retry priced');
    assert.equal(recalls, 1);
  });
});

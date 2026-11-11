// THE REFERRAL FOR A STORE CART THE DOOR BUILDS (AGENT_CHECKOUT_UCP_CART_REFERRAL_ENABLED), on the lane itself and on
// the backend client. The doors end to end: tests/store_cart_referral_door.node.test.cjs.
//
// Pinned here:
//   - the switch: off, the minter is never called, whatever is injected;
//   - when: a create only, only for a catalog link with no tracking member, only once a cart is about to be sent;
//   - the budget: at most one second and never time the cart call needs; too little left is a miss;
//   - the miss policy (a named constant): the cart is built anyway, unattributed, counted and logged with its reason;
//   - what is carried: exactly tracking members, all or nothing, on the link and (its own switch) as cart.attribution;
//   - the id: the members ride as `t` on a seller-priced id; a malformed `t` is ignored, never a refused id;
//   - the hand-off record names the minted click;
//   - the client: the recorded backend answers, the partner assertion over the bytes sent, no id in any log line.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  MERCHANT_PRICING_FLAG, CART_ATTRIBUTION_FLAG, CART_REFERRAL_FLAG, REFERRAL_MINT_BUDGET_MS, REFERRAL_MISS_POLICY,
  REFERRAL_MISS_POLICIES, MERCHANT_PRICING_BUDGET_MS, cartReferralEnabled, cartReferralOutcomeCounts,
  resetCartReferralOutcomeCountsForTest, trackingPairsFrom, priceOnMerchantDoor,
} from '../src/ucpMerchantDoorPricing.js';
import {
  UCP_ESCALATION_FLAG, tryEscalateUcpCheckout, encodeEscalationId, decodeEscalationId, escalationCartIdOf,
  escalationTrackingOf, escalationRecordIdOf,
} from '../src/ucpCheckoutEscalation.js';
import referralModule from '../../src/services/storefrontCartReferral.js';
import assertionModule from '../../src/attribution/issuingAgentAssertion.js';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../tests/fixtures/backend_storefront_cart_referral.backend.json', import.meta.url), 'utf8'));
const FORWARDING = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const RECORD = 'UCP_STOREFRONT_HANDOFF_RECORD_ENABLED';
const PRICED = { [UCP_ESCALATION_FLAG]: '1', [MERCHANT_PRICING_FLAG]: '1' };
const ON = { ...PRICED, [CART_REFERRAL_FLAG]: '1' };
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const ENDPOINT = 'https://shop-a.example.com/api/ucp/mcp';
const CART_URL = 'https://shop-a.example.com/cart/c/abc123?key=k';
const CLICK = 'clk_0000000000000000000000c1';
const PAIRS = Object.freeze([['utm_source', 'pivota'], ['utm_medium', 'create_checkout'], ['utm_campaign', 'US'], ['pvt_click_id', CLICK], ['utm_content', CLICK]]);
const TAIL = PAIRS.map(([k, v]) => `${k}=${v}`).join('&');
const PLAIN_LINK = 'https://shop-a.example.com/products/serum-x?variant=1';
const STAMPED_LINK = `https://shop-a.example.com/products/serum-x?variant=1&utm_source=pivota&pvt_click_id=clk_stamped`;

const SEED = Object.freeze({
  product_id: 'sig_referral_a', merchant_id: 'merch_obs_shop_a', title: 'Serum X', price: 25, currency: 'USD',
  external_redirect_url: PLAIN_LINK, price_as_of: '2026-11-01T10:00:00Z',
  variants: [{ variant_id: 'sig_referral_a', source_variant_id: '44012345678901' }],
});

function executorWith(rowsById) {
  return {
    async execute(op, params) {
      if (op === 'get_product') {
        const row = rowsById[params.payload.product.product_id];
        return row ? { product: structuredClone(row) } : { product: null };
      }
      return { session_id: 'q_kernel' };
    },
  };
}

function sellerCart({ continueUrl = CART_URL } = {}) {
  const payload = {
    id: 'gid://shopify/Cart/c1', currency: 'USD', continue_url: continueUrl,
    line_items: [{ id: 'line_0', item: { id: GID('44012345678901'), title: 'Seller title', price: 2400 }, quantity: 2, totals: [{ type: 'subtotal', amount: 4800 }, { type: 'total', amount: 4800 }] }],
    totals: [{ type: 'subtotal', amount: 4800 }, { type: 'total', amount: 4800 }],
  };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

function fakeDoor({ cart = sellerCart, endpoint = ENDPOINT, discoverDelayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async endpointFor(host) {
      calls.push(['discover', host]);
      if (discoverDelayMs) await new Promise((r) => setTimeout(r, discoverDelayMs));
      return endpoint;
    },
    async createCart(ep, args) { calls.push(['create_cart', ep, structuredClone(args)]); return cart(); },
    async getCart(ep, cartId) { calls.push(['get_cart', ep, cartId]); return cart(); },
  };
}

/** A minter that answers as the client does. `answer`: what `mint` resolves, or a function. */
function minter(answer = { kind: 'minted', clickId: CLICK, pairs: PAIRS.map((p) => [...p]), attributed: true }) {
  const calls = [];
  return {
    calls,
    async mint(fields) {
      calls.push(structuredClone(fields));
      return typeof answer === 'function' ? answer(fields) : answer;
    },
  };
}

function logs() {
  const lines = [];
  const at = (level) => (fields) => lines.push({ level, ...fields });
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
}

const CREATE = { id: 'create_checkout_session', capability: 'checkout' };
const GET = { id: 'get_checkout_session', capability: 'checkout' };
const US = { checkout: { context: { address_country: 'US' } } };
const escBody = (id) => JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8'));
const escOf = (body) => `esc_${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}`;

function create({ env = ON, row = SEED, merchantDoor = fakeDoor(), referralMinter, handoffRecorder, log, ucpArgs = US } = {}) {
  return tryEscalateUcpCheckout({
    op: CREATE, params: { idempotency_key: 'idem-0001', quote: { items: [{ product_id: row.product_id, quantity: 2 }] } }, ctx: {},
    executor: executorWith({ [row.product_id]: row }), ucpArgs, env, now: NOW, merchantDoor, referralMinter, handoffRecorder, log,
  });
}
function reread(id, { env = ON, row = SEED, merchantDoor = fakeDoor(), referralMinter } = {}) {
  return tryEscalateUcpCheckout({
    op: GET, params: { session_id: id }, ctx: {}, executor: executorWith({ [row.product_id]: row }), ucpArgs: {}, env, now: NOW, merchantDoor, referralMinter,
  });
}

beforeEach(() => resetCartReferralOutcomeCountsForTest());

// ---- the switch -----------------------------------------------------------------------------------------------

describe('the switch', () => {
  test('values', () => {
    for (const v of ['1', 'true', 'on', 'YES', ' On ']) assert.equal(cartReferralEnabled({ [CART_REFERRAL_FLAG]: v }), true, v);
    for (const v of ['', '0', 'off', 'no', 'enabled', '2', undefined]) assert.equal(cartReferralEnabled({ [CART_REFERRAL_FLAG]: v }), false, String(v));
    assert.equal(CART_REFERRAL_FLAG, 'AGENT_CHECKOUT_UCP_CART_REFERRAL_ENABLED');
  });

  test('off: the minter is never called and the answer is the one given without a minter', async () => {
    const m = minter();
    const withMinter = await create({ env: PRICED, referralMinter: m });
    const without = await create({ env: PRICED });
    assert.deepEqual(m.calls, []);
    assert.deepEqual(withMinter, without);
    assert.equal(withMinter.continue_url, CART_URL);
    assert.deepEqual(Object.keys(escBody(withMinter.id)), ['v', 'i', 'c', 'h', 'm']);
    assert.deepEqual(cartReferralOutcomeCounts(), {});
  });
});

// ---- when a referral is minted ----------------------------------------------------------------------------------

describe('when', () => {
  test('a create for a link with no tracking member: one mint, after discovery, before create_cart', async () => {
    const order = [];
    const door = fakeDoor();
    const realCreate = door.createCart;
    door.createCart = async (...a) => { order.push('create_cart'); return realCreate(...a); };
    const realDiscover = door.endpointFor;
    door.endpointFor = async (...a) => { order.push('discover'); return realDiscover(...a); };
    const m = minter((fields) => { order.push('mint'); return { kind: 'minted', clickId: CLICK, pairs: PAIRS.map((p) => [...p]) }; });
    const out = await create({ merchantDoor: door, referralMinter: m });
    assert.deepEqual(order, ['discover', 'mint', 'create_cart']);
    assert.deepEqual(m.calls, [{ seller_host: 'shop-a.example.com', market: 'US', merchant_id: 'merch_obs_shop_a' }]);
    assert.equal(out.continue_url, `${CART_URL}&${TAIL}`);
    assert.deepEqual(Object.entries(escBody(out.id).t), PAIRS.map((p) => [...p]));
    assert.deepEqual(cartReferralOutcomeCounts(), { minted: 1 });
  });

  test('a link that already carries a tracking member: nothing is minted', async () => {
    const m = minter();
    const out = await create({ row: { ...SEED, external_redirect_url: STAMPED_LINK }, referralMinter: m });
    assert.deepEqual(m.calls, []);
    assert.equal(out.continue_url, `${CART_URL}&utm_source=pivota&pvt_click_id=clk_stamped`);
    assert.equal(escBody(out.id).t, undefined);
  });

  test('no cart is sent, no referral: an unresolved variant, no seller door', async () => {
    const m = minter();
    const noVariant = { ...SEED, variants: [{ variant_id: 'a' }, { variant_id: 'b' }], external_redirect_url: 'https://shop-a.example.com/products/serum-x' };
    await create({ row: noVariant, referralMinter: m });
    await create({ merchantDoor: fakeDoor({ endpoint: null }), referralMinter: m });
    assert.deepEqual(m.calls, []);
    assert.deepEqual(cartReferralOutcomeCounts(), {});
  });

  test('nothing of the buyer is sent: a checkout with a body email and an attested buyer asks with the same three fields', async () => {
    const m = minter();
    const out = await tryEscalateUcpCheckout({
      op: CREATE, ctx: { user_ref: 'buyer-0001' }, attested: { attested_email: 'attested@example.com' },
      params: { idempotency_key: 'idem-0001', quote: { customer_email: 'buyer@example.com', items: [{ product_id: SEED.product_id, quantity: 2 }] } },
      executor: executorWith({ [SEED.product_id]: SEED }), ucpArgs: US, env: ON, now: NOW, merchantDoor: fakeDoor(), referralMinter: m,
    });
    assert.equal(out.buyer.email, 'attested@example.com', 'the checkout itself knows the buyer');
    assert.deepEqual(m.calls, [{ seller_host: 'shop-a.example.com', market: 'US', merchant_id: 'merch_obs_shop_a' }]);
  });

  test('the market sent is the one the cart is built for: named, or the assumed one', async () => {
    const m = minter();
    const door = fakeDoor();
    await create({ referralMinter: m, ucpArgs: {}, merchantDoor: door });
    await create({ referralMinter: m, ucpArgs: { checkout: { context: { address_country: 'GB' } } }, merchantDoor: door });
    assert.deepEqual(m.calls.map((c) => c.market), ['US', 'GB']);
    assert.deepEqual(door.calls.filter((c) => c[0] === 'create_cart').map((c) => c[2].context.address_country), ['US', 'GB']);
  });

  test('a re-read mints nothing and carries the id\'s members; a create on the id is never repeated', async () => {
    const m = minter();
    const made = await create({ referralMinter: m });
    const door = fakeDoor({ cart: () => sellerCart() });
    const again = await reread(made.id, { merchantDoor: door, referralMinter: m });
    assert.equal(m.calls.length, 1);
    assert.equal(again.continue_url, made.continue_url);
    assert.deepEqual(door.calls.map((c) => c[0]), ['discover', 'get_cart']);
    // The switch off: the id's members are not read.
    const off = await reread(made.id, { env: PRICED });
    assert.equal(off.continue_url, CART_URL);
  });

  test('a member the seller already set on its cart link is never overwritten', async () => {
    const door = fakeDoor({ cart: () => sellerCart({ continueUrl: `${CART_URL}&utm_source=seller` }) });
    const out = await create({ merchantDoor: door, referralMinter: minter() });
    assert.equal(out.continue_url, `${CART_URL}&utm_source=seller&${PAIRS.slice(1).map(([k, v]) => `${k}=${v}`).join('&')}`);
  });
});

// ---- the cart attribute -------------------------------------------------------------------------------------------

describe('cart.attribution', () => {
  test('with its own switch on, the minted members ride on create_cart; off, they do not', async () => {
    const on = fakeDoor();
    await create({ env: { ...ON, [CART_ATTRIBUTION_FLAG]: '1' }, merchantDoor: on, referralMinter: minter() });
    assert.deepEqual(Object.entries(on.calls.find((c) => c[0] === 'create_cart')[2].cartAttribution), PAIRS.map((p) => [...p]));
    const off = fakeDoor();
    await create({ merchantDoor: off, referralMinter: minter() });
    assert.equal('cartAttribution' in off.calls.find((c) => c[0] === 'create_cart')[2], false);
  });

  test('a miss sends no attribute', async () => {
    const door = fakeDoor();
    await create({ env: { ...ON, [CART_ATTRIBUTION_FLAG]: '1' }, merchantDoor: door, referralMinter: minter({ kind: 'unavailable', code: 'timeout' }) });
    assert.equal('cartAttribution' in door.calls.find((c) => c[0] === 'create_cart')[2], false);
  });
});

// ---- the miss policy ----------------------------------------------------------------------------------------------

describe('a miss', () => {
  test('the policy is a named constant: build the cart, unattributed', () => {
    assert.equal(REFERRAL_MISS_POLICY, REFERRAL_MISS_POLICIES.buildCartUnattributed);
    assert.equal(REFERRAL_MISS_POLICY, 'build_cart_unattributed');
    assert.deepEqual(Object.values(REFERRAL_MISS_POLICIES).sort(), ['build_cart_unattributed', 'fallback_to_product_page']);
  });

  const cases = [
    ['no minter is wired', undefined, 'no_minter'],
    ['the backend is unavailable', minter({ kind: 'unavailable', code: 'transport' }), 'transport'],
    ['the backend refuses', minter({ kind: 'refused', code: 'service_caller_required' }), 'service_caller_required'],
    ['the minter throws', { mint() { throw new Error('boom'); } }, 'minter_threw'],
    ['the minter rejects', { async mint() { throw new Error('boom'); } }, 'minter_threw'],
    ['the minter answers nothing', minter(null), 'no_answer'],
    ['an answer with a member that is not a tracking member', minter({ kind: 'minted', clickId: CLICK, pairs: [...PAIRS.map((p) => [...p]), ['note', 'x']] }), 'malformed_answer'],
    ['an answer whose value is a URL', minter({ kind: 'minted', clickId: CLICK, pairs: [['utm_source', 'https://elsewhere.example/'], ['pvt_click_id', CLICK]] }), 'malformed_answer'],
    ['an answer whose click id is not the one its members carry', minter({ kind: 'minted', clickId: 'clk_other', pairs: PAIRS.map((p) => [...p]) }), 'malformed_answer'],
    ['an answer with no click id member', minter({ kind: 'minted', clickId: CLICK, pairs: [['utm_source', 'pivota']] }), 'malformed_answer'],
    ['a code that is not a code', minter({ kind: 'refused', code: 'Not Found <b>' }), 'no_answer'],
  ];
  for (const [name, m, reason] of cases) {
    test(`${name}: the seller-priced cart is still answered, with no tracking member, counted as ${reason}`, async () => {
      const log = logs();
      const door = fakeDoor();
      const out = await create({ merchantDoor: door, referralMinter: m, log });
      assert.equal(out.status, 'requires_escalation');
      assert.ok(out.messages.some((x) => x.code === 'checkout.priced_by_seller_storefront'));
      assert.equal(out.continue_url, CART_URL);
      assert.equal(escBody(out.id).t, undefined);
      assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
      assert.deepEqual(cartReferralOutcomeCounts(), { [`miss:${reason}`]: 1 });
      const line = log.lines.find((l) => l.event === 'ucp_storefront_cart_referral');
      assert.deepEqual(line, { level: 'warn', event: 'ucp_storefront_cart_referral', outcome: 'miss', reason, policy: 'build_cart_unattributed', seller_host: 'shop-a.example.com' });
    });
  }
});

// ---- the budget ---------------------------------------------------------------------------------------------------

describe('the budget', () => {
  const base = () => ({
    items: [{ product_id: SEED.product_id, quantity: 2 }], rows: new Map([[SEED.product_id, structuredClone(SEED)]]),
    sellerHost: 'shop-a.example.com', catalogLink: PLAIN_LINK, market: 'US', env: ON,
  });

  test('one second, a fifth of the door\'s budget, leaving the cart call its whole share', () => {
    assert.equal(REFERRAL_MINT_BUDGET_MS, 1000);
    assert.equal(MERCHANT_PRICING_BUDGET_MS, 5000);
    assert.equal(referralModule.DEFAULT_TIMEOUT_MS, 1000);
  });

  test('a mint slower than its budget is a miss at the budget, and the cart is built', async () => {
    const door = fakeDoor();
    // A 500 ms door: the cart call's share is 350, so the mint has under 150.
    const slow = { mint: () => new Promise((resolve) => setTimeout(() => resolve({ kind: 'minted', clickId: CLICK, pairs: PAIRS.map((p) => [...p]) }), 400)) };
    const started = Date.now();
    const out = await priceOnMerchantDoor({ ...base(), merchantDoor: door, budgetMs: 500, mintReferral: () => slow.mint() });
    const took = Date.now() - started;
    assert.ok(out, 'priced');
    assert.equal(out.continueUrl, CART_URL);
    assert.equal(out.referral, undefined);
    assert.ok(took < 350, `gave up at the budget (${took} ms)`);
    assert.deepEqual(cartReferralOutcomeCounts(), { 'miss:timeout': 1 });
  });

  test('too little left above the cart call\'s share: not asked at all', async () => {
    const m = minter();
    // Discovery eats the head-room: 200 ms door, share 140, discovery takes 40, so under 50 ms is left for the mint.
    const out = await priceOnMerchantDoor({ ...base(), merchantDoor: fakeDoor({ discoverDelayMs: 40 }), budgetMs: 200, mintReferral: () => m.mint({}) });
    assert.ok(out, 'priced');
    assert.deepEqual(m.calls, []);
    assert.deepEqual(cartReferralOutcomeCounts(), { 'miss:no_budget': 1 });
  });
});

// ---- the id -------------------------------------------------------------------------------------------------------

describe('the id', () => {
  const ITEMS = [{ product_id: 'sig_referral_a', quantity: 2 }];
  test('`t` rides on a seller-priced id only, after every other member, and only when it is tracking members', () => {
    const id = encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' }, 'esh_' + 'r'.repeat(22), PAIRS);
    assert.deepEqual(Object.keys(escBody(id)), ['v', 'i', 'c', 'h', 'm', 'r', 't']);
    assert.deepEqual(escalationTrackingOf(id), PAIRS.map((p) => [...p]));
    assert.equal(escalationCartIdOf(id), 'cart_1');
    assert.equal(escalationRecordIdOf(id), 'esh_' + 'r'.repeat(22));
    assert.deepEqual(decodeEscalationId(id), ITEMS);
    // No members, or not tracking members: the id it always was.
    const plain = encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' });
    for (const tracking of [undefined, null, [], [['note', 'x']], [['utm_source', 'a b']], 'utm_source=pivota']) {
      assert.equal(encodeEscalationId(ITEMS, 'cart_1', 'shop-a.example.com', { code: 'US' }, undefined, tracking), plain);
    }
    // Never on a catalogue (v1) id.
    assert.equal(encodeEscalationId(ITEMS, undefined, undefined, { code: 'US' }, undefined, PAIRS), encodeEscalationId(ITEMS, undefined, undefined, { code: 'US' }));
  });

  test('a `t` nobody could have minted is ignored: the id reads as it did before the member existed', () => {
    const body = { v: 2, i: [['sig_referral_a', 2]], c: 'cart_1', h: 'shop-a.example.com', m: 'US' };
    for (const t of [{ note: 'x' }, { utm_source: 'https://elsewhere.example/' }, 'x', 7, [], {}, { utm_source: 1 }, Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`utm_k${i}`, 'v']))]) {
      const id = escOf({ ...body, t });
      assert.deepEqual(decodeEscalationId(id), ITEMS, JSON.stringify(t));
      assert.equal(escalationCartIdOf(id), 'cart_1');
      assert.equal(escalationTrackingOf(id), undefined, JSON.stringify(t));
    }
    assert.equal(escalationTrackingOf(escOf({ v: 1, i: [['sig_referral_a', 2]], t: { utm_source: 'pivota' } })), undefined);
  });

  test('trackingPairsFrom: exactly tracking members', () => {
    assert.deepEqual(trackingPairsFrom({ utm_source: 'pivota', pvt_click_id: CLICK }), [['utm_source', 'pivota'], ['pvt_click_id', CLICK]]);
    assert.deepEqual(trackingPairsFrom(PAIRS), PAIRS.map((p) => [...p]));
    for (const bad of [null, undefined, {}, [], 'x', { utm_source: '' }, { utm_source: 'a&b=c' }, { 'utm_source ': 'x' }, { email: 'buyer@example.com' }, [['utm_source', 'a'], ['utm_source', 'b']], [['utm_source']]]) {
      assert.equal(trackingPairsFrom(bad), null, JSON.stringify(bad));
    }
  });
});

// ---- with the hand-off record -------------------------------------------------------------------------------------

describe('the hand-off record', () => {
  test('names the minted click, and its binding is the id that carries the members', async () => {
    const records = [];
    const recorder = { async record(fields) { records.push(structuredClone(fields)); return { kind: 'recorded' }; } };
    const out = await create({ env: { ...ON, [RECORD]: '1', [FORWARDING]: '1' }, referralMinter: minter(), handoffRecorder: recorder });
    assert.equal(records.length, 1);
    assert.equal(records[0].referral_click_id, CLICK);
    assert.equal(records[0].binding, crypto.createHash('sha256').update(out.id).digest('hex'));
    assert.deepEqual(Object.keys(escBody(out.id)), ['v', 'i', 'c', 'h', 'm', 'r', 't']);
  });

  test('a miss records no click', async () => {
    const records = [];
    const recorder = { async record(fields) { records.push(structuredClone(fields)); return { kind: 'recorded' }; } };
    await create({ env: { ...ON, [RECORD]: '1', [FORWARDING]: '1' }, referralMinter: minter({ kind: 'unavailable', code: 'timeout' }), handoffRecorder: recorder });
    assert.equal('referral_click_id' in records[0], false);
  });
});

// ---- logs -----------------------------------------------------------------------------------------------------------

test('no log line at any level carries the click id', async () => {
  const log = logs();
  await create({ referralMinter: minter(), log });
  assert.ok(log.lines.some((l) => l.event === 'ucp_storefront_cart_referral' && l.outcome === 'minted' && l.level === 'info'));
  assert.equal(JSON.stringify(log.lines).includes(CLICK), false);
});

// ---- the backend client ---------------------------------------------------------------------------------------------

describe('the backend client', () => {
  const BASE = 'http://backend.referral.test';
  const SECRET = 'referral_unit_secret';
  function clientWith(recorded, { signed = true, logger, timeoutMs, authHeaders } = {}) {
    const sent = [];
    const client = referralModule.createStorefrontCartReferralClient({
      baseUrl: `${BASE}/`,
      authHeaders: authHeaders || (() => ({ 'X-API-Key': 'gateway-service-key' })),
      signRequest: ({ op, method, url, rid, rawBody }) => (signed
        ? assertionModule.boundIssuingAgentAssertionHeaders({
          op, method, url, rid, rawBody, invokeContext: { auth_mode: 'api_key', agent_id: 'agent_partner_a' },
          env: { [FORWARDING]: '1', [CART_REFERRAL_FLAG]: '1', ISSUING_AGENT_ASSERTION_SECRET: SECRET },
        })
        : {}),
      fetchImpl: async (url, init) => {
        sent.push({ url, init });
        if (typeof recorded === 'function') return recorded(url, init);
        return { status: recorded.status, text: async () => JSON.stringify(recorded.body) };
      },
      logger,
      timeoutMs,
    });
    return { client, sent };
  }

  test('minted: the recorded answer of the real handler, for a partner and for none', async () => {
    for (const [name, signed] of [['minted_for_partner', true], ['minted_no_partner', false], ['minted_no_market', false], ['minted_market_sg', false]]) {
      const { client, sent } = clientWith(FIXTURE[name], { signed });
      const out = await client.mint(FIXTURE[name].request);
      assert.equal(out.kind, 'minted', name);
      assert.equal(out.clickId, FIXTURE[name].body.click_id);
      assert.deepEqual(out.pairs, Object.entries(FIXTURE[name].body.attribution));
      assert.equal(out.attributed, signed);
      // Exactly the recorded request, in the recorded member order (the bytes a partner assertion is hashed over).
      assert.equal(sent[0].url, `${BASE}/agent/v2/storefront-cart-referrals`);
      assert.equal(sent[0].init.body, JSON.stringify(FIXTURE[name].request));
      assert.equal(sent[0].init.method, 'POST');
      assert.equal(sent[0].init.redirect, 'error');
      assert.equal(sent[0].init.headers['X-API-Key'], 'gateway-service-key');
      assert.equal(Boolean(sent[0].init.headers['X-Pivota-Issuing-Agent']), signed);
    }
  });

  test('the assertion is the request-bound token for this op, over the bytes sent, with no resource id', async () => {
    const { client, sent } = clientWith(FIXTURE.minted_for_partner);
    await client.mint({ seller_host: 'shop-a.example.com', market: 'US', merchant_id: 'merch_obs_shop_a' });
    const [version, encoded, mac] = sent[0].init.headers['X-Pivota-Issuing-Agent'].split('.');
    assert.equal(version, 'v2');
    assert.equal(mac, crypto.createHmac('sha256', SECRET).update(`${version}.${encoded}`).digest('base64url'));
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    assert.equal(payload.op, 'ucp_storefront_cart.referral');
    assert.equal(payload.sub, 'agent_partner_a');
    assert.equal(payload.p, '/agent/v2/storefront-cart-referrals');
    assert.equal(payload.rid, null);
    assert.equal(payload.bh, crypto.createHash('sha256').update(sent[0].init.body, 'utf8').digest('hex'));
  });

  test('the op is signed only with the referral switch AND partner identity forwarding on', () => {
    const sign = (env) => assertionModule.boundIssuingAgentAssertionHeaders({
      op: 'ucp_storefront_cart.referral', method: 'POST', url: `${BASE}/agent/v2/storefront-cart-referrals`, rid: null, rawBody: '{}',
      invokeContext: { auth_mode: 'api_key', agent_id: 'agent_partner_a' }, env: { ISSUING_AGENT_ASSERTION_SECRET: SECRET, ...env },
    });
    assert.ok(sign({ [FORWARDING]: '1', [CART_REFERRAL_FLAG]: '1' })['X-Pivota-Issuing-Agent']);
    assert.deepEqual(sign({ [FORWARDING]: '1' }), {});
    assert.deepEqual(sign({ [CART_REFERRAL_FLAG]: '1' }), {});
    assert.deepEqual(sign({ [FORWARDING]: '1', [RECORD]: '1' }), {});
  });

  test('every recorded refusal is a named miss, never a throw', async () => {
    for (const [name, kind, code] of [
      ['dark', 'refused', 'http_404'],
      ['assertion_rejected', 'refused', 'PARTNER_ASSERTION_REJECTED'],
      ['not_a_service_caller', 'refused', 'service_caller_required'],
      ['invalid_body', 'refused', 'http_400'],
      ['store_unavailable', 'unavailable', 'referral_store_unavailable'],
    ]) {
      const { client } = clientWith(FIXTURE[name]);
      assert.deepEqual(await client.mint(FIXTURE[name].request), { kind, code }, name);
    }
  });

  test('an answer that is not exactly tracking members naming one click is no referral', async () => {
    const good = FIXTURE.minted_for_partner.body;
    const bad = [
      { ...good, attribution: { ...good.attribution, note: 'x' } },
      { ...good, attribution: { ...good.attribution, utm_source: 'https://elsewhere.example/' } },
      { ...good, attribution: { ...good.attribution, pvt_click_id: 'clk_other' } },
      { ...good, attribution: {} },
      { ...good, attribution: [] },
      { ...good, click_id: 'has space' },
      { click_id: good.click_id },
      [],
      null,
    ];
    for (const body of bad) {
      assert.equal(referralModule.readReferralAnswer(body), null, JSON.stringify(body));
      const { client } = clientWith({ status: 200, body });
      assert.deepEqual(await client.mint({ seller_host: 'shop-a.example.com' }), { kind: 'unavailable', code: 'malformed_answer' });
    }
    assert.deepEqual(referralModule.readReferralAnswer(good), { clickId: good.click_id, pairs: Object.entries(good.attribution) });
  });

  test('a transport failure, a timeout and a missing key are misses', async () => {
    const thrown = clientWith(() => { throw new Error('socket'); });
    assert.deepEqual(await thrown.client.mint({ seller_host: 'shop-a.example.com' }), { kind: 'unavailable', code: 'transport' });
    const slow = clientWith((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }), { timeoutMs: 60 });
    const started = Date.now();
    assert.deepEqual(await slow.client.mint({ seller_host: 'shop-a.example.com' }), { kind: 'unavailable', code: 'timeout' });
    assert.ok(Date.now() - started < 500);
    const noKey = clientWith(FIXTURE.minted_no_partner, { authHeaders: () => null });
    assert.deepEqual(await noKey.client.mint({ seller_host: 'shop-a.example.com' }), { kind: 'unavailable', code: 'unconfigured' });
    assert.deepEqual(noKey.sent, [], 'nothing is sent without the gateway\'s own key');
    // The timeout can be lowered, never raised above one second.
    assert.equal(clientWith(FIXTURE.dark, { timeoutMs: 60000 }).client.timeoutMs, 1000);
    assert.equal(clientWith(FIXTURE.dark, {}).client.timeoutMs, 1000);
  });

  test('log lines name an outcome and a code, never the click id, a header or a body', async () => {
    const lines = [];
    const logger = { info: (f) => lines.push(['info', f]), warn: (f) => lines.push(['warn', f]) };
    await clientWith(FIXTURE.minted_for_partner, { logger }).client.mint(FIXTURE.minted_for_partner.request);
    await clientWith(FIXTURE.store_unavailable, { logger }).client.mint(FIXTURE.store_unavailable.request);
    assert.deepEqual(lines, [
      ['info', { event: 'ucp_storefront_cart_referral_call', outcome: 'minted', attributed: true, http_status: 200 }],
      ['warn', { event: 'ucp_storefront_cart_referral_call', outcome: 'unavailable', code: 'referral_store_unavailable', http_status: 503 }],
    ]);
  });
});

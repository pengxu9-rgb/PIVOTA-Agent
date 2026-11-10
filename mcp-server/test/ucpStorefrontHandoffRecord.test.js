// THE UCP STOREFRONT HAND-OFF RECORD AND QUOTE-SOURCE LABEL (FIX_PLAN O-02), on the escalation lane itself.
//
// Pinned here:
//   - the label: every storefront checkout says where its totals came from (`seller_cart` + when the seller priced
//     it, or `catalogue_fallback` + the oldest catalogue read + a warning), on create AND on the re-read; off, absent;
//   - the record: one write per create, for the seller-priced and the catalogue answer alike, with the totals the
//     checkout shows; only a CONFIRMED write puts the record id into the esc id; any other outcome hands out the id
//     the door always handed out;
//   - the switches: the label rides UCP_STOREFRONT_HANDOFF_RECORD_ENABLED alone, the record needs it AND
//     PARTNER_IDENTITY_FORWARDING_ENABLED; all off, the answer is byte-identical to the lane without a recorder;
//   - UCP `cart.attribution` on the seller's create_cart (AGENT_CHECKOUT_UCP_CART_ATTRIBUTION_ENABLED): the same
//     tracking members the cart URL carries, inside the cart as UCP 2026-04-08 cart.json places it, create only;
//   - the get_order mapping of a hand-off read.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { MERCHANT_PRICING_FLAG, CART_ATTRIBUTION_FLAG, cartAttributionOf } from '../src/ucpMerchantDoorPricing.js';
import {
  UCP_ESCALATION_FLAG,
  QUOTE_SOURCE_FALLBACK_MESSAGE_CODE,
  tryEscalateUcpCheckout,
  encodeEscalationId,
  decodeEscalationId,
  escalationCartIdOf,
  escalationRecordIdOf,
  cataloguePriceAsOf,
  referralClickIdOf,
} from '../src/ucpCheckoutEscalation.js';
import { storefrontHandoffOrder } from '../../safety-kernel/src/protocol/canonicalExecutor.js';
import { PivotaCommerceError } from '../../safety-kernel/src/errors.js';
import handoffModule from '../../src/services/storefrontHandoffRecord.js';
import buyerAgentClientModule from '../../src/services/ucpBuyerAgentClient.js';
import assertionModule from '../../src/attribution/issuingAgentAssertion.js';

const RECORD = 'UCP_STOREFRONT_HANDOFF_RECORD_ENABLED';
const FORWARDING = 'PARTNER_IDENTITY_FORWARDING_ENABLED';
const ESC = { [UCP_ESCALATION_FLAG]: '1' };
const PRICED = { ...ESC, [MERCHANT_PRICING_FLAG]: '1' };
const ALL = { [RECORD]: '1', [FORWARDING]: '1' };
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const GID = (n) => `gid://shopify/ProductVariant/${n}`;
const ENDPOINT = 'https://shop-a.example.com/api/ucp/mcp';
const CART_URL = 'https://shop-a.example.com/cart/c/abc123?key=k';
const CLICK = 'clk_00112233445566778899aabb';
const LINK = `https://shop-a.example.com/products/serum-x?utm_source=pivota&utm_medium=agent&pvt_click_id=${CLICK}&variant=1`;

const SEED = Object.freeze({
  product_id: 'sig_handoff_a', merchant_id: 'merch_obs_shop_a', title: 'Serum X', price: 25, currency: 'USD',
  external_redirect_url: LINK, price_as_of: '2026-11-01T10:00:00Z',
  variants: [{ variant_id: 'sig_handoff_a', source_variant_id: '44012345678901' }],
});
const SEED_B = Object.freeze({
  ...SEED, product_id: 'sig_handoff_b', title: 'Toner Y', price: 10, price_as_of: '2026-10-30T08:00:00Z',
  external_redirect_url: 'https://shop-a.example.com/products/toner-y',
  variants: [{ variant_id: 'sig_handoff_b', source_variant_id: '44012345678902' }],
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

function sellerCart({ lines = [[GID('44012345678901'), 2, 2400]], id = 'gid://shopify/Cart/c1' } = {}) {
  const sub = lines.reduce((a, [, q, p]) => a + q * p, 0);
  const payload = {
    id, currency: 'USD', continue_url: CART_URL,
    line_items: lines.map(([gid, quantity, price], i) => ({
      id: `line_${i}`, item: { id: gid, title: `Seller title ${i}`, price }, quantity,
      totals: [{ type: 'subtotal', amount: quantity * price }, { type: 'total', amount: quantity * price }],
    })),
    totals: [{ type: 'subtotal', amount: sub }, { type: 'total', amount: sub }],
  };
  return { ok: true, status: 200, response: { result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } } };
}

function fakeDoor() {
  const calls = [];
  return {
    calls,
    async endpointFor(host) { calls.push(['discover', host]); return ENDPOINT; },
    async createCart(ep, args) { calls.push(['create_cart', ep, structuredClone(args)]); return sellerCart(); },
    async getCart(ep, cartId) { calls.push(['get_cart', ep, cartId]); return sellerCart(); },
  };
}

function recorder(kind = 'recorded') {
  const calls = [];
  return { calls, async record(fields) { calls.push(structuredClone(fields)); return typeof kind === 'function' ? kind(fields) : { kind }; } };
}

const CREATE = { id: 'create_checkout_session', capability: 'checkout' };
const GET = { id: 'get_checkout_session', capability: 'checkout' };
const createParams = (...pairs) => ({ idempotency_key: 'idem-0001', quote: { items: pairs.map(([product_id, quantity]) => ({ product_id, quantity })) } });
const US = { checkout: { context: { address_country: 'US' } } };
const escBody = (id) => JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8'));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function create({ env, rows = { [SEED.product_id]: SEED }, items = [[SEED.product_id, 2]], merchantDoor, handoffRecorder } = {}) {
  return tryEscalateUcpCheckout({
    op: CREATE, params: createParams(...items), ctx: {}, executor: executorWith(rows), ucpArgs: US,
    env, now: NOW, merchantDoor, handoffRecorder,
  });
}

// ---- the catalogue answer ------------------------------------------------------------------------------------

describe('catalogue fallback', () => {
  test('flags on: one record with the totals shown, the record id in the esc id, the label and the warning', async () => {
    const rec = recorder();
    const out = await create({ env: { ...ESC, ...ALL }, handoffRecorder: rec });
    assert.equal(rec.calls.length, 1);
    const recordId = escBody(out.id).r;
    assert.match(recordId, /^esh_[A-Za-z0-9_-]{22}$/);
    assert.equal(escalationRecordIdOf(out.id), recordId);
    assert.deepEqual(decodeEscalationId(out.id), [{ product_id: SEED.product_id, quantity: 2 }], 'the items are unchanged');
    assert.deepEqual(rec.calls[0], {
      record_id: recordId,
      binding: sha(out.id),
      seller_host: 'shop-a.example.com',
      currency: 'USD',
      quoted_total_minor: 5000,
      quote_source: 'catalogue_fallback',
      buyer_market: 'US',
      referral_click_id: CLICK,
      price_as_of: '2026-11-01T10:00:00.000Z',
      merchant_id: 'merch_obs_shop_a',
    });
    assert.equal(out.totals.find((t) => t.type === 'total').amount, 5000);
    assert.equal(out.quote_source, 'catalogue_fallback');
    assert.equal(out.price_as_of, '2026-11-01T10:00:00.000Z');
    const warning = out.messages.find((m) => m.code === QUOTE_SOURCE_FALLBACK_MESSAGE_CODE);
    assert.equal(warning.type, 'warning');
    assert.equal(warning.path, '$.totals');
    assert.match(warning.content, /as of 2026-11-01T10:00:00\.000Z/);
  });

  test('price_as_of is the OLDEST line read, and null when any line has none', async () => {
    const rows = new Map([[SEED.product_id, SEED], [SEED_B.product_id, SEED_B]]);
    const items = [{ product_id: SEED.product_id }, { product_id: SEED_B.product_id }];
    assert.equal(cataloguePriceAsOf(items, rows), '2026-10-30T08:00:00.000Z');
    rows.set(SEED_B.product_id, { ...SEED_B, price_as_of: null });
    assert.equal(cataloguePriceAsOf(items, rows), null);
    rows.set(SEED_B.product_id, { ...SEED_B, price_as_of: 'not a time' });
    assert.equal(cataloguePriceAsOf(items, rows), null);
    const out = await create({ env: { ...ESC, [RECORD]: '1' }, rows: { [SEED.product_id]: { ...SEED, price_as_of: undefined } } });
    assert.equal(out.price_as_of, null);
    assert.match(out.messages.find((m) => m.code === QUOTE_SOURCE_FALLBACK_MESSAGE_CODE).content, /no read time on record/);
  });

  test('a record that is not confirmed hands out exactly the unrecorded id', async () => {
    for (const kind of ['refused', 'unavailable', 'unattributed', () => { throw new Error('boom'); }, () => null]) {
      const rec = recorder(kind);
      const out = await create({ env: { ...ESC, ...ALL }, handoffRecorder: rec });
      assert.equal(rec.calls.length, 1);
      assert.equal(out.id, encodeEscalationId([{ product_id: SEED.product_id, quantity: 2 }], undefined, undefined, { code: 'US', assumed: false }), String(kind));
      assert.equal(out.quote_source, 'catalogue_fallback');
    }
  });

  test('a cart the catalogue cannot price is refused before anything is recorded', async () => {
    const rec = recorder();
    const err = await create({ env: { ...ESC, ...ALL }, rows: { [SEED.product_id]: { ...SEED, price: null } }, handoffRecorder: rec }).catch((e) => e);
    assert.ok(err instanceof PivotaCommerceError);
    assert.equal(rec.calls.length, 0);
  });

  test('the re-read answers the recorded id with the same label, and records nothing', async () => {
    const rec = recorder();
    const env = { ...ESC, ...ALL };
    const created = await create({ env, handoffRecorder: rec });
    const reread = await tryEscalateUcpCheckout({
      op: GET, params: { session_id: created.id }, ctx: {}, executor: executorWith({ [SEED.product_id]: SEED }), ucpArgs: {},
      env, now: NOW, handoffRecorder: rec,
    });
    assert.equal(reread.id, created.id);
    assert.equal(reread.quote_source, 'catalogue_fallback');
    assert.equal(rec.calls.length, 1);
  });
});

// ---- the seller-priced answer ---------------------------------------------------------------------------------

describe('seller cart', () => {
  test('flags on: recorded as seller_cart with the seller totals, labelled with when the seller priced it', async () => {
    const rec = recorder();
    const door = fakeDoor();
    const out = await create({ env: { ...PRICED, ...ALL }, merchantDoor: door, handoffRecorder: rec });
    assert.equal(escalationCartIdOf(out.id), 'gid://shopify/Cart/c1', 'still a seller-priced id');
    const recordId = escalationRecordIdOf(out.id);
    assert.ok(recordId);
    assert.deepEqual(rec.calls[0], {
      record_id: recordId, binding: sha(out.id), seller_host: 'shop-a.example.com', currency: 'USD',
      quoted_total_minor: 4800, quote_source: 'seller_cart', buyer_market: 'US', referral_click_id: CLICK,
      price_as_of: new Date(NOW).toISOString(), merchant_id: 'merch_obs_shop_a',
    });
    assert.equal(out.quote_source, 'seller_cart');
    assert.equal(out.price_as_of, new Date(NOW).toISOString());
    assert.ok(!out.messages.some((m) => m.code === QUOTE_SOURCE_FALLBACK_MESSAGE_CODE));
    // The re-read asks the seller for the SAME cart: the record id does not break the cart binding.
    const reread = await tryEscalateUcpCheckout({
      op: GET, params: { session_id: out.id }, ctx: {}, executor: executorWith({ [SEED.product_id]: SEED }), ucpArgs: {},
      env: { ...PRICED, ...ALL }, now: NOW, merchantDoor: door,
    });
    assert.equal(reread.id, out.id);
    assert.equal(reread.quote_source, 'seller_cart');
    assert.deepEqual(door.calls.filter((c) => c[0] === 'get_cart').map((c) => c[2]), ['gid://shopify/Cart/c1']);
  });
});

// ---- the switches ----------------------------------------------------------------------------------------------

describe('switches', () => {
  for (const [name, base] of [['catalogue', ESC], ['seller cart', PRICED]]) {
    test(`${name}: all off is byte-identical to the lane without a recorder, and contacts no recorder`, async () => {
      const rec = recorder();
      const withRec = await create({ env: base, merchantDoor: fakeDoor(), handoffRecorder: rec });
      const without = await create({ env: base, merchantDoor: fakeDoor() });
      assert.equal(JSON.stringify(withRec), JSON.stringify(without));
      assert.equal(rec.calls.length, 0);
      assert.equal('quote_source' in withRec, false);
      assert.equal(escBody(withRec.id).r, undefined);
    });

    test(`${name}: forwarding alone records nothing and labels nothing`, async () => {
      const rec = recorder();
      const out = await create({ env: { ...base, [FORWARDING]: '1' }, merchantDoor: fakeDoor(), handoffRecorder: rec });
      const without = await create({ env: base, merchantDoor: fakeDoor() });
      assert.equal(JSON.stringify(out), JSON.stringify(without));
      assert.equal(rec.calls.length, 0);
    });

    test(`${name}: the record flag alone labels, but records nothing`, async () => {
      const rec = recorder();
      const out = await create({ env: { ...base, [RECORD]: '1' }, merchantDoor: fakeDoor(), handoffRecorder: rec });
      assert.equal(rec.calls.length, 0);
      assert.equal(escBody(out.id).r, undefined);
      assert.ok(['seller_cart', 'catalogue_fallback'].includes(out.quote_source));
    });
  }

  test('no recorder injected: nothing recorded, the id unrecorded, the label still there', async () => {
    const out = await create({ env: { ...ESC, ...ALL } });
    assert.equal(escBody(out.id).r, undefined);
    assert.equal(out.quote_source, 'catalogue_fallback');
  });
});

// ---- the esc id's record member ----------------------------------------------------------------------------------

describe('the record id in the esc id', () => {
  test('read back only when well formed, and only from an id that decodes', () => {
    const items = [{ product_id: 'p_1', quantity: 1 }];
    const good = `esh_${'a'.repeat(22)}`;
    assert.equal(escalationRecordIdOf(encodeEscalationId(items, undefined, undefined, undefined, good)), good);
    assert.equal(escalationRecordIdOf(encodeEscalationId(items, 'cart_1', 'shop-a.example.com', { code: 'US', assumed: false }, good)), good);
    assert.equal(escalationRecordIdOf(encodeEscalationId(items)), undefined);
    for (const bad of ['esh_short', `esh_${'a'.repeat(23)}`, `x${good}`, 42, `esh_${'a'.repeat(21)}/`]) {
      assert.equal(escalationRecordIdOf(encodeEscalationId(items, undefined, undefined, undefined, bad)), undefined, String(bad));
    }
    const noItems = `esc_${Buffer.from(JSON.stringify({ v: 1, i: [], r: good })).toString('base64url')}`;
    assert.equal(escalationRecordIdOf(noItems), undefined);
    assert.equal(escalationRecordIdOf('not-an-esc-id'), undefined);
  });

  test('an id without a record keeps the exact bytes it always had', () => {
    const items = [{ product_id: 'p_1', quantity: 2 }];
    assert.equal(encodeEscalationId(items), `esc_${Buffer.from(JSON.stringify({ v: 1, i: [['p_1', 2]] })).toString('base64url')}`);
    assert.equal(encodeEscalationId(items, 'c', 'h.example.com'),
      `esc_${Buffer.from(JSON.stringify({ v: 2, i: [['p_1', 2]], c: 'c', h: 'h.example.com' })).toString('base64url')}`);
  });

  test('the referral click id: from a Pivota hop destination or the link itself, one well-formed value only', () => {
    assert.equal(referralClickIdOf(LINK), CLICK);
    const dest = `https://shop-a.example.com/p?pvt_click_id=${CLICK}`;
    const token = `${Buffer.from(JSON.stringify({ dest })).toString('base64url')}.sig`;
    assert.equal(referralClickIdOf(`https://api.pivota.cc/r?token=${token}`), CLICK);
    assert.equal(referralClickIdOf('https://shop-a.example.com/p?pvt_click_id=a&pvt_click_id=b'), null);
    assert.equal(referralClickIdOf('https://shop-a.example.com/p?pvt_click_id=bad%20id'), null);
    assert.equal(referralClickIdOf('https://shop-a.example.com/p'), null);
    assert.equal(referralClickIdOf('not a url'), null);
  });
});

// ---- UCP cart.attribution on the seller's create_cart ------------------------------------------------------------

describe('cart.attribution', () => {
  test('flag on: the catalog link\'s tracking members ride create_cart, and nothing on a re-read', async () => {
    const door = fakeDoor();
    const env = { ...PRICED, [CART_ATTRIBUTION_FLAG]: '1' };
    const out = await create({ env, merchantDoor: door });
    const [, , args] = door.calls.find((c) => c[0] === 'create_cart');
    assert.deepEqual(args.cartAttribution, { utm_source: 'pivota', utm_medium: 'agent', pvt_click_id: CLICK });
    await tryEscalateUcpCheckout({
      op: GET, params: { session_id: out.id }, ctx: {}, executor: executorWith({ [SEED.product_id]: SEED }), ucpArgs: {},
      env, now: NOW, merchantDoor: door,
    });
    assert.equal(door.calls.filter((c) => c[0] === 'create_cart').length, 1);
  });

  test('flag off: the create_cart arguments are exactly as before', async () => {
    const door = fakeDoor();
    await create({ env: PRICED, merchantDoor: door });
    const [, , args] = door.calls.find((c) => c[0] === 'create_cart');
    assert.deepEqual(Object.keys(args).sort(), ['context', 'lineItems']);
  });

  test('a link without tracking members sends no attribution', async () => {
    assert.equal(cartAttributionOf('https://shop-a.example.com/p?variant=1'), null);
    assert.equal(cartAttributionOf('not a url'), null);
    assert.equal(cartAttributionOf(undefined), null);
    const door = fakeDoor();
    const rows = { [SEED.product_id]: { ...SEED, external_redirect_url: 'https://shop-a.example.com/products/serum-x' } };
    await create({ env: { ...PRICED, [CART_ATTRIBUTION_FLAG]: '1' }, rows, merchantDoor: door });
    assert.equal('cartAttribution' in door.calls.find((c) => c[0] === 'create_cart')[2], false);
  });

  test('the client puts it INSIDE the cart object (UCP 2026-04-08 cart.json), strings only; the old sibling is unchanged', async () => {
    const bodies = [];
    const fetchImpl = async (_url, init = {}) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }), headers: { get: () => null } };
    };
    const client = buyerAgentClientModule.createUcpBuyerAgentClient({ profileUrl: 'https://agent.pivota.cc/.well-known/ucp-agent', fetchImpl });
    const lineItems = [{ item: { id: GID(1) }, quantity: 1 }];
    await client.createCart(ENDPOINT, { lineItems, cartAttribution: { utm_source: 'pivota', pvt_click_id: CLICK, n: 1 } });
    await client.createCart(ENDPOINT, { lineItems });
    await client.createCart(ENDPOINT, { lineItems, attribution: { a: 'b' } });
    const args = bodies.map((b) => b.params.arguments);
    assert.deepEqual(args[0].cart.attribution, { utm_source: 'pivota', pvt_click_id: CLICK });
    assert.equal('attribution' in args[0], false);
    assert.equal('attribution' in args[1].cart, false);
    assert.deepEqual(args[2].attribution, { a: 'b' }, 'the existing sibling argument is untouched');
    assert.equal('attribution' in args[2].cart, false);
  });
});

// ---- get_order on a hand-off ---------------------------------------------------------------------------------------

describe('get_order mapping', () => {
  const ID = 'esc_x';
  test('accepted: the hand-off as recorded, never a Pivota order', () => {
    const out = storefrontHandoffOrder(ID, { kind: 'accepted', handoff: {
      record_id: 'esh_r', status: 'buyer_followed_link', handed_off_at: '2026-11-08T12:00:00Z', seller_host: 'shop-a.example.com',
      quote_source: 'catalogue_fallback', price_as_of: '2026-11-01T10:00:00Z', buyer_market: 'US',
      quoted_total: { amount: 2500, currency: 'USD', extra: 'x' }, link_followed_at: '2026-11-08T12:05:00Z', binding: 'never',
    } });
    assert.deepEqual(out, {
      order_id: ID, status: 'buyer_followed_link', source: 'storefront_handoff', completes_on: 'seller_storefront',
      handoff: {
        handed_off_at: '2026-11-08T12:00:00Z', seller_host: 'shop-a.example.com', buyer_market: 'US',
        quote_source: 'catalogue_fallback', price_as_of: '2026-11-01T10:00:00Z',
        quoted_total: { amount: 2500, currency: 'USD' }, link_followed_at: '2026-11-08T12:05:00Z',
      },
    });
  });

  test('refusals', () => {
    const codeOf = (kind) => { try { storefrontHandoffOrder(ID, { kind }); } catch (e) { return [e.code, e.detail.reason]; } return null; };
    assert.deepEqual(codeOf('unrecorded'), ['OPERATION_NOT_ALLOWED', 'storefront_handoff_unrecorded']);
    assert.deepEqual(codeOf('unattributed'), ['OPERATION_NOT_ALLOWED', 'storefront_handoff_partner_required']);
    assert.deepEqual(codeOf('not_found'), ['QUOTE_NOT_FOUND', 'storefront_handoff_not_found']);
    assert.deepEqual(codeOf('not_owner'), ['STATE_LINKAGE_MISMATCH', 'agent_mismatch']);
    assert.deepEqual(codeOf('unavailable'), ['MERCHANT_UNAVAILABLE', 'storefront_handoff_read_unavailable']);
  });
});

// ---- the backend client --------------------------------------------------------------------------------------------

describe('storefront hand-off client', () => {
  const BASE = { 'X-API-Key': 'gateway-key' };
  const SIGNED = { 'X-Pivota-Issuing-Agent': 'v2.x.y' };
  function client({ status = 200, body, headers = BASE, signed = SIGNED, throws } = {}) {
    const calls = [];
    const c = handoffModule.createStorefrontHandoffClient({
      baseUrl: 'http://backend.example.com/',
      authHeaders: () => headers,
      signRequest: (req) => { calls.push(['auth', req.op, req.method, req.url, req.rid, req.rawBody]); return signed; },
      fetchImpl: async (url, init) => {
        calls.push(['fetch', url, init.method, JSON.parse(init.body), init.redirect]);
        calls.push(['sent', init.body, init.headers['X-Pivota-Issuing-Agent'], init.headers['X-API-Key']]);
        if (throws) throw throws;
        return { status, text: async () => JSON.stringify(body) };
      },
    });
    return { c, calls };
  }
  const FIELDS = { record_id: `esh_${'b'.repeat(22)}`, binding: 'f'.repeat(64) };

  test('record: posts the fields with the record op, confirms only the echo of its own id', async () => {
    const ok = client({ body: { record_id: FIELDS.record_id, status: 'handed_off' } });
    assert.deepEqual(await ok.c.record(FIELDS), { kind: 'recorded' });
    const URL_ = 'http://backend.example.com/agent/v2/storefront-handoffs';
    assert.deepEqual(ok.calls, [
      ['auth', 'ucp_storefront_handoff.record', 'POST', URL_, FIELDS.record_id, JSON.stringify(FIELDS)],
      ['fetch', URL_, 'POST', FIELDS, 'error'],
      // The bytes signed are the bytes sent, with the bound header beside the gateway key.
      ['sent', JSON.stringify(FIELDS), 'v2.x.y', 'gateway-key'],
    ]);
    assert.equal((await client({ body: { record_id: 'esh_other', status: 'handed_off' } }).c.record(FIELDS)).kind, 'refused');
    assert.deepEqual(await client({ status: 409, body: { detail: { error: 'handoff_conflict' } } }).c.record(FIELDS), { kind: 'refused', code: 'handoff_conflict' });
    assert.equal((await client({ status: 503, body: {} }).c.record(FIELDS)).kind, 'unavailable');
    assert.equal((await client({ throws: new Error('down') }).c.record(FIELDS)).kind, 'unavailable');
  });

  test('no partner assertion: nothing is sent', async () => {
    for (const [headers, signed] of [[null, SIGNED], [BASE, {}], [BASE, null]]) {
      const none = client({ headers, signed });
      assert.deepEqual(await none.c.record(FIELDS), { kind: 'unattributed' });
      assert.deepEqual(await none.c.read(FIELDS.record_id, 'esc_x'), { kind: 'unattributed' });
      assert.equal(none.calls.filter((c) => c[0] === 'fetch').length, 0);
    }
  });

  test('read: the binding of the esc id, the read op, and the four outcomes', async () => {
    const ok = client({ body: { record_id: FIELDS.record_id, status: 'handed_off' } });
    assert.equal((await ok.c.read(FIELDS.record_id, 'esc_abc')).kind, 'accepted');
    assert.deepEqual(ok.calls[1][3], { record_id: FIELDS.record_id, binding: sha('esc_abc') });
    assert.deepEqual(ok.calls[0].slice(1, 5), ['ucp_storefront_handoff.read', 'POST', 'http://backend.example.com/agent/v2/storefront-handoffs/read', FIELDS.record_id]);
    const wrapped = (code) => ({ detail: { error: code }, error: { code: 'X', message: code, details: { error: code } }, status: 'error' });
    assert.equal((await client({ status: 404, body: wrapped('handoff_not_found') }).c.read(FIELDS.record_id, 'e')).kind, 'not_found');
    assert.equal((await client({ status: 403, body: wrapped('not_owner') }).c.read(FIELDS.record_id, 'e')).kind, 'not_owner');
    assert.equal((await client({ status: 403, body: wrapped('partner_identity_required') }).c.read(FIELDS.record_id, 'e')).kind, 'unavailable');
    assert.equal((await client({ status: 404, body: wrapped('not_available') }).c.read(FIELDS.record_id, 'e')).kind, 'unavailable');
    assert.equal((await client({ body: { record_id: 'esh_other', status: 'handed_off' } }).c.read(FIELDS.record_id, 'e')).kind, 'unavailable');
    const malformed = client();
    assert.deepEqual(await malformed.c.read('esh_bad', 'e'), { kind: 'not_found' });
    assert.equal(malformed.calls.length, 0);
  });

  test('record ids are 128 random bits in the esc id alphabet', () => {
    const ids = new Set(Array.from({ length: 50 }, () => handoffModule.mintHandoffRecordId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, handoffModule.HANDOFF_RECORD_ID_RE);
  });
});

// ---- the assertion on the hand-off ops ---------------------------------------------------------------------------------

describe('issuing-agent assertion on the hand-off ops', () => {
  const invokeContext = { auth_mode: 'api_key', agent_id: 'agent_partner_a' };
  const base = { ISSUING_AGENT_ASSERTION_SECRET: 'fake_test_secret' };
  const URL_ = 'http://backend.example.com/agent/v2/storefront-handoffs/read';
  const rawBody = '{"record_id":"esh_x","binding":"f"}';
  const bound = (op, env) => assertionModule.boundIssuingAgentAssertionHeaders({
    op, invokeContext, env, method: 'post', url: URL_, rid: 'esh_x', rawBody, nowSec: 1794100000, jti: 'j'.repeat(24),
  });
  test('the request-bound (v2) token, only with BOTH switches on, bound to method, path, record id and body', () => {
    for (const op of ['ucp_storefront_handoff.record', 'ucp_storefront_handoff.read']) {
      assert.deepEqual(bound(op, base), {}, op);
      assert.deepEqual(bound(op, { ...base, [RECORD]: '1' }), {}, op);
      assert.deepEqual(bound(op, { ...base, [FORWARDING]: '1' }), {}, op);
      const token = bound(op, { ...base, ...ALL })['X-Pivota-Issuing-Agent'];
      assert.ok(token.startsWith('v2.'));
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      assert.deepEqual(payload, {
        v: 2, kind: 'agent', sub: 'agent_partner_a', op, ts: 1794100000, jti: 'j'.repeat(24), m: 'POST',
        p: '/agent/v2/storefront-handoffs/read', rid: 'esh_x', bh: sha(rawBody),
      });
    }
  });
  test('never the unbound v1 token, whatever the switches', () => {
    for (const op of ['ucp_storefront_handoff.record', 'ucp_storefront_handoff.read']) {
      assert.deepEqual(assertionModule.issuingAgentAssertionHeaders({ op, invokeContext, env: { ...base, ...ALL } }), {});
    }
  });
  test('the hand-off switch binds nothing else', () => {
    assert.deepEqual(bound('create_order', { ...base, [RECORD]: '1' }), {});
    assert.deepEqual(bound('ucp_storefront_handoff.other', { ...base, ...ALL }), {});
  });
});

// UCP checkout escalation (path 2) — the door says "this completes on the seller's storefront" in the spec's
// own shape, for rows Pivota does not transact, and touches nothing on the kernel path.
//
// Two things are pinned here that a green suite could otherwise fake:
//   - the classification is TYPED (the read's `external_redirect_url`, minus `purchase_route:
//     'internal_checkout'`), never a merchant-id prefix or a host pattern — the mutant that classifies by
//     `merch_obs_` prefix must fail;
//   - with the flag OFF, or for a contracted row, the kernel path runs EXACTLY as before — the executor
//     receives create_checkout_session with the same params it did yesterday.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  UCP_ESCALATION_FLAG,
  UCP_RESPONSE_VERSION,
  ucpEscalationEnabled,
  escalationTargetOf,
  encodeEscalationId,
  decodeEscalationId,
  buildEscalationCheckout,
  tryEscalateUcpCheckout,
} from '../src/ucpCheckoutEscalation.js';
import { createCommerceToolSurface, ucpDialectSurface } from '../src/commerceToolSurface.js';

// PROVENANCE: https://ucp.dev/2026-04-08/schemas/shopping/checkout.json + types (fetched 2026-08-18).
const REQUIRED_CHECKOUT = ['ucp', 'id', 'line_items', 'status', 'currency', 'totals', 'links'];
const REQUIRED_UCP = ['version', 'payment_handlers'];
const REQUIRED_LINE_ITEM = ['id', 'item', 'quantity', 'totals'];
const REQUIRED_ITEM = ['id', 'title', 'price'];
const REQUIRED_TOTAL = ['type', 'amount'];
const REQUIRED_LINK = ['type', 'url'];
const STATUS_ENUM = ['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled'];

const ON = { [UCP_ESCALATION_FLAG]: '1' };
const OFF = {};
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const AGENT_META = { 'ucp-agent': { profile: 'https://agent.example/.well-known/ucp-agent' }, 'idempotency-key': 'idem-0001-escalate' };
const SESSION = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };

// A SEED row as the live unscoped read serves it (measured 2026-08-18): storefront destination, observed
// seller, prices in majors, no purchase_route.
const SEED = Object.freeze({
  product_id: 'sig_seed_a', title: 'Vitamin C Serum', brand: 'Comfort Zone', price: 131, currency: 'USD',
  image_url: 'https://cdn.example/a.jpg', merchant_id: 'merch_obs_5a99644d0e8fbed5',
  external_redirect_url: 'https://comfortzone.us/products/skin-regimen-lx-vitamin-c-serum',
  // Deliberately DIFFERENT from the typed redirect target: the escalation must follow the builder's judgement
  // (external_redirect_url), never a raw row URL — a mutant that reads destination_url must fail.
  destination_url: 'https://tracking.example/out?to=comfortzone',
});
const SEED_B = Object.freeze({ ...SEED, product_id: 'sig_seed_b', title: 'Toner', price: 24.5, external_redirect_url: 'https://comfortzone.us/products/toner' });
const SEED_OTHER_SELLER = Object.freeze({ ...SEED, product_id: 'sig_seed_c', title: 'Cream', price: 34.5, external_redirect_url: 'https://us.nuxe.com/products/cream' });
// A CONTRACTED merchant row: no redirect target (the builder publishes none for a merchant Pivota transacts).
const CONTRACTED = Object.freeze({ product_id: 'p_shop_1', title: 'Shop Serum', price: 20, currency: 'USD', merchant_id: 'merchant_shop', variants: [{ variant_id: '48930014462260' }] });

function executorWith(rowsById) {
  const seen = [];
  return {
    seen,
    async execute(op, params, ctx) {
      seen.push({ op, params, ctx });
      if (op === 'get_product') {
        const pid = params.payload.product.product_id;
        const row = rowsById[pid];
        return row ? { product: { ...row } } : { product: null };
      }
      return { session_id: 'q_kernel' };
    },
  };
}
const items = (...pairs) => pairs.map(([product_id, quantity]) => ({ product_id, quantity }));
const params = (its, extra = {}) => ({ idempotency_key: 'idem-0001-escalate', quote: { items: its, ...extra } });
const CREATE = { id: 'create_checkout_session', capability: 'checkout' };
const GET = { id: 'get_checkout_session', capability: 'checkout' };
const UPDATE = { id: 'update_checkout_session', capability: 'checkout' };
const COMPLETE = { id: 'complete_checkout_session', capability: 'checkout' };
const rejected = (p) => p.then(() => null, (e) => e);

// ---- 0. flag ---------------------------------------------------------------------------------------------------

describe('kill-switch', () => {
  test('OFF by default; every truthy spelling turns it on; nothing else does', () => {
    assert.equal(ucpEscalationEnabled({}), false);
    assert.equal(ucpEscalationEnabled({ [UCP_ESCALATION_FLAG]: '0' }), false);
    assert.equal(ucpEscalationEnabled({ [UCP_ESCALATION_FLAG]: 'no' }), false);
    for (const v of ['1', 'true', 'yes', 'on', 'enabled', ' TRUE ']) assert.equal(ucpEscalationEnabled({ [UCP_ESCALATION_FLAG]: v }), true, v);
  });

  test('flag OFF: tryEscalate returns null for every checkout op — even for a seed cart', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED });
    for (const op of [CREATE, GET, UPDATE, COMPLETE]) {
      const out = await tryEscalateUcpCheckout({ op, params: op === CREATE ? params(items([SEED.product_id, 1])) : { session_id: encodeEscalationId(items([SEED.product_id, 1])) }, ctx: {}, executor, ucpArgs: {}, env: OFF });
      assert.equal(out, null, op.id);
    }
    assert.equal(executor.seen.length, 0, 'and performs no read at all');
  });
});

// ---- 1. classification is TYPED -----------------------------------------------------------------------------

describe('escalationTargetOf — the lane decision', () => {
  test('a row with an https external_redirect_url escalates to exactly that URL', () => {
    assert.equal(escalationTargetOf(SEED), 'https://comfortzone.us/products/skin-regimen-lx-vitamin-c-serum');
  });
  test('a contracted row (no redirect target) takes the kernel path', () => {
    assert.equal(escalationTargetOf(CONTRACTED), null);
  });
  test('a row that DECLARES internal_checkout never escalates, even with a redirect url present (fail closed towards the kernel)', () => {
    assert.equal(escalationTargetOf({ ...SEED, purchase_route: 'internal_checkout' }), null);
    assert.equal(escalationTargetOf({ ...SEED, purchase_route: 'INTERNAL_CHECKOUT' }), null);
  });
  test('the decision is the typed redirect field — NOT the merchant-id prefix, NOT the host, NOT destination_url alone', () => {
    // observed-seller prefix without a redirect target -> kernel path (no inference from id shape)
    assert.equal(escalationTargetOf({ ...CONTRACTED, merchant_id: 'merch_obs_deadbeef' }), null);
    // destination_url alone is NOT the builder's judgement — only external_redirect_url is
    assert.equal(escalationTargetOf({ ...CONTRACTED, destination_url: 'https://somewhere.example/p' }), null);
    // a non-https or malformed target is not a place to send anyone
    assert.equal(escalationTargetOf({ ...SEED, external_redirect_url: 'http://comfortzone.us/x' }), null);
    assert.equal(escalationTargetOf({ ...SEED, external_redirect_url: 'javascript:alert(1)' }), null);
    assert.equal(escalationTargetOf({ ...SEED, external_redirect_url: 'not a url' }), null);
    assert.equal(escalationTargetOf({ ...SEED, external_redirect_url: '' }), null);
    assert.equal(escalationTargetOf(null), null);
  });
});

// ---- 2. the id is stateless, opaque, and carries no buyer data -------------------------------------------

describe('escalation id', () => {
  test('round-trips product ids + quantities and nothing else', () => {
    const id = encodeEscalationId(items(['sig_a', 2], ['sig_b', 1]));
    assert.match(id, /^esc_[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeEscalationId(id), items(['sig_a', 2], ['sig_b', 1]));
    assert.equal(id.includes('@'), false);
  });
  test('rejects anything that is not one of ours', () => {
    for (const bad of ['sess_abc', 'esc_', 'esc_!!!', 'esc_' + Buffer.from('{"v":2,"i":[["a",1]]}').toString('base64url'),
      'esc_' + Buffer.from('{"v":1,"i":[]}').toString('base64url'), 'esc_' + Buffer.from('{"v":1,"i":[["a",0]]}').toString('base64url'),
      'esc_' + Buffer.from('{"v":1,"i":[["a","1"]]}').toString('base64url'), 'esc_' + Buffer.from('{"v":1,"i":[["",1]]}').toString('base64url'), 42, null]) {
      assert.equal(decodeEscalationId(bad), null, String(bad));
    }
  });
});

// ---- 3. the response is the spec checkout ------------------------------------------------------------------

describe('buildEscalationCheckout', () => {
  const rows = new Map([[SEED.product_id, SEED], [SEED_B.product_id, SEED_B]]);
  const out = buildEscalationCheckout({ id: 'esc_x', items: items([SEED.product_id, 2], [SEED_B.product_id, 1]), rows, continueUrl: SEED.external_redirect_url, buyerEmail: 'b@example.test', now: NOW, env: {} });

  test('every required member at every level, and the status is the escalation state with its mandatory continue_url', () => {
    for (const k of REQUIRED_CHECKOUT) assert.ok(k in out, `checkout missing ${k}`);
    for (const k of REQUIRED_UCP) assert.ok(k in out.ucp, `ucp missing ${k}`);
    assert.equal(out.ucp.version, UCP_RESPONSE_VERSION);
    assert.deepEqual(out.ucp.payment_handlers, {}, 'Pivota collects no instrument here');
    assert.ok(STATUS_ENUM.includes(out.status));
    assert.equal(out.status, 'requires_escalation');
    assert.equal(out.continue_url, SEED.external_redirect_url);
    for (const li of out.line_items) {
      for (const k of REQUIRED_LINE_ITEM) assert.ok(k in li, `line_item missing ${k}`);
      for (const k of REQUIRED_ITEM) assert.ok(k in li.item, `item missing ${k}`);
      for (const t of li.totals) for (const k of REQUIRED_TOTAL) assert.ok(k in t);
    }
    for (const l of out.links) for (const k of REQUIRED_LINK) assert.ok(k in l);
    assert.match(out.expires_at, /^2026-08-18T18:00:00\.000Z$/, 'the spec default TTL, 6h from now');
  });

  test('money: minor units, per-line and cart totals with EXACTLY one subtotal and one total each', () => {
    assert.equal(out.currency, 'USD');
    assert.equal(out.line_items[0].item.price, 13100);
    assert.deepEqual(out.line_items[0].totals, [{ type: 'subtotal', amount: 26200 }, { type: 'total', amount: 26200 }]);
    assert.deepEqual(out.line_items[1].totals, [{ type: 'subtotal', amount: 2450 }, { type: 'total', amount: 2450 }]);
    assert.equal(out.totals.filter((t) => t.type === 'subtotal').length, 1);
    assert.equal(out.totals.filter((t) => t.type === 'total').length, 1);
    assert.equal(out.totals.find((t) => t.type === 'total').amount, 28650);
    assert.match(out.totals[0].display_text, /last observed/i, 'stated as an expectation, not a quote');
  });

  test('links: the one legal URL that resolves; a privacy URL only when configured (never guessed)', () => {
    assert.deepEqual(out.links.map((l) => l.type), ['terms_of_service']);
    assert.equal(out.links[0].url, 'https://pivota.cc/terms');
    const withPrivacy = buildEscalationCheckout({ id: 'esc_x', items: items([SEED.product_id, 1]), rows, continueUrl: SEED.external_redirect_url, now: NOW, env: { PIVOTA_PRIVACY_POLICY_URL: 'https://pivota.cc/privacy' } });
    assert.deepEqual(withPrivacy.links.map((l) => l.type), ['privacy_policy', 'terms_of_service']);
    const httpPrivacy = buildEscalationCheckout({ id: 'esc_x', items: items([SEED.product_id, 1]), rows, continueUrl: SEED.external_redirect_url, now: NOW, env: { PIVOTA_PRIVACY_POLICY_URL: 'http://pivota.cc/privacy' } });
    assert.deepEqual(httpPrivacy.links.map((l) => l.type), ['terms_of_service'], 'an http legal link is not published');
  });

  test('the message says exactly what this is, names the seller host, and buyer is echoed only when given', () => {
    const m = out.messages[0];
    assert.equal(m.type, 'info');
    assert.equal(m.code, 'checkout.completes_on_seller_storefront');
    assert.match(m.content, /comfortzone\.us/);
    assert.match(m.content, /does not price, charge or ship/);
    assert.match(m.content, /cannot be updated or completed here/);
    assert.deepEqual(out.buyer, { email: 'b@example.test' });
    const noBuyer = buildEscalationCheckout({ id: 'esc_x', items: items([SEED.product_id, 1]), rows, continueUrl: SEED.external_redirect_url, now: NOW, env: {} });
    assert.equal(noBuyer.buyer, undefined);
    // internal row fields never leak
    const s = JSON.stringify(out);
    for (const leak of ['merch_obs_', 'destination_url', 'merchant_id']) assert.equal(s.includes(leak), false, leak);
  });

  test('an unpriced row cannot become a spec line item: NO_MERCHANT_OFFER, terminal', () => {
    const bad = new Map([[SEED.product_id, { ...SEED, price: undefined }]]);
    let err; try { buildEscalationCheckout({ id: 'esc_x', items: items([SEED.product_id, 1]), rows: bad, continueUrl: SEED.external_redirect_url, now: NOW, env: {} }); } catch (e) { err = e; }
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
    assert.equal(err.retriable, false);
    const badCur = new Map([[SEED.product_id, { ...SEED, currency: 'usd' }]]);
    try { err = undefined; buildEscalationCheckout({ id: 'esc_x', items: items([SEED.product_id, 1]), rows: badCur, continueUrl: SEED.external_redirect_url, now: NOW, env: {} }); } catch (e) { err = e; }
    assert.equal(err.code, 'NO_MERCHANT_OFFER');
  });

  test('mixed currencies in one cart are refused, not silently summed', () => {
    const mixed = new Map([[SEED.product_id, SEED], [SEED_B.product_id, { ...SEED_B, currency: 'EUR' }]]);
    let err; try { buildEscalationCheckout({ id: 'esc_x', items: items([SEED.product_id, 1], [SEED_B.product_id, 1]), rows: mixed, continueUrl: SEED.external_redirect_url, now: NOW, env: {} }); } catch (e) { err = e; }
    assert.equal(err.code, 'QUOTE_REQUIRED');
    assert.equal(err.detail.acp_detail.reason, 'ucp_escalation_mixed_currency');
  });
});

// ---- 4. the entry point: what escalates, what falls through, what is refused ---------------------------------

describe('tryEscalateUcpCheckout', () => {
  test('a seed cart escalates: spec checkout, ONE product read per distinct product, and the kernel is never asked to quote', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED, [SEED_B.product_id]: SEED_B });
    const out = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 2], [SEED_B.product_id, 1], [SEED.product_id, 1]), { customer_email: 'b@example.test' }), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON });
    assert.equal(out.status, 'requires_escalation');
    assert.equal(out.continue_url, SEED.external_redirect_url, 'the typed redirect target');
    assert.notEqual(out.continue_url, SEED.destination_url, 'never a raw row URL');
    assert.equal(out.line_items.length, 3);
    assert.deepEqual(executor.seen.map((c) => c.op), ['get_product', 'get_product'], 'two distinct products -> two reads, no create_checkout_session');
    assert.deepEqual(decodeEscalationId(out.id), items([SEED.product_id, 2], [SEED_B.product_id, 1], [SEED.product_id, 1]));
    assert.deepEqual(out.buyer, { email: 'b@example.test' });
  });

  test('money at quantity 3+ and per-line vs cart totals are exact (a capped-quantity mutant must fail)', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED, [SEED_B.product_id]: SEED_B });
    const out = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 3], [SEED_B.product_id, 5])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON });
    assert.deepEqual(out.line_items.map((li) => [li.quantity, li.totals[1].amount]), [[3, 39300], [5, 12250]]);
    assert.equal(out.totals.find((t) => t.type === 'total').amount, 51550);
  });

  test('continue_url is the FIRST line item\'s storefront page, not the last', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED, [SEED_B.product_id]: SEED_B });
    const out = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED_B.product_id, 1], [SEED.product_id, 1])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON });
    assert.equal(out.continue_url, SEED_B.external_redirect_url);
  });

  test('`www.` is not a different seller: www.host and host share one checkout', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED, [SEED_B.product_id]: { ...SEED_B, external_redirect_url: 'https://www.comfortzone.us/products/toner' } });
    const out = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 1], [SEED_B.product_id, 1])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON });
    assert.equal(out.status, 'requires_escalation');
    assert.equal(out.line_items.length, 2);
  });

  test('a quantity that is not a positive safe integer is NOT coerced — the call falls through so intake refuses it', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED });
    for (const q of [2.5, '3', 0, -1, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      const out = await tryEscalateUcpCheckout({ op: CREATE, params: params([{ product_id: SEED.product_id, quantity: q }]), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON });
      assert.equal(out, null, `quantity ${String(q)} must not become an escalation checkout`);
    }
    assert.equal(executor.seen.length, 0, 'and no read is spent on it');
  });

  test('a cart with more distinct products than intake allows is refused BEFORE any read (same bound as intake)', async () => {
    const executor = executorWith({});
    const many = Array.from({ length: 26 }, (_, i) => [`sig_${i}`, 1]);
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: params(items(...many)), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }));
    assert.equal(err.detail.acp_detail.reason, 'acp_cart_too_many_products');
    assert.equal(executor.seen.length, 0);
    // …and a forged 26-product esc_ id on get_checkout is refused the same way
    const err2 = await rejected(tryEscalateUcpCheckout({ op: GET, params: { session_id: encodeEscalationId(items(...many)) }, ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }));
    assert.equal(err2.detail.acp_detail.reason, 'acp_cart_too_many_products');
    assert.equal(executor.seen.length, 0);
  });

  test('reads are bounded by ONE deadline for the batch: a hanging read is a refusal, not a stall', async () => {
    const executor = { seen: [], execute(op, p, ctx) { this.seen.push({ op }); return new Promise(() => {}); } };
    const started = Date.now();
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 1], [SEED_B.product_id, 1])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON, timeoutMs: 40 }));
    assert.equal(err.detail.acp_detail.variant_resolution, 'resolution_unavailable');
    assert.ok(Date.now() - started < 2000, 'returned at the deadline');
  });

  test('buyer echo: ATTESTED wins over a body email, and a body email is normalized — never echoed raw', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED });
    const attestedOut = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 1]), { customer_email: 'body@example.test' }), ctx: SESSION, executor, ucpArgs: {}, attested: { attested_email: 'signed-in@example.test' }, now: NOW, env: ON });
    assert.deepEqual(attestedOut.buyer, { email: 'signed-in@example.test' });
    const rawOut = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 1]), { customer_email: '  Body@Example.test ' }), ctx: SESSION, executor, ucpArgs: {}, attested: {}, now: NOW, env: ON });
    assert.deepEqual(rawOut.buyer, { email: 'Body@Example.test' }, 'normalized (trimmed, shape-checked) — never the raw padded string');
    const junkOut = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 1]), { customer_email: 'not an email' }), ctx: SESSION, executor, ucpArgs: {}, attested: {}, now: NOW, env: ON });
    assert.equal(junkOut.buyer, undefined, 'junk is dropped, not echoed');
  });

  test('a contracted cart returns null — the kernel path is untouched', async () => {
    const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED });
    const out = await tryEscalateUcpCheckout({ op: CREATE, params: params(items([CONTRACTED.product_id, 1])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON });
    assert.equal(out, null);
  });

  test('a MIXED cart (contracted + seed) is refused with the storefront items named — never half-escalated', async () => {
    const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED, [SEED.product_id]: SEED });
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: params(items([CONTRACTED.product_id, 1], [SEED.product_id, 1])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }));
    assert.equal(err.code, 'QUOTE_REQUIRED');
    assert.equal(err.detail.acp_detail.reason, 'ucp_mixed_checkout_lanes');
    assert.deepEqual(err.detail.acp_detail.storefront_items, [SEED.product_id]);
    assert.match(err.detail.acp_message, /one checkout per lane/);
  });

  test('two sellers in one cart are refused with the hosts named — one checkout per seller', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED, [SEED_OTHER_SELLER.product_id]: SEED_OTHER_SELLER });
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 1], [SEED_OTHER_SELLER.product_id, 1])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }));
    assert.equal(err.detail.acp_detail.reason, 'ucp_multi_seller_escalation');
    assert.deepEqual(err.detail.acp_detail.seller_hosts.sort(), ['comfortzone.us', 'us.nuxe.com']);
  });

  test('a read that answers about ANOTHER product is an identity mismatch, before any classification', async () => {
    const executor = { seen: [], async execute(op, p) { return { product: { ...SEED, product_id: 'SOME_OTHER' } }; } };
    const err = await rejected(tryEscalateUcpCheckout({ op: CREATE, params: params(items([SEED.product_id, 1])), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }));
    assert.equal(err.detail.acp_detail.variant_resolution, 'identity_mismatch');
  });

  test('an empty cart returns null (intake owns that refusal)', async () => {
    const executor = executorWith({});
    assert.equal(await tryEscalateUcpCheckout({ op: CREATE, params: params([]), ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }), null);
    assert.equal(executor.seen.length, 0);
  });

  test('get_checkout on an escalation id re-reads and re-answers the same checkout; a kernel id falls through', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED });
    const id = encodeEscalationId(items([SEED.product_id, 3]));
    const out = await tryEscalateUcpCheckout({ op: GET, params: { session_id: id }, ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON });
    assert.equal(out.id, id);
    assert.equal(out.status, 'requires_escalation');
    assert.equal(out.line_items[0].quantity, 3);
    assert.equal(await tryEscalateUcpCheckout({ op: GET, params: { session_id: 'sess_kernel' }, ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }), null);
  });

  test('get_checkout on an escalation id whose row STOPPED being an escalation row says QUOTE_NOT_FOUND, never fabricates', async () => {
    const executor = executorWith({ [SEED.product_id]: { ...SEED, external_redirect_url: undefined } });
    const err = await rejected(tryEscalateUcpCheckout({ op: GET, params: { session_id: encodeEscalationId(items([SEED.product_id, 1])) }, ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }));
    assert.equal(err.code, 'QUOTE_NOT_FOUND');
  });

  test('update / complete on an escalation id are refused with the storefront named as the place to do it', async () => {
    const executor = executorWith({ [SEED.product_id]: SEED });
    const id = encodeEscalationId(items([SEED.product_id, 1]));
    for (const [op, reason] of [[UPDATE, 'ucp_escalation_update_refused'], [COMPLETE, 'ucp_escalation_complete_refused']]) {
      const err = await rejected(tryEscalateUcpCheckout({ op, params: { session_id: id }, ctx: SESSION, executor, ucpArgs: {}, now: NOW, env: ON }));
      assert.equal(err.code, 'OPERATION_NOT_ALLOWED', op.id);
      assert.equal(err.retriable, false);
      assert.equal(err.detail.reason, reason);
      assert.match(err.detail.acp_message, /continue_url/);
    }
    assert.equal(executor.seen.length, 0, 'refused without a read');
  });
});

// ---- 5. through the real surface: flag on/off, and the kernel path is byte-identical when not escalating -----

describe('through createCommerceToolSurface on the UCP dialect', () => {
  const body = (id, qty = 1) => ({ meta: AGENT_META, checkout: { line_items: [{ item: { id }, quantity: qty }], buyer: { email: 'shopper@example.test' } } });

  test('flag OFF: a seed cart takes the kernel path exactly as before (create_checkout_session reaches the executor)', async () => {
    const saved = process.env[UCP_ESCALATION_FLAG]; delete process.env[UCP_ESCALATION_FLAG];
    try {
      const executor = executorWith({ [SEED.product_id]: { ...SEED, purchase_grain: 'product', variants: [{ variant_id: SEED.product_id }] } });
      const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
      const out = await ucp.callTool('create_checkout', body(SEED.product_id), SESSION);
      assert.equal(out.session_id, 'q_kernel');
      assert.ok(executor.seen.some((c) => c.op === 'create_checkout_session'));
    } finally { if (saved !== undefined) process.env[UCP_ESCALATION_FLAG] = saved; }
  });

  test('flag ON: a seed cart is answered with the escalation checkout and create_checkout_session is NEVER executed', async () => {
    const saved = process.env[UCP_ESCALATION_FLAG]; process.env[UCP_ESCALATION_FLAG] = '1';
    try {
      const executor = executorWith({ [SEED.product_id]: SEED });
      const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
      const out = await ucp.callTool('create_checkout', body(SEED.product_id, 2), SESSION);
      assert.equal(out.status, 'requires_escalation');
      assert.equal(out.continue_url, SEED.external_redirect_url);
      assert.deepEqual(out.buyer, { email: 'shopper@example.test' });
      assert.equal(executor.seen.some((c) => c.op === 'create_checkout_session'), false);
      // attested wins through the real surface too: a session carrying a verified email displaces the body's
      const attestedOut = await ucp.callTool('create_checkout', body(SEED.product_id, 1), { ...SESSION, claims: { email: 'verified@example.test', email_verified: true } });
      assert.deepEqual(attestedOut.buyer, { email: 'verified@example.test' });
      // and get_checkout on the returned id round-trips through the SAME door
      const again = await ucp.callTool('get_checkout', { meta: AGENT_META, id: out.id }, SESSION);
      assert.equal(again.id, out.id);
      assert.equal(again.status, 'requires_escalation');
      // update / complete on it are refused
      const upd = await rejected(ucp.callTool('update_checkout', { meta: AGENT_META, id: out.id, checkout: { line_items: [{ item: { id: SEED.product_id }, quantity: 3 }] } }, SESSION));
      assert.equal(upd.code, 'OPERATION_NOT_ALLOWED');
    } finally { if (saved === undefined) delete process.env[UCP_ESCALATION_FLAG]; else process.env[UCP_ESCALATION_FLAG] = saved; }
  });

  test('flag ON: a CONTRACTED cart reads each product ONCE — the classifier and the resolver share the read', async () => {
    const saved = process.env[UCP_ESCALATION_FLAG]; process.env[UCP_ESCALATION_FLAG] = '1';
    try {
      const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED, p_shop_2: { ...CONTRACTED, product_id: 'p_shop_2' } });
      const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
      await ucp.callTool('create_checkout', { meta: AGENT_META, checkout: { line_items: [{ item: { id: CONTRACTED.product_id }, quantity: 1 }, { item: { id: 'p_shop_2' }, quantity: 2 }, { item: { id: CONTRACTED.product_id }, quantity: 1 }], buyer: { email: 'shopper@example.test' } } }, SESSION);
      const reads = executor.seen.filter((c) => c.op === 'get_product').map((c) => c.params.payload.product.product_id).sort();
      assert.deepEqual(reads, [CONTRACTED.product_id, 'p_shop_2'], 'two distinct products -> exactly two reads, not four');
      const create = executor.seen.find((c) => c.op === 'create_checkout_session');
      assert.deepEqual(create.params.quote.items.map((i) => i.variant_id), ['48930014462260', '48930014462260', '48930014462260'], 'and the resolver still resolved from the shared read');
    } finally { if (saved === undefined) delete process.env[UCP_ESCALATION_FLAG]; else process.env[UCP_ESCALATION_FLAG] = saved; }
  });

  test('flag ON: a CONTRACTED cart still takes the kernel path — same executor params as with the flag off', async () => {
    const run = async (flag) => {
      const saved = process.env[UCP_ESCALATION_FLAG];
      if (flag) process.env[UCP_ESCALATION_FLAG] = '1'; else delete process.env[UCP_ESCALATION_FLAG];
      try {
        const executor = executorWith({ [CONTRACTED.product_id]: CONTRACTED });
        const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
        await ucp.callTool('create_checkout', body(CONTRACTED.product_id), SESSION);
        return executor.seen.find((c) => c.op === 'create_checkout_session').params;
      } finally { if (saved === undefined) delete process.env[UCP_ESCALATION_FLAG]; else process.env[UCP_ESCALATION_FLAG] = saved; }
    };
    assert.deepEqual(await run(true), await run(false));
  });

  test('flag ON: the NATIVE /mcp dialect never escalates — a seed cart there still takes the kernel path', async () => {
    const saved = process.env[UCP_ESCALATION_FLAG]; process.env[UCP_ESCALATION_FLAG] = '1';
    try {
      const executor = executorWith({ [SEED.product_id]: { ...SEED, purchase_grain: 'product', variants: [{ variant_id: SEED.product_id }] } });
      const native = createCommerceToolSurface(executor, { cache: false });
      const out = await native.callTool('create_checkout_session', { idempotency_key: 'idem-native-0001', quote: { items: [{ product_id: SEED.product_id, quantity: 1 }], customer_email: 'shopper@example.test' } }, SESSION);
      assert.equal(out.session_id, 'q_kernel', 'native dialect: kernel path');
      assert.equal(out.status, undefined);
      assert.ok(executor.seen.some((c) => c.op === 'create_checkout_session'));
    } finally { if (saved === undefined) delete process.env[UCP_ESCALATION_FLAG]; else process.env[UCP_ESCALATION_FLAG] = saved; }
  });

  test('flag ON: it still requires a verified buyer — an anonymous escalation is refused before any read', async () => {
    const saved = process.env[UCP_ESCALATION_FLAG]; process.env[UCP_ESCALATION_FLAG] = '1';
    try {
      const executor = executorWith({ [SEED.product_id]: SEED });
      const ucp = ucpDialectSurface(createCommerceToolSurface(executor, { cache: false }));
      const err = await rejected(ucp.callTool('create_checkout', body(SEED.product_id), {}));
      assert.equal(err.code, 'USER_AUTH_REQUIRED');
      assert.equal(executor.seen.length, 0);
    } finally { if (saved === undefined) delete process.env[UCP_ESCALATION_FLAG]; else process.env[UCP_ESCALATION_FLAG] = saved; }
  });
});

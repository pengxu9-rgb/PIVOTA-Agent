'use strict';

// EVERY LISTED REFUSAL WHOSE WORDS SAY NOTHING HAPPENED, TAKEN OFF THE LIST, through the real doors over HTTP.
//
// Words that say an order call had no effect ("nothing was ordered", "nothing was done", "no order was created") may be
// given only on the quote-claim release rule's own proof (safety-kernel/src/upstreamRefusal.js): the pair is on the
// shared list, the route named the code, no deadline mark. The day the upstream finds such a check can follow a write, it
// takes the pair off the list in both repositories. This boots a gateway whose list is the shipped one without EVERY pair
// whose released answer says nothing happened (found by scanning those answers, not by a hand list), lands an order
// behind each such refusal, and pins what every door must then say: the kernel's unknown outcome, in the refused words,
// never a no-effect sentence, with the claim kept: the same key is told the same, another key the used session, and no
// second order call is ever made.
//
// The delisting is done in this process only, by answering the list file's read with the shorter list before the
// gateway loads the kernel; nothing on disk changes. Every name is a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { curatedUpstreamRefusal, mapUpstreamErrorToKernelCode } = require('../src/services/commerceKernelErrorMapping');

const LIST_FILE = path.join(__dirname, '../safety-kernel/contracts/order_create_prologue_refusals.json');
const SHIPPED = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
let DELISTED_TEXT = null; // set before the gateway loads; the list file's read answers it from then on
const realRead = fs.readFileSync;
fs.readFileSync = function readFileSync(file, ...rest) {
  if (DELISTED_TEXT !== null && String(file instanceof URL ? file.pathname : file) === LIST_FILE) return typeof rest[0] === 'string' || rest[0]?.encoding ? DELISTED_TEXT : Buffer.from(DELISTED_TEXT);
  return realRead.call(this, file, ...rest);
};
syncBuiltinESMExports();

const fx = require('./_support/quoteClaimReleaseDoor.cjs');

const { IDS, ANSWERS, BEFORE_ANY_ORDER } = fx;
const ORDERS = '/agent/v2/orders';
const CALLERS = ['mcp_complete', 'mcp_payment_link', 'ucp_complete', 'acp_complete', 'invoke'];
let door;
let keys;
let NO_EFFECT;
let KERNEL_ANSWERED_REFUSALS;
let REFUSED_BEFORE_ANY_ORDER;
let NO_EFFECT_PAIRS; // [[status, code, harness answer name]]

test.before(async () => {
  ({ NO_EFFECT } = await import('../safety-kernel/test/helpers/noEffectWords.js'));
  const { ERROR_CATALOG } = await import('../safety-kernel/src/errors.js');
  // The listed pairs whose RELEASED answer says nothing happened: the curated words, else the code's catalog words.
  NO_EFFECT_PAIRS = SHIPPED.filter(([status, code]) => {
    const input = { operation: 'create_order', status, upstreamCode: code, upstreamDetail: { error: code, reason: 'path' } };
    const curated = curatedUpstreamRefusal(input);
    const kernelCode = mapUpstreamErrorToKernelCode(input);
    const words = `${curated?.acp_message || ''} ${ERROR_CATALOG[kernelCode]?.userMessage || ''} ${ERROR_CATALOG[kernelCode]?.recovery || ''}`;
    return NO_EFFECT.test(words);
  }).map(([status, code]) => {
    const name = Object.keys(BEFORE_ANY_ORDER).find((n) => BEFORE_ANY_ORDER[n][0] === status && BEFORE_ANY_ORDER[n][1].error === code);
    assert.ok(name, `the fixture scripts ${status} ${code}`);
    return [status, code, name];
  });
  const kept = SHIPPED.filter(([s, c]) => !NO_EFFECT_PAIRS.some(([s2, c2]) => s2 === s && c2 === c));
  DELISTED_TEXT = `[\n${kept.map(([status, code]) => `  [${status}, ${JSON.stringify(code)}]`).join(',\n')}\n]\n`;
  ({ KERNEL_ANSWERED_REFUSALS } = await import('../safety-kernel/src/errors.js'));
  ({ REFUSED_BEFORE_ANY_ORDER } = await import('../safety-kernel/src/upstreamRefusal.js'));
  keys = await fx.mintKeys();
  door = fx.bootDoor({ port: 5681, keys, env: { AGENT_CHECKOUT_UCP_TOOL_DOOR_ENABLED: '1' } });
  await door.listen();
});
test.after(async () => {
  if (door) await door.close();
  fs.readFileSync = realRead;
  syncBuiltinESMExports();
});

let seq = 0;
const freshKey = () => { seq += 1; return `idem-delist-${String(seq).padStart(5, '0')}`; };
const buyerFor = (n) => ({ 'X-Test-User-Ref': 'buyer-0001', 'X-Test-Acp-Session-Id': `sess-dl-${String(n).padStart(5, '0')}` });
const UCP_AGENT = Object.freeze({ 'ucp-agent': { profile: 'https://agent.example/profile' } });
const destination = (m) => ({ methods: [{ destinations: [{ first_name: 'Buyer', last_name: 'One', street_address: '1 Example Road', address_locality: 'Exampleton', postal_code: '00001', address_country: m }] }] });
const items = [{ product_id: IDS.PRODUCT, variant_id: IDS.VARIANT, quantity: 1 }];
const sent = (r) => r.upstream.filter((c) => c.path === ORDERS).length;

/** A session, and an attempt function `(key) => { code, message, recovery, raw, orders }` for that door. */
async function opened(caller, market) {
  seq += 1;
  const buyer = buyerFor(seq);
  if (caller === 'acp_complete') {
    const r = await door.acp('POST', '/checkout_sessions', { merchant_id: IDS.SELLER, items, fulfillment_address: fx.address(market) }, { key: freshKey() });
    assert.equal(r.http, 201, r.raw.slice(0, 300));
    const token = await keys.mintGrant({ sessionId: r.body.id, currency: r.body.currency, maxAmount: r.body.totals.total });
    return async (key) => {
      const a = await door.acp('POST', `/checkout_sessions/${r.body.id}/complete`, { payment_data: { method: 'acp_delegated_token', token } }, { key });
      return { http: a.http, code: a.body && a.body.code, message: a.body && a.body.message, raw: a.raw, orders: sent(a) };
    };
  }
  if (caller === 'invoke') {
    const q = await door.invoke('preview_quote', { quote: { merchant_id: IDS.SELLER, items, customer_email: 'buyer@example.test', shipping_address: fx.address(market) } }, { buyer });
    assert.equal(q.http, 200, q.raw.slice(0, 300));
    return async (key) => {
      const a = await door.invoke('create_order', { idempotency_key: key, order: { quote_id: q.body.quote_id, customer_email: 'buyer@example.test', shipping_address: { ...fx.address(market), recipient_name: 'Buyer One' } } }, { buyer });
      return { http: a.http, code: a.body.code, message: a.body.message, recovery: a.body.recovery, raw: a.raw, orders: sent(a) };
    };
  }
  const ucp = caller === 'ucp_complete';
  const created = ucp
    ? await door.call('create_checkout', { meta: { ...UCP_AGENT, 'idempotency-key': freshKey() }, checkout: { line_items: [{ item: { id: IDS.PRODUCT }, quantity: 1 }], buyer: { email: 'buyer@example.test' }, fulfillment: destination(market) } }, { buyer, door: '/ucp/mcp' })
    : await door.call('create_checkout_session', { idempotency_key: freshKey(), quote: { merchant_id: IDS.SELLER, items, customer_email: 'buyer@example.test', shipping_address: fx.address(market) } }, { buyer });
  assert.equal(created.isError, false, created.raw.slice(0, 300));
  const id = created.value.session_id || created.value.id;
  const token = await keys.mintGrant({ sessionId: id, currency: created.value.currency, maxAmount: fx.UNIT_MINOR });
  return async (key) => {
    const a = ucp
      ? await door.call('complete_checkout', { meta: { ...UCP_AGENT, 'idempotency-key': key }, id, checkout: { payment: { method: 'ucp_handler', token } } }, { buyer, door: '/ucp/mcp' })
      : caller === 'mcp_complete'
        ? await door.call('complete_checkout_session', { idempotency_key: key, session_id: id, payment_authorization: { method: 'acp_delegated_token', token } }, { buyer })
        : await door.call('create_payment_link', { idempotency_key: key, session_id: id, customer_email: 'buyer@example.test' }, { buyer });
    const e = (a.value && a.value.error) || {};
    return { http: a.http, code: e.code, message: e.message, recovery: e.recovery, detail: e.detail, raw: a.raw, orders: sent(a) };
  };
}

test('the scan finds every listed pair whose answer says nothing happened, and this gateway holds the list without them', () => {
  const found = NO_EFFECT_PAIRS.map(([s, c]) => `${s} ${c}`).sort();
  for (const pair of ['400 INVALID_BUYER_CONTEXT', '403 MERCHANT_NOT_ACCEPTING_ORDERS', '409 PARTNER_ASSERTION_REJECTED']) assert.ok(found.includes(pair), `${pair} in ${JSON.stringify(found)}`);
  for (const [status, code] of NO_EFFECT_PAIRS) assert.equal((REFUSED_BEFORE_ANY_ORDER[status] || []).includes(code), false, `${status} ${code} delisted`);
  // Every other pair is still listed.
  assert.equal(Object.values(REFUSED_BEFORE_ANY_ORDER).flat().length, SHIPPED.length - NO_EFFECT_PAIRS.length);
});

test('delisted: every no-effect refusal, with the order landed behind it, is the unknown outcome on every door, in the refused words and never a no-effect sentence; the claim is kept and no second order call is made', async () => {
  const refused = KERNEL_ANSWERED_REFUSALS.refused;
  for (const [status, code, answerName] of NO_EFFECT_PAIRS) {
    for (const caller of CALLERS) {
      for (const market of ['US', 'SG', 'GB']) {
        const label = `${status} ${code} ${caller} ${market}`;
        const attempt = await opened(caller, market);
        const made = door.orders.length;
        door.orderScript.push(ANSWERS[answerName]({ landed: true }));
        const key = freshKey();
        const first = await attempt(key);
        assert.equal(first.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${label}: ${first.raw.slice(0, 300)}`);
        assert.equal(NO_EFFECT.test(first.raw), false, `${label}: ${first.raw.slice(0, 300)}`);
        assert.equal(/not taking orders|no readable answer|may have been accepted|could not confirm the account/i.test(first.raw), false, `${label}: ${first.raw.slice(0, 300)}`);
        assert.equal(first.orders, 1, label);
        assert.equal(door.orders.length, made + 1, `${label}: the order exists`);
        if (caller === 'acp_complete') {
          assert.deepEqual([first.http, first.message], [409, refused.message], label);
        } else if (caller === 'invoke') {
          assert.deepEqual([first.http, first.message, first.recovery], [409, refused.message, refused.recovery], label);
        } else {
          assert.deepEqual([first.message, first.recovery, first.detail], [`${refused.message} Sending this call again with the same idempotency_key returns this same answer.`, refused.recovery, { reason: 'order_create_outcome_unknown', order_id: null }], label);
        }
        // Kept: the same key is told the same, another key the used session, and no order call follows.
        const same = await attempt(key);
        assert.equal(same.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${label} same key: ${same.raw.slice(0, 300)}`);
        if (caller !== 'acp_complete') assert.equal(same.raw, first.raw, `${label}: byte for byte`);
        const other = await attempt(freshKey());
        assert.equal(other.code, 'QUOTE_ALREADY_USED', `${label} another key: ${other.raw.slice(0, 300)}`);
        assert.equal(NO_EFFECT.test(other.raw), false, `${label} another key: ${other.raw.slice(0, 300)}`);
        assert.equal(same.orders + other.orders, 0, `${label}: no second order call`);
        assert.equal(door.orders.length, made + 1, label);
      }
    }
  }
});

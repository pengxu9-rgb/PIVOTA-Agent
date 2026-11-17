'use strict';

// A SELLER NOT TAKING ORDERS, WITH THE PAIR TAKEN OFF THE LIST, through the real doors over HTTP.
//
// "Nothing was ordered" (MERCHANT_NOT_ACCEPTING_ORDERS) may be said only on the quote-claim release rule's own proof
// (safety-kernel/src/upstreamRefusal.js): the pair [403, MERCHANT_NOT_ACCEPTING_ORDERS] is on the shared list, the
// route named the code, and no deadline mark. The day the upstream finds its merchant check can follow a write, it
// takes the pair off the list in both repositories. This boots a gateway whose list is exactly that (the shipped list
// without the 403 pair) and pins what every door must then say: the kernel's unknown outcome, in the store-refused
// words, never "nothing was ordered", with the claim kept: the same key is told the same, another key the used session,
// and no second order call is ever made.
//
// The delisting is done in this process only, by answering the list file's read with the shorter list before the
// gateway loads the kernel; nothing on disk changes. Every name is a placeholder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const LIST_FILE = path.join(__dirname, '../safety-kernel/contracts/order_create_prologue_refusals.json');
const SHIPPED = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
const DELISTED = SHIPPED.filter(([status, code]) => !(status === 403 && code === 'MERCHANT_NOT_ACCEPTING_ORDERS'));
const DELISTED_TEXT = `[\n${DELISTED.map(([status, code]) => `  [${status}, ${JSON.stringify(code)}]`).join(',\n')}\n]\n`;
const realRead = fs.readFileSync;
fs.readFileSync = function readFileSync(file, ...rest) {
  if (String(file instanceof URL ? file.pathname : file) === LIST_FILE) return typeof rest[0] === 'string' || rest[0]?.encoding ? DELISTED_TEXT : Buffer.from(DELISTED_TEXT);
  return realRead.call(this, file, ...rest);
};
syncBuiltinESMExports();

const fx = require('./_support/quoteClaimReleaseDoor.cjs');

const { IDS, ANSWERS } = fx;
const ORDERS = '/agent/v2/orders';
let door;
let keys;
let KERNEL_ANSWERED_REFUSALS;
let REFUSED_BEFORE_ANY_ORDER;

test.before(async () => {
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

test('the gateway in this process holds the shipped list without the 403 pair', () => {
  assert.equal(Object.hasOwn(REFUSED_BEFORE_ANY_ORDER, 403), false);
  assert.equal(DELISTED.length, SHIPPED.length - 1);
});

test('delisted: a seller not taking orders is the unknown outcome on every door, in the store-refused words, never "nothing was ordered"; the claim is kept and no second order call is made', async () => {
  const refused = KERNEL_ANSWERED_REFUSALS.refused;
  for (const caller of ['mcp_complete', 'mcp_payment_link', 'ucp_complete', 'acp_complete', 'invoke']) {
    for (const market of ['US', 'SG', 'GB']) {
      const label = `${caller} ${market}`;
      const attempt = await opened(caller, market);
      door.orderScript.push(ANSWERS.merchantNotAccepting());
      const key = freshKey();
      const first = await attempt(key);
      assert.equal(first.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${label}: ${first.raw.slice(0, 300)}`);
      assert.equal(/nothing was ordered|not taking orders|no readable answer|may have been accepted/i.test(first.raw), false, `${label}: ${first.raw.slice(0, 300)}`);
      assert.equal(first.orders, 1, label);
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
      assert.equal(same.orders + other.orders, 0, `${label}: no second order call`);
    }
  }
});

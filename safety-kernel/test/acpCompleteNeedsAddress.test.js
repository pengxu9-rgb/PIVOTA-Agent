// A completion with no address to ship to is refused by name before the order (canonicalExecutor.js,
// completionRequiresFulfillmentAddress; buyerIntake.js, fulfillmentAddressRequiredRefusal). At the adapter and the
// executor, on the VERIFIED payment lane (the door suite, tests/acp_complete_needs_address_door.node.test.cjs,
// completes on the delegated-token lane), with an upstream that records every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import { InMemoryKvStore } from '../src/stores.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { createAcpRestAdapter } from '../src/protocol/acpRestAdapter.js';
import { fulfillmentAddressRequiredRefusal, surfaceableIntakeRefusal, REQUIRED_ADDRESS_FIELDS } from '../src/protocol/buyerIntake.js';
import { ERROR_CATALOG } from '../src/errors.js';
import { marketCurrencyOf } from './helpers/marketCurrency.js';

const SECRET = 'acp-signing-secret-0123456789abcdef';
const KSECRET = 'acp-kernel-secret-0123456789abcdef';
const FIXED_NOW = 1_900_000_000_000;
const quiet = { info() {}, warn() {}, error() {} };
const REASON = 'acp_fulfillment_address_required';
const HINT = 'POST /checkout_sessions/{checkout_session_id}';
const ADDRESS = { name: 'Example Buyer', address_line1: '1 Example Street', city: 'Springfield', postal_code: '00000', country: 'US' };

function setup() {
  const calls = [];
  const verified = [];
  const kernelUpstream = async (op, payload) => {
    calls.push({ op, payload: structuredClone(payload) });
    if (op === 'preview_quote') {
      return { quote_id: `uq_${calls.length}`, merchant_of_record: 'merch_A', currency: 'USD', locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [], acp_state: {} };
    }
    if (op === 'create_order') return { order_id: `o_${calls.length}`, acp_state: {} };
    if (op === 'submit_payment') return { order_id: payload.order_id, payment_id: 'pay1', payment_status: 'succeeded' };
    return {};
  };
  const verifyPaymentAuthorization = async (_a, bound) => { verified.push(bound); return { ok: true, amount: bound.amount, currency: bound.currency, user_ref: bound.user_ref }; };
  const kernel = new SafetyKernel({ upstream: kernelUpstream, secret: KSECRET, log: quiet, now: () => FIXED_NOW });
  const executor = createCanonicalExecutor({ kernel, upstream: async () => ({}), verifyPaymentAuthorization });
  const store = new InMemoryKvStore({ now: () => FIXED_NOW });
  const adapter = createAcpRestAdapter({
    executor, sessionStore: store, signingSecret: SECRET,
    resolveUserRef: async () => ({ user_ref: 'buyer_1', customer_email: 'buyer@example.test' }), marketCurrencyOf, now: () => FIXED_NOW,
  });
  const ops = (op) => calls.filter((c) => c.op === op);
  const moneyTouched = () => [verified.length, ops('create_order').length, ops('submit_payment').length];
  return { adapter, executor, kernel, store, ops, verified, moneyTouched };
}
let keys = 0;
function req({ body, id, key } = {}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(FIXED_NOW);
  keys += 1;
  return {
    headers: { timestamp, signature: createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex'), 'idempotency-key': key || `idem-acp-address-${String(keys).padStart(4, '0')}` },
    rawBody, body, params: id ? { checkout_session_id: id } : {},
  };
}
const cart = (address, quantity = 1) => ({ merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity }], ...(address ? { fulfillment_address: address } : {}) });
const completion = (address) => ({ payment_data: { token: 'tok_1' }, ...(address ? { fulfillment_address: address } : {}) });
function assertAddressRequired(answer) {
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.code, 'QUOTE_REQUIRED');
  assert.deepEqual(answer.body.detail, { reason: REASON, missing_fields: [...REQUIRED_ADDRESS_FIELDS], required_fields: [...REQUIRED_ADDRESS_FIELDS] });
}

test('the refusal: QUOTE_REQUIRED, not retriable, naming the missing fields and both places an address can be supplied', () => {
  const err = fulfillmentAddressRequiredRefusal(undefined, { updateHint: HINT });
  assert.equal(err.code, 'QUOTE_REQUIRED');
  assert.equal(ERROR_CATALOG[err.code].retriable, false);
  const { message, detail } = surfaceableIntakeRefusal(err);
  assert.deepEqual(detail, { reason: REASON, missing_fields: [...REQUIRED_ADDRESS_FIELDS], required_fields: [...REQUIRED_ADDRESS_FIELDS] });
  for (const part of [HINT, 'with this completion request', 'same Idempotency-Key', 'Nothing was charged and no order was created', '(`name` may be given as `recipient_name`.)']) assert.ok(message.includes(part), part);
  // A complete address is no refusal; `recipient_name` stands for `name`; what is missing is named, never a value.
  assert.equal(fulfillmentAddressRequiredRefusal(ADDRESS), null);
  const { name: _n, ...unnamed } = ADDRESS;
  assert.equal(fulfillmentAddressRequiredRefusal({ ...unnamed, recipient_name: 'Example Buyer' }), null);
  const partial = surfaceableIntakeRefusal(fulfillmentAddressRequiredRefusal({ city: 'Springfield', country: 'US' }));
  assert.deepEqual(partial.detail.missing_fields, ['name', 'address_line1', 'postal_code']);
  assert.equal(JSON.stringify(partial).includes('Springfield'), false);
  for (const nothing of [null, '', 7, [], {}]) assert.deepEqual(surfaceableIntakeRefusal(fulfillmentAddressRequiredRefusal(nothing)).detail.missing_fields, [...REQUIRED_ADDRESS_FIELDS]);
});

test('verified lane: no address anywhere is refused before the verifier, the order and the charge; the same key then completes', async () => {
  const door = setup();
  const id = (await door.adapter.createCheckoutSession(req({ body: cart() }))).body.id;
  const key = 'idem-acp-address-same-key';
  assertAddressRequired(await door.adapter.completeCheckoutSession(req({ id, key, body: completion() })));
  assertAddressRequired(await door.adapter.completeCheckoutSession(req({ id, key, body: completion() })));
  assert.deepEqual(door.moneyTouched(), [0, 0, 0], 'no authorization presented, no order, no charge');
  assert.equal(await door.kernel.isQuoteClaimed((await door.store.get(id)).quote_id), false, 'the session\'s quote is not spent');
  const paid = await door.adapter.completeCheckoutSession(req({ id, key, body: completion(ADDRESS) }));
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.deepEqual(door.moneyTouched(), [1, 1, 1]);
  assert.equal(door.ops('create_order')[0].payload.order.shipping_address.country, 'US');
});
test('verified lane: a session with an address completes with none on the completion; one that dropped it is refused', async () => {
  const kept = setup();
  const id = (await kept.adapter.createCheckoutSession(req({ body: cart(ADDRESS) }))).body.id;
  assert.equal((await kept.adapter.completeCheckoutSession(req({ id, body: completion() }))).status, 200);
  assert.deepEqual(kept.moneyTouched(), [1, 1, 1]);

  const dropped = setup();
  const other = (await dropped.adapter.createCheckoutSession(req({ body: cart(ADDRESS) }))).body.id;
  assert.equal((await dropped.adapter.updateCheckoutSession(req({ id: other, body: cart(undefined, 2) }))).status, 200);
  assertAddressRequired(await dropped.adapter.completeCheckoutSession(req({ id: other, body: completion() })));
  assert.deepEqual(dropped.moneyTouched(), [0, 0, 0]);
  assert.equal((await dropped.adapter.completeCheckoutSession(req({ id: other, body: completion(ADDRESS) }))).status, 200);
});

test('the executor reads the statement only on a call the ACP door built: any other door\'s completion is as it was', async () => {
  const QUOTE = { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test' };
  for (const [ctx, flag, refused] of [
    [{ user_ref: 'u1', acp_session_id: 's1', protocol: 'acp' }, HINT, true],
    [{ user_ref: 'u1', acp_session_id: 's1', protocol: 'acp' }, undefined, false],
    [{ user_ref: 'u1', acp_session_id: 's1', protocol: 'acp' }, true, false],
    [{ user_ref: 'u1', acp_session_id: 's1', protocol: 'acp' }, '  ', false],
    [{ user_ref: 'u1', acp_session_id: 's1' }, HINT, false],
    [{ user_ref: 'u1', acp_session_id: 's1', protocol: 'mcp' }, HINT, false],
  ]) {
    const { executor, moneyTouched } = setup();
    const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-exec-address-01', quote: QUOTE }, ctx);
    const run = executor.execute('complete_checkout_session', { idempotency_key: 'idem-exec-address-02', session_id: session.session_id, payment_authorization: { token: 'tok_1' }, ...(flag === undefined ? {} : { fulfillment_address_required: flag }) }, ctx);
    if (refused) {
      const err = await run.then(() => assert.fail('expected a refusal'), (e) => e);
      assert.equal(surfaceableIntakeRefusal(err).detail.reason, REASON);
      assert.deepEqual(moneyTouched(), [0, 0, 0]);
    } else {
      // As before this rule: the completion goes on to the order lane (this stub upstream accepts it).
      await run;
      assert.deepEqual(moneyTouched(), [1, 1, 1]);
    }
  }
});

test('the address the order would be created with is the quote\'s completed by the request\'s: either one is enough', async () => {
  const QUOTE = { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test' };
  const ctx = { user_ref: 'u1', acp_session_id: 's1', protocol: 'acp' };
  for (const [onQuote, onRequest, missing] of [
    [ADDRESS, undefined, null], [undefined, ADDRESS, null], [undefined, undefined, [...REQUIRED_ADDRESS_FIELDS]],
    [undefined, { city: 'Springfield', country: 'US' }, ['name', 'address_line1', 'postal_code']],
  ]) {
    const { executor, moneyTouched } = setup();
    const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-exec-address-03', quote: { ...QUOTE, ...(onQuote ? { shipping_address: onQuote } : {}) } }, ctx);
    const run = executor.execute('complete_checkout_session', { idempotency_key: 'idem-exec-address-04', session_id: session.session_id, payment_authorization: { token: 'tok_1' }, fulfillment_address_required: HINT, ...(onRequest ? { shipping_address: onRequest } : {}) }, ctx);
    if (missing) {
      const err = await run.then(() => assert.fail('expected a refusal'), (e) => e);
      assert.deepEqual(surfaceableIntakeRefusal(err).detail.missing_fields, missing);
      assert.deepEqual(moneyTouched(), [0, 0, 0]);
    } else {
      await run;
      assert.deepEqual(moneyTouched(), [1, 1, 1]);
    }
  }
});

test('one address, computed once: what the door judges is what the order is created with', async () => {
  const { effectiveShippingAddress } = await import('../src/kernel.js');
  // The locked address wins field by field, and each side is normalised first: an empty locked field does not
  // hide the request's, and `name` / `recipient_name` stand for each other.
  assert.equal(effectiveShippingAddress(undefined, undefined), undefined);
  assert.equal(effectiveShippingAddress({}, {}), undefined);
  assert.equal(effectiveShippingAddress('x', 7), undefined);
  const { name: _n, ...unnamed } = ADDRESS;
  assert.deepEqual(effectiveShippingAddress({ ...unnamed, recipient_name: 'Example Buyer' }, undefined), { ...ADDRESS, recipient_name: 'Example Buyer' });
  assert.deepEqual(effectiveShippingAddress({ city: 'Lockedtown', postal_code: '' }, ADDRESS), { ...ADDRESS, recipient_name: 'Example Buyer', city: 'Lockedtown' });
  // Through the door: a quote whose address has an empty field, completed by the request's. The order is created
  // with exactly the address the completion was let through for.
  const QUOTE = { merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test' };
  const ctx = { user_ref: 'u1', acp_session_id: 's1', protocol: 'acp' };
  const { executor, ops } = setup();
  const session = await executor.execute('create_checkout_session', { idempotency_key: 'idem-exec-address-05', quote: { ...QUOTE, shipping_address: { ...ADDRESS, postal_code: '' } } }, ctx);
  const complete = (shipping_address) => executor.execute('complete_checkout_session', { idempotency_key: 'idem-exec-address-06', session_id: session.session_id, payment_authorization: { token: 'tok_1' }, fulfillment_address_required: HINT, shipping_address }, ctx);
  const err = await complete(undefined).then(() => assert.fail('expected a refusal'), (e) => e);
  assert.deepEqual(surfaceableIntakeRefusal(err).detail.missing_fields, ['postal_code']);
  await complete({ postal_code: '11111', city: 'Requestville' });
  const sent = ops('create_order')[0].payload.order.shipping_address;
  assert.equal(sent.postal_code, '11111', 'the request filled what the quote left empty');
  assert.equal(sent.city, 'Springfield', 'and the quote\'s own field won');
  assert.equal(fulfillmentAddressRequiredRefusal(sent), null);
});

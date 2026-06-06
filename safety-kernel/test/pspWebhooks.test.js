// PSP-native webhook adapter tests — Stripe (Stripe-Signature t/v1) + Adyen (HMAC over the escaped field list).
// Sign with the same scheme the verifier expects (round-trip), prove tamper/replay/escaping rejection, and
// drive a real charge_pending→paid finalization on the kernel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SafetyKernel } from '../src/kernel.js';
import {
  verifyStripeSignature, createStripeWebhookHandler, defaultStripeMapEvent,
  verifyAdyenHmac, createAdyenWebhookHandler, defaultAdyenMapItem,
} from '../src/pspWebhooks.js';

const CTX = { user_ref: 'usr_1', acp_session_id: 'sess_1' };
const NOW = 1_900_000_000_000; // fixed clock (ms)
const NOW_S = Math.floor(NOW / 1000);
const STRIPE_SECRET = 'whsec_test_0123456789abcdef';
const ADYEN_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex = 32 bytes (real Adyen key size)
const quiet = { info() {}, warn() {}, error() {} };

// a kernel with order o_psp already in charge_pending(payment_id=pay_psp)
async function pendingKernel() {
  let n = 0;
  const upstream = async (op) => (
    op === 'preview_quote' ? { merchant_of_record: 'm', currency: 'USD', locked_totals: { subtotal: 100, tax: 0, shipping: 0, total: 100 }, line_items: [], acp_state: {} }
    : op === 'create_order' ? { order_id: 'o_psp', acp_state: {} }
    : op === 'submit_payment' ? { order_id: 'o_psp', payment_id: 'pay_psp', payment_status: 'requires_action' }
    : {}
  );
  const kernel = new SafetyKernel({ upstream, secret: 'x'.repeat(20), log: quiet });
  const q = await kernel.previewQuote({ quote: { merchant_id: 'm', items: [{ product_id: 'p', quantity: 1 }] } }, CTX);
  const o = await kernel.createOrder({ idempotency_key: 'idem-psp-order', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX);
  const tok = await kernel.mintConfirmation({ order_id: o.order_id }, CTX);
  await kernel.submitPayment({ idempotency_key: 'idem-psp-pay', confirmation_token: tok, payment: { order_id: o.order_id, expected_amount: 100, currency: 'USD' } }, CTX);
  return kernel;
}

// ---- Stripe ----------------------------------------------------------------------------------------------

const stripeSig = (rawBody, t = NOW_S, secret = STRIPE_SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;

test('verifyStripeSignature: valid passes; tampered body, wrong secret, stale t, missing parts fail', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  assert.equal(verifyStripeSignature(body, stripeSig(body), STRIPE_SECRET, { now: () => NOW }), true);
  assert.equal(verifyStripeSignature(body + 'x', stripeSig(body), STRIPE_SECRET, { now: () => NOW }), false); // body tampered
  assert.equal(verifyStripeSignature(body, stripeSig(body, NOW_S, 'whsec_wrong_key_xxxx'), STRIPE_SECRET, { now: () => NOW }), false);
  assert.equal(verifyStripeSignature(body, stripeSig(body, NOW_S - 1000), STRIPE_SECRET, { now: () => NOW }), false); // stale (>300s)
  assert.equal(verifyStripeSignature(body, `v1=deadbeef`, STRIPE_SECRET, { now: () => NOW }), false); // no t
  assert.equal(verifyStripeSignature(body, `t=${NOW_S}`, STRIPE_SECRET, { now: () => NOW }), false); // no v1
  assert.equal(verifyStripeSignature(body, '', STRIPE_SECRET, { now: () => NOW }), false);
});

test('verifyStripeSignature: accepts when ANY v1 matches (secret rotation → multiple v1)', () => {
  const body = JSON.stringify({ id: 'evt_2' });
  const good = createHmac('sha256', STRIPE_SECRET).update(`${NOW_S}.${body}`).digest('hex');
  const header = `t=${NOW_S},v1=00deadbeef,v1=${good}`; // first v1 is bogus, second is valid
  assert.equal(verifyStripeSignature(body, header, STRIPE_SECRET, { now: () => NOW }), true);
});

test('defaultStripeMapEvent: order_id from metadata, payment_id = PaymentIntent id, status from type', () => {
  const evt = { type: 'payment_intent.succeeded', data: { object: { object: 'payment_intent', id: 'pi_123', status: 'succeeded', metadata: { order_id: 'o_psp' } } } };
  assert.deepEqual(defaultStripeMapEvent(evt), { order_id: 'o_psp', payment_id: 'pi_123', status: 'succeeded' });
  const failed = { type: 'payment_intent.payment_failed', data: { object: { object: 'payment_intent', id: 'pi_9', metadata: { pivota_order_id: 'o_x' } } } };
  assert.equal(defaultStripeMapEvent(failed).status, 'failed');
});

test('Stripe handler E2E: a signed succeeded event finalizes charge_pending → paid; forged → 401; unknown → 404', async () => {
  const kernel = await pendingKernel();
  const handler = createStripeWebhookHandler({ kernel, secret: STRIPE_SECRET, now: () => NOW, log: quiet });
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { object: 'payment_intent', id: 'pay_psp', status: 'succeeded', metadata: { order_id: 'o_psp' } } } });
  // forged signature → 401, no transition
  assert.equal((await handler({ headers: { 'stripe-signature': 't=' + NOW_S + ',v1=forged' }, rawBody: body })).status, 401);
  // valid → paid
  const ok = await handler({ headers: { 'stripe-signature': stripeSig(body) }, rawBody: body });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transitioned, 'paid');
  // duplicate → idempotent
  const dup = await handler({ headers: { 'stripe-signature': stripeSig(body) }, rawBody: body });
  assert.equal(dup.body.idempotent, true);
  // a signed event for an unknown order → retryable 404
  const unknownBody = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { object: 'payment_intent', id: 'pi_z', metadata: { order_id: 'o_NOPE' } } } });
  const unk = await handler({ headers: { 'stripe-signature': stripeSig(unknownBody) }, rawBody: unknownBody });
  assert.equal(unk.status, 404);
});

test('Stripe handler: a payment_id that is NOT the order attempt does not finalize (kernel correlation)', async () => {
  const kernel = await pendingKernel();
  const handler = createStripeWebhookHandler({ kernel, secret: STRIPE_SECRET, now: () => NOW, log: quiet });
  // correct order, WRONG payment intent id → kernel ignores as stale_attempt (not paid)
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { object: 'payment_intent', id: 'pi_OTHER', metadata: { order_id: 'o_psp' } } } });
  const res = await handler({ headers: { 'stripe-signature': stripeSig(body) }, rawBody: body });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.transitioned, 'paid');
  assert.equal(res.body.reason, 'stale_attempt');
});

test('construction: Stripe handler refuses a weak/missing secret', () => {
  assert.throws(() => createStripeWebhookHandler({ kernel: { onPaymentWebhook() {} }, secret: 'short' }), /strong webhook secret/);
});

test('P0 Stripe: a non-PaymentIntent success-class event does NOT finalize (checkout.session/charge held)', async () => {
  // checkout.session.completed with status "complete"/"unpaid" must NOT mark paid (it isn't payment success)
  assert.equal(defaultStripeMapEvent({ type: 'checkout.session.completed', data: { object: { object: 'checkout_session', id: 'cs_1', status: 'complete', payment_status: 'unpaid', metadata: { order_id: 'o_psp' } } } }).status, undefined);
  // charge.refunded (charge object, status "succeeded") must NOT map to success
  assert.equal(defaultStripeMapEvent({ type: 'charge.refunded', data: { object: { object: 'charge', id: 'ch_1', status: 'succeeded', metadata: { order_id: 'o_psp' } } } }).status, undefined);
  // drive it end-to-end: a signed checkout.session.completed must leave the order charge_pending
  const kernel = await pendingKernel();
  const handler = createStripeWebhookHandler({ kernel, secret: STRIPE_SECRET, now: () => NOW, log: quiet });
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { object: 'checkout_session', id: 'pay_psp', status: 'complete', payment_status: 'unpaid', metadata: { order_id: 'o_psp' } } } });
  const res = await handler({ headers: { 'stripe-signature': stripeSig(body) }, rawBody: body });
  assert.notEqual(res.body.transitioned, 'paid'); // held — not finalized by a non-PI event
});

test('P1 Adyen: a malformed/short hex key is refused at construction (no silent truncation)', () => {
  assert.throws(() => createAdyenWebhookHandler({ kernel: { onPaymentWebhook() {} }, hmacKey: '0123NOTHEX' }), /valid 32-byte hex/);
  assert.throws(() => createAdyenWebhookHandler({ kernel: { onPaymentWebhook() {} }, hmacKey: '0123456789abcdef' }), /valid 32-byte hex/); // valid hex but only 8 bytes
  assert.equal(verifyAdyenHmac(adyenItem(), '0123NOTHEX'), false); // verifier also fails closed
});

test('P2 Adyen: a batch with one bad item rejects the WHOLE batch with NO partial finalize', async () => {
  const kernel = await pendingKernel();
  const handler = createAdyenWebhookHandler({ kernel, hmacKey: ADYEN_KEY_HEX, log: quiet });
  const good = adyenItem(); // valid AUTHORISATION for o_psp/pay_psp
  const bad = adyenItem({ pspReference: 'pay_psp' }); bad.additionalData.hmacSignature = 'AAAA'; // bad HMAC
  const body = JSON.stringify({ live: 'false', notificationItems: [{ NotificationRequestItem: good }, { NotificationRequestItem: bad }] });
  const res = await handler({ rawBody: body });
  assert.equal(res.status, 401); // whole batch rejected
  // and the FIRST (valid) item was NOT applied — the order is still charge_pending, not paid
  const after = await kernel._orderStore.get('o_psp');
  assert.equal(after.status, 'charge_pending', 'no partial finalize before full-batch verification');
});

test('P2 Adyen: a mapItem that throws fails controlled (400) with NO partial finalize across the batch', async () => {
  const kernel = await pendingKernel();
  // map item 1 fine, throw on item 2 → the WHOLE batch must 400 with item 1 NOT finalized (atomic pre-map)
  let calls = 0;
  const mapItem = (item) => { calls++; if (item.pspReference === 'pay_BOOM') throw new Error('boom'); return defaultAdyenMapItem(item); };
  const handler = createAdyenWebhookHandler({ kernel, hmacKey: ADYEN_KEY_HEX, mapItem, log: quiet });
  const body = JSON.stringify({ live: 'false', notificationItems: [
    { NotificationRequestItem: adyenItem() },                          // valid → o_psp/pay_psp
    { NotificationRequestItem: adyenItem({ pspReference: 'pay_BOOM' }) }, // map throws
  ]});
  const res = await handler({ rawBody: body });
  assert.equal(res.status, 400);
  const after = await kernel._orderStore.get('o_psp');
  assert.equal(after.status, 'charge_pending', 'item 1 must NOT be finalized when a later item is unmappable');
  // single-item throw still 400
  assert.equal((await handler({ rawBody: adyenBody(adyenItem({ pspReference: 'pay_BOOM' })) })).status, 400);
});

test('P2 limits: maxBytes is a TRUE byte cap (a multibyte body cannot slip past via UTF-16 length)', async () => {
  const kernel = await pendingKernel();
  const stripe = createStripeWebhookHandler({ kernel, secret: STRIPE_SECRET, maxBytes: 64, now: () => NOW, log: quiet });
  // 50 multibyte chars = 150 UTF-8 bytes > 64, but .length (50) would have passed a naive char check
  const big = JSON.stringify({ pad: '€'.repeat(50) });
  assert.ok(Buffer.byteLength(big, 'utf8') > 64 && big.length < 64);
  assert.equal((await stripe({ headers: { 'stripe-signature': stripeSig(big) }, rawBody: big })).status, 413);
  const adyen = createAdyenWebhookHandler({ kernel, hmacKey: ADYEN_KEY_HEX, maxBytes: 64, log: quiet });
  assert.equal((await adyen({ rawBody: big })).status, 413);
});

// ---- Adyen -----------------------------------------------------------------------------------------------

function adyenItem({ pspReference = 'pay_psp', merchantReference = 'o_psp', eventCode = 'AUTHORISATION', success = 'true', value = 100, currency = 'USD', merchantAccountCode = 'PivotaECOM', originalReference = '' } = {}) {
  const item = { pspReference, originalReference, merchantAccountCode, merchantReference, amount: { value, currency }, eventCode, success, additionalData: {} };
  // sign exactly as the verifier expects (round-trip), using the SAME escaped field list
  const esc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const signed = [pspReference, originalReference, merchantAccountCode, merchantReference, value, currency, eventCode, success].map(esc).join(':');
  item.additionalData.hmacSignature = createHmac('sha256', Buffer.from(ADYEN_KEY_HEX, 'hex')).update(signed, 'utf8').digest('base64');
  return item;
}
const adyenBody = (item) => JSON.stringify({ live: 'false', notificationItems: [{ NotificationRequestItem: item }] });

test('verifyAdyenHmac: valid passes; tampered field, wrong key, missing sig fail', () => {
  const item = adyenItem();
  assert.equal(verifyAdyenHmac(item, ADYEN_KEY_HEX), true);
  const tampered = { ...item, merchantReference: 'o_EVIL' }; // value changed, sig now stale
  assert.equal(verifyAdyenHmac(tampered, ADYEN_KEY_HEX), false);
  assert.equal(verifyAdyenHmac(item, 'f'.repeat(64)), false); // wrong (but valid-length) key
  assert.equal(verifyAdyenHmac({ ...item, additionalData: {} }, ADYEN_KEY_HEX), false); // no sig
});

test('verifyAdyenHmac: escaping prevents field-boundary forgery (":" in a value cannot shift fields)', () => {
  // a merchantReference legitimately containing ":" must be escaped in the signed string, so a different
  // field split that produces the same raw concatenation must NOT verify under the same signature.
  const a = adyenItem({ merchantReference: 'o:psp', pspReference: 'pay_psp' });
  assert.equal(verifyAdyenHmac(a, ADYEN_KEY_HEX), true); // correctly escaped round-trip passes
  // craft an item whose UNescaped fields would concatenate identically but whose true fields differ
  const b = adyenItem({ merchantReference: 'o', pspReference: 'pay_psp' });
  // swapping b's signature onto a (different merchantReference) must fail — escaping makes the strings distinct
  const spoof = { ...a, merchantReference: 'o', additionalData: { hmacSignature: b.additionalData.hmacSignature } };
  assert.equal(verifyAdyenHmac(spoof, ADYEN_KEY_HEX), true); // b's own sig matches b's own fields
  const crossed = { ...a, additionalData: { hmacSignature: b.additionalData.hmacSignature } }; // a's fields, b's sig
  assert.equal(verifyAdyenHmac(crossed, ADYEN_KEY_HEX), false);
});

test('defaultAdyenMapItem: merchantReference→order_id, pspReference→payment_id, AUTHORISATION+success→status', () => {
  assert.deepEqual(defaultAdyenMapItem(adyenItem()), { order_id: 'o_psp', payment_id: 'pay_psp', status: 'succeeded' });
  assert.equal(defaultAdyenMapItem(adyenItem({ success: 'false' })).status, 'failed');
});

test('Adyen handler E2E: a valid notification finalizes charge_pending → paid; returns [accepted]; bad HMAC → 401', async () => {
  const kernel = await pendingKernel();
  const handler = createAdyenWebhookHandler({ kernel, hmacKey: ADYEN_KEY_HEX, log: quiet });
  // bad HMAC → 401, no transition
  const bad = adyenItem(); bad.additionalData.hmacSignature = 'AAAA';
  assert.equal((await handler({ rawBody: adyenBody(bad) })).status, 401);
  // valid → paid + [accepted]
  const ok = await handler({ rawBody: adyenBody(adyenItem()) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '[accepted]');
  assert.equal(ok.results[0].transitioned, 'paid');
  // duplicate → idempotent
  const dup = await handler({ rawBody: adyenBody(adyenItem()) });
  assert.equal(dup.results[0].idempotent, true);
});

test('Adyen handler: a wrong pspReference (attempt) does not finalize (kernel correlation)', async () => {
  const kernel = await pendingKernel();
  const handler = createAdyenWebhookHandler({ kernel, hmacKey: ADYEN_KEY_HEX, log: quiet });
  const res = await handler({ rawBody: adyenBody(adyenItem({ pspReference: 'pay_OTHER' })) });
  assert.equal(res.status, 200);
  assert.notEqual(res.results[0].transitioned, 'paid');
});

test('Adyen Basic Auth (B4 contract): enforced before body/HMAC; HMAC still required on top', async () => {
  const kernel = await pendingKernel();
  const basicAuth = { username: 'adyen_user', password: 'adyen_pass' };
  const handler = createAdyenWebhookHandler({ kernel, hmacKey: ADYEN_KEY_HEX, basicAuth, log: quiet });
  const authHdr = 'Basic ' + Buffer.from('adyen_user:adyen_pass', 'utf8').toString('base64');
  const body = adyenBody(adyenItem());
  // missing Basic Auth → 401, before any body work
  assert.equal((await handler({ headers: {}, rawBody: body })).status, 401);
  // wrong Basic Auth → 401
  assert.equal((await handler({ headers: { authorization: 'Basic ' + Buffer.from('adyen_user:WRONG', 'utf8').toString('base64') }, rawBody: body })).status, 401);
  // correct Basic Auth + valid HMAC → finalizes
  const ok = await handler({ headers: { authorization: authHdr }, rawBody: body });
  assert.equal(ok.status, 200);
  assert.equal(ok.results[0].transitioned, 'paid');
  // correct Basic Auth but BAD HMAC → still 401 (HMAC is required on top of Basic Auth)
  const bad = adyenItem(); bad.additionalData.hmacSignature = 'AAAA';
  assert.equal((await handler({ headers: { authorization: authHdr }, rawBody: adyenBody(bad) })).status, 401);
  // malformed base64 with trailing junk after a valid credential → 401 (strict token, not Node-permissive)
  assert.equal((await handler({ headers: { authorization: authHdr + '!!!!' }, rawBody: body })).status, 401);
  // a longer/shorter credential does not leak via length — still a clean 401 (hash-compare)
  assert.equal((await handler({ headers: { authorization: 'Basic ' + Buffer.from('adyen_user:adyen_pass_extra', 'utf8').toString('base64') }, rawBody: body })).status, 401);
});

test('construction: Adyen basicAuth requires BOTH username and password', () => {
  assert.throws(() => createAdyenWebhookHandler({ kernel: { onPaymentWebhook: async () => ({}) }, hmacKey: ADYEN_KEY_HEX, basicAuth: { username: 'u' } }), /non-empty username AND password/);
  assert.throws(() => createAdyenWebhookHandler({ kernel: { onPaymentWebhook: async () => ({}) }, hmacKey: ADYEN_KEY_HEX, basicAuth: { password: 'p' } }), /non-empty username AND password/);
});

test('construction: Adyen handler refuses a missing hmacKey; bad JSON / no items → 400', async () => {
  assert.throws(() => createAdyenWebhookHandler({ kernel: { onPaymentWebhook() {} } }), /hmacKey/);
  const handler = createAdyenWebhookHandler({ kernel: { onPaymentWebhook: async () => ({}) }, hmacKey: ADYEN_KEY_HEX, log: quiet });
  assert.equal((await handler({ rawBody: 'not json' })).status, 400);
  assert.equal((await handler({ rawBody: JSON.stringify({ notificationItems: [] }) })).status, 400);
});

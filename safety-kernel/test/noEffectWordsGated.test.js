// EVERY ANSWER WHOSE WORDS SAY THE REQUEST HAD NO EFFECT IS REACHABLE FROM AN ORDER CALL ONLY BEHIND THE RELEASE PROOF.
//
// "Nothing was done", "nothing was ordered", "no order was created", "nothing was charged" are true of an order call
// only when the quote-claim release rule matched it (upstreamAnsweredRefusal: a listed pair, the route's own code, no
// deadline mark). Without that proof the claim is kept because an order may exist, and kernel.createOrder answers the
// unknown outcome instead (errors.js claimsNoEffect).
//
// The words are FOUND BY SCANNING, not listed here: every entry of the error catalog, and every string literal of the
// gateway's upstream-error mapping, is matched against NO_EFFECT below. A new such string that is not flagged, or that
// the kernel would answer without the proof, fails this file. Every name is a placeholder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ERROR_CATALOG, PivotaCommerceError, claimsNoEffect } from '../src/errors.js';
import { REFUSED_BEFORE_ANY_ORDER } from '../src/upstreamRefusal.js';
import { SafetyKernel } from '../src/kernel.js';
import { NO_EFFECT } from './helpers/noEffectWords.js';

const require = createRequire(import.meta.url);
const MAPPING_FILE = new URL('../../src/services/commerceKernelErrorMapping.js', import.meta.url);
const { curatedUpstreamRefusal, mapUpstreamErrorToKernelCode } = require('../../src/services/commerceKernelErrorMapping.js');

// The shapes of "this had no effect" (shared with the delist door test).

const LISTED = Object.entries(REFUSED_BEFORE_ANY_ORDER).flatMap(([status, codes]) => codes.map((code) => [Number(status), code]));
const CODES_IN_MAPPING = [...new Set([...readFileSync(MAPPING_FILE, 'utf8').matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)].map((m) => m[1]))];
const STATUSES = [...new Set([...LISTED.map(([s]) => s), ...Array.from({ length: 100 }, (_, i) => 400 + i)])];

/** Every curated refusal the mapping can give an order call: each code it names, at every 4xx, as the route names it. */
function curatedForOrderCalls() {
  const out = [];
  for (const code of CODES_IN_MAPPING) {
    for (const status of STATUSES) {
      const input = { operation: 'create_order', status, upstreamCode: code, upstreamDetail: { error: code } };
      const curated = curatedUpstreamRefusal(input);
      if (curated) out.push({ input, curated, kernelCode: mapUpstreamErrorToKernelCode(input) });
    }
  }
  return out;
}

test('the scan finds what it is for: the regex matches the known no-effect words and not the unknown-outcome words', () => {
  for (const s of ['so nothing was done', 'nothing was written', 'so nothing was ordered and nothing was charged', 'No order was created and nothing was charged', 'closed without creating a purchase']) assert.match(s, NO_EFFECT, s);
  for (const s of ['an order for it may still exist', 'whether the order was created is unknown', 'an earlier attempt of this checkout may already have placed an order']) assert.doesNotMatch(s, NO_EFFECT, s);
  assert.ok(CODES_IN_MAPPING.includes('INVALID_BUYER_CONTEXT') && CODES_IN_MAPPING.includes('MERCHANT_NOT_ACCEPTING_ORDERS'), 'the mapping\'s codes are read');
});

test('every catalog entry whose words say nothing happened is flagged claimsNoEffect, and every flagged one says so', () => {
  const said = Object.entries(ERROR_CATALOG).filter(([, e]) => NO_EFFECT.test(e.userMessage) || NO_EFFECT.test(e.recovery)).map(([c]) => c).sort();
  const flagged = Object.entries(ERROR_CATALOG).filter(([, e]) => e.claimsNoEffect === true).map(([c]) => c).sort();
  assert.deepEqual(flagged, said);
  assert.ok(said.includes('PARTNER_ASSERTION_REJECTED') && said.includes('MERCHANT_NOT_ACCEPTING_ORDERS'), JSON.stringify(said));
});

test('every string literal of the mapping that says nothing happened is reached only through a curated refusal flagged claims_no_effect', () => {
  // The code, without its comments (which explain these words, and are not answers).
  const source = readFileSync(MAPPING_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ [^'"`\n]*$/gm, '');
  const literals = [...source.matchAll(/'((?:[^'\\\n]|\\.){12,})'|"((?:[^"\\\n]|\\.){12,})"|`((?:[^`\\]|\\.){12,})`/g)].map((m) => (m[1] ?? m[2] ?? m[3]).replace(/\\'/g, "'"));
  const saying = literals.filter((s) => NO_EFFECT.test(s));
  assert.ok(saying.length > 0, 'the scan reads the mapping');
  const curated = curatedForOrderCalls();
  for (const literal of saying) {
    const reached = curated.filter(({ curated: c }) => typeof c.acp_message === 'string' && c.acp_message.includes(literal));
    assert.ok(reached.length > 0, `a no-effect string the scan cannot tie to a curated refusal: ${literal}`);
    for (const { input, curated: c } of reached) assert.equal(c.claims_no_effect, true, `${input.status} ${input.upstreamCode}: ${literal}`);
  }
  // And every curated refusal whose words (its own, or its code's) say nothing happened carries the flag.
  for (const { input, curated: c, kernelCode } of curated) {
    const words = `${c.acp_message || ''} ${ERROR_CATALOG[kernelCode]?.userMessage || ''}`;
    if (NO_EFFECT.test(words)) {
      assert.ok(c.claims_no_effect === true || ERROR_CATALOG[kernelCode]?.claimsNoEffect === true, `${input.status} ${input.upstreamCode}`);
    }
  }
});

// The kernel, over an upstream that answers create_order with one scripted error.
async function kernelAnswer(err) {
  const upstream = async (op) => {
    if (op === 'preview_quote') return { quote_id: 'bq_1', currency: 'USD', merchant_of_record: 'merch_A', locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [{ product_id: 'p1', quantity: 1 }] };
    if (op === 'create_order') throw err;
    return {};
  };
  const kernel = new SafetyKernel({ upstream, secret: 'no-effect-secret-0123456789abcdef', log: { info() {}, warn() {}, error() {} } });
  const ctx = { user_ref: 'buyer_1', acp_session_id: 'sess_1' };
  const q = await kernel.previewQuote({ quote: { merchant_id: 'merch_A', items: [{ product_id: 'p1', quantity: 1 }] } }, ctx);
  const answer = await kernel.createOrder({ idempotency_key: 'idem-no-effect-0001', order: { quote_id: q.quote_id, customer_email: 'buyer@example.test', shipping_address: {} } }, ctx).then(() => null, (e) => e);
  return { answer, kept: await kernel.isQuoteClaimed(q.quote_id) };
}

test('the kernel answers every such answer from an order call as raised only on the release proof; without it, the unknown outcome with the claim kept', async () => {
  const cases = [];
  // Every flagged catalog code, as the transport raises it with no route detail (so no release can match).
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    if (!entry.claimsNoEffect) continue;
    for (const status of [400, 403, 409]) cases.push([`${code} at ${status}, no route detail`, () => new PivotaCommerceError(code, { operation: 'create_order', upstream_status: status, upstream_code: code })]);
  }
  // Every flagged curated refusal, with its route detail taken away.
  for (const { input, curated, kernelCode } of curatedForOrderCalls()) {
    if (!(curated.claims_no_effect || ERROR_CATALOG[kernelCode]?.claimsNoEffect)) continue;
    cases.push([`${input.status} ${input.upstreamCode} curated, no route detail`, () => new PivotaCommerceError(kernelCode, { ...curated, operation: 'create_order', upstream_status: input.status, upstream_code: input.upstreamCode })]);
    cases.push([`${input.status} ${input.upstreamCode} curated, a deadline mark`, () => new PivotaCommerceError(kernelCode, { ...curated, operation: 'create_order', upstream_status: input.status, upstream_code: input.upstreamCode, upstream_detail: { error: input.upstreamCode }, upstream_timeout: true })]);
  }
  // A refused caller assertion whose reason keeps the claim (the upstream may have accepted this very request once).
  for (const reason of ['replay', 'stale', 'subject', undefined]) {
    cases.push([`PARTNER_ASSERTION_REJECTED ${reason}`, () => new PivotaCommerceError('PARTNER_ASSERTION_REJECTED', { operation: 'create_order', upstream_status: 409, upstream_code: 'PARTNER_ASSERTION_REJECTED', upstream_detail: { error: 'PARTNER_ASSERTION_REJECTED', ...(reason ? { reason } : {}) } })]);
  }
  assert.ok(cases.length >= 8, `${cases.length} cases`);
  for (const [label, make] of cases) {
    const raised = make();
    assert.equal(claimsNoEffect(raised), true, label);
    const { answer, kept } = await kernelAnswer(raised);
    assert.equal(answer?.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${label}: ${answer?.code} ${answer?.message}`);
    assert.doesNotMatch(`${answer.message} ${answer.recovery}`, NO_EFFECT, label);
    assert.equal(kept, true, `${label}: the claim is kept`);
  }
  // With the proof (a listed pair, the route naming it), the same words are the answer, and the claim is given back.
  for (const { input, curated, kernelCode } of curatedForOrderCalls()) {
    if (!LISTED.some(([s, c]) => s === input.status && c === input.upstreamCode)) continue;
    const raised = new PivotaCommerceError(kernelCode, { ...curated, operation: 'create_order', upstream_status: input.status, upstream_code: input.upstreamCode, upstream_detail: { error: input.upstreamCode } });
    const { answer, kept } = await kernelAnswer(raised);
    assert.equal(answer, raised, `${input.status} ${input.upstreamCode}`);
    assert.equal(kept, false, `${input.status} ${input.upstreamCode}: released`);
  }
  for (const reason of ['path', 'bad_mac']) {
    const raised = new PivotaCommerceError('PARTNER_ASSERTION_REJECTED', { operation: 'create_order', upstream_status: 409, upstream_code: 'PARTNER_ASSERTION_REJECTED', upstream_detail: { error: 'PARTNER_ASSERTION_REJECTED', reason } });
    const { answer, kept } = await kernelAnswer(raised);
    assert.equal(answer, raised, reason);
    assert.equal(kept, false, reason);
  }
});

// ---- the calls AFTER the order exists: the payment step, the payment page, an after-sales request ---------------

import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';
import { KERNEL_ANSWERED_AFTER_ORDER, kernelOutcomeUnknownOf } from '../src/errors.js';

/** A kernel and an executor whose upstream answers `failOp` with `make()` once; every other call succeeds. */
function afterOrderWorld(failOp, make) {
  let failed = false;
  const calls = [];
  const answer = (op, payload) => {
    calls.push(op);
    if (op === failOp && !failed) { failed = true; throw make(); }
    if (op === 'preview_quote') return { quote_id: 'bq_1', currency: 'USD', merchant_of_record: 'merch_A', locked_totals: { subtotal: 1800, tax: 0, shipping: 0, total: 1800 }, line_items: [{ product_id: 'p1', quantity: 1 }] };
    if (op === 'create_order') return { order_id: 'o_1', acp_state: {} };
    if (op === 'submit_payment') return { payment_id: 'pay_1', payment_status: 'requires_action', redirect_url: 'https://pay.example.test/o_1' };
    if (op === 'create_payment_link') return { checkout_url: 'https://pay.example.test/c/o_1', checkout_session_id: 'cs_1' };
    if (op === 'request_after_sales') return { request_id: 'as_1', status: 'requested' };
    return {};
  };
  const kernel = new SafetyKernel({ upstream: async (op, payload) => answer(op, payload), secret: 'no-effect-secret-0123456789abcdef', log: { info() {}, warn() {}, error() {} } });
  const executor = createCanonicalExecutor({
    kernel, upstream: async (op, payload) => answer(op, payload), hostedLinkEnabled: true,
    verifyPaymentAuthorization: async (_a, b) => ({ ok: true, amount: b.amount, currency: b.currency, user_ref: b.user_ref }),
  });
  return { kernel, executor, calls };
}
const CTX2 = Object.freeze({ user_ref: 'buyer_1', acp_session_id: 'sess_1' });
const QUOTE = Object.freeze({ merchant_id: 'merch_A', items: [{ product_id: 'p1', variant_id: 'v1', quantity: 1 }], customer_email: 'buyer@example.test', shipping_address: { name: 'Buyer One', address_line1: '1 Example Road', city: 'Exampleton', postal_code: '00001', country: 'US' } });
const par = (reason) => () => new PivotaCommerceError('PARTNER_ASSERTION_REJECTED', { operation: 'x', upstream_status: 409, upstream_code: 'PARTNER_ASSERTION_REJECTED', upstream_detail: { error: 'PARTNER_ASSERTION_REJECTED', ...(reason ? { reason } : {}) } });

test('after the order exists, a refusal whose words say nothing happened is the unknown outcome with the order id, for every reason (listed ones too): the payment step, the payment page, the bare submit_payment', async () => {
  const LANES = {
    complete: { op: 'submit_payment', reason: 'payment_outcome_unknown_after_order', run: (w, sid, key) => w.executor.execute('complete_checkout_session', { idempotency_key: key, session_id: sid, payment_authorization: { token: 'grant_placeholder' } }, CTX2) },
    payment_link: { op: 'create_payment_link', reason: 'payment_link_outcome_unknown_after_order', run: (w, sid, key) => w.executor.execute('create_payment_link', { idempotency_key: key, session_id: sid, customer_email: 'buyer@example.test' }, CTX2) },
  };
  const makers = [...['replay', 'stale', 'subject', 'path', undefined].map((r) => [`PARTNER_ASSERTION_REJECTED ${r}`, par(r)]),
    ...Object.entries(ERROR_CATALOG).filter(([, e]) => e.claimsNoEffect).map(([code]) => [code, () => new PivotaCommerceError(code, { operation: 'x', upstream_status: 409, upstream_code: code })])];
  for (const [laneName, lane] of Object.entries(LANES)) {
    for (const [label, make] of makers) {
      const w = afterOrderWorld(lane.op, make);
      const sid = (await w.executor.execute('create_checkout_session', { idempotency_key: 'idem-ae-open-01', quote: QUOTE }, CTX2)).session_id;
      const first = await lane.run(w, sid, 'idem-ae-0001').then(() => null, (e) => e);
      const tag = `${laneName} ${label}`;
      assert.equal(first?.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${tag}: ${first?.code} ${first?.message}`);
      assert.deepEqual(first.detail, { reason: lane.reason, order_id: 'o_1' }, tag);
      assert.equal(first.message, KERNEL_ANSWERED_AFTER_ORDER[lane.reason].message, tag);
      assert.doesNotMatch(`${first.message} ${first.recovery}`, NO_EFFECT, tag);
      if (label.startsWith('PARTNER')) assert.equal(first.upstreamRefusalCode, 'PARTNER_ASSERTION_REJECTED', `${tag}: still counted by its code`);
      // The same key is told the same; the order exists, and no second order or page is asked for.
      const same = await lane.run(w, sid, 'idem-ae-0001').then(() => null, (e) => e);
      assert.equal(same?.code, 'CHECKOUT_OUTCOME_UNKNOWN', `${tag} same key: ${same?.code} ${same?.message}`);
      assert.equal(same.message, first.message, tag);
      assert.deepEqual([w.calls.filter((c) => c === 'create_order').length, w.calls.filter((c) => c === lane.op).length], [1, 1], tag);
    }
  }
  // The bare submit_payment (the invoke route's call), after charge_pending is written.
  for (const [label, make] of makers) {
    const w = afterOrderWorld('submit_payment', make);
    const q = await w.kernel.previewQuote({ quote: QUOTE }, CTX2);
    const o = await w.kernel.createOrder({ idempotency_key: 'idem-ae-bare-01', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX2);
    const token = await w.kernel.mintConfirmation({ order_id: o.order_id }, CTX2);
    const pay = () => w.kernel.submitPayment({ idempotency_key: 'idem-ae-bare-02', confirmation_token: token, payment: { order_id: o.order_id, expected_amount: 1800, currency: 'USD' } }, CTX2).then(() => null, (e) => e);
    const first = await pay();
    assert.deepEqual([first?.code, first?.detail], ['CHECKOUT_OUTCOME_UNKNOWN', { reason: 'payment_outcome_unknown_after_order', order_id: 'o_1' }], `${label}: ${first?.message}`);
    assert.doesNotMatch(`${first.message} ${first.recovery}`, NO_EFFECT, label);
    assert.equal((await w.kernel._orderStore.get('o_1')).status, 'charge_pending', label);
    const same = await pay();
    assert.equal(same?.message, first.message, `${label}: the same key is told the same`);
    assert.equal(w.calls.filter((c) => c === 'submit_payment').length, 1, label);
  }
});

test('request_after_sales: a refusal whose words say nothing happened is given only on the release proof; a kept reason is the unknown outcome with the order id, and the same call may be sent again', async () => {
  for (const [reason, released] of [['replay', false], ['stale', false], ['subject', false], [undefined, false], ['path', true], ['bad_mac', true]]) {
    const w = afterOrderWorld('request_after_sales', par(reason));
    const q = await w.kernel.previewQuote({ quote: QUOTE }, CTX2);
    await w.kernel.createOrder({ idempotency_key: 'idem-as-order-01', order: { quote_id: q.quote_id, shipping_address: {} } }, CTX2);
    const ask = () => w.kernel.requestAfterSales({ idempotency_key: 'idem-as-0001', status: { order_id: 'o_1', requested_action: 'refund', reason: 'placeholder' } }, CTX2).then((v) => v, (e) => e);
    const first = await ask();
    if (released) {
      assert.equal(first?.code, 'PARTNER_ASSERTION_REJECTED', String(reason));
    } else {
      assert.deepEqual([first?.code, first?.detail], ['CHECKOUT_OUTCOME_UNKNOWN', { reason: 'after_sales_outcome_unknown', order_id: 'o_1' }], `${reason}: ${first?.message}`);
      assert.equal(first.message, KERNEL_ANSWERED_AFTER_ORDER.after_sales_outcome_unknown.message, String(reason));
      assert.doesNotMatch(`${first.message} ${first.recovery}`, NO_EFFECT, String(reason));
      assert.equal(kernelOutcomeUnknownOf(first).answered, 'refused');
    }
    // The key was not held: the same call is sent again, with the same Idempotency-Key upstream.
    const again = await ask();
    assert.equal(again?.request_id, 'as_1', String(reason));
    assert.equal(w.calls.filter((c) => c === 'request_after_sales').length, 2, String(reason));
  }
});

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

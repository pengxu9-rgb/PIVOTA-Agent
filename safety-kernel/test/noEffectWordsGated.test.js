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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ERROR_CATALOG, PivotaCommerceError, claimsNoEffect } from '../src/errors.js';
import { REFUSED_BEFORE_ANY_ORDER } from '../src/upstreamRefusal.js';
import { SafetyKernel } from '../src/kernel.js';
import { NO_EFFECT, RESTART, restartInstructions } from '../test-support/noEffectWords.js';
import { stringLiterals } from '../test-support/stringLiterals.js';

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
  for (const s of ['so nothing was done', 'nothing was written', 'so nothing was ordered and nothing was charged', 'No order was created and nothing was charged', 'closed without creating a purchase',
    // The negated and active forms.
    'it has not been ordered', "the buyer wasn't charged", 'the buyer was not charged', 'The buyer was NOT charged.', 'the order was not placed', 'its payment did not go through',
    'this did not create an order', 'the order was not created', 'no payment was made', 'nothing happened', 'it was never charged', 'this call sent nothing to the store', 'the request was not filed',
    'no refund was filed', 'the buyer has not been charged yet']) assert.match(s, NO_EFFECT, s);
  for (const s of ['an order for it may still exist', 'whether the order was created is unknown', 'an earlier attempt of this checkout may already have placed an order',
    'do not place a new order for this purchase without the buyer', 'do not file another request for this order', 'whether it was placed is not known']) assert.doesNotMatch(s, NO_EFFECT, s);
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

// ---- every string this code writes ----------------------------------------------------------------------------------

const ROOT = new URL('../../', import.meta.url);
const SCANNED = [
  ...(function walk(dir) {
    return readdirSync(new URL(dir, ROOT)).flatMap((name) => {
      const rel = `${dir}${name}`;
      return statSync(new URL(rel, ROOT)).isDirectory() ? walk(`${rel}/`) : /\.c?js$/.test(name) ? [rel] : [];
    });
  })('safety-kernel/src/'),
  'mcp-server/src/commerceToolSurface.js',
  'src/services/commerceKernelErrorMapping.js',
];
const MAPPING_REL = 'src/services/commerceKernelErrorMapping.js';
// The words that say a request had no effect and are TRUE where they are given, each with the test that proves it. An
// entry names its file, a part of the string, why it is true, and a test (file and a part of its name); the test below
// checks every entry is still used and that its test still exists. The unknown-outcome words can never be exempt.
const EXEMPT = [
  { file: 'safety-kernel/src/protocol/acpRestAdapter.js', includes: 'is not a country code this door can read', why: 'an ACP intake refusal: before any variant read, quote or order', test: ['safety-kernel/test/acpMarketCurrency.test.js', 'a country that is not two letters is refused by name and never reaches the source or the pricer'] },
  { file: 'safety-kernel/src/protocol/buyerIntake.js', includes: 'Nothing was charged and no order was created; retrying this request unchanged', why: 'a completion with no address to ship to: refused before any authorization, claim or order call', test: ['safety-kernel/test/checkoutHonestAnswers.test.js', 'no address anywhere is refused by name before any order: no authorization presented, no claim'] },
  { file: 'safety-kernel/src/protocol/canonicalExecutor.js', includes: 'is not a country code this door can read', why: 'the executor\'s market intake: before any pricing call', test: ['safety-kernel/test/quoteMarketCurrency.test.js', 'a market that is not an upper-case two-letter code is never priced and never echoed'] },
  { file: 'safety-kernel/src/protocol/canonicalExecutor.js', includes: 'Nothing was converted or relabelled', why: 'a quote in another currency than the market\'s: refused after pricing, before any session, claim or order', test: ['safety-kernel/test/quoteMarketCurrency.test.js', 'refused by name, after one pricing call, and NO session exists'] },
  { file: 'safety-kernel/src/protocol/canonicalExecutor.js', includes: 'Nothing was charged and no order was created.', why: 'a completion judged for another market than its session\'s: refused before any authorization or order call', test: ['safety-kernel/test/acpMarketCurrency.test.js', 'the recorded market and a held market are each judged'] },
  { file: 'safety-kernel/src/protocol/canonicalExecutor.js', includes: 'This request did not cancel anything and sent nothing to the store', why: 'the flag-off cancel by order id makes no upstream call (ACP words)', test: ['tests/checkout_honest_answers_door.node.test.cjs', 'on /mcp and on ACP: unpaid (a page may be open)'] },
  { file: 'safety-kernel/src/protocol/canonicalExecutor.js', includes: 'Its payment did not go through.', why: 'said only for a kernel order whose status is `failed`, read from the kernel row (ACP words)', test: ['tests/checkout_honest_answers_door.node.test.cjs', 'on /mcp and on ACP: unpaid (a page may be open)'] },
  { file: 'safety-kernel/src/quoteRegistry.js', includes: 'Nothing was converted or relabelled', why: 'the registry backstop: a market-bound quote in another currency is never stored', test: ['safety-kernel/test/quoteMarketCurrency.test.js', 'the backstop, with the judgement stubbed out: a market-bound quote in another currency is refused by name, not retriable, and nothing is stored'] },
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'Nothing is substituted when your need asks for', why: 'a tool description of the recommendation gate, not an answer to a call', test: ['tests/agent_signals_recommend_products.node.test.cjs', '8e. the tool description and the code agree'] },
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'Does NOT charge', why: 'the create_payment_link description: the link step never charges', test: ['safety-kernel/test/canonicalExecutor_payment_link.test.js', 'create_payment_link mints a hosted URL and NEVER charges (no submitPayment)'] },
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'nothing was opened by this call; if it retries an earlier call whose outcome was unknown', why: 'start_purchase refused before its key lookup (a frozen lane); hedged that an earlier purchase may exist', test: ['tests/orchestrated_purchase_tool.node.test.cjs', 'a dark backend door, or an explicit rail it cannot honour, is a definite "not available", not an endless retry'] },
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'No order was placed from it.', why: 'given only for a claim a cancellation took (putIfAbsent), which no order can then take', test: ['tests/checkout_honest_answers_door.node.test.cjs', 'C: cancel by session id of a session with no order cancels it truly'] },
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'so nothing was canceled', why: 'the session cancel refused while an order call holds the claim: the claim is left as it is', test: ['safety-kernel/test/checkoutHonestAnswers.test.js', 'C cancel by session id says canceled only when it is true'] },
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'Its payment did not go through.', why: 'said only for a kernel order whose status is `failed`', test: ['mcp-server/test/checkoutHonestAnswersToolError.test.js', 'a failed or canceled order never hears its payment page stays open'] },
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'This call did not cancel anything and sent nothing to the store.', why: 'the flag-off cancel by order id makes no upstream call (`upstream: []`)', test: ['tests/checkout_honest_answers_door.node.test.cjs', '5: cancel by order id with the upstream cancel off is never canceled'] },
];

test('every string this code writes that says a request had no effect is gated (a flagged catalog entry, a flagged curated refusal) or exempt by a named, existing test; the unknown-outcome words never are', async () => {
  const flaggedCatalogWords = new Set(Object.values(ERROR_CATALOG).filter((e) => e.claimsNoEffect).flatMap((e) => [e.userMessage, e.recovery]));
  const used = new Set();
  const ungated = [];
  let literals = 0;
  for (const rel of SCANNED) {
    for (const { text, line } of stringLiterals(readFileSync(new URL(rel, ROOT), 'utf8'))) {
      literals += 1;
      if (!NO_EFFECT.test(text)) continue;
      if (rel === 'safety-kernel/src/errors.js' && flaggedCatalogWords.has(text)) continue;
      if (rel === MAPPING_REL) continue; // the curated-refusal test above ties each one to a flagged refusal
      const entry = EXEMPT.find((e) => e.file === rel && text.includes(e.includes));
      if (entry) { used.add(entry); continue; }
      ungated.push(`${rel}:${line} ${text.slice(0, 160)}`);
    }
  }
  assert.ok(literals > 2000, `${literals} literals read from ${SCANNED.length} files`);
  assert.deepEqual(ungated, [], 'a no-effect string that is neither gated nor exempt by a named test');
  for (const entry of EXEMPT) {
    assert.ok(used.has(entry), `an exemption no string uses any more: ${entry.file} ${entry.includes}`);
    const [testFile, testName] = entry.test;
    assert.ok(readFileSync(new URL(testFile, ROOT), 'utf8').includes(testName), `the test an exemption names does not exist: ${testFile} ${testName}`);
    assert.ok(entry.why.length > 10, entry.includes);
  }
  // The unknown-outcome words: never a no-effect sentence, and never covered by an exemption.
  const { KERNEL_ANSWERED_REFUSALS: refusals, KERNEL_ANSWERED_AFTER_ORDER: afterOrder, IDEMPOTENCY_CONFLICT_ANSWERS: conflicts } = await import('../src/errors.js');
  const { UNKNOWN_ORDER_CLAIM_MESSAGE } = await import('../src/kernel.js');
  const { AMBIGUOUS_PRIOR_ATTEMPT_MESSAGE } = await import('../src/idempotencyLedger.js');
  const unknownWords = [...Object.values(refusals), ...Object.values(afterOrder), ...Object.values(conflicts)].flatMap((w) => [w.message, w.recovery]).concat([UNKNOWN_ORDER_CLAIM_MESSAGE, AMBIGUOUS_PRIOR_ATTEMPT_MESSAGE]);
  for (const words of unknownWords) {
    assert.doesNotMatch(words, NO_EFFECT, words);
    assert.equal(EXEMPT.some((e) => words.includes(e.includes)), false, words);
  }
});

// "Starting fresh" told an agent to begin again while an order may exist (a key still running, a payment already asked
// for). It is in no file this scan reads: not as a literal, not split across literals or a template, not in a comment
// that a later edit could turn back into words.
const START_FRESH = /start(?:ing)?\s*(?:['"`]\s*\+\s*['"`]|\$\{[^}]*\})?\s*fresh|reusing an old reference/i;

test('no file this scan reads says "Starting fresh" (or "start fresh"), in a string, across strings, or anywhere else in it', () => {
  const found = [];
  for (const rel of SCANNED) {
    const source = readFileSync(new URL(rel, ROOT), 'utf8');
    source.split('\n').forEach((line, i) => { if (START_FRESH.test(line)) found.push(`${rel}:${i + 1} ${line.trim().slice(0, 160)}`); });
    for (const { text, line } of stringLiterals(source)) if (START_FRESH.test(text)) found.push(`${rel}:${line} ${text.slice(0, 160)}`);
  }
  // The joined text of each file, so words split across lines or strings are found too.
  for (const rel of SCANNED) {
    const flat = readFileSync(new URL(rel, ROOT), 'utf8').replace(/['"`]\s*\+\s*['"`]/g, '').replace(/\s+/g, ' ');
    if (/start(?:ing)? fresh/i.test(flat) && !found.some((f) => f.startsWith(`${rel}:`))) found.push(`${rel}: (split across lines or strings)`);
  }
  assert.deepEqual(found, []);
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) assert.doesNotMatch(`${entry.userMessage} ${entry.recovery}`, START_FRESH, code);
  assert.ok(START_FRESH.test("'Starting ' + 'fresh.'") && START_FRESH.test('start fresh') && START_FRESH.test('Starting fresh'), 'the pattern finds what it is for');
});

// "Start the order over", "re-quote", "a new order", "start again": obeyed while an order may exist, any of them can place
// a second order for one purchase. Every string this scan reads either bounds such words in their own clause ("only if
// the buyer wants another order", "do not start another order ... without the buyer") or is one of these, each with
// the test that proves it true where it is said. A flagged catalog entry (claimsNoEffect) is given only on the release
// rule's proof that nothing was ordered (the test above), so its words may say to start again, in the catalog or where a
// door gives that code its own catalog words again.
const RESTART_EXEMPT = [
  { file: 'mcp-server/src/commerceToolSurface.js', includes: 'Re-quote a checkout session after a change', why: 'the update_checkout_session tool description: what the tool does (re-prices the session it is sent), not an answer to a call', test: ['tests/intake_key_minimum_and_quantity_ceiling_door.node.test.cjs', '/mcp update: 999 units are re-priced'] },
];

test('the restart words: the pattern finds what it is for, and the bounded forms are not counted', () => {
  for (const t of ['Let me start the order over.', 're-quote in this session', 'Please start over.', 'Starting fresh.', 'start again', 'Let me re-quote what is available.', 'Place a new order.', 'Open another checkout.', 'show new quote, re-confirm']) {
    assert.ok(restartInstructions(t).length > 0, t);
  }
  for (const t of ['start a new checkout only if the buyer wants another order', 'do not start another order for this purchase without the buyer', 'if the buyer still wants the item, start a new checkout', 'get a new quote only if no order was placed for this purchase', 'read it (get_order) instead of starting another', 'Requires new purchases enabled.']) {
    assert.deepEqual(restartInstructions(t), [], t);
  }
  assert.ok(RESTART.global, 'matchAll needs the g flag');
});

test('no string this scan reads tells the caller to start the purchase again, unless its own clause bounds it or it is exempt by a named, existing test', () => {
  const flagged = new Set(Object.values(ERROR_CATALOG).filter((e) => e.claimsNoEffect).flatMap((e) => [e.userMessage, e.recovery]));
  const found = [];
  const used = new Set();
  for (const rel of SCANNED) {
    for (const { text, line } of stringLiterals(readFileSync(new URL(rel, ROOT), 'utf8'))) {
      const hits = restartInstructions(text);
      if (!hits.length) continue;
      if (flagged.has(text)) continue;
      const entry = RESTART_EXEMPT.find((e) => e.file === rel && text.includes(e.includes));
      if (entry) { used.add(entry); continue; }
      found.push(`${rel}:${line} [${hits.map((h) => h.words).join(', ')}] ${text.slice(0, 160)}`);
    }
  }
  assert.deepEqual(found, [], 'a restart instruction that is neither bounded, gated nor exempt by a named test');
  for (const entry of RESTART_EXEMPT) {
    assert.ok(used.has(entry), `an exemption no string uses any more: ${entry.file} ${entry.includes}`);
    const [testFile, testName] = entry.test;
    assert.ok(readFileSync(new URL(testFile, ROOT), 'utf8').includes(testName), `the test an exemption names does not exist: ${testFile} ${testName}`);
  }
  // Every catalog entry that is not gated by the release proof, and the linkage words above all, says no such thing.
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    if (entry.claimsNoEffect) continue;
    assert.deepEqual(restartInstructions(`${entry.userMessage}`).concat(restartInstructions(entry.recovery)), [], code);
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

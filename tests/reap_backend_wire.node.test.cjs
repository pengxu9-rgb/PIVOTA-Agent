'use strict';

// The gateway against pivota-backend's REAL Reap wire, not against its documentation.
//
// Every body in tests/fixtures/reap-backend-wire/ was written by capture_reap_backend_wire.py running over the
// backend's own app (routes + ErrorHandlerMiddleware + SQLite self-heal); README.md there names the commit. Each one
// goes through the REAL client (src/services/reapAgenticPurchaseClient.js) over a stubbed fetch, and the purchase
// views also through the REAL lane's get_checkout. A backend envelope or field change shows up here as a failed
// classification, not in a buyer's checkout.
//
// Discovered by scripts/run_node_test_suites.cjs (glob over tests/**/*.node.test.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createReapAgenticPurchaseClient } = require('../src/services/reapAgenticPurchaseClient');

const DIR = path.join(__dirname, 'fixtures', 'reap-backend-wire');
const WIRE = Object.fromEntries(fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
  .map((f) => [f.slice(0, -'.json'.length), JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))]));
const USED = new Set();
function wire(name) {
  assert.ok(WIRE[name], `missing captured fixture ${name}`);
  USED.add(name);
  return WIRE[name];
}

const HEADERS = { 'X-API-Key': 'ak_wire_fixture', 'X-Agent-User-JWT': 'eyJ.wire.fixture' };
const PID_RE = /^rp_[0-9a-f]{24}$/;

function clientAnswering(record) {
  const calls = [];
  const client = createReapAgenticPurchaseClient({
    baseUrl: 'https://backend.test',
    authHeaders: () => HEADERS,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return { status: record.status, text: async () => JSON.stringify(record.body) };
    },
  });
  return { client, calls };
}

let lanePromise = null;
const lane = () => (lanePromise ||= import('../mcp-server/src/ucpReapAgenticLane.js'));

// get_checkout through the lane itself: decode the id, call the client, map the view.
async function getCheckout(record, env = { REAP_AGENTIC_LANE_ENABLED: '1' }) {
  const m = await lane();
  const view = record.body;
  const snapshot = { purchaseId: view.id, productId: 'sig_wire_item', productKey: view.product_key,
    quantity: view.quantity, currency: view.totals.currency, unitMinor: view.totals.our_price_minor };
  const id = m.encodeReapCheckoutId(snapshot);
  const { client, calls } = clientAnswering(record);
  const out = await m.tryReapAgenticCheckout({
    op: { id: 'get_checkout_session' }, params: { session_id: id }, ctx: {}, ucpArgs: {}, client,
    env, now: Date.parse(view.updated_at),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://backend.test/agent/v2/commerce/reap/purchases/${view.id}`);
  return out;
}
const message = (out, code) => out.messages.find((msg) => msg.code === code);

test('create 202: a fresh purchase carries its committed dispatch facts', async () => {
  const record = wire('create_202_fresh');
  const res = await clientAnswering(record).client.startPurchase({});
  assert.equal(res.kind, 'accepted');
  assert.match(res.purchase.id, PID_RE);
  assert.equal(res.purchase.state, 'resolving');
  assert.equal(res.purchase.checkout_dispatch_state, 'not_dispatched');
  assert.equal(res.purchase.contact_reentry_required, false);
});

test('create 202 replay: a started dispatch and a paused contact are forwarded, never defaulted', async () => {
  const res = await clientAnswering(wire('create_202_replay_dispatch_started')).client.startPurchase({});
  assert.equal(res.kind, 'accepted');
  assert.equal(res.purchase.checkout_dispatch_state, 'dispatch_started');
  assert.equal(res.purchase.contact_reentry_required, true);
});

test('create 409 price_changed: an authoritative refusal read from the middleware envelope', async () => {
  const record = wire('create_409_price_changed');
  assert.equal(record.body.error.code, 'CONFLICT', 'the envelope the client checks the class of');
  const res = await clientAnswering(record).client.startPurchase({});
  assert.deepEqual(res, { kind: 'refused', code: 'price_changed', http_status: 409 });
});

test('create 503 checkout_outcome_unknown: unavailable (recover, never re-POST), not a refusal', async () => {
  const record = wire('create_503_outcome_unknown');
  assert.equal(record.body.detail.error, 'checkout_outcome_unknown');
  const res = await clientAnswering(record).client.startPurchase({});
  assert.equal(res.kind, 'unavailable');
  assert.equal(res.code, 'http_5xx');
});

for (const name of ['get_200_contact_paused', 'recover_200_contact_paused']) {
  test(`${name}: a contact-paused purchase tells the agent to resume_checkout, not to poll`, async () => {
    const record = wire(name);
    assert.equal(record.body.contact_reentry_required, true);
    assert.equal(record.body.checkout_dispatch_state, 'not_dispatched');
    if (name.startsWith('recover')) {
      const res = await clientAnswering(record).client.recoverPurchase({});
      assert.equal(res.kind, 'accepted');
    }
    const out = await getCheckout(record);
    assert.equal(out.status, 'incomplete');
    assert.equal(message(out, 'reap.contact_reentry_required').content, 'true');
    assert.equal(message(out, 'reap.checkout_dispatch_state').content, 'not_dispatched');
    const needed = message(out, 'reap.contact_reentry_needed');
    assert.equal(needed.type, 'warning');
    assert.match(needed.content, /call resume_checkout with this checkout_id/);
    assert.match(needed.content, /Do not create a new checkout/);
    assert.equal(message(out, 'reap.contact_reentry_unavailable'), undefined);
  });
}

test('contact-paused while new Reap purchases are paused: keep polling, never sent to a tool that refuses', async () => {
  const out = await getCheckout(wire('get_200_contact_paused'),
    { REAP_AGENTIC_LANE_ENABLED: '1', REAP_AGENTIC_CREATE_ENABLED: '0' });
  assert.equal(message(out, 'reap.contact_reentry_needed'), undefined);
  const unavailable = message(out, 'reap.contact_reentry_unavailable');
  assert.equal(unavailable.type, 'warning');
  assert.match(unavailable.content, /temporarily unavailable/);
  assert.match(unavailable.content, /Keep polling get_checkout/);
  assert.doesNotMatch(unavailable.content, /call resume_checkout/);
});

test('a paused needs_enrollment with a card page: the link stays, but the text says resume first, not "poll afterwards"', async () => {
  const paused = wire('get_200_contact_paused').body;
  const later = new Date(Date.parse(paused.updated_at) + 10 * 60 * 1000).toISOString();
  const enrolling = { ...paused, state: 'needs_enrollment', hosted_url: 'https://pay.prava.space/enroll/3fa85f64', hosted_url_expires_at: later };
  const out = await getCheckout({ status: 200, body: enrolling });
  assert.equal(out.status, 'requires_escalation');
  assert.equal(out.continue_url, enrolling.hosted_url);
  const step = message(out, 'reap.needs_enrollment');
  assert.match(step.content, /will not continue until its contact details are re-entered/);
  assert.doesNotMatch(step.content, /Poll get_checkout afterwards/);
  assert.ok(message(out, 'reap.contact_reentry_needed'));
  const ordinary = await getCheckout({ status: 200, body: { ...enrolling, contact_reentry_required: false } });
  assert.match(message(ordinary, 'reap.needs_enrollment').content, /Poll get_checkout afterwards/);
});

test('resume 200: the same purchase, contact restored, and no resume prompt any more', async () => {
  const record = wire('resume_200');
  const { client, calls } = clientAnswering(record);
  const res = await client.resumePurchase(record.body.id, {});
  assert.equal(res.kind, 'accepted');
  assert.equal(calls[0].url, `https://backend.test/agent/v2/commerce/reap/purchases/${record.body.id}/resume`);
  assert.equal(res.purchase.contact_reentry_required, false);
  const out = await getCheckout(record);
  assert.equal(message(out, 'reap.contact_reentry_required').content, 'false');
  assert.equal(message(out, 'reap.contact_reentry_needed'), undefined);
});

for (const name of ['resume_404_not_available_on_this_rail', 'resume_404_purchase_not_found',
  'resume_409_checkout_dispatch_unresolved', 'resume_409_resume_raced', 'resume_409_terminal_purchase_not_resumable']) {
  test(`${name}: a resume refusal keeps the attempt and echoes no backend text`, async () => {
    const record = wire(name);
    const res = await clientAnswering(record).client.resumePurchase('rp_0123456789abcdef01234567', {});
    assert.deepEqual(res, { kind: 'unavailable', code: 'resume_unavailable', http_status: record.status });
  });
}

// The same envelopes on the read routes, where the client DOES read the reason: GET and recover decide "this id is
// not yours or does not exist" (QUOTE_NOT_FOUND) against "unavailable, keep polling" from it.
test('GET and recover: only the captured purchase_not_found envelope is an owner miss', async () => {
  const miss = wire('resume_404_purchase_not_found');
  for (const call of [(c) => c.getPurchase('rp_0123456789abcdef01234567'), (c) => c.recoverPurchase({})]) {
    const res = await call(clientAnswering(miss).client);
    assert.equal(res.kind, 'not_found');
    assert.equal(res.code, 'purchase_not_found');
  }
  const dark = wire('resume_404_not_available_on_this_rail');
  for (const call of [(c) => c.getPurchase('rp_0123456789abcdef01234567'), (c) => c.recoverPurchase({})]) {
    const res = await call(clientAnswering(dark).client);
    assert.equal(res.kind, 'unavailable');
    assert.equal(res.code, 'not_available_on_this_rail');
  }
});

test('GET: a captured 409 envelope yields exactly its reason code, read from the middleware wrapping', async () => {
  for (const name of ['resume_409_checkout_dispatch_unresolved', 'resume_409_resume_raced', 'resume_409_terminal_purchase_not_resumable']) {
    const record = wire(name);
    const res = await clientAnswering(record).client.getPurchase('rp_0123456789abcdef01234567');
    assert.deepEqual(res, { kind: 'unavailable', code: record.body.detail.error, http_status: 409 }, name);
  }
});

for (const [name, state] of [['get_200_lapsed_failed', 'failed'], ['get_200_lapsed_expired', 'expired']]) {
  test(`${name}: a lapsed purchase is canceled, named, and says to start over with a new key`, async () => {
    const record = wire(name);
    assert.equal(record.body.last_error_code, 'contact_reentry_lapsed');
    const out = await getCheckout(record);
    assert.equal(out.status, 'canceled');
    const ended = message(out, `reap.purchase_${state}`);
    assert.match(ended.content, /Reason: contact_reentry_lapsed\./);
    assert.match(ended.content, /No checkout was created with the payment partner and nothing was charged/);
    assert.match(ended.content, /NEW idempotency key/);
    assert.equal(message(out, 'reap.contact_reentry_needed'), undefined);
  });
}

test('the lapse hint is keyed on its own states and its own code', async () => {
  const lapsed = wire('get_200_lapsed_failed').body;
  const refused = await getCheckout({ status: 200, body: { ...lapsed, state: 'refused' } });
  assert.match(message(refused, 'reap.purchase_refused').content, /Reason: contact_reentry_lapsed\./);
  assert.doesNotMatch(message(refused, 'reap.purchase_refused').content, /not re-entered in time/);
  const other = await getCheckout({ status: 200, body: { ...lapsed, last_error_code: 'contact_retention_elapsed' } });
  assert.doesNotMatch(message(other, 'reap.purchase_failed').content, /not re-entered in time/);
});

test('the resume prompt needs all four facts: paused contact, not_dispatched, a paused state, no review code', async () => {
  const paused = wire('get_200_contact_paused').body;
  const cases = [
    { checkout_dispatch_state: 'dispatch_started' },
    { checkout_dispatch_state: 'unknown' },
    { contact_reentry_required: false },
    { state: 'awaiting_approval' },
    { last_error_code: 'checkout_dispatch_unresolved' },
  ];
  for (const change of cases) {
    const out = await getCheckout({ status: 200, body: { ...paused, ...change } });
    assert.equal(message(out, 'reap.contact_reentry_needed'), undefined, JSON.stringify(change));
  }
  for (const state of ['needs_enrollment', 'quoting']) {
    const out = await getCheckout({ status: 200, body: { ...paused, state } });
    assert.ok(message(out, 'reap.contact_reentry_needed'), state);
  }
});

// Meaningless when a filter ran only some of the tests above.
const FILTERED = process.execArgv.concat(process.argv).some((arg) => /^--test-(name-pattern|skip-pattern|only)/.test(arg));
test('every captured backend body is exercised', { skip: FILTERED }, () => {
  const unused = Object.keys(WIRE).filter((name) => !USED.has(name));
  assert.deepEqual(unused, []);
});

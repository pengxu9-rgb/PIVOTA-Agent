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
async function getCheckout(record) {
  const m = await lane();
  const view = record.body;
  const snapshot = { purchaseId: view.id, productId: 'sig_wire_item', productKey: view.product_key,
    quantity: view.quantity, currency: view.totals.currency, unitMinor: view.totals.our_price_minor };
  const id = m.encodeReapCheckoutId(snapshot);
  const { client, calls } = clientAnswering(record);
  const out = await m.tryReapAgenticCheckout({
    op: { id: 'get_checkout_session' }, params: { session_id: id }, ctx: {}, ucpArgs: {}, client,
    env: { REAP_AGENTIC_LANE_ENABLED: '1' }, now: Date.parse(view.updated_at),
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
  });
}

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

for (const [name, state] of [['get_200_lapsed_failed', 'failed'], ['get_200_lapsed_expired', 'expired']]) {
  test(`${name}: a lapsed purchase is canceled, named, and says to start over with a new key`, async () => {
    const record = wire(name);
    assert.equal(record.body.last_error_code, 'contact_reentry_lapsed');
    const out = await getCheckout(record);
    assert.equal(out.status, 'canceled');
    const ended = message(out, `reap.purchase_${state}`);
    assert.match(ended.content, /Reason: contact_reentry_lapsed\./);
    assert.match(ended.content, /nothing was charged/);
    assert.match(ended.content, /NEW idempotency key/);
    assert.equal(message(out, 'reap.contact_reentry_needed'), undefined);
  });
}

test('the lapse hint is keyed on its own states and its own code', async () => {
  const lapsed = wire('get_200_lapsed_failed').body;
  const refused = await getCheckout({ status: 200, body: { ...lapsed, state: 'refused' } });
  assert.doesNotMatch(message(refused, 'reap.purchase_refused').content, /resume_checkout/);
  const other = await getCheckout({ status: 200, body: { ...lapsed, last_error_code: 'contact_retention_elapsed' } });
  assert.doesNotMatch(message(other, 'reap.purchase_failed').content, /resume_checkout/);
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

test('every captured backend body is exercised', () => {
  const unused = Object.keys(WIRE).filter((name) => !USED.has(name));
  assert.deepEqual(unused, []);
});

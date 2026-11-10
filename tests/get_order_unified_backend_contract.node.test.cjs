'use strict';

// The gateway's readers of the backend answers get_order and cancel_checkout_session depend on, replayed from ONE
// recording of the merged backend (tests/fixtures/backend_get_order_unified.backend.json, see its `generated_from`)
// instead of keys copied by hand into each test (status review P2-6). If the backend changes a status, a code or
// the envelope, re-recording changes the fixture and these fail; a hand copy would keep passing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'backend_get_order_unified.backend.json'), 'utf8'),
);
const { CANCEL_KIND, classifyUpstreamCancel } = require('../src/services/checkoutCancelUpstream');
const { createStorefrontHandoffClient } = require('../src/services/storefrontHandoffRecord');
const { createAgentPurchaseReadClient } = require('../src/services/agentPurchaseReadClient');
const { mapUpstreamErrorToKernelCode } = require('../src/services/commerceKernelErrorMapping');

// A fetch that answers one recorded response, the way the backend sent it (status + JSON text).
function replay(recorded) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status: recorded.status, text: async () => JSON.stringify(recorded.body) };
  };
  return { fetchImpl, calls };
}

// ---- cancel: v2 (what the kernel calls) and v1 (what the REST invoke lane reaches) -------------------------------

const CANCEL_EXPECTED = {
  canceled: CANCEL_KIND.canceled,
  already_canceled: CANCEL_KIND.alreadyCanceled,
  not_canceled_paid: CANCEL_KIND.paid,
  not_canceled_processing: CANCEL_KIND.processing,
  not_confirmed: CANCEL_KIND.notConfirmed,
};

test('every recorded v2 cancel answer classifies as what it says, and only the two 200s read as canceled', () => {
  for (const [outcome, kind] of Object.entries(CANCEL_EXPECTED)) {
    const { status, body } = FIXTURE.cancel_v2[outcome];
    assert.deepEqual(classifyUpstreamCancel(status, body), { kind }, outcome);
  }
  assert.deepEqual(classifyUpstreamCancel(FIXTURE.cancel_v2.not_found.status, FIXTURE.cancel_v2.not_found.body), { kind: CANCEL_KIND.notFound });
  // The backend flag off: the route does not exist, which is "not confirmed", never canceled or not found.
  assert.deepEqual(classifyUpstreamCancel(FIXTURE.cancel_v2.route_off.status, FIXTURE.cancel_v2.route_off.body), { kind: CANCEL_KIND.unavailable });
});

test('the v1 cancel (flag on) gives the v2 answers: each outcome classifies exactly as its v2 twin', () => {
  for (const [outcome, kind] of Object.entries(CANCEL_EXPECTED)) {
    const v1 = FIXTURE.cancel_v1[outcome];
    const v2 = FIXTURE.cancel_v2[outcome];
    assert.equal(v1.status, v2.status, outcome);
    assert.deepEqual(classifyUpstreamCancel(v1.status, v1.body), { kind }, outcome);
  }
  // 409 / 503 bodies are byte-identical; a v1 200 only adds v1's own keys beside the same `cancel` block.
  for (const outcome of ['not_canceled_paid', 'not_canceled_processing', 'not_confirmed']) {
    assert.deepEqual(FIXTURE.cancel_v1[outcome].body, FIXTURE.cancel_v2[outcome].body, outcome);
  }
  for (const outcome of ['canceled', 'already_canceled']) {
    assert.deepEqual(FIXTURE.cancel_v1[outcome].body.cancel, FIXTURE.cancel_v2[outcome].body.cancel, outcome);
  }
  // v1 still says 403 for another agent's order (v2 says 404): never canceled.
  const other = FIXTURE.cancel_v1.other_agent;
  assert.equal(other.status, 403);
  assert.notEqual(classifyUpstreamCancel(other.status, other.body).kind, CANCEL_KIND.canceled);
});

test('the "not canceled" answers each say canceled:false and carry the code the gateway keys on', () => {
  for (const [outcome, code] of [['not_canceled_paid', 'ORDER_ALREADY_PAID'], ['not_canceled_processing', 'PAYMENT_PROCESSING'], ['not_confirmed', 'CANCEL_NOT_CONFIRMED']]) {
    for (const door of ['cancel_v1', 'cancel_v2']) {
      const { detail } = FIXTURE[door][outcome].body;
      assert.equal(detail.canceled, false, `${door} ${outcome}`);
      assert.equal(detail.error, code, `${door} ${outcome}`);
    }
  }
});

// ---- POST /agent/v1/payments on a canceled order ---------------------------------------------------------------

test('the recorded 409 ORDER_CANCELED is a non-retriable ORDER_CANCELED on every op, money ops included', async () => {
  const { status, body } = FIXTURE.payments_v1.order_canceled;
  assert.equal(status, 409);
  // The codes the gateway's extractUpstreamErrorCode reads (the unified envelope's details.error, and detail.error).
  assert.equal(body.error.details.error, 'ORDER_CANCELED');
  assert.equal(body.detail.error, 'ORDER_CANCELED');
  for (const operation of ['submit_payment', 'submit_delegated_payment', 'create_payment_link', 'create_order', 'get_order_status']) {
    assert.equal(mapUpstreamErrorToKernelCode({ operation, upstreamCode: 'ORDER_CANCELED', status }), 'ORDER_CANCELED', operation);
  }
  const { ERROR_CATALOG, isPivotaErrorCode, PivotaCommerceError } = await import('../safety-kernel/src/errors.js');
  const { toToolError } = await import('../mcp-server/src/commerceToolSurface.js');
  assert.ok(isPivotaErrorCode('ORDER_CANCELED'));
  assert.equal(ERROR_CATALOG.ORDER_CANCELED.retriable, false);
  assert.doesNotMatch(ERROR_CATALOG.ORDER_CANCELED.userMessage, /try again shortly|temporarily/i);
  const tool = JSON.parse(toToolError(new PivotaCommerceError('ORDER_CANCELED', { operation: 'submit_delegated_payment' })).content[0].text);
  assert.deepEqual([tool.error.code, tool.error.retriable], ['ORDER_CANCELED', false]);
  assert.equal(tool.error.message, ERROR_CATALOG.ORDER_CANCELED.userMessage);
  assert.match(ERROR_CATALOG.ORDER_CANCELED.recovery, /^do not retry/);
  const acp = fs.readFileSync(path.join(__dirname, '..', 'safety-kernel', 'src', 'protocol', 'acpRestAdapter.js'), 'utf8');
  assert.match(acp.split('const STATUS_BY_CODE')[1].split('});')[0], /ORDER_CANCELED:\s*409/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const statusFn = server.split('function statusForCommerceKernelError')[1].split('\n}\n')[0];
  assert.match(statusFn, /case 'ORDER_CANCELED':\s*\n(?:\s*case '[A-Z_]+':\s*\n)*\s*return 409;/);
});

// ---- the storefront hand-off read (esc_) --------------------------------------------------------------------------

function handoffClient(recorded) {
  const { fetchImpl, calls } = replay(recorded);
  const client = createStorefrontHandoffClient({
    baseUrl: 'http://backend.contract.test',
    fetchImpl,
    authHeaders: () => ({ 'X-API-Key': 'gateway-key-fake' }),
    signRequest: () => ({ 'X-Pivota-Issuing-Agent': 'v2.fake.fake' }),
  });
  return { client, calls };
}

test('the recorded hand-off reads: the owner is accepted, the other partner is not_owner, an unknown record not_found', async () => {
  const rec = FIXTURE.handoff_read;
  const own = await handoffClient(rec.owner).client.read(rec.record_id, rec.escalation_id);
  assert.equal(own.kind, 'accepted');
  assert.equal(own.handoff.record_id, rec.record_id);
  assert.equal((await handoffClient(rec.other_partner).client.read(rec.record_id, rec.escalation_id)).kind, 'not_owner');
  assert.equal((await handoffClient(rec.unknown_record).client.read(rec.record_id, rec.escalation_id)).kind, 'not_found');
  // The record answer the write path keys on.
  assert.deepEqual(rec.record.body, { record_id: rec.record_id, status: 'handed_off' });
});

// ---- the rail purchase read (pp_ / rp_) ---------------------------------------------------------------------------

function purchaseClient(recorded) {
  const { fetchImpl, calls } = replay(recorded);
  const client = createAgentPurchaseReadClient({
    baseUrl: 'http://backend.contract.test',
    fetchImpl,
    authHeaders: () => ({ 'X-API-Key': 'ak_fake', 'X-Agent-User-JWT': 'buyer.token.fake' }),
  });
  return { client, calls };
}

test('the recorded purchase reads: the owner is accepted under both ids, another agent or buyer is not_found', async () => {
  const rec = FIXTURE.purchase_read;
  const byPp = await purchaseClient(rec.owner_by_pp).client.getPurchase(rec.purchase_id);
  const byRp = await purchaseClient(rec.owner_by_rp).client.getPurchase(rec.rail_purchase_id);
  for (const answered of [byPp, byRp]) {
    assert.equal(answered.kind, 'accepted');
    assert.equal(answered.purchase.purchase_id, rec.purchase_id);
  }
  for (const [label, recorded, id] of [
    ['other_agent', rec.other_agent, rec.purchase_id],
    ['other_agent_rp', rec.other_agent_rp, rec.rail_purchase_id],
    ['other_buyer', rec.other_buyer, rec.purchase_id],
  ]) {
    assert.deepEqual(await purchaseClient(recorded).client.getPurchase(id), { kind: 'not_found', code: 'purchase_not_found' }, label);
  }
});

// ---- the kernel order read (plain id) -----------------------------------------------------------------------------

test('the recorded order routes: the owner reads the row; another agent is 403 and an unknown id 404, both "not found" to the gateway', () => {
  const rec = FIXTURE.order_read;
  assert.equal(rec.order.status, 200);
  assert.equal(rec.tracking.status, 200);
  assert.equal(typeof rec.order.body.order.state, 'string', 'kernelOrderStatusResult reads order.state');
  for (const k of ['other_agent_order', 'other_agent_tracking']) assert.equal(rec[k].status, 403, k);
  for (const k of ['unknown_order', 'unknown_tracking']) assert.equal(rec[k].status, 404, k);
  // throwKernelOrderReadNotFound (src/server.js) turns exactly these two statuses into QUOTE_NOT_FOUND.
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  const fn = server.split('async function throwKernelOrderReadNotFound')[1].split('\n}\n')[0];
  assert.match(fn, /status !== 403 && status !== 404/);
});

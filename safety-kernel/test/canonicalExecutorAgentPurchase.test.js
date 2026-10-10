// get_order for a rail purchase (`pp_…`): the executor routes it to the injected `readAgentPurchase` (the
// backend's owner-scoped rail-neutral read) instead of the kernel order store, and maps the read's outcome.
// Null from the reader (its dial is off) must leave get_order exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SafetyKernel } from '../src/kernel.js';
import { createCanonicalExecutor } from '../src/protocol/canonicalExecutor.js';

const SECRET = 'exec-secret-0123456789abcdef';
const CTX = { user_ref: 'user_1', acp_session_id: 'acp_1' };
const PID = 'pp_0123456789abcdef01234567';
const quiet = { info() {}, warn() {}, error() {} };
const PURCHASE = { purchase_id: PID, rail: 'reap', state: 'completed', rail_state: 'completed', order_reference: 'ord_1' };

function setup(readAgentPurchase) {
  const kernel = new SafetyKernel({ upstream: async () => ({}), secret: SECRET, log: quiet });
  const reads = [];
  const calls = [];
  const exec = createCanonicalExecutor({
    kernel,
    upstream: async (op, payload) => { reads.push({ op, payload }); return { ok: true }; },
    readAgentPurchase: readAgentPurchase && (async (id, ctx) => { calls.push({ id, ctx }); return readAgentPurchase(id, ctx); }),
  });
  return { exec: exec.execute, reads, calls };
}

test('a pp_ id is answered by the purchase read, not the kernel store or the order upstream', async () => {
  const { exec, reads, calls } = setup(async () => ({ kind: 'accepted', purchase: PURCHASE }));
  const out = await exec('get_order', { order_id: PID }, CTX);
  assert.equal(out.order_id, PID);
  assert.equal(out.status, 'completed');
  assert.equal(out.source, 'agent_purchase');
  assert.equal(out.order_reference, 'ord_1');
  assert.deepEqual(calls.map((c) => c.id), [PID]);
  assert.equal(reads.length, 0, 'no kernel get_order_status upstream read');
});

test('not_found is the SAME answer an untracked kernel order gets', async () => {
  const { exec } = setup(async () => ({ kind: 'not_found', code: 'purchase_not_found' }));
  await assert.rejects(exec('get_order', { order_id: PID }, CTX),
    (e) => e.code === 'QUOTE_NOT_FOUND' && e.detail?.reason === 'order_not_found');
  const kernelOnly = setup(undefined);
  await assert.rejects(kernelOnly.exec('get_order', { order_id: 'o_untracked' }, CTX),
    (e) => e.code === 'QUOTE_NOT_FOUND' && e.detail?.reason === 'order_not_found');
});

test('unavailable is retriable MERCHANT_UNAVAILABLE, never "not found" (which would invite a second purchase)', async () => {
  for (const answered of [{ kind: 'unavailable', code: 'timeout' }, { kind: 'surprise' }]) {
    const { exec } = setup(async () => answered);
    await assert.rejects(exec('get_order', { order_id: PID }, CTX),
      (e) => e.code === 'MERCHANT_UNAVAILABLE' && e.detail?.reason === 'agent_purchase_read_unavailable');
  }
});

test('unauthenticated maps to USER_AUTH_REQUIRED', async () => {
  const { exec } = setup(async () => ({ kind: 'unauthenticated' }));
  await assert.rejects(exec('get_order', { order_id: PID }, CTX), (e) => e.code === 'USER_AUTH_REQUIRED');
});

test('a null answer (dial off) falls through to the kernel path unchanged: fail closed, no upstream read', async () => {
  const { exec, reads, calls } = setup(async () => null);
  await assert.rejects(exec('get_order', { order_id: PID }, CTX), (e) => e.code === 'QUOTE_NOT_FOUND');
  assert.equal(calls.length, 1);
  assert.equal(reads.length, 0);
});

test('only a well-formed pp_ id reaches the reader; kernel ids never do', async () => {
  const { exec, calls } = setup(async () => ({ kind: 'accepted', purchase: PURCHASE }));
  for (const id of ['o_exec', 'rp_0123456789abcdef01234567', 'pp_short', `${PID}x`]) {
    await assert.rejects(exec('get_order', { order_id: id }, CTX), (e) => e.code === 'QUOTE_NOT_FOUND');
  }
  assert.equal(calls.length, 0);
});

test('the contract gates still run first: no buyer or no session never reaches the reader', async () => {
  const { exec, calls } = setup(async () => ({ kind: 'accepted', purchase: PURCHASE }));
  await assert.rejects(exec('get_order', { order_id: PID }, { acp_session_id: 'acp_1' }), (e) => e.code === 'USER_AUTH_REQUIRED');
  await assert.rejects(exec('get_order', { order_id: PID }, { user_ref: 'user_1' }), (e) => e.code === 'STATE_LINKAGE_MISMATCH');
  assert.equal(calls.length, 0);
});

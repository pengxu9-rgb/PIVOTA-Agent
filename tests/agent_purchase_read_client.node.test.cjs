'use strict';

// src/services/agentPurchaseReadClient.js — get_order's read of the backend's rail-neutral purchase
// (`GET /agent/v2/commerce/purchases/{pp_id}`, pivota-backend docs/agent_purchases_routes.md), plus its
// production wiring in src/server.js. The backend is a STUBBED fetchImpl answering in the backend's own
// envelope shapes (the 404 envelope is the one ErrorHandlerMiddleware writes).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAgentPurchaseReadClient,
  AGENT_PURCHASES_PATH,
} = require('../src/services/agentPurchaseReadClient');

const PID = 'pp_0123456789abcdef01234567';
const API_KEY = 'ak_agent_fixture';
const USER_JWT = 'eyJ.user.fixture';
const FULL_AUTH = () => ({ 'X-API-Key': API_KEY, 'X-Agent-User-JWT': USER_JWT });

const PURCHASE = {
  purchase_id: PID,
  rail: 'reap',
  executor: 'rail_managed',
  rail_purchase_id: 'rp_0123456789abcdef01234567',
  state: 'completed',
  rail_state: 'completed',
  order_reference: 'ord_merchant_1',
  totals: { currency: 'USD', final_total_minor: 4650 },
  detail: { state: 'completed' },
};

function envelope404(reason) {
  return {
    status: 'error',
    error: { code: 'PRODUCT_NOT_FOUND', message: reason, details: { error: reason } },
    detail: { error: reason },
    metadata: { request_id: 'r', timestamp: 't' },
  };
}

function fakeBackend(answer) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push({ url, ...init });
    const out = typeof answer === 'function' ? await answer(url, init) : answer;
    return { status: out.status, text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)) };
  }
  return { calls, fetchImpl };
}

function client(answer, auth = FULL_AUTH, extra = {}) {
  const backend = fakeBackend(answer);
  const c = createAgentPurchaseReadClient({ baseUrl: 'https://backend.example/', authHeaders: auth, fetchImpl: backend.fetchImpl, ...extra });
  return { c, backend };
}

test('accepted: one GET to the unified path with the caller\'s two headers, body returned whole', async () => {
  const { c, backend } = client({ status: 200, body: PURCHASE });
  const out = await c.getPurchase(PID);
  assert.deepEqual(out, { kind: 'accepted', purchase: PURCHASE });
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].url, `https://backend.example${AGENT_PURCHASES_PATH}/${PID}`);
  assert.equal(backend.calls[0].method, 'GET');
  assert.equal(backend.calls[0].redirect, 'error');
  assert.equal(backend.calls[0].headers['X-API-Key'], API_KEY);
  assert.equal(backend.calls[0].headers['X-Agent-User-JWT'], USER_JWT);
});

test('a 200 for a DIFFERENT purchase, or without a state, is malformed, never accepted', async () => {
  for (const body of [{ ...PURCHASE, purchase_id: 'pp_ffffffffffffffffffffffff' }, { ...PURCHASE, state: undefined }, [PURCHASE], 'not json']) {
    const { c } = client({ status: 200, body });
    assert.deepEqual(await c.getPurchase(PID), { kind: 'unavailable', code: 'malformed' });
  }
});

test('404 purchase_not_found is not_found; every other refusal is unavailable, never a statement about the purchase', async () => {
  assert.deepEqual(await client({ status: 404, body: envelope404('purchase_not_found') }).c.getPurchase(PID),
    { kind: 'not_found', code: 'purchase_not_found' });
  const dark = await client({ status: 404, body: envelope404('not_available') }).c.getPurchase(PID);
  assert.equal(dark.kind, 'unavailable');
  assert.equal(dark.code, 'not_available');
  const bare404 = await client({ status: 404, body: '' }).c.getPurchase(PID);
  assert.equal(bare404.kind, 'unavailable', 'a 404 without the backend envelope (a platform 404) is not an owner miss');
  for (const status of [401, 403, 429, 503, 500]) {
    const out = await client({ status, body: { detail: { error: 'state_unmapped' } } }).c.getPurchase(PID);
    assert.equal(out.kind, 'unavailable', String(status));
  }
});

test('transport failure and timeout are unavailable', async () => {
  const broken = await client(async () => { throw new Error('ECONNRESET'); }).c.getPurchase(PID);
  assert.deepEqual(broken, { kind: 'unavailable', code: 'transport' });
  const slow = client(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), FULL_AUTH, { timeoutMs: 50 });
  assert.deepEqual(await slow.c.getPurchase(PID), { kind: 'unavailable', code: 'timeout' });
});

test('no caller key or no buyer token: unauthenticated and NO request', async () => {
  for (const auth of [() => ({ 'X-Agent-User-JWT': USER_JWT }), () => ({ 'X-API-Key': API_KEY }), () => { throw new Error('ctx'); }]) {
    const { c, backend } = client({ status: 200, body: PURCHASE }, auth);
    assert.deepEqual(await c.getPurchase(PID), { kind: 'unauthenticated' });
    assert.equal(backend.calls.length, 0);
  }
});

test('an rp_ id is accepted when the body names it as rail_purchase_id, and the answer still carries a pp_ id', async () => {
  const RID = 'rp_0123456789abcdef01234567';
  const { c, backend } = client({ status: 200, body: PURCHASE });
  assert.deepEqual(await c.getPurchase(RID), { kind: 'accepted', purchase: PURCHASE });
  assert.equal(backend.calls[0].url.endsWith(`/${RID}`), true);
  const other = client({ status: 200, body: { ...PURCHASE, rail_purchase_id: 'rp_ffffffffffffffffffffffff' } });
  assert.deepEqual(await other.c.getPurchase(RID), { kind: 'unavailable', code: 'malformed' });
  const noPp = client({ status: 200, body: { ...PURCHASE, purchase_id: RID } });
  assert.deepEqual(await noPp.c.getPurchase(RID), { kind: 'unavailable', code: 'malformed' }, 'purchase_id must be a pp_ id');
});

test('the client and the executor match the same ids (no drift)', async () => {
  const { AGENT_PURCHASE_ID_RE } = require('../src/services/agentPurchaseReadClient');
  const executor = await import('../safety-kernel/src/protocol/canonicalExecutor.js');
  assert.equal(AGENT_PURCHASE_ID_RE.source, executor.AGENT_PURCHASE_ID_RE.source);
  assert.equal(AGENT_PURCHASE_ID_RE.flags, executor.AGENT_PURCHASE_ID_RE.flags);
});

test('only a well-formed pp_/rp_ id is ever sent', async () => {
  for (const id of ['xp_0123456789abcdef01234567', 'pp_short', 'pp_0123456789ABCDEF01234567', `${PID}/../x`, '', null]) {
    const { c, backend } = client({ status: 200, body: PURCHASE });
    assert.deepEqual(await c.getPurchase(id), { kind: 'not_found', code: 'invalid_id' });
    assert.equal(backend.calls.length, 0);
  }
});

test('logs carry no id, header or body', async () => {
  const lines = [];
  const logger = { info: (f) => lines.push(JSON.stringify(f)), warn: (f) => lines.push(JSON.stringify(f)) };
  await client({ status: 200, body: PURCHASE }, FULL_AUTH, { logger }).c.getPurchase(PID);
  await client({ status: 404, body: envelope404('purchase_not_found') }, FULL_AUTH, { logger }).c.getPurchase(PID);
  const text = lines.join('\n');
  for (const secret of [PID, API_KEY, USER_JWT, 'ord_merchant_1']) assert.equal(text.includes(secret), false, secret);
  assert.ok(lines.length >= 2);
});

// ── production wiring (src/server.js) ─────────────────────────────────────────────────────────────

test('server wiring: caller headers only, never the internal key; the dial gates the read per call', async (t) => {
  const priorKey = process.env.PIVOTA_API_KEY;
  t.after(() => { if (priorKey === undefined) delete process.env.PIVOTA_API_KEY; else process.env.PIVOTA_API_KEY = priorKey; });
  process.env.PIVOTA_API_KEY = priorKey || 'internal-key-fixture';
  const server = require('../src/server');
  const strict = server._debug.__agentCheckoutStrict;
  const backend = fakeBackend({ status: 200, body: PURCHASE });
  const c = strict.buildAgentPurchaseReadClient(null, { fetchImpl: backend.fetchImpl, baseUrl: 'https://backend.example' });
  const read = strict.buildReadAgentPurchase(c);

  const prior = process.env.AGENT_PURCHASE_ORDER_READ_ENABLED;
  try {
    delete process.env.AGENT_PURCHASE_ORDER_READ_ENABLED;
    assert.equal(strict.isAgentPurchaseOrderReadEnabled(), false, 'default OFF');
    const off = await strict.runInInvokeAuthContextForTest({ api_key: API_KEY, agent_user_jwt: USER_JWT }, () => read(PID));
    assert.equal(off, null, 'dial off: not handled, the kernel path answers');
    assert.equal(backend.calls.length, 0);

    process.env.AGENT_PURCHASE_ORDER_READ_ENABLED = 'true';
    const on = await strict.runInInvokeAuthContextForTest({ api_key: API_KEY, agent_user_jwt: USER_JWT, buyer_ref: 'b' }, () => read(PID));
    assert.equal(on.kind, 'accepted');
    assert.equal(backend.calls[0].headers['X-API-Key'], API_KEY);
    assert.equal(backend.calls[0].headers['X-Agent-User-JWT'], USER_JWT);
    assert.equal(Object.hasOwn(backend.calls[0].headers, 'X-Buyer-Ref'), false);

    const noKey = await strict.runInInvokeAuthContextForTest({ agent_user_jwt: USER_JWT }, () => read(PID));
    assert.equal(noKey.kind, 'unauthenticated', 'no caller key -> no request, NOT the internal key');
    assert.equal(backend.calls.length, 1);

    const mismatch = await strict.runInInvokeAuthContextForTest(
      { api_key: API_KEY, agent_user_jwt: USER_JWT, agent_id: 'agent_a' }, () => read(PID, { agent_id: 'agent_b' }));
    assert.deepEqual(mismatch, { kind: 'identity_mismatch' }, 'ctx and request name different agents -> refuse');
    assert.equal(backend.calls.length, 1, 'no request on a mismatch');
    const same = await strict.runInInvokeAuthContextForTest(
      { api_key: API_KEY, agent_user_jwt: USER_JWT, agent_id: 'agent_a' }, () => read(PID, { agent_id: 'agent_a' }));
    assert.equal(same.kind, 'accepted');
  } finally {
    if (prior === undefined) delete process.env.AGENT_PURCHASE_ORDER_READ_ENABLED;
    else process.env.AGENT_PURCHASE_ORDER_READ_ENABLED = prior;
  }
});

'use strict';

// Cold partner search on the commerce/public MCP lanes was taking ~2x the work it actually did.
//
// Measured on prod 2026-08-05 for ONE search: attempt 1 started 02:35:19.2, the 10s loopback budget
// aborted it at 02:35:29.4, attempt 2 re-ran the entire pipeline and answered in 9.3s at 02:35:38.4 —
// 19.3s delivered for 9.3s of work. The self-call is loopback, so a timeout there is not a transient
// network fault, and aborting the client does not stop the server: the retry runs the whole expensive
// pipeline a second time, concurrently, against a 5-connection DB pool.
//
// Both halves of the fix are asserted ON THE REAL ROUTE (supertest + nock on the loopback), because both
// are wiring: a pure-function assertion would pass with the wiring deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');
const supertest = require('supertest');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.PORT = '3999';
process.env.PUBLIC_READ_MCP_ENABLED = '1';
// The projected-result cache would answer without ever reaching the loopback; this suite is about the
// loopback, so compute every time.
process.env.PUBLIC_READ_CACHE_ENABLED = '0';
// Arm the retry we assert is NOT taken. With this off the retry test would pass for the wrong reason.
process.env.UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT = 'true';

// Squeeze the OUTBOUND budget below the self-invoke budget so the two differ observably. Without the
// unsafe-lower opt-in this is clamped up to the 8s safe floor and the widening becomes untestable.
process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER = 'true';
process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = '1500';
process.env.SELF_INVOKE_TIMEOUT_MS = '6000';

const app = require('../src/server');
const { resolveSelfInvokeBudget } = app._debug;

const LOOPBACK = 'http://127.0.0.1:3999';
const SEARCH_RESULT = { status: 'success', success: true, products: [{ id: 'p1', title: 'probe' }], total: 1 };

function searchRpc(query, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_catalog', arguments: { query } } };
}

/** Intercept the loopback invoke, delaying `delayMs` before answering. Returns an attempt counter. */
function interceptLoopback(delayMs) {
  const state = { attempts: 0 };
  state.scope = nock(LOOPBACK)
    .persist()
    .post('/agent/shop/v1/invoke')
    .reply(function reply() {
      state.attempts += 1;
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve([200, SEARCH_RESULT]), delayMs);
        if (t && typeof t.unref === 'function') t.unref();
      });
    });
  return state;
}

test.afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

// -- budget relationships (the shipped default is asserted on the wire, below) ---------------------------

test('the self-invoke budget widens a narrower outbound default', () => {
  assert.equal(resolveSelfInvokeBudget(1500), 6000);
});

test('a wider outbound default is never narrowed', () => {
  assert.equal(resolveSelfInvokeBudget(45000), 45000);
});

test('an explicit AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS still wins', () => {
  process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS = '7000';
  try {
    assert.equal(resolveSelfInvokeBudget(1500), 7000);
  } finally {
    delete process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS;
  }
});

// -- the wiring, on the surface that actually runs -------------------------------------------------------

test('a loopback search slower than the OUTBOUND budget still succeeds (the widened budget is applied)', async () => {
  // 3s sits above the 1.5s outbound budget and below the 6s self-invoke budget. Reverting the
  // `selfInvoked ? resolveSelfInvokeBudget(timeout) : timeout` wiring makes this request time out, so
  // this test — not the pure-function ones above — is what pins the widening.
  const state = interceptLoopback(3000);
  try {
    const resp = await supertest(app)
      .post('/public/mcp')
      .set('X-Forwarded-For', '10.7.7.7, 203.0.113.91')
      .send(searchRpc('widened budget probe'))
      .expect(200);
    const result = resp.body.result;
    // The public tier answers with a human summary + structuredContent; a refused/timed-out call comes
    // back as isError with an error payload instead.
    assert.notEqual(
      result.isError,
      true,
      `expected the slow-but-within-budget loopback search to succeed, got ${JSON.stringify(result.content)}`,
    );
    assert.match(result.content[0].text, /found/i);
    assert.equal(state.attempts, 1, `expected exactly one attempt, saw ${state.attempts}`);
  } finally {
    state.scope.persist(false);
  }
});

test('a timed-out loopback search is attempted ONCE, not retried', async () => {
  // 9s outlives even the self-invoke budget, so the request genuinely times out — the condition that
  // used to trigger a second full pipeline run.
  const state = interceptLoopback(9000);
  try {
    await supertest(app)
      .post('/public/mcp')
      .set('X-Forwarded-For', '10.7.7.8, 203.0.113.92')
      .send(searchRpc('retry probe'));
    // Let an (incorrect) retry land before counting.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(state.attempts, 1, `loopback search must be attempted once; saw ${state.attempts}`);
  } finally {
    state.scope.persist(false);
  }
});

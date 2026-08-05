'use strict';

// Cold partner search on the commerce/public MCP lanes was taking ~2x the work it actually did.
//
// Measured on prod 2026-08-05 for ONE search: attempt 1 started 02:35:19.2, the 10s loopback budget
// aborted it at 02:35:29.4, attempt 2 re-ran the entire pipeline and answered in 9.3s at 02:35:38.4 —
// 19.3s delivered for 9.3s of work. The self-call is loopback, so a timeout there is not a transient
// network fault, and aborting the client does not stop the server: the retry runs the whole expensive
// pipeline a second time, concurrently, against a 5-connection DB pool.
//
// These tests assert the two properties that fix costs: ONE attempt on the loopback, and a diagnostics
// query that can never extend a partner's latency.

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
// Arm the retry we are asserting is NOT taken. With this off the test would pass for the wrong reason.
process.env.UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT = 'true';
// NOTE: SELF_INVOKE_TIMEOUT_MS is deliberately left at its default here so the budget assertions below
// exercise the real shipped value. The wire test narrows the budget per-call instead.

const app = require('../src/server');
const { resolveSelfInvokeBudget, attachCanonicalChainRecallTelemetryFromPromise } = app._debug;

const LOOPBACK = 'http://127.0.0.1:3999';

test.after(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

// -- the budget ---------------------------------------------------------------------------------------

test('self-invoke budget widens the outbound default rather than inheriting it', () => {
  // The outbound-upstream budget (10s in prod) sat just under the inner search p50, so ordinary jitter
  // tipped every slow query into a re-execution. The loopback must get the wider budget.
  assert.equal(resolveSelfInvokeBudget(10000), 30000);
  assert.equal(resolveSelfInvokeBudget(0), 30000);
});

test('a wider outbound default is never narrowed by the self-invoke budget', () => {
  assert.equal(resolveSelfInvokeBudget(45000), 45000);
});

test('an explicit AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS still wins', () => {
  process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS = '7000';
  try {
    assert.equal(resolveSelfInvokeBudget(10000), 7000);
  } finally {
    delete process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS;
  }
});

// -- the diagnostics await ----------------------------------------------------------------------------

test('a hung canonical-chain telemetry query does NOT extend the response', async () => {
  const body = { products: [{ id: 'p1' }], metadata: { existing: true } };
  const neverResolves = new Promise(() => {});
  const startedAt = Date.now();
  const out = await attachCanonicalChainRecallTelemetryFromPromise(body, neverResolves);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3000, `expected the budget to release the response, waited ${elapsed}ms`);
  // Degrading costs metadata, never products.
  assert.deepEqual(out.products, body.products);
  assert.equal(out.metadata.existing, true);
});

test('a rejected telemetry query is swallowed and never becomes an unhandled rejection', async () => {
  const body = { products: [] };
  const out = await attachCanonicalChainRecallTelemetryFromPromise(body, Promise.reject(new Error('db down')));
  assert.deepEqual(out, body);
  // Give the microtask queue a turn: an unhandled rejection would surface here.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test('telemetry that resolves within budget is still attached', async () => {
  const body = { products: [], metadata: {} };
  const resolved = Promise.resolve({ telemetry: { canonical_path_executed: true, canonical_returned_count: 3 } });
  const out = await attachCanonicalChainRecallTelemetryFromPromise(body, resolved);
  assert.notDeepEqual(out.metadata, {}, 'expected telemetry to reach metadata when it arrives in time');
});

// -- the wiring, on the surface that actually runs ------------------------------------------------------

test('a timed-out loopback search is attempted ONCE, not retried', async () => {
  nock.cleanAll();
  // Narrow the loopback budget for this call only (this override wins inside resolveSelfInvokeBudget), so
  // the hung interceptor below trips it in 300ms instead of 30s.
  process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS = '300';

  let attempts = 0;
  const scope = nock(LOOPBACK)
    .persist()
    .post('/agent/shop/v1/invoke')
    .reply(function reply() {
      attempts += 1;
      // Outlive the 300ms budget so axios aborts, which is the condition that used to trigger the retry.
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve([200, { products: [] }]), 2000);
        if (t && typeof t.unref === 'function') t.unref();
      });
    });

  try {
    await supertest(app)
      .post('/public/mcp')
      .set('X-Forwarded-For', '10.7.7.7, 203.0.113.99')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_catalog', arguments: { query: 'self invoke retry probe' } },
      });
    // Let any (incorrect) retry land before we count.
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(attempts, 1, `loopback search must be attempted once; saw ${attempts}`);
  } finally {
    delete process.env.AGENT_CHECKOUT_UPSTREAM_TIMEOUT_MS;
    scope.persist(false);
    nock.cleanAll();
    nock.enableNetConnect();
  }
});

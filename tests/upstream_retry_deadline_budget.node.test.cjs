'use strict';

// A retry that the caller's hard deadline will cut off is not a retry, it is a delay plus an extra request.
//
// The find_products_multi mainline had exactly that shape: a 6000ms non-beauty hard deadline racing a chain
// whose first attempt times out at 4500ms, with the timeout-retry enabled. The retry therefore began with
// 1500ms left to redo work that had just failed to finish in 4500ms — impossible by construction — so its
// only effects were +1500ms of latency and a second request fired at an upstream that was, by definition,
// already struggling. Measured on prod 2026-08-05, primary_upstream stamped ~6002ms and returned 0 rows.
//
// These tests drive the real callUpstreamWithOptionalRetry with a stubbed HTTP layer.

const test = require('node:test');
const assert = require('node:assert/strict');
const nock = require('nock');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
// find_products_multi only joins the timeout-retryable set when this is on, which is prod's setting. With
// it off these tests would pass for the wrong reason.
process.env.UPSTREAM_RETRY_FIND_PRODUCTS_MULTI_ON_TIMEOUT = 'true';

// Pose the route in the PRODUCTION SHAPE: deadline strictly ABOVE the attempt timeout, which is the only
// arrangement in which the doomed retry can occur. The knob that makes this possible is
// UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS — it caps BOTH the attempt (min(G, budget)) and the deadline
// (min(D_env, G)), so it must be raised above the budget for the two to decouple. All read at module load.
process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_ALLOW_UNSAFE_LOWER = 'true';
process.env.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS = '4000';
process.env.FIND_PRODUCTS_MULTI_UPSTREAM_LOOKUP_TIMEOUT_MS = '1500';
process.env.FIND_PRODUCTS_MULTI_UPSTREAM_DEFAULT_TIMEOUT_MS = '1800';
process.env.FIND_PRODUCTS_MULTI_NON_BEAUTY_PRIMARY_DEADLINE_MS = '2900';
process.env.PROXY_SEARCH_RESOLVER_FIRST_ENABLED = 'false';
process.env.API_MODE = 'REAL';
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:4599';
const TEST_KEY = `ak_${'a'.repeat(64)}`;
process.env.PIVOTA_API_KEY = TEST_KEY;
delete process.env.DATABASE_URL;

const app = require('../src/server');
const { callUpstreamWithOptionalRetry } = app._debug;

const HOST = 'http://127.0.0.1:4123';
const PATH = '/agent/v2/products/search';

/** Intercept the upstream, never answering, so every attempt ends in an axios timeout. */
function interceptHanging() {
  const state = { attempts: 0 };
  state.scope = nock(HOST)
    .persist()
    .get(PATH)
    .reply(function reply() {
      state.attempts += 1;
      return new Promise((resolve) => {
        setTimeout(() => resolve([200, { products: [] }]), 30000);
      });
    });
  return state;
}

function config(timeoutMs) {
  return { method: 'GET', url: `${HOST}${PATH}`, timeout: timeoutMs };
}

test.afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

test('with no deadline, a timed-out search still retries (unchanged legacy behaviour)', async () => {
  const state = interceptHanging();
  try {
    await assert.rejects(() => callUpstreamWithOptionalRetry('find_products_multi', config(150), {}));
    assert.equal(state.attempts, 2, `expected the legacy retry; saw ${state.attempts} attempt(s)`);
  } finally {
    state.scope.persist(false);
  }
});

test('THE FIX: a retry the deadline cannot accommodate is not started', async () => {
  // The production shape: deadline only slightly beyond the attempt timeout. 150ms attempt, 200ms of
  // deadline — the retry would have ~50ms to redo work that just failed in 150ms.
  const state = interceptHanging();
  const startedAt = Date.now();
  try {
    await assert.rejects(() =>
      callUpstreamWithOptionalRetry('find_products_multi', config(150), {
        deadlineAtMs: Date.now() + 200,
      }));
    assert.equal(state.attempts, 1, `a doomed retry must not be started; saw ${state.attempts} attempts`);
    // And the caller gets its answer at the first timeout rather than burning the rest of the deadline.
    assert.ok(Date.now() - startedAt < 400, 'must fail fast on the first timeout');
  } finally {
    state.scope.persist(false);
  }
});

test('a retry the deadline CAN accommodate still runs', async () => {
  // Widen the deadline and the retry becomes worth starting again — the rule is "can it finish", not
  // "is there a deadline".
  const state = interceptHanging();
  try {
    await assert.rejects(() =>
      callUpstreamWithOptionalRetry('find_products_multi', config(150), {
        deadlineAtMs: Date.now() + 5000,
      }));
    assert.equal(state.attempts, 2, `a viable retry must still run; saw ${state.attempts} attempt(s)`);
  } finally {
    state.scope.persist(false);
  }
});

// NOTE: there is deliberately no "retry timeout is clamped to the deadline" test. An earlier draft clamped
// it; review showed the clamp buys nothing (the caller already races the chain) while making axios abort a
// moment BEFORE the race, which swapped the deadline error for a bare timeout and silently dropped the
// deadline's telemetry. The clamp was removed; the race is the enforcement point.

// -- the wiring, on the surface that actually runs --------------------------------------------------------

const supertest = require('supertest');

test('WIRING: the route threads its hard deadline into the retry decision', async () => {
  // The tests above pass deadlineAtMs themselves, so they prove the POLICY and not the WIRING — deleting
  // `deadlineAtMs` from the callTrackedUpstream call site leaves every one of them green. This drives the
  // real invoke route with a hanging backend, in the production shape (1500ms attempt under a 2900ms
  // deadline), and counts UPSTREAM ATTEMPTS: one with the wiring, two without it.
  let attempts = 0;
  nock.cleanAll();
  const hang = () => {
    attempts += 1;
    return new Promise((resolve) => { setTimeout(() => resolve([200, { products: [] }]), 30000); });
  };
  const scope = nock('http://127.0.0.1:4599').persist();
  scope.post(/\/agent\/v[12]\/products\/search/).query(true).reply(hang);
  scope.get(/\/agent\/v[12]\/products\/search/).query(true).reply(hang);

  const startedAt = Date.now();
  try {
    const res = await supertest(app)
      .post('/agent/shop/v1/invoke')
      .set('x-agent-api-key', TEST_KEY)
      .send({
        operation: 'find_products_multi',
        metadata: { source: 'shopping_agent' },
        payload: { search: { query: 'running shoes', page_size: 5 } },
      });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(attempts, 1, `the deadline cannot accommodate a retry; expected 1 attempt, saw ${attempts}`);
    assert.ok(elapsedMs < 2400, `expected to fail fast at the first timeout, took ${elapsedMs}ms`);
    // Declining the retry must still be reported AS a deadline outcome. Skipping quietly would buy latency
    // by deleting the very signal an operator uses to see this guard working.
    const metadata = (res.body && res.body.metadata) || {};
    assert.equal(metadata.fpm_primary_deadline_applied, true, 'deadline telemetry must survive the skip');
    assert.equal(metadata.strict_empty_reason, 'shopping_mainline_non_beauty_primary_deadline');
  } finally {
    nock.cleanAll();
    nock.enableNetConnect();
  }
});

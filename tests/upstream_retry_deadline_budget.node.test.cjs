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

// Arm the non-beauty primary deadline JUST ABOVE the attempt timeout the route actually uses — that
// narrow gap is the production shape (6000ms deadline over a 4500ms attempt). Measured, not assumed: this
// lane arms 1800ms regardless of the *_UPSTREAM_*_TIMEOUT_MS knobs below, so an earlier draft of this test
// put the deadline UNDER the attempt timeout, the first attempt never aborted, and the retry branch it
// exists to exercise never ran at all. Read at module load, so set before the server is required.
process.env.FIND_PRODUCTS_MULTI_NON_BEAUTY_PRIMARY_DEADLINE_MS = '2200';
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:4599';
const TEST_KEY = `ak_${'a'.repeat(64)}`;
process.env.PIVOTA_API_KEY = TEST_KEY;

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

test('a viable retry never arms a timeout longer than the deadline allows', async () => {
  // getTimeoutRetryMs would hand this op a 10s retry timeout. Inside a ~1.2s remaining budget that number
  // is a fiction: the race abandons the request first. Clamping keeps the armed timeout honest.
  const state = interceptHanging();
  let armedTimeout = null;
  const cfg = config(150);
  try {
    await assert.rejects(() =>
      callUpstreamWithOptionalRetry('find_products_multi', cfg, {
        deadlineAtMs: Date.now() + 1400,
        onRetry: () => { armedTimeout = cfg.timeout; },
      }));
    assert.equal(state.attempts, 2);
    assert.ok(armedTimeout !== null, 'expected the retry to have been taken');
    assert.ok(
      armedTimeout <= 1400,
      `retry timeout ${armedTimeout}ms must be clamped to the remaining deadline, not the op default`,
    );
  } finally {
    state.scope.persist(false);
  }
});

// -- WHY THERE IS NO ROUTE-LEVEL TEST HERE ----------------------------------------------------------------
//
// A route-level test was written and then DELETED, because it passed with the wiring
// (`deadlineAtMs` at the callTrackedUpstream call site) deleted — it advertised coverage it did not have,
// which is the exact "test that cannot fail" shape this repo has shipped before.
//
// The reason it could not discriminate, recorded so the next person does not spend the same hour: the
// mainline primary does not use the *_UPSTREAM_*_TIMEOUT_MS knobs this suite can set (it armed 1800ms
// regardless), and whether the retry starts at all turns out to depend on the deadline itself — measured,
// with the deadline at 5000ms the retry fires at ~1800ms, and at 2200ms it never fires. So the harness
// cannot be posed in the production shape (4500ms attempt under a 6000ms deadline) where the doomed retry
// actually occurs.
//
// That shape IS real: prod logs 2026-08-05 02:12-02:13 show `previous_timeout_ms=4500 retry_timeout_ms=10000`
// on the primary, with `primary_upstream` then stamping ~6002ms — attempt aborted at 4.5s, retry started,
// deadline killed it 1.5s later. The POLICY above is mutation-covered; the one-line wiring that feeds it is
// verified only by reading. Said plainly rather than papered over with a green test.

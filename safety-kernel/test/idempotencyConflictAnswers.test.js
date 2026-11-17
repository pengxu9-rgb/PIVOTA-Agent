// A KEY THAT CANNOT RUN THIS REQUEST NOW IS NEVER TOLD TO START AGAIN.
//
// IDEMPOTENCY_CONFLICT is answered for a missing or reused key, and for a key whose attempt is still running, was taken
// over, or may have taken effect, and for an order whose payment was already asked for. Each says what is true there
// (errors.js IDEMPOTENCY_CONFLICT_ANSWERS, and the catalog's own words for the rest); none says "Starting fresh", which an
// agent obeys by opening a second checkout while the first may have placed an order.
// Every name is a placeholder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CATALOG, IDEMPOTENCY_CONFLICT_ANSWERS, PivotaCommerceError, idempotencyConflict } from '../src/errors.js';
import { IdempotencyLedger } from '../src/idempotencyLedger.js';
import { InMemoryKvStore } from '../src/stores.js';
import { NO_EFFECT } from '../test-support/noEffectWords.js';

const START_AGAIN = /start(?:ing)? (?:fresh|over|again)|different request reusing an old reference/i;

function assertConflict(err, reason, label, { orderId } = {}) {
  const words = IDEMPOTENCY_CONFLICT_ANSWERS[reason];
  assert.ok(err instanceof PivotaCommerceError, `${label}: ${err}`);
  assert.deepEqual([err.code, err.retriable, err.detail.reason, err.detail.acp_message], ['IDEMPOTENCY_CONFLICT', false, reason, words.message], label);
  assert.deepEqual(err.detail.acp_detail, orderId ? { reason, order_id: orderId } : { reason }, label);
  assert.doesNotMatch(`${words.message} ${words.recovery}`, START_AGAIN, label);
  assert.doesNotMatch(`${words.message} ${words.recovery}`, NO_EFFECT, label);
}

test('the words: the catalog and every named conflict answer say nothing of starting again, and say nothing had no effect', () => {
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    assert.doesNotMatch(`${entry.userMessage} ${entry.recovery}`, START_AGAIN, code);
  }
  const generic = ERROR_CATALOG.IDEMPOTENCY_CONFLICT;
  assert.match(generic.userMessage, /missing or too short, or an earlier request with other details already used it/);
  assert.match(generic.userMessage, /do not start another checkout for this purchase without the buyer/);
  assert.doesNotMatch(`${generic.userMessage} ${generic.recovery}`, NO_EFFECT);
  for (const [reason, words] of Object.entries(IDEMPOTENCY_CONFLICT_ANSWERS)) {
    assert.match(words.message, /get_order|checkout session or its order/, reason);
    assert.doesNotMatch(`${words.message} ${words.recovery}`, START_AGAIN, reason);
    assert.doesNotMatch(`${words.message} ${words.recovery}`, NO_EFFECT, reason);
  }
  assert.match(IDEMPOTENCY_CONFLICT_ANSWERS.in_flight.message, /still running, and its outcome is not known yet/);
  assert.match(IDEMPOTENCY_CONFLICT_ANSWERS.charge_pending.message, /\(detail\.order_id\) was already asked for, and its outcome is not known yet/);
  // An answer that names the order is given only the caller's own order id; one that does not never carries it.
  assert.throws(() => idempotencyConflict('charge_pending', { order_id: 'o_1' }), /names the caller's own order/);
  assert.deepEqual(idempotencyConflict('charge_in_progress', { order_id: 'o_1' }, { ownedOrderId: 'o_1' }).detail.acp_detail, { reason: 'charge_in_progress' });
  assert.throws(() => idempotencyConflict('no_such_reason'), /Unknown idempotency conflict reason/);
});

test('the ledger: a same-key resend while the first attempt is still running, a key held a moment ago, and a key taken over after the op each get their own words; the op runs once', async () => {
  const ledger = new IdempotencyLedger();
  let release;
  let runs = 0;
  const held = new Promise((r) => { release = r; });
  const first = ledger.run('idem-flight-0001', { a: 1 }, async () => { runs += 1; await held; return { order_id: 'o_1' }; });
  const second = await ledger.run('idem-flight-0001', { a: 1 }, async () => { runs += 1; return {}; }).then(() => null, (e) => e);
  assertConflict(second, 'in_flight', 'in flight');
  release();
  assert.deepEqual((await first).result, { order_id: 'o_1' });
  assert.equal(runs, 1);
  const replay = await ledger.run('idem-flight-0001', { a: 1 }, async () => { runs += 1; return {}; });
  assert.deepEqual([replay.replayed, replay.result, runs], [true, { order_id: 'o_1' }, 1], 'the first attempt\'s answer, once it finished');

  // The claim lost, then nothing there: the attempt that held it ended a moment ago.
  const gone = new IdempotencyLedger({ store: { putIfAbsent: async () => false, get: async () => null } });
  assertConflict(await gone.run('idem-race-00001', {}, async () => ({})).then(() => null, (e) => e), 'race', 'race');

  // The op ran, and another attempt took the key over before it finished.
  const store = new InMemoryKvStore();
  store.compareAndSet = async () => false;
  let ran = 0;
  const lost = await new IdempotencyLedger({ store }).run('idem-lease-0001', {}, async () => { ran += 1; return {}; }).then(() => null, (e) => e);
  assertConflict(lost, 'lease_lost_after_op', 'lease lost');
  assert.equal(ran, 1);

  // A key reused for a request with other details keeps the catalog's words, which are true there.
  const reused = await ledger.run('idem-flight-0001', { a: 2 }, async () => ({})).then(() => null, (e) => e);
  assert.deepEqual([reused.code, reused.detail.reason, reused.userMessage], ['IDEMPOTENCY_CONFLICT', undefined, ERROR_CATALOG.IDEMPOTENCY_CONFLICT.userMessage]);
});

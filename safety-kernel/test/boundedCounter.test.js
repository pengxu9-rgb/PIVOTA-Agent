// incrementCounterBelow / decrementCounter: the atomic bounded counter the merchant quote rate limit uses.
// The same cases run on the in-memory store and on PostgresKvStore over the SQL-semantics fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryKvStore } from '../src/stores.js';
import { PostgresKvStore } from '../src/stores/postgresKvStore.js';
import { makeFakePgDb } from './helpers/fakePgDb.js';

const BACKENDS = {
  memory: (now) => new InMemoryKvStore({ now }),
  postgres: (now) => new PostgresKvStore({ db: makeFakePgDb(now), namespace: 'counter_test', now }),
};
const stores = (now) => Object.entries(BACKENDS).map(([name, make]) => [name, make(now)]);

test('counts up to the limit, then refuses without changing the count', async () => {
  for (const [name, store] of stores(() => 1_000)) {
    const counts = [];
    for (let i = 0; i < 4; i += 1) counts.push(await store.incrementCounterBelow('k', 3, { ttlMs: 60_000 }));
    assert.deepEqual(counts, [1, 2, 3, null], name);
    assert.deepEqual(await store.get('k'), { count: 3 }, name);
  }
});

test('an expired counter restarts at 1 with the new expiry; a live one keeps its expiry', async () => {
  for (const [name, make] of Object.entries(BACKENDS)) {
    let clock = 0;
    const store = make(() => clock);
    assert.equal(await store.incrementCounterBelow('k', 1, { ttlMs: 1_000 }), 1, name);
    clock = 500;
    // A live counter at its limit is refused, and the refusal does not extend its life.
    assert.equal(await store.incrementCounterBelow('k', 1, { ttlMs: 60_000 }), null, name);
    // Past the expiry (the two stores differ only at the exact instant, which this avoids).
    clock = 1_001;
    assert.equal(await store.incrementCounterBelow('k', 1, { ttlMs: 1_000 }), 1, name);
    clock = 2_000;
    assert.equal(await store.incrementCounterBelow('k', 1, { ttlMs: 1_000 }), null, name);
  }
});

test('a live record that is not a counter is never overwritten or counted', async () => {
  for (const [name, store] of stores(() => 1_000)) {
    await store.set('k', { claim: 'other-owner' }, { ttlMs: 60_000 });
    assert.equal(await store.incrementCounterBelow('k', 5, { ttlMs: 60_000 }), null, name);
    assert.equal(await store.decrementCounter('k'), false, name);
    assert.deepEqual(await store.get('k'), { claim: 'other-owner' }, name);
  }
});

test('decrement gives one back, never below zero, and never on an absent key', async () => {
  for (const [name, store] of stores(() => 1_000)) {
    assert.equal(await store.decrementCounter('missing'), false, name);
    await store.incrementCounterBelow('k', 2, { ttlMs: 60_000 });
    await store.incrementCounterBelow('k', 2, { ttlMs: 60_000 });
    assert.equal(await store.decrementCounter('k'), true, name);
    assert.equal(await store.incrementCounterBelow('k', 2, { ttlMs: 60_000 }), 2, name);
    assert.equal(await store.decrementCounter('k'), true, name);
    assert.equal(await store.decrementCounter('k'), true, name);
    assert.equal(await store.decrementCounter('k'), false, name);
    assert.deepEqual(await store.get('k'), { count: 0 }, name);
  }
});

test('concurrent increments admit exactly the limit', async () => {
  for (const [name, store] of stores(() => 1_000)) {
    const results = await Promise.all(Array.from({ length: 25 }, () => store.incrementCounterBelow('k', 7, { ttlMs: 60_000 })));
    assert.equal(results.filter((count) => count !== null).length, 7, name);
    assert.deepEqual(results.filter((count) => count !== null).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7], name);
  }
});

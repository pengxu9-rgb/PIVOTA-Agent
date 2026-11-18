'use strict';

// PostgresKvStore.incrementCounterBelow / decrementCounter on a REAL PostgreSQL, under real concurrency.
// The unit tests (safety-kernel/test/boundedCounter.test.js) run the store over a fake that matches the
// SQL text and re-implements its meaning in JS, so only this file runs the statements themselves. The
// merchant quote rate limit depends on them: a counter must never pass its limit across instances, an
// expired row must restart exactly once, a refund must never go below zero, and a record that is not a
// counter must never be counted or overwritten.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const MIGRATION = path.join(__dirname, '..', '..', 'safety-kernel', 'migrations', '050_commerce_kv.sql');
const INSTANCES = 8;
const PER_INSTANCE = 25;
const NS = 'bounded_counter_test';
const TTL_MS = 60_000;

test('bounded counter SQL on PostgreSQL', { skip: url ? false : 'CANONICAL_MAINLINE_TEST_DATABASE_URL is unset' }, async (t) => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('bounded counter Postgres tests require a local database');
  }
  const { PostgresKvStore } = await import('../../safety-kernel/src/stores/postgresKvStore.js');
  const schema = `bounded_counter_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  // One pool per simulated gateway instance, each with its own connections (80 in all, within the default
  // max_connections of 100 that the CI service runs with). Each instance queues 25 racers on its 10.
  const pools = Array.from({ length: INSTANCES }, () => new Pool({
    connectionString: url, max: 10, options: `-c search_path=${schema}`,
  }));
  t.after(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  await pools[0].query(fs.readFileSync(MIGRATION, 'utf8'));
  const stores = pools.map((db) => new PostgresKvStore({ db, namespace: NS }));
  const [store] = stores;
  const row = async (k) => (await pools[0].query(
    'SELECT v, expires_at FROM commerce_kv WHERE ns = $1 AND k = $2', [NS, k])).rows[0];
  const everyone = (fn) => Promise.all(stores.flatMap((s) => Array.from({ length: PER_INSTANCE }, () => fn(s))));

  await t.test('first inserts racing on a fresh key admit exactly the limit, once each', async () => {
    const counts = await everyone((s) => s.incrementCounterBelow('fresh', 37, { ttlMs: TTL_MS }));
    const admitted = counts.filter((count) => count !== null).sort((a, b) => a - b);
    assert.deepEqual(admitted, Array.from({ length: 37 }, (_, i) => i + 1));
    assert.deepEqual((await row('fresh')).v, { count: 37 });
  });

  await t.test('an expired row is restarted exactly once, with a new expiry', async () => {
    await store.incrementCounterBelow('restart', 37, { ttlMs: TTL_MS });
    await pools[0].query(
      `UPDATE commerce_kv SET v = '{"count": 37}'::jsonb, expires_at = now() - interval '1 second' WHERE ns = $1 AND k = $2`,
      [NS, 'restart']);
    const counts = await everyone((s) => s.incrementCounterBelow('restart', 10, { ttlMs: TTL_MS }));
    const admitted = counts.filter((count) => count !== null);
    assert.equal(admitted.length, 10);
    assert.equal(admitted.filter((count) => count === 1).length, 1);
    const after = await row('restart');
    assert.deepEqual(after.v, { count: 10 });
    assert.ok(after.expires_at.getTime() > Date.now());
  });

  await t.test('a live counter keeps its expiry when counted or refused', async () => {
    await store.incrementCounterBelow('expiry', 2, { ttlMs: TTL_MS });
    const first = (await row('expiry')).expires_at.getTime();
    await store.incrementCounterBelow('expiry', 2, { ttlMs: 10 * TTL_MS });
    assert.equal(await store.incrementCounterBelow('expiry', 2, { ttlMs: 10 * TTL_MS }), null);
    assert.equal((await row('expiry')).expires_at.getTime(), first);
  });

  await t.test('racing decrements stop at zero; an expired or absent row is never decremented', async () => {
    for (let i = 0; i < 5; i += 1) await store.incrementCounterBelow('refund', 5, { ttlMs: TTL_MS });
    const done = await everyone((s) => s.decrementCounter('refund'));
    assert.equal(done.filter(Boolean).length, 5);
    assert.deepEqual((await row('refund')).v, { count: 0 });
    assert.equal(await store.decrementCounter('absent'), false);
    await store.incrementCounterBelow('dead', 5, { ttlMs: TTL_MS });
    await pools[0].query(`UPDATE commerce_kv SET expires_at = now() - interval '1 second' WHERE ns = $1 AND k = $2`, [NS, 'dead']);
    assert.equal(await store.decrementCounter('dead'), false);
    assert.deepEqual((await row('dead')).v, { count: 1 });
  });

  await t.test('interleaved increments and decrements keep the count exact and within 0..limit', async () => {
    let increments = 0;
    let decrements = 0;
    let peak = 0;
    await Promise.all(stores.flatMap((s, i) => Array.from({ length: 40 }, async (_, j) => {
      if ((i + j) % 3 === 0) {
        if (await s.decrementCounter('mixed')) decrements += 1;
      } else {
        const count = await s.incrementCounterBelow('mixed', 7, { ttlMs: TTL_MS });
        if (count !== null) {
          increments += 1;
          peak = Math.max(peak, count);
        }
      }
    })));
    const { count } = (await row('mixed')).v;
    assert.equal(count, increments - decrements);
    assert.ok(count >= 0 && count <= 7 && peak <= 7);
  });

  await t.test('a live record that is not a counter is never counted or overwritten', async () => {
    await store.set('claim', { claim: 'owner' }, { ttlMs: TTL_MS });
    const counts = await everyone((s) => s.incrementCounterBelow('claim', 5, { ttlMs: TTL_MS }));
    assert.ok(counts.every((count) => count === null));
    assert.equal(await store.decrementCounter('claim'), false);
    assert.deepEqual((await row('claim')).v, { claim: 'owner' });
  });
});

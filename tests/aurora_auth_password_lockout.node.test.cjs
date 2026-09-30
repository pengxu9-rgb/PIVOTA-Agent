'use strict';

// Aurora password login lockout: the attempt is reserved by one guarded UPDATE before the scrypt
// comparison (the same shape as the login-code cap), so the lockout counts every comparison.
// pg-mem runs the shipped 013 + 014 DDL; concurrency is pinned on real PostgreSQL in
// tests/integration/aurora_otp_start_atomic_postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeAuroraAuthDb } = require('./fixtures/auroraAuthPgMem.cjs');

const AUTH_STORE_ID = require.resolve('../src/auroraBff/authStore');
const DB_MODULE = require('../src/db');

const ENV = {
  AURORA_BFF_AUTH_ENABLED: 'true',
  AURORA_BFF_AUTH_PEPPER: 'test-pepper',
  AURORA_BFF_AUTH_PASSWORD_SCRYPT_N: '1024',
  AURORA_BFF_AUTH_PASSWORD_MAX_ATTEMPTS: '',
  AURORA_BFF_AUTH_PASSWORD_LOCKOUT_MS: '',
};

function loadAuthStore(db) {
  const previous = {};
  for (const [k, v] of Object.entries(ENV)) {
    previous[k] = process.env[k];
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
  const originals = { query: DB_MODULE.query, withClient: DB_MODULE.withClient };
  DB_MODULE.query = db.query;
  DB_MODULE.withClient = db.withClient;
  delete require.cache[AUTH_STORE_ID];
  try {
    return require('../src/auroraBff/authStore');
  } finally {
    Object.assign(DB_MODULE, originals);
    delete require.cache[AUTH_STORE_ID];
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function userWithPassword(email, password) {
  const db = makeAuroraAuthDb();
  const store = loadAuthStore(db);
  const userId = `usr_${email.split('@')[0]}`;
  await db.query('INSERT INTO aurora_users (user_id, email) VALUES ($1, $2)', [userId, email]);
  await store.setUserPassword({ userId, password });
  return { db, store, userId };
}

async function userRow(db, userId) {
  return (await db.query(
    'SELECT password_failed_attempts, password_locked_until FROM aurora_users WHERE user_id = $1',
    [userId],
  )).rows[0];
}

test('the 5th wrong password locks the account; the right password is refused while locked', async () => {
  const email = 'lock@example.com';
  const { db, store, userId } = await userWithPassword(email, 'correct horse');
  for (let i = 1; i <= 4; i += 1) {
    const out = await store.verifyPasswordForEmail({ email, password: `wrong-${i}` });
    assert.deepEqual(out, { ok: false, reason: 'mismatch', locked_until: null }, `wrong ${i}`);
  }
  const fifth = await store.verifyPasswordForEmail({ email, password: 'wrong-5' });
  assert.equal(fifth.reason, 'mismatch');
  assert.ok(fifth.locked_until, 'the 5th wrong password sets the lock');
  const row = await userRow(db, userId);
  assert.equal(Number(row.password_failed_attempts), 5);
  assert.ok(row.password_locked_until);

  // Mutant killed: comparing before checking the lock.
  const right = await store.verifyPasswordForEmail({ email, password: 'correct horse' });
  assert.equal(right.ok, false);
  assert.equal(right.reason, 'locked');
});

test('four wrong passwords then the right one signs in and clears the count', async () => {
  const email = 'fifth-ok@example.com';
  const { db, store, userId } = await userWithPassword(email, 'correct horse');
  for (let i = 0; i < 4; i += 1) await store.verifyPasswordForEmail({ email, password: 'nope' });
  const ok = await store.verifyPasswordForEmail({ email, password: 'correct horse' });
  assert.equal(ok.ok, true);
  const row = await userRow(db, userId);
  assert.equal(Number(row.password_failed_attempts), 0);
  assert.equal(row.password_locked_until, null);
});

test('the right password on the 5th attempt signs in and clears the lock that attempt set', async () => {
  const email = 'fifth-right@example.com';
  const { db, store, userId } = await userWithPassword(email, 'correct horse');
  for (let i = 0; i < 4; i += 1) await store.verifyPasswordForEmail({ email, password: 'nope' });
  // Mutant killed: an off-by-one reservation that locks on the 4th, or refuses the 5th outright.
  assert.equal((await store.verifyPasswordForEmail({ email, password: 'correct horse' })).ok, true);
  assert.equal((await userRow(db, userId)).password_locked_until, null);
});

test('an expired lock starts a fresh count of five', async () => {
  const email = 'expiry@example.com';
  const { store } = await userWithPassword(email, 'correct horse');
  for (let i = 0; i < 5; i += 1) await store.verifyPasswordForEmail({ email, password: 'nope' });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 16 * 60_000;
    for (let i = 1; i <= 4; i += 1) {
      const out = await store.verifyPasswordForEmail({ email, password: 'nope' });
      assert.equal(out.locked_until, null, `fresh wrong ${i} does not re-lock`);
    }
    assert.ok((await store.verifyPasswordForEmail({ email, password: 'nope' })).locked_until);
  } finally {
    Date.now = realNow;
  }
});

test('the attempt is reserved before scrypt runs: a locked account costs no comparison', async () => {
  const email = 'noscrypt@example.com';
  const { store } = await userWithPassword(email, 'correct horse');
  for (let i = 0; i < 5; i += 1) await store.verifyPasswordForEmail({ email, password: 'nope' });
  const original = crypto.scrypt;
  let calls = 0;
  crypto.scrypt = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await store.verifyPasswordForEmail({ email, password: 'nope' })).reason, 'locked');
  } finally {
    crypto.scrypt = original;
  }
  assert.equal(calls, 0);
});

test('a failed reservation write fails closed (throws), it is not ignored', async () => {
  const email = 'dberr@example.com';
  const { db } = await userWithPassword(email, 'correct horse');
  const failing = {
    query: async (sql, params) => {
      if (/password_failed_attempts =\s*\(CASE/.test(sql)) throw Object.assign(new Error('db down'), { code: '57P01' });
      return db.query(sql, params);
    },
    withClient: db.withClient,
  };
  const broken = loadAuthStore(failing);
  // Mutant killed: swallowing the counter write (the old try/catch) and comparing anyway.
  await assert.rejects(broken.verifyPasswordForEmail({ email, password: 'correct horse' }), /db down/);
});

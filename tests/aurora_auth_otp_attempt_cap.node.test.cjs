'use strict';

// Aurora login codes: the wrong-guess cap, the per-email /start bound, and the constant-time compare.
//
// A code is 6 digits and a verified code buys a 30-day session. Before this, wrong guesses were
// counted (attempts + 1) but nothing ever read the count, so any code could be walked. The statements
// here run against the SHIPPED DDL (migration 013, read from disk, not retyped) in pg-mem, because the
// cap is a property of the SQL (a guarded UPDATE ... RETURNING), not of the JS around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

const MIGRATION_PATH = path.join(__dirname, '..', 'src', 'db', 'migrations', '013_aurora_accounts.sql');
const AUTH_STORE_ID = require.resolve('../src/auroraBff/authStore');
const DB_MODULE = require('../src/db');

const BASE_ENV = {
  AURORA_BFF_AUTH_ENABLED: 'true',
  AURORA_BFF_AUTH_PEPPER: 'test-pepper',
  // No provider -> email_not_configured; the debug flag hands the code back so the test can use it.
  AURORA_BFF_AUTH_EMAIL_PROVIDER: 'none',
  AURORA_BFF_AUTH_DEBUG_RETURN_CODE: 'true',
  AURORA_BFF_AUTH_DEBUG: '',
  AURORA_BFF_AUTH_OTP_MAX_ATTEMPTS: '',
  AURORA_BFF_AUTH_OTP_START_MAX_PER_EMAIL: '',
  AURORA_BFF_AUTH_OTP_START_WINDOW_MS: '',
};

function authTablesDdl() {
  // Only the tables authStore touches; the rest of 013 references tables from other migrations.
  return fs
    .readFileSync(MIGRATION_PATH, 'utf8')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /\b(aurora_users|aurora_auth_challenges|aurora_auth_sessions)\b/.test(s))
    .filter((s) => !/aurora_identity_links|aurora_account_/.test(s));
}

function makeDb() {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool();
  const ready = (async () => {
    for (const stmt of authTablesDdl()) await pool.query(stmt);
  })();
  const query = async (sql, params) => {
    await ready;
    return pool.query(sql, params);
  };
  return { query, ready };
}

// Loads a FRESH authStore bound to `query` — two loads over one db are two gateway instances.
function loadAuthStore(query, envOverrides = {}) {
  const env = { ...BASE_ENV, ...envOverrides };
  const previous = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    if (v === '' || v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const originalQuery = DB_MODULE.query;
  DB_MODULE.query = query;
  delete require.cache[AUTH_STORE_ID];
  try {
    return require('../src/auroraBff/authStore');
  } finally {
    DB_MODULE.query = originalQuery;
    delete require.cache[AUTH_STORE_ID];
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function wrongCodeFor(code) {
  return code === '123456' ? '654321' : '123456';
}

async function challengeRows(query, email) {
  const res = await query(
    'SELECT challenge_id, attempts, consumed_at FROM aurora_auth_challenges WHERE email = $1 ORDER BY created_at ASC',
    [email],
  );
  return res.rows;
}

test('the 5th wrong code closes the challenge; the right code is refused after that', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const email = 'cap@example.com';
  const { debug_code: code } = await store.createOtpChallenge({ email });
  assert.match(code, /^\d{6}$/);

  for (let i = 1; i <= 4; i += 1) {
    const out = await store.verifyOtpChallenge({ email, code: wrongCodeFor(code) });
    assert.deepEqual(out, { ok: false, reason: 'invalid_or_expired' }, `wrong guess ${i}`);
  }
  const fifth = await store.verifyOtpChallenge({ email, code: wrongCodeFor(code) });
  assert.deepEqual(fifth, { ok: false, reason: 'too_many_attempts' });

  // Mutant killed: a cap that only reports, or one that closes a guess late — the right code now fails.
  const right = await store.verifyOtpChallenge({ email, code });
  assert.equal(right.ok, false);
  assert.equal(right.reason, 'invalid_or_expired');

  const rows = await challengeRows(query, email);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].attempts), 5);
  assert.ok(rows[0].consumed_at, 'the capped challenge is closed in the row that holds the code');
});

test('four wrong codes then the right one still signs in (the cap is 5 guesses, not 4)', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const email = 'fifth-right@example.com';
  const { debug_code: code } = await store.createOtpChallenge({ email });
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await store.verifyOtpChallenge({ email, code: wrongCodeFor(code) })).ok, false);
  }
  // Mutant killed: an off-by-one cap (attempts < MAX - 1, or closing at MAX - 1).
  const out = await store.verifyOtpChallenge({ email, code });
  assert.equal(out.ok, true);
  assert.match(out.userId, /^usr_/);
});

test('after the cap only a new /start helps, and its code works', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const email = 'restart@example.com';
  const first = await store.createOtpChallenge({ email });
  for (let i = 0; i < 5; i += 1) await store.verifyOtpChallenge({ email, code: wrongCodeFor(first.debug_code) });
  assert.equal((await store.verifyOtpChallenge({ email, code: first.debug_code })).ok, false);

  const second = await store.createOtpChallenge({ email });
  assert.notEqual(second.challengeId, first.challengeId);
  assert.equal((await store.verifyOtpChallenge({ email, code: second.debug_code })).ok, true);
});

test('the counter is shared by every instance: 3 guesses on one + 2 on another close the code', async () => {
  const { query } = makeDb();
  const instanceA = loadAuthStore(query);
  const instanceB = loadAuthStore(query);
  const email = 'two-instances@example.com';
  const { debug_code: code } = await instanceA.createOtpChallenge({ email });
  for (let i = 0; i < 3; i += 1) await instanceA.verifyOtpChallenge({ email, code: wrongCodeFor(code) });
  for (let i = 0; i < 2; i += 1) await instanceB.verifyOtpChallenge({ email, code: wrongCodeFor(code) });
  // Mutant killed: a process-local counter (each instance would still allow its own 5).
  assert.equal((await instanceB.verifyOtpChallenge({ email, code })).ok, false);
  assert.equal((await instanceA.verifyOtpChallenge({ email, code })).ok, false);
});

test('concurrent guesses cannot exceed the cap: a burst of wrong codes then the right one is refused', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const email = 'burst@example.com';
  const { debug_code: code } = await store.createOtpChallenge({ email });
  const burst = await Promise.all(
    Array.from({ length: 12 }, () => store.verifyOtpChallenge({ email, code: wrongCodeFor(code) })),
  );
  assert.ok(burst.every((r) => r.ok === false));
  assert.equal((await store.verifyOtpChallenge({ email, code })).ok, false);
  const rows = await challengeRows(query, email);
  assert.ok(Number(rows[0].attempts) <= 5, `attempts never pass the cap (got ${rows[0].attempts})`);
});

test('a code signs in once: the second use of the same right code is refused', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const email = 'once@example.com';
  const { debug_code: code } = await store.createOtpChallenge({ email });
  assert.equal((await store.verifyOtpChallenge({ email, code })).ok, true);
  assert.deepEqual(await store.verifyOtpChallenge({ email, code }), { ok: false, reason: 'invalid_or_expired' });
});

test('concurrent uses of the right code mint exactly one session', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const email = 'race@example.com';
  const { debug_code: code } = await store.createOtpChallenge({ email });
  const outs = await Promise.all(Array.from({ length: 5 }, () => store.verifyOtpChallenge({ email, code })));
  // Mutant killed: consuming without `AND consumed_at IS NULL ... RETURNING` (every racer wins).
  assert.equal(outs.filter((o) => o.ok).length, 1);
});

test('no code, a wrong code and an expired code all give the same answer', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const none = await store.verifyOtpChallenge({ email: 'nobody@example.com', code: '123456' });

  const email = 'someone@example.com';
  const { debug_code: code } = await store.createOtpChallenge({ email });
  const wrong = await store.verifyOtpChallenge({ email, code: wrongCodeFor(code) });

  const realNow = Date.now;
  try {
    // Past the 10-minute TTL but inside the 15-minute retention, so the row is still there to close.
    Date.now = () => realNow() + 12 * 60_000;
    const expired = await store.verifyOtpChallenge({ email, code });
    // Mutant killed: distinct reasons ('not_found_or_expired' / 'code_mismatch' / 'expired') that say
    // whether a code was requested for this address.
    assert.deepEqual(none, { ok: false, reason: 'invalid_or_expired' });
    assert.deepEqual(wrong, none);
    assert.deepEqual(expired, none);
  } finally {
    Date.now = realNow;
  }
  // The expired challenge was closed, so its code does not come back to life (mutant killed: an
  // expiry answer that leaves the row open, which a clock step back would revive).
  assert.equal((await store.verifyOtpChallenge({ email, code })).ok, false);
});

test('/start is bounded per email across instances, whatever became of the earlier codes', async () => {
  const { query } = makeDb();
  const instanceA = loadAuthStore(query);
  const instanceB = loadAuthStore(query);
  const email = 'starts@example.com';

  // 1 used successfully, 1 capped, 3 simply superseded: all five count.
  const used = await instanceA.createOtpChallenge({ email });
  assert.equal((await instanceA.verifyOtpChallenge({ email, code: used.debug_code })).ok, true);
  const capped = await instanceB.createOtpChallenge({ email });
  for (let i = 0; i < 5; i += 1) await instanceB.verifyOtpChallenge({ email, code: wrongCodeFor(capped.debug_code) });
  await instanceA.createOtpChallenge({ email });
  await instanceB.createOtpChallenge({ email });
  await instanceA.createOtpChallenge({ email });

  // Mutant killed: counting only open challenges, or deleting superseded/used rows before the window ends.
  await assert.rejects(instanceB.createOtpChallenge({ email }), (err) => {
    assert.equal(err.code, 'AUTH_RATE_LIMITED');
    assert.equal(err.status, 429);
    assert.ok(err.retryAfterSec >= 1 && err.retryAfterSec <= 15 * 60, `retryAfterSec=${err.retryAfterSec}`);
    return true;
  });

  // Another address is untouched.
  assert.ok((await instanceA.createOtpChallenge({ email: 'other@example.com' })).debug_code);

  // After the window the email can start again.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 16 * 60_000;
    assert.ok((await instanceA.createOtpChallenge({ email })).debug_code);
  } finally {
    Date.now = realNow;
  }
});

test('the /start bound answers the same for an address with an account and one without', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  await query('INSERT INTO aurora_users (user_id, email) VALUES ($1, $2)', ['usr_known', 'known@example.com']);
  const outcomes = {};
  for (const email of ['known@example.com', 'unknown@example.com']) {
    const shapes = [];
    for (let i = 0; i < 5; i += 1) {
      const out = await store.createOtpChallenge({ email });
      shapes.push(Object.keys(out).sort().join(','));
    }
    const sixth = await store.createOtpChallenge({ email }).then(
      () => 'allowed',
      (err) => `${err.status}:${err.code}`,
    );
    outcomes[email] = { shapes, sixth };
  }
  assert.deepEqual(outcomes['known@example.com'], outcomes['unknown@example.com']);
  assert.equal(outcomes['known@example.com'].sixth, '429:AUTH_RATE_LIMITED');
});

test('the code comparison is constant-time (crypto.timingSafeEqual over the stored hash)', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const email = 'ct@example.com';
  const { debug_code: code } = await store.createOtpChallenge({ email });
  const [row] = (await query('SELECT code_hash FROM aurora_auth_challenges WHERE email = $1', [email])).rows;

  const original = crypto.timingSafeEqual;
  const calls = [];
  crypto.timingSafeEqual = (a, b) => {
    calls.push([Buffer.from(a).toString('utf8'), Buffer.from(b).toString('utf8')]);
    return original(a, b);
  };
  try {
    assert.equal((await store.verifyOtpChallenge({ email, code: wrongCodeFor(code) })).ok, false);
    assert.equal((await store.verifyOtpChallenge({ email, code })).ok, true);
  } finally {
    crypto.timingSafeEqual = original;
  }
  // Mutant killed: `expected === actual` (never calls timingSafeEqual).
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([expected]) => expected === row.code_hash));
});

test('hashesEqual refuses unequal, different-length and empty digests', () => {
  const { query } = makeDb();
  const { hashesEqual } = loadAuthStore(query).__test__;
  const a = 'a'.repeat(64);
  assert.equal(hashesEqual(a, a), true);
  assert.equal(hashesEqual(a, `${'a'.repeat(63)}b`), false);
  assert.equal(hashesEqual(a, 'a'.repeat(63)), false);
  assert.equal(hashesEqual('', ''), false);
  assert.equal(hashesEqual(null, null), false);
});

test('codes come from the CSPRNG (crypto.randomInt), six digits', async () => {
  const { query } = makeDb();
  const store = loadAuthStore(query);
  const original = crypto.randomInt;
  let calls = 0;
  crypto.randomInt = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    const { debug_code: code } = await store.createOtpChallenge({ email: 'rng@example.com' });
    assert.match(code, /^[1-9]\d{5}$/);
  } finally {
    crypto.randomInt = original;
  }
  // Mutant killed: Math.random().
  assert.equal(calls, 1);
});

test('the attempt cap and /start bound are configurable within safe bounds only', () => {
  const { query } = makeDb();
  const loose = loadAuthStore(query, {
    AURORA_BFF_AUTH_OTP_MAX_ATTEMPTS: '1000',
    AURORA_BFF_AUTH_OTP_START_MAX_PER_EMAIL: '1000',
  }).__test__;
  assert.equal(loose.OTP_MAX_ATTEMPTS, 10);
  assert.equal(loose.OTP_START_MAX_PER_EMAIL, 20);
  const junk = loadAuthStore(query, {
    AURORA_BFF_AUTH_OTP_MAX_ATTEMPTS: 'lots',
    AURORA_BFF_AUTH_OTP_START_MAX_PER_EMAIL: '0',
  }).__test__;
  assert.equal(junk.OTP_MAX_ATTEMPTS, 5);
  assert.equal(junk.OTP_START_MAX_PER_EMAIL, 1);
});

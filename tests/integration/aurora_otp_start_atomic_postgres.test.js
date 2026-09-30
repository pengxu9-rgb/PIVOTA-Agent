const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// Aurora sign-in bounds under REAL concurrency on PostgreSQL. pg-mem runs one statement at a time, so
// the pg-mem suites prove what the SQL says, not that it holds when four gateway instances race:
//   - /start: count + close + insert in one transaction under a per-email advisory lock. As three
//     autocommit statements, 40 concurrent calls minted 35-40 codes with 9-28 left open.
//   - migration 060: at most one open code per email (partial unique index), after closing the
//     duplicates the old race could leave behind.
//   - /verify: a guarded reservation before the compare, so a burst makes at most 5 comparisons.
//   - password login: the same reservation shape, so a burst makes at most 5 scrypt comparisons.
const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATIONS = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
const INSTANCES = 4;
const BURST = 40;

function statements(file) {
  return fs
    .readFileSync(path.join(MIGRATIONS, file), 'utf8')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const AUTH_ENV = {
  AURORA_BFF_AUTH_ENABLED: 'true',
  AURORA_BFF_AUTH_PEPPER: 'test-pepper',
  AURORA_BFF_AUTH_EMAIL_PROVIDER: 'none',
  AURORA_BFF_AUTH_DEBUG_RETURN_CODE: 'true',
  AURORA_BFF_AUTH_PASSWORD_SCRYPT_N: '1024',
};

suite('Aurora sign-in bounds on PostgreSQL under concurrency', () => {
  let admin;
  let pool;
  let schema;
  let instances;
  let priorEnv;

  const query = (sql, params) => pool.query(sql, params);
  const withClient = async (fn) => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };

  function loadInstance() {
    let store;
    jest.isolateModules(() => {
      jest.doMock('../../src/db', () => ({ query, withClient }));
      store = require('../../src/auroraBff/authStore');
    });
    return store;
  }

  const wrong = (code) => (code === '123456' ? '654321' : '123456');

  beforeAll(async () => {
    priorEnv = { ...process.env };
    Object.assign(process.env, AUTH_ENV);
    schema = `aurora_auth_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, max: 20, options: `-c search_path=${schema}` });

    const tables = statements('013_aurora_accounts.sql')
      .filter((s) => /\b(aurora_users|aurora_auth_challenges|aurora_auth_sessions)\b/.test(s))
      .filter((s) => !/aurora_identity_links|aurora_account_/.test(s));
    for (const stmt of tables) await query(stmt);
    for (const stmt of statements('014_aurora_password_auth.sql')) await query(stmt);

    // Leave behind what the old racing /start could: several open codes for one email.
    const insert = (id, email, createdAt) =>
      query(
        `INSERT INTO aurora_auth_challenges (challenge_id, email, code_hash, expires_at, created_at)
         VALUES ($1, $2, 'h', now() + interval '10 minutes', $3)`,
        [id, email, createdAt],
      );
    await insert('dup-1', 'dup@example.com', '2026-09-30T00:00:01Z');
    await insert('dup-2', 'dup@example.com', '2026-09-30T00:00:03Z');
    await insert('dup-3', 'dup@example.com', '2026-09-30T00:00:02Z');
    await insert('solo-1', 'solo@example.com', '2026-09-30T00:00:01Z');

    // Migration 060 exactly as shipped, in one transaction as src/db/migrate.js runs it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(MIGRATIONS, '060_aurora_auth_one_open_challenge_per_email.sql'), 'utf8'));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    instances = Array.from({ length: INSTANCES }, loadInstance);
  }, 60000);

  afterAll(async () => {
    process.env = priorEnv;
    if (pool) await pool.end();
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('migration 060 closes all but the newest open code per email, then allows only one open code', async () => {
    const open = await query(
      `SELECT email, challenge_id FROM aurora_auth_challenges WHERE consumed_at IS NULL AND email IN ('dup@example.com', 'solo@example.com') ORDER BY email`,
    );
    expect(open.rows).toEqual([
      { email: 'dup@example.com', challenge_id: 'dup-2' },
      { email: 'solo@example.com', challenge_id: 'solo-1' },
    ]);
    await expect(
      query(
        `INSERT INTO aurora_auth_challenges (challenge_id, email, code_hash, expires_at) VALUES ('solo-2', 'solo@example.com', 'h', now())`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  test(`${BURST} concurrent /start calls on ${INSTANCES} instances mint at most 5 codes and leave exactly 1 open`, async () => {
    const email = 'start-burst@example.com';
    const outcomes = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        instances[i % INSTANCES].createOtpChallenge({ email }).then(
          () => 'minted',
          (err) => (err.code === 'AUTH_RATE_LIMITED' ? 'limited' : `error:${err.code || err.message}`),
        ),
      ),
    );
    const minted = outcomes.filter((o) => o === 'minted').length;
    expect(outcomes.filter((o) => o.startsWith('error'))).toEqual([]);
    expect(minted).toBe(5);
    const rows = await query('SELECT consumed_at FROM aurora_auth_challenges WHERE email = $1', [email]);
    expect(rows.rows).toHaveLength(5);
    expect(rows.rows.filter((r) => r.consumed_at === null)).toHaveLength(1);
  });

  test(`${BURST} concurrent wrong codes make at most 5 comparisons, and the right code then fails`, async () => {
    const email = 'verify-burst@example.com';
    const { debug_code: code } = await instances[0].createOtpChallenge({ email });
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    const outs = await Promise.all(
      Array.from({ length: BURST }, (_, i) => instances[i % INSTANCES].verifyOtpChallenge({ email, code: wrong(code) })),
    );
    expect(outs.every((o) => o.ok === false && o.reason === 'invalid_or_expired')).toBe(true);
    // Exactly 5: the spy must see the comparisons (a vacuous 0 would pass a <= check).
    expect(compare.mock.calls.length).toBe(5);
    const [row] = (await query('SELECT attempts, consumed_at FROM aurora_auth_challenges WHERE email = $1', [email])).rows;
    expect(Number(row.attempts)).toBe(5);
    expect(row.consumed_at).not.toBeNull();
    expect((await instances[1].verifyOtpChallenge({ email, code })).ok).toBe(false);
  });

  test('concurrent uses of the right code across instances mint exactly one session', async () => {
    const email = 'race@example.com';
    const { debug_code: code } = await instances[2].createOtpChallenge({ email });
    const outs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => instances[i % INSTANCES].verifyOtpChallenge({ email, code })),
    );
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
  });

  test(`${BURST} concurrent wrong passwords make at most 5 scrypt comparisons, then the account is locked`, async () => {
    const email = 'pw-burst@example.com';
    await query('INSERT INTO aurora_users (user_id, email) VALUES ($1, $2)', ['usr_pwburst', email]);
    await instances[0].setUserPassword({ userId: 'usr_pwburst', password: 'correct horse' });
    const scrypt = jest.spyOn(crypto, 'scrypt');
    const outs = await Promise.all(
      Array.from({ length: BURST }, (_, i) => instances[i % INSTANCES].verifyPasswordForEmail({ email, password: `nope-${i}` })),
    );
    expect(outs.every((o) => o.ok === false)).toBe(true);
    expect(scrypt.mock.calls.length).toBe(5);
    const [row] = (await query('SELECT password_failed_attempts, password_locked_until FROM aurora_users WHERE email = $1', [email])).rows;
    expect(Number(row.password_failed_attempts)).toBe(5);
    expect(row.password_locked_until).not.toBeNull();
    expect((await instances[3].verifyPasswordForEmail({ email, password: 'correct horse' })).reason).toBe('locked');
  });
});

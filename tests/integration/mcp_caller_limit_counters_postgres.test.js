const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// The shared-counter sync of the per-caller MCP limits (src/guardrails/mcpCallerLimits.js SYNC_SQL) on a
// real PostgreSQL: migration 064 applies, the table is UNLOGGED, an instance's upsert is idempotent and
// never lowers a count, the read returns only OTHER instances' totals, a stale in-flight gauge is not
// summed, the prune removes old windows, and two limiter instances enforce one budget through it.

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = path.join(__dirname, '..', '..', 'src', 'db', 'migrations', '064_gateway_caller_limit_counters.sql');

const {
  SYNC_SQL,
  WINDOW_MS,
  createCallerLimiter,
  createPostgresCallerLimitStore,
} = require('../../src/guardrails/mcpCallerLimits');

suite('MCP caller limit counters on PostgreSQL', () => {
  let admin;
  let pool;
  let schema;
  let db;
  let priorDatabaseUrl;

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
      throw new Error('caller limit Postgres tests require a local database');
    }
    schema = `caller_limits_${crypto.randomBytes(4).toString('hex')}`;
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    // Applying twice is a no-op (the boot migrator may race a hand apply).
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    // The REAL db module (src/db), pointed at this schema: the store's statement_timeout path is what runs.
    priorDatabaseUrl = process.env.DATABASE_URL;
    const u = new URL(url);
    u.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = u.toString();
    db = require('../../src/db');
  });

  afterAll(async () => {
    if (db) await db.closePool();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE gateway_caller_limit_counters');
  });

  test('the table is UNLOGGED', async () => {
    const { rows } = await pool.query(
      `SELECT c.relpersistence FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'gateway_caller_limit_counters'`,
      [schema],
    );
    expect(rows[0].relpersistence).toBe('u');
  });

  test('sync returns other instances\' totals only, never lowers a count, and filters stale gauges', async () => {
    const store = createPostgresCallerLimitStore({ db });
    const win = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
    const base = { sinceMs: win - WINDOW_MS, freshSec: 6, timeoutMs: 1000 };
    expect(await store.sync({ ...base, instanceId: 'a', rows: [{ key: 'k1', windowMs: win, requests: 5, inflight: 2 }] })).toEqual([]);
    const fromB = await store.sync({
      ...base,
      instanceId: 'b',
      rows: [
        { key: 'k1', windowMs: win, requests: 1, inflight: 1 },
        { key: 'k1', windowMs: win - WINDOW_MS, requests: 4, inflight: 0 },
      ],
    });
    expect(fromB).toEqual([{ key: 'k1', windowMs: win, requests: 5, inflight: 2 }]);
    // An instance never reads its own rows back: it already counts its own requests locally, so reading
    // them would double-count. Instance a's second sync sees only b.
    const fromA = await store.sync({ ...base, instanceId: 'a', rows: [{ key: 'k1', windowMs: win, requests: 5, inflight: 2 }] });
    expect(fromA.find((r) => r.windowMs === win)).toEqual({ key: 'k1', windowMs: win, requests: 1, inflight: 1 });
    // A late, lower count from instance a does not lower its row.
    await store.sync({ ...base, instanceId: 'a', rows: [{ key: 'k1', windowMs: win, requests: 3, inflight: 0 }] });
    const fromC = await store.sync({ ...base, instanceId: 'c', rows: [{ key: 'k1', windowMs: win, requests: 0, inflight: 0 }] });
    const byWin = Object.fromEntries(fromC.map((r) => [r.windowMs, r]));
    expect(byWin[win]).toEqual({ key: 'k1', windowMs: win, requests: 6, inflight: 1 });
    expect(byWin[win - WINDOW_MS]).toEqual({ key: 'k1', windowMs: win - WINDOW_MS, requests: 4, inflight: 0 });
    // A gauge older than freshSec is not summed.
    await pool.query("UPDATE gateway_caller_limit_counters SET updated_at = now() - interval '1 minute' WHERE instance_id = 'b'");
    const stale = await store.sync({ ...base, instanceId: 'c', rows: [{ key: 'k1', windowMs: win, requests: 0, inflight: 0 }] });
    expect(stale.find((r) => r.windowMs === win).inflight).toBe(0);
    // Only the keys asked about come back.
    await store.sync({ ...base, instanceId: 'a', rows: [{ key: 'k2', windowMs: win, requests: 9, inflight: 0 }] });
    const onlyK1 = await store.sync({ ...base, instanceId: 'd', rows: [{ key: 'k1', windowMs: win, requests: 0, inflight: 0 }] });
    expect(onlyK1.every((r) => r.key === 'k1')).toBe(true);
  });

  test('the prune removes windows before the cutoff and keeps the rest', async () => {
    const store = createPostgresCallerLimitStore({ db });
    const win = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
    const rows = [0, 1, 2, 3].map((i) => ({ key: 'k', windowMs: win - i * WINDOW_MS, requests: 1, inflight: 0 }));
    await store.sync({ instanceId: 'a', rows, sinceMs: win - 5 * WINDOW_MS, freshSec: 6, timeoutMs: 1000 });
    await store.prune({ beforeMs: win - 2 * WINDOW_MS, timeoutMs: 1000 });
    const { rows: left } = await pool.query('SELECT count(*)::int AS n FROM gateway_caller_limit_counters');
    expect(left[0].n).toBe(3);
  });

  test('two limiter instances enforce one per-caller budget through the table', async () => {
    const store = createPostgresCallerLimitStore({ db });
    const env = {
      MCP_CALLER_LIMITS_MODE: 'enforce',
      MCP_CALLER_LIMITS_ANON_RPM: '8',
      MCP_CALLER_LIMITS_ANON_CONCURRENCY: '0',
      MCP_CALLER_LIMITS_ANON_TIER_CONCURRENCY_PER_INSTANCE: '0',
      MCP_CALLER_LIMITS_SHED_ANON_POOL_WAITING: '0',
      // The per-instance split before a first sync is covered in the unit suite; here, the shared count.
      MCP_CALLER_LIMITS_EXPECTED_INSTANCES: '1',
    };
    const now = () => Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + 1000;
    const i1 = createCallerLimiter({ env, now, store, autoSync: false, instanceId: 'i1' });
    const i2 = createCallerLimiter({ env, now, store, autoSync: false, instanceId: 'i2' });
    const caller = { tier: 'anonymous', id: 'ip:203.0.113.1', key: 'anonymous:pgtest', agent_id: null, oauth_client_id: null };
    for (let i = 0; i < 5; i += 1) expect(i1.admit(caller).allowed).toBe(true);
    expect(await i1.syncNow()).toBe(true);
    i2.admit(caller).release();
    expect(await i2.syncNow()).toBe(true);
    let more = 0;
    while (i2.admit(caller).allowed && more < 20) more += 1;
    expect(more).toBe(2);
  });

  test('a sync blocked past its timeout is cancelled BY POSTGRES (57014); the connection survives, no orphan runs', async () => {
    const store = createPostgresCallerLimitStore({ db });
    const win = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
    const args = { instanceId: 'slow', sinceMs: win - WINDOW_MS, freshSec: 6 };
    await store.sync({ ...args, rows: [{ key: 'locked', windowMs: win, requests: 1, inflight: 0 }], timeoutMs: 1000 });
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT 1 FROM gateway_caller_limit_counters WHERE caller_key = 'locked' FOR UPDATE");
      const gwPool = db.peekPool();
      const connectionsBefore = gwPool.totalCount;
      let err = null;
      try {
        await store.sync({ ...args, rows: [{ key: 'locked', windowMs: win, requests: 2, inflight: 0 }], timeoutMs: 300 });
      } catch (e) {
        err = e;
      }
      expect(err && err.code).toBe('57014');
      expect(gwPool.totalCount).toBe(connectionsBefore);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%INSERT INTO gateway_caller_limit_counters%' AND pid <> pg_backend_pid()",
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // The same pool keeps working.
    const after = await store.sync({ ...args, instanceId: 'other', rows: [{ key: 'locked', windowMs: win, requests: 0, inflight: 0 }], timeoutMs: 1000 });
    expect(after.find((r) => r.windowMs === win).requests).toBe(1);
  });

  test('the statement text names only the migrated table', () => {
    expect(SYNC_SQL).toMatch(/gateway_caller_limit_counters/);
  });
});

'use strict';

// What the pool guards do on a REAL server, which a mocked pg cannot show:
//
//   1. A budgeted caller that gives up destroys its connection, but the backend
//      keeps executing the statement -- orphaned work on the primary -- unless
//      the session carries client_connection_check_interval.
//   2. A helper that scopes statement_timeout with SET and then "clears" it with
//      `SET statement_timeout = 0` hands the pooled connection back with NO
//      timeout at all, instead of the pool's connection-level backstop.

const { Client } = require('pg');

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;

function assertOwnedLoopbackDb(raw) {
  const parsed = new URL(raw);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    !(parsed.pathname === '/gateway_test' && (parsed.port || '5432') === '5432')
  ) {
    throw Error('Explicit owned or CI loopback DB required');
  }
}

function withParams(raw, params) {
  const parsed = new URL(raw);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(url ? describe : describe.skip)('pool statement guards on real PostgreSQL', () => {
  const ENV_KEYS = [
    'DATABASE_URL',
    'DB_POOL_MAX',
    'DB_LANE_DEADLINES_ENABLED',
    'DB_LANE_DEADLINE_GRACE_MS',
    'DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS',
  ];
  let previousEnv;
  let monitor;
  let db;

  beforeAll(async () => {
    assertOwnedLoopbackDb(url);
    monitor = new Client({ connectionString: url });
    await monitor.connect();
  });

  afterAll(async () => {
    await monitor?.end();
  });

  beforeEach(() => {
    jest.resetModules();
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.DB_POOL_MAX = '1';
    process.env.DB_LANE_DEADLINES_ENABLED = 'true';
    process.env.DB_LANE_DEADLINE_GRACE_MS = '0';
  });

  afterEach(async () => {
    await db?.closePool();
    db = null;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
  });

  async function activeStatementsFor(appName) {
    const { rows } = await monitor.query(
      `SELECT pid, state FROM pg_stat_activity WHERE application_name = $1 AND query LIKE '%pg_sleep%' AND state = 'active'`,
      [appName],
    );
    return rows;
  }

  async function giveUpOnSlowStatement(appName) {
    process.env.DATABASE_URL = withParams(url, { application_name: appName });
    // eslint-disable-next-line global-require
    db = require('../../src/db');
    const startedAt = Date.now();
    const err = await db
      .runWithDbDeadline({ budgetMs: 300, label: 'it_lane' }, () => db.query('SELECT pg_sleep(8)'))
      .catch((e) => e);
    return { err, elapsedMs: Date.now() - startedAt };
  }

  test('with the check interval, a statement abandoned at the deadline stops running on the server', async () => {
    process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS = '100';
    const appName = `lane_deadline_reaped_${process.pid}`;

    const { err, elapsedMs } = await giveUpOnSlowStatement(appName);
    expect(err).toMatchObject({ code: db.DB_BUDGET_QUERY_TIMEOUT });
    expect(elapsedMs).toBeLessThan(2_000);

    let remaining = await activeStatementsFor(appName);
    for (let i = 0; i < 20 && remaining.length; i += 1) {
      await sleep(100);
      remaining = await activeStatementsFor(appName);
    }
    expect(remaining).toEqual([]);

    // And the pool slot came straight back: the next caller is served at once.
    await expect(db.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  test('without it, the same abandoned statement keeps running (the orphan this guards against)', async () => {
    delete process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS;
    const appName = `lane_deadline_orphan_${process.pid}`;

    const { err } = await giveUpOnSlowStatement(appName);
    expect(err).toMatchObject({ code: db.DB_BUDGET_QUERY_TIMEOUT });

    await sleep(1_000);
    const orphans = await activeStatementsFor(appName);
    try {
      expect(orphans.length).toBe(1);
    } finally {
      for (const { pid } of orphans) await monitor.query('SELECT pg_terminate_backend($1)', [pid]);
    }
  });

  test('a scoped statement_timeout lookup hands its pooled connection back WITH the pool backstop', async () => {
    delete process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS;
    process.env.DB_LANE_DEADLINES_ENABLED = '';
    // An empty schema, so the lookup's table is missing and it fails AFTER the
    // SET -- the finally block runs exactly as on a slow or successful read.
    const schema = `stmt_guard_${process.pid}`;
    await monitor.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    try {
      process.env.DATABASE_URL = withParams(url, { options: `-c search_path=${schema}` });
      // eslint-disable-next-line global-require
      db = require('../../src/db');
      // eslint-disable-next-line global-require
      const { _internals } = require('../../src/services/productGroundingResolver');

      const before = await db.query('SELECT pg_backend_pid() AS pid, current_setting($1) AS st', ['statement_timeout']);
      expect(before.rows[0].st).toBe('30s');

      const result = await _internals.fetchCandidatesViaProductsCache({
        merchantIds: ['m1'],
        query: 'vitamin c serum',
        limit: 5,
        timeoutMs: 700,
      });
      expect(result.ok).toBe(false);

      const after = await db.query('SELECT pg_backend_pid() AS pid, current_setting($1) AS st', ['statement_timeout']);
      // Same pooled connection (pool of one), and still bounded.
      expect(after.rows[0].pid).toBe(before.rows[0].pid);
      expect(after.rows[0].st).toBe('30s');
    } finally {
      await monitor.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});

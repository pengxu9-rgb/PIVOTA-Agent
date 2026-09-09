'use strict';

// The 2026-09-08 recall stall could not be attributed from outside the process:
// a pool that is full, an event loop that is blocked, and a server that is slow
// all present as "the caller waited and gave up". These fields separate them.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function buildPool({ connectImpl, totalCount = 3, idleCount = 1, waitingCount = 2 }) {
  const handlers = new Map();
  const pool = {
    totalCount, idleCount, waitingCount,
    on: jest.fn((event, fn) => { handlers.set(event, fn); }),
    end: jest.fn(async () => {}),
    query: jest.fn(async () => ({ rows: [] })),
    connect: jest.fn(async () => {
      const client = await connectImpl();
      const onConnect = handlers.get('connect');
      if (onConnect) onConnect(client);
      return client;
    }),
  };
  return pool;
}

function loadDb(pool) {
  jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
  jest.doMock('../src/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
  // eslint-disable-next-line global-require
  return require('../src/db');
}

describe('queryWithBudget diagnostics', () => {
  let previousDatabaseUrl;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota';
  });

  afterEach(() => {
    jest.dontMock('pg');
    jest.dontMock('../src/logger');
    jest.resetModules();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  test('a successful call reports the acquire/query split, the pool census and the connection age', async () => {
    const client = { query: jest.fn(async () => ({ rows: [{ ok: 1 }] })), release: jest.fn(), _poolUseCount: 4 };
    const pool = buildPool({ connectImpl: async () => client });
    const db = loadDb(pool);

    const diagnostics = {};
    await db.queryWithBudget('SELECT 1', [], { timeoutMs: 5000, diagnostics });

    expect(diagnostics.budget_ms).toBe(5000);
    expect(typeof diagnostics.acquire_ms).toBe('number');
    expect(typeof diagnostics.query_ms).toBe('number');
    expect(diagnostics.pool_total).toBe(3);
    expect(diagnostics.pool_idle).toBe(1);
    expect(diagnostics.pool_waiting).toBe(2);
    // Stamped by the pool's own 'connect' event, which is the only place a
    // connection's birth time is observable.
    expect(typeof diagnostics.conn_age_ms).toBe('number');
    expect(diagnostics.conn_use_count).toBe(4);
  });

  test('a statement that outruns its budget reports timer lag, so a blocked event loop is distinguishable', async () => {
    const running = deferred();
    const client = { query: jest.fn(() => running.promise), release: jest.fn() };
    const pool = buildPool({ connectImpl: async () => client });
    const db = loadDb(pool);

    const diagnostics = {};
    const err = await db.queryWithBudget('SELECT 1', [], { timeoutMs: 25, diagnostics })
      .then(() => null, (e) => e);

    expect(err.code).toBe(db.DB_BUDGET_QUERY_TIMEOUT);
    // Near zero here: nothing blocks this test's loop. In production a large lag
    // is the tell that the process could not drain its sockets either.
    expect(typeof err.timer_lag_ms).toBe('number');
    expect(diagnostics.timer_lag_ms).toBe(err.timer_lag_ms);
    // The error carries a snapshot so a caller that only sees the throw still
    // learns which of the three causes it was.
    expect(err.diagnostics.query_ms).toBeGreaterThanOrEqual(0);
    expect(err.diagnostics.pool_waiting).toBe(2);

    running.reject(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('a checkout that outruns its budget attributes the wait to acquire, not to the query', async () => {
    const gate = deferred();
    const pool = buildPool({ connectImpl: () => gate.promise });
    const db = loadDb(pool);

    const diagnostics = {};
    const err = await db.queryWithBudget('SELECT 1', [], { timeoutMs: 25, diagnostics })
      .then(() => null, (e) => e);

    expect(err.code).toBe(db.DB_BUDGET_ACQUIRE_TIMEOUT);
    expect(diagnostics.acquire_ms).toBeGreaterThanOrEqual(20);
    // No query was ever issued, so there must be no query timing to mistake for one.
    expect(diagnostics.query_ms).toBeUndefined();

    gate.resolve({ query: jest.fn(), release: jest.fn() });
    await new Promise((resolve) => setImmediate(resolve));
  });
});

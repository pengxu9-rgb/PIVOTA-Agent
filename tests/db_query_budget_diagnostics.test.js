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
    // Both snapshots: the pressure we queued into, and what it looked like once
    // we were served.
    expect(diagnostics.pool_total_at_request).toBe(3);
    expect(diagnostics.pool_waiting_at_request).toBe(2);
    expect(diagnostics.pool_waiting_at_acquire).toBe(2);
    // Present on a connection's FIRST use, where pg-pool sets no count at all.
    expect(diagnostics.conn_use_count).toBe(4);
    // Sampled across the whole call, so a fast stage has a lag to compare a slow
    // one against.
    expect(typeof diagnostics.event_loop_lag_ms).toBe('number');
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
    expect(typeof err.timer_lag_ms).toBe('number');
    expect(diagnostics.timer_lag_ms).toBe(err.timer_lag_ms);
    // The error carries a snapshot so a caller that only sees the throw still
    // learns which of the three causes it was.
    expect(err.diagnostics.query_ms).toBeGreaterThanOrEqual(0);
    expect(err.diagnostics.pool_waiting_at_request).toBe(2);

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

describe('event-loop lag measurement', () => {
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

  // These two are the whole point of the field: the same 600ms of waiting has to
  // read differently depending on WHY we waited. Without them a constant, or a
  // reading taken off the wrong clock, ships green.
  test('a block in the middle of the wait is measured as lag', async () => {
    const client = {
      query: () => new Promise((resolve) => {
        setTimeout(() => {
          // Block the loop, then keep waiting well past it. The block must be
          // caught by the sampling DURING the call: by the time the call ends
          // the loop has long recovered, so an end-of-call reading alone sees
          // nothing. This is the shape a real mid-request stall has.
          const until = Date.now() + 300;
          while (Date.now() < until) { /* spin */ }
        }, 20);
        setTimeout(() => resolve({ rows: [] }), 900);
      }),
      release: jest.fn(),
    };
    const pool = buildPool({ connectImpl: async () => client });
    const db = loadDb(pool);

    const diagnostics = {};
    await db.queryWithBudget('SELECT 1', [], { timeoutMs: 1500, diagnostics });

    expect(diagnostics.event_loop_lag_ms).toBeGreaterThan(150);
  });

  test('a slow wire with a free event loop is not measured as lag', async () => {
    const client = {
      query: () => new Promise((resolve) => { setTimeout(() => resolve({ rows: [] }), 400); }),
      release: jest.fn(),
    };
    const pool = buildPool({ connectImpl: async () => client });
    const db = loadDb(pool);

    const diagnostics = {};
    await db.queryWithBudget('SELECT 1', [], { timeoutMs: 600, diagnostics });

    // Same wait, nothing blocking: this is what "the wire was slow" looks like,
    // and it must not be confused with the case above.
    expect(diagnostics.event_loop_lag_ms).toBeLessThan(60);
    expect(diagnostics.query_ms).toBeGreaterThan(300);
  });
});

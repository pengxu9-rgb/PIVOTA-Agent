'use strict';

// Regression cover for the pool starvation behind the aurora beauty recall
// fallback (2026-09-08): a stage that gave up on its budget kept its pool slot,
// either by staying in pg's uncancellable checkout queue or by leaving a
// statement running until `statement_timeout`.

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildPoolWith(connectImpl) {
  const pool = {
    connect: jest.fn(connectImpl),
    query: jest.fn(async () => ({ rows: [{ from: 'pool.query' }] })),
    end: jest.fn(async () => {}),
    on: jest.fn(),
  };
  return pool;
}

function loadDb(pool) {
  jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
  jest.doMock('../src/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
  // eslint-disable-next-line global-require
  return require('../src/db');
}

describe('queryWithBudget', () => {
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
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  test('a checkout that outlives the budget hands its slot back instead of running the query', async () => {
    const gate = deferred();
    const lateClient = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
    const pool = buildPoolWith(() => gate.promise);
    const db = loadDb(pool);

    await expect(db.queryWithBudget('SELECT 1', [], { timeoutMs: 25 })).rejects.toMatchObject({
      code: db.DB_BUDGET_ACQUIRE_TIMEOUT,
    });

    // pg cannot withdraw us from the checkout queue, so the client still lands.
    gate.resolve(lateClient);
    await new Promise((resolve) => setImmediate(resolve));

    expect(lateClient.release).toHaveBeenCalledTimes(1);
    expect(lateClient.release).toHaveBeenCalledWith();
    // The whole point: the slot we could not use was never spent on a query.
    expect(lateClient.query).not.toHaveBeenCalled();
  });

  test('a statement that outlives the budget destroys its connection rather than returning it', async () => {
    const running = deferred();
    const client = { query: jest.fn(() => running.promise), release: jest.fn() };
    const pool = buildPoolWith(async () => client);
    const db = loadDb(pool);

    await expect(db.queryWithBudget('SELECT 1', [], { timeoutMs: 25 })).rejects.toMatchObject({
      code: db.DB_BUDGET_QUERY_TIMEOUT,
    });

    expect(client.release).toHaveBeenCalledTimes(1);
    // `true` is the destroy flag: a connection whose statement is still running
    // must not go back to the pool, or the next caller inherits the wait.
    expect(client.release).toHaveBeenCalledWith(true);

    running.reject(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('a query inside its budget returns the rows and releases the client normally', async () => {
    const client = { query: jest.fn(async () => ({ rows: [{ ok: 1 }] })), release: jest.fn() };
    const pool = buildPoolWith(async () => client);
    const db = loadDb(pool);

    await expect(db.queryWithBudget('SELECT 1', [], { timeoutMs: 5000 })).resolves.toEqual({
      rows: [{ ok: 1 }],
    });

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith();
  });

  test('without a budget it stays on the plain pooled path', async () => {
    const pool = buildPoolWith(async () => {
      throw new Error('connect() must not be used when no budget is given');
    });
    const db = loadDb(pool);

    await expect(db.queryWithBudget('SELECT 1', [], {})).resolves.toEqual({
      rows: [{ from: 'pool.query' }],
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

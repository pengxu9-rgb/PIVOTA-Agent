'use strict';

// Lane deadlines (src/db runWithDbDeadline): a plain query() issued inside a
// caller's budget must not outlive the caller. A first-paint stage that gave up
// at its budget used to leave its statement running on a pooled connection
// until the 30s pool-level statement_timeout, and a few of those pinned a whole
// instance's pool.

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
  return {
    connect: jest.fn(connectImpl),
    query: jest.fn(async () => ({ rows: [{ from: 'pool.query' }] })),
    end: jest.fn(async () => {}),
    on: jest.fn(),
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
  };
}

const ENV_KEYS = [
  'DATABASE_URL',
  'DB_LANE_DEADLINES_ENABLED',
  'DB_LANE_DEADLINE_GRACE_MS',
  'DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS',
];

describe('lane deadlines on plain query()', () => {
  let previousEnv;
  let PoolCtor;

  let logger;
  function loadDb(pool) {
    PoolCtor = jest.fn(() => pool);
    logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
    jest.doMock('pg', () => ({ Pool: PoolCtor }));
    jest.doMock('../src/logger', () => logger);
    // eslint-disable-next-line global-require
    return require('../src/db');
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota';
    process.env.DB_LANE_DEADLINES_ENABLED = 'true';
    process.env.DB_LANE_DEADLINE_GRACE_MS = '0';
    // Lane deadlines are refused without the server-side check interval (see the refusal tests below).
    process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS = '1000';
  });

  afterEach(() => {
    jest.dontMock('pg');
    jest.dontMock('../src/logger');
    jest.resetModules();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('a statement still running at the deadline has its connection destroyed, not returned', async () => {
    const running = deferred();
    const client = { query: jest.fn(() => running.promise), release: jest.fn() };
    const pool = buildPoolWith(async () => client);
    const db = loadDb(pool);

    await expect(
      db.runWithDbDeadline({ budgetMs: 30, label: 'test_lane' }, () => db.query('SELECT slow()', [])),
    ).rejects.toMatchObject({ code: db.DB_BUDGET_QUERY_TIMEOUT });

    // Routed through the budgeted checkout, never the unbounded pool.query.
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('SELECT slow()', []);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);

    running.reject(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('a query inside the deadline answers normally and returns its connection', async () => {
    const client = { query: jest.fn(async () => ({ rows: [{ ok: 1 }] })), release: jest.fn() };
    const pool = buildPoolWith(async () => client);
    const db = loadDb(pool);

    await expect(
      db.runWithDbDeadline({ budgetMs: 5000 }, () => db.query('SELECT 1', [])),
    ).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(client.release).toHaveBeenCalledWith();
  });

  test('a spent deadline fails before touching the pool', async () => {
    const pool = buildPoolWith(async () => {
      throw new Error('connect() must not be reached once the deadline is spent');
    });
    const db = loadDb(pool);

    const err = await db
      .runWithDbDeadline({ budgetMs: 5, label: 'spent_lane' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return db.query('SELECT 1', []);
      })
      .catch((e) => e);

    expect(err).toMatchObject({ code: db.DB_BUDGET_ACQUIRE_TIMEOUT, lane: 'spent_lane' });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a nested deadline can shorten the outer one but never extend it', async () => {
    const db = loadDb(buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() })));

    const seen = await db.runWithDbDeadline({ budgetMs: 200 }, () =>
      db.runWithDbDeadline({ budgetMs: 60_000 }, () => db.remainingDbDeadlineMs()),
    );
    expect(seen).toBeLessThanOrEqual(200);

    const shorter = await db.runWithDbDeadline({ budgetMs: 60_000 }, () =>
      db.runWithDbDeadline({ budgetMs: 100 }, () => db.remainingDbDeadlineMs()),
    );
    expect(shorter).toBeLessThanOrEqual(100);
  });

  test('an explicit queryWithBudget inside a lane gets the earlier of the two budgets', async () => {
    const running = deferred();
    const client = { query: jest.fn(() => running.promise), release: jest.fn() };
    const db = loadDb(buildPoolWith(async () => client));

    const startedAt = Date.now();
    await expect(
      db.runWithDbDeadline({ budgetMs: 30 }, () =>
        db.queryWithBudget('SELECT slow()', [], { timeoutMs: 10_000 }),
      ),
    ).rejects.toMatchObject({ code: db.DB_BUDGET_QUERY_TIMEOUT });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    running.reject(new Error('Connection terminated'));
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('the deadline does not leak to queries issued outside the run', async () => {
    const pool = buildPoolWith(async () => {
      throw new Error('connect() is only for the budgeted path');
    });
    const db = loadDb(pool);

    await db.runWithDbDeadline({ budgetMs: 5_000 }, async () => {});
    await expect(db.query('SELECT 1', [])).resolves.toEqual({ rows: [{ from: 'pool.query' }] });
    expect(db.remainingDbDeadlineMs()).toBeNull();
  });

  test('flag off: runWithDbDeadline is a plain call and query() stays on pool.query', async () => {
    process.env.DB_LANE_DEADLINES_ENABLED = '';
    const pool = buildPoolWith(async () => {
      throw new Error('connect() must not be used with the flag off');
    });
    const db = loadDb(pool);

    await expect(
      db.runWithDbDeadline({ budgetMs: 1 }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(db.remainingDbDeadlineMs()).toBeNull();
        return db.query('SELECT 1', []);
      }),
    ).resolves.toEqual({ rows: [{ from: 'pool.query' }] });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test.each([
    ['the check interval is unset', () => { delete process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS; }, 'client_connection_check_interval_unset'],
    ['the check interval is 0', () => { process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS = '0'; }, 'client_connection_check_interval_unset'],
    ['DATABASE_URL carries its own options= (which would override the interval)', () => {
      process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20search_path%3Dx';
    }, 'database_url_options_override_check_interval'],
    ['DATABASE_URL options= set the interval to 0 (a substring match would pass it)', () => {
      process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20client_connection_check_interval%3D0';
    }, 'database_url_options_check_interval_off'],
    ['DATABASE_URL options= set the interval twice, the last to 0 (the server keeps the last)', () => {
      process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20client_connection_check_interval%3D500%20-c%20client_connection_check_interval%3D0';
    }, 'database_url_options_check_interval_off'],
    ['DATABASE_URL cannot be parsed', () => {
      process.env.DATABASE_URL = 'not a connection string ::: %%%';
    }, 'database_url_unparseable'],
    ['the parser throws on an out-of-range port', () => {
      process.env.DATABASE_URL = 'postgres://u:p@h:99999/db';
    }, 'database_url_unparseable'],
    ['the parser throws on an unclosed IPv6 host', () => {
      process.env.DATABASE_URL = 'postgres://[::1/db';
    }, 'database_url_unparseable'],
    ['URL options= name the interval in UPPER case, set to 0', () => {
      process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20CLIENT_CONNECTION_CHECK_INTERVAL%3D0';
    }, 'database_url_options_check_interval_off'],
    ['URL options= name the interval with dashes, set to 0', () => {
      process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20client-connection-check-interval%3D0';
    }, 'database_url_options_check_interval_off'],
    ['URL options= set a sub-millisecond interval (the server stores 0)', () => {
      process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20client_connection_check_interval%3D0.4ms';
    }, 'database_url_options_check_interval_off'],
    ['URL options= set a sub-millisecond interval in seconds', () => {
      process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20client_connection_check_interval%3D0.0004s';
    }, 'database_url_options_check_interval_off'],
    ['the Cloud SQL socket-form URL has no interval anywhere', () => {
      process.env.DATABASE_URL = 'postgresql://example:test@/pivota?host=/cloudsql/project:region:instance';
      delete process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS;
    }, 'client_connection_check_interval_unset'],
  ])('deadlines are REFUSED, with one boot warning, when %s', async (_label, arrange, reason) => {
    arrange();
    const pool = buildPoolWith(async () => {
      throw new Error('connect() must not be used when the deadlines are refused');
    });
    const db = loadDb(pool);
    // The boot-time check already warned, once.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ reason });
    expect(db.isDbLaneDeadlinesEnabled()).toBe(false);

    await expect(
      db.runWithDbDeadline({ budgetMs: 50 }, async () => {
        expect(db.remainingDbDeadlineMs()).toBeNull();
        return db.query('SELECT 1', []);
      }),
    ).resolves.toEqual({ rows: [{ from: 'pool.query' }] });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the Cloud SQL socket-form URL with the env interval', 'postgresql://example:test@/pivota?host=/cloudsql/project:region:instance', '1000'],
    ['a URL whose options= set the interval > 0 (with a unit)', 'postgres://example:test@localhost:5432/pivota?options=-c%20client_connection_check_interval%3D2s', ''],
    ['a plain URL with the env interval', 'postgres://example:test@localhost:5432/pivota', '250'],
    ['URL options= with a mixed-case, dashed name set > 0', 'postgres://example:test@localhost:5432/pivota?options=-c%20Client-Connection-Check-Interval%3D1s', ''],
  ])('accepted: %s', (_label, databaseUrl, interval) => {
    process.env.DATABASE_URL = databaseUrl;
    if (interval) process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS = interval;
    else delete process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS;
    const db = loadDb(buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() })));
    expect(db.isDbLaneDeadlinesEnabled()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each([
    ['0', false],
    ['1s', true],
    ['250ms', true],
    ['0.4ms', false],
  ])('the first pooled connection reporting the interval as %s leaves deadlines enabled=%s', async (shown, enabled) => {
    const pool = buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() }));
    const db = loadDb(pool);
    db.getPool();
    const onConnect = pool.on.mock.calls.find(([event]) => event === 'connect')[1];
    const client = { query: jest.fn(async () => ({ rows: [{ client_connection_check_interval: shown }] })) };
    onConnect(client);
    onConnect(client); // asked once per process, not per connection
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SHOW client_connection_check_interval');
    expect(db.isDbLaneDeadlinesEnabled()).toBe(enabled);
    if (!enabled) {
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'server_reports_check_interval_off' }), expect.any(String));
    }
  });

  test('a probe that fails is retried once on the next connection, then refuses as unverified', async () => {
    const pool = buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() }));
    const db = loadDb(pool);
    db.getPool();
    const onConnect = pool.on.mock.calls.find(([event]) => event === 'connect')[1];
    const failing = { query: jest.fn(async () => { throw new Error('Connection terminated'); }) };
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    onConnect(failing);
    await flush();
    // One failure proves nothing: still armed, and the next connection asks again.
    expect(db.isDbLaneDeadlinesEnabled()).toBe(true);
    onConnect(failing);
    await flush();
    expect(failing.query).toHaveBeenCalledTimes(2);
    expect(db.isDbLaneDeadlinesEnabled()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'server_check_interval_unverified' }), expect.any(String));
    // Settled: no third probe.
    onConnect(failing);
    await flush();
    expect(failing.query).toHaveBeenCalledTimes(2);
  });

  test('a failed probe followed by an answer > 0 keeps the deadlines', async () => {
    const pool = buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() }));
    const db = loadDb(pool);
    db.getPool();
    const onConnect = pool.on.mock.calls.find(([event]) => event === 'connect')[1];
    onConnect({ query: jest.fn(async () => { throw new Error('Connection terminated'); }) });
    await new Promise((resolve) => setImmediate(resolve));
    onConnect({ query: jest.fn(async () => ({ rows: [{ client_connection_check_interval: '1s' }] })) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.isDbLaneDeadlinesEnabled()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('the server is not asked when deadlines are not requested', async () => {
    process.env.DB_LANE_DEADLINES_ENABLED = '';
    const pool = buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() }));
    const db = loadDb(pool);
    db.getPool();
    const onConnect = pool.on.mock.calls.find(([event]) => event === 'connect')[1];
    const client = { query: jest.fn() };
    onConnect(client);
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.query).not.toHaveBeenCalled();
  });

  test('a DATABASE_URL whose options= carry the interval itself is accepted', () => {
    process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota?options=-c%20client_connection_check_interval%3D1000';
    const db = loadDb(buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() })));
    expect(db.isDbLaneDeadlinesEnabled()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('the grace keeps the DB deadline behind the caller budget', async () => {
    process.env.DB_LANE_DEADLINE_GRACE_MS = '400';
    const db = loadDb(buildPoolWith(async () => ({ query: jest.fn(), release: jest.fn() })));
    const remaining = await db.runWithDbDeadline({ budgetMs: 100 }, () => db.remainingDbDeadlineMs());
    expect(remaining).toBeGreaterThan(100);
    expect(remaining).toBeLessThanOrEqual(500);
  });
});

describe('client_connection_check_interval startup option', () => {
  let previous;

  beforeEach(() => {
    jest.resetModules();
    previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS: process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS,
    };
    process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota';
  });

  afterEach(() => {
    jest.dontMock('pg');
    jest.resetModules();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function poolConfigFor(intervalEnv) {
    if (intervalEnv === undefined) delete process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS;
    else process.env.DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS = intervalEnv;
    const Pool = jest.fn(() => ({ query: jest.fn(), on: jest.fn(), end: jest.fn() }));
    jest.doMock('pg', () => ({ Pool }));
    // eslint-disable-next-line global-require
    require('../src/db').getPool();
    return Pool.mock.calls[0][0];
  }

  test('unset keeps today\'s startup packet (no options sent)', () => {
    const config = poolConfigFor(undefined);
    expect(config).not.toHaveProperty('options');
    expect(config.statement_timeout).toBe(30000);
  });

  test('set sends the interval in the startup packet', () => {
    expect(poolConfigFor('1000').options).toBe('-c client_connection_check_interval=1000');
  });

  test('garbage or zero is off', () => {
    expect(poolConfigFor('0')).not.toHaveProperty('options');
    jest.resetModules();
    expect(poolConfigFor('soon')).not.toHaveProperty('options');
  });
});

describe('isDbUnavailableError', () => {
  // eslint-disable-next-line global-require
  const { isDbUnavailableError, DB_BUDGET_ACQUIRE_TIMEOUT, DB_BUDGET_QUERY_TIMEOUT } = require('../src/db');

  test.each([
    ['pg-pool checkout timeout', new Error('timeout exceeded when trying to connect')],
    ['pg connect timeout', new Error('Connection terminated due to connection timeout')],
    ['pg client query_timeout', new Error('Query read timeout')],
    ['statement_timeout', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['too many connections', Object.assign(new Error('sorry, too many clients already'), { code: '53300' })],
    ['budgeted checkout', Object.assign(new Error('x'), { code: DB_BUDGET_ACQUIRE_TIMEOUT })],
    ['budgeted statement', Object.assign(new Error('x'), { code: DB_BUDGET_QUERY_TIMEOUT })],
    ['reset socket', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['admin shutdown', Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' })],
  ])('%s means the database could not answer', (_label, err) => {
    expect(isDbUnavailableError(err)).toBe(true);
  });

  test.each([
    ['missing relation', Object.assign(new Error('relation "x" does not exist'), { code: '42P01' })],
    ['syntax error', Object.assign(new Error('syntax error at or near "SELEC"'), { code: '42601' })],
    ['a defect that merely mentions timeout', new Error('timeout is not defined')],
    ['nothing', null],
  ])('%s is an answer (or a defect), not unavailability', (_label, err) => {
    expect(isDbUnavailableError(err)).toBe(false);
  });
});

describe('withClient honours markClientForDestroy', () => {
  let previous;
  beforeEach(() => {
    jest.resetModules();
    previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota';
  });
  afterEach(() => {
    jest.dontMock('pg');
    jest.dontMock('../src/logger');
    jest.resetModules();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  });

  test.each([
    ['marked', true, true],
    ['not marked', false, false],
  ])('a client %s is released with destroy=%s', async (_label, mark, destroyed) => {
    const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn(), on: jest.fn(), off: jest.fn() };
    const pool = { connect: jest.fn(async () => client), query: jest.fn(), end: jest.fn(async () => {}), on: jest.fn() };
    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
    jest.doMock('../src/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    // eslint-disable-next-line global-require
    const db = require('../src/db');
    await db.withClient(async (c) => {
      if (mark) db.markClientForDestroy(c);
    });
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(destroyed);
  });
});

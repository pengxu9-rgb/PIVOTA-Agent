'use strict';

describe('db pool resilience', () => {
  let previousEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    previousEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      DB_QUERY_RETRIES: process.env.DB_QUERY_RETRIES,
      DB_CONNECT_RETRIES: process.env.DB_CONNECT_RETRIES,
      DB_QUERY_RETRY_BACKOFF_MS: process.env.DB_QUERY_RETRY_BACKOFF_MS,
    };
    process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota';
    process.env.DB_QUERY_RETRIES = '1';
    process.env.DB_CONNECT_RETRIES = '1';
    process.env.DB_QUERY_RETRY_BACKOFF_MS = '0';
  });

  afterEach(() => {
    jest.dontMock('pg');
    jest.dontMock('../src/logger');
    jest.resetModules();

    for (const [key, value] of Object.entries(previousEnv || {})) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test('query retries once after transient ECONNRESET by rebuilding the pool', async () => {
    const firstPool = {
      query: jest.fn(async () => {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }),
      end: jest.fn(async () => {}),
      on: jest.fn(),
    };
    const secondPool = {
      query: jest.fn(async () => ({ rows: [{ ok: 1 }] })),
      end: jest.fn(async () => {}),
      on: jest.fn(),
    };
    const Pool = jest
      .fn()
      .mockImplementationOnce(() => firstPool)
      .mockImplementationOnce(() => secondPool);
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

    jest.doMock('pg', () => ({ Pool }));
    jest.doMock('../src/logger', () => logger);

    const db = require('../src/db');
    const result = await db.query('SELECT 1');

    expect(result).toEqual({ rows: [{ ok: 1 }] });
    expect(Pool).toHaveBeenCalledTimes(2);
    expect(firstPool.query).toHaveBeenCalledTimes(1);
    expect(firstPool.end).toHaveBeenCalledTimes(1);
    expect(secondPool.query).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ECONNRESET',
        attempt: 1,
        max_retries: 1,
      }),
      'Transient DB query failed; resetting pool and retrying',
    );
  });

  test('query does not retry non-transient database errors', async () => {
    const err = new Error('relation does not exist');
    err.code = '42P01';
    const firstPool = {
      query: jest.fn(async () => {
        throw err;
      }),
      end: jest.fn(async () => {}),
      on: jest.fn(),
    };
    const Pool = jest.fn(() => firstPool);
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

    jest.doMock('pg', () => ({ Pool }));
    jest.doMock('../src/logger', () => logger);

    const db = require('../src/db');

    await expect(db.query('SELECT 1')).rejects.toMatchObject({ code: '42P01' });
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(firstPool.end).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('withClient retries transient connect failures before invoking the callback', async () => {
    const firstPool = {
      connect: jest.fn(async () => {
        const err = new Error('read ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }),
      end: jest.fn(async () => {}),
      on: jest.fn(),
    };
    const client = {
      query: jest.fn(async () => ({ rows: [{ ok: true }] })),
      release: jest.fn(),
    };
    const secondPool = {
      connect: jest.fn(async () => client),
      end: jest.fn(async () => {}),
      on: jest.fn(),
    };
    const Pool = jest
      .fn()
      .mockImplementationOnce(() => firstPool)
      .mockImplementationOnce(() => secondPool);
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

    jest.doMock('pg', () => ({ Pool }));
    jest.doMock('../src/logger', () => logger);

    const db = require('../src/db');
    const result = await db.withClient(async (activeClient) => {
      await activeClient.query('SELECT 1');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(Pool).toHaveBeenCalledTimes(2);
    expect(firstPool.end).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT 1');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ECONNRESET',
        attempt: 1,
        max_retries: 1,
      }),
      'Transient DB connect failed; resetting pool and retrying',
    );
  });
});

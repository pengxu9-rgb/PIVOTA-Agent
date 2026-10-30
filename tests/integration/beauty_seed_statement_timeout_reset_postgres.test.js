'use strict';

// The beauty seed recall scopes statement_timeout on a POOLED connection. It used to "clear" it with
// `SET statement_timeout = 0` -- which means no limit -- and hand the connection back to the pool with the
// pool's connection-level backstop stripped. On a real server: after the helper, the same connection must
// still carry the value it was opened with. And a RESET that fails must mark the connection for
// destruction rather than return it in an unknown state.

const { Client } = require('pg');

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(),
  markClientForDestroy: jest.fn(),
}));

const url = process.env.CANONICAL_MAINLINE_TEST_DATABASE_URL;

(url ? describe : describe.skip)('beauty seed recall statement_timeout scope on real PostgreSQL', () => {
  let client;
  let db;
  let app;
  let originalEnv;

  beforeAll(async () => {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        !(parsed.pathname === '/gateway_test' && (parsed.port || '5432') === '5432')) {
      throw Error('Explicit owned or CI loopback DB required');
    }
    originalEnv = { ...process.env };
    process.env.DATABASE_URL = url;
    // Opened the way src/db opens a pooled connection: statement_timeout in the startup packet.
    client = new Client({ connectionString: url, statement_timeout: 30000 });
    await client.connect();
    db = require('../../src/db');
    db.withClient.mockImplementation(async (fn) => fn(client));
    app = require('../../src/server');
  });

  afterAll(async () => {
    try { await client?.end(); } finally { process.env = originalEnv; }
  });

  beforeEach(() => {
    db.markClientForDestroy.mockClear();
  });

  test('the connection keeps the pool backstop after the scoped read', async () => {
    const before = await client.query('SELECT current_setting($1) AS st', ['statement_timeout']);
    expect(before.rows[0].st).toBe('30s');

    const result = await app._debug.queryBeautyExternalSeedRowsWithTimeout('SELECT 1 AS ok', [], 700);
    expect(result.rows).toEqual([{ ok: 1 }]);

    const after = await client.query('SELECT current_setting($1) AS st', ['statement_timeout']);
    expect(after.rows[0].st).toBe('30s');
    expect(db.markClientForDestroy).not.toHaveBeenCalled();
  });

  test('...including when the scoped read itself fails (statement timeout)', async () => {
    await expect(
      app._debug.queryBeautyExternalSeedRowsWithTimeout('SELECT pg_sleep(2)', [], 250),
    ).rejects.toMatchObject({ code: '57014' });
    const after = await client.query('SELECT current_setting($1) AS st', ['statement_timeout']);
    expect(after.rows[0].st).toBe('30s');
  });

  test('a RESET that fails marks the connection for destruction instead of returning it', async () => {
    const failingReset = {
      query: jest.fn(async (sql) => {
        if (/^RESET statement_timeout/.test(sql)) throw new Error('Connection terminated');
        return client.query(sql);
      }),
    };
    db.withClient.mockImplementationOnce(async (fn) => fn(failingReset));
    await app._debug.queryBeautyExternalSeedRowsWithTimeout('SELECT 1 AS ok', [], 700);
    expect(db.markClientForDestroy).toHaveBeenCalledWith(failingReset);
  });
});

'use strict';

// Both grounding lookups scope statement_timeout on a pooled connection. The scope must end with RESET
// (never `= 0`, which is "no limit"), and a RESET that fails must mark the connection for destruction so
// it is not handed back to the pool in an unknown state. The real-server half is in
// tests/integration/db_pool_statement_guards_postgres.test.js.

jest.mock('../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(),
  markClientForDestroy: jest.fn(),
}));

const db = require('../src/db');
const { _internals } = require('../src/services/productGroundingResolver');

const LOOKUPS = [
  ['products-cache lookup', () => _internals.fetchCandidatesViaProductsCache({
    merchantIds: ['m1'], query: 'vitamin c serum', limit: 5, timeoutMs: 700,
  })],
  ['external-seed recall lookup', () => _internals.fetchCandidatesViaExternalSeedRecall({
    query: 'vitamin c serum', hintBrand: 'Example Brand', limit: 5, timeoutMs: 700,
  })],
];

describe('grounding lookups end their statement_timeout scope safely', () => {
  let previous;
  beforeAll(() => {
    previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://grounding.test/none';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  });
  beforeEach(() => {
    db.withClient.mockReset();
    db.markClientForDestroy.mockReset();
  });

  test.each(LOOKUPS)('%s: the scope ends with RESET, never SET ... = 0', async (_label, run) => {
    const seen = [];
    const client = { query: jest.fn(async (sql) => { seen.push(String(sql)); return { rows: [] }; }) };
    db.withClient.mockImplementation(async (fn) => fn(client));
    await run();
    expect(seen[0]).toMatch(/^SET statement_timeout = \d+$/);
    expect(seen[seen.length - 1]).toBe('RESET statement_timeout');
    expect(seen.some((sql) => /statement_timeout\s*=\s*0\b/.test(sql))).toBe(false);
    expect(db.markClientForDestroy).not.toHaveBeenCalled();
  });

  test.each(LOOKUPS)('%s: a failed RESET marks the connection for destruction', async (_label, run) => {
    const client = {
      query: jest.fn(async (sql) => {
        if (String(sql) === 'RESET statement_timeout') throw new Error('Connection terminated');
        return { rows: [] };
      }),
    };
    db.withClient.mockImplementation(async (fn) => fn(client));
    await run();
    expect(db.markClientForDestroy).toHaveBeenCalledWith(client);
  });
});

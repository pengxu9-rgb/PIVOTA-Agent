'use strict';

// Every other test for this instrumentation injects `queryFn`, which means the
// seam between the recall stage and the real db layer is never exercised. A
// `runDbQuery` that stopped forwarding `options`, or a call site that stopped
// passing `logger`, would ship the whole thing inert with every suite green.
// This drives the stage through the REAL db layer with only `pg` mocked.

describe('recall stage -> db layer seam', () => {
  let previousEnv;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    previousEnv = {
      DATABASE_URL: process.env.DATABASE_URL,
      AURORA_BFF_USE_MOCK: process.env.AURORA_BFF_USE_MOCK,
    };
    process.env.DATABASE_URL = 'postgres://example:test@localhost:5432/pivota';
    process.env.AURORA_BFF_USE_MOCK = 'true';
  });

  afterEach(() => {
    jest.dontMock('pg');
    jest.resetModules();
    for (const [key, value] of Object.entries(previousEnv || {})) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('a real stage timeout carries the db diagnostics into both the ledger and the log', async () => {
    let rejectQuery = null;
    const client = {
      query: jest.fn(() => new Promise((_, reject) => { rejectQuery = reject; })),
      release: jest.fn(),
    };
    const handlers = new Map();
    const pool = {
      totalCount: 6,
      idleCount: 1,
      waitingCount: 0,
      on: jest.fn((event, fn) => { handlers.set(event, fn); }),
      end: jest.fn(async () => {}),
      query: jest.fn(async () => ({ rows: [] })),
      connect: jest.fn(async () => {
        const onConnect = handlers.get('connect');
        if (onConnect) onConnect(client);
        return client;
      }),
    };
    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));

    // eslint-disable-next-line global-require
    const { __internal } = require('../src/auroraBff/routes');
    const warnings = [];
    const logger = { warn: (fields, message) => warnings.push({ fields, message }), info: () => {}, error: () => {} };

    const out = await __internal.searchLocalExternalSeedProducts({
      query: 'salicylic acid serum clogged pores',
      limit: 6,
      logger,
      role: {
        role_id: 'acne_clogged_pore_treatment',
        rank: 11,
        preferred_step: 'treatment',
        query_terms: ['salicylic acid treatment'],
        fit_keywords: ['clogged', 'pore'],
        product_type_hypotheses: ['serum'],
      },
      preferredStep: 'treatment',
      timeoutMs: 300,
    });

    // The pool was actually used — this did not quietly fall back to a stub.
    expect(pool.connect).toHaveBeenCalled();
    expect(client.query).toHaveBeenCalled();

    const stage = (out.local_external_seed_stage_debug || [])[0];
    expect(stage?.timeout).toBe(true);
    // `runDbQuery` forwarded `options`, so the db layer produced a budget and a
    // cause. Without the forwarding this is a plain `db.query` with no timeout,
    // no cause and no diagnostics.
    expect(stage?.timeout_cause).toBe('query');
    expect(typeof stage?.db?.query_ms).toBe('number');
    expect(typeof stage?.db?.event_loop_lag_ms).toBe('number');
    expect(stage?.db?.pool_total_at_request).toBe(6);

    // The call site passed `logger`, so the stall is attributable after the fact.
    const timeoutLog = warnings.find((row) => row.message === 'local_external_seed_stage_timeout');
    expect(timeoutLog).toBeTruthy();
    expect(timeoutLog.fields?.db?.pool_total_at_request).toBe(6);

    if (rejectQuery) rejectQuery(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => setImmediate(resolve));
  });

  // The multi-query entry point reaches the staged search through its OWN call
  // site. Covering only the single-query one leaves that site free to drop
  // `logger` — the stall stops being attributable and every suite stays green.
  test('the multi-query entry point logs a real stage timeout too', async () => {
    let rejectQuery = null;
    const client = {
      query: jest.fn(() => new Promise((_, reject) => { rejectQuery = reject; })),
      release: jest.fn(),
    };
    const handlers = new Map();
    const pool = {
      totalCount: 6,
      idleCount: 1,
      waitingCount: 0,
      on: jest.fn((event, fn) => { handlers.set(event, fn); }),
      end: jest.fn(async () => {}),
      query: jest.fn(async () => ({ rows: [] })),
      connect: jest.fn(async () => {
        const onConnect = handlers.get('connect');
        if (onConnect) onConnect(client);
        return client;
      }),
    };
    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));

    // eslint-disable-next-line global-require
    const { __internal } = require('../src/auroraBff/routes');
    const warnings = [];
    const logger = { warn: (fields, message) => warnings.push({ fields, message }), info: () => {}, error: () => {} };

    await __internal.searchLocalExternalSeedProductsForQueryVariants({
      // Two queries, so this does NOT delegate to the single-query entry point.
      queries: ['salicylic acid serum clogged pores', 'salicylic acid treatment'],
      limit: 6,
      logger,
      role: {
        role_id: 'acne_clogged_pore_treatment',
        rank: 11,
        preferred_step: 'treatment',
        query_terms: ['salicylic acid treatment'],
        fit_keywords: ['clogged', 'pore'],
        product_type_hypotheses: ['serum'],
      },
      preferredStep: 'treatment',
      timeoutMs: 300,
    });

    const timeoutLog = warnings.find((row) => row.message === 'local_external_seed_stage_timeout');
    expect(timeoutLog).toBeTruthy();
    expect(timeoutLog.fields?.timeout_cause).toBe('query');
    expect(typeof timeoutLog.fields?.db?.event_loop_lag_ms).toBe('number');

    if (rejectQuery) rejectQuery(Object.assign(new Error('Connection terminated'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => setImmediate(resolve));
  });
});

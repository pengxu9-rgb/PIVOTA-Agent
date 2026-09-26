'use strict';

// 2026-07-25 regression: three sitemap PDPs (sig_1b4d53ca…, sig_4b293ca5…,
// sig_77977a7f…) returned ZERO BYTES and no HTTP status, indefinitely, for
// hours. Not ISR, not user-agent gating, not edge routing — the serverless
// function simply never produced a response.
//
// Root cause was a two-part chain in resolveCatalogProductRefFromPivotaSignature:
//   1. `query()` is pg `Pool.query`, which had neither `statement_timeout` nor
//      `query_timeout`, so a pathological plan never settled; and
//   2. the single-flight map stores the PENDING promise and only evicts it in
//      `.finally()`. A promise that never settles is never evicted, so every
//      LATER request for that sig was handed the SAME dead promise.
//
// (2) is what turned one unlucky query into a permanent, per-sig outage that
// looked exactly like corrupt product data. These tests pin the invariant that
// makes it self-healing: EVERY path out of the resolver settles, and the
// in-flight entry is always released.
//
// The behavioral assertions are the point. `never-settling query` is simulated
// rather than asserted on SQL shape, because the bug was not in the SQL — it
// was in what the cache did with a promise that never came back.

const ORIGINAL_ENV = process.env;

const SIG = 'sig_1b4d53ca07835e10cdaada553bc26ed6';

function loadServerWithQuery(queryImpl, envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    // Keep the test fast; production defaults are seconds, not milliseconds.
    RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '60',
    RESOLVE_CATALOG_SIGNATURE_COOLDOWN_MS: '1000',
    ...envOverrides,
  };
  jest.doMock('../src/db', () => ({
    query: queryImpl,
    queryWithStatementTimeout: queryImpl,
    withClient: jest.fn(),
    getPool: jest.fn(() => ({})),
    closePool: jest.fn(),
  }));
  return require('../src/server');
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('resolveCatalogProductRefFromPivotaSignature — in-flight poisoning', () => {
  test('a never-settling query rejects on budget instead of hanging forever', async () => {
    const query = jest.fn(() => new Promise(() => {})); // never settles
    const app = loadServerWithQuery(query);

    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {
        hydrateIdentityListing: true,
        hydrateIdentityGroupMembers: true,
      }),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });
  });

  test('THE REGRESSION: the dead promise is evicted, not served to every later request', async () => {
    const query = jest.fn(() => new Promise(() => {}));
    const app = loadServerWithQuery(query);

    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {}),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });

    // Before the fix this map still held the unsettled promise, and every
    // subsequent request for this sig awaited it forever.
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_INFLIGHT.size).toBe(0);
  });

  test('a budget miss is never cached as a successful value', async () => {
    const query = jest.fn(() => new Promise(() => {}));
    const app = loadServerWithQuery(query);

    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {}),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });

    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_CACHE.size).toBe(0);
  });

  test('cooldown fails fast WITHOUT launching another pool-pinning query', async () => {
    const query = jest.fn(() => new Promise(() => {}));
    const app = loadServerWithQuery(query);

    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {}),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });
    const callsAfterFirst = query.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // The timed-out query is still running and still holding one of only
    // DB_POOL_MAX (default 5) connections. Piling on more copies is how a
    // single bad sig starves every other operation.
    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {}),
    ).rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_RESOLVE_TIMEOUT' });

    expect(query).toHaveBeenCalledTimes(callsAfterFirst);
  });

  test('the sig RECOVERS once the query is healthy again (not permanently poisoned)', async () => {
    let hang = true;
    const query = jest.fn(() =>
      hang
        ? new Promise(() => {})
        : Promise.resolve({
            rows: [
              {
                merchant_id: 'merch_test',
                platform: 'shopify',
                source_product_id: 'prod_test',
                pivota_signature_id: SIG,
              },
            ],
          }),
    );
    const app = loadServerWithQuery(query, {
      RESOLVE_CATALOG_SIGNATURE_COOLDOWN_MS: '1000',
    });

    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {}),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });

    // Let the cooldown lapse, then serve a healthy read.
    hang = false;
    app._debug.RESOLVE_CATALOG_SIGNATURE_COOLDOWN.clear();

    const resolved = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {
      hydrateIdentityListing: false,
    });
    expect(resolved).toMatchObject({
      merchant_id: 'merch_test',
      product_id: 'prod_test',
    });
  });

  test('cache-bypass reads are bounded too', async () => {
    const query = jest.fn(() => new Promise(() => {}));
    const app = loadServerWithQuery(query);

    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, { bypassCache: true }),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });
  });
});

describe('identity-group member SQL — TOAST detoast gate', () => {
  // The projection `product_payload #> '{seed_data,electronics_meta}'` detoasts
  // the ENTIRE payload, once per group member. For the three Tom Ford Beauty
  // sigs that meant ~67-77MB of TOAST reads per request (40- and 43-member
  // groups, 1.0-1.9MB payloads vs a 3,697-byte corpus median) to produce a
  // column that is NULL for every live row in the corpus.
  test('electronics_meta is gated on category so beauty rows never detoast the payload', () => {
    jest.resetModules();
    jest.dontMock('../src/db');
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
    const app = require('../src/server');

    const sql = app._debug.buildGroupMemberCatalogOfferLateralJoinSql('pil');
    // The lateral itself must not project the payload at all.
    expect(sql).not.toContain('electronics_meta');

    const queryFn = jest.fn(async () => ({ rows: [] }));
    return app._debug
      .fetchApprovedLiveIdentityGroupMembersForOffers({
        sellableItemGroupId: 'sig_group',
        excludeMerchantId: 'merch_x',
        excludeProductId: 'prod_x',
        queryFn,
      })
      .then(() => {
        const memberSql = String(queryFn.mock.calls[0][0]);
        // Still projected (the electronics spec surface is first-class)...
        expect(memberSql).toContain("product_payload#>'{seed_data,electronics_meta}'");
        // ...but ONLY behind the cheap category gate. An ungated projection is
        // the regression this guards.
        expect(memberSql).toMatch(
          /CASE\s+WHEN cp_offer\.category ILIKE 'electronics%'\s+THEN cp_offer\.product_payload#>'\{seed_data,electronics_meta\}'/,
        );
      });
  });
});

describe('db pool — no query can hang forever', () => {
  test('pool is constructed with both a server-side and client-side deadline', () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    };
    // The suite above registers a '../src/db' mock, and mock REGISTRATIONS
    // survive resetModules() — without this we would assert against the mock's
    // stub getPool instead of the real pool construction.
    jest.dontMock('../src/db');
    const captured = [];
    jest.doMock('pg', () => ({
      Pool: class {
        constructor(config) {
          captured.push(config);
        }
        on() {}
      },
    }));
    const db = require('../src/db');
    db.getPool();

    expect(captured).toHaveLength(1);
    // statement_timeout lets Postgres cancel the runaway plan and RELEASE the
    // connection; query_timeout is the client-side backstop for a wedged
    // socket. query_timeout must stay above statement_timeout so the clean
    // server-side cancel normally wins.
    expect(captured[0].statement_timeout).toBeGreaterThan(0);
    expect(captured[0].query_timeout).toBeGreaterThan(captured[0].statement_timeout);
  });
});

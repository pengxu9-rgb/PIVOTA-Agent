'use strict';

// A database that could not ANSWER is not a sig that resolves to NOTHING.
//
// The signature resolver used to turn every query error into `null`. A pool
// checkout timeout ("timeout exceeded when trying to connect") therefore became:
//   - a memoized null for the whole single-flight cache TTL,
//   - PRODUCT_NOT_FOUND on the PDP lanes (a 404 that tells a crawler to drop a
//     live product), and
//   - "provably dead" to the public-search chain filter, which DROPPED the row
//     despite its own fail-open contract.
// Those errors now surface as a retryable CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE.
// The resolver also runs its statements inside a lane deadline, so a budget
// miss stops holding pool connections.

const request = require('supertest');

const ORIGINAL_ENV = process.env;
const SIG = 'sig_0a1b2c3d4e5f60718293a4b5c6d7e8f9';

function poolCheckoutTimeout() {
  // pg-pool's own error: no SQLSTATE, message only.
  return new Error('timeout exceeded when trying to connect');
}

function loadServer(queryImpl, envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '2000',
    // Off unless a test is about it, so the per-call assertions see every call reach the database.
    RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '0',
    ...envOverrides,
  };
  const actualDb = jest.requireActual('../src/db');
  jest.doMock('../src/db', () => ({
    query: queryImpl,
    queryWithStatementTimeout: queryImpl,
    withClient: jest.fn(),
    getPool: jest.fn(() => ({})),
    closePool: jest.fn(),
    isDbUnavailableError: actualDb.isDbUnavailableError,
    runWithDbDeadline: actualDb.runWithDbDeadline,
    remainingDbDeadlineMs: actualDb.remainingDbDeadlineMs,
  }));
  // eslint-disable-next-line global-require
  return { app: require('../src/server'), actualDb };
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('signature resolver: unavailable database', () => {
  test('a pool checkout timeout is a retryable error, never a cached null', async () => {
    const query = jest.fn(async () => {
      throw poolCheckoutTimeout();
    });
    const { app } = loadServer(query);

    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE',
    });
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_CACHE.size).toBe(0);
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_INFLIGHT.size).toBe(0);

    // The next request asks the database again instead of reading a memoized miss.
    const callsAfterFirst = query.mock.calls.length;
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE',
    });
    expect(query.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test('a statement timeout is unavailability too', async () => {
    const query = jest.fn(async () => {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    });
    const { app } = loadServer(query);
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE',
    });
  });

  test('a genuine miss is still null, and a defect still degrades to null as before', async () => {
    const empty = jest.fn(async () => ({ rows: [] }));
    const { app } = loadServer(empty);
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).resolves.toBeNull();

    const defect = jest.fn(async () => {
      throw Object.assign(new Error('syntax error at or near "SELEC"'), { code: '42601' });
    });
    const second = loadServer(defect);
    await expect(second.app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).resolves.toBeNull();
  });

  test('the public-search chain filter KEEPS a row it could not check (fail-open)', async () => {
    const query = jest.fn(async () => {
      throw poolCheckoutTimeout();
    });
    const { app } = loadServer(query);
    const { kept, droppedCount } = await app._debug.filterPublicReadChainResolvableRows([
      { product_id: SIG, pivota_signature_id: SIG },
    ]);
    expect(droppedCount).toBe(0);
    expect(kept).toHaveLength(1);
  });

  test('...and still drops a row whose sig provably resolves to nothing', async () => {
    const { app } = loadServer(jest.fn(async () => ({ rows: [] })));
    const { droppedCount } = await app._debug.filterPublicReadChainResolvableRows([
      { product_id: SIG, pivota_signature_id: SIG },
    ]);
    expect(droppedCount).toBe(1);
  });

  test('get_pdp_v2 answers a retryable 503, not PRODUCT_NOT_FOUND', async () => {
    const query = jest.fn(async () => {
      throw poolCheckoutTimeout();
    });
    const { app } = loadServer(query, { PIVOTA_API_BASE: 'http://localhost:8080', PIVOTA_API_KEY: 'test-token' });
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation: 'get_pdp_v2', payload: { product_ref: { product_id: SIG } } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('TEMPORARY_UNAVAILABLE');
    // Reported as what it is, not as a first-paint budget miss.
    expect(res.body.reason_code).toBe('CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE');
    expect(res.body.details).toMatchObject({ reason: 'catalog_signature_resolve_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('PRODUCT_NOT_FOUND');
  });

  test('get_pdp_v2 still reports a budget miss as the timeout it is', async () => {
    const query = jest.fn(() => new Promise(() => {}));
    const { app } = loadServer(query, {
      RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '60', PIVOTA_API_BASE: 'http://localhost:8080', PIVOTA_API_KEY: 'test-token',
    });
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation: 'get_pdp_v2', payload: { product_ref: { product_id: SIG } } });
    expect(res.status).toBe(503);
    expect(res.body.reason_code).toBe('CATALOG_SIGNATURE_RESOLVE_TIMEOUT');
    expect(res.body.details).toMatchObject({ reason: 'catalog_signature_resolve_timeout' });
  });

  test('resolve_product_candidates answers a retryable 503 for an unavailable database, not a 500', async () => {
    const query = jest.fn(async () => {
      throw poolCheckoutTimeout();
    });
    const { app } = loadServer(query, { PIVOTA_API_BASE: 'http://localhost:8080', PIVOTA_API_KEY: 'test-token' });
    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({ operation: 'resolve_product_candidates', payload: { product_ref: { product_id: SIG } } });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'TEMPORARY_UNAVAILABLE',
      details: { reason: 'catalog_signature_resolve_unavailable' },
    });
  });
});

describe('signature resolver: instance-wide cooldown after an unavailable database', () => {
  const OTHER_SIG = 'sig_ffeeddccbbaa99887766554433221100';

  test('the next resolve of ANY sig fails fast without a query while the cooldown lasts', async () => {
    const query = jest.fn(async () => {
      throw poolCheckoutTimeout();
    });
    const { app } = loadServer(query, { RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '60000' });
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE',
    });
    const calls = query.mock.calls.length;

    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(OTHER_SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE',
      cooldown: true,
    });
    // The bypass-cache path is held too.
    await expect(
      app._debug.resolveCatalogProductRefFromPivotaSignature(OTHER_SIG, { bypassCache: true }),
    ).rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE' });
    expect(query.mock.calls.length).toBe(calls);

    // Search rows checked during the cooldown are kept (fail-open), and counted as such.
    const filtered = await app._debug.filterPublicReadChainResolvableRows([{ product_id: OTHER_SIG }]);
    expect(filtered).toMatchObject({ droppedCount: 0, failedOpenCount: 1 });
    expect(query.mock.calls.length).toBe(calls);
  });

  test('a cached ref is still served during the cooldown, and the database is asked again after it', async () => {
    let down = false;
    const query = jest.fn(async (sql) => {
      if (down) throw poolCheckoutTimeout();
      return String(sql).includes('cp.pivota_signature_id = $1')
        ? { rows: [{ merchant_id: 'merch_test', platform: 'shopify', source_product_id: 'prod_test', pivota_signature_id: SIG }] }
        : { rows: [] };
    });
    const { app } = loadServer(query, { RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '100' });
    const warm = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, { hydrateIdentityListing: false });
    expect(warm).toMatchObject({ merchant_id: 'merch_test' });

    down = true;
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(OTHER_SIG, { hydrateIdentityListing: false }))
      .rejects.toMatchObject({ code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE' });
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, { hydrateIdentityListing: false }))
      .resolves.toMatchObject({ merchant_id: 'merch_test' });

    down = false;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const calls = query.mock.calls.length;
    await app._debug.resolveCatalogProductRefFromPivotaSignature(OTHER_SIG, { hydrateIdentityListing: false });
    expect(query.mock.calls.length).toBeGreaterThan(calls);
  });

  test('defaults to a few seconds when unset', async () => {
    const query = jest.fn(async () => {
      throw poolCheckoutTimeout();
    });
    const { app } = loadServer(query, { RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '' });
    const startedAt = Date.now();
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toBeTruthy();
    const windowMs = app._debug.RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_STATE.untilMs - startedAt;
    expect(windowMs).toBeGreaterThan(2_000);
    expect(windowMs).toBeLessThanOrEqual(3_500);
  });

  test('0 disables it', async () => {
    const query = jest.fn(async () => {
      throw poolCheckoutTimeout();
    });
    const { app } = loadServer(query, { RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '0' });
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toBeTruthy();
    const calls = query.mock.calls.length;
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(OTHER_SIG, {})).rejects.toBeTruthy();
    expect(query.mock.calls.length).toBeGreaterThan(calls);
  });
});

describe('signature resolver: an optional sub-read that could not reach the database', () => {
  // Each optional sub-read of the rich shape, failing alone: the ref is served without what it would have
  // added, and must not be memoized for the cache TTL.
  test.each([
    ['the identity listing', (text) => /WHERE pil\.source_listing_ref = \$1/.test(text)],
    ['the identity-group members (direct query)', (text) => /WHERE pil\.sellable_item_group_id = \$1/.test(text)],
    ['the identity-group members (live identity graph)', (text) => /FROM pdp_identity_listing\s+WHERE sellable_item_group_id = \$1/.test(text)],
  ])('%s failing is served but not memoized', async (_label, failsHere) => {
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (failsHere(text)) throw poolCheckoutTimeout();
      if (text.includes('cp.pivota_signature_id = $1')) {
        return { rows: [{ merchant_id: 'external_seed', platform: 'external_seed', source_product_id: 'ext_synthetic_1', pivota_signature_id: SIG }] };
      }
      if (/WHERE pil\.source_listing_ref = \$1/.test(text)) {
        return { rows: [{ sellable_item_group_id: 'sig_group_synthetic', identity_status: 'approved', live_read_enabled: true }] };
      }
      return { rows: [] };
    });
    const { app } = loadServer(query, { PDP_IDENTITY_GRAPH_ENABLED: 'true' });
    const ref = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {});
    expect(ref).toMatchObject({ merchant_id: 'external_seed', product_id: 'ext_synthetic_1' });
    expect(query.mock.calls.some(([sql]) => failsHere(String(sql)))).toBe(true);
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_CACHE.size).toBe(0);
  });

  test('serves the ref but never memoizes it', async () => {
    let identityDown = true;
    const query = jest.fn(async (sql) => {
      const text = String(sql);
      if (text.includes('cp.pivota_signature_id = $1')) {
        return { rows: [{ merchant_id: 'external_seed', platform: 'external_seed', source_product_id: 'ext_synthetic_1', pivota_signature_id: SIG }] };
      }
      if (text.includes('FROM pdp_identity_listing pil') && identityDown) throw poolCheckoutTimeout();
      return { rows: [] };
    });
    const { app } = loadServer(query);
    const first = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {});
    expect(first).toMatchObject({ merchant_id: 'external_seed', product_id: 'ext_synthetic_1' });
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_CACHE.size).toBe(0);

    identityDown = false;
    const second = await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {});
    expect(second).toMatchObject({ merchant_id: 'external_seed' });
    // A complete ref is memoized as before.
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_CACHE.size).toBe(1);
  });
});

describe('signature resolver: lane deadline', () => {
  test('its statements run inside a DB deadline bounded by the first-paint budget', async () => {
    let seenRemaining = 'unset';
    let actual;
    const query = jest.fn(async () => {
      if (seenRemaining === 'unset') seenRemaining = actual.remainingDbDeadlineMs();
      return { rows: [] };
    });
    const loaded = loadServer(query, {
      DB_LANE_DEADLINES_ENABLED: 'true',
      DB_CLIENT_CONNECTION_CHECK_INTERVAL_MS: '1000',
      DB_LANE_DEADLINE_GRACE_MS: '100',
      RESOLVE_CATALOG_SIGNATURE_BUDGET_MS: '1500',
    });
    actual = loaded.actualDb;
    await loaded.app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {});
    expect(typeof seenRemaining).toBe('number');
    expect(seenRemaining).toBeGreaterThan(1000);
    expect(seenRemaining).toBeLessThanOrEqual(1600);
  });

  test('flag off: no deadline is in force (today\'s behaviour)', async () => {
    let seenRemaining = 'unset';
    let actual;
    const query = jest.fn(async () => {
      if (seenRemaining === 'unset') seenRemaining = actual.remainingDbDeadlineMs();
      return { rows: [] };
    });
    const loaded = loadServer(query, { DB_LANE_DEADLINES_ENABLED: '' });
    actual = loaded.actualDb;
    await loaded.app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {});
    expect(seenRemaining).toBeNull();
  });
});

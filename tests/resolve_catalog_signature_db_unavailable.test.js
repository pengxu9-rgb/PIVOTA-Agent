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

describe('signature resolver: cooldown after an unavailable database', () => {
  const sigN = (n) => `sig_${String(n).padStart(32, '0')}`;
  const OTHER_SIG = 'sig_ffeeddccbbaa99887766554433221100';
  const alwaysDown = () => jest.fn(async () => {
    throw poolCheckoutTimeout();
  });

  test('ONE failing sig is held on its own and does not block any other sig', async () => {
    let badSigDown = true;
    const query = jest.fn(async (sql, params) => {
      if (badSigDown && params?.[0] === SIG) throw poolCheckoutTimeout();
      return { rows: [] };
    });
    const { app } = loadServer(query, { RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '60000' });
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE',
    });
    const calls = query.mock.calls.length;

    // The same sig fails fast...
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE', cooldown: true,
    });
    expect(query.mock.calls.length).toBe(calls);
    // ...but every other sig still reaches the database.
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(OTHER_SIG, {})).resolves.toBeNull();
    expect(query.mock.calls.length).toBeGreaterThan(calls);
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_STATE.untilMs).toBe(0);
  });

  test('several DISTINCT sigs failing within the window trip the instance-wide fast-fail', async () => {
    const query = alwaysDown();
    const { app } = loadServer(query, {
      RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '60000', RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_TRIP_KEYS: '3',
    });
    for (const n of [1, 2]) {
      await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(sigN(n), {})).rejects.toBeTruthy();
    }
    // Two distinct failures: not yet an outage.
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_STATE.untilMs).toBe(0);
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(sigN(3), {})).rejects.toBeTruthy();
    const calls = query.mock.calls.length;

    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(OTHER_SIG, {})).rejects.toMatchObject({
      code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE', cooldown: true,
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

  test('the same sig failing repeatedly never counts as several', async () => {
    const query = alwaysDown();
    const { app } = loadServer(query, {
      RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '50', RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_TRIP_KEYS: '2',
    });
    for (let i = 0; i < 3; i += 1) {
      await app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {}).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_STATE.untilMs).toBe(0);
  });

  test('distinct sigs only add up WITHIN one window: an expired failure no longer counts', async () => {
    const query = alwaysDown();
    const { app } = loadServer(query, {
      RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '50', RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_TRIP_KEYS: '2',
    });
    await app._debug.resolveCatalogProductRefFromPivotaSignature(sigN(1), {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 70));
    await app._debug.resolveCatalogProductRefFromPivotaSignature(sigN(2), {}).catch(() => {});
    expect(app._debug.RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_STATE.untilMs).toBe(0);
  });

  test('a cached ref is still served during the cooldown, and the database is asked again after it', async () => {
    let down = false;
    const query = jest.fn(async (sql) => {
      if (down) throw poolCheckoutTimeout();
      return String(sql).includes('cp.pivota_signature_id = $1')
        ? { rows: [{ merchant_id: 'merch_test', platform: 'shopify', source_product_id: 'prod_test', pivota_signature_id: SIG }] }
        : { rows: [] };
    });
    const { app } = loadServer(query, {
      RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '100', RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_TRIP_KEYS: '1',
    });
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

  test('defaults: a few seconds per sig, and three distinct sigs to trip the instance', async () => {
    const query = alwaysDown();
    const { app } = loadServer(query, {
      RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '', RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_TRIP_KEYS: '',
    });
    const startedAt = Date.now();
    for (const n of [1, 2]) {
      await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(sigN(n), {})).rejects.toBeTruthy();
    }
    const state = app._debug.RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_STATE;
    const windowMs = state.perSig.get(sigN(1)) - startedAt;
    expect(windowMs).toBeGreaterThan(2_000);
    expect(windowMs).toBeLessThanOrEqual(3_500);
    expect(state.untilMs).toBe(0);
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(sigN(3), {})).rejects.toBeTruthy();
    expect(state.untilMs - startedAt).toBeGreaterThan(2_000);
  });

  test('at most 1,000 sigs are remembered: the oldest is evicted first', async () => {
    const { app } = loadServer(jest.fn(async () => ({ rows: [] })), {
      RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '60000', RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_TRIP_KEYS: '1000',
    });
    const state = app._debug.RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_STATE;
    for (let n = 1; n <= 1001; n += 1) app._debug.noteCatalogSignatureUnavailable(sigN(n));
    expect(state.perSig.size).toBe(1000);
    expect(state.perSig.has(sigN(1))).toBe(false);
    expect(state.perSig.has(sigN(2))).toBe(true);
    expect(state.perSig.has(sigN(1001))).toBe(true);
    // A sig failing again moves to the newest end, so it is not the next one evicted.
    app._debug.noteCatalogSignatureUnavailable(sigN(2));
    app._debug.noteCatalogSignatureUnavailable(sigN(1002));
    expect(state.perSig.has(sigN(2))).toBe(true);
    expect(state.perSig.has(sigN(3))).toBe(false);
  });

  test('0 disables it', async () => {
    const query = alwaysDown();
    const { app } = loadServer(query, { RESOLVE_CATALOG_SIGNATURE_UNAVAILABLE_COOLDOWN_MS: '0' });
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toBeTruthy();
    const calls = query.mock.calls.length;
    await expect(app._debug.resolveCatalogProductRefFromPivotaSignature(SIG, {})).rejects.toBeTruthy();
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
    // The live graph's own fallback to the canonical catalog group used to swallow this with .catch(() => null).
    ['the canonical catalog group (live graph fallback)', (text) => /WITH target AS/.test(text)],
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

describe('get_pdp_v2 marks a response built from a degraded ref', () => {
  // A healthy product: active seed, serving-eligible exact row. Nothing else answers (product detail, rescue),
  // which is what a database outage looks like to the reads after the signature resolve.
  const exactSeedRow = {
    merchant_id: 'external_seed', platform: 'external_seed', source_product_id: 'ext_synthetic_1', pivota_signature_id: SIG,
    source_system: 'external_product_seeds_mirror_v1', signature_serving_eligible: true, external_seed_id: 101,
    external_seed_external_product_id: 'ext_synthetic_1', external_seed_status: 'active', external_seed_route_lane: 0,
  };
  const invoke = (app) => request(app)
    .post('/agent/shop/v1/invoke')
    .send({ operation: 'get_pdp_v2', payload: { product_ref: { product_id: SIG } } });
  const serverWith = (identityDown) => loadServer(jest.fn(async (sql) => {
    const text = String(sql);
    if (identityDown && /WHERE pil\.source_listing_ref = \$1/.test(text)) throw poolCheckoutTimeout();
    if (text.includes('cp.pivota_signature_id = $1')) return { rows: [exactSeedRow] };
    return { rows: [] };
  }), { PIVOTA_API_BASE: 'http://localhost:8080', PIVOTA_API_KEY: 'test-token' });

  test('a degraded ref for a healthy product answers a retryable 503, never a 404', async () => {
    const res = await invoke(serverWith(true).app);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: 'TEMPORARY_UNAVAILABLE',
      reason_code: 'CATALOG_SIGNATURE_RESOLVE_UNAVAILABLE',
      details: { reason: 'catalog_signature_partial_read', withheld_verdict: { status: 404 } },
      degraded_reads: ['catalog_signature_partial'],
    });
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('control: the same reads with a COMPLETE ref keep their verdict, unmarked', async () => {
    const res = await invoke(serverWith(false).app);
    // Whatever the handler concludes from a complete ref is left alone -- including a 404.
    expect(res.status).toBe(404);
    expect(res.body.degraded_reads).toBeUndefined();
  });

  describe('the rule for every body sent after the mark', () => {
    let app;
    beforeAll(() => { ({ app } = loadServer(jest.fn(async () => ({ rows: [] })))); });
    function fakeRes() {
      const res = {
        statusCode: 200, headers: {}, sent: null,
        status(code) { this.statusCode = code; return this; },
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        json(body) { this.sent = body; return this; },
      };
      return res;
    }
    const send = (status, body) => {
      const res = fakeRes();
      app._debug.markInvokeResponseDegraded(res, 'catalog_signature_partial');
      res.status(status).json(body);
      return res;
    };

    test('200: kept, marked, no-store', () => {
      const res = send(200, { modules: [] });
      expect(res.statusCode).toBe(200);
      expect(res.sent).toEqual({ modules: [], degraded_reads: ['catalog_signature_partial'] });
      expect(res.headers['cache-control']).toBe('no-store');
    });
    test('404 (any not-found verdict): rewritten to the retryable 503, verdict withheld, marked', () => {
      const res = send(404, { error: 'PRODUCT_NOT_SERVABLE', reason_code: 'PRODUCT_NOT_SERVABLE', details: { reason: 'low_quality', index_row_found: true, serving_eligible: false } });
      expect(res.statusCode).toBe(503);
      expect(res.sent).toMatchObject({
        error: 'TEMPORARY_UNAVAILABLE',
        details: { withheld_verdict: { status: 404, error: 'PRODUCT_NOT_SERVABLE', reason: 'low_quality' } },
        degraded_reads: ['catalog_signature_partial'],
      });
      // The settled-ineligibility shape agent-ui would store as a 404 must not survive the rewrite.
      expect(res.sent.details.index_row_found).toBeUndefined();
    });
    test('other 4xx (an input error) and 5xx: status kept, marked', () => {
      expect(send(400, { error: 'MISSING_PARAMETERS' })).toMatchObject({ statusCode: 400, sent: { error: 'MISSING_PARAMETERS', degraded_reads: ['catalog_signature_partial'] } });
      expect(send(503, { error: 'TEMPORARY_UNAVAILABLE' })).toMatchObject({ statusCode: 503, sent: { degraded_reads: ['catalog_signature_partial'] } });
    });
  });
});

describe('normalizePdpV2ToProductDetail carries the degraded marker', () => {
  let app;
  beforeAll(() => { ({ app } = loadServer(jest.fn(async () => ({ rows: [] })))); });
  const page = (extra = {}) => ({
    modules: [{ type: 'canonical', data: { pdp_payload: { product: { product_id: 'sig_x', title: 'T', price: { current: { amount: 10, currency: 'USD' } } } } } }],
    ...extra,
  });

  test('a degraded page keeps degraded_reads next to the product', () => {
    const out = app._debug.normalizePdpV2ToProductDetail(page({ degraded_reads: ['catalog_signature_partial'] }));
    expect(out.product).toMatchObject({ product_id: 'sig_x', price: 10 });
    expect(out.degraded_reads).toEqual(['catalog_signature_partial']);
  });
  test('...and on a page with no product', () => {
    expect(app._debug.normalizePdpV2ToProductDetail({ modules: [], degraded_reads: ['catalog_signature_partial'] }))
      .toEqual({ product: null, degraded_reads: ['catalog_signature_partial'] });
  });
  test('a complete page has no marker', () => {
    expect(app._debug.normalizePdpV2ToProductDetail(page())).not.toHaveProperty('degraded_reads');
  });
});

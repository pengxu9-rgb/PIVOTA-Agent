'use strict';

// Follow-up to the 2026-07-25 zero-byte PDP hang. That incident's root cause was
// a single-flight map that stored a PENDING promise and evicted it only in
// `.finally()`: a promise that never settles is never evicted, so every LATER
// caller for that key is handed the same dead promise and the key is poisoned
// for the life of the process.
//
// An audit found the same shape in two more places. These tests pin the fixes.
//
//   PRODUCT_DETAIL_INFLIGHT (src/server.js) — two defects:
//     (a) `totalTimeoutMs` is opt-in and defaults to 0, and most call sites
//         never pass one, so the load ran with NO deadline at all.
//     (b) even when a budget WAS passed, the map stored the UNGUARDED promise
//         while awaiting the guarded one — so concurrent callers that hit
//         `return inflight` awaited something unbounded.
//
//   liveSyntheticPdpInflight (src/services/pdpIdentityGraph.js) — no budget and
//         no size cap; evict-on-settle only.

const ORIGINAL_ENV = process.env;

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

function loadServer(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    ...envOverrides,
  };
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  return { db, debug: app._debug };
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('PRODUCT_DETAIL_INFLIGHT — offer-detail load is always bounded', () => {
  test('a load with NO caller budget still fails instead of hanging forever', async () => {
    const { db, debug } = loadServer({ PRODUCT_DETAIL_MAX_LOAD_MS: '1000' });
    db.query.mockImplementation(() => new Promise(() => {})); // never settles

    // Deliberately no totalTimeoutMs — this is the majority case, and the one
    // that previously had no deadline whatsoever.
    await expect(
      debug.fetchProductDetailForOffers({
        merchantId: 'external_seed',
        productId: 'ext_hang_1',
      }),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });
  });

  test('THE REGRESSION: the poisoned key is evicted, not re-served forever', async () => {
    const { db, debug } = loadServer({ PRODUCT_DETAIL_MAX_LOAD_MS: '1000' });
    db.query.mockImplementation(() => new Promise(() => {}));

    await expect(
      debug.fetchProductDetailForOffers({
        merchantId: 'external_seed',
        productId: 'ext_hang_2',
      }),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });

    expect(debug.PRODUCT_DETAIL_INFLIGHT.size).toBe(0);
  });

  test('a piggybacking concurrent caller is bounded too, not left awaiting forever', async () => {
    const { db, debug } = loadServer({ PRODUCT_DETAIL_MAX_LOAD_MS: '1000' });
    db.query.mockImplementation(() => new Promise(() => {}));

    // Both callers race for the same cacheKey; the second returns the STORED
    // promise. Before the fix that stored promise was the unguarded load, so
    // this second await never settled even after the first one timed out.
    const first = debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_hang_3',
    });
    const second = debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_hang_3',
    });

    await expect(first).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });
    await expect(second).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });
  });

  test("a caller's tighter budget still wins over the backstop", async () => {
    const { db, debug } = loadServer({ PRODUCT_DETAIL_MAX_LOAD_MS: '60000' });
    db.query.mockImplementation(() => new Promise(() => {}));

    const startedAt = Date.now();
    await expect(
      debug.fetchProductDetailForOffers({
        merchantId: 'external_seed',
        productId: 'ext_hang_4',
        totalTimeoutMs: 400,
      }),
    ).rejects.toMatchObject({ code: 'STAGE_TIMEOUT' });
    // Would be ~60s if the backstop clobbered the caller's own deadline.
    expect(Date.now() - startedAt).toBeLessThan(10000);
  });
});

describe('liveSyntheticPdpInflight — live identity-graph read is bounded', () => {
  function loadGraph(envOverrides = {}) {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      ...envOverrides,
    };
    return require('../src/services/pdpIdentityGraph')._internals;
  }

  test('a never-settling read degrades to null instead of hanging', async () => {
    const internals = loadGraph({ PDP_IDENTITY_GRAPH_LIVE_READ_BUDGET_MS: '300' });
    const bounded = internals.withLiveSyntheticPdpBudget(
      new Promise(() => {}),
      'ck_test',
    );
    await expect(bounded).resolves.toBeNull();
  });

  test('a healthy read passes its value through untouched', async () => {
    const internals = loadGraph({ PDP_IDENTITY_GRAPH_LIVE_READ_BUDGET_MS: '5000' });
    const value = { synthetic_product: { product_id: 'p1' } };
    await expect(
      internals.withLiveSyntheticPdpBudget(Promise.resolve(value), 'ck_ok'),
    ).resolves.toBe(value);
  });

  test('the in-flight map starts empty and is exported for eviction assertions', () => {
    const internals = loadGraph();
    expect(internals.liveSyntheticPdpInflight instanceof Map).toBe(true);
    expect(internals.liveSyntheticPdpInflight.size).toBe(0);
  });
});

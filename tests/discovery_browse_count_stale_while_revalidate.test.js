// The unfiltered browse product total came from a count query measured at ~0.9-1.7s, cached per
// instance for 60s. Landing-page traffic is a handful of requests an hour across 4+ instances, so the
// entry had always expired before the next visitor and every one of them paid the full query. A stale
// entry is now served immediately while a single background refresh runs.
//
// The property that matters is "returns WITHOUT WAITING". Asserting a value came back does not prove
// that - a stale read that awaited the refresh would return the same value. So the refresh query is held
// open (a promise that has not resolved) and the read must still complete.

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('browse catalog count: stale-while-revalidate', () => {
  let now;
  let queryImpl;
  let countCalls;
  let feed;
  const priorEnv = {};

  const request = { surface: 'browse_products', page: 1, limit: 12, scope: { brand_names: [], categories: [] }, query: { text: '' } };
  const isCountSql = (sql) => /count\(/i.test(String(sql || ''));

  beforeEach(() => {
    for (const key of ['DATABASE_URL', 'DISCOVERY_BROWSE_COUNT_CACHE_TTL_MS', 'DISCOVERY_BROWSE_COUNT_MAX_STALE_MS']) {
      priorEnv[key] = process.env[key];
    }
    process.env.DATABASE_URL = 'postgres://count-probe';
    delete process.env.DISCOVERY_BROWSE_COUNT_CACHE_TTL_MS;
    delete process.env.DISCOVERY_BROWSE_COUNT_MAX_STALE_MS;
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    countCalls = 0;
    queryImpl = async () => ({ rows: [{ total: 100 }] });
    jest.resetModules();
    jest.doMock('../src/db', () => ({
      query: (sql, params) => {
        if (isCountSql(sql)) countCalls += 1;
        return queryImpl(sql, params);
      },
      withClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    }));
    feed = require('../src/services/discoveryFeed')._internals;
    feed.resetBrowseCatalogCountCache();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('../src/db');
    jest.resetModules();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const warm = async (total = 100) => {
    queryImpl = async () => ({ rows: [{ total }] });
    const value = await feed.countStableBrowseCatalogTotal(request);
    expect(value.total).toBe(total);
  };

  test('a fresh entry is served without querying', async () => {
    await warm(100);
    countCalls = 0;
    now += 30_000; // inside the 60s TTL
    const value = await feed.countStableBrowseCatalogTotal(request);
    expect(value.total).toBe(100);
    expect(countCalls).toBe(0);
  });

  test('a stale entry is served WITHOUT waiting for the refresh', async () => {
    await warm(100);
    now += 5 * 60_000; // past the TTL, well inside max-stale
    const refresh = deferred();
    queryImpl = () => refresh.promise; // held open: never resolves during this read
    countCalls = 0;

    const outcome = await Promise.race([
      feed.countStableBrowseCatalogTotal(request).then((value) => ({ value })),
      new Promise((resolve) => setTimeout(() => resolve('waited on the refresh'), 200)),
    ]);

    expect(outcome).not.toBe('waited on the refresh');
    expect(outcome.value.total).toBe(100);
    expect(countCalls).toBe(1); // a refresh WAS started
    refresh.resolve({ rows: [{ total: 100 }] });
  });

  test('concurrent stale reads start exactly one refresh', async () => {
    await warm(100);
    now += 5 * 60_000;
    const refresh = deferred();
    queryImpl = () => refresh.promise;
    countCalls = 0;
    const values = await Promise.all(Array.from({ length: 10 }, () => feed.countStableBrowseCatalogTotal(request)));
    expect(values.every((value) => value.total === 100)).toBe(true);
    expect(countCalls).toBe(1);
    refresh.resolve({ rows: [{ total: 100 }] });
  });

  test('once the background refresh lands, the new total is served', async () => {
    await warm(100);
    now += 5 * 60_000;
    const refresh = deferred();
    queryImpl = () => refresh.promise;
    await feed.countStableBrowseCatalogTotal(request); // serves 100, starts the refresh
    refresh.resolve({ rows: [{ total: 250 }] });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    queryImpl = async () => ({ rows: [{ total: 999 }] }); // must not be needed
    countCalls = 0;
    const value = await feed.countStableBrowseCatalogTotal(request);
    expect(value.total).toBe(250);
    expect(countCalls).toBe(0);
  });

  test('a failed refresh keeps serving the last good total', async () => {
    await warm(100);
    now += 5 * 60_000;
    queryImpl = async () => { throw new Error('connection reset'); };
    const first = await feed.countStableBrowseCatalogTotal(request);
    expect(first.total).toBe(100);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const second = await feed.countStableBrowseCatalogTotal(request);
    // Not null, not the runtime-corpus fallback: the stale entry survived the failure.
    expect(second.total).toBe(100);
  });

  test('past max-stale the read waits for a real count again', async () => {
    await warm(100);
    now += 7 * 60 * 60 * 1000; // beyond the 6h default
    const refresh = deferred();
    queryImpl = () => refresh.promise;
    let settled = false;
    const pending = feed.countStableBrowseCatalogTotal(request).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false); // it is waiting, as before this change
    refresh.resolve({ rows: [{ total: 300 }] });
    expect((await pending).total).toBe(300);
  });

  test('DISCOVERY_BROWSE_COUNT_MAX_STALE_MS=0 restores the old wait-on-expiry behaviour', async () => {
    process.env.DISCOVERY_BROWSE_COUNT_MAX_STALE_MS = '0';
    await warm(100);
    now += 5 * 60_000;
    const refresh = deferred();
    queryImpl = () => refresh.promise;
    let settled = false;
    const pending = feed.countStableBrowseCatalogTotal(request).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    refresh.resolve({ rows: [{ total: 400 }] });
    expect((await pending).total).toBe(400);
  });

  test('concurrent cold misses share one count query', async () => {
    const refresh = deferred();
    queryImpl = () => refresh.promise;
    countCalls = 0;
    const reads = Array.from({ length: 5 }, () => feed.countStableBrowseCatalogTotal(request));
    refresh.resolve({ rows: [{ total: 42 }] });
    const values = await Promise.all(reads);
    expect(values.every((value) => value.total === 42)).toBe(true);
    expect(countCalls).toBe(1);
  });
});

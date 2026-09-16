const nock = require('nock');
const logger = require('../src/logger');
const { buildDiscoveryProfile, getDiscoveryFeed, _internals } = require('../src/services/discoveryFeed');
const { resetDiscoveryMetricsForTest } = require('../src/observability/discoveryMetrics');

const BASE_URL = 'http://discovery-catalog.test';
const ENV_KEYS = [
  'DISCOVERY_PRODUCTS_SEARCH_BASE_URL',
  'DISCOVERY_PRODUCTS_SEARCH_API_KEY',
  'DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS',
  'DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS',
  'DISCOVERY_PRODUCTS_SEARCH_BREAKER_FAILURES',
  'DISCOVERY_PRODUCTS_SEARCH_BREAKER_COOLDOWN_MS',
  'DISCOVERY_PRODUCTS_SEARCH_BREAKER_MAX_COOLDOWN_MS',
  'DISCOVERY_RECALL_BUDGET_MS',
  'DATABASE_URL',
];

function brandRequest(brand = 'Meebak') {
  return _internals.normalizeDiscoveryRequest({
    surface: 'browse_products',
    page: 1,
    limit: 12,
    scope: { brand_names: [brand] },
    context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] },
  });
}

function load(brand) {
  return _internals.loadProductsSearchCandidates({ request: brandRequest(brand), profile: {}, limit: 48 });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Every HTTP call lands here; `respond` decides the answer per call.
function interceptSearch(respond) {
  const calls = [];
  nock(BASE_URL)
    .persist()
    .get('/agent/v1/products/search')
    .query(true)
    .reply(async (uri) => {
      calls.push(uri);
      return respond(calls.length);
    });
  return calls;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i += 1) await sleep(5);
}

describe('products_search circuit breaker', () => {
  let previousEnv;
  let clock;

  beforeEach(() => {
    previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.DISCOVERY_PRODUCTS_SEARCH_BASE_URL = BASE_URL;
    process.env.DISCOVERY_PRODUCTS_SEARCH_API_KEY = 'test-key';
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BREAKER_FAILURES;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BREAKER_COOLDOWN_MS;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_BREAKER_MAX_COOLDOWN_MS;
    delete process.env.DISCOVERY_PRODUCTS_SEARCH_TIMEOUT_MS;
    delete process.env.DISCOVERY_RECALL_BUDGET_MS;
    delete process.env.DATABASE_URL;
    resetDiscoveryMetricsForTest();
    _internals.resetBrowsePoolCache();
    _internals.resetProductsSearchBreaker();
    nock.cleanAll();
    nock.disableNetConnect();
    clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    nock.cleanAll();
    nock.enableNetConnect();
    _internals.resetProductsSearchBreaker();
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  test('opens after three consecutive failures and then serves without calling the upstream', async () => {
    const calls = interceptSearch(() => [503, { error: 'backend unavailable' }]);

    for (let i = 0; i < 3; i += 1) {
      const result = await load();
      expect(result.recallSummary[0]).toEqual(expect.objectContaining({ failure_reason: 'http_5xx' }));
    }
    expect(calls).toHaveLength(3);
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: true, consecutive_failures: 3, cooldown_ms: 60000, open_until: clock + 60000 }),
    );

    const skipped = await load();
    expect(calls).toHaveLength(3);
    expect(skipped.products).toEqual([]);
    expect(skipped.recallSummary).toEqual([
      expect.objectContaining({
        provider: 'products_search',
        skipped: true,
        skip_reason: 'circuit_open',
        latency_ms: 0,
        returned: 0,
      }),
    ]);
  });

  test('stays closed below the threshold, and a success resets the failure count', async () => {
    const calls = interceptSearch((n) => (n === 3 ? [200, { products: [] }] : [503, {}]));

    await load();
    await load();
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: false, consecutive_failures: 2 }),
    );
    await load(); // success
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: false, consecutive_failures: 0 }),
    );
    await load();
    await load();
    expect(_internals.getProductsSearchBreakerState().open).toBe(false);
    await load();
    expect(_internals.getProductsSearchBreakerState().open).toBe(true);
    expect(calls).toHaveLength(6);
  });

  test('a threshold of 1 opens on the first failure', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BREAKER_FAILURES = '1';
    interceptSearch(() => [503, {}]);
    await load();
    expect(_internals.getProductsSearchBreakerState().open).toBe(true);
  });

  test('step timeouts count as failures, like the prod outage', async () => {
    process.env.DISCOVERY_RECALL_BUDGET_MS = '500';
    jest.restoreAllMocks(); // real clock: axios times the request out in real time
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const calls = interceptSearch(async () => {
      await sleep(700);
      return [200, { products: [] }];
    });

    for (let i = 0; i < 3; i += 1) {
      const result = await load();
      expect(result.recallSummary[0]).toEqual(expect.objectContaining({ failure_reason: 'timeout' }));
    }
    expect(_internals.getProductsSearchBreakerState().open).toBe(true);

    const startedAt = Date.now();
    const skipped = await load();
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(skipped.recallSummary[0]).toEqual(expect.objectContaining({ skip_reason: 'circuit_open' }));
    expect(calls).toHaveLength(3);
  });

  test('after the cooldown a single background probe runs, and no request waits for it', async () => {
    const gate = deferred();
    let failing = true;
    const calls = interceptSearch(async () => {
      if (failing) return [503, {}];
      await gate.promise;
      return [200, { products: [] }];
    });
    for (let i = 0; i < 3; i += 1) await load();
    failing = false;

    clock += 59_999;
    await load();
    await sleep(50);
    expect(calls).toHaveLength(3); // still cooling down: no probe

    clock += 1;
    const first = await load(); // resolves while the probe is held open
    const second = await load();
    await waitFor(() => calls.length >= 4);
    await sleep(50);
    expect(first.recallSummary[0]).toEqual(expect.objectContaining({ skip_reason: 'circuit_open' }));
    expect(second.recallSummary[0]).toEqual(expect.objectContaining({ skip_reason: 'circuit_open' }));
    expect(calls).toHaveLength(4); // exactly one probe
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: true, probe_inflight: true }),
    );

    gate.resolve();
    await waitFor(() => !_internals.getProductsSearchBreakerState().probe_inflight);
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: false, consecutive_failures: 0, probe_inflight: false }),
    );

    const closed = await load();
    expect(calls).toHaveLength(5);
    expect(closed.recallSummary[0]).toEqual(expect.objectContaining({ status: 200 }));
  });

  test('a failed probe doubles the cooldown, capped at the maximum', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BREAKER_MAX_COOLDOWN_MS = '200000';
    const calls = interceptSearch(() => [503, {}]);
    for (let i = 0; i < 3; i += 1) await load();

    const waitForProbe = () => waitFor(() => !_internals.getProductsSearchBreakerState().probe_inflight);
    const expected = [120000, 200000, 200000];
    for (const cooldown of expected) {
      clock = _internals.getProductsSearchBreakerState().open_until;
      await load();
      await waitForProbe();
      expect(_internals.getProductsSearchBreakerState()).toEqual(
        expect.objectContaining({ open: true, cooldown_ms: cooldown, open_until: clock + cooldown }),
      );
    }
    expect(calls).toHaveLength(6);
  });

  test('a call already in flight when the circuit opens does not stretch the cooldown', async () => {
    const gate = deferred();
    let n = 0;
    interceptSearch(async () => {
      n += 1;
      if (n === 1) await gate.promise;
      return [503, {}];
    });
    const slow = load(); // call 1, held open
    await waitFor(() => n >= 1);
    for (let i = 0; i < 3; i += 1) await load();
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: true, cooldown_ms: 60000, open_until: clock + 60000 }),
    );
    gate.resolve();
    await slow;
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: true, cooldown_ms: 60000, open_until: clock + 60000, consecutive_failures: 3 }),
    );
  });

  test('DISCOVERY_PRODUCTS_SEARCH_BREAKER_FAILURES=0 disables the breaker', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_BREAKER_FAILURES = '0';
    const calls = interceptSearch(() => [503, {}]);
    for (let i = 0; i < 6; i += 1) {
      const result = await load();
      expect(result.recallSummary[0].skip_reason).toBeUndefined();
    }
    expect(calls).toHaveLength(6);
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: false, consecutive_failures: 0, cooldown_ms: 0 }),
    );
  });

  test('setting DISCOVERY_PRODUCTS_SEARCH_BREAKER_FAILURES=0 while open resumes calling at once', async () => {
    const calls = interceptSearch(() => [503, {}]);
    for (let i = 0; i < 3; i += 1) await load();
    expect(_internals.getProductsSearchBreakerState().open).toBe(true);

    process.env.DISCOVERY_PRODUCTS_SEARCH_BREAKER_FAILURES = '0';
    const result = await load();
    expect(calls).toHaveLength(4);
    expect(result.recallSummary[0].skip_reason).toBeUndefined();
  });

  test('the parallel home_hot_deals path feeds the breaker too', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS = '2';
    const calls = interceptSearch(() => [503, {}]);
    const request = _internals.normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      limit: 6,
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          { merchant_id: 'm1', product_id: 'p1', brand: 'Glow Lab', product_type: 'Serum', category: 'Skincare' },
          { merchant_id: 'm2', product_id: 'p2', brand: 'Glow Lab', product_type: 'Toner', category: 'Skincare' },
        ],
        recent_queries: [],
      },
    });
    const profile = buildDiscoveryProfile(request.context);

    const first = await _internals.loadProductsSearchCandidates({ request, profile, limit: 48 });
    // Both steps ran in one parallel batch: that is the path under test.
    expect(first.recallSummary).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(_internals.getProductsSearchBreakerState()).toEqual(
      expect.objectContaining({ open: false, consecutive_failures: 2 }),
    );
    await _internals.loadProductsSearchCandidates({ request, profile, limit: 48 });
    expect(_internals.getProductsSearchBreakerState().open).toBe(true);

    const skipped = await _internals.loadProductsSearchCandidates({ request, profile, limit: 48 });
    expect(calls).toHaveLength(4);
    expect(skipped.recallSummary[0]).toEqual(expect.objectContaining({ skip_reason: 'circuit_open' }));
  });

  test('the feed reports the provider as skipped with circuit_open and makes no upstream call', async () => {
    process.env.DISCOVERY_PRODUCTS_SEARCH_MAX_CALLS = '1';
    const calls = interceptSearch(() => [503, { error: 'backend unavailable' }]);
    const feed = () =>
      getDiscoveryFeed({
        surface: 'home_hot_deals',
        limit: 6,
        context: { auth_state: 'anonymous', locale: 'en-US', recent_views: [], recent_queries: [] },
      }).then(
        () => null,
        (caught) => caught,
      );

    while (!_internals.getProductsSearchBreakerState().open && calls.length < 10) await feed();
    const before = calls.length;
    const err = await feed();

    expect(calls).toHaveLength(before);
    // Same outcome as a failed call: no provider succeeded, so the catalog is unavailable.
    expect(err).toMatchObject({ code: 'DISCOVERY_CATALOG_UNAVAILABLE' });
    expect(err.details.providerBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'products_search',
          attempted: true,
          successful: false,
          skipped: true,
          skip_reason: 'circuit_open',
          latency_ms: 0,
        }),
      ]),
    );
  });
});

// The brand-direct discovery pool (brand pages) is cached per gateway instance. The 2026-09-15
// pivota-pg CPU incident was ~22 brand pages opened over and over; every open re-ran two
// CPU-heavy brand queries. These tests drive the REAL brand fetchers against a mocked `../db`, so
// the cache is exercised on the path production takes — not through injected fetch stubs, which
// deliberately bypass it.

const SIGS = ['sig_00000000000000000000000000000001', 'sig_00000000000000000000000000000002', 'sig_00000000000000000000000000000003'];

describe('brand-direct discovery pool cache', () => {
  let priorEnv;
  let canonicalCalls;
  let externalCalls;
  let canonicalBehaviour;
  let discovery;

  const canonicalRows = () => SIGS.map((sig, index) => ({
    pivota_signature_id: sig,
    title: `Mixsoon Bean Essence ${index}`,
    brand: 'mixsoon',
    content_key: `ck_${index}`,
  }));

  const load = () => {
    jest.resetModules();
    jest.doMock('../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql);
        if (text.includes('agent_pdp_view')) {
          canonicalCalls += 1;
          return canonicalBehaviour();
        }
        if (text.includes('external_product_seeds')) {
          externalCalls += 1;
          return { rows: [] };
        }
        return { rows: [] };
      }),
      withClient: jest.fn(async (fn) => fn({ query: async () => ({ rows: [] }) })),
    }));
    discovery = require('../src/services/discoveryFeed');
    discovery._internals.resetBrandDirectPoolCache();
  };

  const request = () => discovery._internals.normalizeDiscoveryRequest({
    surface: 'browse_products',
    scope: { brand_names: ['Mixsoon'] },
    query: { text: 'Mixsoon' },
    page: 1,
    limit: 24,
  });
  const loadPool = (overrides = {}) => discovery._internals.loadBrandScopedDirectCandidates({
    request: request(),
    brandAliases: ['mixsoon'],
    limit: 72,
    ...overrides,
  });

  beforeEach(() => {
    priorEnv = { ...process.env };
    process.env.DATABASE_URL = 'postgres://fixture';
    process.env.BRAND_PAGE_USES_COMMERCE_INDEX = 'true';
    delete process.env.DISCOVERY_BRAND_DIRECT_CACHE_TTL_MS;
    canonicalCalls = 0;
    externalCalls = 0;
    canonicalBehaviour = async () => ({ rows: canonicalRows() });
    load();
  });

  afterEach(() => {
    process.env = priorEnv;
    jest.restoreAllMocks();
    jest.dontMock('../src/db');
    jest.resetModules();
  });

  test('control: a load really reaches the brand queries and returns products', async () => {
    const result = await loadPool();
    expect(canonicalCalls).toBe(1);
    expect(externalCalls).toBeGreaterThanOrEqual(1);
    expect(result.products.map((p) => p.product_id).sort()).toEqual([...SIGS].sort());
    expect(result.recallSummary[0].cache_hit).toBe(false);
  });

  test('a second open within the TTL is served without querying the database', async () => {
    const first = await loadPool();
    const second = await loadPool();
    expect(canonicalCalls).toBe(1);
    expect(second.products).toEqual(first.products);
    expect(second.recallSummary[0]).toEqual(expect.objectContaining({ cache_hit: true, label: 'brand_direct_pool' }));
    expect(second.recallSummary[0].cache_age_ms).toBeGreaterThanOrEqual(0);
  });

  test('concurrent opens of the same brand share one load', async () => {
    canonicalBehaviour = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { rows: canonicalRows() };
    };
    const [a, b, c] = await Promise.all([loadPool(), loadPool(), loadPool()]);
    expect(canonicalCalls).toBe(1);
    expect(b.products).toEqual(a.products);
    expect(c.products).toEqual(a.products);
  });

  test('a swallowed query failure is never cached (no empty brand page pinned for minutes)', async () => {
    let failNext = true;
    canonicalBehaviour = async () => {
      if (failNext) {
        failNext = false;
        throw new Error('timeout exceeded when trying to connect');
      }
      return { rows: canonicalRows() };
    };
    const failed = await loadPool();
    expect(failed.products).toEqual([]);
    const recovered = await loadPool();
    expect(canonicalCalls).toBe(2);
    expect(recovered.products).toHaveLength(SIGS.length);
    expect(recovered.recallSummary[0].cache_hit).toBe(false);
    await loadPool();
    expect(canonicalCalls).toBe(2);
  });

  test('an entry expires after the TTL', async () => {
    process.env.DISCOVERY_BRAND_DIRECT_CACHE_TTL_MS = '60000';
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await loadPool();
    now += 59_000;
    await loadPool();
    expect(canonicalCalls).toBe(1);
    now += 2_000;
    await loadPool();
    expect(canonicalCalls).toBe(2);
  });

  test('TTL 0 disables the cache', async () => {
    process.env.DISCOVERY_BRAND_DIRECT_CACHE_TTL_MS = '0';
    await loadPool();
    await loadPool();
    expect(canonicalCalls).toBe(2);
  });

  test('mutating a returned product cannot corrupt the next hit', async () => {
    // A miss result (the load's own value)...
    const first = await loadPool();
    first.products[0].title = 'MUTATED';
    first.products.push({ product_id: 'sig_injected' });
    const second = await loadPool();
    expect(canonicalCalls).toBe(1);
    expect(second.products).toHaveLength(SIGS.length);
    expect(second.products.some((p) => p.title === 'MUTATED')).toBe(false);
    // ...and a HIT result: a caller scoring/mutating what the cache handed it must not reach the
    // stored entry either.
    second.products[1].title = 'MUTATED_HIT';
    second.products.length = 1;
    second.recallSummary[0].cache_age_ms = -1;
    const third = await loadPool();
    expect(canonicalCalls).toBe(1);
    expect(third.products).toHaveLength(SIGS.length);
    expect(third.products.some((p) => p.title === 'MUTATED_HIT')).toBe(false);
    expect(third.recallSummary[0].cache_age_ms).toBeGreaterThanOrEqual(0);
  });

  test('different limits and different brands are separate entries', async () => {
    await loadPool({ limit: 72 });
    await loadPool({ limit: 240 });
    await loadPool({ brandAliases: ['tocobo'] });
    expect(canonicalCalls).toBe(3);
    await loadPool({ limit: 240 });
    expect(canonicalCalls).toBe(3);
  });

  test('injected fetch functions bypass the cache', async () => {
    const fetchExternalCandidatesFn = jest.fn(async () => [{ merchant_id: 'm', product_id: 'p1' }]);
    const fetchInternalCandidatesFn = jest.fn(async () => []);
    await loadPool({ fetchExternalCandidatesFn, fetchInternalCandidatesFn });
    await loadPool({ fetchExternalCandidatesFn, fetchInternalCandidatesFn });
    expect(fetchExternalCandidatesFn).toHaveBeenCalledTimes(2);
  });
});

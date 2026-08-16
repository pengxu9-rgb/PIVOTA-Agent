const REQUIRED_COLUMNS = [
  { table_name: 'products_cache', column_name: 'id' },
  { table_name: 'products_cache', column_name: 'merchant_id' },
  { table_name: 'products_cache', column_name: 'product_data' },
  { table_name: 'products_cache', column_name: 'expires_at' },
  { table_name: 'products_cache', column_name: 'cached_at' },
  { table_name: 'external_product_seeds', column_name: 'id' },
  { table_name: 'external_product_seeds', column_name: 'external_product_id' },
  { table_name: 'external_product_seeds', column_name: 'destination_url' },
  { table_name: 'external_product_seeds', column_name: 'canonical_url' },
  { table_name: 'external_product_seeds', column_name: 'title' },
  { table_name: 'external_product_seeds', column_name: 'seed_data' },
  { table_name: 'external_product_seeds', column_name: 'market' },
  { table_name: 'external_product_seeds', column_name: 'tool' },
  { table_name: 'external_product_seeds', column_name: 'status' },
  { table_name: 'external_product_seeds', column_name: 'attached_product_key' },
  { table_name: 'external_product_seeds', column_name: 'updated_at' },
  { table_name: 'external_product_seeds', column_name: 'created_at' },
];

const REQUIRED_INDEXES = [
  'idx_external_product_seeds_recall_title_trgm',
  'idx_external_product_seeds_recall_summary_trgm',
  'idx_external_product_seeds_recall_category_vertical_recency',
  'idx_external_product_seeds_recall_vertical_recency',
  'idx_external_product_seeds_recall_ingredient_tokens_trgm',
  'idx_external_product_seeds_recall_alias_tokens_trgm',
].map((indexname) => ({ tablename: 'external_product_seeds', indexname }));

const makeSigRow = (index, overrides = {}) => ({
  content_key: `ck_${index}`,
  pivota_signature_id: `sig_${String(index).padStart(4, '0')}`,
  first_party_merchant_id: null,
  first_party_platform: null,
  first_party_source_product_id: null,
  first_party_product_key: null,
  external_product_id: `ext_${index}`,
  external_product_key: `external_seed:ext_${index}`,
  brand: 'Alpha',
  title: `Canonical Product ${index}`,
  description: `Description for canonical product ${index}`,
  image_url: `https://example.com/images/${index}.jpg`,
  image_urls: [`https://example.com/images/${index}.jpg`],
  currency: 'USD',
  price_min: 24,
  price_max: 24,
  offer_count: 1,
  offers: [{ merchant_id: 'external_seed', price: 24 }],
  category_path: ['Beauty', 'Skincare'],
  ...overrides,
});

const isSigQuery = (sql) => String(sql).includes('FROM agent_pdp_view apv');
const isSeedQuery = (sql) => String(sql).includes('external_product_seeds');

function buildDbMock(sigRows) {
  const calls = [];
  const mock = jest.fn((sql, params) => {
    const text = String(sql || '');
    calls.push({ sql: text, params });
    if (text.includes('information_schema.columns')) return Promise.resolve({ rows: REQUIRED_COLUMNS });
    if (text.includes('pg_indexes')) return Promise.resolve({ rows: REQUIRED_INDEXES });
    if (isSigQuery(text)) return Promise.resolve({ rows: sigRows });
    return Promise.resolve({ rows: [] });
  });
  return { mock, calls };
}

function loadInternals(dbMock) {
  jest.resetModules();
  jest.doMock('../src/db', () => ({ query: dbMock }));
  // eslint-disable-next-line global-require
  const { _internals } = require('../src/services/discoveryFeed');
  _internals.resetDiscoveryDependencyProbeCache();
  return _internals;
}

const GENERIC_BROWSE_REQUEST = {
  surface: 'browse_products',
  page: 1,
  limit: 60,
  context: {
    auth_state: 'anonymous',
    locale: 'en-US',
    recent_views: [],
    recent_queries: [],
  },
};

describe('canonical sig browse main route', () => {
  const prevDatabaseUrl = process.env.DATABASE_URL;
  const prevFlag = process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG;

  afterEach(() => {
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    if (prevFlag === undefined) delete process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG;
    else process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = prevFlag;
    jest.resetModules();
  });

  test('identity resolves product first, then merchant', () => {
    const internals = loadInternals(jest.fn());

    const seedMirrored = internals.mapCanonicalIndexRowToProduct(makeSigRow(1));
    expect(seedMirrored.id).toBe('sig_0001');
    expect(seedMirrored.pivota_signature_id).toBe('sig_0001');
    // No connected first-party row for this identity, so the merchant falls back
    // to the external-seed mirror rather than inventing one.
    expect(seedMirrored.merchant_id).toBe('external_seed');
    expect(seedMirrored.external_product_id).toBe('ext_1');

    const firstParty = internals.mapCanonicalIndexRowToProduct(
      makeSigRow(2, {
        first_party_merchant_id: 'merch_live_123',
        first_party_platform: 'shopify',
        first_party_source_product_id: '99887766',
        first_party_product_key: 'shopify:99887766',
      }),
    );
    // Same sig identity, but a real merchant now owns the offer.
    expect(firstParty.id).toBe('sig_0002');
    expect(firstParty.merchant_id).toBe('merch_live_123');
    expect(firstParty.platform).toBe('shopify');
    expect(firstParty.product_key).toBe('shopify:99887766');
  });

  test('flag is off by default so the seed lane keeps serving', () => {
    const internals = loadInternals(jest.fn());
    expect(internals.browseUsesCanonicalSig()).toBe(false);

    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
    expect(internals.browseUsesCanonicalSig()).toBe(true);
  });

  test('query gates on public trust and orders deterministically for cursor paging', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    const { mock, calls } = buildDbMock([makeSigRow(1)]);
    const internals = loadInternals(mock);

    await internals.fetchCanonicalSigBrowseCandidates({ request: GENERIC_BROWSE_REQUEST, limit: 60 });

    const sigCall = calls.find((call) => isSigQuery(call.sql));
    expect(sigCall).toBeTruthy();
    expect(sigCall.sql).toContain("crt.serving_decision = 'public'");
    // A refreshed_at-only sort has ties, and browse re-runs this query per page.
    expect(sigCall.sql).toContain('apv.pivota_signature_id ASC');
    // Unscoped browse must not filter on a category the corpus may not carry.
    expect(sigCall.sql).not.toContain('unnest(apv.category_path)');
  });

  test('category scope filters on the identity row own category path', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    const { mock, calls } = buildDbMock([makeSigRow(1)]);
    const internals = loadInternals(mock);

    await internals.fetchCanonicalSigBrowseCandidates({
      request: { ...GENERIC_BROWSE_REQUEST, scope: { categories: ['Skincare'] } },
      limit: 60,
    });

    const sigCall = calls.find((call) => isSigQuery(call.sql));
    expect(sigCall.sql).toContain('unnest(apv.category_path)');
    expect(sigCall.params).toContainEqual(['skincare']);
  });

  test('a sufficient sig index skips the external seed lane entirely', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
    const sigRows = Array.from({ length: 120 }, (_, index) => makeSigRow(index + 1));
    const { mock, calls } = buildDbMock(sigRows);
    const internals = loadInternals(mock);

    const result = await internals.loadCatalogCandidates({
      request: internals.normalizeDiscoveryRequest(GENERIC_BROWSE_REQUEST),
      profile: { hasInterestSignals: false },
      limit: 120,
    });

    expect(result.candidateSource).toBe('canonical_sig');
    expect(result.primaryPathUsed).toBe('canonical_sig');
    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products[0].pivota_signature_id).toMatch(/^sig_/);

    // The point of the main route: when the identity index covers the page, the
    // legacy seed ladder must not run at all — not merely run faster.
    expect(calls.filter((call) => isSeedQuery(call.sql))).toHaveLength(0);

    const seedProvider = (result.providerBreakdown || []).find(
      (entry) => entry.provider === 'external_seeds',
    );
    expect(seedProvider).toMatchObject({ skipped: true, skip_reason: 'canonical_sig_sufficient' });
  });

  test('an empty sig index falls back to the seed lane instead of serving nothing', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
    const { mock, calls } = buildDbMock([]);
    const internals = loadInternals(mock);

    const result = await internals.loadCatalogCandidates({
      request: internals.normalizeDiscoveryRequest(GENERIC_BROWSE_REQUEST),
      profile: { hasInterestSignals: false },
      limit: 120,
    });

    expect(result.fallbackTriggered).toBe(true);
    // The sig index was consulted and came back empty, so the seed lane still
    // ran. fallbackReason reflects the LAST stage to fall back, which is the
    // seed fastpath — the canonical_sig attempt is recorded in the breakdown.
    expect(calls.filter((call) => isSigQuery(call.sql))).toHaveLength(1);
    expect(calls.filter((call) => isSeedQuery(call.sql)).length).toBeGreaterThan(0);

    // "Consulted and empty" must be distinguishable from "never ran".
    const sigProvider = (result.providerBreakdown || []).find(
      (entry) => entry.provider === 'canonical_sig',
    );
    expect(sigProvider).toMatchObject({ attempted: true, returned: 0, skipped: false });
  });
});

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
  external_brand: 'Alpha',
  // Deliberately DIFFERENT from external_destination_url: identical fixture
  // values made "destination_url reads the seed URL" and "merchant_canonical_url
  // reads the catalog URL" mutually indistinguishable, so swapping them passed.
  external_canonical_url: `https://alpha.example.com/catalog/${index}`,
  external_seed_id: `eps_${index}`,
  external_destination_url: `https://alpha.example.com/buy/${index}`,
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
// A seed-LANE query is one that recalls FROM the seeds table. The sig reader
// also touches external_product_seeds — inside a lateral, to carry the seed id
// and destination URL for the identity every other lane serves — so a bare
// substring match would count the sig query itself as the seed lane and make
// "the seed lane did not run" unprovable.
const isSeedQuery = (sql) => {
  const text = String(sql);
  return text.includes('external_product_seeds') && !isSigQuery(text);
};

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

  // The consumer (agent-ui isKnownUnservableProduct) treats an external-seed
  // product carrying a sig_ id but NONE of {external_seed_id, seed_id,
  // external_redirect_url, action.redirect_url, seed_data, external_seed_recall}
  // as unservable and drops it. The sig reader emitted exactly that shape, so
  // with the flag on the API returned 24 products and the page rendered zero.
  // This pins the fields the reader must carry — the same ones every other lane
  // serves — using the consumer's own predicate, transcribed, so a future
  // "tidy up" of the mapper cannot silently re-break the page.
  function consumerWouldDrop(p) {
    const seedEvidence = [p.external_seed_id, p.seed_id, p.external_redirect_url,
      p.action && p.action.redirect_url, p.seed_data, p.external_seed_recall]
      .some((v) => v != null && String(v).trim().length > 0);
    const isExternalSeed = p.merchant_id === 'external_seed' || p.platform === 'external_seed'
      || String(p.source_product_id || '').startsWith('ext_');
    const hasSig = String(p.product_id || '').startsWith('sig_');
    return isExternalSeed && !seedEvidence && hasSig;
  }

  test('an external-seed row carries the identity the consumer requires to render it', () => {
    const internals = loadInternals(jest.fn());
    const product = internals.mapCanonicalIndexRowToProduct(makeSigRow(7));

    // The exact fields the seed lane serves and the UI keys on.
    expect(product.external_seed_id).toBe('eps_7');
    // From the catalog brand: reading seed_data for a seller name cost 6x on a
    // field this surface never renders.
    expect(product.merchant_name).toBe('Alpha');
    // Distinct URLs: the buyer's redirect is the SEED's destination, and the
    // merchant canonical is the CATALOG url. Swapping them must fail.
    expect(product.merchant_canonical_url).toBe('https://alpha.example.com/catalog/7');
    expect(product.destination_url).toBe('https://alpha.example.com/buy/7');
    // Never emitted: sourcing it from the co-identified catalog row pointed 49
    // servable products at a DIFFERENT product's PDP, and agent-ui prefers it
    // over pivota_signature_id when resolving the route.
    expect(product.pivota_canonical_url).toBeUndefined();
    expect(product.platform_product_id).toBe('ext_7');
    // Convention both lanes share: provenance sentinel here, real seller in merchant_name.
    expect(product.merchant_id).toBe('external_seed');

    expect(consumerWouldDrop(product)).toBe(false);
  });

  test('a first-party row does not borrow external identity', () => {
    const internals = loadInternals(jest.fn());
    const product = internals.mapCanonicalIndexRowToProduct(
      makeSigRow(8, {
        first_party_merchant_id: 'merch_live_8',
        first_party_platform: 'shopify',
        first_party_source_product_id: '8008',
        first_party_product_key: 'shopify:8008',
      }),
    );
    expect(product.merchant_id).toBe('merch_live_8');
    // A connected storefront's product must not be dressed as an external seed:
    // the redirect/purchase flow reads destination_url and would send the buyer
    // off-platform.
    expect(product.external_seed_id).toBeUndefined();
    expect(product.destination_url).toBeUndefined();
    expect(product.merchant_canonical_url).toBeUndefined();
    expect(product.merchant_name).toBeUndefined();
    expect(consumerWouldDrop(product)).toBe(false);
  });

  test('a row with no active seed falls back to the catalog url and brand', () => {
    const internals = loadInternals(jest.fn());
    const row = makeSigRow(9);
    delete row.external_seed_id;
    delete row.external_destination_url;
    const product = internals.mapCanonicalIndexRowToProduct(row);

    // 3 servable rows have no active seed. They still need a merchant link and
    // a name; the catalog url and brand are the honest fallbacks.
    expect(product.destination_url).toBe('https://alpha.example.com/catalog/9');
    expect(product.merchant_canonical_url).toBe('https://alpha.example.com/catalog/9');
    expect(product.merchant_name).toBe('Alpha');
    // With no seed evidence the consumer WILL drop it — that is correct, the
    // row genuinely has no seed backing it.
    expect(product.external_seed_id).toBeUndefined();
  });

  // Parameterised over BOTH readers. fetchBrandScopedCanonicalCandidates is LIVE
  // in production (BRAND_PAGE_USES_COMMERCE_INDEX=true) and shares this SELECT,
  // this lateral and this mapper, while the sig reader is still flag-gated — so
  // the untested half was the half that ships. Deleting the nested seed lateral
  // from the brand query, deleting its new SELECT aliases, or reverting its
  // IS NOT DISTINCT FROM all passed until this covered it.
  const CANONICAL_READERS = [
    {
      name: 'sig browse',
      run: (internals) => internals.fetchCanonicalSigBrowseCandidates({ limit: 60 }),
    },
    {
      name: 'brand page',
      run: (internals) => internals.fetchBrandScopedCanonicalCandidates({ brandAliases: ['alpha'], limit: 60 }),
    },
  ];

  test.each(CANONICAL_READERS)('the $name query selects every column the mapper depends on', async ({ run }) => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    const { mock, calls } = buildDbMock([makeSigRow(1)]);
    const internals = loadInternals(mock);

    await run(internals);

    const sql = calls.map((call) => call.sql).find(isSigQuery);
    expect(sql).toBeTruthy();
    for (const column of [
      'AS external_product_id',
      'AS external_product_key',
      'AS external_brand',
      'AS external_canonical_url',
      'AS external_seed_id',
      'AS external_destination_url',
    ]) {
      expect(sql).toContain(column);
    }
    // The nested lateral that supplies the seed id and the buyer's destination.
    expect(sql).toContain('FROM external_product_seeds eps');
    expect(sql).toContain('eps.attached_product_key = cp.product_key');
    // The row pick must prefer THIS identity, and must use IS NOT DISTINCT FROM:
    // NULL = sig is NULL and ORDER BY DESC sorts NULLs FIRST, which would hand
    // the pick to one of the 211 live rows with a NULL sig.
    expect(sql).toContain('cp.pivota_signature_id IS NOT DISTINCT FROM apv.pivota_signature_id');
    expect(sql).not.toMatch(/cp\.pivota_signature_id\s*=\s*apv\.pivota_signature_id/);
    // Never reintroduce the column that pointed 49 rows at another product's
    // PDP. Matched loosely: `AS` on the next line evaded a toContain check.
    expect(sql).not.toMatch(/pivota_canonical_url/);
    // And never read seed_data here — it detoasts a 435MB column per row.
    expect(sql).not.toMatch(/eps\.seed_data/);
    // The seed pick must prefer the storefront the card's merchant_canonical_url
    // names, or one card shows merchant A and links the buy button to seller B
    // (13 live rows before this). Same NULL hazard as the outer pick, so the
    // guard and IS NOT DISTINCT FROM must both be present.
    expect(sql).toContain("substring(eps.destination_url from '^https?://([^/]+)')");
    expect(sql).toContain('eps.destination_url IS NOT NULL');
    expect(sql).toMatch(/substring\(eps\.destination_url[\s\S]*?IS NOT DISTINCT FROM[\s\S]*?substring\(cp\.canonical_url/);
  });

  test('a real query failure is never reported as a successful empty provider', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';

    // The sig index fails for a reason that is NOT "migrations pending", and
    // every other provider is unreachable too.
    const mock = jest.fn((sql) => {
      const text = String(sql || '');
      if (text.includes('information_schema.columns')) return Promise.resolve({ rows: REQUIRED_COLUMNS });
      if (text.includes('pg_indexes')) return Promise.resolve({ rows: REQUIRED_INDEXES });
      if (isSigQuery(text)) return Promise.reject(new Error('canceling statement due to statement timeout'));
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    const internals = loadInternals(mock);

    // Flattening the failure to [] would record canonical_sig as a 200 with zero
    // rows, which counts as a successful provider and suppresses this throw —
    // turning a dead database into a healthy-looking empty page and making the
    // discovery smoke gate pass on it.
    await expect(
      internals.loadCatalogCandidates({
        request: internals.normalizeDiscoveryRequest(GENERIC_BROWSE_REQUEST),
        profile: { hasInterestSignals: false },
        limit: 120,
      }),
    ).rejects.toThrow(/Failed to load discovery candidates/);
  });

  test('an unreadable index is not recorded as a successful empty provider', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';

    // Migrations not applied yet. This must behave like "no index to read", NOT
    // like a healthy read that returned nothing — otherwise a status-200
    // zero-row provider counts as successful and suppresses the unavailable
    // error, which is the same defect as a flattened query failure.
    const mock = jest.fn((sql) => {
      const text = String(sql || '');
      if (text.includes('information_schema.columns')) return Promise.resolve({ rows: REQUIRED_COLUMNS });
      if (text.includes('pg_indexes')) return Promise.resolve({ rows: REQUIRED_INDEXES });
      if (isSigQuery(text)) {
        return Promise.reject(new Error('relation "agent_pdp_view" does not exist'));
      }
      return Promise.reject(new Error('ECONNREFUSED'));
    });
    const internals = loadInternals(mock);

    await expect(
      internals.loadCatalogCandidates({
        request: internals.normalizeDiscoveryRequest(GENERIC_BROWSE_REQUEST),
        profile: { hasInterestSignals: false },
        limit: 120,
      }),
    ).rejects.toThrow(/Failed to load discovery candidates/);
  });

  test('a missing DATABASE_URL is not recorded as a successful empty provider', async () => {
    delete process.env.DATABASE_URL;
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';

    const internals = loadInternals(jest.fn(() => Promise.resolve({ rows: [] })));
    // Returns null — "there is no index here" — rather than an empty array that
    // the caller would record as a healthy zero-row read.
    await expect(internals.fetchCanonicalSigBrowseCandidates({ limit: 60 })).resolves.toBeNull();
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
    expect(seedProvider).toMatchObject({ skipped: true, skip_reason: 'canonical_sig_primary_used' });
  });

  // NOTE: this pins that a thin index still consults the fallbacks. It does NOT
  // pin the quality-aware gate against a raw `mergedProducts.length` bar — at
  // this row count both spellings fall back, so the distinction is not
  // unit-observable here. `hasSufficientProviderCandidates` is shared with the
  // beauty mainline path and covered by its tests.
  // The gate is domain-blind on volume alone, and every other fixture in this
  // file is ['Beauty','Skincare'] — so the suite passed identically with or
  // without a composition check until these existed.
  test('a domain-skewed sig head does not skip the seed lane on browse', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';

    // Volume clears enoughThreshold, but most of the head is apparel — which
    // COLD_START_DEFERRED_DOMAINS sends to the tail bucket. Serving this page
    // would render mostly rows the curator is about to bury.
    const rows = Array.from({ length: 120 }, (_, index) =>
      index < 100
        ? makeSigRow(index + 1, {
            brand: 'Denim Co',
            title: `Slim Fit Jean ${index + 1}`,
            description: `Cotton denim jean ${index + 1}`,
            category_path: ['Apparel', 'Jeans'],
          })
        : makeSigRow(index + 1),
    );
    const { mock, calls } = buildDbMock(rows);
    const internals = loadInternals(mock);

    const result = await internals.loadCatalogCandidates({
      request: internals.normalizeDiscoveryRequest({ ...GENERIC_BROWSE_REQUEST, limit: 24 }),
      profile: { hasInterestSignals: false },
      limit: 120,
    });

    expect(result.primaryPathUsed).not.toBe('canonical_sig');
    expect(calls.filter((call) => isSeedQuery(call.sql)).length).toBeGreaterThan(0);
  });

  test('a non-beauty sig head does not skip the seed lane on home_hot_deals', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';

    // external_seeds IS the beauty supply for home cold start, so a head of 24
    // rows of any domain must not be allowed to skip it.
    const rows = Array.from({ length: 24 }, (_, index) =>
      index < 22
        ? makeSigRow(index + 1, {
            brand: 'Acme',
            title: `Cordless Drill ${index + 1}`,
            description: `Power tool ${index + 1}`,
            category_path: ['Tools', 'Power Tools'],
          })
        : makeSigRow(index + 1),
    );
    const { mock, calls } = buildDbMock(rows);
    const internals = loadInternals(mock);

    const result = await internals.loadCatalogCandidates({
      request: internals.normalizeDiscoveryRequest({
        ...GENERIC_BROWSE_REQUEST,
        surface: 'home_hot_deals',
        limit: 6,
      }),
      profile: { hasInterestSignals: false },
      limit: 48,
    });

    expect(result.primaryPathUsed).not.toBe('canonical_sig');
    const seedProvider = (result.providerBreakdown || []).find(
      (entry) => entry.provider === 'external_seeds',
    );
    expect(seedProvider?.skip_reason).not.toBe('canonical_sig_primary_used');
  });

  test('the volume bar is enoughThreshold, not the primary-path threshold', () => {
    const internals = loadInternals(jest.fn());
    const request = internals.normalizeDiscoveryRequest({ ...GENERIC_BROWSE_REQUEST, limit: 24 });

    // Pins the divergence a future "harmonize the thresholds" refactor would
    // silently collapse: 48 vs 24 at browse page 1 / limit 24.
    expect(internals.getRecallEnoughThreshold(request, 120)).toBe(48);
    expect(internals.getPrimaryPathEnoughThreshold(request)).toBe(24);
  });

  test('a thin sig index still consults the fallbacks', async () => {
    process.env.DATABASE_URL = 'postgres://canonical-sig-test';
    process.env.DISCOVERY_BROWSE_USES_CANONICAL_SIG = 'true';
    const { mock, calls } = buildDbMock([makeSigRow(1), makeSigRow(2)]);
    const internals = loadInternals(mock);

    const result = await internals.loadCatalogCandidates({
      request: internals.normalizeDiscoveryRequest(GENERIC_BROWSE_REQUEST),
      profile: { hasInterestSignals: false },
      limit: 120,
    });

    expect(result.primaryPathUsed).not.toBe('canonical_sig');
    expect(calls.filter((call) => isSeedQuery(call.sql)).length).toBeGreaterThan(0);

    const sigProvider = (result.providerBreakdown || []).find(
      (entry) => entry.provider === 'canonical_sig',
    );
    expect(sigProvider).toMatchObject({ attempted: true, returned: 2 });
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

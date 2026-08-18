const nock = require('nock');

jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

// ADR-009 — the seed store is addressable WITHOUT a seller.
//
// fetchExternalSeedProductDetailFromDb keys on the product id alone; it never
// names a merchant. Until this change the only way to reach it was to derive a
// merchant from the product id's PREFIX and let the retired shared bucket act
// as a routing token — sourcing information wearing the seller field. These
// tests pin the replacement mechanism: the seller-less call is admitted, it
// unlocks the seed store and nothing else, and every seller-addressed call
// behaves exactly as it did before.

const ORIGINAL_ENV = process.env;

const SEED_ID = 'ext_seller_less_detail_1';

function loadServerWithDb(envOverrides = {}) {
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
  return { app, db, debug: app._debug };
}

function seedDetailRow(overrides = {}) {
  return {
    id: 'eps_seller_less_1',
    external_product_id: SEED_ID,
    status: 'active',
    canonical_url: 'https://example.test/products/seller-less-probe',
    destination_url: 'https://example.test/products/seller-less-probe',
    domain: 'example.test',
    title: 'Seller-less Route Probe Serum',
    image_url: 'https://cdn.example.test/probe.png',
    price_amount: '42.00',
    price_currency: 'USD',
    availability: 'In Stock',
    seed_data: {
      brand: 'Probe Labs',
      description: 'A serum used only to pin the seller-less seed route.',
      snapshot: {
        canonical_url: 'https://example.test/products/seller-less-probe',
        image_url: 'https://cdn.example.test/probe.png',
      },
    },
    ...overrides,
  };
}

// The seed detail lookup tries `external_product_id = $1`, then `id::text = $1`,
// then the seed_data JSON arms. Answer the first arm for the probe id only, so
// a lookup for any other id genuinely misses.
function mockSeedDetailQueries(db, { answerFor = SEED_ID, row = seedDetailRow() } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    const text = String(sql || '');
    const requested = Array.isArray(params) ? String(params[0] || '') : '';
    if (text.includes('FROM external_product_seeds') && text.includes('external_product_id = $1')) {
      return { rows: requested === answerFor ? [row] : [] };
    }
    return { rows: [] };
  });
}

function withoutGeneratedAt(value) {
  if (Array.isArray(value)) return value.map(withoutGeneratedAt);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === 'generated_at' ? '<masked>' : withoutGeneratedAt(entry);
    }
    return out;
  }
  return value;
}

describe('ADR-009 seller-less seed detail route', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('a seed-shaped id with NO merchant resolves from the seed store', async () => {
    const { db, debug } = loadServerWithDb();
    mockSeedDetailQueries(db);

    const product = await debug.fetchProductDetailForOffers({ productId: SEED_ID });

    expect(product).toBeTruthy();
    expect(product.product_id).toBe(SEED_ID);
    expect(product.title).toBe('Seller-less Route Probe Serum');
    // The payload keeps the seller its own builder stamped. It is NOT
    // overwritten with the empty string the seller-less call carried.
    expect(product.merchant_id).toBe('external_seed');
    expect(String(db.query.mock.calls[0][0] || '')).toContain('FROM external_product_seeds');
  });

  // CONTROL for the assertion above: merchant_id is not pinned to one constant
  // by the route — a seller-addressed call really does change it. Without this
  // the test above would pass against a build that hardcoded the value.
  test('an observed seller re-stamps the same seed payload with ITS id', async () => {
    const { db, debug } = loadServerWithDb();
    mockSeedDetailQueries(db);

    const product = await debug.fetchProductDetailForOffers({
      merchantId: 'merch_obs_022b65d47a58b87a',
      productId: SEED_ID,
    });

    expect(product).toBeTruthy();
    expect(product.merchant_id).toBe('merch_obs_022b65d47a58b87a');
    expect(product.title).toBe('Seller-less Route Probe Serum');
  });

  test('the legacy shared-bucket call is byte-identical to the seller-less one', async () => {
    const legacy = loadServerWithDb();
    mockSeedDetailQueries(legacy.db);
    const legacyProduct = await legacy.debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: SEED_ID,
    });

    const sellerLess = loadServerWithDb();
    mockSeedDetailQueries(sellerLess.db);
    const sellerLessProduct = await sellerLess.debug.fetchProductDetailForOffers({
      productId: SEED_ID,
    });

    expect(legacyProduct).toBeTruthy();
    // `generated_at` is a wall-clock stamp minted per call, so it is the one
    // field that cannot be expected to match between two runs. Pin that the
    // normalizer below is masking a field that really is present — otherwise it
    // would be free to mask nothing and this comparison would prove nothing.
    expect(typeof legacyProduct.ingredient_intel.authoritative.generated_at).toBe('string');
    expect(typeof sellerLessProduct.ingredient_intel.authoritative.generated_at).toBe('string');
    // Everything else must match exactly.
    expect(withoutGeneratedAt(sellerLessProduct)).toEqual(withoutGeneratedAt(legacyProduct));
  });

  test('a NON-seed id with no merchant is still rejected before any query', async () => {
    const { db, debug } = loadServerWithDb();
    mockSeedDetailQueries(db);

    const product = await debug.fetchProductDetailForOffers({ productId: '9886500749640' });

    expect(product).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a seed-shaped id that no seed row answers returns null, not a fabricated product', async () => {
    const { db, debug } = loadServerWithDb();
    mockSeedDetailQueries(db, { answerFor: 'ext_some_other_id' });

    const product = await debug.fetchProductDetailForOffers({ productId: SEED_ID });

    expect(product).toBeNull();
    // Every query it made was against the seed store: the seller-less call must
    // not fall through to the seller-scoped products_cache lookup.
    expect(db.query.mock.calls.length).toBeGreaterThan(0);
    for (const call of db.query.mock.calls) {
      expect(String(call[0] || '')).toContain('FROM external_product_seeds');
    }
  });

  test('with no database the seller-less call stops instead of calling the seller-scoped upstream', async () => {
    const { debug } = loadServerWithDb({
      DATABASE_URL: '',
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });
    const upstream = nock('https://backend.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, { status: 'success', product: { product_id: SEED_ID, title: 'from upstream' } });

    const product = await debug.fetchProductDetailForOffers({ productId: SEED_ID });

    expect(product).toBeNull();
    expect(upstream.isDone()).toBe(false);
  });

  // CONTROL for the test above: the upstream fetch is reachable in that exact
  // environment — it is the missing SELLER that stops it, not a dead nock or a
  // disabled fallback.
  test('with no database a seller-addressed call for the same id DOES reach upstream', async () => {
    const { debug } = loadServerWithDb({
      DATABASE_URL: '',
      PIVOTA_API_BASE: 'https://backend.test',
      PIVOTA_API_KEY: 'test-token',
    });
    const upstream = nock('https://backend.test')
      .post('/agent/shop/v1/invoke')
      .reply(200, {
        status: 'success',
        success: true,
        product: { product_id: SEED_ID, title: 'from upstream' },
      });

    const product = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: SEED_ID,
    });

    expect(upstream.isDone()).toBe(true);
    expect(product).toMatchObject({ title: 'from upstream' });
  });

  // The primary seed lookup and the legacy `attached_product_key IS NULL` scan
  // are two separate re-stamp sites in the same branch. Only the first is
  // reachable with the legacy fallback flag off (its default), so the second
  // needs its own coverage or its re-stamp is untested.
  describe('legacy attached-key-less fallback', () => {
    function mockLegacyFallbackQueries(db) {
      db.query.mockImplementation(async (sql) => {
        const text = String(sql || '');
        // Primary lookup: miss, so the fallback below is reached.
        if (text.includes('FROM external_product_seeds') && !text.includes('attached_product_key IS NULL')) {
          return { rows: [] };
        }
        if (text.includes('attached_product_key IS NULL')) {
          return { rows: [seedDetailRow()] };
        }
        return { rows: [] };
      });
    }

    test('a seller-less call keeps the fallback payload’s own seller', async () => {
      const { db, debug } = loadServerWithDb({
        PDP_EXTERNAL_SEED_LEGACY_DETAIL_FALLBACK_ENABLED: 'true',
      });
      mockLegacyFallbackQueries(db);

      const product = await debug.fetchProductDetailForOffers({ productId: SEED_ID });

      expect(product).toBeTruthy();
      expect(product.product_id).toBe(SEED_ID);
      expect(product.merchant_id).toBe('external_seed');
      expect(
        db.query.mock.calls.some((call) => String(call[0] || '').includes('attached_product_key IS NULL')),
      ).toBe(true);
    });

    // CONTROL: the same fallback DOES re-stamp for a real seller, so the
    // assertion above is constraining a branch and not a constant.
    test('an observed seller re-stamps the fallback payload', async () => {
      const { db, debug } = loadServerWithDb({
        PDP_EXTERNAL_SEED_LEGACY_DETAIL_FALLBACK_ENABLED: 'true',
      });
      mockLegacyFallbackQueries(db);

      const product = await debug.fetchProductDetailForOffers({
        merchantId: 'merch_obs_022b65d47a58b87a',
        productId: SEED_ID,
      });

      expect(product).toBeTruthy();
      expect(product.merchant_id).toBe('merch_obs_022b65d47a58b87a');
    });
  });

  test('the seller-less lane is never memory-cached', async () => {
    const { db, debug } = loadServerWithDb();
    mockSeedDetailQueries(db);

    await debug.fetchProductDetailForOffers({ productId: SEED_ID });
    const firstCallCount = db.query.mock.calls.length;
    await debug.fetchProductDetailForOffers({ productId: SEED_ID });

    // A cached second read would issue no query at all.
    expect(db.query.mock.calls.length).toBe(firstCallCount * 2);
  });

  // CONTROL for the test above: the in-memory cache is ON in this environment
  // and does serve a second read — for a seller whose TTL is not the seed
  // lane's deliberate zero.
  test('an observed-seller read of the same id IS memory-cached', async () => {
    const { db, debug } = loadServerWithDb();
    mockSeedDetailQueries(db);

    await debug.fetchProductDetailForOffers({
      merchantId: 'merch_obs_022b65d47a58b87a',
      productId: SEED_ID,
    });
    const firstCallCount = db.query.mock.calls.length;
    await debug.fetchProductDetailForOffers({
      merchantId: 'merch_obs_022b65d47a58b87a',
      productId: SEED_ID,
    });

    expect(db.query.mock.calls.length).toBe(firstCallCount);
  });
});

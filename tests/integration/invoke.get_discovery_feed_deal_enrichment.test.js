// Regression test for the brand-page deal enrichment bug:
// `get_discovery_feed` previously returned `discoveryResponse` raw, skipping
// `applyDealsToResponse`. The brand landing page in pivota-agent-ui calls
// `getBrandDiscoveryFeed` → operation:'get_discovery_feed', so its products
// never carried `all_deals` / `best_deal`. This test pins the fix.

process.env.PIVOTA_API_BASE = 'http://catalog.test';
process.env.PIVOTA_BACKEND_BASE_URL = 'http://catalog.test';
process.env.PIVOTA_API_KEY = 'test-token';
process.env.API_MODE = 'MOCK';
// Force the in-memory local promotion store so we don't talk to a remote backend.
process.env.PROMOTIONS_MODE = 'local';

const nock = require('nock');
const request = require('supertest');

describe('/agent/shop/v1/invoke get_discovery_feed enriches products with deals', () => {
  let app;

  beforeAll(() => {
    jest.resetModules();
    // Stub the promo store with one global creator-channel promo so the
    // enrichment path has something deterministic to surface.
    jest.doMock('../../src/promotionStore', () => {
      const FIXTURE = [
        {
          id: 'promo_test_brand_page_001',
          name: 'Brand Page Test Promo',
          type: 'FLASH_SALE',
          merchantId: 'merch_brandpage_test',
          channels: ['creator_agents'],
          scope: { global: true },
          config: { kind: 'FLASH_SALE', flashPrice: 8, originalPrice: 10 },
          exposeToCreators: true,
          allowedCreatorIds: [],
          humanReadableRule: 'Brand page test deal',
          startAt: '2024-01-01T00:00:00Z',
          endAt: '2099-12-31T23:59:59Z',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          deletedAt: null,
        },
      ];
      return {
        getAllPromotions: async () => [...FIXTURE],
        getPromotionsForMerchant: async () => [...FIXTURE],
        getPromotionById: async (id) => FIXTURE.find((p) => p.id === id) || null,
        upsertPromotion: async () => {},
        softDeletePromotion: async () => true,
        savePromotions: () => {},
        loadPromotions: () => [...FIXTURE],
        normalizePromotionRecord: (p) => p,
        normalizeDbPromotionRow: (r) => r,
        fetchMerchantPromotionsFromDb: async () => [...FIXTURE],
        STORE_PATH: '/tmp/test_promotions.json',
        DEFAULT_MERCHANT_ID: 'merch_brandpage_test',
      };
    });
    app = require('../../src/server');
  });

  afterAll(() => {
    jest.dontMock('../../src/promotionStore');
    jest.resetModules();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test('products returned by get_discovery_feed carry best_deal and all_deals fields', async () => {
    nock('http://catalog.test')
      .matchHeader('x-api-key', 'test-token')
      .get('/agent/v1/products/search')
      .query(true)
      .times(2)
      .reply(200, {
        products: [
          {
            merchant_id: 'merch_brandpage_test',
            product_id: 'brandpage_product_1',
            title: 'Test Brand Item A',
            brand: 'TestBrand',
            category: 'Beauty',
            product_type: 'Lipstick',
            inventory_quantity: 5,
            status: 'active',
            price: 10,
          },
        ],
      });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_discovery_feed',
        payload: {
          surface: 'browse_products',
          page: 1,
          limit: 4,
          scope: { brand_names: ['TestBrand'] },
          context: { auth_state: 'authenticated', locale: 'en-US' },
        },
      })
      .expect(200);

    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products.length).toBeGreaterThan(0);
    const product = res.body.products[0];
    // Pre-fix: these keys were absent on this route entirely.
    expect(product).toHaveProperty('all_deals');
    expect(product).toHaveProperty('best_deal');
    expect(Array.isArray(product.all_deals)).toBe(true);
    expect(product.all_deals.length).toBeGreaterThan(0);
    const matched = product.all_deals.find((d) => d.id === 'promo_test_brand_page_001');
    expect(matched).toBeTruthy();
    expect(matched.label).toBe('Brand page test deal');
    expect(product.best_deal && product.best_deal.id).toBe('promo_test_brand_page_001');
  });
});

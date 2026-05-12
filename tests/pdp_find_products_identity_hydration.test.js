jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

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
  return { db, debug: app._debug };
}

describe('find_products catalog identity hydration', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('adds signature and product group fields to merchant product cards', async () => {
    const { db, debug } = loadServerWithDb();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          merchant_id: 'merch_1',
          source_product_id: '10064558129449',
          product_key: 'prod::merch_1::shopify::10064558129449',
          pivota_signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        },
      ],
    });

    const hydrated = await debug.hydrateFindProductsCatalogIdentityFields({
      products: [
        {
          product_id: '10064558129449',
          merchant_id: 'merch_1',
          title: 'Winona Soothing Repair Serum',
        },
      ],
      metadata: { query_source: 'agent_v2' },
    });

    expect(hydrated.products[0]).toEqual(
      expect.objectContaining({
        product_id: '10064558129449',
        merchant_id: 'merch_1',
        pivota_signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        signature_id: 'sig_174dca24d4ffc297db0c3865d54b712b',
        product_key: 'prod::merch_1::shopify::10064558129449',
      }),
    );
    expect(hydrated.metadata.catalog_identity_hydration).toEqual({
      attempted: true,
      hydrated_count: 1,
    });
  });
});

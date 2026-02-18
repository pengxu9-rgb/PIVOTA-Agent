describe('cross-merchant cache lexical search', () => {
  let prevDatabaseUrl;
  let prevVectorEnabled;

  beforeEach(() => {
    prevDatabaseUrl = process.env.DATABASE_URL;
    prevVectorEnabled = process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED;
    process.env.DATABASE_URL = 'postgres://test';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('../src/db');
    jest.resetModules();
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
    if (prevVectorEnabled === undefined) delete process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED;
    else process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = prevVectorEnabled;
  });

  test('keeps published products sellable for brand query', async () => {
    const rows = [
      {
        merchant_id: 'merch_1',
        merchant_name: 'Merchant One',
        product_data: {
          id: 'prod_ipsa_published',
          product_id: 'prod_ipsa_published',
          merchant_id: 'merch_1',
          title: 'IPSA Time Reset Aqua',
          description: 'Hydrating toner',
          status: 'published',
          inventory_quantity: 12,
        },
      },
      {
        merchant_id: 'merch_1',
        merchant_name: 'Merchant One',
        product_data: {
          id: 'prod_ipsa_draft',
          product_id: 'prod_ipsa_draft',
          merchant_id: 'merch_1',
          title: 'IPSA Draft Listing',
          description: 'Should be filtered',
          status: 'draft',
          inventory_quantity: 12,
        },
      },
    ];

    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: rows.length }] };
        }
        if (text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo')) {
          return { rows };
        }
        return { rows: [] };
      },
    }));

    const app = require('../src/server');
    const { searchCrossMerchantFromCache } = app._debug;

    const result = await searchCrossMerchantFromCache('ipsa', 1, 10, { inStockOnly: true });
    const ids = (result.products || []).map((p) => String(p.product_id || p.id || ''));

    expect(ids).toContain('prod_ipsa_published');
    expect(ids).not.toContain('prod_ipsa_draft');
    expect(result.retrieval_sources?.[0]).toEqual(
      expect.objectContaining({
        source: 'lexical_cache',
        used: true,
      }),
    );
  });
});

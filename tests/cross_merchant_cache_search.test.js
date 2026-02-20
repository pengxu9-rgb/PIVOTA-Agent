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

  test('falls back to relaxed cache query when onboarding join returns empty', async () => {
    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        const isStrictJoinQuery = text.includes('JOIN merchant_onboarding mo');
        const isCountQuery = text.includes('COUNT(*)::int AS total');

        if (isStrictJoinQuery && isCountQuery) return { rows: [{ total: 0 }] };
        if (isStrictJoinQuery) return { rows: [] };

        if (!isStrictJoinQuery && isCountQuery && text.includes('FROM products_cache')) {
          return { rows: [{ total: 1 }] };
        }
        if (!isStrictJoinQuery && text.includes('FROM products_cache')) {
          return {
            rows: [
              {
                merchant_id: 'merch_relaxed_1',
                merchant_name: null,
                product_data: {
                  id: 'prod_ipsa_relaxed',
                  product_id: 'prod_ipsa_relaxed',
                  merchant_id: 'merch_relaxed_1',
                  title: 'IPSA Relaxed Cache Item',
                  description: 'Fallback from products_cache only',
                  status: 'active',
                  inventory_quantity: 5,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../src/server');
    const { searchCrossMerchantFromCache } = app._debug;

    const result = await searchCrossMerchantFromCache('ipsa', 1, 10, { inStockOnly: true });
    const ids = (result.products || []).map((p) => String(p.product_id || p.id || ''));

    expect(ids).toContain('prod_ipsa_relaxed');
    expect(result.retrieval_sources || []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'lexical_cache', count: 0 }),
        expect.objectContaining({ source: 'lexical_cache_relaxed_no_onboarding', used: true, count: 1 }),
      ]),
    );
  });

  test('pet harness query falls back to pet browse when lexical misses', async () => {
    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        const isStrictJoin = text.includes('FROM products_cache pc') && text.includes('JOIN merchant_onboarding mo');
        const isCountQuery = text.includes('COUNT(*)::int AS total');

        if (isStrictJoin && isCountQuery) return { rows: [{ total: 0 }] };

        // strict lexical rows: miss
        if (isStrictJoin && !isCountQuery && !text.includes('~*')) {
          return { rows: [] };
        }

        // relaxed lexical rows: miss
        if (!isStrictJoin && isCountQuery && text.includes('FROM products_cache')) {
          return { rows: [{ total: 0 }] };
        }
        if (!isStrictJoin && text.includes('FROM products_cache')) {
          return { rows: [] };
        }

        // pet regex fallback rows: hit
        if (isStrictJoin && text.includes('~*')) {
          return {
            rows: [
              {
                merchant_id: 'merch_pet_1',
                merchant_name: 'Pet Merchant',
                product_data: {
                  id: 'prod_dog_harness_1',
                  product_id: 'prod_dog_harness_1',
                  merchant_id: 'merch_pet_1',
                  title: 'No Pull Dog Harness and Leash Set',
                  description: 'Adjustable harness for walking dogs',
                  status: 'active',
                  inventory_quantity: 7,
                },
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    const app = require('../src/server');
    const { searchCrossMerchantFromCache } = app._debug;

    const result = await searchCrossMerchantFromCache('有没有狗链推荐？', 1, 10, { inStockOnly: true });
    const ids = (result.products || []).map((p) => String(p.product_id || p.id || ''));
    expect(ids).toContain('prod_dog_harness_1');
    expect(result.retrieval_sources || []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'lexical_cache', count: 0 }),
        expect.objectContaining({ source: 'lexical_cache_relaxed_no_onboarding', count: 0 }),
        expect.objectContaining({ source: 'pet_harness_browse_fallback', used: true, count: 1 }),
      ]),
    );
  });
});

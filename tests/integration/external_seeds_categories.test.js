describe('external seed products in creator categories', () => {
  function loadCategoriesServiceWithDb() {
    jest.resetModules();

    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_KEY = '';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.TAXONOMY_ENABLED = 'true';
    process.env.CREATOR_CATEGORIES_INCLUDE_EXTERNAL_SEEDS = 'true';
    process.env.CREATOR_CATEGORIES_EXTERNAL_SEEDS_LIMIT = '25';
    process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET = 'US';

    const taxonomy = {
      version: 'test@v1',
      market: 'GLOBAL',
      locale: 'en-US',
      viewId: 'GLOBAL_BEAUTY',
      roots: ['beauty-tools', 'lingerie-set'],
      byId: new Map([
        [
          'beauty-tools',
          {
            id: 'beauty-tools',
            slug: 'beauty-tools',
            name: 'Beauty Tools',
            parentId: null,
            level: 0,
            imageUrl: null,
            pinned: false,
            hidden: false,
            priorityBoost: 0,
            priorityBase: 0,
            path: ['Beauty Tools'],
          },
        ],
        [
          'lingerie-set',
          {
            id: 'lingerie-set',
            slug: 'lingerie-set',
            name: 'Lingerie Set',
            parentId: null,
            level: 0,
            imageUrl: null,
            pinned: false,
            hidden: false,
            priorityBoost: 0,
            priorityBase: 0,
            path: ['Lingerie Set'],
          },
        ],
      ]),
      childrenById: new Map([
        ['beauty-tools', []],
        ['lingerie-set', []],
      ]),
    };

    jest.doMock('../../src/creatorConfig', () => ({
      getCreatorConfig: (creatorId) => (creatorId ? { creatorId, merchantIds: ['m1'] } : undefined),
    }));

    jest.doMock('../../src/services/taxonomyStore', () => ({
      getTaxonomyView: async () => taxonomy,
    }));

    jest.doMock('../../src/promotionStore', () => ({
      getAllPromotions: async () => [],
    }));

    jest.doMock('../../src/db', () => ({
      query: async (sql) => {
        const text = String(sql || '');
        if (text.includes('FROM products_cache')) {
          return { rows: [] };
        }
        if (text.includes('FROM external_product_seeds')) {
          return {
            rows: [
              {
                id: 'eps_test_1',
                external_product_id: 'ext_test_123',
                market: 'US',
                tool: '*',
                destination_url: 'https://example.com/p/1',
                canonical_url: 'https://example.com/p/1',
                domain: 'example.com',
                title: 'Acme Brush Set',
                image_url: 'https://example.com/img.jpg',
                price_amount: 19.99,
                price_currency: 'USD',
                availability: 'in_stock',
                seed_data: {
                  title: 'Acme Brush Set',
                  description: 'Makeup brush for seamless base',
                  brand: 'Acme',
                  category: 'Beauty Tools',
                },
                status: 'active',
                attached_product_key: null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (text.includes('FROM merchant_category_mapping')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    }));

    // eslint-disable-next-line global-require
    return require('../../src/services/categories');
  }

  test('counts external seeds into canonical taxonomy categories', async () => {
    const { buildCreatorCategoryTree } = loadCategoriesServiceWithDb();

    const tree = await buildCreatorCategoryTree('test-creator', {
      includeCounts: true,
      includeEmpty: true,
      viewId: 'GLOBAL_BEAUTY',
      locale: 'en-US',
    });

    const bySlug = new Map(tree.roots.map((n) => [n.category.slug, n]));
    expect(bySlug.get('beauty-tools')?.category.productCount).toBe(1);
  });
});


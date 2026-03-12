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
                  image_urls: [
                    'https://example.com/img.jpg',
                    'https://example.com/img-2.jpg',
                  ],
                  snapshot: {
                    canonical_url: 'https://example.com/p/1',
                    image_urls: [
                      'https://example.com/img.jpg',
                      'https://example.com/img-2.jpg',
                    ],
                    variants: [
                      {
                        sku: 'ACME-001',
                        variant_id: 'ACME-001',
                        option_name: 'Shade',
                        option_value: 'Light',
                        price: '19.99',
                        currency: 'USD',
                        stock: 'In Stock',
                        image_url: 'https://example.com/img.jpg',
                        image_urls: [
                          'https://example.com/img.jpg',
                          'https://example.com/img-2.jpg',
                        ],
                      },
                      {
                        sku: 'ACME-002',
                        variant_id: 'ACME-002',
                        option_name: 'Shade',
                        option_value: 'Medium',
                        price: '21.99',
                        currency: 'USD',
                        stock: 'In Stock',
                        image_url: 'https://example.com/img-3.jpg',
                        image_urls: [
                          'https://example.com/img-3.jpg',
                          'https://example.com/img-4.jpg',
                        ],
                      },
                    ],
                  },
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

  test('builds external products with seed snapshot variants and image galleries', async () => {
    const { getCreatorCategoryProducts } = loadCategoriesServiceWithDb();

    const result = await getCreatorCategoryProducts('test-creator', 'beauty-tools', {
      viewId: 'GLOBAL_BEAUTY',
      locale: 'en-US',
      limit: 10,
    });

    expect(result.products).toHaveLength(1);
    expect(result.products[0].images).toEqual([
      'https://example.com/img.jpg',
      'https://example.com/img-2.jpg',
    ]);
    expect(result.products[0].variants).toHaveLength(2);
    expect(result.products[0].variants[0]).toEqual(
      expect.objectContaining({
        sku: 'ACME-001',
        image_url: 'https://example.com/img.jpg',
      }),
    );
  });
});

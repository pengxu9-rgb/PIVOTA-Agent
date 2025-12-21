describe('merchant category mapping guardrail', () => {
  function loadCategoriesService() {
    jest.resetModules();

    process.env.API_MODE = 'MOCK';
    process.env.PIVOTA_API_KEY = '';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.TAXONOMY_ENABLED = 'true';

    const product = {
      id: 'p1',
      merchant_id: 'm1',
      title: 'Dual-Ended Foundation Brush',
      description: 'Makeup brush for seamless base',
      product_type: 'Makeup Brush',
      status: 'active',
      orderable: true,
    };

    const taxonomy = {
      version: 'test@v1',
      market: 'GLOBAL',
      locale: 'en-US',
      viewId: 'GLOBAL_BEAUTY',
      roots: ['lingerie-set', 'beauty-tools'],
      byId: new Map([
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
      ]),
      childrenById: new Map([
        ['lingerie-set', []],
        ['beauty-tools', []],
      ]),
    };

    jest.doMock('../../src/creatorConfig', () => ({
      getCreatorConfig: (creatorId) => (creatorId ? { creatorId, merchantIds: ['m1'] } : undefined),
    }));

    jest.doMock('../../src/mockProducts', () => ({
      mockProducts: {
        m1: [product],
      },
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
        if (text.includes('FROM merchant_category_mapping')) {
          // Simulate a wrong merchant-level mapping that would otherwise
          // put brushes into lingerie-set.
          return {
            rows: [
              {
                merchant_id: 'm1',
                merchant_category_key: 'Makeup Brush',
                canonical_category_id: 'lingerie-set',
                confidence: 0.99,
              },
            ],
          };
        }
        return { rows: [] };
      },
    }));

    // eslint-disable-next-line global-require
    return require('../../src/services/categories');
  }

  test('overrides lingerie mapping when heuristic indicates beauty-tools', async () => {
    const { buildCreatorCategoryTree } = loadCategoriesService();

    const tree = await buildCreatorCategoryTree('test-creator', {
      includeCounts: true,
      includeEmpty: true,
      viewId: 'GLOBAL_BEAUTY',
      locale: 'en-US',
    });

    const bySlug = new Map(tree.roots.map((n) => [n.category.slug, n]));

    expect(bySlug.get('beauty-tools')?.category.productCount).toBe(1);
    expect(bySlug.get('lingerie-set')?.category.productCount).toBe(0);
  });
});


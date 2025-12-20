describe('creator cache search ranking', () => {
  test('penalizes toy/pet items for human clothing queries', async () => {
    const prevDatabaseUrl = process.env.DATABASE_URL;
    const prevVectorEnabled = process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED;
    process.env.DATABASE_URL = '';
    process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = 'false';

    const products = [
      {
        id: 'toy-1',
        merchant_id: 'merch_efbc46b4619cfbdf',
        status: 'active',
        inventory_quantity: 10,
        title: 'Kawaii Dress Outfit for Labubu Doll (Doll Outfit)',
        description: 'Doll clothes outfit set with dress',
      },
      {
        id: 'pet-1',
        merchant_id: 'merch_efbc46b4619cfbdf',
        status: 'active',
        inventory_quantity: 10,
        title: 'Warm Coat for Dogs & Cats',
        description: 'Pet jacket for cold weather',
      },
      {
        id: 'human-1',
        merchant_id: 'merch_efbc46b4619cfbdf',
        status: 'active',
        inventory_quantity: 10,
        title: "Women's casual dress",
        description: 'Women outfit for date night',
      },
      {
        id: 'human-2',
        merchant_id: 'merch_efbc46b4619cfbdf',
        status: 'active',
        inventory_quantity: 10,
        title: 'Sweet Lace lingerie set',
        description: 'Women underwear set',
      },
    ];

    jest.resetModules();
    jest.doMock('../src/db', () => ({
      query: async (sql) => {
        const s = String(sql || '');
        if (s.includes('COUNT(*)')) return { rows: [{ total: products.length }] };
        return { rows: products.map((p) => ({ product_data: p })) };
      },
    }));

    try {
      const app = require('../src/server');
      const { searchCreatorSellableFromCache } = app._debug;

      const res = await searchCreatorSellableFromCache(
        'creator_demo_001',
        'women dress outfit',
        1,
        5,
        { intent: { target_object: { type: 'human' }, language: 'en' } }
      );

      const ids = (res.products || []).map((p) => String(p.id || p.product_id || ''));
      expect(ids.length).toBeGreaterThan(0);
      expect(ids[0]).toMatch(/^human-/);
      expect(ids).toEqual(expect.arrayContaining(['human-1', 'human-2']));
    } finally {
      jest.dontMock('../src/db');
      jest.resetModules();
      process.env.DATABASE_URL = prevDatabaseUrl;
      process.env.FIND_PRODUCTS_MULTI_VECTOR_ENABLED = prevVectorEnabled;
    }
  });
});

describe('ingredientProductRecall', () => {
  let prevDatabaseUrl;

  beforeEach(() => {
    jest.resetModules();
    prevDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://ingredient-product-recall-test';
  });

  afterEach(() => {
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
  });

  test('drops bundle-like candidates when a non-bundle explicit ingredient match exists', async () => {
    jest.doMock('../../src/services/pciKbClient', () => ({
      kbQuery: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('to_regclass')) {
          return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
        }
        return { rows: [] };
      }),
    }));

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        if (!text.includes("coalesce(attached_product_key, '') <> ''")) return { rows: [] };
        const now = new Date().toISOString();
        return {
          rows: [
            {
              id: 'seed_rose',
              external_product_id: 'ext_rose',
              destination_url: 'https://pixi.example.com/products/rose-ceramide-cream',
              canonical_url: 'https://pixi.example.com/products/rose-ceramide-cream',
              domain: 'pixi.example.com',
              title: 'Rose Ceramide Cream',
              image_url: 'https://pixi.example.com/rose.jpg',
              price_amount: 24,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:rose',
              seed_data: {
                brand: 'Pixi Beauty',
                category: 'Moisturizer',
                snapshot: {
                  title: 'Rose Ceramide Cream',
                  description: 'ceramide moisturizer for barrier repair',
                  brand: 'Pixi Beauty',
                  category: 'Moisturizer',
                  canonical_url: 'https://pixi.example.com/products/rose-ceramide-cream',
                  destination_url: 'https://pixi.example.com/products/rose-ceramide-cream',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_bundle',
              external_product_id: 'ext_bundle',
              destination_url: 'https://pixi.example.com/products/rose-glow-routine',
              canonical_url: 'https://pixi.example.com/products/rose-glow-routine',
              domain: 'pixi.example.com',
              title: 'Rose Glow Routine',
              image_url: 'https://pixi.example.com/routine.jpg',
              price_amount: 42,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:routine',
              seed_data: {
                brand: 'Pixi Beauty',
                category: 'Moisturizer',
                snapshot: {
                  title: 'Rose Glow Routine',
                  description: 'ceramide skincare routine bundle',
                  brand: 'Pixi Beauty',
                  category: 'Moisturizer',
                  canonical_url: 'https://pixi.example.com/products/rose-glow-routine',
                  destination_url: 'https://pixi.example.com/products/rose-glow-routine',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_quartet',
              external_product_id: 'ext_quartet',
              destination_url: 'https://pixi.example.com/products/antioxidant-radiance-quartet',
              canonical_url: 'https://pixi.example.com/products/antioxidant-radiance-quartet',
              domain: 'pixi.example.com',
              title: 'Antioxidant Radiance Quartet',
              image_url: 'https://pixi.example.com/quartet.jpg',
              price_amount: 52,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:quartet',
              seed_data: {
                brand: 'Pixi Beauty',
                category: 'Moisturizer',
                snapshot: {
                  title: 'Antioxidant Radiance Quartet',
                  description: 'ceramides gift set',
                  brand: 'Pixi Beauty',
                  category: 'Moisturizer',
                  canonical_url: 'https://pixi.example.com/products/antioxidant-radiance-quartet',
                  destination_url: 'https://pixi.example.com/products/antioxidant-radiance-quartet',
                },
              },
              updated_at: now,
              created_at: now,
            },
          ],
        };
      }),
    }));

    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    const out = await recallIngredientProducts({
      query: 'ceramide moisturizer',
      ingredientId: 'ceramide_np',
      targetStepFamily: 'moisturizer',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Rose Ceramide Cream']);
    expect(out.diagnostics.family_fallback_used).toBe(false);
  });

  test('keeps routine-safe default behavior when exact ingredient recall is empty', async () => {
    jest.doMock('../../src/services/pciKbClient', () => ({
      kbQuery: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('to_regclass')) {
          return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
        }
        return { rows: [] };
      }),
    }));

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql, params = []) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        const patterns = Array.isArray(params?.[2]) ? params[2] : [];
        const familyQuery = patterns.some((pattern) => /soothing|repair|hydrating/i.test(String(pattern || '')));
        if (!familyQuery) return { rows: [] };
        const now = new Date().toISOString();
        return {
          rows: [
            {
              id: 'seed_winona',
              external_product_id: 'ext_winona',
              destination_url: 'https://winona.example.com/products/soothing-repair-serum',
              canonical_url: 'https://winona.example.com/products/soothing-repair-serum',
              domain: 'winona.example.com',
              title: 'Winona Soothing Repair Serum',
              image_url: 'https://winona.example.com/serum.jpg',
              price_amount: 29,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:winona',
              seed_data: {
                brand: 'Winona',
                category: 'Serum',
                snapshot: {
                  title: 'Winona Soothing Repair Serum',
                  description: 'soothing barrier repair serum for sensitive skin',
                  brand: 'Winona',
                  category: 'Serum',
                  canonical_url: 'https://winona.example.com/products/soothing-repair-serum',
                  destination_url: 'https://winona.example.com/products/soothing-repair-serum',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_concealer',
              external_product_id: 'ext_concealer',
              destination_url: 'https://rare.example.com/products/hydrating-concealer',
              canonical_url: 'https://rare.example.com/products/hydrating-concealer',
              domain: 'rare.example.com',
              title: 'Hydrating Longwear Concealer',
              image_url: 'https://rare.example.com/concealer.jpg',
              price_amount: 25,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:concealer',
              seed_data: {
                brand: 'Rare Beauty',
                snapshot: {
                  title: 'Hydrating Longwear Concealer',
                  description: 'hydrating coverage for dry skin',
                  canonical_url: 'https://rare.example.com/products/hydrating-concealer',
                  destination_url: 'https://rare.example.com/products/hydrating-concealer',
                },
              },
              updated_at: now,
              created_at: now,
            },
          ],
        };
      }),
    }));

    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    const out = await recallIngredientProducts({
      query: 'panthenol repair serum',
      ingredientId: 'panthenol',
      targetStepFamily: 'serum',
      limit: 3,
    });

    expect(out.products).toEqual([]);
    expect(out.diagnostics.family_fallback_attempted).toBe(false);
    expect(out.diagnostics.family_fallback_used).toBe(false);
  });

  test('allows ingredient-intent family fallback when explicitly requested', async () => {
    jest.doMock('../../src/services/pciKbClient', () => ({
      kbQuery: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('to_regclass')) {
          return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
        }
        return { rows: [] };
      }),
    }));

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql, params = []) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        const patterns = Array.isArray(params?.[2]) ? params[2] : [];
        const familyQuery = patterns.some((pattern) => /soothing|repair|hydrating/i.test(String(pattern || '')));
        if (!familyQuery) return { rows: [] };
        const now = new Date().toISOString();
        return {
          rows: [
            {
              id: 'seed_winona',
              external_product_id: 'ext_winona',
              destination_url: 'https://winona.example.com/products/soothing-repair-serum',
              canonical_url: 'https://winona.example.com/products/soothing-repair-serum',
              domain: 'winona.example.com',
              title: 'Winona Soothing Repair Serum',
              image_url: 'https://winona.example.com/serum.jpg',
              price_amount: 29,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:winona',
              seed_data: {
                brand: 'Winona',
                category: 'Serum',
                snapshot: {
                  title: 'Winona Soothing Repair Serum',
                  description: 'soothing barrier repair serum for sensitive skin',
                  brand: 'Winona',
                  category: 'Serum',
                  canonical_url: 'https://winona.example.com/products/soothing-repair-serum',
                  destination_url: 'https://winona.example.com/products/soothing-repair-serum',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_concealer',
              external_product_id: 'ext_concealer',
              destination_url: 'https://rare.example.com/products/hydrating-concealer',
              canonical_url: 'https://rare.example.com/products/hydrating-concealer',
              domain: 'rare.example.com',
              title: 'Hydrating Longwear Concealer',
              image_url: 'https://rare.example.com/concealer.jpg',
              price_amount: 25,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:concealer',
              seed_data: {
                brand: 'Rare Beauty',
                snapshot: {
                  title: 'Hydrating Longwear Concealer',
                  description: 'hydrating coverage for dry skin',
                  canonical_url: 'https://rare.example.com/products/hydrating-concealer',
                  destination_url: 'https://rare.example.com/products/hydrating-concealer',
                },
              },
              updated_at: now,
              created_at: now,
            },
          ],
        };
      }),
    }));

    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    const out = await recallIngredientProducts({
      query: 'panthenol repair serum',
      ingredientId: 'panthenol',
      targetStepFamily: 'serum',
      limit: 3,
      allowFamilyFallback: true,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Winona Soothing Repair Serum']);
    expect(out.diagnostics.family_fallback_attempted).toBe(true);
    expect(out.diagnostics.family_fallback_recovered).toBe(1);
    expect(out.diagnostics.family_fallback_used).toBe(true);
    expect(out.diagnostics.recall_source_breakdown).toEqual({
      family_attached_seed: 1,
    });
  });
});

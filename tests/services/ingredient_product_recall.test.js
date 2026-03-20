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

  test('uses KB ingredient evidence to keep direct recall products even when surface text is generic', async () => {
    jest.doMock('../../src/services/pciKbClient', () => ({
      kbQuery: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('to_regclass')) {
          return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
        }
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'extseed:seed_support_serum:theordinary',
                brand: 'The Ordinary',
                product_name: 'Soothing & Barrier Support Serum',
                source_ref: 'https://ordinary.example.com/products/support-serum',
                raw_ingredient_text_clean: 'panthenol, dexpanthenol, glycerin',
                inci_list: 'panthenol, dexpanthenol',
                created_at: new Date().toISOString(),
              },
            ],
          };
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
              id: 'seed_support_serum',
              external_product_id: 'ext_support_serum',
              destination_url: 'https://ordinary.example.com/products/support-serum',
              canonical_url: 'https://ordinary.example.com/products/support-serum',
              domain: 'ordinary.example.com',
              title: 'Soothing & Barrier Support Serum',
              image_url: 'https://ordinary.example.com/support-serum.jpg',
              price_amount: 22,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:support-serum',
              seed_data: {
                brand: 'The Ordinary',
                category: 'Serum',
                snapshot: {
                  title: 'Soothing & Barrier Support Serum',
                  description: 'multi-active barrier support serum',
                  brand: 'The Ordinary',
                  category: 'Serum',
                  canonical_url: 'https://ordinary.example.com/products/support-serum',
                  destination_url: 'https://ordinary.example.com/products/support-serum',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_vitc_serum',
              external_product_id: 'ext_vitc_serum',
              destination_url: 'https://ordinary.example.com/products/vitamin-c-serum',
              canonical_url: 'https://ordinary.example.com/products/vitamin-c-serum',
              domain: 'ordinary.example.com',
              title: 'Vitamin-C Serum',
              image_url: 'https://ordinary.example.com/vitc-serum.jpg',
              price_amount: 24,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:vitamin-c-serum',
              seed_data: {
                brand: 'The Ordinary',
                category: 'Serum',
                snapshot: {
                  title: 'Vitamin-C Serum',
                  description: 'vitamin c antioxidant serum',
                  brand: 'The Ordinary',
                  category: 'Serum',
                  canonical_url: 'https://ordinary.example.com/products/vitamin-c-serum',
                  destination_url: 'https://ordinary.example.com/products/vitamin-c-serum',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_peptide_moisturizer',
              external_product_id: 'ext_peptide_moisturizer',
              destination_url: 'https://ordinary.example.com/products/strength-trainer-moisturizer',
              canonical_url: 'https://ordinary.example.com/products/strength-trainer-moisturizer',
              domain: 'ordinary.example.com',
              title: 'Strength Trainer Peptide Boost Moisturizer',
              image_url: 'https://ordinary.example.com/strength-trainer.jpg',
              price_amount: 38,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:strength-trainer',
              seed_data: {
                brand: 'The Ordinary',
                category: 'Moisturizer',
                snapshot: {
                  title: 'Strength Trainer Peptide Boost Moisturizer',
                  description: 'peptide moisturizer for barrier support',
                  brand: 'The Ordinary',
                  category: 'Moisturizer',
                  canonical_url: 'https://ordinary.example.com/products/strength-trainer-moisturizer',
                  destination_url: 'https://ordinary.example.com/products/strength-trainer-moisturizer',
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

    expect(out.products.map((row) => row.title || row.name)).toEqual([
      'Soothing & Barrier Support Serum',
    ]);
    expect(out.diagnostics.family_fallback_attempted).toBe(false);
    expect(out.diagnostics.family_fallback_used).toBe(false);
    expect(out.diagnostics.recall_source_breakdown).toEqual({
      kb_attached_seed: 1,
    });
  });

  test('prefers surface-explicit B5 products over KB-only generic support serum', async () => {
    jest.doMock('../../src/services/pciKbClient', () => ({
      kbQuery: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('to_regclass')) {
          return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
        }
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'extseed:seed_support_serum:theordinary',
                brand: 'The Ordinary',
                product_name: 'Soothing & Barrier Support Serum',
                source_ref: 'https://ordinary.example.com/products/support-serum',
                raw_ingredient_text_clean: 'panthenol, dexpanthenol, glycerin',
                inci_list: 'panthenol, dexpanthenol',
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        const now = new Date().toISOString();
        if (text.includes("AND coalesce(attached_product_key, '') = ''")) {
          return {
            rows: [
              {
                id: 'seed_b5_1',
                external_product_id: 'ext_b5_1',
                destination_url: 'https://ordinary.example.com/products/ha-b5',
                canonical_url: 'https://ordinary.example.com/products/ha-b5',
                domain: 'ordinary.example.com',
                title: 'Hyaluronic Acid 2% + B5 (Original Formulation)',
                image_url: 'https://ordinary.example.com/ha-b5.jpg',
                price_amount: 15,
                price_currency: 'USD',
                availability: 'in stock',
                attached_product_key: '',
                seed_data: {
                  brand: 'The Ordinary',
                  snapshot: {
                    title: 'Hyaluronic Acid 2% + B5 (Original Formulation)',
                    description: 'hydrating serum with vitamin b5',
                    brand: 'The Ordinary',
                    canonical_url: 'https://ordinary.example.com/products/ha-b5',
                    destination_url: 'https://ordinary.example.com/products/ha-b5',
                  },
                },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_b5_2',
                external_product_id: 'ext_b5_2',
                destination_url: 'https://ordinary.example.com/products/amino-acids-b5',
                canonical_url: 'https://ordinary.example.com/products/amino-acids-b5',
                domain: 'ordinary.example.com',
                title: 'Amino Acids + B5',
                image_url: 'https://ordinary.example.com/amino-b5.jpg',
                price_amount: 14,
                price_currency: 'USD',
                availability: 'in stock',
                attached_product_key: '',
                seed_data: {
                  brand: 'The Ordinary',
                  snapshot: {
                    title: 'Amino Acids + B5',
                    description: 'lightweight serum with vitamin b5',
                    brand: 'The Ordinary',
                    canonical_url: 'https://ordinary.example.com/products/amino-acids-b5',
                    destination_url: 'https://ordinary.example.com/products/amino-acids-b5',
                  },
                },
                updated_at: now,
                created_at: now,
              },
            ],
          };
        }
        if (text.includes("AND coalesce(attached_product_key, '') <> ''")) {
          return {
            rows: [
              {
                id: 'seed_support_serum',
                external_product_id: 'ext_support_serum',
                destination_url: 'https://ordinary.example.com/products/support-serum',
                canonical_url: 'https://ordinary.example.com/products/support-serum',
                domain: 'ordinary.example.com',
                title: 'Soothing & Barrier Support Serum',
                image_url: 'https://ordinary.example.com/support-serum.jpg',
                price_amount: 22,
                price_currency: 'USD',
                availability: 'in stock',
                attached_product_key: 'shopify:support-serum',
                seed_data: {
                  brand: 'The Ordinary',
                  category: 'Serum',
                  snapshot: {
                    title: 'Soothing & Barrier Support Serum',
                    description: 'multi-active barrier support serum',
                    brand: 'The Ordinary',
                    category: 'Serum',
                    canonical_url: 'https://ordinary.example.com/products/support-serum',
                    destination_url: 'https://ordinary.example.com/products/support-serum',
                  },
                },
                updated_at: now,
                created_at: now,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    const out = await recallIngredientProducts({
      query: 'panthenol repair serum',
      ingredientId: 'panthenol',
      targetStepFamily: 'serum',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual([
      'Hyaluronic Acid 2% + B5 (Original Formulation)',
      'Amino Acids + B5',
    ]);
    expect(out.diagnostics.recall_source_breakdown).toEqual({
      unattached_seed: 2,
    });
  });

  test('keeps surface-explicit B5 products even when step metadata is missing', async () => {
    jest.doMock('../../src/services/pciKbClient', () => ({
      kbQuery: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (text.includes('to_regclass')) {
          return { rows: [{ table_name: 'pci_kb.sku_ingredients' }] };
        }
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'extseed:seed_support_serum:theordinary',
                brand: 'The Ordinary',
                product_name: 'Soothing & Barrier Support Serum',
                source_ref: 'https://ordinary.example.com/products/support-serum',
                raw_ingredient_text_clean: 'panthenol, dexpanthenol, glycerin',
                inci_list: 'panthenol, dexpanthenol',
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    jest.doMock('../../src/db', () => ({
      query: jest.fn(async (sql) => {
        const text = String(sql || '');
        if (!text.includes('FROM external_product_seeds')) return { rows: [] };
        const now = new Date().toISOString();
        if (text.includes("AND coalesce(attached_product_key, '') = ''")) {
          return {
            rows: [
              {
                id: 'seed_b5_missing_step_1',
                external_product_id: 'ext_b5_missing_step_1',
                destination_url: 'https://ordinary.example.com/products/ha-b5',
                canonical_url: 'https://ordinary.example.com/products/ha-b5',
                domain: 'ordinary.example.com',
                title: 'Hyaluronic Acid 2% + B5 (Original Formulation)',
                image_url: 'https://ordinary.example.com/ha-b5.jpg',
                price_amount: 15,
                price_currency: 'USD',
                availability: 'in stock',
                attached_product_key: '',
                seed_data: {
                  brand: 'The Ordinary',
                  snapshot: {
                    title: 'Hyaluronic Acid 2% + B5 (Original Formulation)',
                    description: 'hydrating serum with vitamin b5',
                    brand: 'The Ordinary',
                    canonical_url: 'https://ordinary.example.com/products/ha-b5',
                    destination_url: 'https://ordinary.example.com/products/ha-b5',
                  },
                },
                updated_at: now,
                created_at: now,
              },
              {
                id: 'seed_b5_missing_step_2',
                external_product_id: 'ext_b5_missing_step_2',
                destination_url: 'https://ordinary.example.com/products/amino-acids-b5',
                canonical_url: 'https://ordinary.example.com/products/amino-acids-b5',
                domain: 'ordinary.example.com',
                title: 'Amino Acids + B5',
                image_url: 'https://ordinary.example.com/amino-b5.jpg',
                price_amount: 14,
                price_currency: 'USD',
                availability: 'in stock',
                attached_product_key: '',
                seed_data: {
                  brand: 'The Ordinary',
                  snapshot: {
                    title: 'Amino Acids + B5',
                    description: 'lightweight serum with vitamin b5',
                    brand: 'The Ordinary',
                    canonical_url: 'https://ordinary.example.com/products/amino-acids-b5',
                    destination_url: 'https://ordinary.example.com/products/amino-acids-b5',
                  },
                },
                updated_at: now,
                created_at: now,
              },
            ],
          };
        }
        if (text.includes("AND coalesce(attached_product_key, '') <> ''")) {
          return {
            rows: [
              {
                id: 'seed_support_serum',
                external_product_id: 'ext_support_serum',
                destination_url: 'https://ordinary.example.com/products/support-serum',
                canonical_url: 'https://ordinary.example.com/products/support-serum',
                domain: 'ordinary.example.com',
                title: 'Soothing & Barrier Support Serum',
                image_url: 'https://ordinary.example.com/support-serum.jpg',
                price_amount: 22,
                price_currency: 'USD',
                availability: 'in stock',
                attached_product_key: 'shopify:support-serum',
                seed_data: {
                  brand: 'The Ordinary',
                  category: 'Serum',
                  snapshot: {
                    title: 'Soothing & Barrier Support Serum',
                    description: 'multi-active barrier support serum',
                    brand: 'The Ordinary',
                    category: 'Serum',
                    canonical_url: 'https://ordinary.example.com/products/support-serum',
                    destination_url: 'https://ordinary.example.com/products/support-serum',
                  },
                },
                updated_at: now,
                created_at: now,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    }));

    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    const out = await recallIngredientProducts({
      query: 'panthenol repair serum',
      ingredientId: 'panthenol',
      targetStepFamily: 'serum',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual([
      'Hyaluronic Acid 2% + B5 (Original Formulation)',
      'Amino Acids + B5',
    ]);
    expect(out.diagnostics.recall_source_breakdown).toEqual({
      unattached_seed: 2,
    });
  });

  test('scopes explicit seed pattern recall to targeted fields instead of full seed_data json', async () => {
    const capturedSql = [];
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
        capturedSql.push(text);
        return { rows: [] };
      }),
    }));

    const { recallIngredientProducts } = require('../../src/services/ingredientProductRecall');
    await recallIngredientProducts({
      query: 'panthenol repair serum',
      ingredientId: 'panthenol',
      targetStepFamily: 'serum',
      limit: 3,
    });

    const patternSql = capturedSql.find((text) => text.includes('LIKE ANY($3::text[])'));
    expect(patternSql).toBeTruthy();
    expect(patternSql).not.toMatch(/seed_data::text/);
    expect(patternSql).toMatch(/seed_data->'snapshot'->>'title'/);
    expect(patternSql).toMatch(/seed_data->'snapshot'->>'description'/);
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

  test('uses KB/reference-derived profile terms for non-base ingredients', async () => {
    jest.doMock('../../src/services/ingredientReferenceStore', () => ({
      getBestIngredientReferenceMatch: jest.fn(async (input) => {
        if (!/alpha arbutin/i.test(String(input || ''))) return null;
        return {
          canonical_inci_name: 'Alpha-Arbutin',
          canonical_display_name: 'Alpha Arbutin',
          aliases_common_list: ['alpha arbutin', 'alpha-arbutin'],
          parser_variants_list: ['arbutin alpha'],
          lookup_terms: ['alpha arbutin serum'],
          function_tags_list: ['brightening'],
          benefit_tags_list: ['tone evening'],
          flags: {},
        };
      }),
    }));
    jest.doMock('../../src/services/ingredientSignalStore', () => ({
      getBestIngredientSignalMatch: jest.fn(async () => null),
    }));
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
              id: 'seed_alpha_arbutin',
              external_product_id: 'ext_alpha_arbutin',
              destination_url: 'https://ordinary.example.com/products/alpha-arbutin-2-ha',
              canonical_url: 'https://ordinary.example.com/products/alpha-arbutin-2-ha',
              domain: 'ordinary.example.com',
              title: 'Alpha Arbutin 2% + HA',
              image_url: 'https://ordinary.example.com/alpha-arbutin.jpg',
              price_amount: 12,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:alpha-arbutin',
              seed_data: {
                brand: 'The Ordinary',
                category: 'Serum',
                snapshot: {
                  title: 'Alpha Arbutin 2% + HA',
                  description: 'brightening serum with alpha arbutin',
                  category: 'Serum',
                  canonical_url: 'https://ordinary.example.com/products/alpha-arbutin-2-ha',
                  destination_url: 'https://ordinary.example.com/products/alpha-arbutin-2-ha',
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
      query: 'alpha arbutin serum',
      targetStepFamily: 'serum',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Alpha Arbutin 2% + HA']);
    expect(out.diagnostics.ingredient_profile_source).toBe('kb_only');
    expect(out.diagnostics.ingredient_reference_match_found).toBe(true);
  });

  test('treats description-only adjacent ingredient text as weak evidence', async () => {
    jest.doMock('../../src/services/ingredientReferenceStore', () => ({
      getBestIngredientReferenceMatch: jest.fn(async () => null),
    }));
    jest.doMock('../../src/services/ingredientSignalStore', () => ({
      getBestIngredientSignalMatch: jest.fn(async () => null),
    }));
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
              id: 'seed_azelaic',
              external_product_id: 'ext_azelaic',
              destination_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
              canonical_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
              domain: 'ordinary.example.com',
              title: 'Azelaic Acid Suspension 10%',
              image_url: 'https://ordinary.example.com/azelaic.jpg',
              price_amount: 14,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:azelaic',
              seed_data: {
                brand: 'The Ordinary',
                category: 'Treatment',
                snapshot: {
                  title: 'Azelaic Acid Suspension 10%',
                  description: 'azelaic acid cream for visible redness',
                  category: 'Treatment',
                  canonical_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
                  destination_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_vitc',
              external_product_id: 'ext_vitc',
              destination_url: 'https://ordinary.example.com/products/vitamin-c-serum',
              canonical_url: 'https://ordinary.example.com/products/vitamin-c-serum',
              domain: 'ordinary.example.com',
              title: 'Vitamin-C Serum',
              image_url: 'https://ordinary.example.com/vitc.jpg',
              price_amount: 16,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:vitc',
              seed_data: {
                brand: 'The Ordinary',
                category: 'Serum',
                snapshot: {
                  title: 'Vitamin-C Serum',
                  description: 'tone-evening serum that mentions azelaic acid only in marketing copy',
                  category: 'Serum',
                  canonical_url: 'https://ordinary.example.com/products/vitamin-c-serum',
                  destination_url: 'https://ordinary.example.com/products/vitamin-c-serum',
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
      query: 'azelaic acid cream',
      ingredientId: 'azelaic_acid',
      targetStepFamily: 'treatment',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Azelaic Acid Suspension 10%']);
  });
});

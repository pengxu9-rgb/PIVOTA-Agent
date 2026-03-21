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

  test('family-only fallback is diagnostic-only and does not count as direct recall success', async () => {
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

    expect(out.products).toEqual([]);
    expect(out.diagnostics.family_fallback_attempted).toBe(true);
    expect(out.diagnostics.family_fallback_recovered).toBe(1);
    expect(out.diagnostics.family_fallback_used).toBe(true);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBe('no_explicit_sku_evidence');
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
    expect(Object.values(out.diagnostics.recall_source_breakdown || {}).reduce((sum, count) => sum + Number(count || 0), 0)).toBeGreaterThan(0);
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
    expect(Object.values(out.diagnostics.recall_source_breakdown || {}).reduce((sum, count) => sum + Number(count || 0), 0)).toBeGreaterThan(0);
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
    expect(patternSql).not.toMatch(/seed_data->'snapshot'->>'description'/);
  });

  test('records ingredient-intent family fallback diagnostics without returning it as direct success', async () => {
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

    expect(out.products).toEqual([]);
    expect(out.diagnostics.family_fallback_attempted).toBe(true);
    expect(out.diagnostics.family_fallback_recovered).toBe(1);
    expect(out.diagnostics.family_fallback_used).toBe(true);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBe('step_family_mismatch');
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
        if (!text.includes('LIKE ANY($3::text[])')) return { rows: [] };
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
    expect(String(out.diagnostics.ingredient_profile_source || '')).toMatch(/reference/);
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

  test('azelaic acid cream can use KB step hints when the attached seed title is generic', async () => {
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
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'kb:ordinary:azelaic-suspension',
                brand: 'The Ordinary',
                product_name: 'Azelaic Acid Suspension 10%',
                source_ref: 'https://ordinary.example.com/products/azelaic-acid-suspension',
                raw_ingredient_text_clean: 'azelaic acid',
                inci_list: 'azelaic acid',
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
              id: 'seed_azelaic_generic',
              external_product_id: 'ext_azelaic_generic',
              destination_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
              canonical_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
              domain: 'ordinary.example.com',
              title: 'Calm + Clear 10%',
              image_url: 'https://ordinary.example.com/azelaic.jpg',
              price_amount: 14,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:azelaic-generic',
              seed_data: {
                brand: 'The Ordinary',
                snapshot: {
                  title: 'Calm + Clear 10%',
                  description: 'visible redness support',
                  canonical_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
                  destination_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
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

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Calm + Clear 10%']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('azelaic acid cream can infer treatment step from explicit title when category is missing', async () => {
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
        if (!text.includes("coalesce(attached_product_key, '') = ''")) return { rows: [] };
        const now = new Date().toISOString();
        return {
          rows: [
            {
              id: 'seed_azelaic_unattached',
              external_product_id: 'ext_azelaic_unattached',
              destination_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
              canonical_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
              domain: 'ordinary.example.com',
              title: 'Azelaic Acid Suspension 10%',
              image_url: 'https://ordinary.example.com/azelaic.jpg',
              price_amount: 14,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: '',
              seed_data: {
                brand: 'The Ordinary',
                snapshot: {
                  title: 'Azelaic Acid Suspension 10%',
                  description: 'visible redness support cream',
                  canonical_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
                  destination_url: 'https://ordinary.example.com/products/azelaic-acid-suspension',
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
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('benzoyl peroxide gel keeps explicit treatment products ahead of generic blemish sticker noise', async () => {
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
              id: 'seed_bpo',
              external_product_id: 'ext_bpo',
              destination_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
              canonical_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
              domain: 'acme.example.com',
              title: 'Benzoyl Peroxide 5% Gel',
              image_url: 'https://acme.example.com/bpo.jpg',
              price_amount: 18,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:bpo',
              seed_data: {
                brand: 'Acme',
                category: 'Treatment',
                snapshot: {
                  title: 'Benzoyl Peroxide 5% Gel',
                  description: 'benzoyl peroxide acne treatment gel',
                  category: 'Treatment',
                  canonical_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
                  destination_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_patch',
              external_product_id: 'ext_patch',
              destination_url: 'https://acme.example.com/products/blemish-patch-stickers',
              canonical_url: 'https://acme.example.com/products/blemish-patch-stickers',
              domain: 'acme.example.com',
              title: 'Blemish Patch Stickers',
              image_url: 'https://acme.example.com/patch.jpg',
              price_amount: 9,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:patch',
              seed_data: {
                brand: 'Acme',
                category: 'Patch',
                snapshot: {
                  title: 'Blemish Patch Stickers',
                  description: 'blemish sticker for acne spots',
                  category: 'Patch',
                  canonical_url: 'https://acme.example.com/products/blemish-patch-stickers',
                  destination_url: 'https://acme.example.com/products/blemish-patch-stickers',
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
      query: 'benzoyl peroxide gel',
      ingredientId: 'benzoyl_peroxide',
      targetStepFamily: 'treatment',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Benzoyl Peroxide 5% Gel']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('benzoyl peroxide gel can use KB step hints when the attached seed title is generic', async () => {
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
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'kb:acme:bpo-gel',
                brand: 'Acme',
                product_name: 'Benzoyl Peroxide 5% Gel',
                source_ref: 'https://acme.example.com/products/benzoyl-peroxide-gel',
                raw_ingredient_text_clean: 'benzoyl peroxide',
                inci_list: 'benzoyl peroxide',
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
              id: 'seed_bpo_generic',
              external_product_id: 'ext_bpo_generic',
              destination_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
              canonical_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
              domain: 'acme.example.com',
              title: 'Clear Skin 5%',
              image_url: 'https://acme.example.com/bpo.jpg',
              price_amount: 18,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:bpo-generic',
              seed_data: {
                brand: 'Acme',
                snapshot: {
                  title: 'Clear Skin 5%',
                  description: 'daily blemish care',
                  canonical_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
                  destination_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
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
      query: 'benzoyl peroxide gel',
      ingredientId: 'benzoyl_peroxide',
      targetStepFamily: 'treatment',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Clear Skin 5%']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('benzoyl peroxide gel can infer treatment step from explicit title when category is missing', async () => {
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
        if (!text.includes("coalesce(attached_product_key, '') = ''")) return { rows: [] };
        const now = new Date().toISOString();
        return {
          rows: [
            {
              id: 'seed_bpo_unattached',
              external_product_id: 'ext_bpo_unattached',
              destination_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
              canonical_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
              domain: 'acme.example.com',
              title: 'Benzoyl Peroxide 5% Gel',
              image_url: 'https://acme.example.com/bpo.jpg',
              price_amount: 18,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: '',
              seed_data: {
                brand: 'Acme',
                snapshot: {
                  title: 'Benzoyl Peroxide 5% Gel',
                  description: 'daily acne gel',
                  canonical_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
                  destination_url: 'https://acme.example.com/products/benzoyl-peroxide-gel',
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
      query: 'benzoyl peroxide gel',
      ingredientId: 'benzoyl_peroxide',
      targetStepFamily: 'treatment',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Benzoyl Peroxide 5% Gel']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('fetchSeedRowsByPatterns searches targeted ingredient metadata fields, not only titles and urls', async () => {
    const queryMock = jest.fn(async () => ({ rows: [] }));
    jest.doMock('../../src/db', () => ({
      query: queryMock,
    }));

    const { _internals } = require('../../src/services/ingredientSkuEvidence');
    await _internals.fetchSeedRowsByPatterns({
      patterns: ['%glycerin%'],
      attachedState: 'attached',
      limit: 6,
    });

    const sqlText = String(queryMock.mock.calls[0]?.[0] || '');
    const whereSql = sqlText.split('ORDER BY')[0] || sqlText;
    expect(sqlText).toContain("seed_data->'science'->'key_ingredients'");
    expect(sqlText).toContain("seed_data->'ingredient_intel'->'inci_normalized'");
    expect(sqlText).toContain("seed_data->'snapshot'->'ingredient_intel'->'inci_normalized'");
    expect(whereSql).toContain("seed_data->'science'->'key_ingredients'");
    expect(whereSql).toContain("seed_data->'ingredient_intel'->'inci_normalized'");
    expect(whereSql).toContain("seed_data->'snapshot'->'ingredient_intel'->'inci_normalized'");
  });

  test('glycerin moisturizer can use seed ingredient metadata when title is generic', async () => {
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
        if (
          !text.includes("seed_data->'science'->'key_ingredients'") ||
          !text.includes("seed_data->'ingredient_intel'->'inci_normalized'")
        ) {
          return { rows: [] };
        }
        const now = new Date().toISOString();
        return {
          rows: [
            {
              id: 'seed_generic_glycerin',
              external_product_id: 'ext_generic_glycerin',
              destination_url: 'https://acme.example.com/products/barrier-support-moisturizer',
              canonical_url: 'https://acme.example.com/products/barrier-support-moisturizer',
              domain: 'acme.example.com',
              title: 'Barrier Support Moisturizer',
              image_url: 'https://acme.example.com/barrier.jpg',
              price_amount: 26,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:barrier-support-moisturizer',
              seed_data: {
                brand: 'Acme',
                category: 'Moisturizer',
                science: {
                  key_ingredients: ['Glycerin', 'Panthenol'],
                },
                ingredient_intel: {
                  inci_normalized: ['Glycerin', 'Panthenol'],
                },
                snapshot: {
                  title: 'Barrier Support Moisturizer',
                  description: 'daily barrier moisturizer for dry skin',
                  category: 'Moisturizer',
                  science: {
                    key_ingredients: ['Glycerin', 'Panthenol'],
                  },
                  ingredient_intel: {
                    inci_normalized: ['Glycerin', 'Panthenol'],
                  },
                  canonical_url: 'https://acme.example.com/products/barrier-support-moisturizer',
                  destination_url: 'https://acme.example.com/products/barrier-support-moisturizer',
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
      query: 'glycerin moisturizer',
      ingredientId: 'glycerin',
      targetStepFamily: 'moisturizer',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Barrier Support Moisturizer']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('glycerin moisturizer can bridge KB product name and brand when urls do not match', async () => {
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
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'kb:acme:barrier-support-moisturizer',
                brand: 'Acme',
                product_name: 'Barrier Support Moisturizer',
                source_ref: 'https://kb.acme.example.com/pdp/barrier-support-moisturizer',
                raw_ingredient_text_clean: 'glycerin, panthenol',
                inci_list: 'glycerin, panthenol',
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
              id: 'seed_barrier_support',
              external_product_id: 'ext_barrier_support',
              destination_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
              canonical_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
              domain: 'shop.acme.example.com',
              title: 'Barrier Support Moisturizer',
              image_url: 'https://shop.acme.example.com/barrier.jpg',
              price_amount: 24,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:barrier-support-moisturizer',
              seed_data: {
                brand: 'Acme',
                category: 'Moisturizer',
                snapshot: {
                  title: 'Barrier Support Moisturizer',
                  description: 'daily barrier moisturizer for dry skin',
                  brand: 'Acme',
                  category: 'Moisturizer',
                  canonical_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
                  destination_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
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
      query: 'glycerin moisturizer',
      ingredientId: 'glycerin',
      targetStepFamily: 'moisturizer',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Barrier Support Moisturizer']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
    expect(
      Number(out.diagnostics.recall_source_breakdown?.kb_named_attached_seed || 0) +
      Number(out.diagnostics.recall_source_breakdown?.kb_attached_seed || 0),
    ).toBeGreaterThan(0);
  });

  test('glycerin moisturizer can use KB step hints when the attached seed title is generic and category is missing', async () => {
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
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'kb:acme:barrier-support-moisturizer',
                brand: 'Acme',
                product_name: 'Barrier Support Moisturizer',
                source_ref: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
                raw_ingredient_text_clean: 'glycerin, panthenol',
                inci_list: 'glycerin, panthenol',
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
              id: 'seed_barrier_support_generic',
              external_product_id: 'ext_barrier_support_generic',
              destination_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
              canonical_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
              domain: 'shop.acme.example.com',
              title: 'Barrier Support',
              image_url: 'https://shop.acme.example.com/barrier.jpg',
              price_amount: 24,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:barrier-support-moisturizer',
              seed_data: {
                brand: 'Acme',
                snapshot: {
                  title: 'Barrier Support',
                  description: 'daily skin support',
                  canonical_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
                  destination_url: 'https://shop.acme.example.com/products/barrier-support-moisturizer',
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
      query: 'glycerin moisturizer',
      ingredientId: 'glycerin',
      targetStepFamily: 'moisturizer',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Barrier Support']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('glycerin moisturizer rejects off-family hand-mask noise before ranking', async () => {
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
              id: 'seed_glycerin_moisturizer',
              external_product_id: 'ext_glycerin_moisturizer',
              destination_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
              canonical_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
              domain: 'acme.example.com',
              title: 'Glycerin Barrier Moisturizer',
              image_url: 'https://acme.example.com/glycerin.jpg',
              price_amount: 20,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:glycerin-moisturizer',
              seed_data: {
                brand: 'Acme',
                category: 'Moisturizer',
                snapshot: {
                  title: 'Glycerin Barrier Moisturizer',
                  description: 'glycerin moisturizer for dry skin',
                  category: 'Moisturizer',
                  canonical_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
                  destination_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_hand_mask',
              external_product_id: 'ext_hand_mask',
              destination_url: 'https://acme.example.com/products/glycerin-hand-mask',
              canonical_url: 'https://acme.example.com/products/glycerin-hand-mask',
              domain: 'acme.example.com',
              title: 'Glycerin Hand Mask',
              image_url: 'https://acme.example.com/hand-mask.jpg',
              price_amount: 8,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:glycerin-hand-mask',
              seed_data: {
                brand: 'Acme',
                category: 'Mask',
                snapshot: {
                  title: 'Glycerin Hand Mask',
                  description: 'glycerin mask for hands',
                  category: 'Mask',
                  canonical_url: 'https://acme.example.com/products/glycerin-hand-mask',
                  destination_url: 'https://acme.example.com/products/glycerin-hand-mask',
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
      query: 'glycerin moisturizer',
      ingredientId: 'glycerin',
      targetStepFamily: 'moisturizer',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Glycerin Barrier Moisturizer']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('glycerin moisturizer rejects explicit peel and primer rows before ranking', async () => {
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
        if (text.includes('FROM pci_kb.sku_ingredients')) {
          return {
            rows: [
              {
                sku_key: 'extseed:seed_peel:pixi',
                brand: 'Pixi',
                product_name: 'Hydrating Milky Peel',
                source_ref: 'https://pixibeauty.com/products/hydrating-milky-peel',
                raw_ingredient_text_clean: 'glycerin',
                inci_list: 'glycerin',
                created_at: new Date().toISOString(),
              },
              {
                sku_key: 'extseed:seed_primer:pixi',
                brand: 'Pixi',
                product_name: 'Flawless Beauty Primer',
                source_ref: 'https://pixibeauty.com/products/flawless-beauty-primer',
                raw_ingredient_text_clean: 'glycerin',
                inci_list: 'glycerin',
                created_at: new Date().toISOString(),
              },
              {
                sku_key: 'extseed:seed_moisturizer:acme',
                brand: 'Acme',
                product_name: 'Glycerin Barrier Moisturizer',
                source_ref: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
                raw_ingredient_text_clean: 'glycerin',
                inci_list: 'glycerin',
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
              id: 'seed_peel',
              external_product_id: 'ext_peel',
              destination_url: 'https://pixibeauty.com/products/hydrating-milky-peel',
              canonical_url: 'https://pixibeauty.com/products/hydrating-milky-peel',
              domain: 'pixibeauty.com',
              title: 'Hydrating Milky Peel',
              image_url: 'https://pixibeauty.com/peel.jpg',
              price_amount: 24,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:peel',
              seed_data: {
                brand: 'Pixi',
                snapshot: {
                  title: 'Hydrating Milky Peel',
                  description: 'micro-exfoliating cream with glycerin',
                  canonical_url: 'https://pixibeauty.com/products/hydrating-milky-peel',
                  destination_url: 'https://pixibeauty.com/products/hydrating-milky-peel',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_primer',
              external_product_id: 'ext_primer',
              destination_url: 'https://pixibeauty.com/products/flawless-beauty-primer',
              canonical_url: 'https://pixibeauty.com/products/flawless-beauty-primer',
              domain: 'pixibeauty.com',
              title: 'Flawless Beauty Primer',
              image_url: 'https://pixibeauty.com/primer.jpg',
              price_amount: 22,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:primer',
              seed_data: {
                brand: 'Pixi',
                snapshot: {
                  title: 'Flawless Beauty Primer',
                  description: 'makeup primer with glycerin',
                  canonical_url: 'https://pixibeauty.com/products/flawless-beauty-primer',
                  destination_url: 'https://pixibeauty.com/products/flawless-beauty-primer',
                },
              },
              updated_at: now,
              created_at: now,
            },
            {
              id: 'seed_moisturizer',
              external_product_id: 'ext_moisturizer',
              destination_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
              canonical_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
              domain: 'acme.example.com',
              title: 'Glycerin Barrier Moisturizer',
              image_url: 'https://acme.example.com/glycerin.jpg',
              price_amount: 20,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:glycerin-moisturizer',
              seed_data: {
                brand: 'Acme',
                category: 'Moisturizer',
                snapshot: {
                  title: 'Glycerin Barrier Moisturizer',
                  description: 'glycerin moisturizer for dry skin',
                  category: 'Moisturizer',
                  canonical_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
                  destination_url: 'https://acme.example.com/products/glycerin-barrier-moisturizer',
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
      query: 'glycerin moisturizer',
      ingredientId: 'glycerin',
      targetStepFamily: 'moisturizer',
      limit: 3,
    });

    expect(out.products.map((row) => row.title || row.name)).toEqual(['Glycerin Barrier Moisturizer']);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBeNull();
  });

  test('glycerin moisturizer rejects off-surface explicit-only hand mask rows', async () => {
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
              id: 'seed_hand_mask',
              external_product_id: 'ext_hand_mask',
              destination_url: 'https://acme.example.com/products/glycerin-hand-mask',
              canonical_url: 'https://acme.example.com/products/glycerin-hand-mask',
              domain: 'acme.example.com',
              title: 'Glycerin Hand Mask',
              image_url: 'https://acme.example.com/hand-mask.jpg',
              price_amount: 8,
              price_currency: 'USD',
              availability: 'in stock',
              attached_product_key: 'shopify:glycerin-hand-mask',
              seed_data: {
                brand: 'Acme',
                category: 'Mask',
                snapshot: {
                  title: 'Glycerin Hand Mask',
                  description: 'glycerin mask for hands',
                  category: 'Mask',
                  canonical_url: 'https://acme.example.com/products/glycerin-hand-mask',
                  destination_url: 'https://acme.example.com/products/glycerin-hand-mask',
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
      query: 'glycerin moisturizer',
      ingredientId: 'glycerin',
      targetStepFamily: 'moisturizer',
      limit: 3,
    });

    expect(out.products).toEqual([]);
    expect(out.diagnostics.ingredient_direct_miss_reason).toBe('no_explicit_sku_evidence');
  });
});

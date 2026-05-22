const {
  enrichProductWithCatalogPdpContentFields,
  __test,
} = require('../../src/services/catalogPdpContentFields');
const { buildStructuredPdpIngredientModules } = require('../../src/services/pdpIngredientAuthority');

describe('catalogPdpContentFields', () => {
  beforeEach(() => {
    __test._resetCache();
  });

  test('fills force-filled ingredient evidence from approved catalog product payload', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          source_product_id: 'ext_tom_ford_payload',
          product_payload: {
            category: 'Eyeliner',
            category_path: ['beauty', 'makeup', 'eye', 'eyeliner'],
            catalog_category_path: 'beauty/makeup/eye/eyeliner',
            product_type: 'Eyeliner',
            seed_data: {
              pdp_ingredients_raw:
                'Hydrogenated Polyisobutene, Trimethylsiloxysilicate, Isododecane, Synthetic Wax, Polybutene, Mica, Synthetic Fluorphlogopite, Lauroyl Lysine, Disteardimonium Hectorite, Propylene Carbonate, Ethylene/propylene Copolymer, Copernicia Cerifera (carnauba) Wax Copernicia Cerifera Cera Cire De Carnauba, Pentaerythrityl Tetra-di-t-butyl Hydroxyhydrocinnamate, Titanium Dioxide (ci 77891), Iron Oxides (ci 77491), Iron Oxides (ci 77492), Iron Oxides (ci 77499)',
              raw_ingredient_text_clean:
                'Hydrogenated Polyisobutene, Trimethylsiloxysilicate, Isododecane, Synthetic Wax, Polybutene, Mica, Synthetic Fluorphlogopite, Lauroyl Lysine, Disteardimonium Hectorite, Propylene Carbonate, Ethylene/propylene Copolymer, Copernicia Cerifera (carnauba) Wax Copernicia Cerifera Cera Cire De Carnauba, Pentaerythrityl Tetra-di-t-butyl Hydroxyhydrocinnamate, Titanium Dioxide (ci 77891), Iron Oxides (ci 77491), Iron Oxides (ci 77492), Iron Oxides (ci 77499)',
              pdp_field_quality_summary: {
                ingredients_raw: {
                  source_origin: 'official_html',
                  source_quality_status: 'high',
                },
                ingredients_inci: {
                  source_origin: 'official_html',
                  source_quality_status: 'high',
                },
              },
            },
          },
        },
      ],
    }));
    const product = {
      product_id: 'ext_tom_ford_alias',
      merchant_id: 'external_seed',
      title: 'Gel Eyeliner',
      product_family: 'set_or_collection',
      product_kind: 'bundle',
      ingredient_intel: {
        force_fill_contract: {
          contract_version: 'pivota.pdp.force_fill.v1',
          source_origin: 'pivota_force_fill',
          source_quality_status: 'force_filled_pending_source',
          display_note: 'Ingredient details are pending approved source capture.',
        },
      },
      pdp_field_quality_summary: {
        ingredients_inci: {
          source_origin: 'pivota_force_fill',
          source_quality_status: 'force_filled_pending_source',
        },
      },
    };

    await enrichProductWithCatalogPdpContentFields(product, {
      merchantId: 'external_seed',
      sourceProductIds: ['ext_tom_ford_alias', 'ext_tom_ford_payload'],
      queryFn,
    });

    expect(product.pdp_ingredients_raw).toContain('Trimethylsiloxysilicate');
    expect(product.raw_ingredient_text_clean).toContain('Titanium Dioxide');
    expect(product.category_path).toEqual(['beauty', 'makeup', 'eye', 'eyeliner']);
    expect(product.product_type).toBe('Eyeliner');
    expect(product.ingredient_intel?.force_fill_contract).toBeUndefined();
    expect(product.pdp_field_quality_summary.ingredients_raw).toMatchObject({
      source_origin: 'official_html',
      source_quality_status: 'high',
    });
    expect(product.catalog_pdp_content_hydration).toMatchObject({
      source: 'catalog_products.product_payload',
      source_product_id: 'ext_tom_ford_payload',
    });
    expect(buildStructuredPdpIngredientModules(product).ingredientsInciData).toEqual(
      expect.objectContaining({
        source_quality_status: 'authoritative',
        items: expect.arrayContaining(['Trimethylsiloxysilicate']),
      }),
    );
  });

  test('does not overwrite existing high-quality PDP content with catalog payload text', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          source_product_id: 'ext_lower_priority',
          product_payload: {
            seed_data: {
              pdp_ingredients_raw: 'Catalog Replacement, Should Not Apply',
              pdp_field_quality_summary: {
                ingredients_raw: {
                  source_origin: 'official_html',
                  source_quality_status: 'high',
                },
              },
            },
          },
        },
      ],
    }));
    const product = {
      product_id: 'ext_existing_high',
      merchant_id: 'external_seed',
      pdp_ingredients_raw: 'Reviewed Existing, Glycerin, Panthenol',
      pdp_field_quality_summary: {
        ingredients_raw: {
          source_origin: 'manual_reviewed',
          source_quality_status: 'high',
        },
      },
    };

    await enrichProductWithCatalogPdpContentFields(product, {
      merchantId: 'external_seed',
      sourceProductIds: ['ext_lower_priority'],
      queryFn,
    });

    expect(product.pdp_ingredients_raw).toBe('Reviewed Existing, Glycerin, Panthenol');
    expect(product.catalog_pdp_content_hydration).toBeUndefined();
  });

  test('ignores low-quality catalog payload fields', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          source_product_id: 'ext_low',
          product_payload: {
            seed_data: {
              pdp_ingredients_raw: 'Marketing extract blend',
              pdp_field_quality_summary: {
                ingredients_raw: {
                  source_origin: 'legacy_fallback',
                  source_quality_status: 'low',
                },
              },
            },
          },
        },
      ],
    }));
    const product = {
      product_id: 'ext_missing',
      merchant_id: 'external_seed',
    };

    await enrichProductWithCatalogPdpContentFields(product, {
      merchantId: 'external_seed',
      sourceProductIds: ['ext_low'],
      queryFn,
    });

    expect(product.pdp_ingredients_raw).toBeUndefined();
    expect(product.catalog_pdp_content_hydration).toBeUndefined();
  });
});

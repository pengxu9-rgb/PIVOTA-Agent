const ORIGINAL_ENV = process.env;

function makeExternalProduct(product_id, overrides = {}) {
  return {
    merchant_id: 'external_seed',
    product_id,
    title: overrides.title || product_id,
    brand: overrides.brand || 'The Ordinary',
    category: overrides.category || 'Serum',
    product_type: overrides.product_type || overrides.category || 'Serum',
    price: overrides.price || 20,
    currency: 'USD',
    source: 'external_seed',
    inventory_quantity: 10,
    status: 'active',
    ...overrides,
  };
}

describe('RecommendationEngine product-intel card hydration', () => {
  afterEach(() => {
    jest.dontMock('../../src/auroraBff/productIntelKbStore');
    jest.resetModules();
    process.env = ORIGINAL_ENV;
  });

  test('hydrates similar card highlight from reviewed product-intel KB', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: '',
      PDP_RECS_CACHE_ENABLED: 'false',
    };
    jest.doMock('../../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntries: jest.fn(async () =>
        new Map([
          [
            'product:ext_candidate_serum',
            {
              source: 'pivota_product_intel_pilot_selected',
              source_meta: {
                quality_state: 'reviewed',
                review_status: 'completed',
                reviewer_kind: 'human',
              },
              analysis: {
                product_intel_v1: {
                  shopping_card: {
                    title: 'The Ordinary Candidate Serum',
                    subtitle: 'Treatment Serum',
                    highlight: 'Peptide serum with HA',
                    intro: 'Reviewed serum card copy.',
                  },
                  search_card: {
                    title_candidate: 'The Ordinary Candidate Serum',
                    compact_candidate: 'Treatment Serum',
                    highlight_candidate: 'Peptide serum with HA',
                  },
                },
              },
            },
          ],
        ]),
      ),
    }));

    const { recommend } = require('../../src/services/RecommendationEngine');
    const result = await recommend({
      pdp_product: makeExternalProduct('ext_base_serum', {
        title: 'Hydrating Serum',
        price: 20,
      }),
      k: 1,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          makeExternalProduct('ext_candidate_serum', {
            title: 'Brightening Serum',
            price: 21,
          }),
        ],
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].card_highlight).toBe('Peptide serum with HA');
    expect(result.items[0].shopping_card?.highlight).toBe('Peptide serum with HA');
    expect(result.items[0].search_card?.highlight_candidate).toBe('Peptide serum with HA');
    expect(result.metadata.product_intel_card_hydration).toEqual(
      expect.objectContaining({ attempted_count: 1, hydrated_count: 1 }),
    );
  });

  test('does not hydrate unreviewed product-intel KB into similar cards', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: '',
      PDP_RECS_CACHE_ENABLED: 'false',
    };
    jest.doMock('../../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntries: jest.fn(async () =>
        new Map([
          [
            'product:ext_unreviewed_serum',
            {
              source: 'draft_generation',
              source_meta: { quality_state: 'draft' },
              analysis: {
                product_intel_v1: {
                  shopping_card: {
                    highlight: 'Draft-only claim',
                  },
                },
              },
            },
          ],
        ]),
      ),
    }));

    const { recommend } = require('../../src/services/RecommendationEngine');
    const result = await recommend({
      pdp_product: makeExternalProduct('ext_base_serum', {
        title: 'Hydrating Serum',
        price: 20,
      }),
      k: 1,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          makeExternalProduct('ext_unreviewed_serum', {
            title: 'Brightening Serum',
            price: 21,
          }),
        ],
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].card_highlight).toBeUndefined();
    expect(result.metadata.product_intel_card_hydration).toEqual(
      expect.objectContaining({ attempted_count: 1, hydrated_count: 0, skipped_unreviewed_count: 1 }),
    );
  });

  test('hydrates variant similar cards from reviewed sig or parent Product Intel aliases', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: '',
      PDP_RECS_CACHE_ENABLED: 'false',
    };
    const getProductIntelKbEntries = jest.fn(async () =>
      new Map([
        [
          'product:sig_lip_glaze',
          {
            source: 'c_beauty_product_intel_sig_alias',
            source_meta: {
              quality_state: 'reviewed',
              review_status: 'completed',
              reviewer_kind: 'assistant',
            },
            analysis: {
              product_intel_v1: {
                shopping_card: {
                  title: 'Aqua Burst Lip Glaze',
                  subtitle: 'Lip Glaze',
                  highlight: 'Glass-like lip shine',
                },
                search_card: {
                  title_candidate: 'Aqua Burst Lip Glaze',
                  compact_candidate: 'Lip Glaze',
                  highlight_candidate: 'Glass-like lip shine',
                },
              },
            },
          },
        ],
      ]),
    );
    jest.doMock('../../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntries,
    }));

    const { recommend } = require('../../src/services/RecommendationEngine');
    const result = await recommend({
      pdp_product: makeExternalProduct('ext_base_lip', {
        title: 'Silky Matte Lip Ink',
        category: 'Lip Makeup',
        price: 20,
      }),
      k: 1,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          makeExternalProduct('ext_variant_lip_glaze', {
            title: 'Aqua Burst Lip Glaze',
            category: 'Lip Makeup',
            price: 21,
            parent_external_product_id: 'ext_parent_lip_glaze',
            sellable_item_group_id: 'sig_lip_glaze',
            source_listing_scope: 'variant',
          }),
        ],
      },
    });

    expect(getProductIntelKbEntries).toHaveBeenCalledWith(
      expect.arrayContaining([
        'product:ext_variant_lip_glaze',
        'product:sig_lip_glaze',
        'product:ext_parent_lip_glaze',
      ]),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].card_highlight).toBe('Glass-like lip shine');
    expect(result.metadata.product_intel_card_hydration).toEqual(
      expect.objectContaining({ attempted_count: 1, hydrated_count: 1 }),
    );
  });

  test('does not run direct DB fallback for alias misses when an item already has a reviewed bundle', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unit-test',
      PDP_RECS_CACHE_ENABLED: 'false',
    };
    const query = jest.fn(async () => ({ rows: [] }));
    jest.doMock('../../src/db', () => ({ query }));
    jest.doMock('../../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntries: jest.fn(async () =>
        new Map([
          [
            'product:sig_lip_glaze',
            {
              source: 'c_beauty_product_intel_sig_alias',
              source_meta: {
                quality_state: 'reviewed',
                review_status: 'completed',
                reviewer_kind: 'assistant',
              },
              analysis: {
                product_intel_v1: {
                  shopping_card: {
                    title: 'Aqua Burst Lip Glaze',
                    subtitle: 'Lip Glaze',
                    highlight: 'Glass-like lip shine',
                  },
                },
              },
            },
          ],
        ]),
      ),
    }));

    const { recommend } = require('../../src/services/RecommendationEngine');
    const result = await recommend({
      pdp_product: makeExternalProduct('ext_base_lip', {
        title: 'Silky Matte Lip Ink',
        category: 'Lip Makeup',
        price: 20,
      }),
      k: 1,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          makeExternalProduct('ext_variant_lip_glaze', {
            title: 'Aqua Burst Lip Glaze',
            category: 'Lip Makeup',
            price: 21,
            parent_external_product_id: 'ext_parent_lip_glaze',
            sellable_item_group_id: 'sig_lip_glaze',
            source_listing_scope: 'variant',
          }),
        ],
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].card_highlight).toBe('Glass-like lip shine');
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('aurora_product_intel_kb')),
    ).toBe(false);
    expect(result.metadata.product_intel_card_hydration).toEqual(
      expect.objectContaining({
        attempted_count: 1,
        hydrated_count: 1,
        db_fallback_attempted_count: 0,
        db_fallback_hit_count: 0,
      }),
    );
  });

  test('uses direct DB fallback when KB store misses a reviewed similar card bundle', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unit-test',
      PDP_RECS_CACHE_ENABLED: 'false',
    };
    jest.doMock('../../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntries: jest.fn(async () => new Map()),
    }));
    jest.doMock('../../src/db', () => ({
      query: jest.fn(async () => ({
        rows: [
          {
            kb_key: 'product:ext_db_serum',
            source: 'c_beauty_product_intel_sig_alias',
            source_meta: {
              quality_state: 'reviewed',
              review_status: 'completed',
              reviewer_kind: 'assistant',
            },
            analysis: {
              product_intel_v1: {
                shopping_card: {
                  title: 'Reviewed DB Serum',
                  subtitle: 'Treatment Serum',
                  highlight: 'Reviewed DB highlight',
                },
                search_card: {
                  title_candidate: 'Reviewed DB Serum',
                  compact_candidate: 'Treatment Serum',
                  highlight_candidate: 'Reviewed DB highlight',
                },
              },
            },
          },
        ],
      })),
    }));

    const { recommend } = require('../../src/services/RecommendationEngine');
    const result = await recommend({
      pdp_product: makeExternalProduct('ext_base_serum', {
        title: 'Hydrating Serum',
        price: 20,
      }),
      k: 1,
      options: {
        debug: true,
        no_cache: true,
        internal_candidates: [],
        external_candidates: [
          makeExternalProduct('ext_db_serum', {
            title: 'Brightening Serum',
            price: 21,
          }),
        ],
      },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].card_highlight).toBe('Reviewed DB highlight');
    expect(result.metadata.product_intel_card_hydration).toEqual(
      expect.objectContaining({
        attempted_count: 1,
        hydrated_count: 1,
        db_fallback_attempted_count: 1,
        db_fallback_hit_count: 1,
      }),
    );
  });
});

describe('search dedupe policy', () => {
  let app;

  beforeAll(() => {
    jest.resetModules();
    app = require('../src/server');
  });

  test('beauty scenario query allows more same-title variants', () => {
    const limit = app._debug.resolveSearchDedupePerTitleLimit({
      queryText: '约会妆',
      intent: {
        primary_domain: 'beauty',
        scenario: { name: 'general' },
        query_class: 'scenario',
      },
      queryClass: 'scenario',
    });
    expect(limit).toBe(3);
  });

  test('beauty non-scenario query keeps moderate dedupe', () => {
    const limit = app._debug.resolveSearchDedupePerTitleLimit({
      queryText: '化妆刷',
      intent: {
        primary_domain: 'beauty',
        scenario: { name: 'beauty_tools' },
        query_class: 'category',
      },
      queryClass: 'category',
    });
    expect(limit).toBe(2);
  });

  test('lookup query keeps strict dedupe', () => {
    const limit = app._debug.resolveSearchDedupePerTitleLimit({
      queryText: 'ipsa',
      intent: {
        primary_domain: 'beauty',
        scenario: { name: 'general' },
        query_class: 'lookup',
      },
      queryClass: 'lookup',
    });
    expect(limit).toBe(1);
  });

  test('travel lookup surface keeps strict dedupe regardless of beauty scenario', () => {
    const limit = app._debug.resolveSearchDedupePerTitleLimit({
      queryText: 'gel-cream moisturizer',
      intent: {
        primary_domain: 'beauty',
        scenario: { name: 'general' },
        query_class: 'category',
      },
      queryClass: 'category',
      uiSurface: 'travel_lookup',
    });
    expect(limit).toBe(1);
  });

  test('buildFindProductsMultiPayloadFromQuery applies travel lookup clarification continuation', () => {
    const payload = app._debug.buildFindProductsMultiPayloadFromQuery({
      query: 'Face SPF50+ PA++++ sunscreen',
      ui_surface: 'travel_lookup',
      clarification_slot: 'brand',
      clarification_answer: 'No brand preference',
      slot_state: JSON.stringify({
        asked_slots: ['category'],
        resolved_slots: { category: 'sunscreen' },
      }),
    });

    expect(payload).toEqual(
      expect.objectContaining({
        search: expect.objectContaining({
          query: 'Face SPF50+ PA++++ sunscreen',
          allow_external_seed: true,
          external_seed_strategy: 'unified_relevance',
          fast_mode: true,
        }),
        context: {
          ui_surface: 'travel_lookup',
          asked_slots: ['category', 'brand'],
          resolved_slots: {
            category: 'sunscreen',
            brand: 'No brand preference',
          },
        },
        metadata: expect.objectContaining({
          ui_surface: 'travel_lookup',
          slot_state: {
            asked_slots: ['category', 'brand'],
            resolved_slots: {
              category: 'sunscreen',
              brand: 'No brand preference',
            },
          },
        }),
      }),
    );
  });

  test('travel lookup defaults external fallback even without clarification state', () => {
    const payload = app._debug.buildFindProductsMultiPayloadFromQuery({
      query: 'Gel-cream moisturizer',
      ui_surface: 'travel_lookup',
    });

    expect(payload.search.allow_external_seed).toBe(true);
    expect(payload.search.external_seed_strategy).toBe('unified_relevance');
    expect(payload.search.fast_mode).toBe(true);
  });

  test('fallback clarification honors resolved travel lookup slot state', () => {
    const body = app._debug.buildProxySearchSoftFallbackResponse({
      queryParams: {
        query: 'Face SPF50+ PA++++ sunscreen',
        ui_surface: 'travel_lookup',
      },
      slotStateInput: {
        asked_slots: ['brand'],
        resolved_slots: { brand: 'No brand preference' },
      },
      reason: 'primary_irrelevant_no_fallback',
      queryClass: 'attribute',
      intent: {
        language: 'en',
        query_class: 'attribute',
        primary_domain: 'beauty',
      },
      queryText: 'Face SPF50+ PA++++ sunscreen',
    });

    expect(body.clarification).toEqual(
      expect.objectContaining({
        slot: 'budget',
        reason_code: 'CLARIFY_BUDGET',
      }),
    );
    expect(body.metadata.slot_state).toEqual({
      asked_slots: ['brand'],
      resolved_slots: {
        brand: 'No brand preference',
      },
    });
  });

  test('budget clarification maps to price bounds', () => {
    const payload = app._debug.buildFindProductsMultiPayloadFromQuery({
      query: 'Gel-cream moisturizer',
      ui_surface: 'travel_lookup',
      clarification_slot: 'budget',
      clarification_answer: '$25–50',
    });

    expect(payload.search.min_price).toBe(25);
    expect(payload.search.max_price).toBe(50);
  });

  test('travel lookup post-process dedupes by canonical url and ranks stock last', () => {
    const processed = app._debug.postProcessTravelLookupProductsResponse({
      products: [
        {
          merchant_id: 'external_seed',
          product_id: 'seed_a',
          title: 'Hydra Vizor Huez',
          canonical_url: 'https://fentybeauty.com/products/hydra-vizor',
          in_stock: true,
        },
        {
          merchant_id: 'external_seed',
          product_id: 'seed_b',
          title: 'Hydra Vizor Huez Duplicate',
          canonical_url: 'https://fentybeauty.com/products/hydra-vizor',
          in_stock: true,
        },
        {
          merchant_id: 'm1',
          product_id: 'unknown_stock',
          title: 'Unknown Stock Moisturizer',
        },
        {
          merchant_id: 'm2',
          product_id: 'oos_product',
          title: 'Sold Out SPF',
          in_stock: false,
        },
      ],
    });

    expect(processed.products).toHaveLength(3);
    expect(processed.products[0].product_id).toBe('seed_a');
    expect(processed.products[0].availability_state).toBe('in_stock');
    expect(processed.products[1].product_id).toBe('unknown_stock');
    expect(processed.products[1].availability_state).toBe('unknown');
    expect(processed.products[2].product_id).toBe('oos_product');
    expect(processed.products[2].availability_state).toBe('out_of_stock');
  });
});

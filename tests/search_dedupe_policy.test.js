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

  test('public beauty discovery derives a deterministic semantic contract for sunscreen queries', () => {
    // Semantic-contract derivation moved from the route-level payload builder into the FPM
    // policy layer: buildBeautyDiscoverySemanticContract (src/findProductsMulti/policy.js),
    // invoked by the mainline with the raw query + search/metadata surfaces.
    const policy = require('../src/findProductsMulti/policy');
    const contract = policy.buildBeautyDiscoverySemanticContract({
      rawQuery: 'best sunscreen for oily skin',
      search: { catalog_surface: 'beauty' },
      metadata: { source: 'aurora-bff' },
    });

    expect(contract).toEqual(
      expect.objectContaining({
        version: 'beauty_semantic_contract_v1',
        owner: 'shopping_agent_beauty_contract_builder',
        planner_mode: 'step_aware',
        request_class: 'sunscreen',
        target_step_family: 'sunscreen',
        primary_role_id: 'daily_sunscreen',
        source_surface: 'shopping_agent_public_beauty',
      }),
    );
  });

  test('public beauty exact lookup does not auto-derive a discovery semantic contract', () => {
    const payload = app._debug.buildFindProductsMultiPayloadFromQuery({
      query: 'The Ordinary Niacinamide 10% + Zinc 1%',
      source: 'aurora-bff',
      catalog_surface: 'beauty',
    });

    expect(payload.search.semantic_contract).toBeUndefined();
  });

  test('public beauty barrier-repair moisturizer query still derives a discovery contract', () => {
    // Seam moved to policy-layer buildBeautyDiscoverySemanticContract
    // (src/findProductsMulti/policy.js). The policy layer now treats capitalized
    // ingredient tokens ("Ceramide NP") as an exact-title-lookup signal and returns
    // no discovery contract for that variant, so the discovery expectation uses the
    // plain lowercase form of the same query.
    const policy = require('../src/findProductsMulti/policy');
    const contract = policy.buildBeautyDiscoverySemanticContract({
      rawQuery: 'moisturizer barrier repair ceramide np barrier repair',
      search: { catalog_surface: 'beauty' },
      metadata: { source: 'aurora-bff' },
    });

    expect(contract).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_contract_builder',
        target_step_family: 'moisturizer',
        primary_role_id: 'barrier_moisturizer',
      }),
    );

    // Title-cased ingredient variant is classified as an exact-title lookup, not discovery.
    expect(
      policy.buildBeautyDiscoverySemanticContract({
        rawQuery: 'moisturizer barrier repair Ceramide NP barrier repair',
        search: { catalog_surface: 'beauty' },
        metadata: { source: 'aurora-bff' },
      }),
    ).toBeNull();
  });

  test('guidance-only beauty serum query derives a discovery contract instead of falling back to generic lookup', () => {
    // Seam moved to policy-layer buildBeautyDiscoverySemanticContract
    // (src/findProductsMulti/policy.js). The policy layer now honors the explicit
    // serum step family (allowed families ['serum', 'treatment']) instead of the
    // legacy route-level coercion of serum -> treatment.
    const policy = require('../src/findProductsMulti/policy');
    const contract = policy.buildBeautyDiscoverySemanticContract({
      rawQuery: 'barrier repair serum',
      search: {
        catalog_surface: 'beauty',
        ui_surface: 'ingredient_plan_guidance_only',
        target_step_family: 'serum',
      },
      metadata: { source: 'aurora_chatbox' },
    });

    expect(contract).toEqual(
      expect.objectContaining({
        owner: 'shopping_agent_beauty_contract_builder',
        target_step_family: 'serum',
        primary_role_id: 'barrier_repair_serum',
        source_surface: 'shopping_agent_public_beauty',
      }),
    );
    expect(contract.allowed_step_families).toEqual(expect.arrayContaining(['serum', 'treatment']));
  });

  test('fallback clarification honors resolved travel lookup slot state', () => {
    // The soft-fallback response builder (buildProxySearchSoftFallbackResponse,
    // src/server.js, exported via _debug for tests) no longer threads slot_state;
    // slot-state honoring moved into buildClarification/chooseNextSlot
    // (src/findProductsMulti/clarification.js), which skips already-resolved slots.
    const body = app._debug.buildProxySearchSoftFallbackResponse({
      queryParams: {
        query: 'Face SPF50+ PA++++ sunscreen',
        ui_surface: 'travel_lookup',
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
    expect(body.metadata.strict_empty).toBe(true);
    expect(body.metadata.strict_empty_reason).toBe('primary_irrelevant_no_fallback');

    // Slot-state honoring at the new seam: a resolved brand slot is not re-asked
    // (next clarify targets budget), and a resolved budget slot advances to brand.
    const { buildClarification } = require('../src/findProductsMulti/clarification');
    expect(
      buildClarification({
        queryClass: 'attribute',
        intent: { language: 'en', query_class: 'attribute', primary_domain: 'beauty' },
        language: 'en',
        rawQuery: 'Face SPF50+ PA++++ sunscreen',
        slotState: {
          asked_slots: ['brand'],
          resolved_slots: { brand: 'No brand preference' },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        slot: 'budget',
        reason_code: 'CLARIFY_BUDGET',
      }),
    );
    expect(
      buildClarification({
        queryClass: 'attribute',
        intent: { language: 'en', query_class: 'attribute', primary_domain: 'beauty' },
        language: 'en',
        rawQuery: 'Face SPF50+ PA++++ sunscreen',
        slotState: {
          asked_slots: ['budget'],
          resolved_slots: { budget: '$25–50' },
        },
      }),
    ).toEqual(
      expect.objectContaining({
        slot: 'brand',
        reason_code: 'CLARIFY_BRAND',
      }),
    );
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

  test('show baseline picks broadens over-constrained sunscreen query', () => {
    // The route-level payload builder no longer rewrites the query for the
    // "Show baseline picks" answer; the baseline-picks broadening escape hatch now
    // lives as a clarification option in buildEnClarification
    // (src/findProductsMulti/clarification.js:374), offered once the attribute
    // slots (budget/brand/category) are exhausted for an over-constrained query.
    const { buildClarification } = require('../src/findProductsMulti/clarification');
    const clarification = buildClarification({
      queryClass: 'attribute',
      intent: { language: 'en', query_class: 'attribute', primary_domain: 'beauty' },
      language: 'en',
      rawQuery: 'Face SPF50+ PA++++ sunscreen',
      slotState: {
        asked_slots: ['budget', 'brand', 'category'],
        resolved_slots: { brand: 'No brand preference' },
      },
    });

    expect(clarification).toEqual(
      expect.objectContaining({
        reason_code: 'CLARIFY_ATTRIBUTE',
        slot: 'budget',
      }),
    );
    expect(clarification.options).toContain('Show baseline picks');
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

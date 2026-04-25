const {
  inferNonBeautyDomainIntent,
  applyNonBeautyDomainIsolation,
} = require('../src/modules/policy/nonBeautyDomainIsolation');

describe('non-beauty domain isolation policy', () => {
  test('detects known non-beauty commerce intents from user text', () => {
    expect(inferNonBeautyDomainIntent('I need a carry-on suitcase under $200')?.id).toBe(
      'carry_on_luggage',
    );
    expect(inferNonBeautyDomainIntent('What camera should a beginner lifestyle creator buy?')?.id).toBe(
      'camera',
    );
    expect(inferNonBeautyDomainIntent('What sunscreen should I buy for oily skin?')).toBeNull();
  });

  test('filters beauty and pet contamination from clear luggage requests', () => {
    const result = applyNonBeautyDomainIsolation({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'I need a carry-on suitcase under $200.',
      responseBody: {
        products: [
          {
            canonical_title: 'Moisture Airyfit Daily Sunscreen SPF50+/PA++++ / Unscented',
            brand: 'Haruharu Wonder',
            canonical_category: 'external',
          },
          {
            canonical_title: 'Warm Fall/Winter Utility-Style Warm Overalls for Dogs & Cats',
            brand: 'PawStyle',
            canonical_category: 'Pet Overalls',
          },
        ],
        metadata: {
          catalog_surface: 'all',
        },
      },
      search: {
        query: 'I need a carry-on suitcase under $200.',
      },
      metadata: {
        source: 'shopping_agent',
      },
    });

    expect(result.products).toHaveLength(0);
    expect(result.reply).toContain('grounded carry-on luggage match');
    expect(result.has_good_match).toBe(false);
    expect(result.reason_codes).toEqual(
      expect.arrayContaining([
        'non_beauty_domain_isolation_applied',
        'non_beauty_domain_isolation_empty',
      ]),
    );
    expect(result.metadata.non_beauty_domain_isolation).toMatchObject({
      applied: true,
      intent_id: 'carry_on_luggage',
      original_count: 2,
      kept_count: 0,
      dropped_count: 2,
      contamination_count: 2,
    });
  });

  test('keeps matching non-beauty products while dropping cross-domain rows', () => {
    const result = applyNonBeautyDomainIsolation({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'I need a carry-on suitcase under $200.',
      responseBody: {
        products: [
          {
            canonical_title: 'FlexLite Carry-On Spinner Suitcase',
            brand: 'TravelCo',
            canonical_category: 'Luggage',
          },
          {
            canonical_title: 'Daily Soothing Sun Shield SPF50+ PA++++',
            brand: 'Haruharu Wonder',
            canonical_category: 'external',
          },
        ],
        metadata: {},
      },
      search: {
        query: 'I need a carry-on suitcase under $200.',
      },
      metadata: {
        source: 'shopping_agent',
      },
    });

    expect(result.products).toHaveLength(1);
    expect(result.products[0].canonical_title).toBe('FlexLite Carry-On Spinner Suitcase');
    expect(result.metadata.non_beauty_domain_isolation).toMatchObject({
      kept_count: 1,
      dropped_count: 1,
    });
    expect(result.reply).toBeUndefined();
  });

  test('also isolates known non-beauty requests on creator fixed-delegate search lanes', () => {
    const result = applyNonBeautyDomainIsolation({
      operation: 'find_products_multi',
      invokeSearchRail: 'fixed_delegate',
      queryText: 'What espresso machine should I buy for a small kitchen?',
      responseBody: {
        products: [
          {
            canonical_title: 'Escape-Proof No-Pull Tactical Dog Harness for Small to Medium Dogs',
            brand: 'PetCozy',
            canonical_category: 'Pet Harness',
          },
          {
            canonical_title: 'Winona Soothing Repair Serum',
            brand: 'Winona',
            canonical_category: 'Serum',
          },
        ],
        metadata: {
          catalog_surface: 'all',
        },
      },
      search: {
        query: 'What espresso machine should I buy for a small kitchen?',
      },
      metadata: {
        source: 'creator_agent',
        catalog_surface: 'all',
      },
    });

    expect(result.products).toEqual([]);
    expect(result.reply).toContain('grounded espresso machine match');
    expect(result.metadata.non_beauty_domain_isolation).toMatchObject({
      applied: true,
      intent_id: 'espresso_machine',
      original_count: 2,
      kept_count: 0,
    });
  });

  test('does not run on explicit beauty surfaces', () => {
    const body = {
      products: [
        {
          canonical_title: 'Daily Soothing Sun Shield SPF50+ PA++++',
          brand: 'Haruharu Wonder',
          canonical_category: 'external',
        },
      ],
      metadata: {},
    };

    const result = applyNonBeautyDomainIsolation({
      operation: 'find_products_multi',
      invokeSearchRail: 'authoritative_shopping',
      queryText: 'I need a sunscreen for oily skin.',
      responseBody: body,
      search: {
        query: 'I need a sunscreen for oily skin.',
        catalog_surface: 'beauty',
      },
      metadata: {
        source: 'shopping_agent',
        beauty_domain_hint: 'beauty',
      },
    });

    expect(result).toBe(body);
  });
});

const { _internals } = require('../../scripts/build_missing_catalog_query_shortlist.cjs');

describe('build_missing_catalog_query_shortlist', () => {
  test('filters noise reasons and keeps actionable rows', () => {
    const shortlist = _internals.buildGroupedShortlist([
      {
        normalized_query: 'daily face sunscreen',
        query_sample: 'daily face sunscreen',
        last_reason: 'blacklisted_category_or_title',
        seen_count: 50,
      },
      {
        normalized_query: 'barrier relief moisturizer',
        query_sample: 'Barrier Relief Moisturizer',
        last_reason: 'product_url_missing',
        seen_count: 200,
      },
    ], 10);

    expect(shortlist).toHaveLength(1);
    expect(shortlist[0]).toMatchObject({
      normalized_query: 'barrier relief moisturizer',
      primary_reason: 'product_url_missing',
      operator_lane: 'create_explicit_product_target',
    });
  });

  test('groups duplicate normalized queries and merges tokens', () => {
    const shortlist = _internals.buildGroupedShortlist([
      {
        normalized_query: 'ceramide_np_https_www_amazon_com_s_k_ceramide_20np',
        query_sample: 'ceramide np skincare best',
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
        last_reason: 'ingredient_plan_v2_external_fallback',
        status: 'external_executor_empty',
        source: 'catalog_partial',
        capture_mode: 'sync_external_executor',
        candidate_url: 'https://www.amazon.com/s?k=Ceramide+NP',
        seen_count: 10,
      },
      {
        normalized_query: 'ceramide_np_https_www_amazon_com_s_k_ceramide_20np',
        query_sample: 'ceramide np skincare best',
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
        last_reason: 'ingredient_plan_v2_external_fallback',
        status: 'external_fallback_returned',
        source: 'catalog_partial',
        capture_mode: 'sync_external_fallback',
        candidate_url: 'https://www.amazon.com/s?k=Ceramide+NP',
        seen_count: 25,
      },
    ], 10);

    expect(shortlist).toHaveLength(1);
    expect(shortlist[0]).toMatchObject({
      ingredient_id: 'ceramide_np',
      query_kind: 'ingredient_query',
      primary_reason: 'ingredient_plan_v2_external_fallback',
      operator_lane: 'external_executor_followup',
      seen_count: 25,
    });
    expect(shortlist[0].capture_modes.sort()).toEqual([
      'sync_external_executor',
      'sync_external_fallback',
    ]);
  });

  test('sorts product_url_missing ahead of lower-priority no_candidates rows', () => {
    const shortlist = _internals.buildGroupedShortlist([
      {
        normalized_query: 'paulas choice bha liquid',
        query_sample: 'Paula’s Choice BHA Liquid',
        last_reason: 'no_candidates',
        seen_count: 500,
      },
      {
        normalized_query: 'barrier relief moisturizer',
        query_sample: 'Barrier Relief Moisturizer',
        last_reason: 'product_url_missing',
        seen_count: 100,
      },
    ], 10);

    expect(shortlist[0].normalized_query).toBe('barrier relief moisturizer');
    expect(shortlist[1].normalized_query).toBe('paulas choice bha liquid');
  });
});

const {
  buildFindProductsMultiPayloadFromQuery,
  extractSearchQueryText,
  firstQueryParamValue,
  normalizeSearchQueryParams,
  parseQueryBoolean,
  parseQueryNumber,
  parseQueryStringArray,
} = require('../../src/commerce/catalog/searchQueryParams');

describe('searchQueryParams', () => {
  test('parses query primitives from scalar and array inputs', () => {
    expect(firstQueryParamValue(['', 'serum'])).toBe('serum');
    expect(parseQueryBoolean(['false'])).toBe(false);
    expect(parseQueryBoolean('YES')).toBe(true);
    expect(parseQueryNumber(['12'])).toBe(12);
    expect(parseQueryStringArray(['a,b', ' c '])).toEqual(['a', 'b', 'c']);
  });

  test('extracts and normalizes search query params', () => {
    expect(extractSearchQueryText({ q: ' toner ' })).toBe('toner');
    expect(normalizeSearchQueryParams({ keyword: 'ipsa lotion' })).toEqual({
      queryText: 'ipsa lotion',
      queryParams: {
        keyword: 'ipsa lotion',
        query: 'ipsa lotion',
      },
    });
  });

  test('builds find_products_multi payload and clamps search limit', () => {
    expect(
      buildFindProductsMultiPayloadFromQuery(
        {
          q: 'peptide serum',
          merchant_ids: 'm1,m2',
          search_all_merchants: 'true',
          allow_external_seed: 'false',
          allow_stale_cache: '0',
          fast_mode: '1',
          external_seed_strategy: 'supplement_internal_first',
          limit: '999',
          offset: '40',
          source: 'Aurora-BFF',
        },
        { searchLimitMax: 50 },
      ),
    ).toEqual({
      search: {
        query: 'peptide serum',
        merchant_ids: ['m1', 'm2'],
        search_all_merchants: true,
        allow_external_seed: false,
        allow_stale_cache: false,
        fast_mode: true,
        external_seed_strategy: 'supplement_internal_first',
        limit: 50,
        page: 1,
      },
      metadata: {
        source: 'aurora-bff',
      },
    });
  });

  test('returns null for empty query unless allowEmptyQuery is enabled', () => {
    expect(buildFindProductsMultiPayloadFromQuery({})).toBeNull();
    expect(
      buildFindProductsMultiPayloadFromQuery(
        {
          merchant_id: 'm1',
        },
        { allowEmptyQuery: true },
      ),
    ).toEqual({
      search: {
        query: '',
        merchant_id: 'm1',
      },
    });
  });
});

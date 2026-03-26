const {
  buildResolverQueryCandidates,
} = require('../../src/commerce/catalog/resolverQueryCandidates');

describe('resolverQueryCandidates', () => {
  test('builds deduped candidates from raw, sanitized, and anchor tokens', () => {
    const result = buildResolverQueryCandidates({
      queryText: '  ipsa的商品有吗？  ',
      sanitizeSearchQueryForRelevance: () => 'ipsa',
      extractSearchAnchorTokens: () => ['ipsa', 'time reset aqua', 'aqua'],
    });

    expect(result).toEqual([
      'ipsa的商品有吗？',
      'ipsa',
      'ipsa time reset aqua aqua',
      'time reset aqua',
      'aqua',
    ]);
  });

  test('returns empty list for blank query', () => {
    expect(buildResolverQueryCandidates({ queryText: '   ' })).toEqual([]);
  });
});

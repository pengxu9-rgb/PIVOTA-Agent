const {
  isKnownLookupAliasQuery: isKnownLookupAliasQueryBase,
  expandLookupAnchorTokens: expandLookupAnchorTokensBase,
} = require('../../src/commerce/catalog/resolverPolicy');
const {
  createSearchRelevanceHelpers,
} = require('../../src/commerce/catalog/searchRelevance');

function createHelpers(overrides = {}) {
  return createSearchRelevanceHelpers({
    firstQueryParamValue: (value) => (Array.isArray(value) ? value[0] : value),
    normalizeResolverText: (value) => String(value || '').trim().toLowerCase(),
    tokenizeResolverQuery: (value) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    isKnownLookupAliasQueryBase,
    expandLookupAnchorTokensBase,
    hasPetSearchSignal: (value) => /\b(dog|cat|pet)\b/i.test(String(value || '')),
    hasPetHarnessSearchSignal: (value) => /\b(harness)\b/i.test(String(value || '')),
    hasBeautyMakeupSearchSignal: (value) => /\b(brush|makeup|foundation|powder)\b/i.test(String(value || '')),
    searchExternalHardRulePrune: true,
    searchCacheValidate: true,
    searchCacheMinCount: 2,
    searchCacheMinAnchor: 0.25,
    searchCacheMaxDomainEntropy: 0.8,
    searchCacheMaxCrossDomainRatio: 0.4,
    ...overrides,
  });
}

describe('searchRelevance helpers', () => {
  test('extractSearchQueryText and normalizeSearchQueryParams normalize q into query', () => {
    const helpers = createHelpers();
    expect(helpers.extractSearchQueryText({ q: '  ipsa toner  ' })).toBe('ipsa toner');
    expect(helpers.normalizeSearchQueryParams({ q: 'ipsa toner' })).toEqual({
      queryText: 'ipsa toner',
      queryParams: { q: 'ipsa toner', query: 'ipsa toner' },
    });
  });

  test('extractSearchAnchorTokens strips noise and keeps meaningful anchors', () => {
    const helpers = createHelpers();
    expect(helpers.extractSearchAnchorTokens('推荐 copper peptide serum products')).toEqual([
      'copper',
      'peptide',
      'serum',
    ]);
  });

  test('isProxySearchFallbackRelevant keeps lookup queries strict to alias-expanded anchors', () => {
    const helpers = createHelpers();
    const irrelevant = helpers.isProxySearchFallbackRelevant(
      {
        products: [{ merchant_id: 'm1', product_id: 'p1', title: 'Random serum' }],
      },
      'IPSA toner',
    );
    const relevant = helpers.isProxySearchFallbackRelevant(
      {
        products: [{ merchant_id: 'm1', product_id: 'p1', title: 'IPSA Time Reset Aqua Toner' }],
      },
      'IPSA toner',
    );
    expect(irrelevant).toBe(false);
    expect(relevant).toBe(true);
  });

  test('isSupplementCandidateRelevant allows ingredient-intent overlap with enriched tokens', () => {
    const helpers = createHelpers();
    expect(
      helpers.isSupplementCandidateRelevant(
        { merchant_id: 'm1', product_id: 'p1', title: 'Brand Multi Peptide Serum' },
        'copper peptide serum',
      ),
    ).toBe(true);
  });

  test('evaluateCacheQualityGate rejects cross-domain cache sets for pet intent', () => {
    const helpers = createHelpers();
    const gate = helpers.evaluateCacheQualityGate({
      products: [
        { merchant_id: 'm1', product_id: 'p1', title: 'Makeup foundation brush' },
        { merchant_id: 'm1', product_id: 'p2', title: 'Powder puff makeup tool' },
      ],
      queryText: 'dog harness',
      intent: { target_object: { type: 'pet' } },
      queryClass: 'category',
    });
    expect(gate.enabled).toBe(true);
    expect(gate.accepted).toBe(false);
    expect(gate.reason).toBe('anchor_below_threshold');
    expect(gate.expected_domain).toBe('pet');
  });
});

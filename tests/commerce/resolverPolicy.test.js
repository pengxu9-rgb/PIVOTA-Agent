const {
  isKnownLookupAliasQuery,
  expandLookupAnchorTokens,
  shouldReducePrimaryTimeoutAfterResolverMiss,
  isStrongResolverFirstQuery,
  getSecondaryFallbackSkipReason,
  shouldUseResolverFirstSearch,
} = require('../../src/commerce/catalog/resolverPolicy');

describe('resolverPolicy', () => {
  test('recognizes known lookup alias queries across language variants', () => {
    expect(
      isKnownLookupAliasQuery({
        queryText: '想买流金水',
        normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
      }),
    ).toBe(true);

    expect(
      isKnownLookupAliasQuery({
        queryText: 'generic moisturizer',
        normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
      }),
    ).toBe(false);
  });

  test('expands lookup anchors with family aliases and split tokens', () => {
    const expanded = expandLookupAnchorTokens({
      queryText: 'ipsa time reset aqua',
      anchorTokens: ['ipsa'],
      normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
      tokenizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean),
    });

    expect(expanded).toEqual(
      expect.arrayContaining(['ipsa', 'time reset aqua', 'time', 'reset', 'aqua', '流金水']),
    );
  });

  test('reduces primary timeout after resolver miss only for targeted miss reasons', () => {
    expect(
      shouldReducePrimaryTimeoutAfterResolverMiss({
        result: { usableCount: 0, resolve_reason_code: 'no_candidates' },
        queryText: 'ipsa toner',
        hasPetSearchSignal: () => false,
        normalizeOffersResolveReasonCode: (value) => String(value || '').trim().toLowerCase(),
      }),
    ).toBe(true);

    expect(
      shouldReducePrimaryTimeoutAfterResolverMiss({
        result: { usableCount: 0, resolve_reason_code: 'db_timeout' },
        queryText: 'dog harness',
        hasPetSearchSignal: () => true,
        normalizeOffersResolveReasonCode: (value) => String(value || '').trim().toLowerCase(),
      }),
    ).toBe(false);
  });

  test('treats stable alias matches as strong resolver-first queries', () => {
    expect(
      isStrongResolverFirstQuery({
        queryText: 'ipsa 流金水',
        isKnownLookupAliasQuery: () => false,
        resolveStableAliasByQuery: ({ normalizedQuery }) =>
          normalizedQuery.includes('ipsa')
            ? { product_ref: { merchant_id: 'm1', product_id: 'p1' } }
            : null,
        buildResolverQueryCandidates: () => ['ipsa 流金水'],
        normalizeResolverText: (value) => String(value || '').trim().toLowerCase(),
        tokenizeResolverQuery: (value) => String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean),
      }),
    ).toBe(true);
  });

  test('returns uuid skip reason after resolver miss when fallback skip gate is enabled', () => {
    const reason = getSecondaryFallbackSkipReason({
      result: { usableCount: 0, resolve_reason_code: 'no_candidates' },
      queryText: '123e4567-e89b-12d3-a456-426614174000',
      proxySearchSkipSecondaryFallbackAfterResolverMiss: true,
      hasPetSearchSignal: () => false,
      hasFragranceQuerySignal: () => false,
      shouldReducePrimaryTimeoutAfterResolverMiss: () => true,
      isKnownLookupAliasQuery: () => false,
      extractSearchAnchorTokens: () => [],
      isLookupStyleSearchQuery: () => false,
      fpmGateSimplifyV1: false,
      fpmLookupOnlyResolver: false,
      isStrongResolverFirstQuery: () => false,
    });

    expect(reason).toBe('resolver_miss_uuid_like');
  });

  test('disables resolver-first for aurora when the aurora guard is enabled', () => {
    expect(
      shouldUseResolverFirstSearch({
        operation: 'find_products_multi',
        metadata: { source: 'aurora' },
        queryText: 'ipsa 流金水',
        proxySearchResolverFirstEnabled: true,
        fpmLatencyGuardResolverMinRemainingMs: 0,
        fpmGateSimplifyV1: false,
        extractSearchAnchorTokens: () => ['ipsa'],
        isLookupStyleSearchQuery: () => true,
        isStrongResolverFirstQuery: () => true,
        fpmLookupOnlyResolver: false,
        normalizeAgentSource: (value) => String(value || '').trim().toLowerCase(),
        isCreatorUiSource: () => false,
        isAuroraSource: (value) => value === 'aurora',
        proxySearchResolverFirstDisableAurora: true,
        isResolverFirstCatalogSource: () => false,
        proxySearchResolverFirstStrongOnly: false,
      }),
    ).toBe(false);
  });

  test('allows resolver-first for catalog sources when strong-only gating is satisfied', () => {
    expect(
      shouldUseResolverFirstSearch({
        operation: 'find_products',
        metadata: { source: 'catalog_assistant' },
        queryText: 'ipsa 流金水',
        proxySearchResolverFirstEnabled: true,
        fpmLatencyGuardResolverMinRemainingMs: 0,
        fpmGateSimplifyV1: false,
        extractSearchAnchorTokens: () => ['ipsa'],
        isLookupStyleSearchQuery: () => false,
        isStrongResolverFirstQuery: () => true,
        fpmLookupOnlyResolver: false,
        normalizeAgentSource: (value) => String(value || '').trim().toLowerCase(),
        isCreatorUiSource: () => false,
        isAuroraSource: () => false,
        proxySearchResolverFirstDisableAurora: false,
        isResolverFirstCatalogSource: (value) => value === 'catalog_assistant',
        proxySearchResolverFirstStrongOnly: true,
      }),
    ).toBe(true);
  });
});

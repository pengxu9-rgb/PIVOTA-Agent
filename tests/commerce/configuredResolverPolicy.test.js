const { createConfiguredResolverPolicy } = require('../../src/commerce/catalog/configuredResolverPolicy');

function buildPolicy(config = {}) {
  return createConfiguredResolverPolicy({
    hasPetSearchSignal: jest.fn(() => false),
    hasFragranceQuerySignal: jest.fn(() => false),
    normalizeOffersResolveReasonCode: (value) => String(value || '').trim().toLowerCase(),
    isKnownLookupAliasQuery: jest.fn(() => false),
    extractSearchAnchorTokens: jest.fn((query) =>
      String(query || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    ),
    isLookupStyleSearchQuery: jest.fn((query) => String(query || '').toLowerCase().includes('sku-123')),
    resolveStableAliasByQuery: jest.fn(() => null),
    buildResolverQueryCandidates: jest.fn((query) => [query]),
    normalizeResolverText: jest.fn((value) => String(value || '').trim().toLowerCase()),
    tokenizeResolverQuery: jest.fn((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    ),
    normalizeAgentSource: jest.fn((value) => String(value || '').trim().toLowerCase() || null),
    isCreatorUiSource: jest.fn((source) => source === 'creator_ui'),
    isAuroraSource: jest.fn((source) => source === 'aurora-bff'),
    isResolverFirstCatalogSource: jest.fn((source) => source === 'shopping_agent'),
    config,
  });
}

describe('configuredResolverPolicy', () => {
  test('respects configured allow flags for secondary, invoke, and resolver fallbacks', () => {
    const policy = buildPolicy({
      proxySearchSecondaryFallbackMultiEnabled: false,
      proxySearchInvokeFallbackEnabled: true,
      proxySearchResolverFallbackEnabled: false,
    });

    expect(policy.shouldAllowSecondaryFallback('find_products_multi')).toBe(false);
    expect(policy.shouldAllowSecondaryFallback('find_products_multi', { forceSecondaryFallback: true })).toBe(true);
    expect(policy.shouldAllowInvokeFallback('find_products_multi')).toBe(true);
    expect(policy.shouldAllowResolverFallback('find_products_multi')).toBe(false);
  });

  test('getSecondaryFallbackSkipReason honors configured skip-after-resolver-miss flag', () => {
    const enabledPolicy = buildPolicy({
      proxySearchSkipSecondaryFallbackAfterResolverMiss: true,
    });
    const disabledPolicy = buildPolicy({
      proxySearchSkipSecondaryFallbackAfterResolverMiss: false,
    });
    const resolverMiss = {
      usableCount: 0,
      resolve_reason_code: 'no_candidates',
      resolve_sources: [{ ok: false }],
    };

    expect(enabledPolicy.getSecondaryFallbackSkipReason(resolverMiss, 'hair serum')).toBe(
      'resolver_miss_skip_secondary',
    );
    expect(disabledPolicy.getSecondaryFallbackSkipReason(resolverMiss, 'hair serum')).toBeNull();
  });

  test('shouldUseResolverFirstSearch respects configured aurora disable and strong-only rules', () => {
    const auroraDisabledPolicy = buildPolicy({
      proxySearchResolverFirstEnabled: true,
      proxySearchResolverFirstDisableAurora: true,
      proxySearchResolverFirstStrongOnly: false,
      fpmLatencyGuardResolverMinRemainingMs: 50,
    });
    const strongOnlyPolicy = buildPolicy({
      proxySearchResolverFirstEnabled: true,
      proxySearchResolverFirstDisableAurora: false,
      proxySearchResolverFirstStrongOnly: true,
      fpmLatencyGuardResolverMinRemainingMs: 50,
    });

    expect(
      auroraDisabledPolicy.shouldUseResolverFirstSearch({
        operation: 'find_products_multi',
        metadata: { source: 'aurora-bff' },
        queryText: 'sku-123 lipstick',
        remainingBudgetMs: 500,
      }),
    ).toBe(false);

    expect(
      strongOnlyPolicy.shouldUseResolverFirstSearch({
        operation: 'find_products_multi',
        metadata: { source: 'shopping_agent' },
        queryText: 'broad category search',
        remainingBudgetMs: 500,
      }),
    ).toBe(false);

    expect(
      strongOnlyPolicy.shouldUseResolverFirstSearch({
        operation: 'find_products_multi',
        metadata: { source: 'shopping_agent' },
        queryText: 'sku-123 lipstick',
        remainingBudgetMs: 500,
      }),
    ).toBe(true);
  });
});

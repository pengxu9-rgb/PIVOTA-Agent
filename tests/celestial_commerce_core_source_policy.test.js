const {
  normalizeExternalSeedStrategy,
  stripExternalSeedStrategyOverride,
  applyFindProductsMultiSourceContract,
  createSourcePolicyRuntime,
} = require('../src/modules/policy/sourcePolicy');

describe('Celestial commerce core source policy module', () => {
  test('normalizes external seed strategies and strips overrides', () => {
    expect(normalizeExternalSeedStrategy('supplement_internal_first')).toBe('unified_relevance');
    expect(normalizeExternalSeedStrategy('legacy')).toBe('legacy');
    expect(normalizeExternalSeedStrategy('unknown', 'legacy')).toBe('legacy');

    expect(
      stripExternalSeedStrategyOverride({
        query: 'serum',
        external_seed_strategy: 'unified_relevance',
        externalSeedStrategy: 'legacy',
      }),
    ).toEqual({
      query: 'serum',
    });
  });

  test('runtime binds source policy for public, shopping, and aurora ingress', () => {
    const runtime = createSourcePolicyRuntime({
      pivotaApiBase: 'http://pivota.test',
      auroraApiBase: 'http://aurora.test',
      forceAuroraFastMode: true,
      auroraAllowExternalSeed: true,
      auroraExternalSeedStrategy: 'unified_relevance',
    });

    expect(runtime.normalizeAgentSource('shopping agent ui')).toBe('shopping-agent-ui');
    expect(runtime.isShoppingSource('shopping_agent')).toBe(true);
    expect(runtime.isCreatorUiSource('creator_agent_ui')).toBe(true);
    expect(runtime.isCatalogGuardSource('aurora-bff')).toBe(true);
    expect(runtime.isResolverFirstCatalogSource('creator-agent')).toBe(true);
    expect(runtime.getProxySearchApiBase('aurora-bff')).toBe('http://aurora.test');
    expect(runtime.getProxySearchApiBase('search')).toBe('http://pivota.test');

    expect(runtime.getAuroraFallbackOverrides('aurora-bff', 'find_products_multi')).toEqual({
      active: true,
      strategySource: 'aurora_force_path',
      disableSkipAfterResolverMiss: false,
      forceSecondaryFallback: false,
      forceInvokeFallback: false,
    });

    expect(
      runtime.applyShoppingCatalogQueryGuards(
        {
          query: 'serum',
          external_seed_strategy: 'unified_relevance',
        },
        'search',
      ),
    ).toEqual({
      query: 'serum',
      external_seed_strategy: 'unified_relevance',
    });

    expect(
      runtime.applyShoppingCatalogQueryGuards(
        {
          query: 'serum',
          external_seed_strategy: 'unified_relevance',
        },
        'shopping_agent',
      ),
    ).toMatchObject({
      query: 'serum',
      allow_external_seed: true,
      allow_stale_cache: false,
      external_seed_strategy: 'unified_relevance',
      fast_mode: true,
    });

    expect(
      runtime.applyShoppingCatalogQueryGuards(
        {
          query: 'serum',
        },
        'aurora-bff',
      ),
    ).toMatchObject({
      query: 'serum',
      allow_external_seed: true,
      allow_stale_cache: false,
      external_seed_strategy: 'unified_relevance',
      fast_mode: true,
    });
  });

  test('find_products_multi source contract preserves public search overrides', () => {
    const payload = {
      search: {
        query: 'serum',
        external_seed_strategy: 'unified_relevance',
      },
    };

    expect(
      applyFindProductsMultiSourceContract(payload, { source: 'search' }, 'find_products_multi'),
    ).toEqual({
      search: {
        query: 'serum',
        external_seed_strategy: 'unified_relevance',
      },
    });

    expect(
      applyFindProductsMultiSourceContract(payload, { source: 'shopping_agent' }, 'find_products_multi'),
    ).toEqual(payload);
  });
});

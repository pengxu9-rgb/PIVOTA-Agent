const {
  createSearchGuardHelpers,
} = require('../../src/commerce/catalog/searchGuards');

describe('searchGuards', () => {
  test('applies catalog guard defaults for shopping sources', () => {
    const guards = createSearchGuardHelpers({
      pivotaApiBase: 'http://pivota.test',
      proxySearchAuroraApiBase: 'http://aurora.test',
      proxySearchAuroraAllowExternalSeed: false,
      proxySearchAuroraExternalSeedStrategy: 'supplement_internal_first',
      proxySearchAuroraForceFastMode: true,
    });

    expect(
      guards.applyShoppingCatalogQueryGuards(
        { query: 'serum', commerce_surface: 'agent_api' },
        'shopping-agent-ui',
      ),
    ).toMatchObject({
      allow_external_seed: false,
      allow_stale_cache: false,
      external_seed_strategy: 'legacy',
      fast_mode: true,
    });
  });

  test('uses aurora-specific search base and fallback overrides for aurora FPM', () => {
    const guards = createSearchGuardHelpers({
      pivotaApiBase: 'http://pivota.test',
      proxySearchAuroraApiBase: 'http://aurora.test',
      proxySearchAuroraDisableSkipAfterResolverMiss: true,
      proxySearchAuroraForceSecondaryFallback: true,
      proxySearchAuroraForceInvokeFallback: true,
    });

    expect(guards.getProxySearchApiBase('aurora-bff')).toBe('http://aurora.test');
    expect(guards.getAuroraFallbackOverrides('aurora-bff', 'find_products_multi')).toEqual({
      active: true,
      strategySource: 'aurora_force_path',
      disableSkipAfterResolverMiss: true,
      forceSecondaryFallback: true,
      forceInvokeFallback: true,
    });
  });
});

const SEARCH_PROFILE_IDS = Object.freeze({
  FRAGRANCE_STRICT: 'fragrance_strict',
  BRAND_BROAD: 'brand_broad',
  LINGERIE_STRICT: 'lingerie_strict',
  PET_SUPPLIES: 'pet_supplies',
  BEAUTY_GENERAL: 'beauty_general',
  GENERAL: 'general',
});

const SEARCH_PROFILE_MAP = Object.freeze({
  [SEARCH_PROFILE_IDS.FRAGRANCE_STRICT]: Object.freeze({
    id: SEARCH_PROFILE_IDS.FRAGRANCE_STRICT,
    intentSignals: ['fragrance', 'perfume', 'brand_alias'],
    ambiguityPolicy: 'search_first',
    supplementPolicy: Object.freeze({
      externalParticipation: 'always',
      queryVariants: 'fragrance_variants',
      allowBrandExpansion: 'query_contains_brand_only',
      defaultSeedStrategy: 'unified_relevance',
    }),
    filterPolicy: Object.freeze({
      mode: 'strict_allow_block',
      allowVerticals: ['fragrance'],
      blockedVerticals: ['beauty_tools', 'makeup_tools', 'appliance'],
    }),
    rankingPolicy: Object.freeze({
      boost: ['fragrance_signal', 'brand_match'],
      penalty: ['tool_signal'],
    }),
    budgetPolicy: Object.freeze({
      cacheStageBudgetMs: 2600,
      externalSeedTimeoutSeconds: 0.8,
      secondaryStageEnabled: true,
    }),
  }),
  [SEARCH_PROFILE_IDS.BRAND_BROAD]: Object.freeze({
    id: SEARCH_PROFILE_IDS.BRAND_BROAD,
    intentSignals: ['brand_query'],
    ambiguityPolicy: 'search_first',
    supplementPolicy: Object.freeze({
      externalParticipation: 'always',
      queryVariants: 'brand_variants',
      allowBrandExpansion: 'query_contains_brand_only',
      defaultSeedStrategy: 'unified_relevance',
    }),
    filterPolicy: Object.freeze({
      mode: 'balanced',
      allowVerticals: ['all'],
      blockedVerticals: ['beauty_tools', 'makeup_tools'],
    }),
    rankingPolicy: Object.freeze({
      boost: ['brand_match', 'semantic_relevance'],
      penalty: ['tool_signal'],
    }),
    budgetPolicy: Object.freeze({
      cacheStageBudgetMs: 2400,
      externalSeedTimeoutSeconds: 0.8,
      secondaryStageEnabled: true,
    }),
  }),
  [SEARCH_PROFILE_IDS.LINGERIE_STRICT]: Object.freeze({
    id: SEARCH_PROFILE_IDS.LINGERIE_STRICT,
    intentSignals: ['lingerie', 'underwear', 'intimates'],
    ambiguityPolicy: 'search_first',
    supplementPolicy: Object.freeze({
      externalParticipation: 'always',
      queryVariants: 'lingerie_variants',
      allowBrandExpansion: 'never',
      defaultSeedStrategy: 'unified_relevance',
    }),
    filterPolicy: Object.freeze({
      mode: 'strict_allow_block',
      allowVerticals: ['lingerie', 'underwear', 'intimates'],
      blockedVerticals: ['beauty_tools', 'toys', 'appliance'],
    }),
    rankingPolicy: Object.freeze({
      boost: ['lingerie_signal'],
      penalty: ['cross_vertical'],
    }),
    budgetPolicy: Object.freeze({
      cacheStageBudgetMs: 2600,
      externalSeedTimeoutSeconds: 0.35,
      secondaryStageEnabled: true,
    }),
  }),
  [SEARCH_PROFILE_IDS.PET_SUPPLIES]: Object.freeze({
    id: SEARCH_PROFILE_IDS.PET_SUPPLIES,
    intentSignals: ['pet', 'dog', 'cat'],
    ambiguityPolicy: 'clarify_first',
    supplementPolicy: Object.freeze({
      externalParticipation: 'when_relevant',
      queryVariants: 'pet_variants',
      allowBrandExpansion: 'never',
      defaultSeedStrategy: 'unified_relevance',
    }),
    filterPolicy: Object.freeze({
      mode: 'balanced',
      allowVerticals: ['pet'],
      blockedVerticals: ['beauty_tools'],
    }),
    rankingPolicy: Object.freeze({
      boost: ['pet_signal'],
      penalty: ['cross_vertical'],
    }),
    budgetPolicy: Object.freeze({
      cacheStageBudgetMs: 2200,
      externalSeedTimeoutSeconds: 0.35,
      secondaryStageEnabled: true,
    }),
  }),
  [SEARCH_PROFILE_IDS.BEAUTY_GENERAL]: Object.freeze({
    id: SEARCH_PROFILE_IDS.BEAUTY_GENERAL,
    intentSignals: ['beauty', 'skincare', 'makeup'],
    ambiguityPolicy: 'clarify_first',
    supplementPolicy: Object.freeze({
      externalParticipation: 'when_relevant',
      queryVariants: 'beauty_variants',
      allowBrandExpansion: 'never',
      defaultSeedStrategy: 'unified_relevance',
    }),
    filterPolicy: Object.freeze({
      mode: 'balanced',
      allowVerticals: ['beauty', 'skincare', 'makeup'],
      blockedVerticals: ['pet', 'appliance'],
    }),
    rankingPolicy: Object.freeze({
      boost: ['beauty_signal'],
      penalty: ['cross_vertical'],
    }),
    budgetPolicy: Object.freeze({
      cacheStageBudgetMs: 2200,
      externalSeedTimeoutSeconds: 0.35,
      secondaryStageEnabled: true,
    }),
  }),
  [SEARCH_PROFILE_IDS.GENERAL]: Object.freeze({
    id: SEARCH_PROFILE_IDS.GENERAL,
    intentSignals: ['default'],
    ambiguityPolicy: 'clarify_first',
    supplementPolicy: Object.freeze({
      externalParticipation: 'when_relevant',
      queryVariants: 'default',
      allowBrandExpansion: 'never',
      defaultSeedStrategy: 'unified_relevance',
    }),
    filterPolicy: Object.freeze({
      mode: 'balanced',
      allowVerticals: ['all'],
      blockedVerticals: [],
    }),
    rankingPolicy: Object.freeze({
      boost: ['semantic_relevance'],
      penalty: [],
    }),
    budgetPolicy: Object.freeze({
      cacheStageBudgetMs: 2000,
      externalSeedTimeoutSeconds: 0.35,
      secondaryStageEnabled: true,
    }),
  }),
});

module.exports = {
  SEARCH_PROFILE_IDS,
  SEARCH_PROFILE_MAP,
};

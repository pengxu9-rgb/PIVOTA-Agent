const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFindProductsInvokeSemanticOwnerRuntime,
} = require('../src/findProductsInvokeSemanticOwner');

function normalizeRecoTargetStep(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('sunscreen') || normalized.includes('spf') || normalized.includes('uv')) return 'sunscreen';
  if (
    normalized.includes('moisturizer') ||
    normalized.includes('moisturiser') ||
    normalized.includes('cream') ||
    normalized.includes('lotion')
  ) {
    return 'moisturizer';
  }
  return 'treatment';
}

test('prepareInvokeSemanticOwnerContext builds role-aware support query pack from the shared support-role contract', () => {
  const runtime = createFindProductsInvokeSemanticOwnerRuntime({
    normalizeAgentSource: (value) => String(value || '').trim().toLowerCase(),
    normalizeRecoTargetStep,
    firstQueryParamValue: (value) => (Array.isArray(value) ? value[0] : value),
    buildBeautyFamilySupplementQueries: () => [],
    normalizeSearchTextForMatch: (value) => String(value || '').trim().toLowerCase(),
    detectBeautyQueryBucket: () => 'skincare',
    normalizeSearchUiSurface: (value) => value,
    normalizeRecommendationDecisionMode: (value) => value,
    resolveGuidanceSearchStepStrength: () => '',
    shouldUseSharedTargetRelevancePipeline: () => true,
    buildBeautySkincareHitQualityDecision: () => ({
      hit_quality: 'valid_hit',
      ranked_products: [],
      exact_step_topk_count: 0,
      strong_goal_family_topk_count: 0,
      supportive_same_family_topk_count: 0,
      same_family_topk_count: 0,
      raw_result_count: 0,
    }),
    summarizeSharedCandidateSources: () => ({
      source_tier_counts: {},
      source_quality_counts: {},
      top_candidate_provenance: {},
    }),
    scoreSharedBeautyCandidateForTarget: () => ({ score: 1 }),
    BEAUTY_DISCOVERY_MAINLINE_OWNER: 'shopping_agent_beauty_mainline',
  });

  const { prepareInvokeSemanticOwnerContext } = runtime;
  const context = prepareInvokeSemanticOwnerContext({
    operation: 'find_products_multi',
    semanticOwnerControlled: true,
    strictFindProductsMultiDecision: null,
    metadata: { source: 'search' },
    traceQueryClass: 'beauty_generic',
    rawUserQuery: 'im oily skin. what product should i buy?',
    semanticRewriteResultMeta: {
      normalized_query_pack: ['niacinamide serum oily skin'],
    },
    semanticContractMeta: {
      target_step_family: 'treatment',
      semantic_family: 'oil_control',
      support_role_ids: ['lightweight_moisturizer', 'daily_sunscreen'],
      framework_roles: [
        {
          role_id: 'lightweight_moisturizer',
          label: 'Lightweight moisturizer',
          preferred_step: 'moisturizer',
          query_terms: ['lightweight moisturizer', 'gel cream', 'oil free moisturizer'],
          fit_keywords: ['lightweight', 'gel cream', 'breathable', 'oil-free'],
        },
        {
          role_id: 'daily_sunscreen',
          label: 'Daily sunscreen',
          preferred_step: 'sunscreen',
          query_terms: ['daily sunscreen', 'lightweight sunscreen', 'spf fluid'],
          fit_keywords: ['lightweight', 'non-greasy', 'uv filters'],
        },
      ],
    },
    queryParams: {},
    effectivePayload: { search: {} },
  });

  assert.deepEqual(
    context.semanticOwnerSupportRoleQueryPack,
    [
      'lightweight moisturizer oily skin',
      'oil free moisturizer',
      'oil control sunscreen',
      'lightweight sunscreen oily skin',
    ],
  );
});

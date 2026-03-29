const {
  collectFamilies,
  fixtureHasFamilyAliases,
  evaluateReadinessScorecard,
} = require('../scripts/lib/commerce_readiness_scorecard');

describe('Commerce readiness scorecard', () => {
  test('collects family tokens recursively across shared corpora', () => {
    expect(
      Array.from(
        collectFamilies({
          prompt_cases: [{ family: 'prompt_clarify' }],
          nested: {
            semantic_cases: [{ family: 'merchant_query' }],
          },
        }),
      ).sort(),
    ).toEqual(['merchant_query', 'prompt_clarify']);
  });

  test('accepts alias families in shared corpus checks', () => {
    expect(
      fixtureHasFamilyAliases(
        {
          semantic_cases: [
            { family: 'merchant_product_split' },
            { family: 'strict_consistency' },
          ],
        },
        ['merchant_query', 'strict_ingredient'],
      ),
    ).toBe(true);
  });

  test('marks all amber dimensions green once live coverage, shared corpus, and provenance truth exist', () => {
    const result = evaluateReadinessScorecard({
      publicLocalStatus: 'pass',
      shoppingLocalStatus: 'pass',
      auroraLocalStatus: 'pass',
      gatewayGovernanceLocalStatus: 'pass',
      prodSmokeStatus: 'pass',
      promptLiveSmokeStatus: 'pass',
      gatewayGovernanceExtractStatus: 'missing',
      gatewayGovernanceReportStatus: 'pass',
      gatewayGovernanceReadinessStatus: 'green',
      publicGatewayAuthRequired: false,
      agentProdCommit: 'abc123',
      backendProdCommit: 'def456',
      promptCases: {
        prompt_cases: [
          { family: 'prompt_clarify' },
          { family: 'conversation_progress_resume' },
        ],
      },
      prodGateCases: [
        { family: 'merchant_query' },
        { family: 'exact_product_lookup' },
        { family: 'exactish_lookup' },
        { family: 'strict_ingredient' },
        { family: 'scenario_clarify' },
      ],
      stagingCases: {
        semantic_cases: [
          { family: 'merchant_query' },
          { family: 'exact_product_lookup' },
          { family: 'exactish_lookup' },
          { family: 'scenario_clarify' },
          { family: 'aurora_guidance_cache_hit' },
          { family: 'aurora_guidance_cache_miss' },
          { family: 'aurora_guidance_direct_supplement' },
        ],
      },
    });

    expect(result.prompt_fixture_complete).toBe(true);
    expect(result.live_query_corpus_complete).toBe(true);
    expect(result.staging_semantic_corpus_complete).toBe(true);
    expect(result.shared_query_corpus_complete).toBe(true);
    expect(result.scorecard).toEqual({
      prompt_intent: 'green',
      query_decomposition: 'green',
      commerce_search_contract: 'green',
      merchant_product_routing: 'green',
      fallback_resilience: 'green',
      gateway_invocation_access_governance: 'green',
      observability_provenance: 'green',
      cross_layer_contract_drift: 'green',
    });
  });

  test('holds routing and fallback dimensions at amber when shared corpus is incomplete', () => {
    const result = evaluateReadinessScorecard({
      publicLocalStatus: 'pass',
      shoppingLocalStatus: 'pass',
      auroraLocalStatus: 'pass',
      gatewayGovernanceLocalStatus: 'pass',
      prodSmokeStatus: 'pass',
      promptLiveSmokeStatus: 'pass',
      gatewayGovernanceExtractStatus: 'missing',
      gatewayGovernanceReportStatus: 'pass',
      gatewayGovernanceReadinessStatus: 'green',
      publicGatewayAuthRequired: false,
      agentProdCommit: 'abc123',
      backendProdCommit: '',
      gatewayGovernanceLogInputPath: '/tmp/runtime.ndjson',
      promptCases: {
        prompt_cases: [
          { family: 'prompt_clarify' },
          { family: 'conversation_progress_resume' },
        ],
      },
      prodGateCases: [
        { family: 'merchant_query' },
        { family: 'exact_product_lookup' },
      ],
      stagingCases: {
        semantic_cases: [{ family: 'aurora_guidance_cache_hit' }],
      },
    });

    expect(result.prompt_fixture_complete).toBe(true);
    expect(result.live_query_corpus_complete).toBe(false);
    expect(result.staging_semantic_corpus_complete).toBe(false);
    expect(result.shared_query_corpus_complete).toBe(false);
    expect(result.scorecard.prompt_intent).toBe('green');
    expect(result.scorecard.query_decomposition).toBe('amber');
    expect(result.scorecard.merchant_product_routing).toBe('amber');
    expect(result.scorecard.fallback_resilience).toBe('amber');
    expect(result.scorecard.cross_layer_contract_drift).toBe('amber');
    expect(result.scorecard.observability_provenance).toBe('green');
  });

  test('keeps live-routing dimensions amber until exactish coverage enters the prod corpus', () => {
    const result = evaluateReadinessScorecard({
      publicLocalStatus: 'pass',
      shoppingLocalStatus: 'pass',
      auroraLocalStatus: 'pass',
      gatewayGovernanceLocalStatus: 'pass',
      prodSmokeStatus: 'pass',
      promptLiveSmokeStatus: 'pass',
      gatewayGovernanceExtractStatus: 'pass',
      gatewayGovernanceReportStatus: 'pass',
      gatewayGovernanceReadinessStatus: 'green',
      publicGatewayAuthRequired: false,
      agentProdCommit: 'abc123',
      backendProdCommit: 'def456',
      promptCases: {
        prompt_cases: [
          { family: 'prompt_clarify' },
          { family: 'conversation_progress_resume' },
        ],
      },
      prodGateCases: [
        { family: 'merchant_query' },
        { family: 'exact_product_lookup' },
        { family: 'strict_ingredient' },
        { family: 'scenario_clarify' },
      ],
      stagingCases: {
        semantic_cases: [
          { family: 'merchant_query' },
          { family: 'exact_product_lookup' },
          { family: 'exactish_lookup' },
          { family: 'scenario_clarify' },
          { family: 'aurora_guidance_cache_hit' },
          { family: 'aurora_guidance_cache_miss' },
          { family: 'aurora_guidance_direct_supplement' },
        ],
      },
    });

    expect(result.live_query_corpus_complete).toBe(false);
    expect(result.staging_semantic_corpus_complete).toBe(true);
    expect(result.shared_query_corpus_complete).toBe(false);
    expect(result.scorecard.query_decomposition).toBe('amber');
    expect(result.scorecard.merchant_product_routing).toBe('amber');
    expect(result.scorecard.fallback_resilience).toBe('amber');
    expect(result.scorecard.cross_layer_contract_drift).toBe('amber');
  });
});

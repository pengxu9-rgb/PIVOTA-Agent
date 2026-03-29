const { normalizeAcceptanceFamily } = require('./commerce_acceptance_family');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectFamilies(payload, out = new Set()) {
  if (Array.isArray(payload)) {
    for (const item of payload) collectFamilies(item, out);
    return out;
  }

  if (!isPlainObject(payload)) return out;

  const family = normalizeAcceptanceFamily(payload.family);
  if (family) out.add(family);

  for (const value of Object.values(payload)) {
    collectFamilies(value, out);
  }
  return out;
}

function normalizeAliasGroups(aliasGroups = []) {
  return aliasGroups.map((group) =>
    Array.from(
      new Set(
        (Array.isArray(group)
          ? group
          : String(group || '')
              .split('|')
              .map((item) => item.trim())
              .filter(Boolean)
        )
          .map((item) => normalizeAcceptanceFamily(item))
          .filter(Boolean),
      ),
    ),
  );
}

function fixtureHasFamilyAliases(payload, aliasGroups = []) {
  const families = collectFamilies(payload);
  const groups = normalizeAliasGroups(aliasGroups);
  return groups.every((aliases) => aliases.some((alias) => families.has(alias)));
}

function evaluateReadinessScorecard(input = {}) {
  const publicLocalStatus = String(input.publicLocalStatus || '').trim() || 'missing';
  const shoppingLocalStatus = String(input.shoppingLocalStatus || '').trim() || 'missing';
  const auroraLocalStatus = String(input.auroraLocalStatus || '').trim() || 'missing';
  const gatewayGovernanceLocalStatus =
    String(input.gatewayGovernanceLocalStatus || '').trim() || 'missing';
  const prodSmokeStatus = String(input.prodSmokeStatus || '').trim() || 'missing';
  const promptLiveSmokeStatus = String(input.promptLiveSmokeStatus || '').trim() || 'missing';
  const gatewayGovernanceExtractStatus =
    String(input.gatewayGovernanceExtractStatus || '').trim() || 'missing';
  const gatewayGovernanceReportStatus =
    String(input.gatewayGovernanceReportStatus || '').trim() || 'missing';
  const gatewayGovernanceReadinessStatus =
    String(input.gatewayGovernanceReadinessStatus || '').trim() || '';
  const publicGatewayAuthRequired = input.publicGatewayAuthRequired === true;
  const agentProdCommit = String(input.agentProdCommit || '').trim();
  const authoritativeProdCommit = String(input.authoritativeProdCommit || '').trim();
  const gatewayGovernanceLogInputPath = String(input.gatewayGovernanceLogInputPath || '').trim();
  const gatewayGovernanceAutomationStatus =
    String(input.gatewayGovernanceAutomationStatus || '').trim() || 'missing';
  const gatewayGovernanceLogInputAutomated = input.gatewayGovernanceLogInputAutomated === true;

  const promptFixtureComplete = fixtureHasFamilyAliases(input.promptCases, [
    'prompt_clarify',
    'conversation_progress_resume',
  ]);
  const liveQueryCorpusComplete = fixtureHasFamilyAliases(input.prodGateCases, [
    'merchant_query',
    'exact_product_lookup',
    'exactish_lookup',
    'strict_ingredient',
    'scenario_clarify',
  ]);
  const stagingSemanticCorpusComplete = fixtureHasFamilyAliases(input.stagingCases, [
    'merchant_query',
    'exact_product_lookup',
    'exactish_lookup',
    'scenario_clarify',
    'aurora_guidance_cache_hit',
    'aurora_guidance_cache_miss',
    'aurora_guidance_direct_supplement',
  ]);
  const sharedQueryCorpusComplete = liveQueryCorpusComplete && stagingSemanticCorpusComplete;

  let promptIntent = 'red';
  let queryDecomposition = 'red';
  let commerceSearchContract = 'red';
  let merchantProductRouting = 'red';
  let fallbackResilience = 'red';
  let gatewayInvocationAccessGovernance = 'red';
  let observabilityProvenance = 'amber';
  let crossLayerContractDrift = 'red';

  if (shoppingLocalStatus === 'pass') {
    promptIntent = 'amber';
    queryDecomposition = 'amber';
  }

  if (publicLocalStatus === 'pass' && prodSmokeStatus === 'pass') {
    commerceSearchContract = 'green';
  }

  if (
    shoppingLocalStatus === 'pass' &&
    promptLiveSmokeStatus === 'pass' &&
    promptFixtureComplete
  ) {
    promptIntent = 'green';
  }

  if (
    promptLiveSmokeStatus === 'pass' &&
    prodSmokeStatus === 'pass' &&
    liveQueryCorpusComplete
  ) {
    queryDecomposition = 'green';
  }

  if (
    auroraLocalStatus === 'pass' &&
    prodSmokeStatus === 'pass' &&
    liveQueryCorpusComplete
  ) {
    merchantProductRouting = 'green';
  } else if (
    auroraLocalStatus === 'pass' &&
    (prodSmokeStatus === 'pass' || publicGatewayAuthRequired)
  ) {
    merchantProductRouting = 'amber';
  }

  if (
    shoppingLocalStatus === 'pass' &&
    auroraLocalStatus === 'pass' &&
    prodSmokeStatus === 'pass' &&
    liveQueryCorpusComplete
  ) {
    fallbackResilience = 'green';
  } else if (
    shoppingLocalStatus === 'pass' &&
    auroraLocalStatus === 'pass' &&
    (prodSmokeStatus === 'pass' || publicGatewayAuthRequired)
  ) {
    fallbackResilience = 'amber';
  }

  if (
    shoppingLocalStatus === 'pass' &&
    auroraLocalStatus === 'pass' &&
    prodSmokeStatus === 'pass' &&
    sharedQueryCorpusComplete
  ) {
    crossLayerContractDrift = 'green';
  } else if (
    shoppingLocalStatus === 'pass' &&
    auroraLocalStatus === 'pass' &&
    (prodSmokeStatus === 'pass' || publicGatewayAuthRequired)
  ) {
    crossLayerContractDrift = 'amber';
  }

  if (
    gatewayGovernanceLocalStatus === 'pass' &&
    gatewayGovernanceReportStatus === 'pass'
  ) {
    gatewayInvocationAccessGovernance = gatewayGovernanceReadinessStatus || 'amber';
  }

  if (
    (authoritativeProdCommit || agentProdCommit) &&
    gatewayGovernanceReportStatus === 'pass' &&
    gatewayGovernanceExtractStatus === 'pass' &&
    (gatewayGovernanceAutomationStatus === 'pass' ||
      (gatewayGovernanceLogInputAutomated && Boolean(gatewayGovernanceLogInputPath)))
  ) {
    observabilityProvenance = 'green';
  }

  return {
    prompt_fixture_complete: promptFixtureComplete,
    live_query_corpus_complete: liveQueryCorpusComplete,
    staging_semantic_corpus_complete: stagingSemanticCorpusComplete,
    shared_query_corpus_complete: sharedQueryCorpusComplete,
    scorecard: {
      prompt_intent: promptIntent,
      query_decomposition: queryDecomposition,
      commerce_search_contract: commerceSearchContract,
      merchant_product_routing: merchantProductRouting,
      fallback_resilience: fallbackResilience,
      gateway_invocation_access_governance: gatewayInvocationAccessGovernance,
      observability_provenance: observabilityProvenance,
      cross_layer_contract_drift: crossLayerContractDrift,
    },
  };
}

module.exports = {
  collectFamilies,
  fixtureHasFamilyAliases,
  evaluateReadinessScorecard,
};

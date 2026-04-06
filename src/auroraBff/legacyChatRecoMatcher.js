function createLegacyChatRecoMatcherRuntime(deps = {}) {
  const {
    buildIngredientPlan,
    buildProductRecommendationsBundle,
    toLegacyRecommendationsPayload,
  } = deps;

  function computeLegacyRecoMatcher({
    latestArtifact = null,
    mappedIngredientPlan = null,
    profile = null,
    language = 'EN',
    logger = null,
    requestId = null,
    productMatcherEnabled = false,
    productMatcherBundledSeedFallbackEnabled = false,
    diagProductCatalogPath = '',
  } = {}) {
    if (!(productMatcherEnabled && latestArtifact)) {
      return {
        matcherBundle: null,
        matcherPayload: null,
        mappedIngredientPlan,
      };
    }
    try {
      const artifactPayload = latestArtifact;
      const planForMatcher =
        mappedIngredientPlan ||
        buildIngredientPlan({ artifact: artifactPayload, profile: profile || {} });
      const allowBundledSeedCatalog =
        productMatcherBundledSeedFallbackEnabled && !diagProductCatalogPath;
      const matcherBundle = buildProductRecommendationsBundle({
        ingredientPlan: planForMatcher,
        artifact: artifactPayload,
        profile,
        language,
        disallowTreatment: false,
        catalogPath: diagProductCatalogPath,
        allowDefaultSeedCatalog: allowBundledSeedCatalog,
      });
      return {
        matcherBundle,
        matcherPayload: toLegacyRecommendationsPayload(matcherBundle, { language }),
        mappedIngredientPlan: mappedIngredientPlan || planForMatcher,
      };
    } catch (err) {
      logger?.warn(
        { err: err && err.message ? err.message : String(err), request_id: requestId },
        'aurora bff: product matcher failed',
      );
      return {
        matcherBundle: null,
        matcherPayload: null,
        mappedIngredientPlan,
      };
    }
  }

  return {
    computeLegacyRecoMatcher,
  };
}

module.exports = {
  createLegacyChatRecoMatcherRuntime,
};

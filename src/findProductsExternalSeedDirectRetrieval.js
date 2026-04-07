const {
  buildExternalSeedRecallLikePredicate,
  classifyExternalSeedRecallMatchSource,
} = require('./services/externalSeedRecall');

async function retrieveExternalSeedDirectCandidates({
  retrievalQueries = [],
  relevanceQueryText = '',
  queryTokens = [],
  ingredientIntent = false,
  market = 'US',
  tool = '*',
  inStockOnly = false,
  useLeanGuidanceSql = false,
  safeLimit = 20,
  guidanceOnlyDiscovery = false,
  targetStepFamily = null,
  deps = {},
} = {}) {
  const {
    resolveGuidanceDirectExternalSeedRetrievalBudget,
    shouldRunExternalSeedExactTitleRecall,
    queryExternalSeedExactTitleRows,
    normalizeExactTitleLookupText,
    compactExactTitleLookupText,
    buildExternalSeedProduct,
    buildSearchProductKey,
    normalizeSearchTextForMatch,
    extractSearchAnchorTokens,
    tokenizeSearchTextForMatch,
    query,
  } = deps;

  const seen = new Set();
  const rawProducts = [];
  const variantQueryDebug = [];
  const retrievalBudget = resolveGuidanceDirectExternalSeedRetrievalBudget({
    safeLimit,
    guidanceOnlyDiscovery,
    targetStepFamily,
    retrievalQueryCount: retrievalQueries.length,
  });
  const perVariantLimit = retrievalBudget.per_variant_limit;
  const rawProductCap = retrievalBudget.raw_product_cap;
  const shouldRunExactTitleRecall = shouldRunExternalSeedExactTitleRecall({
    queryText: relevanceQueryText,
    queryTokens,
    ingredientIntent,
  });

  if (shouldRunExactTitleRecall) {
    const exactTitleStartedAt = Date.now();
    try {
      const exactTitleRows = await queryExternalSeedExactTitleRows({
        market,
        tool,
        normalizedQuery: normalizeExactTitleLookupText(relevanceQueryText),
        compactNormalizedQuery: compactExactTitleLookupText(relevanceQueryText),
        inStockOnly,
        limit: Math.min(perVariantLimit, 24),
      });
      variantQueryDebug.push({
        query: relevanceQueryText,
        pattern_count: 1,
        row_count: exactTitleRows.length,
        duration_ms: Date.now() - exactTitleStartedAt,
        exact_title_recall: true,
        lean_sql_applied: false,
        match_source_hint: 'exact_title',
      });
      for (const row of exactTitleRows) {
        const product = buildExternalSeedProduct(row, { matchSource: 'exact_title' });
        if (!product) continue;
        const key = buildSearchProductKey(product);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rawProducts.push(product);
        if (rawProducts.length >= rawProductCap) break;
      }
    } catch (err) {
      variantQueryDebug.push({
        query: relevanceQueryText,
        pattern_count: 1,
        row_count: 0,
        duration_ms: Date.now() - exactTitleStartedAt,
        exact_title_recall: true,
        lean_sql_applied: false,
        error: err?.message || String(err),
      });
    }
  }

  const variantResults = await Promise.all(
    retrievalQueries.map(async (retrievalQuery) => {
      const variantStartedAt = Date.now();
      try {
        const variantNormalizedQuery = normalizeSearchTextForMatch(retrievalQuery);
        const variantAnchorTokens = extractSearchAnchorTokens(retrievalQuery);
        const variantQueryTokens = Array.from(new Set(tokenizeSearchTextForMatch(variantNormalizedQuery)));
        const variantSearchPatterns = Array.from(
          new Set(
            [...variantAnchorTokens, ...variantQueryTokens]
              .map((token) => `%${String(token || '').trim()}%`)
              .filter(Boolean),
          ),
        ).slice(0, 12);
        const sqlParams = [market, tool];
        const filters = [];

        if (variantSearchPatterns.length > 0) {
          sqlParams.push(variantSearchPatterns);
          const bind = `$${sqlParams.length}`;
          filters.push(
            buildExternalSeedRecallLikePredicate(bind, {
              includeLegacyFallback: useLeanGuidanceSql !== true,
            }),
          );
        }

        if (inStockOnly) {
          filters.push(
            `coalesce(lower(availability), '') NOT IN ('out of stock', 'out_of_stock', 'outofstock', 'oos')`,
          );
        }

        sqlParams.push(perVariantLimit);
        const limitBind = `$${sqlParams.length}`;
        const res = await query(
          `
            SELECT
              id,
              external_product_id,
              destination_url,
              canonical_url,
              domain,
              title,
              image_url,
              price_amount,
              price_currency,
              availability,
              seed_data,
              updated_at,
              created_at
            FROM external_product_seeds
            WHERE status = 'active'
              AND attached_product_key IS NULL
              AND market = $1
              AND (tool = '*' OR tool = $2)
              ${filters.length > 0 ? `AND ${filters.join('\n              AND ')}` : ''}
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
            LIMIT ${limitBind}
          `,
          sqlParams,
        );

        return {
          query: retrievalQuery,
          pattern_count: variantSearchPatterns.length,
          row_count: Array.isArray(res?.rows) ? res.rows.length : 0,
          duration_ms: Date.now() - variantStartedAt,
          lean_sql_applied: useLeanGuidanceSql,
          rows: Array.isArray(res?.rows) ? res.rows : [],
        };
      } catch (err) {
        return {
          query: retrievalQuery,
          pattern_count: 0,
          row_count: 0,
          duration_ms: Date.now() - variantStartedAt,
          lean_sql_applied: useLeanGuidanceSql,
          rows: [],
          error: err?.message || String(err),
        };
      }
    }),
  );

  for (const variantResult of variantResults) {
    variantQueryDebug.push({
      query: variantResult.query,
      pattern_count: variantResult.pattern_count,
      row_count: variantResult.row_count,
      duration_ms: variantResult.duration_ms,
      lean_sql_applied: variantResult.lean_sql_applied === true,
      match_source_hint:
        Array.isArray(variantResult.rows) && variantResult.rows[0]
          ? classifyExternalSeedRecallMatchSource(variantResult.rows[0], [variantResult.query])
          : 'none',
      ...(variantResult.error ? { error: variantResult.error } : {}),
    });
    for (const row of variantResult.rows || []) {
      const matchSource = classifyExternalSeedRecallMatchSource(row, [variantResult.query]);
      const product = buildExternalSeedProduct(row, { matchSource });
      if (!product) continue;
      const key = buildSearchProductKey(product);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rawProducts.push(product);
      if (rawProducts.length >= rawProductCap) break;
    }
    if (rawProducts.length >= rawProductCap) break;
  }

  return {
    rawProducts,
    variantQueryDebug,
    retrievalBudget,
    shouldRunExactTitleRecall,
  };
}

module.exports = {
  retrieveExternalSeedDirectCandidates,
};

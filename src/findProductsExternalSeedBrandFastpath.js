async function runExternalSeedBrandMainlineFastpath({
  relevanceQueryText = '',
  market = 'US',
  tool = '*',
  inStockOnly = false,
  safePage = 1,
  safeLimit = 20,
  safeOffset = 0,
  deps = {},
} = {}) {
  const {
    detectBrandEntities,
    normalizeSearchTextForMatch,
    buildBrandQueryVariants,
    buildExternalSeedProduct,
    buildSearchProductKey,
    query,
    logger,
  } = deps;

  const brandDetection = detectBrandEntities(relevanceQueryText, { candidateProducts: [] });
  const brandTerms = Array.from(
    new Set(
      (Array.isArray(brandDetection?.brands) ? brandDetection.brands : [])
        .map((value) => normalizeSearchTextForMatch(value))
        .filter(Boolean),
    ),
  );
  const queryVariants = Array.from(
    new Set(
      buildBrandQueryVariants(relevanceQueryText, brandTerms)
        .map((value) => normalizeSearchTextForMatch(value))
        .filter(Boolean),
    ),
  ).slice(0, 8);
  const queryPatterns = Array.from(new Set(queryVariants.map((value) => `%${value}%`).filter(Boolean))).slice(0, 12);
  const availabilityFilter = inStockOnly
    ? `AND coalesce(lower(availability), '') NOT IN ('out of stock', 'out_of_stock', 'outofstock', 'oos')`
    : '';

  const buildBrandFastpathResponse = ({
    rows,
    totalRows,
    strategyApplied,
    broadFallbackUsed = false,
    broadScopeRows = 0,
    retrievalDebug = [],
  }) => {
    const products = [];
    const seen = new Set();
    for (const row of rows) {
      const product = buildExternalSeedProduct(row);
      if (!product) continue;
      const key = buildSearchProductKey(product);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      products.push(product);
    }

    return {
      status: 'success',
      success: true,
      products,
      total: totalRows,
      page: safePage,
      page_size: products.length,
      reply: null,
      metadata: {
        query_source: 'agent_products_external_seed_direct',
        fetched_at: new Date().toISOString(),
        source_breakdown: {
          internal_count: 0,
          external_seed_count: Math.max(totalRows, products.length),
          stale_cache_used: false,
          strategy_applied: strategyApplied,
        },
        external_seed_only_requested: true,
        external_seed_rows_fetched: totalRows,
        external_seed_rows_built: Math.max(totalRows, products.length),
        external_seed_returned_count: products.length,
        raw_result_count: totalRows,
        brand_search_mainline_query: true,
        retrieval_query_variants: queryVariants,
        retrieval_query_variant_count: queryVariants.length,
        retrieval_query_debug: retrievalDebug,
        external_seed_brand_strict_rows:
          strategyApplied === 'brand_search_external_seed_mainline_exact' ? totalRows : 0,
        external_seed_brand_relevant_rows:
          strategyApplied === 'brand_search_external_seed_mainline_exact' ? totalRows : 0,
        external_seed_broad_fallback_used: broadFallbackUsed,
        external_seed_broad_scope_rows: broadScopeRows,
        search_decision: {
          brand_search_mainline_query: true,
          retrieval_query_variants: queryVariants,
          retrieval_query_variant_count: queryVariants.length,
          raw_result_count: totalRows,
          products_returned_count: products.length,
          final_decision: products.length > 0 ? 'products_returned' : 'empty',
        },
      },
    };
  };

  const exactSqlParams = [market, tool, brandTerms, safeLimit, safeOffset];

  try {
    const exactRes = await query(
      `
        WITH candidates AS (
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
            created_at,
            4 AS brand_match_rank
          FROM external_product_seeds
          WHERE status = 'active'
            AND attached_product_key IS NULL
            AND market = $1
            AND (tool = '*' OR tool = $2)
            ${availabilityFilter}
            AND (
              lower(coalesce(seed_data->>'brand', '')) = ANY($3::text[])
              OR lower(coalesce(seed_data->'snapshot'->>'brand', '')) = ANY($3::text[])
              OR lower(coalesce(seed_data->>'merchant_display_name', '')) = ANY($3::text[])
              OR lower(coalesce(seed_data->'snapshot'->>'merchant_display_name', '')) = ANY($3::text[])
              OR lower(coalesce(seed_data->>'vendor', '')) = ANY($3::text[])
              OR lower(coalesce(seed_data->'snapshot'->>'vendor', '')) = ANY($3::text[])
            )
        ),
        paged AS (
          SELECT
            *,
            COUNT(*) OVER() AS total_rows
          FROM candidates
          ORDER BY brand_match_rank DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT $4
          OFFSET $5
        )
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
          created_at,
          total_rows
        FROM paged
      `,
      exactSqlParams,
    );

    const exactRows = Array.isArray(exactRes?.rows) ? exactRes.rows : [];
    const exactTotalRows = Math.max(0, Number(exactRows[0]?.total_rows || exactRows.length) || 0);
    const exactCoverageEnd = safeOffset + exactRows.length;
    const exactPageCovered = exactRows.length > 0 && exactTotalRows >= exactCoverageEnd;
    if (exactPageCovered) {
      return buildBrandFastpathResponse({
        rows: exactRows,
        totalRows: exactTotalRows,
        strategyApplied: 'brand_search_external_seed_mainline_exact',
        broadFallbackUsed: false,
        broadScopeRows: 0,
        retrievalDebug: [
          {
            query: relevanceQueryText,
            pattern_count: 0,
            row_count: exactTotalRows,
            duration_ms: null,
            brand_fastpath: true,
            stage: 'brand_exact',
          },
        ],
      });
    }

    const broadSqlParams = [market, tool, brandTerms, queryPatterns, safeLimit, safeOffset];
    const broadRes = await query(
      `
        WITH candidates AS (
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
            created_at,
            CASE
              WHEN lower(coalesce(title, '')) LIKE ANY($4::text[]) THEN 3
              WHEN (
                lower(coalesce(domain, '')) LIKE ANY($4::text[])
                OR lower(coalesce(canonical_url, '')) LIKE ANY($4::text[])
                OR lower(coalesce(destination_url, '')) LIKE ANY($4::text[])
              ) THEN 2
              ELSE 1
            END AS brand_match_rank
          FROM external_product_seeds
          WHERE status = 'active'
            AND attached_product_key IS NULL
            AND market = $1
            AND (tool = '*' OR tool = $2)
            ${availabilityFilter}
            AND (
              lower(coalesce(title, '')) LIKE ANY($4::text[])
              OR lower(coalesce(domain, '')) LIKE ANY($4::text[])
              OR lower(coalesce(canonical_url, '')) LIKE ANY($4::text[])
              OR lower(coalesce(destination_url, '')) LIKE ANY($4::text[])
            )
        ),
        paged AS (
          SELECT
            *,
            COUNT(*) OVER() AS total_rows
          FROM candidates
          ORDER BY brand_match_rank DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT $5
          OFFSET $6
        )
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
          created_at,
          total_rows
        FROM paged
      `,
      broadSqlParams,
    );

    const broadRows = Array.isArray(broadRes?.rows) ? broadRes.rows : [];
    const broadTotalRows = Math.max(0, Number(broadRows[0]?.total_rows || broadRows.length) || 0);

    return buildBrandFastpathResponse({
      rows: broadRows,
      totalRows: Math.max(exactTotalRows, broadTotalRows),
      strategyApplied: 'brand_search_external_seed_mainline_broad',
      broadFallbackUsed: true,
      broadScopeRows: broadTotalRows,
      retrievalDebug: [
        {
          query: relevanceQueryText,
          pattern_count: 0,
          row_count: exactTotalRows,
          duration_ms: null,
          brand_fastpath: true,
          stage: 'brand_exact',
        },
        {
          query: relevanceQueryText,
          pattern_count: queryPatterns.length,
          row_count: broadTotalRows,
          duration_ms: null,
          brand_fastpath: true,
          stage: 'brand_broad',
        },
      ],
    });
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err), query: relevanceQueryText },
      'public brand external seed mainline fastpath failed',
    );
  }
  return null;
}

module.exports = {
  runExternalSeedBrandMainlineFastpath,
};

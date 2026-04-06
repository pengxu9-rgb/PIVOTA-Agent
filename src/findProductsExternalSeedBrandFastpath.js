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
    normalizeBrandText,
    buildExternalSeedBrandSearchProduct,
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
  const exactBrandCompactVariants = Array.from(
    new Set(
      buildBrandQueryVariants(relevanceQueryText, brandTerms)
        .map((value) => normalizeBrandText(value).replace(/\s+/g, ''))
        .filter(Boolean),
    ),
  ).slice(0, 8);
  const queryPatterns = Array.from(
    new Set(queryVariants.map((value) => `%${value}%`).filter(Boolean)),
  ).slice(0, 12);
  const brandToolValues = Array.from(
    new Set([tool, '*'].map((value) => String(value || '').trim()).filter(Boolean)),
  );
  const availabilityFilter = inStockOnly
    ? `AND coalesce(lower(availability), '') NOT IN ('out of stock', 'out_of_stock', 'outofstock', 'oos')`
    : '';
  const brandMatchExpr = `
    lower(
      regexp_replace(
        coalesce(
          seed_data->>'brand',
          seed_data->'snapshot'->>'brand',
          split_part(domain, '.', 1),
          ''
        ),
        '[^a-z0-9]+',
        '',
        'g'
      )
    )
  `;
  const brandFastpathSelect = `
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
    updated_at,
    created_at,
    coalesce(
      seed_data->>'brand',
      seed_data->'snapshot'->>'brand',
      seed_data->>'merchant_display_name',
      seed_data->'snapshot'->>'merchant_display_name',
      seed_data->>'vendor',
      seed_data->'snapshot'->>'vendor',
      ''
    ) AS seed_brand,
    coalesce(
      seed_data->>'merchant_display_name',
      seed_data->'snapshot'->>'merchant_display_name',
      ''
    ) AS seed_merchant_display_name,
    coalesce(
      seed_data->>'vendor',
      seed_data->'snapshot'->>'vendor',
      ''
    ) AS seed_vendor,
    coalesce(
      seed_data->>'category',
      seed_data->'snapshot'->>'category',
      ''
    ) AS seed_category,
    coalesce(
      seed_data->>'product_type',
      seed_data->'snapshot'->>'product_type',
      ''
    ) AS seed_product_type,
    coalesce(
      seed_data->>'description',
      seed_data->'snapshot'->>'description',
      ''
    ) AS seed_description
  `;

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
      const product = buildExternalSeedBrandSearchProduct(row);
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
            external_seed_count: products.length,
            stale_cache_used: false,
            strategy_applied: strategyApplied,
          },
          external_seed_only_requested: true,
          external_seed_rows_fetched: rows.length,
          external_seed_rows_built: products.length,
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

  const exactSqlParams = [market, brandToolValues, exactBrandCompactVariants];

  try {
    const exactPageStartedAt = Date.now();
    const exactWhereClause = `
      status = 'active'
        AND attached_product_key IS NULL
        AND market = $1
        AND tool = ANY($2::text[])
        ${availabilityFilter}
        AND ${brandMatchExpr} = ANY($3::text[])
    `;
    const [exactRes, exactCountRes] = await Promise.all([
      query(
        `
          SELECT
            ${brandFastpathSelect}
          FROM external_product_seeds
          WHERE ${exactWhereClause}
          ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT $4
          OFFSET $5
        `,
        [...exactSqlParams, safeLimit, safeOffset],
      ),
      query(
        `
          SELECT COUNT(*)::int AS total
          FROM external_product_seeds
          WHERE ${exactWhereClause}
        `,
        exactSqlParams,
      ),
    ]);
    const exactDurationMs = Math.max(0, Date.now() - exactPageStartedAt);

    const exactRows = Array.isArray(exactRes?.rows) ? exactRes.rows : [];
    const exactTotalRows = Math.max(0, Number(exactCountRes?.rows?.[0]?.total || 0) || 0);
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
            duration_ms: exactDurationMs,
            brand_fastpath: true,
            stage: 'brand_exact',
          },
        ],
      });
    }

    const broadSqlParams = [market, brandToolValues, brandTerms, queryPatterns, safeLimit, safeOffset];
    const broadStartedAt = Date.now();
    const broadRes = await query(
      `
        WITH candidates AS (
          SELECT
            ${brandFastpathSelect},
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
            AND tool = ANY($2::text[])
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
          *
        FROM paged
      `,
      broadSqlParams,
    );
    const broadDurationMs = Math.max(0, Date.now() - broadStartedAt);

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
          duration_ms: exactDurationMs,
          brand_fastpath: true,
          stage: 'brand_exact',
        },
        {
          query: relevanceQueryText,
          pattern_count: queryPatterns.length,
          row_count: broadTotalRows,
          duration_ms: broadDurationMs,
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

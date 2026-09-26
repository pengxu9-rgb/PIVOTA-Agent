function buildExternalSeedServingEligibleJoinSql() {
  // Gate external_seed retrieval on catalog_row_trust.serving_decision='public',
  // the single source of truth for serving eligibility (identity + source
  // lifecycle + IPS + quarantine + tombstone composed in one place).
  return `INNER JOIN catalog_row_trust crt
        ON crt.subject_type = 'product'
       AND crt.subject_key = cp.product_key
       AND crt.serving_decision = 'public'`;
}

async function runExternalSeedBrandMainlineFastpath({
  relevanceQueryText = '',
  market = 'US',
  tool = '*',
  inStockOnly = false,
  includeAttached = false,
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
  // NOTE: normalizeBrandText is NOT the twin of the '[^a-z0-9]' fold this is compared against —
  // it KEEPS '-', '&' and '\u00ae' and folds accents to ASCII, where the SQL class drops all of them,
  // so "AXIS-Y" binds 'axis-y' against a stored 'axisy' and "Estee Lauder" with the acute binds
  // 'esteelauder' against a stored 'estelauder'. Those brands are still unreachable by this arm.
  //
  // Binding the SQL fold of the raw query text as a second key was tried here and REVERTED: it is
  // not additive. For a query in a non-Latin script the fold leaves only the Latin residue, which
  // is a product-line token and not a brand — "<hangul> BB" yields the key 'bb' — and because the
  // exact arm returns before the broad fallback runs, one junk match SUPPRESSES the rows the
  // fallback used to return. Measured: that query lost its Sulwhasoo row. `split_part(domain, ...)`
  // in the match expression means a 2-character residue does not even need a 2-letter brand to
  // collide; it reached a brandless seed on 'cc.co.kr'. A length floor only moves the boundary.
  // Reaching those brands needs a key derived from a DETECTED brand, not from raw query residue.
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
  const normalizedTool = String(tool || '').trim();
  const allToolsRequested =
    !normalizedTool || normalizedTool === '*' || normalizedTool.toLowerCase() === 'all_tools';
  const brandToolValues = allToolsRequested
    ? []
    : Array.from(new Set([normalizedTool, '*', ''].map((value) => String(value || '').trim()).filter(Boolean)));
  const buildToolScopeClause = (bind) =>
    allToolsRequested ? '' : `AND (tool = ANY(${bind}::text[]) OR tool IS NULL OR tool = '')`;
  const availabilityFilter = inStockOnly
    ? `AND coalesce(lower(availability), '') NOT IN ('out of stock', 'out_of_stock', 'outofstock', 'oos')`
    : '';
  const attachedFilter = 'AND attached_product_key IS NOT NULL';
  // lower() wraps the COALESCE, not the regexp_replace. The other order filters before it
  // case-folds, and 'A-Z' is not in '[^a-z0-9]', so every capital letter is DELETED:
  // lower(regexp_replace('Fenty Beauty', '[^a-z0-9]+', '', 'g')) is 'entyeauty', not
  // 'fentybeauty'. The bound key comes from normalizeBrandText, which lowercases first, so the
  // exact arm could only ever match a brand stored entirely in lower case. Measured on prod
  // 2026-09-16: 10,283 of 11,817 attached active seeds carry a capital, and replaying the 59
  // largest brand pages matched 1,311 rows this way against 7,916 with the order below.
  //
  // The index definitions in migrations 031/032 carry the broken spelling, so this expression no
  // longer matches them — which costs nothing here: both are partial on `attached_product_key
  // IS NULL` while this query requires IS NOT NULL, so neither could ever serve it.
  const brandMatchExpr = `
    regexp_replace(
      lower(
        coalesce(
          seed_data->>'brand',
          seed_data->'snapshot'->>'brand',
          split_part(domain, '.', 1),
          ''
        )
      ),
      '[^a-z0-9]+',
      '',
      'g'
    )
  `;
  const servingEligibleSeedExistsClause = `
    EXISTS (
      SELECT 1
      FROM catalog_products cp
      ${buildExternalSeedServingEligibleJoinSql()}
      WHERE cp.product_key = external_product_seeds.attached_product_key
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
        retrieval_tool_scope: allToolsRequested ? 'all_tools' : 'preferred_tool',
        retrieval_tool: allToolsRequested ? null : normalizedTool,
        retrieval_include_attached: Boolean(includeAttached),
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

  const exactWhereSqlParams = allToolsRequested
    ? [market, exactBrandCompactVariants]
    : [market, brandToolValues, exactBrandCompactVariants];
  const exactBrandBind = `$${exactWhereSqlParams.length}`;
  const exactToolScopeClause = buildToolScopeClause('$2');
  const exactPageSqlParams = [...exactWhereSqlParams];
  exactPageSqlParams.push(safeLimit);
  const exactLimitBind = `$${exactPageSqlParams.length}`;
  exactPageSqlParams.push(safeOffset);
  const exactOffsetBind = `$${exactPageSqlParams.length}`;

  try {
    const exactPageStartedAt = Date.now();
    const exactWhereClause = `
      status = 'active'
        AND ${servingEligibleSeedExistsClause}
        ${attachedFilter}
        AND market = $1
        ${exactToolScopeClause}
        ${availabilityFilter}
        AND ${brandMatchExpr} = ANY(${exactBrandBind}::text[])
    `;
    const exactRes = await query(
      `
        SELECT
          ${brandFastpathSelect},
          COUNT(*) OVER()::int AS total_rows
        FROM external_product_seeds
        WHERE ${exactWhereClause}
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT ${exactLimitBind}
        OFFSET ${exactOffsetBind}
      `,
      exactPageSqlParams,
    );
    const exactDurationMs = Math.max(0, Date.now() - exactPageStartedAt);

    const exactRows = Array.isArray(exactRes?.rows) ? exactRes.rows : [];
    let exactTotalRows = Math.max(0, Number(exactRows[0]?.total_rows || 0) || 0);
    if (exactRows.length === 0 && safeOffset > 0) {
      const exactCountRes = await query(
        `
          SELECT COUNT(*)::int AS total
          FROM external_product_seeds
          WHERE ${exactWhereClause}
        `,
        exactWhereSqlParams,
      );
      exactTotalRows = Math.max(0, Number(exactCountRes?.rows?.[0]?.total || 0) || 0);
      if (exactTotalRows > 0 && safeOffset >= exactTotalRows) {
        return buildBrandFastpathResponse({
          rows: [],
          totalRows: exactTotalRows,
          strategyApplied: 'brand_search_external_seed_mainline_exact',
          broadFallbackUsed: false,
          broadScopeRows: 0,
          retrievalDebug: [
            {
              query: relevanceQueryText,
              pattern_count: 0,
              row_count: exactTotalRows,
              duration_ms: Math.max(0, Date.now() - exactPageStartedAt),
              brand_fastpath: true,
              stage: 'brand_exact_empty_page',
            },
          ],
        });
      }
    }
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

    const broadSqlParams = [market];
    const broadToolScopeClause = allToolsRequested
      ? ''
      : (() => {
          broadSqlParams.push(brandToolValues);
          return buildToolScopeClause(`$${broadSqlParams.length}`);
        })();
    broadSqlParams.push(queryPatterns);
    const broadQueryPatternsBind = `$${broadSqlParams.length}`;
    broadSqlParams.push(safeLimit);
    const broadLimitBind = `$${broadSqlParams.length}`;
    broadSqlParams.push(safeOffset);
    const broadOffsetBind = `$${broadSqlParams.length}`;
    const broadStartedAt = Date.now();
    const broadRes = await query(
      `
        WITH candidates AS (
          SELECT
            ${brandFastpathSelect},
            CASE
              WHEN lower(coalesce(title, '')) LIKE ANY(${broadQueryPatternsBind}::text[]) THEN 3
              WHEN (
                lower(coalesce(domain, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
                OR lower(coalesce(canonical_url, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
                OR lower(coalesce(destination_url, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
                OR lower(coalesce(seed_data::text, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
              ) THEN 2
              ELSE 1
            END AS brand_match_rank
          FROM external_product_seeds
          WHERE status = 'active'
            AND ${servingEligibleSeedExistsClause}
            ${attachedFilter}
            AND market = $1
            ${broadToolScopeClause}
            ${availabilityFilter}
            AND (
              lower(coalesce(title, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
              OR lower(coalesce(domain, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
              OR lower(coalesce(canonical_url, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
              OR lower(coalesce(destination_url, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
              OR lower(coalesce(seed_data::text, '')) LIKE ANY(${broadQueryPatternsBind}::text[])
            )
        ),
        paged AS (
          SELECT
            *,
            COUNT(*) OVER() AS total_rows
          FROM candidates
          ORDER BY brand_match_rank DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
          LIMIT ${broadLimitBind}
          OFFSET ${broadOffsetBind}
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
  _internals: {
    buildExternalSeedServingEligibleJoinSql,
  },
};

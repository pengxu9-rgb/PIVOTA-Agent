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
  // Two keys per variant, because normalizeBrandText is NOT the twin of the SQL expression this
  // is compared against and cannot be made into one without changing every other caller:
  //   - normalizeBrandText keeps '-' and folds accents to ASCII: "AXIS-Y" -> 'axis-y',
  //     "Estee Lauder" with the acute -> 'esteelauder'.
  //   - the SQL '[^a-z0-9]+' drops BOTH: 'axisy' and 'estelauder'.
  // So the SQL twin is bound ALONGSIDE the existing key, never instead of it: every brand that
  // matches today still matches, and hyphenated and accented brands start to.
  //
  // A twin key under 2 characters is dropped. A brand written in a non-Latin script reduces to
  // almost nothing under '[^a-z0-9]' ("<katakana> MEAL IT" -> 'mealit', but a script-only brand
  // can reduce to a single letter), and a one-character key is not an identity — it would equal
  // unrelated rows that happen to reduce the same way.
  // One extra key: the RAW query text folded the way the SQL expression folds it. normalizeBrandText
  // is not the twin of '[^a-z0-9]' and cannot be made into one without changing every other caller
  // — it KEEPS '-', '&' and '\u00ae', and folds accented letters to ASCII, where the SQL class drops all
  // of them. So "AXIS-Y" binds 'axis-y' but is stored 'axisy', and "Estee Lauder" with the acute
  // binds 'esteelauder' but is stored 'estelauder'. The twin is bound ALONGSIDE the existing key,
  // never instead of it, so no brand that matches today stops matching.
  //
  // It is taken from the RAW text, not from the variants: buildBrandQueryVariants (and
  // detectBrandEntities before it) return values that have ALREADY been through normalizeBrandText,
  // so the accent is gone before a variant is seen here and twinning a variant recovers nothing a
  // plain compaction did not already give. Measured over the prod brands that differ under the two
  // folds, twinning the variants added no key that was not already bound or a whole-sentence
  // compaction matching nothing.
  //
  // KNOWN BOUND: this rescues a query that IS the brand name — which is what a brand page sends.
  // "Estee Lauder serum" with the acute is not rescued, because the accent is lost inside
  // detectBrandEntities before any of this runs. Fixing that means carrying the spelling through
  // the lexicon, which is a change to a shared vocabulary and not this one.
  //
  // A twin under 2 characters is dropped: a brand written in a non-Latin script reduces to almost
  // nothing under '[^a-z0-9]', and a one-character key is not an identity — bound, it would equal
  // every unrelated row that reduces the same way.
  const sqlBrandKeyTwin = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const rawQueryBrandKey = sqlBrandKeyTwin(relevanceQueryText);
  const exactBrandCompactVariants = Array.from(
    new Set(
      [
        ...buildBrandQueryVariants(relevanceQueryText, brandTerms)
          .map((value) => normalizeBrandText(value).replace(/\s+/g, '')),
        rawQueryBrandKey.length >= 2 ? rawQueryBrandKey : '',
      ].filter(Boolean),
    ),
  ).slice(0, 9);
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

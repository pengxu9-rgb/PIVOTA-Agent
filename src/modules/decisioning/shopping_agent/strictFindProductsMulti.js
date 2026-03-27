const STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_PROFILES = Object.freeze({
  ascorbic_acid: Object.freeze({
    display_name: 'Vitamin C',
    aliases: ['ascorbic acid', 'vitamin c', 'l ascorbic acid'],
    expected_step_families: ['serum', 'treatment'],
  }),
  azelaic_acid: Object.freeze({
    display_name: 'Azelaic Acid',
    aliases: ['azelaic acid', 'azelaic'],
    expected_step_families: ['serum', 'treatment', 'cream'],
  }),
  benzoyl_peroxide: Object.freeze({
    display_name: 'Benzoyl Peroxide',
    aliases: ['benzoyl peroxide', 'benzoyl', 'bpo'],
    expected_step_families: ['treatment', 'cleanser', 'gel'],
  }),
  ceramide_np: Object.freeze({
    display_name: 'Ceramide NP',
    aliases: ['ceramide', 'ceramides', 'ceramide np'],
    expected_step_families: ['serum', 'moisturizer'],
  }),
  glycerin: Object.freeze({
    display_name: 'Glycerin',
    aliases: ['glycerin', 'glycerine'],
    expected_step_families: ['serum', 'moisturizer'],
  }),
  hyaluronic_acid: Object.freeze({
    display_name: 'Hyaluronic Acid',
    aliases: ['hyaluronic acid', 'hyaluronic', 'hyaluron', 'sodium hyaluronate'],
    expected_step_families: ['serum', 'moisturizer'],
  }),
  niacinamide: Object.freeze({
    display_name: 'Niacinamide',
    aliases: ['niacinamide', 'nicotinamide', 'vitamin b3'],
    expected_step_families: ['serum', 'treatment'],
  }),
  panthenol: Object.freeze({
    display_name: 'Panthenol',
    aliases: ['panthenol', 'vitamin b5', 'provitamin b5', 'b5'],
    expected_step_families: ['serum', 'moisturizer'],
  }),
  peptides: Object.freeze({
    display_name: 'Peptides',
    aliases: [
      'peptide',
      'peptides',
      'multi peptide',
      'multi-peptide',
      'copper peptide',
      'copper peptides',
      'tripeptide',
      'tetrapeptide',
      'hexapeptide',
    ],
    expected_step_families: ['serum', 'treatment'],
  }),
  retinol: Object.freeze({
    display_name: 'Retinol',
    aliases: ['retinol', 'retinoid', 'vitamin a'],
    expected_step_families: ['serum', 'treatment', 'cream'],
  }),
  salicylic_acid: Object.freeze({
    display_name: 'Salicylic Acid',
    aliases: ['salicylic acid', 'salicylic', 'bha'],
    expected_step_families: ['serum', 'treatment', 'cleanser'],
  }),
  zinc_pca: Object.freeze({
    display_name: 'Zinc PCA',
    aliases: ['zinc pca', 'zinc'],
    expected_step_families: ['serum', 'treatment'],
  }),
});

const STRICT_FIND_PRODUCTS_MULTI_SHADE_CATEGORY_TERMS = Object.freeze([
  'foundation',
  'lipstick',
  'blush',
  'gloss',
]);

const STRICT_FIND_PRODUCTS_MULTI_VISIBLE_ATTRIBUTE_TERMS = Object.freeze([
  'fragrance free',
  'sensitive skin',
  'hydrating',
  'brightening',
]);

const STRICT_FIND_PRODUCTS_MULTI_SKINCARE_CATEGORY_TERMS = Object.freeze([
  'serum',
  'moisturizer',
  'cleanser',
  'toner',
]);

const STRICT_FIND_PRODUCTS_MULTI_EXTERNAL_PREFETCH_LIMIT = Math.max(
  1,
  Math.min(Number(process.env.STRICT_FIND_PRODUCTS_MULTI_EXTERNAL_PREFETCH_LIMIT || 12) || 12, 50),
);

function defaultNormalizeSearchTextForMatch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getRequestedCatalogSurface({ search = {}, metadata = {} } = {}) {
  return String(
    search?.catalog_surface ||
      search?.catalogSurface ||
      metadata?.catalog_surface ||
      metadata?.catalogSurface ||
      '',
  )
    .trim()
    .toLowerCase();
}

function isStrictCommerceCatalogSurface(surface) {
  return ['agent_api', 'acp', 'ucp'].includes(String(surface || '').trim().toLowerCase());
}

function buildSqlLikeClauses(columnSql, values, params, startIndex) {
  const clauses = [];
  let paramIndex = startIndex;
  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) continue;
    params.push(`%${normalized}%`);
    clauses.push(`${columnSql} LIKE $${paramIndex}`);
    paramIndex += 1;
  }
  return { clauses, nextIndex: paramIndex };
}

function createStrictFindProductsMultiRuntime(deps = {}) {
  const normalizeSearchTextForMatch =
    typeof deps.normalizeSearchTextForMatch === 'function'
      ? deps.normalizeSearchTextForMatch
      : defaultNormalizeSearchTextForMatch;
  const buildBeautyQueryProfile =
    typeof deps.buildBeautyQueryProfile === 'function' ? deps.buildBeautyQueryProfile : () => null;
  const query = typeof deps.query === 'function' ? deps.query : async () => ({ rows: [] });
  const buildExternalSeedProduct =
    typeof deps.buildExternalSeedProduct === 'function' ? deps.buildExternalSeedProduct : (row) => row || null;
  const logger =
    deps.logger && typeof deps.logger.warn === 'function'
      ? deps.logger
      : { warn() {} };
  const buildSearchProductsV2Body =
    typeof deps.buildSearchProductsV2Body === 'function'
      ? deps.buildSearchProductsV2Body
      : ({ search = {} } = {}) => ({ ...search });
  const pruneEmptyFields =
    typeof deps.pruneEmptyFields === 'function' ? deps.pruneEmptyFields : (value) => value;
  const hasDatabaseUrl =
    typeof deps.hasDatabaseUrl === 'boolean' ? deps.hasDatabaseUrl : Boolean(process.env.DATABASE_URL);

  const strictIngredientAliases = Object.freeze(
    Object.fromEntries(
      Object.entries(STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_PROFILES).flatMap(([ingredientId, profile]) => {
        const aliases = [
          ingredientId.replace(/_/g, ' '),
          ...((profile && Array.isArray(profile.aliases)) ? profile.aliases : []),
        ];
        return aliases
          .map((term) => normalizeSearchTextForMatch(term))
          .filter(Boolean)
          .map((term) => [term, ingredientId]);
      }),
    ),
  );

  function extractStrictFindProductsMultiIngredientIntents(queryText, beautyQueryProfile = null) {
    const normalizedQuery = normalizeSearchTextForMatch(String(queryText || ''));
    if (!normalizedQuery) return [];
    const beautyBucket = String(beautyQueryProfile?.bucket || '').trim().toLowerCase();
    const isBeautyQuery = Boolean(beautyQueryProfile?.isBeautyQuery);
    if (isBeautyQuery && beautyBucket && beautyBucket !== 'skincare') {
      return [];
    }
    const intents = [];
    for (const [term, ingredientId] of Object.entries(strictIngredientAliases)) {
      if (!normalizedQuery.includes(term)) continue;
      if (!intents.includes(ingredientId)) intents.push(ingredientId);
    }
    return intents;
  }

  function extractStrictFindProductsMultiShadeOptionIntents(queryText, beautyQueryProfile = null) {
    const normalizedQuery = normalizeSearchTextForMatch(String(queryText || ''));
    if (!normalizedQuery) return [];
    const beautyBucket = String(beautyQueryProfile?.bucket || '').trim().toLowerCase();
    const isBeautyQuery = Boolean(beautyQueryProfile?.isBeautyQuery);
    if (isBeautyQuery && !['general', 'base_makeup', 'lip_makeup'].includes(beautyBucket)) {
      return [];
    }
    if (!STRICT_FIND_PRODUCTS_MULTI_SHADE_CATEGORY_TERMS.some((term) => normalizedQuery.includes(term))) {
      return [];
    }
    const intents = [];
    const shadePattern = /\bshade\s+([a-z0-9][a-z0-9 ]{0,30})\b/g;
    for (const match of normalizedQuery.matchAll(shadePattern)) {
      const rawValue = normalizeSearchTextForMatch(match[1] || '');
      if (!rawValue) continue;
      const label = `shade_${rawValue.replace(/\s+/g, '_')}`;
      if (!intents.includes(label)) intents.push(label);
    }
    return intents;
  }

  function hasStrictFindProductsMultiBudgetConstraint(queryText) {
    const normalizedQuery = normalizeSearchTextForMatch(String(queryText || ''));
    if (!normalizedQuery) return false;
    return (
      /\b(under|below|over|above|less than|more than)\s+\d+\b/.test(normalizedQuery) ||
      /\b\d+\s*(usd|eur|gbp|cny)\b/.test(normalizedQuery) ||
      /(?:€|\$|£)\s*\d+/.test(String(queryText || ''))
    );
  }

  function extractStrictFindProductsMultiVisibleAttributeIntents(queryText) {
    const normalizedQuery = normalizeSearchTextForMatch(String(queryText || ''));
    if (!normalizedQuery) return [];
    return STRICT_FIND_PRODUCTS_MULTI_VISIBLE_ATTRIBUTE_TERMS.filter((term) =>
      normalizedQuery.includes(normalizeSearchTextForMatch(term)),
    );
  }

  function getStrictFindProductsMultiConstraintDecision({ search = {}, metadata = {} } = {}) {
    const requestedCatalogSurface = getRequestedCatalogSurface({ search, metadata });
    const rawQuery = String(search?.query || '').trim();
    if (!rawQuery && isStrictCommerceCatalogSurface(requestedCatalogSurface)) {
      return {
        enabled: true,
        catalogSurface: requestedCatalogSurface,
        strictConstraintQuery: false,
        strictConstraintReason: null,
        ingredientIntents: [],
        shadeOptionIntents: [],
      };
    }
    if (!rawQuery) {
      return {
        enabled: false,
        catalogSurface: null,
        strictConstraintQuery: false,
        strictConstraintReason: null,
        ingredientIntents: [],
        shadeOptionIntents: [],
      };
    }

    const beautyQueryProfile = buildBeautyQueryProfile({ rawQuery });
    const ingredientIntents = extractStrictFindProductsMultiIngredientIntents(rawQuery, beautyQueryProfile);
    const shadeOptionIntents = extractStrictFindProductsMultiShadeOptionIntents(rawQuery, beautyQueryProfile);
    const hasIngredientConstraint = ingredientIntents.length > 0;
    const hasShadeConstraint = shadeOptionIntents.length > 0;
    if (!hasIngredientConstraint && !hasShadeConstraint) {
      return {
        enabled: false,
        catalogSurface: null,
        strictConstraintQuery: false,
        strictConstraintReason: null,
        ingredientIntents,
        shadeOptionIntents,
      };
    }

    const visibleAttributeIntents = extractStrictFindProductsMultiVisibleAttributeIntents(rawQuery);
    const hasBudgetConstraint = hasStrictFindProductsMultiBudgetConstraint(rawQuery);
    const hasAdditionalConstraint =
      visibleAttributeIntents.length > 0 ||
      hasBudgetConstraint ||
      (hasIngredientConstraint && hasShadeConstraint);
    const strictConstraintReason = hasAdditionalConstraint
      ? 'multi_constraint'
      : hasIngredientConstraint
        ? 'ingredient'
        : 'shade';

    return {
      enabled:
        isStrictCommerceCatalogSurface(requestedCatalogSurface) ||
        hasIngredientConstraint ||
        hasShadeConstraint,
      catalogSurface: isStrictCommerceCatalogSurface(requestedCatalogSurface)
        ? requestedCatalogSurface
        : 'agent_api',
      strictConstraintQuery: hasIngredientConstraint || hasShadeConstraint,
      strictConstraintReason,
      ingredientIntents,
      shadeOptionIntents,
    };
  }

  function extractStrictFindProductsMultiSkincareCategoryIntents(queryText) {
    const normalizedQuery = normalizeSearchTextForMatch(String(queryText || ''));
    if (!normalizedQuery) return [];
    return STRICT_FIND_PRODUCTS_MULTI_SKINCARE_CATEGORY_TERMS.filter((term) =>
      normalizedQuery.includes(normalizeSearchTextForMatch(term)),
    );
  }

  function productMatchesStrictIngredientPrefetch(
    product,
    { ingredientIntents = [], categoryIntents = [], inStockOnly = true } = {},
  ) {
    if (!product || typeof product !== 'object') return false;
    const productIngredientIds = Array.isArray(product.ingredient_ids)
      ? product.ingredient_ids.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (
      ingredientIntents.length > 0 &&
      !ingredientIntents.every((intent) => productIngredientIds.includes(intent))
    ) {
      return false;
    }

    const visibilityHaystack = normalizeSearchTextForMatch(
      [
        product.title,
        product.product_type,
        product.category,
        product.description,
        product.canonical_url,
        product.destination_url,
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (
      categoryIntents.length > 0 &&
      !categoryIntents.every((intent) => visibilityHaystack.includes(normalizeSearchTextForMatch(intent)))
    ) {
      return false;
    }

    if (inStockOnly && product.in_stock !== true) {
      return false;
    }

    if (ingredientIntents.length > 0) {
      const surfaceText = normalizeSearchTextForMatch(
        [
          product.title,
          product.product_type,
          product.category,
          product.canonical_url,
          product.destination_url,
        ]
          .filter(Boolean)
          .join(' '),
      );
      const resolvedStepFamilies = STRICT_FIND_PRODUCTS_MULTI_SKINCARE_CATEGORY_TERMS.filter((term) =>
        surfaceText.includes(normalizeSearchTextForMatch(term)),
      );
      for (const ingredientId of ingredientIntents) {
        const profile = STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_PROFILES[ingredientId] || null;
        const targetTerms = [
          ingredientId.replace(/_/g, ' '),
          ...((profile && Array.isArray(profile.aliases)) ? profile.aliases : []),
        ]
          .map((term) => normalizeSearchTextForMatch(term))
          .filter(Boolean);
        const targetSurfaceAnchor = targetTerms.some((term) => surfaceText.includes(term));
        const expectedStepFamilies =
          profile && Array.isArray(profile.expected_step_families)
            ? profile.expected_step_families.map((value) => normalizeSearchTextForMatch(value)).filter(Boolean)
            : [];
        const stepFamilyMismatch =
          expectedStepFamilies.length > 0 &&
          resolvedStepFamilies.length > 0 &&
          !expectedStepFamilies.some((value) => resolvedStepFamilies.includes(value));
        if (stepFamilyMismatch) return false;
        if (!targetSurfaceAnchor) return false;
      }
    }

    return true;
  }

  async function prefetchStrictIngredientExternalSeedCandidates({
    search = {},
    strictInvokeDecision = null,
    rawQueryText = null,
  } = {}) {
    if (!hasDatabaseUrl) return [];

    const decision =
      strictInvokeDecision && typeof strictInvokeDecision === 'object'
        ? strictInvokeDecision
        : getStrictFindProductsMultiConstraintDecision({ search, metadata: {} });
    const ingredientIntents = Array.isArray(decision?.ingredientIntents)
      ? decision.ingredientIntents.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (!decision?.strictConstraintQuery || ingredientIntents.length === 0) {
      return [];
    }

    const queryText = String(rawQueryText || search?.query || '').trim();
    const categoryIntents = extractStrictFindProductsMultiSkincareCategoryIntents(queryText);
    const textTerms = [
      ...ingredientIntents.flatMap((value) => {
        const profile = STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_PROFILES[value] || null;
        return [
          value.replace(/_/g, ' '),
          ...((profile && Array.isArray(profile.aliases)) ? profile.aliases : []),
        ];
      }),
      ...(categoryIntents.length > 0 ? categoryIntents : STRICT_FIND_PRODUCTS_MULTI_SKINCARE_CATEGORY_TERMS),
    ];

    const params = ['US'];
    let paramIndex = 2;
    const titleLike = buildSqlLikeClauses('LOWER(COALESCE(title, \'\'))', textTerms, params, paramIndex);
    paramIndex = titleLike.nextIndex;
    const urlLike = buildSqlLikeClauses(
      'LOWER(COALESCE(canonical_url, \'\'))',
      textTerms,
      params,
      paramIndex,
    );
    paramIndex = urlLike.nextIndex;
    const seedDataLike = buildSqlLikeClauses(
      'LOWER(CAST(COALESCE(seed_data, \'{}\'::jsonb) AS TEXT))',
      textTerms,
      params,
      paramIndex,
    );
    paramIndex = seedDataLike.nextIndex;
    params.push(Math.max(STRICT_FIND_PRODUCTS_MULTI_EXTERNAL_PREFETCH_LIMIT * 3, 24));

    const structuredIngredientEvidenceClauses = [
      "COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(COALESCE(seed_data, '{}'::jsonb)->'reviewed_ingredient_ids') = 'array' THEN COALESCE(seed_data, '{}'::jsonb)->'reviewed_ingredient_ids' ELSE '[]'::jsonb END), 0) > 0",
      "COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(COALESCE(seed_data, '{}'::jsonb)->'ingredient_ids') = 'array' THEN COALESCE(seed_data, '{}'::jsonb)->'ingredient_ids' ELSE '[]'::jsonb END), 0) > 0",
      "COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(COALESCE(seed_data, '{}'::jsonb)->'snapshot'->'reviewed_ingredient_ids') = 'array' THEN COALESCE(seed_data, '{}'::jsonb)->'snapshot'->'reviewed_ingredient_ids' ELSE '[]'::jsonb END), 0) > 0",
      "COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(COALESCE(seed_data, '{}'::jsonb)->'snapshot'->'ingredient_ids') = 'array' THEN COALESCE(seed_data, '{}'::jsonb)->'snapshot'->'ingredient_ids' ELSE '[]'::jsonb END), 0) > 0",
    ];

    const sql = `
      SELECT
        id,
        external_product_id,
        market,
        tool,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE status = 'active'
        AND attached_product_key IS NULL
        AND market = $1
        AND (
          ${structuredIngredientEvidenceClauses.join(' OR ')}
        )
        AND (
          ${[...titleLike.clauses, ...urlLike.clauses, ...seedDataLike.clauses].join(' OR ')}
        )
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $${paramIndex}
    `;

    try {
      const result = await query(sql, params);
      const candidates = [];
      const seen = new Set();
      for (const row of result?.rows || []) {
        const product = buildExternalSeedProduct(row);
        if (!product) continue;
        product.market = row.market || 'US';
        product.tool = row.tool || '*';
        product.external_seed_id = product.external_seed_id || row.id || null;
        if (
          !productMatchesStrictIngredientPrefetch(product, {
            ingredientIntents,
            categoryIntents,
            inStockOnly: search?.in_stock_only !== false,
          })
        ) {
          continue;
        }
        const dedupeKey = String(product.product_id || product.id || '').trim();
        if (!dedupeKey || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        candidates.push(product);
        if (candidates.length >= STRICT_FIND_PRODUCTS_MULTI_EXTERNAL_PREFETCH_LIMIT) break;
      }
      return candidates;
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err), queryText, ingredientIntents, categoryIntents },
        'strict ingredient external seed prefetch failed',
      );
      return [];
    }
  }

  async function buildFindProductsMultiInvokeBody({
    payload = {},
    search = {},
    metadata = {},
    clientChannel = 'shop',
    gatewayRequestId = null,
    defaultSearchAllMerchants = false,
    strictInvokeDecision = null,
    rawQueryText = null,
  } = {}) {
    const resolvedStrictInvokeDecision =
      strictInvokeDecision && typeof strictInvokeDecision === 'object'
        ? strictInvokeDecision
        : getStrictFindProductsMultiConstraintDecision({ search, metadata });
    const requestedCatalogSurface =
      String(resolvedStrictInvokeDecision?.catalogSurface || '').trim().toLowerCase() ||
      getRequestedCatalogSurface({ search, metadata });
    const normalizedSearch = {
      ...(search && typeof search === 'object' ? search : {}),
      ...(requestedCatalogSurface
        ? {
            catalog_surface: requestedCatalogSurface,
            commerce_surface: requestedCatalogSurface,
          }
        : {}),
      ...(
        resolvedStrictInvokeDecision?.strictConstraintQuery && String(rawQueryText || '').trim()
          ? { query: String(rawQueryText || '').trim() }
          : {}
      ),
    };
    const prefetchedExternalSeedCandidates = await prefetchStrictIngredientExternalSeedCandidates({
      search: normalizedSearch,
      strictInvokeDecision: resolvedStrictInvokeDecision,
      rawQueryText,
    });
    return {
      operation: 'find_products_multi',
      payload: {
        search: buildSearchProductsV2Body({
          payload,
          search: normalizedSearch,
          metadata,
          clientChannel,
          gatewayRequestId,
          defaultSearchAllMerchants,
        }),
      },
      metadata: pruneEmptyFields({
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        catalog_surface: requestedCatalogSurface || undefined,
        commerce_surface: requestedCatalogSurface || undefined,
        ...(prefetchedExternalSeedCandidates.length > 0
          ? {
              external_seed_candidates: prefetchedExternalSeedCandidates,
              external_seed_prefetch_source: 'agent_strict_ingredient_prefetch',
            }
          : {}),
      }),
    };
  }

  return {
    getRequestedCatalogSurface,
    isStrictCommerceCatalogSurface,
    extractStrictFindProductsMultiIngredientIntents,
    extractStrictFindProductsMultiShadeOptionIntents,
    hasStrictFindProductsMultiBudgetConstraint,
    extractStrictFindProductsMultiVisibleAttributeIntents,
    getStrictFindProductsMultiConstraintDecision,
    extractStrictFindProductsMultiSkincareCategoryIntents,
    productMatchesStrictIngredientPrefetch,
    prefetchStrictIngredientExternalSeedCandidates,
    buildFindProductsMultiInvokeBody,
  };
}

module.exports = {
  createStrictFindProductsMultiRuntime,
};

const {
  buildSellableStatusPredicate: buildSellableStatusPredicateBase,
  isProductSellable: isProductSellableBase,
} = require('./sellability');
const {
  createCatalogQueryHeuristics,
} = require('./queryHeuristics');

function createCatalogCacheRuntime({
  logger,
  queryDb,
  config = {},
  helpers = {},
} = {}) {
  const query = typeof queryDb === 'function' ? queryDb : async () => ({ rows: [] });
  const getCreatorConfig =
    typeof helpers.getCreatorConfig === 'function' ? helpers.getCreatorConfig : () => null;
  const buildSellableStatusPredicate =
    typeof helpers.buildSellableStatusPredicate === 'function'
      ? helpers.buildSellableStatusPredicate
      : buildSellableStatusPredicateBase;
  const isProductSellable =
    typeof helpers.isProductSellable === 'function' ? helpers.isProductSellable : isProductSellableBase;
  const applyShopifyCurrencyOverride =
    typeof helpers.applyShopifyCurrencyOverride === 'function'
      ? helpers.applyShopifyCurrencyOverride
      : async () => {};
  const scoreByTagFacetOverlap =
    typeof helpers.scoreByTagFacetOverlap === 'function'
      ? helpers.scoreByTagFacetOverlap
      : () => ({ score: 0 });
  const scorePairOverlap =
    typeof helpers.scorePairOverlap === 'function'
      ? helpers.scorePairOverlap
      : () => ({ score: 0 });
  const embedText =
    typeof helpers.embedText === 'function'
      ? helpers.embedText
      : async () => ({ vector: [], dim: 0, provider: 'none', model: 'none' });
  const semanticSearchCreatorProductsFromCache =
    typeof helpers.semanticSearchCreatorProductsFromCache === 'function'
      ? helpers.semanticSearchCreatorProductsFromCache
      : async () => [];

  const SEARCH_LIMIT_MAX = Math.max(1, Number(config.searchLimitMax || 20));
  const FIND_PRODUCTS_MULTI_VECTOR_ENABLED = Boolean(config.findProductsMultiVectorEnabled);
  const HAS_DATABASE = Boolean(config.hasDatabase);

  function buildCacheProductKey(product) {
    const merchantId = String(product?.merchant_id || product?.merchantId || '').trim();
    const productId = String(product?.id || product?.product_id || product?.productId || '').trim();
    return `${merchantId}::${productId || JSON.stringify(product || {}).slice(0, 96)}`;
  }

  function buildFallbackCandidateText(product) {
    if (!product || typeof product !== 'object') return '';
    return [
      product.title,
      product.name,
      product.display_name,
      product.brand,
      product.vendor,
      product.product_name,
      product.description,
      product.product_type,
      product.category,
      product.external_domain,
      product.external_url,
      product.canonical_url,
      product.destination_url,
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .join(' ');
  }

  async function loadCreatorSellableFromCache(creatorId, page = 1, limit = 20, options = {}) {
    const creatorConfig = getCreatorConfig(creatorId);
    if (
      !creatorConfig ||
      !Array.isArray(creatorConfig.merchantIds) ||
      creatorConfig.merchantIds.length === 0
    ) {
      const err = new Error('Unknown creator');
      err.code = 'UNKNOWN_CREATOR';
      throw err;
    }

    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(Math.max(1, Number(limit || 20)), SEARCH_LIMIT_MAX);
    const fetchLimit = Math.max(safeLimit * Math.max(safePage, 1) * 2, 20);
    const inStockOnly = options?.inStockOnly !== false;

    let pickRankByProductId = new Map();
    try {
      const picksRes = await query(
        `
          SELECT product_id, rank
          FROM creator_picks
          WHERE creator_id = $1
          ORDER BY rank ASC
          LIMIT $2
        `,
        [creatorId, safeLimit * 4],
      );
      pickRankByProductId = new Map(
        (picksRes.rows || [])
          .map((row) => {
            const pid = String(row.product_id || '').trim();
            const rank = Number(row.rank);
            return [pid, rank];
          })
          .filter(([pid, rank]) => pid && Number.isFinite(rank)),
      );
    } catch (err) {
      logger?.warn?.(
        { err: err?.message, creatorId },
        'Failed to load creator_picks for creator featured feed; continuing without explicit picks',
      );
    }

    const baseWhere = `
      merchant_id = ANY($1)
      AND (expires_at IS NULL OR expires_at > now())
      AND ${buildSellableStatusPredicate("product_data->>'status'")}
    `;

    const rowsRes = await query(
      `
        SELECT product_data
        FROM products_cache
        WHERE ${baseWhere}
        ORDER BY cached_at DESC
        LIMIT $2
      `,
      [creatorConfig.merchantIds, fetchLimit],
    );

    let baseProducts = (rowsRes.rows || [])
      .map((row) => row.product_data)
      .filter(Boolean)
      .filter((product) => isProductSellable(product, { inStockOnly }));

    if (baseProducts.length === 0) {
      try {
        const relaxedRowsRes = await query(
          `
            SELECT product_data
            FROM products_cache
            WHERE merchant_id = ANY($1)
            ORDER BY cached_at DESC NULLS LAST, id DESC
            LIMIT $2
          `,
          [creatorConfig.merchantIds, fetchLimit],
        );
        baseProducts = (relaxedRowsRes.rows || [])
          .map((row) => row.product_data)
          .filter(Boolean)
          .filter((product) => isProductSellable(product, { inStockOnly }));
      } catch (err) {
        logger?.warn?.(
          { err: err?.message, creatorId },
          'Creator featured strict cache query empty and relaxed fallback failed',
        );
      }
    }

    let pickProducts = [];
    const pickIds = Array.from(pickRankByProductId.keys());
    if (pickIds.length > 0) {
      try {
        const pickRowsRes = await query(
          `
            SELECT product_data
            FROM products_cache
            WHERE ${baseWhere}
              AND (
                platform_product_id = ANY($2)
                OR product_data->>'id' = ANY($2)
                OR product_data->>'product_id' = ANY($2)
              )
            ORDER BY cached_at DESC
          `,
          [creatorConfig.merchantIds, pickIds],
        );
        pickProducts = (pickRowsRes.rows || [])
          .map((row) => row.product_data)
          .filter(Boolean)
          .filter((product) => isProductSellable(product, { inStockOnly }));
      } catch (err) {
        logger?.warn?.(
          { err: err?.message, creatorId, pickIdsCount: pickIds.length },
          'Failed to hydrate creator_picks from products_cache; continuing with base products only',
        );
      }
    }

    const products = [...pickProducts, ...baseProducts];
    const seen = new Set();
    const unique = [];
    for (const product of products) {
      const key = buildCacheProductKey(product);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(product);
    }

    const decorated = unique.map((product) => {
      const pid = String(product.id || product.product_id || product.productId || '').trim();
      const rank = pid && pickRankByProductId.has(pid) ? pickRankByProductId.get(pid) : null;
      return { product, pickRank: rank };
    });

    decorated.sort((a, b) => {
      const ar = a.pickRank == null ? Number.POSITIVE_INFINITY : a.pickRank;
      const br = b.pickRank == null ? Number.POSITIVE_INFINITY : b.pickRank;
      if (ar !== br) return ar - br;
      return 0;
    });

    const sorted = decorated.map(({ product, pickRank }) => {
      if (pickRank == null) return product;
      return {
        ...product,
        creator_pick: true,
        creator_pick_rank: pickRank,
      };
    });

    const startIdx = (safePage - 1) * safeLimit;
    const pageItems = sorted.slice(startIdx, startIdx + safeLimit);
    await applyShopifyCurrencyOverride(pageItems);

    return {
      products: pageItems,
      total: sorted.length,
      page: safePage,
      page_size: pageItems.length,
      merchantIds: creatorConfig.merchantIds,
    };
  }

  function buildPetSignalSql(startIndex) {
    const latin =
      '(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|perro|perros|mascota|mascotas|gato|gatos|chien|chiens|chienne|chiot|chat|chats)';
    const cjk = '(狗狗|狗|猫猫|猫|宠物|犬服|猫服|犬|ペット|わんちゃん)';
    const re = `(\\m${latin}\\M|${cjk})`;
    const fields = [
      "coalesce(product_data->>'title','')",
      "coalesce(product_data->>'description','')",
      "coalesce(product_data->>'product_type','')",
    ];
    const idx = startIndex;
    const ors = fields.map((field) => `${field} ~* $${idx}`).join(' OR ');
    return { sql: `(${ors})`, params: [re], nextIndex: idx + 1 };
  }

  function hasPetSearchSignal(queryText) {
    const q = String(queryText || '');
    if (!q) return false;
    return (
      /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|perro|perros|mascota|mascotas|gato|gatos|chien|chiens|chat|chats)\b/i.test(
        q,
      ) || /狗狗|狗|猫猫|猫|宠物|犬|犬服|猫服|ペット|わんちゃん/.test(q)
    );
  }

  function hasPetHarnessSearchSignal(queryText) {
    const q = String(queryText || '');
    if (!q) return false;
    return (
      /\b(harness|leash|dog\s+leash|pet\s+leash|collar|lead|no-?pull)\b/i.test(q) ||
      /背带|背帶|胸背|牵引|牽引|牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|项圈|項圈|胸背带|胸背帶|狗绳|狗繩|胴輪|ハーネス|リード|首輪/.test(
        q,
      )
    );
  }

  function hasPetLeashSearchSignal(queryText) {
    const q = String(queryText || '');
    if (!q) return false;
    return (
      /\b(leash|dog\s+leash|pet\s+leash|lead|training\s+leash|collar)\b/i.test(q) ||
      /牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|狗绳|狗繩|项圈|項圈|リード|首輪/.test(q)
    );
  }

  function hasStrictPetHarnessCatalogSignal(candidateText) {
    const text = String(candidateText || '');
    if (!text) return false;
    return (
      /\b(harness|leash|dog\s+leash|pet\s+leash|collar|lead|no-?pull|training\s+leash)\b/i.test(
        text,
      ) ||
      /(背带|背帶|胸背|牵引|牽引|牵引绳|牽引繩|遛狗绳|狗链|狗鏈|狗链子|狗鏈子|项圈|項圈|胴輪|ハーネス|リード|首輪|arn[eé]s|correa|collier)/i.test(
        text,
      )
    );
  }

  function hasBeautyMakeupSearchSignal(queryText) {
    const q = String(queryText || '');
    if (!q) return false;
    return (
      /\b(makeup|cosmetic|cosmetics|beauty|foundation|concealer|lipstick|blush|mascara|eyeshadow|perfume|fragrance|parfum|cologne|body mist)\b/i.test(
        q,
      ) ||
      /化妆|化妝|美妆|美妝|彩妆|彩妝|底妆|底妝|粉底|遮瑕|口红|口紅|唇膏|腮红|眼影|睫毛膏|约会妆|約會妝|香水|体香喷雾|體香噴霧/.test(
        q,
      )
    );
  }

  function hasBeautyCatalogProductSignal(candidateText) {
    const text = String(candidateText || '');
    if (!text) return false;
    return (
      /\b(makeup|cosmetic|cosmetics|beauty|foundation|concealer|lipstick|blush|mascara|eyeshadow|brush|palette|toner|serum|skincare|perfume|fragrance|parfum|cologne|body mist|fenty|tom ford|winona|ipsa)\b/i.test(
        text,
      ) ||
      /(化妆|化妝|美妆|美妝|彩妆|彩妝|底妆|底妝|粉底|遮瑕|口红|口紅|唇膏|腮红|眼影|睫毛膏|化妆刷|化妝刷|刷具|粉扑|美妆蛋|妆前|妝前|定妆|定妝|香水|体香喷雾|體香噴霧|薇诺娜|薇諾娜|茵芙莎|流金水)/.test(
        text,
      )
    );
  }

  const queryHeuristics = createCatalogQueryHeuristics({
    normalizeResolverText: helpers.normalizeResolverText,
    tokenizeResolverQuery: helpers.tokenizeResolverQuery,
    isKnownLookupAliasQueryBase: helpers.isKnownLookupAliasQueryBase,
    expandLookupAnchorTokensBase: helpers.expandLookupAnchorTokensBase,
    hasPetSearchSignal,
    hasPetHarnessSearchSignal,
    hasBeautyMakeupSearchSignal,
  });
  const buildUnderwearExclusionSql =
    typeof helpers.buildUnderwearExclusionSql === 'function'
      ? helpers.buildUnderwearExclusionSql
      : queryHeuristics.buildUnderwearExclusionSql;
  const detectToyOutfitIntentFromQuery =
    typeof helpers.detectToyOutfitIntentFromQuery === 'function'
      ? helpers.detectToyOutfitIntentFromQuery
      : queryHeuristics.detectToyOutfitIntentFromQuery;
  const tokenizeQueryForCache =
    typeof helpers.tokenizeQueryForCache === 'function'
      ? helpers.tokenizeQueryForCache
      : queryHeuristics.tokenizeQueryForCache;
  const looksSkuLikeQuery =
    typeof helpers.looksSkuLikeQuery === 'function'
      ? helpers.looksSkuLikeQuery
      : queryHeuristics.looksSkuLikeQuery;

  function classifyBeautyBucketFromProduct(product) {
    const text = buildFallbackCandidateText(product);
    if (!text) return 'other';

    if (
      /\b(brush|brushes|blender|sponge|puff|applicator|tool|tools|brush\s*set)\b/i.test(text) ||
      /化妆刷|化妝刷|刷具|粉扑|粉撲|美妆蛋|美妝蛋|工具|刷子|パフ|ブラシ/.test(text)
    ) {
      return 'tools';
    }
    if (
      /\b(foundation|concealer|primer|powder|cushion|bb\s*cream|cc\s*cream|setting\s*powder)\b/i.test(
        text,
      ) || /粉底|遮瑕|妆前|妝前|散粉|蜜粉|气垫|氣墊/.test(text)
    ) {
      return 'base_makeup';
    }
    if (
      /\b(eyeshadow|eye\s*shadow|mascara|eyeliner|brow|eyebrow)\b/i.test(text) ||
      /眼影|睫毛膏|眼线|眼線|眉笔|眉筆|眉粉/.test(text)
    ) {
      return 'eye_makeup';
    }
    if (
      /\b(lipstick|lip\s*tint|lip\s*gloss|lip\s*balm|lip\s*liner|lip)\b/i.test(text) ||
      /口红|口紅|唇膏|唇彩|唇釉|润唇|潤唇/.test(text)
    ) {
      return 'lip_makeup';
    }
    if (
      /\b(skincare|serum|toner|essence|moisturizer|cream|cleanser|sunscreen)\b/i.test(text) ||
      /护肤|護膚|精华|精華|化妆水|化妝水|乳液|面霜|洁面|潔面|防晒|防曬/.test(text)
    ) {
      return 'skincare';
    }
    return 'other';
  }

  function computeBeautyBucketMix(products, topN = 10) {
    const buckets = {
      base_makeup: 0,
      eye_makeup: 0,
      lip_makeup: 0,
      skincare: 0,
      tools: 0,
      other: 0,
    };
    const top = Array.isArray(products) ? products.slice(0, Math.max(1, Number(topN || 10))) : [];
    for (const product of top) {
      const bucket = classifyBeautyBucketFromProduct(product);
      buckets[bucket] = Number(buckets[bucket] || 0) + 1;
    }
    return buckets;
  }

  function isBeautyGeneralDiversitySupplementCandidate(intent, products, limit) {
    if (!intent || intent.primary_domain !== 'beauty') return false;
    const scenario = String(intent?.scenario?.name || '');
    if (scenario === 'beauty_tools' || scenario === 'eye_shadow_brush') return false;
    const topN = Math.max(1, Number(limit || 10));
    const mix = computeBeautyBucketMix(products, topN);
    const coreBuckets = ['base_makeup', 'eye_makeup', 'lip_makeup', 'skincare'];
    const distinctCore = coreBuckets.filter((bucket) => Number(mix[bucket] || 0) > 0).length;
    const toolsCount = Number(mix.tools || 0);
    return distinctCore < 2 && toolsCount >= Math.ceil(topN * 0.6);
  }

  function blendBeautyDiversitySupplement(internalProducts, supplementProducts, limit) {
    const targetLimit = Math.max(1, Number(limit || 10));
    const priorityBuckets = ['base_makeup', 'eye_makeup', 'lip_makeup', 'skincare', 'tools', 'other'];
    const seen = new Set();
    const merged = [];
    const internal = Array.isArray(internalProducts) ? internalProducts : [];
    const supplement = Array.isArray(supplementProducts) ? supplementProducts : [];

    const addUnique = (product) => {
      const key = buildCacheProductKey(product);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(product);
    };

    for (const product of internal) addUnique(product);
    for (const product of supplement) addUnique(product);

    const queues = new Map(priorityBuckets.map((bucket) => [bucket, []]));
    for (const product of merged) {
      const bucket = classifyBeautyBucketFromProduct(product);
      if (!queues.has(bucket)) queues.set(bucket, []);
      queues.get(bucket).push(product);
    }

    const output = [];
    while (output.length < targetLimit) {
      let progressed = false;
      for (const bucket of priorityBuckets) {
        const queue = queues.get(bucket);
        if (!queue || queue.length === 0) continue;
        output.push(queue.shift());
        progressed = true;
        if (output.length >= targetLimit) break;
      }
      if (!progressed) break;
    }

    return output;
  }

  function buildPetHarnessSignalSql(startIndex) {
    const latin =
      '(harness|leash|collar|lead|no-?pull|dog\\s+harness|dog\\s+leash|pet\\s+harness|pet\\s+leash)';
    const cjk = '(背带|胸背|牵引|牵引绳|遛狗绳|狗链|项圈|胸背带|胴輪|ハーネス)';
    const re = `(\\m${latin}\\M|${cjk})`;
    const fields = [
      "coalesce(product_data->>'title','')",
      "coalesce(product_data->>'description','')",
      "coalesce(product_data->>'product_type','')",
    ];
    const idx = startIndex;
    const ors = fields.map((field) => `${field} ~* $${idx}`).join(' OR ');
    return { sql: `(${ors})`, params: [re], nextIndex: idx + 1 };
  }

  function buildBeautySignalSql(startIndex) {
    const latin =
      '(makeup|cosmetic|cosmetics|beauty|foundation|concealer|lipstick|blush|mascara|eyeshadow|brush|palette|toner|serum|skincare|perfume|fragrance|parfum|cologne|body\\s*mist|fenty|tom\\s*ford|winona|ipsa)';
    const cjk =
      '(化妆|化妝|美妆|美妝|彩妆|彩妝|底妆|底妝|粉底|遮瑕|口红|口紅|唇膏|腮红|眼影|睫毛膏|化妆刷|化妝刷|刷具|粉扑|美妆蛋|妆前|妝前|定妆|定妝|香水|体香喷雾|體香噴霧|薇诺娜|薇諾娜|茵芙莎|流金水)';
    const re = `(\\m${latin}\\M|${cjk})`;
    const fields = [
      "coalesce(product_data->>'title','')",
      "coalesce(product_data->>'description','')",
      "coalesce(product_data->>'product_type','')",
      "coalesce(product_data->>'vendor','')",
    ];
    const idx = startIndex;
    const ors = fields.map((field) => `${field} ~* $${idx}`).join(' OR ');
    return { sql: `(${ors})`, params: [re], nextIndex: idx + 1 };
  }

  async function searchCreatorSellableFromCache(creatorId, queryText, page = 1, limit = 20, options = {}) {
    const creatorConfig = getCreatorConfig(creatorId);
    if (
      !creatorConfig ||
      !Array.isArray(creatorConfig.merchantIds) ||
      creatorConfig.merchantIds.length === 0
    ) {
      const err = new Error('Unknown creator');
      err.code = 'UNKNOWN_CREATOR';
      throw err;
    }

    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(Math.max(1, Number(limit || 20)), SEARCH_LIMIT_MAX);
    const offset = (safePage - 1) * safeLimit;
    const q = String(queryText || '').trim().toLowerCase();
    const inStockOnly = options?.inStockOnly !== false;

    const baseWhere = `
      merchant_id = ANY($1)
      AND (expires_at IS NULL OR expires_at > now())
      AND ${buildSellableStatusPredicate("product_data->>'status'")}
    `;

    const terms = tokenizeQueryForCache(q);
    const skuLike = looksSkuLikeQuery(q);
    const { toy_intent, outfit_intent, lingerie_intent } = detectToyOutfitIntentFromQuery(q);
    const intentTarget = String(options?.intent?.target_object?.type || '').toLowerCase();

    const whereParts = [];
    const params = [creatorConfig.merchantIds];
    let idx = 2;

    if (terms.length === 0) {
      return loadCreatorSellableFromCache(creatorId, safePage, safeLimit, { inStockOnly });
    }

    const matchFields = [
      "lower(coalesce(product_data->>'title',''))",
      "lower(coalesce(product_data->>'description',''))",
      "lower(coalesce(product_data->>'product_type',''))",
      "lower(coalesce(product_data->>'sku',''))",
      "lower(coalesce(product_data->>'vendor',''))",
    ];

    for (const term of terms) {
      params.push(`%${term}%`);
      const ors = matchFields.map((field) => `${field} LIKE $${idx}`).join(' OR ');
      const termParts = [`(${ors})`];
      if (skuLike) {
        termParts.push(`lower(CAST(product_data AS TEXT)) LIKE $${idx}`);
      }
      whereParts.push(`(${termParts.join(' OR ')})`);
      idx += 1;
    }

    let underwearClause = null;
    let underwearParams = [];
    let afterUnderwearIdx = idx;
    const shouldExcludeUnderwear =
      !lingerie_intent &&
      ((toy_intent || outfit_intent) || intentTarget === 'pet' || intentTarget === 'human');

    if (shouldExcludeUnderwear) {
      const built = buildUnderwearExclusionSql(idx);
      underwearClause = built.sql;
      underwearParams = built.params;
      afterUnderwearIdx = built.nextIndex;
    }

    const queryWhere = whereParts.length ? `(${whereParts.join(' OR ')})` : 'TRUE';
    let petClause = null;
    let petParams = [];
    let afterPetIdx = afterUnderwearIdx;
    if (intentTarget === 'pet') {
      const built = buildPetSignalSql(afterUnderwearIdx);
      petClause = built.sql;
      petParams = built.params;
      afterPetIdx = built.nextIndex;
    }

    const finalWhere = [
      baseWhere,
      queryWhere,
      ...(underwearClause ? [underwearClause] : []),
      ...(petClause ? [petClause] : []),
    ].join(' AND ');

    const pageFetch = Math.min(Math.max(safeLimit * 3, 60), 300);
    const pageOffset = Math.max(0, offset);

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM products_cache
      WHERE ${finalWhere}
    `;

    const rowsSql = `
      SELECT product_data
      FROM products_cache
      WHERE ${finalWhere}
      ORDER BY cached_at DESC
      OFFSET $${afterPetIdx}
      LIMIT $${afterPetIdx + 1}
    `;

    const countParams = underwearClause
      ? petClause
        ? [...params, ...underwearParams, ...petParams]
        : [...params, ...underwearParams]
      : petClause
        ? [...params, ...petParams]
        : params;
    const rowsParams = underwearClause
      ? petClause
        ? [...params, ...underwearParams, ...petParams, pageOffset, pageFetch]
        : [...params, ...underwearParams, pageOffset, pageFetch]
      : petClause
        ? [...params, ...petParams, pageOffset, pageFetch]
        : [...params, pageOffset, pageFetch];

    const [countRes, rowsRes] = await Promise.all([
      query(countSql, countParams),
      query(rowsSql, rowsParams),
    ]);

    const total = Number(countRes.rows?.[0]?.total || 0);
    const rawProducts = (rowsRes.rows || []).map((row) => row.product_data).filter(Boolean);

    const lexicalScoreByKey = new Map();
    const scored = rawProducts
      .filter((product) => isProductSellable(product, { inStockOnly }))
      .map((product) => {
        const title = String(product.title || '').toLowerCase();
        const desc = String(product.description || '').toLowerCase();
        const ptype = String(product.product_type || product.productType || '').toLowerCase();
        const sku = String(product.sku || '').toLowerCase();
        const tags = Array.isArray(product.tags)
          ? product.tags.join(' ').toLowerCase()
          : String(product.tags || '').toLowerCase();
        const recTags = Array.isArray(product.recommendation_meta?.tags)
          ? product.recommendation_meta.tags.join(' ').toLowerCase()
          : '';
        const recFacets = product.recommendation_meta?.facets
          ? JSON.stringify(product.recommendation_meta.facets).toLowerCase()
          : '';
        const blob = `${title} ${ptype} ${sku} ${tags} ${recTags} ${recFacets} ${desc}`;

        let score = 0;
        for (const term of terms) {
          if (title.includes(term)) score += 3;
          else if (ptype.includes(term)) score += 2;
          else if (blob.includes(term)) score += 1;
        }
        score += scoreByTagFacetOverlap(terms, product).score;

        if (skuLike) {
          const q0 = q.replace(/[^a-z0-9-]+/g, '');
          if (q0 && sku === q0) score += 6;
          else if (q0 && blob.includes(q0)) score += 3;
        }

        if ((toy_intent || outfit_intent) && /\b(labubu|doll|plush|toy|outfit)\b/.test(blob)) {
          score += 1;
        }

        const toyLike =
          /\b(labubu|doll|vinyl face doll|blind box|plush|plushie|figure|collectible)\b/.test(blob) ||
          /盲盒|公仔|娃娃|娃衣/.test(blob);
        const petLike =
          /\b(dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets)\b/.test(blob) ||
          /\b(perro|perros|mascota|mascotas|gato|gatos)\b/.test(blob) ||
          /\b(chien|chiens|chat|chats|animal|animaux)\b/.test(blob) ||
          /狗|猫|宠物|犬服|猫服|ペット/.test(blob);

        if (intentTarget === 'human') {
          if (!toy_intent && !outfit_intent && toyLike) score -= 100;
          if (petLike) score -= 60;
        } else if (intentTarget === 'pet') {
          if (toyLike) score -= 100;
        } else if (intentTarget === 'toy') {
          if (petLike) score -= 40;
        }

        return { product, score, key: buildCacheProductKey(product) };
      })
      .sort((a, b) => b.score - a.score);

    for (const row of scored) {
      if (row?.key) lexicalScoreByKey.set(row.key, Number(row.score || 0));
    }

    const lexicalProducts = scored.slice(0, safeLimit).map((row) => row.product);
    const retrievalSources = [
      {
        source: 'lexical_cache',
        used: true,
        count: lexicalProducts.length,
        candidate_count: rawProducts.length,
      },
    ];

    if (lexicalProducts.length === 0) {
      try {
        const relaxedWhere = [
          'merchant_id = ANY($1)',
          queryWhere,
          ...(underwearClause ? [underwearClause] : []),
          ...(petClause ? [petClause] : []),
        ].join(' AND ');
        const relaxedRowsSql = `
          SELECT product_data
          FROM products_cache
          WHERE ${relaxedWhere}
          ORDER BY cached_at DESC NULLS LAST, id DESC
          OFFSET $${afterPetIdx}
          LIMIT $${afterPetIdx + 1}
        `;
        const relaxedRowsRes = await query(relaxedRowsSql, rowsParams);
        const relaxedProductsRaw = (relaxedRowsRes.rows || [])
          .map((row) => row.product_data)
          .filter(Boolean)
          .filter((product) => isProductSellable(product, { inStockOnly }));
        const seen = new Set();
        const relaxedProducts = [];
        for (const product of relaxedProductsRaw) {
          const key = buildCacheProductKey(product);
          if (seen.has(key)) continue;
          seen.add(key);
          relaxedProducts.push(product);
          if (relaxedProducts.length >= safeLimit) break;
        }
        retrievalSources.push({
          source: 'lexical_cache_relaxed',
          used: true,
          count: relaxedProducts.length,
          candidate_count: relaxedProductsRaw.length,
        });
        if (relaxedProducts.length > 0) {
          await applyShopifyCurrencyOverride(relaxedProducts);
          return {
            products: relaxedProducts,
            total: Math.max(total, relaxedProducts.length),
            page: safePage,
            page_size: safeLimit,
            merchantIds: creatorConfig.merchantIds,
            retrieval_sources: retrievalSources,
          };
        }
      } catch (err) {
        retrievalSources.push({
          source: 'lexical_cache_relaxed',
          used: false,
          error: String(err?.message || err),
        });
      }
    }

    if (lexicalProducts.length === 0 && intentTarget === 'pet') {
      try {
        let underwearClause2 = null;
        let underwearParams2 = [];
        let idx2 = 2;
        const shouldExcludeUnderwear2 =
          !lingerie_intent &&
          ((toy_intent || outfit_intent) || intentTarget === 'pet' || intentTarget === 'human');
        if (shouldExcludeUnderwear2) {
          const built = buildUnderwearExclusionSql(idx2);
          underwearClause2 = built.sql;
          underwearParams2 = built.params;
          idx2 = built.nextIndex;
        }
        const builtPet = buildPetSignalSql(idx2);
        const browseWhere = [baseWhere, ...(underwearClause2 ? [underwearClause2] : []), builtPet.sql].join(
          ' AND ',
        );
        const pageFetch2 = Math.min(Math.max(safeLimit * 4, 80), 300);
        const browseRes = await query(
          `
            SELECT product_data
            FROM products_cache
            WHERE ${browseWhere}
            ORDER BY cached_at DESC
            LIMIT $${builtPet.nextIndex}
          `,
          [creatorConfig.merchantIds, ...underwearParams2, ...builtPet.params, pageFetch2],
        );

        const browseProducts = (browseRes.rows || [])
          .map((row) => row.product_data)
          .filter(Boolean)
          .filter((product) => isProductSellable(product, { inStockOnly }))
          .slice(0, safeLimit);

        retrievalSources.push({
          source: 'pet_browse_fallback',
          used: true,
          count: browseProducts.length,
        });

        if (browseProducts.length > 0) {
          await applyShopifyCurrencyOverride(browseProducts);
          return {
            products: browseProducts,
            total: Math.max(total, browseProducts.length),
            page: safePage,
            page_size: safeLimit,
            merchantIds: creatorConfig.merchantIds,
            retrieval_sources: retrievalSources,
          };
        }
      } catch (err) {
        retrievalSources.push({
          source: 'pet_browse_fallback',
          used: false,
          error: String(err?.message || err),
        });
      }
    }

    if (lexicalProducts.length === 0 && hasBeautyMakeupSearchSignal(q)) {
      try {
        let underwearClause2 = null;
        let underwearParams2 = [];
        let idx2 = 2;
        const shouldExcludeUnderwear2 =
          !lingerie_intent &&
          ((toy_intent || outfit_intent) || intentTarget === 'pet' || intentTarget === 'human');
        if (shouldExcludeUnderwear2) {
          const built = buildUnderwearExclusionSql(idx2);
          underwearClause2 = built.sql;
          underwearParams2 = built.params;
          idx2 = built.nextIndex;
        }
        const builtBeauty = buildBeautySignalSql(idx2);
        const browseWhere = [
          baseWhere,
          ...(underwearClause2 ? [underwearClause2] : []),
          builtBeauty.sql,
        ].join(' AND ');
        const pageFetch2 = Math.min(Math.max(safeLimit * 4, 80), 300);
        const browseRes = await query(
          `
            SELECT product_data
            FROM products_cache
            WHERE ${browseWhere}
            ORDER BY cached_at DESC
            LIMIT $${builtBeauty.nextIndex}
          `,
          [creatorConfig.merchantIds, ...underwearParams2, ...builtBeauty.params, pageFetch2],
        );

        const browseProducts = (browseRes.rows || [])
          .map((row) => row.product_data)
          .filter(Boolean)
          .filter((product) => isProductSellable(product, { inStockOnly }))
          .slice(0, safeLimit);

        retrievalSources.push({
          source: 'beauty_browse_fallback',
          used: true,
          count: browseProducts.length,
        });

        if (browseProducts.length > 0) {
          await applyShopifyCurrencyOverride(browseProducts);
          return {
            products: browseProducts,
            total: Math.max(total, browseProducts.length),
            page: safePage,
            page_size: safeLimit,
            merchantIds: creatorConfig.merchantIds,
            retrieval_sources: retrievalSources,
          };
        }
      } catch (err) {
        retrievalSources.push({
          source: 'beauty_browse_fallback',
          used: false,
          error: String(err?.message || err),
        });
      }
    }

    const vectorEnabled =
      FIND_PRODUCTS_MULTI_VECTOR_ENABLED && HAS_DATABASE && safePage === 1;
    const intentLang = String(options?.intent?.language || '').toLowerCase();
    const shouldTryVector =
      vectorEnabled &&
      ((intentLang && intentLang !== 'en' && intentLang !== 'other') || lexicalProducts.length === 0);

    if (shouldTryVector) {
      try {
        const embedding = await embedText(queryText, { cache: true });
        const vecLimit = Math.min(Math.max(safeLimit * 6, 80), 240);
        const vecHits = await semanticSearchCreatorProductsFromCache({
          merchantIds: creatorConfig.merchantIds,
          queryVector: embedding.vector,
          dim: embedding.dim,
          provider: embedding.provider,
          model: embedding.model,
          limit: vecLimit,
          intentTarget,
          excludeUnderwear: shouldExcludeUnderwear,
        });

        const vectorScoreByKey = new Map();
        const vecProducts = vecHits
          .map((hit) => {
            const product = hit?.product || null;
            if (!product) return null;
            vectorScoreByKey.set(buildCacheProductKey(product), Number(hit.score || 0));
            return product;
          })
          .filter(Boolean)
          .filter((product) => isProductSellable(product, { inStockOnly }));

        retrievalSources.push({
          source: 'vector_cache',
          used: true,
          count: vecProducts.length,
          provider: embedding.provider,
          model: embedding.model,
          dim: embedding.dim,
        });

        const nonEnglishQuery = intentLang && intentLang !== 'en' && intentLang !== 'other';
        const shouldBlend =
          vecProducts.length > 0 &&
          (lexicalProducts.length < safeLimit || nonEnglishQuery || intentTarget === 'human' || intentTarget === 'pet');

        if (shouldBlend) {
          const seen = new Set();
          const merged = [];
          const lexicalTake = nonEnglishQuery
            ? Math.min(Math.ceil(safeLimit * 0.4), lexicalProducts.length)
            : lexicalProducts.length;

          for (const product of lexicalProducts.slice(0, lexicalTake)) {
            const key = buildCacheProductKey(product);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(product);
          }
          for (const product of vecProducts) {
            if (merged.length >= safeLimit) break;
            const key = buildCacheProductKey(product);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(product);
          }
          if (merged.length < safeLimit && lexicalTake < lexicalProducts.length) {
            for (const product of lexicalProducts.slice(lexicalTake)) {
              if (merged.length >= safeLimit) break;
              const key = buildCacheProductKey(product);
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(product);
            }
          }

          merged.sort((a, b) => {
            const ak = buildCacheProductKey(a);
            const bk = buildCacheProductKey(b);
            const aScore = (lexicalScoreByKey.get(ak) || 0) + (vectorScoreByKey.get(ak) || 0) * 4.0;
            const bScore = (lexicalScoreByKey.get(bk) || 0) + (vectorScoreByKey.get(bk) || 0) * 4.0;
            return bScore - aScore;
          });

          await applyShopifyCurrencyOverride(merged);
          return {
            products: merged,
            total: Math.max(total, merged.length),
            page: safePage,
            page_size: safeLimit,
            merchantIds: creatorConfig.merchantIds,
            retrieval_sources: retrievalSources,
          };
        }
      } catch (err) {
        retrievalSources.push({
          source: 'vector_cache',
          used: false,
          error: String(err?.message || err),
        });
      }
    }

    await applyShopifyCurrencyOverride(lexicalProducts);
    return {
      products: lexicalProducts,
      total,
      page: safePage,
      page_size: safeLimit,
      merchantIds: creatorConfig.merchantIds,
      retrieval_sources: retrievalSources,
    };
  }

  async function searchCrossMerchantFromCache(queryText, page = 1, limit = 20, options = {}) {
    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(Math.max(1, Number(limit || 20)), SEARCH_LIMIT_MAX);
    const offset = (safePage - 1) * safeLimit;
    const q = String(queryText || '').trim().toLowerCase();
    const inStockOnly = options?.inStockOnly !== false;

    const terms = tokenizeQueryForCache(q);
    if (terms.length === 0) {
      return loadCrossMerchantBrowseFromCache(safePage, safeLimit, { inStockOnly });
    }

    const skuLike = looksSkuLikeQuery(q);
    const buildQueryFilter = (fieldPrefix = 'pc.') => {
      const matchFields = [
        `lower(coalesce(${fieldPrefix}product_data->>'title',''))`,
        `lower(coalesce(${fieldPrefix}product_data->>'description',''))`,
        `lower(coalesce(${fieldPrefix}product_data->>'product_type',''))`,
        `lower(coalesce(${fieldPrefix}product_data->>'sku',''))`,
        `lower(coalesce(${fieldPrefix}product_data->>'vendor',''))`,
      ];
      const whereParts = [];
      const params = [];
      let idx = 1;
      for (const term of terms) {
        params.push(`%${term}%`);
        const ors = matchFields.map((field) => `${field} LIKE $${idx}`).join(' OR ');
        const termParts = [`(${ors})`];
        if (skuLike) {
          termParts.push(`lower(CAST(${fieldPrefix}product_data AS TEXT)) LIKE $${idx}`);
        }
        whereParts.push(`(${termParts.join(' OR ')})`);
        idx += 1;
      }
      return {
        params,
        idx,
        queryWhere: whereParts.length ? `(${whereParts.join(' OR ')})` : 'TRUE',
      };
    };

    const toRankedUniqueProducts = (rows = []) => {
      const rawProducts = (rows || [])
        .map((row) => {
          const product = row.product_data;
          if (!product) return null;
          const merchantId = String(row.merchant_id || '').trim();
          const merchantName = row.merchant_name ? String(row.merchant_name).trim() : '';
          const out = { ...product };
          if (merchantId && !out.merchant_id && !out.merchantId) out.merchant_id = merchantId;
          if (merchantName && !out.merchant_name && !out.merchantName) out.merchant_name = merchantName;
          return out;
        })
        .filter(Boolean)
        .filter((product) => isProductSellable(product, { inStockOnly }));

      const scored = rawProducts
        .map((product) => {
          const title = String(product.title || '').toLowerCase();
          const desc = String(product.description || '').toLowerCase();
          const ptype = String(product.product_type || product.productType || '').toLowerCase();
          const sku = String(product.sku || '').toLowerCase();
          const tags = Array.isArray(product.tags)
            ? product.tags.join(' ').toLowerCase()
            : String(product.tags || '').toLowerCase();
          const blob = `${title} ${ptype} ${sku} ${tags} ${desc}`;

          let score = 0;
          for (const term of terms) {
            if (title.includes(term)) score += 3;
            else if (ptype.includes(term)) score += 2;
            else if (blob.includes(term)) score += 1;
          }
          score += scoreByTagFacetOverlap(terms, product).score;
          if (skuLike) {
            const q0 = q.replace(/[^a-z0-9-]+/g, '');
            if (q0 && sku === q0) score += 6;
            else if (q0 && blob.includes(q0)) score += 3;
          }
          return { product, score };
        })
        .sort((a, b) => b.score - a.score);

      const seen = new Set();
      const unique = [];
      for (const row of scored) {
        const key = buildCacheProductKey(row.product);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row.product);
        if (unique.length >= safeLimit) break;
      }
      return { products: unique, candidateCount: rawProducts.length };
    };

    const strictFilter = buildQueryFilter('pc.');
    const baseWhere = `
      (pc.expires_at IS NULL OR pc.expires_at > now())
      AND ${buildSellableStatusPredicate("pc.product_data->>'status'")}
      AND mo.status NOT IN ('deleted', 'rejected')
      AND mo.psp_connected = true
    `;

    const pageFetch = Math.min(Math.max(safeLimit * 4, 80), 400);
    const pageOffset = Math.max(0, offset);
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM products_cache pc
      JOIN merchant_onboarding mo
        ON mo.merchant_id = pc.merchant_id
      WHERE ${baseWhere}
        AND ${strictFilter.queryWhere}
    `;
    const rowsSql = `
      SELECT pc.merchant_id,
             mo.business_name AS merchant_name,
             pc.product_data
      FROM products_cache pc
      JOIN merchant_onboarding mo
        ON mo.merchant_id = pc.merchant_id
      WHERE ${baseWhere}
        AND ${strictFilter.queryWhere}
      ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
      OFFSET $${strictFilter.idx}
      LIMIT $${strictFilter.idx + 1}
    `;

    const retrievalSources = [];
    const [countRes, rowsRes] = await Promise.all([
      query(countSql, strictFilter.params),
      query(rowsSql, [...strictFilter.params, pageOffset, pageFetch]),
    ]);

    const strictTotal = Number(countRes.rows?.[0]?.total || 0);
    const strictRanked = toRankedUniqueProducts(rowsRes.rows || []);
    retrievalSources.push({
      source: 'lexical_cache',
      used: true,
      count: strictRanked.products.length,
      candidate_count: strictRanked.candidateCount,
      total: strictTotal,
    });

    if (strictRanked.products.length > 0) {
      await applyShopifyCurrencyOverride(strictRanked.products);
      return {
        products: strictRanked.products,
        total: strictTotal,
        page: safePage,
        page_size: strictRanked.products.length,
        retrieval_sources: retrievalSources,
      };
    }

    try {
      const relaxedFilter = buildQueryFilter('');
      const relaxedBaseWhere = `
        (expires_at IS NULL OR expires_at > now())
        AND ${buildSellableStatusPredicate("product_data->>'status'")}
        AND COALESCE(lower(product_data->>'orderable'), 'true') <> 'false'
      `;
      const relaxedCountSql = `
        SELECT COUNT(*)::int AS total
        FROM products_cache
        WHERE ${relaxedBaseWhere}
          AND ${relaxedFilter.queryWhere}
      `;
      const relaxedRowsSql = `
        SELECT merchant_id,
               NULL::text AS merchant_name,
               product_data
        FROM products_cache
        WHERE ${relaxedBaseWhere}
          AND ${relaxedFilter.queryWhere}
        ORDER BY cached_at DESC NULLS LAST, id DESC
        OFFSET $${relaxedFilter.idx}
        LIMIT $${relaxedFilter.idx + 1}
      `;
      const [relaxedCountRes, relaxedRowsRes] = await Promise.all([
        query(relaxedCountSql, relaxedFilter.params),
        query(relaxedRowsSql, [...relaxedFilter.params, pageOffset, pageFetch]),
      ]);
      const relaxedTotal = Number(relaxedCountRes.rows?.[0]?.total || 0);
      const relaxedRanked = toRankedUniqueProducts(relaxedRowsRes.rows || []);
      retrievalSources.push({
        source: 'lexical_cache_relaxed_no_onboarding',
        used: true,
        count: relaxedRanked.products.length,
        candidate_count: relaxedRanked.candidateCount,
        total: relaxedTotal,
      });

      if (relaxedRanked.products.length === 0 && hasPetSearchSignal(q)) {
        const petSignalFilter = hasPetHarnessSearchSignal(q)
          ? buildPetHarnessSignalSql(1)
          : buildPetSignalSql(1);
        const petRowsSql = `
          SELECT pc.merchant_id,
                 mo.business_name AS merchant_name,
                 pc.product_data
          FROM products_cache pc
          JOIN merchant_onboarding mo
            ON mo.merchant_id = pc.merchant_id
          WHERE ${baseWhere}
            AND ${petSignalFilter.sql}
          ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
          OFFSET $${petSignalFilter.nextIndex}
          LIMIT $${petSignalFilter.nextIndex + 1}
        `;
        const petRowsRes = await query(petRowsSql, [...petSignalFilter.params, pageOffset, pageFetch]);
        const petRanked = toRankedUniqueProducts(petRowsRes.rows || []);
        retrievalSources.push({
          source: hasPetHarnessSearchSignal(q)
            ? 'pet_harness_browse_fallback'
            : 'pet_browse_fallback',
          used: true,
          count: petRanked.products.length,
          candidate_count: petRanked.candidateCount,
        });

        if (petRanked.products.length > 0) {
          await applyShopifyCurrencyOverride(petRanked.products);
          return {
            products: petRanked.products,
            total: Math.max(strictTotal, relaxedTotal, petRanked.products.length),
            page: safePage,
            page_size: petRanked.products.length,
            retrieval_sources: retrievalSources,
          };
        }
      }

      if (relaxedRanked.products.length === 0 && hasBeautyMakeupSearchSignal(q)) {
        const beautySignalFilter = buildBeautySignalSql(1);
        const beautyRowsSql = `
          SELECT pc.merchant_id,
                 mo.business_name AS merchant_name,
                 pc.product_data
          FROM products_cache pc
          JOIN merchant_onboarding mo
            ON mo.merchant_id = pc.merchant_id
          WHERE ${baseWhere}
            AND ${beautySignalFilter.sql}
          ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
          OFFSET $${beautySignalFilter.nextIndex}
          LIMIT $${beautySignalFilter.nextIndex + 1}
        `;
        const beautyRowsRes = await query(
          beautyRowsSql,
          [...beautySignalFilter.params, pageOffset, pageFetch],
        );
        const beautyRanked = toRankedUniqueProducts(beautyRowsRes.rows || []);
        retrievalSources.push({
          source: 'beauty_browse_fallback',
          used: true,
          count: beautyRanked.products.length,
          candidate_count: beautyRanked.candidateCount,
        });

        if (beautyRanked.products.length > 0) {
          await applyShopifyCurrencyOverride(beautyRanked.products);
          return {
            products: beautyRanked.products,
            total: Math.max(strictTotal, relaxedTotal, beautyRanked.products.length),
            page: safePage,
            page_size: beautyRanked.products.length,
            retrieval_sources: retrievalSources,
          };
        }
      }

      await applyShopifyCurrencyOverride(relaxedRanked.products);
      return {
        products: relaxedRanked.products,
        total: Math.max(strictTotal, relaxedTotal, relaxedRanked.products.length),
        page: safePage,
        page_size: relaxedRanked.products.length,
        retrieval_sources: retrievalSources,
      };
    } catch (err) {
      retrievalSources.push({
        source: 'lexical_cache_relaxed_no_onboarding',
        used: false,
        error: String(err?.message || err),
      });
      return {
        products: [],
        total: strictTotal,
        page: safePage,
        page_size: 0,
        retrieval_sources: retrievalSources,
      };
    }
  }

  async function loadCrossMerchantBrowseFromCache(page = 1, limit = 20, options = {}) {
    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(Math.max(1, Number(limit || 20)), SEARCH_LIMIT_MAX);
    const inStockOnly = options?.inStockOnly !== false;
    const fetchLimit = Math.min(Math.max(safeLimit * Math.max(safePage, 1) * 5 + 20, 50), 500);

    const rowsRes = await query(
      `
        SELECT pc.merchant_id,
               mo.business_name AS merchant_name,
               pc.product_data
        FROM (
          SELECT id, expires_at, merchant_id, product_data
          FROM products_cache
          WHERE expires_at > now()
            AND ${buildSellableStatusPredicate("product_data->>'status'")}
          ORDER BY expires_at DESC, id DESC
          LIMIT $1
        ) pc
        JOIN merchant_onboarding mo
          ON mo.merchant_id = pc.merchant_id
        WHERE mo.status NOT IN ('deleted', 'rejected')
          AND mo.psp_connected = true
        ORDER BY pc.expires_at DESC, pc.id DESC
      `,
      [fetchLimit],
    );

    const baseProducts = (rowsRes.rows || [])
      .map((row) => {
        const product = row.product_data;
        if (!product) return null;
        const merchantId = String(row.merchant_id || '').trim();
        const merchantName = row.merchant_name ? String(row.merchant_name).trim() : '';
        const out = { ...product };
        if (merchantId && !out.merchant_id && !out.merchantId) out.merchant_id = merchantId;
        if (merchantName && !out.merchant_name && !out.merchantName) out.merchant_name = merchantName;
        return out;
      })
      .filter(Boolean)
      .filter((product) => isProductSellable(product, { inStockOnly }));

    const seen = new Set();
    const unique = [];
    for (const product of baseProducts) {
      const key = buildCacheProductKey(product);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(product);
    }

    const startIdx = (safePage - 1) * safeLimit;
    const pageItems = unique.slice(startIdx, startIdx + safeLimit);
    await applyShopifyCurrencyOverride(pageItems);

    return {
      products: pageItems,
      total: unique.length,
      page: safePage,
      page_size: pageItems.length,
    };
  }

  async function loadMerchantBrowseFromCache(merchantId, page = 1, limit = 20, options = {}) {
    const mid = String(merchantId || '').trim();
    if (!mid) return { products: [], total: 0, page: 1, page_size: 0 };

    const safePage = Math.max(1, Number(page || 1));
    const safeLimit = Math.min(Math.max(1, Number(limit || 20)), SEARCH_LIMIT_MAX);
    const inStockOnly = options?.inStockOnly !== false;
    const fetchLimit = Math.min(Math.max(safeLimit * Math.max(safePage, 1) * 6 + 30, 60), 600);

    const rowsRes = await query(
      `
        SELECT pc.id,
               pc.merchant_id,
               mo.business_name AS merchant_name,
               pc.product_data
        FROM products_cache pc
        JOIN merchant_onboarding mo
          ON mo.merchant_id = pc.merchant_id
        WHERE pc.merchant_id = $1
          AND (pc.expires_at IS NULL OR pc.expires_at > now())
          AND ${buildSellableStatusPredicate("pc.product_data->>'status'")}
          AND mo.status NOT IN ('deleted', 'rejected')
          AND mo.psp_connected = true
        ORDER BY pc.cached_at DESC NULLS LAST, pc.id DESC
        LIMIT $2
      `,
      [mid, fetchLimit],
    );

    const baseProducts = (rowsRes.rows || [])
      .map((row) => {
        const product = row.product_data;
        if (!product) return null;
        const merchantName = row.merchant_name ? String(row.merchant_name).trim() : '';
        const out = { ...product };
        if (!out.merchant_id && !out.merchantId) out.merchant_id = mid;
        if (merchantName && !out.merchant_name && !out.merchantName) out.merchant_name = merchantName;
        return out;
      })
      .filter(Boolean)
      .filter((product) => isProductSellable(product, { inStockOnly }));

    const seen = new Set();
    const unique = [];
    for (const product of baseProducts) {
      const key = buildCacheProductKey({ ...product, merchant_id: mid });
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(product);
    }

    const startIdx = (safePage - 1) * safeLimit;
    const pageItems = unique.slice(startIdx, startIdx + safeLimit);
    await applyShopifyCurrencyOverride(pageItems);

    return {
      products: pageItems,
      total: unique.length,
      page: safePage,
      page_size: pageItems.length,
    };
  }

  function buildPetFallbackQuery(intent, rawUserQuery) {
    const lang = intent?.language || 'en';
    const queryText = String(rawUserQuery || '');
    const wantsHarness = hasPetHarnessSearchSignal(queryText);
    switch (lang) {
      case 'zh':
        return wantsHarness ? '狗 狗狗 宠物 背带 牵引绳 狗链' : '狗 狗狗 宠物 外套 衣服';
      case 'es':
        return wantsHarness ? 'perro arnes correa collar' : 'perro ropa abrigo chaqueta';
      case 'fr':
        return wantsHarness ? 'chien harnais laisse collier' : 'chien vêtement manteau veste';
      case 'ja':
        return wantsHarness ? '犬 ハーネス リード 首輪' : '犬 犬服 服';
      default:
        return wantsHarness ? 'dog harness dog leash dog collar' : 'dog jacket dog clothes';
    }
  }

  async function loadCreatorProductFromCache(creatorId, productId) {
    const creatorConfig = getCreatorConfig(creatorId);
    if (
      !creatorConfig ||
      !Array.isArray(creatorConfig.merchantIds) ||
      creatorConfig.merchantIds.length === 0
    ) {
      return null;
    }
    const pid = String(productId || '').trim();
    if (!pid) return null;

    const res = await query(
      `
        SELECT product_data
        FROM products_cache
        WHERE merchant_id = ANY($1)
          AND (expires_at IS NULL OR expires_at > now())
          AND (
            product_data->>'id' = $2
            OR product_data->>'product_id' = $2
            OR product_data->>'productId' = $2
          )
        ORDER BY cached_at DESC
        LIMIT 1
      `,
      [creatorConfig.merchantIds, pid],
    );
    return res.rows?.[0]?.product_data || null;
  }

  async function findSimilarCreatorFromCache(creatorId, productId, limit = 9) {
    const base = await loadCreatorProductFromCache(creatorId, productId);
    if (!base) return null;

    const baseTitle = String(base.title || '').toLowerCase();
    const baseDesc = String(base.description || '').toLowerCase();
    const baseType = String(base.product_type || base.productType || '').toLowerCase();
    const baseTags = Array.isArray(base.tags)
      ? base.tags.join(' ').toLowerCase()
      : String(base.tags || '').toLowerCase();
    const baseRecTags = Array.isArray(base.recommendation_meta?.tags)
      ? base.recommendation_meta.tags.join(' ').toLowerCase()
      : '';
    const baseRecFacets = base.recommendation_meta?.facets
      ? JSON.stringify(base.recommendation_meta.facets).toLowerCase()
      : '';
    const baseBlob = `${baseTitle} ${baseType} ${baseTags} ${baseRecTags} ${baseRecFacets} ${baseDesc}`.trim();

    const baseToy = /\b(labubu|doll|plush|toy|collectible)\b/.test(baseBlob);
    const baseUnderwear =
      /\b(lingerie|underwear|bra|pant(y|ies)|thong|sleepwear|nightgown|nightdress)\b/.test(
        baseBlob,
      );

    const anchor = [];
    if (baseBlob.includes('labubu')) anchor.push('labubu');
    if (/\bdoll\b/.test(baseBlob)) anchor.push('doll');
    if (/\boutfit\b/.test(baseBlob)) anchor.push('outfit');
    if (anchor.length === 0) {
      const tagTokens = [];
      if (Array.isArray(base.tags)) tagTokens.push(...base.tags);
      if (Array.isArray(base.recommendation_meta?.tags)) {
        tagTokens.push(...base.recommendation_meta.tags);
      }
      const facets = base.recommendation_meta?.facets || {};
      for (const value of Object.values(facets)) {
        if (!value) continue;
        if (Array.isArray(value)) tagTokens.push(...value);
        else tagTokens.push(value);
      }
      anchor.push(...tokenizeQueryForCache(tagTokens.join(' ')).slice(0, 6));
      if (anchor.length < 3) {
        anchor.push(...tokenizeQueryForCache(baseTitle).slice(0, 3));
      }
    }

    const queryText = anchor.join(' ');
    const found = await searchCreatorSellableFromCache(
      creatorId,
      queryText,
      1,
      Math.min(Math.max(6, limit * 3), 60),
    );
    const candidates = (found.products || []).filter(
      (product) => String(product.id || product.product_id || '') !== String(productId),
    );

    const filtered = candidates.filter((product) => {
      const text = `${String(product.title || '').toLowerCase()} ${String(
        product.description || '',
      ).toLowerCase()} ${String(product.product_type || product.productType || '').toLowerCase()}`;
      const isUnderwear =
        /\b(lingerie|underwear|bra|pant(y|ies)|thong|sleepwear|nightgown|nightdress)\b/.test(
          text,
        );
      if (baseToy && !baseUnderwear && isUnderwear) return false;
      return true;
    });

    const ranked = filtered
      .map((product) => ({ product, score: scorePairOverlap(base, product).score }))
      .sort((a, b) => b.score - a.score)
      .map((row) => row.product);

    return {
      base_product_id: String(productId),
      strategy_used: 'cache_creator_similar',
      items: ranked
        .slice(0, Math.max(1, Number(limit || 9)))
        .map((product) => ({ product })),
    };
  }

  return {
    loadCreatorSellableFromCache,
    buildPetSignalSql,
    hasPetSearchSignal,
    hasPetHarnessSearchSignal,
    hasPetLeashSearchSignal,
    hasStrictPetHarnessCatalogSignal,
    hasBeautyMakeupSearchSignal,
    hasBeautyCatalogProductSignal,
    isBeautyGeneralDiversitySupplementCandidate,
    blendBeautyDiversitySupplement,
    searchCreatorSellableFromCache,
    searchCrossMerchantFromCache,
    loadCrossMerchantBrowseFromCache,
    loadMerchantBrowseFromCache,
    buildPetFallbackQuery,
    findSimilarCreatorFromCache,
  };
}

module.exports = {
  createCatalogCacheRuntime,
};

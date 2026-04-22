const {
  createBeautyExpertV1Response,
  normalizeBeautyRequestBlock,
} = require('../../contracts/beautyExpertContracts');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = pickFirstTrimmed(...value);
      if (nested) return nested;
      continue;
    }
    const token = asString(value);
    if (token) return token;
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeSourceToken(value) {
  return normalizeText(value).replace(/[\s_]+/g, '-');
}

function cloneJsonSafe(value, fallback) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      values
        .map((item) => asString(item).toLowerCase())
        .filter(Boolean),
    ),
  );
}

const BEAUTY_KEYWORD_PATTERN =
  /\b(beauty|skin|skincare|routine|sunscreen|spf|moisturizer|moisturiser|cleanser|serum|toner|essence|retinol|retinoid|barrier|acne|pore|oily|dry|sensitive|hydration|dewy|matte|makeup pilling|pilling|eczema|rosacea)\b/i;

function extractLatestUserText(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (normalizeText(item?.role) !== 'user') continue;
    const content = asString(item?.content);
    if (content) return content;
  }
  return '';
}

function extractCards(response = {}) {
  if (Array.isArray(response.cards)) return response.cards;
  if (Array.isArray(response.cards_v1)) return response.cards_v1;
  if (Array.isArray(response.chat_cards)) return response.chat_cards;
  return [];
}

function extractRecommendationProducts(response = {}) {
  if (Array.isArray(response.products) && response.products.length > 0) {
    return response.products.filter((row) => isPlainObject(row));
  }
  const cards = extractCards(response);
  const recoCard = cards.find((card) => {
    const type = normalizeText(card?.type || card?.card_type);
    return type === 'recommendations';
  });
  const sections = Array.isArray(recoCard?.sections) ? recoCard.sections : [];
  const rows = [];
  for (const section of sections) {
    const products = Array.isArray(section?.products) ? section.products : [];
    for (const product of products) {
      if (isPlainObject(product)) rows.push(product);
    }
  }
  return rows;
}

function inferAuthorityStatus(response = {}, metadata = {}) {
  return (
    pickFirstTrimmed(
      response?.mainline_status,
      response?.recommendation_meta?.mainline_status,
      response?.metadata?.mainline_status,
      metadata?.mainline_status,
      metadata?.recommendation_mainline_status,
    ) || null
  );
}

function buildAxisFromReason(reason = '', index = 0) {
  const normalized = normalizeText(reason);
  if (!normalized) return null;
  if (
    /\b(not|don't|do not|without)\b[^.]{0,32}\btoo\b[^.]{0,16}\b(dewy|matte)\b/.test(normalized) ||
    /\bbetween\b[^.]{0,48}\bmatte\b[^.]{0,48}\bdewy\b/.test(normalized) ||
    /\bbetween\b[^.]{0,48}\bdewy\b[^.]{0,48}\bmatte\b/.test(normalized)
  ) {
    return { id: `axis_${index + 1}`, label: 'lighter / smoother finish' };
  }
  if (/\bmineral|sensitive\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'mineral / sensitive-skin' };
  }
  if (/\bserum-like|serum like|fluid\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'serum-like / thinner feel' };
  }
  if (/\bmatte|shine|oil-control|oil control|less slip\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'matte / shine control' };
  }
  if (/\bdewy|hydrat|moistur|fresh|cushion|cream\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'more hydration / dewier finish' };
  }
  if (/\blight|lighter|smooth|weightless|sheer|thin|under makeup|under-makeup\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'lighter / smoother finish' };
  }
  return {
    id: `axis_${index + 1}`,
    label: reason.length > 72 ? `${reason.slice(0, 69)}...` : reason,
  };
}

function buildCompareAxes(products = []) {
  return products
    .slice(0, 4)
    .map((product, index) =>
      buildAxisFromReason(
        pickFirstTrimmed(product?.why_this_one, product?.short_description, product?.description),
        index,
      ),
    )
    .filter(Boolean);
}

function normalizeRecoProduct(product = {}) {
  if (!isPlainObject(product)) return null;
  const productId = pickFirstTrimmed(product.product_id, product.id);
  const name = pickFirstTrimmed(product.name, product.title);
  if (!productId && !name) return null;

  let price = null;
  let currency = null;
  if (isPlainObject(product.price)) {
    const parsed = Number(product.price.amount ?? product.price.value ?? product.price.major);
    price = Number.isFinite(parsed) ? parsed : null;
    currency = pickFirstTrimmed(product.price.currency, product.currency);
  } else {
    const parsed = Number(product.price);
    price = Number.isFinite(parsed) ? parsed : null;
    currency = pickFirstTrimmed(product.currency);
  }

  return {
    ...(productId ? { product_id: productId } : {}),
    ...(pickFirstTrimmed(product.merchant_id) ? { merchant_id: pickFirstTrimmed(product.merchant_id) } : {}),
    ...(pickFirstTrimmed(product.product_group_id) ? { product_group_id: pickFirstTrimmed(product.product_group_id) } : {}),
    ...(name ? { name } : {}),
    ...(pickFirstTrimmed(product.brand) ? { brand: pickFirstTrimmed(product.brand) } : {}),
    ...(pickFirstTrimmed(product.image_url) ? { image_url: pickFirstTrimmed(product.image_url) } : {}),
    ...(price != null ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...(pickFirstTrimmed(product.why_this_one, product.short_description, product.description)
      ? { why_this_one: pickFirstTrimmed(product.why_this_one, product.short_description, product.description) }
      : {}),
    ...(product.pdp_open != null ? { pdp_open: cloneJsonSafe(product.pdp_open, null) } : {}),
    ...(pickFirstTrimmed(product.authority_status, product.grounding_status)
      ? { authority_status: pickFirstTrimmed(product.authority_status, product.grounding_status) }
      : {}),
  };
}

function buildRecoBundle(products = [], authorityStatus = null) {
  const rows = products.map(normalizeRecoProduct).filter(Boolean);
  return {
    lead_picks: rows.length > 0 ? [rows[0]] : [],
    support_picks: rows.slice(1, 4),
    comparison_mode: rows.length > 1 ? 'same_type_compare' : rows.length === 1 ? 'single_pick' : 'none',
    authority_status: authorityStatus,
  };
}

function extractBeautyRequest(input = {}) {
  const context = isPlainObject(input.context) ? input.context : {};
  const normalizedNeed = isPlainObject(context.normalized_need) ? context.normalized_need : {};
  const beautyRequest = isPlainObject(normalizedNeed.beauty_request)
    ? normalizeBeautyRequestBlock(normalizedNeed.beauty_request)
    : {
        domain: null,
        user_goal: null,
        skin_context: {},
        routine_context: {},
        product_context: {},
        scenario_context: {},
        constraints: {},
        analysis_requested: false,
      };
  const metadata = isPlainObject(input.metadata) ? input.metadata : {};
  const payload = isPlainObject(input.payload) ? input.payload : {};
  const payloadSearch = isPlainObject(payload.search) ? payload.search : {};
  const userGoal =
    pickFirstTrimmed(
      beautyRequest.user_goal,
      input.query_text,
      payloadSearch.query,
      payload.query,
      metadata.query,
      context.raw_user_goal,
      extractLatestUserText(input.messages),
    ) || null;

  return {
    ...beautyRequest,
    user_goal: userGoal,
  };
}

function inferMissingContext(beautyRequest, queryText) {
  const missing = [];
  const normalizedQuery = normalizeText(queryText);
  const skinContext = isPlainObject(beautyRequest.skin_context) ? beautyRequest.skin_context : {};
  const constraints = isPlainObject(beautyRequest.constraints) ? beautyRequest.constraints : {};
  if (!pickFirstTrimmed(skinContext.skin_type, skinContext.skinType) && !/\b(oily|dry|sensitive|combination|acne-prone|acne prone)\b/.test(normalizedQuery)) {
    missing.push('skin_type');
  }
  if (!pickFirstTrimmed(constraints.location, constraints.climate) && /\b(what should i buy|what should i use|recommend)\b/.test(normalizedQuery)) {
    missing.push('environment');
  }
  return missing;
}

function inferBeautyMode({ taskType, beautyRequest, queryText, response } = {}) {
  const normalizedQuery = normalizeText(queryText);
  const productContext = isPlainObject(beautyRequest?.product_context) ? beautyRequest.product_context : {};
  const missingContext = inferMissingContext(beautyRequest, queryText);
  const explicitCategoryPattern =
    /\b(sunscreen|spf|moisturizer|moisturiser|cleanser|serum|toner|essence|retinol|retinoid|mask|balm|oil|cream|lotion)\b/;
  const genericGuidancePattern =
    /\bwhat should i (use|buy)\b(?:[^.]{0,24}\bfor my skin\b)?|\bhelp my skin\b|\bfor my skin\b/;
  const hasExplicitCategory = explicitCategoryPattern.test(normalizedQuery);
  const isGenericGuidanceAsk = genericGuidancePattern.test(normalizedQuery);
  if (
    String(taskType || '').trim() === 'exact_product' ||
    pickFirstTrimmed(productContext.product_id, productContext.product_group_id, productContext.canonical_product_ref)
  ) {
    return 'exact_product_assist';
  }
  if (!hasExplicitCategory && isGenericGuidanceAsk && missingContext.length > 0) {
    return 'guided_beauty_reco';
  }
  if (
    Array.isArray(response?.products) && response.products.length > 0 &&
    (/\b(compare|comparison|which)\b/.test(normalizedQuery) || hasExplicitCategory)
  ) {
    return 'category_compare';
  }
  if (
    /\b(compare|comparison|which)\b/.test(normalizedQuery) ||
    hasExplicitCategory
  ) {
    return 'category_compare';
  }
  return 'guided_beauty_reco';
}

function isBeautyRequest({ beautyRequest, metadata, context, queryText, response } = {}) {
  if (beautyRequest?.domain === 'beauty') return true;
  if (normalizeText(metadata?.catalog_surface) === 'beauty') return true;
  if (normalizeText(context?.vertical) === 'beauty') return true;
  if (
    normalizeText(response?.metadata?.decision_owner) === 'shopping_agent_beauty_mainline' ||
    normalizeText(response?.metadata?.semantic_owner) === 'shopping_agent_beauty_mainline'
  ) {
    return true;
  }
  return BEAUTY_KEYWORD_PATTERN.test(queryText || '');
}

function buildAnalysisSummary(beautyRequest = {}, queryText = '', products = []) {
  const skinContext = isPlainObject(beautyRequest.skin_context) ? beautyRequest.skin_context : {};
  const routineContext = isPlainObject(beautyRequest.routine_context) ? beautyRequest.routine_context : {};
  const scenarioContext = isPlainObject(beautyRequest.scenario_context) ? beautyRequest.scenario_context : {};
  return {
    user_goal: beautyRequest.user_goal || queryText || null,
    known_skin_context: cloneJsonSafe(skinContext, {}),
    routine_context: cloneJsonSafe(routineContext, {}),
    scenario_context: cloneJsonSafe(scenarioContext, {}),
    missing_context: inferMissingContext(beautyRequest, queryText),
    product_count: Array.isArray(products) ? products.length : 0,
  };
}

function buildConfidence(response = {}, analysisSummary = {}) {
  const authorityStatus = inferAuthorityStatus(response, response?.metadata || {});
  const missingCount = Array.isArray(analysisSummary.missing_context)
    ? analysisSummary.missing_context.length
    : 0;
  let level = 'low';
  if (authorityStatus === 'grounded_success' && missingCount === 0) level = 'high';
  else if (authorityStatus && authorityStatus !== 'empty' && authorityStatus !== 'needs_more_context') level = 'medium';
  return {
    level,
    reason_codes: uniqueStrings([
      authorityStatus || '',
      missingCount > 0 ? 'missing_context' : '',
    ]),
  };
}

function buildNextActions({ mode, beautyRequest, analysisSummary, products } = {}) {
  const nextActions = [];
  const missingContext = Array.isArray(analysisSummary?.missing_context)
    ? analysisSummary.missing_context
    : [];

  if (missingContext.length > 0) {
    nextActions.push({
      type: 'consider_skin_analysis',
      label: 'Consider skin analysis for a more precise recommendation',
      payload: {
        reason: missingContext.join(','),
      },
    });
  }

  if (mode === 'exact_product_assist' && products[0]) {
    nextActions.push({
      type: 'open_pdp',
      label: 'View product details',
      payload: {
        product_id: pickFirstTrimmed(products[0].product_id, products[0].id),
        merchant_id: pickFirstTrimmed(products[0].merchant_id),
      },
    });
  }

  if (products.length > 1) {
    nextActions.push({
      type: 'compare_same_type',
      label: 'Compare similar options',
      payload: {
        product_ids: products
          .map((product) => pickFirstTrimmed(product.product_id, product.id))
          .filter(Boolean)
          .slice(0, 4),
      },
    });
    nextActions.push({
      type: 'show_alternatives',
      label: 'See alternatives',
    });
  }

  if (mode === 'guided_beauty_reco' && missingContext.length > 0) {
    nextActions.push({
      type: 'ask_missing_constraint',
      label: 'Add more skin context',
      payload: {
        missing_context: missingContext,
      },
    });
  }

  return nextActions;
}

function buildBeautyExpertV1Response({
  source = null,
  entryLayer = null,
  delegatedLayer = null,
  projectionType = 'normalized_only',
  taskType = null,
  context = {},
  metadata = {},
  payload = {},
  messages = [],
  response = {},
} = {}) {
  const beautyRequest = extractBeautyRequest({
    context,
    metadata,
    payload,
    messages,
  });
  const queryText = beautyRequest.user_goal || '';
  if (!isBeautyRequest({ beautyRequest, metadata, context, queryText, response })) return null;
  const normalizedBeautyIntent = normalizeBeautyRequestBlock({
    ...beautyRequest,
    domain: 'beauty',
    user_goal: beautyRequest.user_goal || queryText || null,
  });

  const products = extractRecommendationProducts(response);
  const mode = inferBeautyMode({
    taskType,
    beautyRequest: normalizedBeautyIntent,
    queryText,
    response: { products },
  });
  const authorityStatus = inferAuthorityStatus(response, metadata);
  const analysisSummary = buildAnalysisSummary(normalizedBeautyIntent, queryText, products);
  const confidence = buildConfidence(response, analysisSummary);
  const compareAxes = buildCompareAxes(products);
  const nextActions = buildNextActions({
    mode,
    beautyRequest,
    analysisSummary,
    products,
  });
  const delegatedLayerResolved =
    delegatedLayer || (mode === 'exact_product_assist' ? 'execution_facing' : 'decisioning');
  const cards = extractCards(response);

  return createBeautyExpertV1Response({
    mode,
    beauty_intent: normalizedBeautyIntent,
    analysis_summary: analysisSummary,
    recommendation_scope: {
      request_kind: mode,
      comparison_mode: products.length > 1 ? 'same_type_compare' : products.length === 1 ? 'single_pick' : 'none',
      final_authority_status: authorityStatus,
    },
    reco_bundle: buildRecoBundle(products, authorityStatus),
    compare_axes: compareAxes,
    confidence,
    next_actions: nextActions,
    delegation_trace: {
      source_profile: normalizeSourceToken(source),
      entry_layer: entryLayer || null,
      beauty_capability_invoked: true,
      beauty_mode: mode,
      delegated_layer: delegatedLayerResolved,
      analysis_suggestion_reason:
        Array.isArray(analysisSummary.missing_context) && analysisSummary.missing_context.length > 0
          ? analysisSummary.missing_context.join(',')
          : null,
      final_authority_status: authorityStatus,
      projection_type: projectionType,
    },
    ui_projections:
      projectionType === 'aurora_cards' && cards.length > 0
        ? {
            aurora_cards: cloneJsonSafe(cards, []),
          }
        : {},
  });
}

function attachBeautyExpertV1ToResponse(response = {}, options = {}) {
  if (!isPlainObject(response)) return response;
  const beautyExpertV1 = buildBeautyExpertV1Response({
    response,
    ...options,
  });
  if (!beautyExpertV1) return response;

  const next = {
    ...response,
    beauty_expert_v1: beautyExpertV1,
  };

  if (isPlainObject(response.metadata)) {
    next.metadata = {
      ...response.metadata,
      beauty_capability_invoked: true,
      beauty_mode: beautyExpertV1.mode,
      final_authority_status:
        beautyExpertV1.delegation_trace?.final_authority_status || null,
      projection_type: beautyExpertV1.delegation_trace?.projection_type || null,
    };
  } else if (isPlainObject(response.meta)) {
    next.meta = {
      ...response.meta,
      beauty_capability_invoked: true,
      beauty_mode: beautyExpertV1.mode,
      final_authority_status:
        beautyExpertV1.delegation_trace?.final_authority_status || null,
      projection_type: beautyExpertV1.delegation_trace?.projection_type || null,
    };
  }

  return next;
}

module.exports = {
  attachBeautyExpertV1ToResponse,
  buildBeautyExpertV1Response,
};

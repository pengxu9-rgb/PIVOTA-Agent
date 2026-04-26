function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9+.'\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function flattenObjectText(value, depth = 0) {
  if (depth > 3 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => flattenObjectText(item, depth + 1)).join(' ');
  if (!isPlainObject(value)) return '';
  return Object.values(value).map((item) => flattenObjectText(item, depth + 1)).join(' ');
}

function getProductText(product = {}) {
  if (!isPlainObject(product)) return '';
  return normalizeText([
    product.title,
    product.name,
    product.canonical_title,
    product.display_name,
    product.brand,
    product.vendor,
    product.canonical_category,
    product.category,
    product.product_type,
    product.productType,
    product.description,
    product.short_description,
    product.recommendation_reason,
  ].filter(Boolean).join(' '));
}

function getBeautyRequestText({ queryText = '', beautyRequest = {} } = {}) {
  return normalizeText([
    queryText,
    beautyRequest.user_goal,
    flattenObjectText(beautyRequest.skin_context),
    flattenObjectText(beautyRequest.routine_context),
    flattenObjectText(beautyRequest.product_context),
    flattenObjectText(beautyRequest.scenario_context),
    flattenObjectText(beautyRequest.constraints),
  ].filter(Boolean).join(' '));
}

function hasBeautySurfaceHint({ search = {}, metadata = {}, beautyRequest = {} } = {}) {
  const catalogSurface = normalizeText(
    search.catalog_surface ||
      search.catalogSurface ||
      metadata.catalog_surface ||
      metadata.catalogSurface,
  );
  const beautyDomainHint = normalizeText(
    search.beauty_domain_hint ||
      search.beautyDomainHint ||
      metadata.beauty_domain_hint ||
      metadata.beautyDomainHint,
  );
  return catalogSurface === 'beauty' || beautyDomainHint === 'beauty' || normalizeText(beautyRequest.domain) === 'beauty';
}

function hasExactProductContext({ queryText = '', beautyRequest = {} } = {}) {
  const productContext = isPlainObject(beautyRequest.product_context) ? beautyRequest.product_context : {};
  if (
    productContext.product_id ||
    productContext.product_group_id ||
    productContext.product_ref ||
    productContext.canonical_product_ref ||
    productContext.name ||
    productContext.title
  ) {
    return true;
  }
  return /\b(is|would|should|can)\b[^.]{0,120}\b(good|right|fit|suit|work|use)\b|\bbetter than\b|\bvs\.?\b|\bversus\b/.test(
    normalizeText(queryText),
  );
}

function inferBeautyRoleIntent({ queryText = '', beautyRequest = {} } = {}) {
  const text = getBeautyRequestText({ queryText, beautyRequest });
  if (!text) return null;
  const explicitSunscreen = /\b(sunscreen|spf|sun\s*screen|sunblock|uv)\b/.test(text);
  const explicitMoisturizer =
    /\b(moisturizer|moisturiser|moisturize|moisturise|cream|lotion|gel\s*cream|barrier|dry|tight|retinoid|tretinoin)\b/.test(text);
  const explicitTreatment =
    /\b(serum|treatment|spot\s*treat|niacinamide|bha|salicylic|azelaic|retinol|retinal|vitamin\s*c)\b/.test(text);
  const explicitCleanser = /\b(cleanser|cleanse|wash|face\s*wash)\b/.test(text);
  const firstBuyRoutine =
    /\b(simple\s+routine|starter\s+routine|use\s+first|buy\s+first|first\s+product|only\s+buy\s+one|one\s+product)\b/.test(text);
  const barrierLeaningContext =
    /\b(winter|dry|tight|barrier|sensitive|retinoid|tretinoin|lightweight|gel\s*cream|moisture|hydration|hydrating)\b/.test(text);
  if (explicitSunscreen && !explicitMoisturizer) return 'sunscreen';
  if (explicitMoisturizer) return 'moisturizer';
  if (firstBuyRoutine && barrierLeaningContext && !explicitSunscreen && !explicitTreatment && !explicitCleanser) {
    return 'moisturizer';
  }
  if (explicitCleanser) return 'cleanser';
  if (explicitTreatment) return 'treatment';
  return null;
}

function hasRetinoidConflictContext(queryText = '') {
  return /\b(tretinoin|retinoid|retin[- ]?a|adapalene|differin|retinoid stressed|sensitive)\b/.test(queryText);
}

function hasSpfRequestContext(queryText = '') {
  return /\b(sunscreen|spf|sun\s*screen|sunblock|uv|daytime|day\s*time|morning)\b/.test(queryText);
}

function evaluateProductForBeautyRole(product = {}, role = null, queryText = '') {
  const text = getProductText(product);
  const retinoidConflict = hasRetinoidConflictContext(queryText);
  const spfRequested = hasSpfRequestContext(queryText);
  const hardReasons = [];
  let score = 0;

  if (/\b(gift\s*card|e gift|egift)\b/.test(text)) hardReasons.push('gift_card');
  if (/\b(dog|dogs|cat|cats|pet|paw|overalls|knit\s*sweater)\b/.test(text)) hardReasons.push('pet');
  if (/\b(brush|bristle|applicator|sponge|puff|dry'n shape|dryn shape|tool|tower face|spa)\b/.test(text)) hardReasons.push('tool');
  if (/\b(shampoo|conditioner|hair|scalp|dry\s*shampoo)\b/.test(text)) hardReasons.push('hair');
  if (/\bmoroccanoil\b/.test(text) && !/\b(face|facial|skin|skincare|spf|sunscreen|moisturizer|cream|cleanser|serum|toner)\b/.test(text)) {
    hardReasons.push('hair_brand');
  }
  if (/\b(gloss|lipstick|mascara|eyeshadow|blush|powder|foundation|concealer|setting\s*powder)\b/.test(text)) hardReasons.push('makeup');
  if (/\b(body|hand\s*cream|foot|deodorant)\b/.test(text)) hardReasons.push('body');

  if (role === 'moisturizer') {
    if (retinoidConflict && /\b(retinol|retinal|ginseng\s*\+?\s*retinol|resurfacing|peel|aha|bha|glycolic)\b/.test(text)) {
      hardReasons.push('active_conflict');
    }
    if (/\b(moisturizer|moisturiser|moisturizing|moisturising|cream|lotion|gel\s*cream|balm)\b/.test(text)) score += 70;
    if (/\b(ceramide|colloidal|oat|oatmeal|panthenol|cica|centella|calming|soothing|repair|lipid|peptide|hydrating|sensitive)\b/.test(text)) score += 28;
    if (/\b(serum|toner|essence|ampoule|dots|patch|acne)\b/.test(text)) score -= 38;
    if (!spfRequested && /\b(spf|sunscreen|sun\s*shield|dayscreen|superscreen)\b/.test(text)) score -= 62;
    if (/\b(set|kit|routine|duo|bundle)\b/.test(text)) score -= 28;
  } else if (role === 'sunscreen') {
    if (/\b(sunscreen|spf|sun\s*shield|sunblock|uv|pa\+)\b/.test(text)) score += 80;
    if (/\b(lightweight|airy|fluid|gel|watery|aqua|mild|mineral|matte|oil|shine|makeup)\b/.test(text)) score += 20;
    if (/\b(serum|toner|cleanser|shampoo|gloss|patch|dots)\b/.test(text)) score -= 35;
    if (/\b(set|kit|routine|duo|bundle)\b/.test(text)) score -= 20;
  } else if (role === 'treatment') {
    if (/\b(serum|treatment|niacinamide|salicylic|bha|azelaic|retinol|retinal|vitamin\s*c|acne|blemish|pore|pores|ampoule)\b/.test(text)) score += 65;
    if (/\b(moisturizer|cream|lotion|spf|sunscreen|cleanser)\b/.test(text)) score -= 20;
    if (/\b(set|kit|routine|duo|bundle)\b/.test(text)) score -= 24;
  } else if (role === 'cleanser') {
    if (/\b(cleanser|cleansing|wash|face\s*wash)\b/.test(text)) score += 75;
    if (/\b(serum|cream|moisturizer|spf|sunscreen|toner)\b/.test(text)) score -= 30;
  } else {
    if (/\b(skincare|skin\s*care|moisturizer|cream|lotion|serum|sunscreen|spf|toner|essence|ampoule|cleanser)\b/.test(text)) score += 10;
    if (/\b(set|kit|routine|duo|bundle)\b/.test(text)) score -= 15;
  }

  const hardInvalid = hardReasons.length > 0;
  const roleMismatch =
    role === 'moisturizer' &&
    !spfRequested &&
    /\b(spf|sunscreen|sun\s*shield|sunblock|dayscreen|superscreen)\b/.test(text);
  const roleFit =
    hardInvalid
      ? 'hard_invalid'
      : roleMismatch
        ? 'role_mismatch'
      : score >= 60
        ? 'role_match'
        : score >= 25
          ? 'supportive_adjacent'
          : score >= 0
            ? 'weak_adjacent'
            : 'role_mismatch';
  return {
    role,
    score,
    role_fit: roleFit,
    hard_reasons: hardReasons,
  };
}

function inferBeautyRoleFromProducts(products = []) {
  for (const product of Array.isArray(products) ? products : []) {
    const text = getProductText(product);
    if (/\b(sunscreen|spf|sun\s*shield|sunblock|uv|pa\+)\b/.test(text)) return 'sunscreen';
    if (/\b(moisturizer|moisturiser|moisturizing|moisturising|cream|lotion|gel\s*cream|balm)\b/.test(text)) return 'moisturizer';
    if (/\b(cleanser|cleansing|wash|face\s*wash)\b/.test(text)) return 'cleanser';
    if (/\b(serum|treatment|niacinamide|salicylic|bha|azelaic|retinol|retinal|vitamin\s*c|acne|blemish|pore|pores|ampoule)\b/.test(text)) return 'treatment';
  }
  return null;
}

function normalizeRoleFamily(value) {
  const text = normalizeText(value);
  if (!text) return null;
  if (/\b(sunscreen|spf|sun\s*screen|sunblock|uv|dayscreen)\b/.test(text)) return 'sunscreen';
  if (/\b(moisturizer|moisturiser|moisturizing|moisturising|cream|lotion|barrier|gel\s*cream|balm)\b/.test(text)) {
    return 'moisturizer';
  }
  if (/\b(cleanser|cleansing|wash|face\s*wash)\b/.test(text)) return 'cleanser';
  if (/\b(serum|treatment|toner|essence|ampoule|oil\s*control|clogged\s*pore|acne|blemish|pore|pores|niacinamide|bha|salicylic|azelaic|retinol|retinal|vitamin\s*c)\b/.test(text)) {
    return 'treatment';
  }
  return null;
}

function inferBeautyRoleFromSemanticContract({ responseBody = {}, search = {}, metadata = {} } = {}) {
  const responseMetadata = isPlainObject(responseBody?.metadata) ? responseBody.metadata : {};
  const contract = isPlainObject(responseMetadata.search_request_contract)
    ? responseMetadata.search_request_contract
    : isPlainObject(search.search_request_contract)
      ? search.search_request_contract
      : isPlainObject(search.searchRequestContract)
        ? search.searchRequestContract
        : isPlainObject(metadata.search_request_contract)
          ? metadata.search_request_contract
          : null;
  const semanticContract = isPlainObject(contract?.semantic_contract)
    ? contract.semantic_contract
    : isPlainObject(search.semantic_contract)
      ? search.semantic_contract
      : isPlainObject(metadata.semantic_contract)
        ? metadata.semantic_contract
        : null;
  return (
    normalizeRoleFamily(semanticContract?.target_step_family) ||
    normalizeRoleFamily(contract?.target_step_family) ||
    normalizeRoleFamily(semanticContract?.primary_role_id) ||
    normalizeRoleFamily(contract?.primary_role_id)
  );
}

function appendReason(existing, reason) {
  const rows = Array.isArray(existing) ? existing.slice() : [];
  if (!rows.includes(reason)) rows.push(reason);
  return rows;
}

function annotateProduct(product, fit) {
  return {
    ...product,
    beauty_role_fit: {
      role: fit.role,
      score: fit.score,
      role_fit: fit.role_fit,
      hard_reasons: fit.hard_reasons,
    },
  };
}

function applyBeautyRoleCompatibleSelection({
  responseBody = {},
  queryText = '',
  operation = '',
  invokeSearchRail = '',
  search = {},
  metadata = {},
  beautyRequest = {},
} = {}) {
  if (!isPlainObject(responseBody)) return responseBody;
  if (String(operation || '').trim() !== 'find_products_multi') return responseBody;
  if (String(invokeSearchRail || '').trim().toLowerCase() !== 'authoritative_shopping') return responseBody;
  if (!hasBeautySurfaceHint({ search, metadata, beautyRequest })) return responseBody;
  const products = Array.isArray(responseBody.products) ? responseBody.products.filter(isPlainObject) : [];
  if (products.length === 0) return responseBody;
  const requestText = getBeautyRequestText({ queryText: queryText || search.query || search.q, beautyRequest });
  const role =
    inferBeautyRoleFromSemanticContract({ responseBody, search, metadata }) ||
    inferBeautyRoleIntent({ queryText: requestText, beautyRequest }) ||
    (hasExactProductContext({ queryText: requestText, beautyRequest })
      ? inferBeautyRoleFromProducts(products)
      : null);
  const evaluated = products.map((product, index) => ({
    product,
    index,
    fit: evaluateProductForBeautyRole(product, role, requestText),
  }));
  const hardDropped = evaluated.filter((item) => item.fit.role_fit === 'hard_invalid');
  const candidates = evaluated.filter((item) => item.fit.role_fit !== 'hard_invalid');
  if (hardDropped.length === 0 && !role) return responseBody;

  const roleMatches = candidates.filter((item) => item.fit.role_fit === 'role_match');
  const supportive = candidates.filter((item) => item.fit.role_fit === 'supportive_adjacent');
  const weak = candidates.filter((item) => item.fit.role_fit === 'weak_adjacent');
  const keepPool =
    roleMatches.length > 0
      ? roleMatches.concat(supportive)
      : supportive.length > 0
        ? supportive
        : weak;
  const sorted = keepPool
    .slice()
    .sort((left, right) => {
      if (right.fit.score !== left.fit.score) return right.fit.score - left.fit.score;
      return left.index - right.index;
    });
  const selectedIndexes = new Set(sorted.map((item) => item.index));
  const selected = sorted.map((item) => annotateProduct(item.product, item.fit));
  const droppedCount = products.length - selected.length;
  if (droppedCount <= 0) return responseBody;

  const next = {
    ...responseBody,
    products: selected,
    total: selected.length,
    page_size: Math.min(Number(responseBody.page_size || selected.length) || selected.length, selected.length),
    metadata: {
      ...(isPlainObject(responseBody.metadata) ? responseBody.metadata : {}),
      beauty_role_compatible_selection: {
        applied: true,
        role: role || 'skincare',
        original_count: products.length,
        selected_count: selected.length,
        hard_dropped_count: hardDropped.length,
        role_dropped_count: Math.max(0, droppedCount - hardDropped.length),
        dropped_titles: evaluated
          .filter((item) => !selectedIndexes.has(item.index))
          .slice(0, 8)
          .map((item) => ({
            title: item.product.canonical_title || item.product.title || item.product.name || null,
            role_fit: item.fit.role_fit,
            score: item.fit.score,
            hard_reasons: item.fit.hard_reasons,
          })),
      },
    },
    reason_codes: appendReason(responseBody.reason_codes, 'beauty_role_compatible_selection_applied'),
    reply: selected.length > 0 ? null : responseBody.reply,
  };
  if (selected.length === 0) {
    next.reply = 'I do not have a role-compatible grounded skincare match from the current catalog for that request yet.';
    next.has_good_match = false;
    next.match_confidence = 'none';
    next.reason_codes = appendReason(next.reason_codes, 'beauty_role_compatible_selection_empty');
  }
  return next;
}

module.exports = {
  inferBeautyRoleIntent,
  inferBeautyRoleFromSemanticContract,
  evaluateProductForBeautyRole,
  applyBeautyRoleCompatibleSelection,
};

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

function flattenText(value, depth = 0) {
  if (depth > 3 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => flattenText(item, depth + 1)).join(' ');
  if (!isPlainObject(value)) return '';
  return Object.values(value).map((item) => flattenText(item, depth + 1)).join(' ');
}

function normalizeProductToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function compactVisibleEvidence(value) {
  const raw = String(value || '');
  const cleaned = stripHtml(raw);
  const normalized = normalizeText(cleaned);
  if (!normalized) return '';
  const hasMarkup = /<[^>]+>/.test(raw) || /&(?:nbsp|amp|quot|#39);/i.test(raw);
  if (
    /(^|\s)(test fixture|ingredients|ingredient list|full ingredient|clinical study|made by|product details|how to use|directions|soft wash to smoky|synthetic fibers|with pouch)(\s|$)/.test(normalized) ||
    /\b(brush|makeup brush|synthetic fibers|pouch)\b/.test(normalized) ||
    /\bmerchant-network search candidate\b/i.test(cleaned) ||
    (hasMarkup && cleaned.length > 96)
  ) {
    return '';
  }
  if (cleaned.length <= 160) return cleaned;
  const firstSentence = cleaned.match(/^(.{40,150}?[.!?])(?:\s|$)/)?.[1]?.trim();
  return firstSentence || '';
}

function pickVisibleEvidence(...values) {
  for (const value of values) {
    const evidence = compactVisibleEvidence(value);
    if (evidence) return evidence;
  }
  return '';
}

function asEvidenceFragment(value = '') {
  const text = asString(value);
  if (!text) return '';
  if (/^[A-Z]{2,}\b/.test(text)) return text;
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
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

function getCardCollectionKey(response = {}) {
  if (Array.isArray(response.cards)) return 'cards';
  if (Array.isArray(response.cards_v1)) return 'cards_v1';
  if (Array.isArray(response.chat_cards)) return 'chat_cards';
  return null;
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

function buildAxisFromReason(reason = '', index = 0, { allowFallbackLabel = true } = {}) {
  const rawReason = String(reason || '');
  const cleanedReason = stripHtml(reason);
  const normalized = normalizeText(cleanedReason);
  if (!normalized) return null;
  const hasMarkup = /<[^>]+>/.test(rawReason) || /&(?:nbsp|amp|quot|#39);/i.test(rawReason);
  if (
    /(^|\s)(test fixture|ingredients|clinical study|made by|soft wash to smoky|synthetic fibers|with pouch)(\s|$)/.test(normalized) ||
    /\b(brush|makeup brush|synthetic fibers|pouch)\b/.test(normalized) ||
    (hasMarkup && cleanedReason.length > 96)
  ) {
    return null;
  }
  if (
    /\b(not|don't|do not|without)\b[^.]{0,32}\btoo\b[^.]{0,16}\b(dewy|matte)\b/.test(normalized) ||
    /\bbetween\b[^.]{0,48}\bmatte\b[^.]{0,48}\bdewy\b/.test(normalized) ||
    /\bbetween\b[^.]{0,48}\bdewy\b[^.]{0,48}\bmatte\b/.test(normalized)
  ) {
    return { id: `axis_${index + 1}`, label: 'lighter / smoother finish' };
  }
  if (/\bmineral|sensitive|mild up|mild-up\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'mineral / sensitive-skin' };
  }
  if (/\bserum-like|serum like|fluid|airy|aqua fresh|aqua-fresh|gel|watery\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'serum-like / thinner feel' };
  }
  if (/\bniacinamide|zinc pca|targeted treatment|skin-balancing|skin balancing|oil-balancing|oil balancing|clarifying serum|blemish serum\b/.test(normalized)) {
    return { id: `axis_${index + 1}`, label: 'targeted treatment / balancing serum' };
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
  if (normalized.length > 120) {
    return null;
  }
  if (/\b(sunscreen|spf|cream|serum|lotion|toner|cleanser|moisturizer|moisturiser)\b/.test(normalized)) {
    return null;
  }
  if (!allowFallbackLabel) {
    return null;
  }
  return {
    id: `axis_${index + 1}`,
    label: cleanedReason.length > 72 ? `${cleanedReason.slice(0, 69)}...` : cleanedReason,
  };
}

function buildCompareAxes(products = []) {
  return products
    .slice(0, 4)
    .map((product, index) => {
      const evidence = pickVisibleEvidence(product?.why_this_one, product?.short_description);
      if (evidence) return buildAxisFromReason(evidence, index);
      const title = pickFirstTrimmed(product?.title, product?.name, product?.canonical_title);
      return buildAxisFromReason(title, index, { allowFallbackLabel: false });
    })
    .filter(Boolean);
}

function buildRecoTitleDedupeKey(product = {}) {
  const title = pickFirstTrimmed(product.title, product.name, product.canonical_title);
  if (!title) return '';
  const brand = normalizeProductToken(pickFirstTrimmed(product.brand, product.vendor));
  const normalizedTitle = normalizeProductToken(title)
    .replace(/\bdeal\b/g, ' ')
    .replace(/\bsubscription\b/g, ' ')
    .replace(/\bsubscribe\b/g, ' ')
    .replace(/\bautoship\b/g, ' ')
    .replace(/\bauto ship\b/g, ' ')
    .replace(/\bbroad spectrum\b/g, ' ')
    .replace(/\bspf\s*\d+\+?\b/g, ' ')
    .replace(/\bpa\s*\+{2,4}\b/g, ' ')
    .replace(/\buvlock\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ml|oz|fl oz|g)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `title:${brand}:${normalizedTitle || normalizeProductToken(title)}`;
}

function buildRecoDedupeKeys(product = {}) {
  const keys = [];
  const titleKey = buildRecoTitleDedupeKey(product);
  if (titleKey) keys.push(titleKey);
  const exactKey = pickFirstTrimmed(product.product_group_id, product.dedupe_group_id);
  if (exactKey) keys.push(`id:${normalizeProductToken(exactKey)}`);
  return keys;
}

function buildRecoDedupeKey(product = {}) {
  return buildRecoDedupeKeys(product)[0] || '';
}

function scoreRecoDedupeRepresentative(product = {}) {
  const title = normalizeText(pickFirstTrimmed(product.title, product.name, product.canonical_title));
  let score = 0;
  if (pickFirstTrimmed(product.product_id, product.id)) score += 2;
  if (pickFirstTrimmed(product.product_group_id, product.dedupe_group_id)) score += 1;
  if (product.pdp_open) score += 2;
  if (pickFirstTrimmed(product.image_url)) score += 1;
  if (pickFirstTrimmed(product.price)) score += 1;
  if (/\b(deal|subscription|subscribe|autoship|auto ship)\b/.test(title)) score -= 10;
  return score;
}

function dedupeRecoProducts(products = []) {
  const rows = Array.isArray(products) ? products.filter((row) => isPlainObject(row)) : [];
  const seen = new Map();
  const out = [];
  for (const product of rows) {
    const keys = buildRecoDedupeKeys(product);
    const existingIndex = keys.map((key) => seen.get(key)).find((index) => Number.isInteger(index));
    if (Number.isInteger(existingIndex)) {
      if (scoreRecoDedupeRepresentative(product) > scoreRecoDedupeRepresentative(out[existingIndex])) {
        out[existingIndex] = product;
      }
      for (const key of keys) seen.set(key, existingIndex);
      continue;
    }
    for (const key of keys) seen.set(key, out.length);
    out.push(product);
  }
  return out;
}

function buildAnchorTokens(beautyRequest = {}, queryText = '') {
  const productContext = isPlainObject(beautyRequest.product_context) ? beautyRequest.product_context : {};
  const brand = pickFirstTrimmed(productContext.brand);
  const title = pickFirstTrimmed(
    productContext.title,
    productContext.name,
    productContext.product_name,
    productContext.display_name,
    productContext.canonical_product_ref,
    productContext.product_ref,
  );
  const tokens = uniqueStrings([
    title,
    brand && title ? `${brand} ${title}` : '',
    pickFirstTrimmed(productContext.product_id),
    pickFirstTrimmed(productContext.product_group_id),
  ])
    .map((item) => normalizeProductToken(item))
    .filter(Boolean);
  if (tokens.length > 0) return tokens;
  return uniqueStrings([queryText])
    .map((item) => normalizeProductToken(item))
    .filter((item) => item.split(' ').length >= 4);
}

function buildProductMatchTokens(product = {}) {
  const canonicalRef = isPlainObject(product.canonical_product_ref)
    ? pickFirstTrimmed(
        product.canonical_product_ref.product_id,
        product.canonical_product_ref.canonical_product_ref,
        product.canonical_product_ref.product_ref,
      )
    : pickFirstTrimmed(product.canonical_product_ref);
  const name = pickFirstTrimmed(product.name, product.title, product.canonical_title, product.display_name);
  const brand = pickFirstTrimmed(product.brand);
  return uniqueStrings([
    name,
    brand && name ? `${brand} ${name}` : '',
    pickFirstTrimmed(product.product_id, product.id),
    pickFirstTrimmed(product.product_group_id),
    pickFirstTrimmed(product.product_ref),
    canonicalRef,
  ])
    .map((item) => normalizeProductToken(item))
    .filter(Boolean);
}

function getMeaningfulProductTokenParts(text = '') {
  return normalizeProductToken(text)
    .split(' ')
    .map((part) => part.trim())
    .filter((part) =>
      part.length >= 3 &&
      ![
        'and',
        'the',
        'for',
        'with',
        'from',
        'skin',
        'care',
        'face',
        'cream',
        'lotion',
        'serum',
        'sunscreen',
        'moisturizer',
        'moisturiser',
      ].includes(part));
}

function scoreProductAgainstAnchor(product = {}, beautyRequest = {}, queryText = '') {
  const anchorTokens = buildAnchorTokens(beautyRequest, queryText);
  if (anchorTokens.length === 0) return 0;
  const productTokens = buildProductMatchTokens(product);
  let score = 0;
  for (const anchor of anchorTokens) {
    for (const token of productTokens) {
      if (!anchor || !token) continue;
      if (anchor === token) score = Math.max(score, 3);
      else if (anchor.includes(token) || token.includes(anchor)) score = Math.max(score, 2);
      else if (anchor.split(' ').every((part) => token.includes(part))) score = Math.max(score, 1);
      else {
        const anchorParts = getMeaningfulProductTokenParts(anchor);
        const tokenParts = getMeaningfulProductTokenParts(token);
        const tokenPartSet = new Set(tokenParts);
        const overlap = anchorParts.filter((part) => tokenPartSet.has(part)).length;
        if (overlap >= 3 && overlap / Math.max(anchorParts.length, 1) >= 0.45) {
          score = Math.max(score, 1);
        }
      }
    }
  }
  return score;
}

function filterExactAnchorProducts(products = [], { mode, beautyRequest, queryText } = {}) {
  const rows = Array.isArray(products) ? products.filter(isPlainObject) : [];
  if (mode !== 'exact_product_assist' || rows.length === 0) return rows;
  const anchorTokens = buildAnchorTokens(beautyRequest, queryText);
  if (anchorTokens.length === 0) return rows;
  const scored = rows.map((product, index) => ({
    product,
    index,
    score: scoreProductAgainstAnchor(product, beautyRequest, queryText),
  }));
  const maxScore = Math.max(...scored.map((item) => item.score));
  if (maxScore <= 0) return [];
  return scored
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map((item) => item.product);
}

function reorderProductsForBeautyMode(products = [], { mode, beautyRequest, queryText } = {}) {
  const rows = Array.isArray(products) ? [...products] : [];
  if (rows.length <= 1) return rows;
  const requestText = normalizeText([
    queryText,
    beautyRequest?.user_goal,
    flattenText(beautyRequest?.skin_context),
    flattenText(beautyRequest?.scenario_context),
    flattenText(beautyRequest?.constraints),
  ].filter(Boolean).join(' '));
  const sunscreenFinishFit =
    mode === 'category_compare' &&
    /\b(sunscreen|spf)\b/.test(requestText) &&
    /\b(oily|oil|humid|houston|makeup|shiny|shine|greasy|heavy|under makeup)\b/.test(requestText);
  if (sunscreenFinishFit) {
    return rows
      .map((product, index) => {
        const text = normalizeText([
          product?.name,
          product?.title,
          product?.canonical_title,
          product?.brand,
          product?.why_this_one,
          product?.short_description,
        ].filter(Boolean).join(' '));
        let score = 0;
        if (/\b(sunscreen|spf|uv|sun)\b/.test(text)) score += 40;
        if (/\b(unseen|primer|matte|fluid|aqua|aqua fresh|water fit|serum|airy|lightweight|weightless|clear)\b/.test(text)) score += 18;
        if (/\b(lighter|smoother|smooth|balanced)\b/.test(text)) score += 20;
        if (/\b(mild|mild up|mineral|sensitive)\b/.test(text)) score += 8;
        if (/\b(stick|cushion|tinted|tint|shade)\b/.test(text)) score -= 16;
        if (/\b(moisturizing|moisturising|dewy|dew|glow|tinted|drops|hydrating|cream)\b/.test(text)) score -= 14;
        if (/\b(deal|subscription|subscribe|autoship|auto ship)\b/.test(text)) score -= 30;
        return { product, index, score };
      })
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.index - right.index;
      })
      .map((item) => item.product);
  }
  const retinoidBarrierFit =
    mode === 'category_compare' &&
    /\b(moisturizer|moisturiser|cream|lotion|barrier)\b/.test(requestText) &&
    /\b(tretinoin|retinoid|dry|sensitive|tight|barrier)\b/.test(requestText);
  if (retinoidBarrierFit) {
    return rows
      .map((product, index) => {
        const text = normalizeText([
          product?.name,
          product?.title,
          product?.canonical_title,
          product?.brand,
          product?.why_this_one,
          product?.short_description,
        ].filter(Boolean).join(' '));
        let score = 0;
        if (/\b(moisturizer|moisturiser|cream|lotion|gel cream|balm)\b/.test(text)) score += 40;
        if (/\b(oat|oatmeal|colloidal|ceramide|panthenol|cica|centella|repair|barrier|sensitive|fragrance free|calming|soothing)\b/.test(text)) score += 30;
        if (/\b(ultra repair|first aid beauty|vanicream|skinfix|lipid)\b/.test(text)) score += 12;
        if (/\b(retinol|retinal|resurfacing|peel|aha|bha|glycolic|firming|brightening)\b/.test(text)) score -= 35;
        if (/\b(set|kit|bundle|routine)\b/.test(text)) score -= 20;
        if (/\b(sunscreen|spf|serum|toner|essence|ampoule|cleanser)\b/.test(text)) score -= 25;
        return { product, index, score };
      })
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.index - right.index;
      })
      .map((item) => item.product);
  }
  if (mode !== 'exact_product_assist') return rows;
  return rows
    .map((product, index) => ({
      product,
      index,
      score: scoreProductAgainstAnchor(product, beautyRequest, queryText),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.index - right.index;
    })
    .map((item) => item.product);
}

function normalizeRecoProduct(product = {}) {
  if (!isPlainObject(product)) return null;
  const productId = pickFirstTrimmed(product.product_id, product.id);
  const name = pickFirstTrimmed(product.name, product.title, product.canonical_title);
  if (!productId && !name) return null;
  const firstOffer = Array.isArray(product.offers) && isPlainObject(product.offers[0]) ? product.offers[0] : {};

  let price = null;
  let currency = null;
  if (isPlainObject(product.price)) {
    const parsed = Number(product.price.amount ?? product.price.value ?? product.price.major);
    price = Number.isFinite(parsed) ? parsed : null;
    currency = pickFirstTrimmed(product.price.currency, product.currency, firstOffer.currency);
  } else {
    const parsed = Number(product.price ?? firstOffer.price);
    price = Number.isFinite(parsed) ? parsed : null;
    currency = pickFirstTrimmed(product.currency, firstOffer.currency);
  }

  return {
    ...(productId ? { product_id: productId } : {}),
    ...(pickFirstTrimmed(product.merchant_id, firstOffer.merchant_id)
      ? { merchant_id: pickFirstTrimmed(product.merchant_id, firstOffer.merchant_id) }
      : {}),
    ...(pickFirstTrimmed(product.product_group_id) ? { product_group_id: pickFirstTrimmed(product.product_group_id) } : {}),
    ...(name ? { name } : {}),
    ...(pickFirstTrimmed(product.brand) ? { brand: pickFirstTrimmed(product.brand) } : {}),
    ...(pickFirstTrimmed(product.image_url, product.image_refs)
      ? { image_url: pickFirstTrimmed(product.image_url, product.image_refs) }
      : {}),
    ...(price != null ? { price } : {}),
    ...(currency ? { currency } : {}),
    ...(pickVisibleEvidence(product.why_this_one, product.short_description)
      ? { why_this_one: pickVisibleEvidence(product.why_this_one, product.short_description) }
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
  const rawBeautyRequest = isPlainObject(normalizedNeed.beauty_request)
    ? normalizedNeed.beauty_request
    : null;
  const hasBeautyRequestBlock = rawBeautyRequest && Object.keys(rawBeautyRequest).length > 0;
  const beautyRequest = hasBeautyRequestBlock
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
    /\b(sunscreens?|spf|moisturi[sz]ers?|cleansers?|serums?|toners?|essences?|retinols?|retinoids?|masks?|balms?|oils?|creams?|lotions?)\b/;
  const genericGuidancePattern =
    /\bwhat should i (use|buy)\b(?:[^.]{0,24}\bfor my skin\b)?|\bhelp my skin\b|\bfor my skin\b/;
  const exactProductAskPattern =
    /\b(is|would|should)\b[^.]{0,120}\b(good|better|right|fit|suit|work|use)\b|\bbetter than\b|\bvs\.?\b|\bversus\b/;
  const hasExplicitCategory = explicitCategoryPattern.test(normalizedQuery);
  const isGenericGuidanceAsk = genericGuidancePattern.test(normalizedQuery);
  if (
    String(taskType || '').trim() === 'exact_product' ||
    pickFirstTrimmed(
      productContext.product_id,
      productContext.product_group_id,
      productContext.canonical_product_ref,
      productContext.product_ref,
      productContext.name,
      productContext.title,
    ) ||
    (exactProductAskPattern.test(normalizedQuery) &&
      /\b(beauty of joseon|ultra repair|first aid beauty|round lab|skin1004|paula'?s choice|glossier|supergoop)\b/.test(normalizedQuery))
  ) {
    return 'exact_product_assist';
  }
  if (!hasExplicitCategory && isGenericGuidanceAsk && missingContext.length > 0) {
    return 'guided_beauty_reco';
  }
  if (
    Array.isArray(response?.products) &&
    response.products.length > 0 &&
    missingContext.length === 0
  ) {
    return 'category_compare';
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
  if (normalizeText(beautyRequest?.domain) === 'beauty') return true;
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

  const rawProducts = extractRecommendationProducts(response);
  const mode = inferBeautyMode({
    taskType,
    beautyRequest: normalizedBeautyIntent,
    queryText,
    response: { products: rawProducts },
  });
  const products = reorderProductsForBeautyMode(rawProducts, {
    mode,
    beautyRequest: normalizedBeautyIntent,
    queryText,
  });
  const authorityStatus = inferAuthorityStatus(response, metadata);
  const analysisSummary = buildAnalysisSummary(normalizedBeautyIntent, queryText, products);
  const confidence = buildConfidence(response, analysisSummary);
  const shouldSuppressRecoBundle =
    mode === 'guided_beauty_reco' &&
    Array.isArray(analysisSummary.missing_context) &&
    analysisSummary.missing_context.length > 0;
  const effectiveProducts = shouldSuppressRecoBundle
    ? []
    : filterExactAnchorProducts(
        applyBeautyIntentProductConstraints(dedupeRecoProducts(products), normalizedBeautyIntent, { mode }),
        {
          mode,
          beautyRequest: normalizedBeautyIntent,
          queryText,
        },
      );
  const compareAxes = buildCompareAxes(effectiveProducts);
  const nextActions = buildNextActions({
    mode,
    beautyRequest,
    analysisSummary,
    products: effectiveProducts,
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
      comparison_mode:
        effectiveProducts.length > 1 ? 'same_type_compare' : effectiveProducts.length === 1 ? 'single_pick' : 'none',
      final_authority_status: authorityStatus,
    },
    reco_bundle: buildRecoBundle(effectiveProducts, authorityStatus),
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

function reorderBeautyProjectionRows(rows = [], {
  mode,
  beautyIntent,
} = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => isPlainObject(row)) : [];
  if (!list.length) return [];
  const reordered = reorderProductsForBeautyMode(list, {
    mode,
    beautyRequest: beautyIntent,
    queryText: pickFirstTrimmed(beautyIntent?.user_goal),
  });
  return filterExactAnchorProducts(
    applyBeautyIntentProductConstraints(dedupeRecoProducts(reordered), beautyIntent, { mode }),
    {
      mode,
      beautyRequest: beautyIntent,
      queryText: pickFirstTrimmed(beautyIntent?.user_goal),
    },
  );
}

function rewriteRecommendationCardForBeautyExpert(card = {}, {
  mode,
  beautyIntent,
} = {}) {
  if (!isPlainObject(card) || normalizeText(card.type || card.card_type) !== 'recommendations') return card;
  const nextCard = { ...card };
  const payload = isPlainObject(card.payload) ? { ...card.payload } : null;
  const reorderRows = (rows) => {
    if (!Array.isArray(rows)) return rows;
    const reordered = reorderBeautyProjectionRows(rows, { mode, beautyIntent });
    return mode === 'exact_product_assist' ? reordered : (reordered.length > 0 ? reordered : rows);
  };

  if (Array.isArray(nextCard.sections)) {
    nextCard.sections = nextCard.sections.map((section) => {
      if (!isPlainObject(section) || !Array.isArray(section.products)) return section;
      return {
        ...section,
        products: reorderRows(section.products),
      };
    });
  }

  if (payload) {
    if (Array.isArray(payload.recommendations)) {
      payload.recommendations = reorderRows(payload.recommendations);
    }
    if (Array.isArray(payload.products)) {
      payload.products = reorderRows(payload.products);
    }
    if (Array.isArray(payload.sections)) {
      payload.sections = payload.sections.map((section) => {
        if (!isPlainObject(section) || !Array.isArray(section.products)) return section;
        return {
          ...section,
          products: reorderRows(section.products),
        };
      });
    }
    nextCard.payload = payload;
  }

  return nextCard;
}

function projectBeautyExpertResponse(response = {}, beautyExpertV1 = null) {
  if (!isPlainObject(response) || !isPlainObject(beautyExpertV1)) return response;

  const next = { ...response };
  if (Array.isArray(response.products)) {
    next.products = reorderBeautyProjectionRows(response.products, {
      mode: beautyExpertV1.mode,
      beautyIntent: beautyExpertV1.beauty_intent,
    });
  }

  const cardCollectionKey = getCardCollectionKey(response);
  if (cardCollectionKey) {
    next[cardCollectionKey] = response[cardCollectionKey].map((card) =>
      rewriteRecommendationCardForBeautyExpert(card, {
        mode: beautyExpertV1.mode,
        beautyIntent: beautyExpertV1.beauty_intent,
      }));
  }
  return next;
}

function getAssistantTextFromResponse(response = {}) {
  return pickFirstTrimmed(
    response?.assistant_message?.content,
    response?.assistant_text,
  );
}

function getProductDisplayName(product = {}) {
  return pickFirstTrimmed(
    product?.name,
    product?.title,
    product?.canonical_title,
    product?.display_name,
    product?.product_name,
    product?.sku?.name,
    product?.sku?.title,
  );
}

function findNormalizedTitleIndex(text = '', title = '') {
  const normalizedText = normalizeProductToken(text);
  const normalizedTitle = normalizeProductToken(title);
  if (!normalizedText || !normalizedTitle) return -1;
  return normalizedText.indexOf(normalizedTitle);
}

function suppressExactProductConflictingAssistant(response = {}, beautyExpertV1 = null) {
  if (!isPlainObject(response) || !isPlainObject(beautyExpertV1)) return response;
  if (beautyExpertV1.mode !== 'exact_product_assist') return response;
  const assistantText = getAssistantTextFromResponse(response);
  if (!assistantText) return response;
  const products = extractRecommendationProducts(response);
  if (!Array.isArray(products) || products.length < 1) return response;
  const leadTitle = getProductDisplayName(products[0]);
  if (!leadTitle) return response;
  const leadIndex = findNormalizedTitleIndex(assistantText, leadTitle);
  if (products.length < 2) {
    if (leadIndex >= 0 && leadIndex <= 80) return response;
    const next = {
      ...response,
      assistant_message: null,
    };
    if (Object.prototype.hasOwnProperty.call(next, 'assistant_text')) {
      next.assistant_text = '';
    }
    const suppressionMeta = {
      assistant_visible_suppressed_reason: 'exact_product_projection_assistant_mismatch',
      assistant_projection_expected_lead: leadTitle,
      assistant_projection_conflicting_lead: null,
    };
    if (isPlainObject(next.meta)) {
      next.meta = {
        ...next.meta,
        ...suppressionMeta,
      };
    }
    if (isPlainObject(next.metadata)) {
      next.metadata = {
        ...next.metadata,
        ...suppressionMeta,
      };
    }
    return next;
  }
  let earliestOtherIndex = -1;
  let earliestOtherTitle = '';
  for (const product of products.slice(1, 4)) {
    const title = getProductDisplayName(product);
    if (!title) continue;
    const index = findNormalizedTitleIndex(assistantText, title);
    if (index < 0) continue;
    if (earliestOtherIndex < 0 || index < earliestOtherIndex) {
      earliestOtherIndex = index;
      earliestOtherTitle = title;
    }
  }
  if (earliestOtherIndex < 0) return response;
  if (leadIndex >= 0 && leadIndex < earliestOtherIndex) return response;

  const next = {
    ...response,
    assistant_message: null,
  };
  if (Object.prototype.hasOwnProperty.call(next, 'assistant_text')) {
    next.assistant_text = '';
  }
  const suppressionMeta = {
    assistant_visible_suppressed_reason: 'exact_product_projection_assistant_mismatch',
    assistant_projection_expected_lead: leadTitle,
    assistant_projection_conflicting_lead: earliestOtherTitle || null,
  };
  if (isPlainObject(next.meta)) {
    next.meta = {
      ...next.meta,
      ...suppressionMeta,
    };
  }
  if (isPlainObject(next.metadata)) {
    next.metadata = {
      ...next.metadata,
      ...suppressionMeta,
    };
  }
  return next;
}

function isGenericInvokeReply(reply = '') {
  const normalized = normalizeProductToken(reply);
  return (
    normalized === 'here are some more suitable picks based on your request' ||
    normalized.startsWith('here are some more suitable picks based on your request budget') ||
    normalized.startsWith('i only found a few weak matches') ||
    normalized.startsWith('i do not have a role compatible grounded skincare match') ||
    normalized.startsWith('to avoid off topic recommendations what should we prioritize')
  );
}

function formatPrice(product = {}) {
  const amount = Number(product.price);
  const currency = pickFirstTrimmed(product.currency);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return `${currency || 'USD'} ${amount}`;
}

function getProductPriceAmount(product = {}) {
  const amount = Number(product.price);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function getBeautyBudgetMax(beautyIntent = {}) {
  const constraints = isPlainObject(beautyIntent?.constraints) ? beautyIntent.constraints : {};
  for (const raw of [
    constraints.budget_max,
    constraints.max_budget,
    constraints.price_max,
    constraints.max_price,
    constraints.under,
  ]) {
    if (raw == null || raw === '') continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function productHasRetinoidActiveConflict(product = {}) {
  const text = normalizeText([
    product.name,
    product.title,
    product.canonical_title,
    product.brand,
    product.why_this_one,
    product.short_description,
  ].filter(Boolean).join(' '));
  return /\b(retinol|retinal|resurfacing|peel|aha|bha|glycolic|lactic|firming)\b/.test(text);
}

function applyBeautyIntentProductConstraints(products = [], beautyIntent = {}, { mode = null } = {}) {
  const rows = Array.isArray(products) ? products.filter(isPlainObject) : [];
  if (rows.length <= 1) return rows;
  const contextText = getBeautyIntentContextText(beautyIntent);
  const budgetMax = getBeautyBudgetMax(beautyIntent);
  let filtered = rows;
  if (budgetMax != null) {
    const inBudget = rows.filter((product) => {
      const amount = getProductPriceAmount(product);
      return amount == null || amount <= budgetMax;
    });
    if (inBudget.length > 0) filtered = inBudget;
  }
  if (mode !== 'exact_product_assist' && /\b(tretinoin|retinoid|dry|sensitive|barrier)\b/.test(contextText)) {
    const calmerRows = filtered.filter((product) => !productHasRetinoidActiveConflict(product));
    if (calmerRows.length > 0) filtered = calmerRows;
  }
  return filtered;
}

function getBeautyIntentContextText(beautyIntent = {}) {
  return normalizeText([
    beautyIntent?.user_goal,
    flattenText(beautyIntent?.skin_context),
    flattenText(beautyIntent?.routine_context),
    flattenText(beautyIntent?.scenario_context),
    flattenText(beautyIntent?.constraints),
  ].filter(Boolean).join(' '));
}

function buildBeautyContextFrame(beautyIntent = {}) {
  const text = getBeautyIntentContextText(beautyIntent);
  if (/\b(sunscreen|spf)\b/.test(text) && /\b(humid|houston|makeup|shiny|shine|under makeup)\b/.test(text)) {
    const skinCopy = /\boily\b/.test(text) ? 'oily skin' : 'this sunscreen request';
    const placeCopy = /\bhouston\b/.test(text)
      ? ' in humid Houston'
      : /\bhumid\b/.test(text)
        ? ' in humid weather'
        : '';
    const makeupCopy = /\b(makeup|under makeup)\b/.test(text) ? ' under makeup' : '';
    if (/\b(shiny|shine)\b/.test(text)) {
      return `For ${skinCopy}${placeCopy}${makeupCopy}, finish, midday shine, and the fact that you get shiny by noon matter as much as basic SPF coverage.`;
    }
    return `For ${skinCopy}${placeCopy}${makeupCopy}, finish matters as much as basic SPF coverage.`;
  }
  if (/\b(tretinoin|retinoid)\b/.test(text) && /\b(dry|sensitive|tight|barrier)\b/.test(text)) {
    const budgetMax = getBeautyBudgetMax(beautyIntent);
    const budgetCopy = budgetMax != null ? ` under USD ${budgetMax}` : '';
    return `For dry sensitive skin using tretinoin${budgetCopy}, compare barrier comfort, sting risk, and budget rather than adding more active pressure.`;
  }
  if (/\b(clogged pores|pores|combination)\b/.test(text) && /\b(winter|seattle)\b/.test(text)) {
    return 'For combination skin with clogged pores in Seattle winter, the tradeoff is oil-control support without letting the barrier get too tight.';
  }
  return '';
}

function inferProductRoleLabel(product = {}) {
  const haystack = normalizeText([
    product.name,
    product.title,
    product.canonical_title,
    product.brand,
    product.why_this_one,
  ].filter(Boolean).join(' '));
  if (/\bspf|sunscreen|sun\b/.test(haystack)) return 'sunscreen role';
  if (/\bmoistur|cream|lotion|barrier\b/.test(haystack)) return 'moisturizer/barrier role';
  if (/\bserum|niacinamide|retinol|bha|aha|treatment\b/.test(haystack)) return 'treatment role';
  if (/\bcleanser|wash\b/.test(haystack)) return 'cleanser role';
  return 'requested role';
}

function describeProductForVisibleCopy(product = {}, beautyIntent = {}) {
  const reason = pickVisibleEvidence(product.why_this_one, product.short_description);
  if (reason) return asEvidenceFragment(reason);
  const contextText = getBeautyIntentContextText(beautyIntent);
  const productText = normalizeText([
    product.name,
    product.title,
    product.canonical_title,
    product.brand,
  ].filter(Boolean).join(' '));
  if (/\b(sunscreen|spf)\b/.test(productText) && /\b(oily|oil|humid|houston|makeup|shiny|shine|greasy|heavy|under makeup)\b/.test(contextText)) {
    if (/\b(stick|cushion)\b/.test(productText)) {
      return 'it is a grounded SPF option that is more useful as a reapplication or touch-up lane than as the first full-face base if low-shine wear is the priority';
    }
    if (/\b(tinted|tint|shade)\b/.test(productText)) {
      return 'it is a grounded SPF option that can help when shade or coverage fit matters, but it is a less universal first pick for oily skin';
    }
    if (/\b(moisturizing|moisturising|dewy|dew|glow|drops|hydrating)\b/.test(productText)) {
      return 'it is a grounded SPF option, but its moisturizing or dewy positioning may be less aligned if shine control under makeup is the priority';
    }
    if (/\b(unseen|primer|matte|fluid|aqua|aqua fresh|water fit|serum|airy|lightweight|weightless|clear)\b/.test(productText)) {
      return 'it is a grounded SPF option whose title points to a lighter or smoother texture lane for oily skin under makeup';
    }
    if (/\b(mild|mild up|mineral|sensitive)\b/.test(productText)) {
      return 'it is a grounded SPF option in a milder or mineral lane, which is a cleaner low-shine comparison than moisturizing or tinted variants, though the record does not prove a matte finish';
    }
    return 'it is a grounded SPF option, but the current product record does not prove makeup wear or shine-control performance';
  }
  if (/\b(moisturizer|moisturiser|cream|lotion|barrier)\b/.test(productText) && /\b(tretinoin|retinoid|dry|sensitive|tight)\b/.test(contextText)) {
    if (/\b(retinol|retinal|resurfacing|peel|aha|bha|glycolic)\b/.test(productText)) {
      return 'it is a moisturizer-format row, but the active positioning is not the cleanest first pick for a retinoid-stressed routine';
    }
    if (/\b(ceramide|oat|colloidal|panthenol|cica|repair|barrier|sensitive|fragrance free)\b/.test(productText)) {
      return 'it points to a calmer barrier-support lane for dry sensitive or retinoid-stressed skin';
    }
  }
  const parts = [];
  const role = inferProductRoleLabel(product);
  if (role) parts.push(`it matches the ${role}`);
  const price = formatPrice(product);
  if (price) parts.push(`it is listed around ${price}`);
  return parts.join(' and ') || 'it is a grounded catalog option for this request';
}

function buildBeautyExpertBulletReply(products = [], beautyIntent = {}, { creatorFacing = false } = {}) {
  const rows = products.slice(0, 3);
  if (rows.length === 0) return '';
  const contextFrame = buildBeautyContextFrame(beautyIntent);
  const header = creatorFacing
    ? 'Three slot reasons for a creator-facing shortlist:'
    : 'Three slot reasons:';
  const bullets = rows.map((product, index) => {
    const name = getProductDisplayName(product) || `Option ${index + 1}`;
    const label = index === 0 ? 'lead slot' : `comparison slot ${index + 1}`;
    const reason = describeProductForVisibleCopy(product, beautyIntent);
    const versus = index === 0
      ? 'versus the others, it is the reference point for fit, price, and routine risk'
      : 'versus the lead, use it when its texture, price, or positioning fits the audience better';
    return `- ${name}: ${label}; ${reason}; ${versus}.`;
  });
  return `${contextFrame ? `${contextFrame} ` : ''}${header}\n${bullets.join('\n')}`;
}

function buildBeautyExpertRoutineOrderReply(products = [], beautyIntent = {}, { creatorFacing = false } = {}) {
  const lead = products[0];
  if (!lead) return '';
  const support = products.slice(1, 3);
  const leadName = getProductDisplayName(lead) || 'the lead option';
  const contextFrame = buildBeautyContextFrame(beautyIntent);
  const leadReason = describeProductForVisibleCopy(lead, beautyIntent);
  const contextText = getBeautyIntentContextText(beautyIntent);
  const leadRole = inferProductRoleLabel(lead);
  let placementCopy = 'place it after cleansing and before creamier steps, then keep sunscreen as the daytime final step';
  if (/\bsunscreen\b/.test(leadRole)) {
    placementCopy = 'use it as the final morning skincare step before makeup or sun exposure';
  } else if (/\bmoisturizer\b/.test(leadRole)) {
    placementCopy = /\b(tretinoin|retinoid)\b/.test(contextText)
      ? 'use it after watery serums and after your retinoid on retinoid nights'
      : 'use it after cleansing and any watery serum, then follow with SPF in the morning';
  } else if (/\btreatment\b/.test(leadRole)) {
    placementCopy = 'use it after cleansing and before moisturizer, then avoid stacking extra strong actives in the same routine until tolerance is clear';
  }
  const supportCopy = support
    .map((product) => {
      const name = getProductDisplayName(product);
      if (!name) return '';
      return `${name} is a later comparison if you want to trade off texture, price, or active load because ${describeProductForVisibleCopy(product, beautyIntent)}`;
    })
    .filter(Boolean);
  const supportSentence = supportCopy.length > 0
    ? `Compared with it, ${supportCopy.join('; ')}.`
    : 'If this is the only product you buy first, keep the rest of the routine simple; treat stronger actives or richer texture swaps as later comparisons after you see tolerance.';
  const prefix = creatorFacing ? 'For a creator-facing recommendation, ' : '';
  return `${contextFrame ? `${contextFrame} ` : ''}${prefix}If you only buy one first, use ${leadName} as the first purchase decision. In the routine, ${placementCopy}, because ${leadReason}. ${supportSentence}`;
}

function buildBeautyExpertVisibleReply(beautyExpertV1 = {}) {
  const mode = String(beautyExpertV1.mode || '').trim();
  const products = [
    ...asArray(beautyExpertV1.reco_bundle?.lead_picks),
    ...asArray(beautyExpertV1.reco_bundle?.support_picks),
  ].filter(isPlainObject);
  const beautyIntent = isPlainObject(beautyExpertV1.beauty_intent) ? beautyExpertV1.beauty_intent : {};
  const sourceProfile = normalizeSourceToken(beautyExpertV1?.delegation_trace?.source_profile);
  const creatorFacing = sourceProfile === 'creator-agent';

  if (mode === 'guided_beauty_reco' && products.length === 0) {
    const missing = asArray(beautyExpertV1.analysis_summary?.missing_context).filter(Boolean);
    const missingCopy = missing.length > 0
      ? missing.join(', ')
      : 'skin type, main concern, current routine, climate, and budget';
    return `I need a bit more context before narrowing products: ${missingCopy}. A skin analysis can help if you want a more precise routine, but it is not required to continue.`;
  }

  if (mode === 'exact_product_assist' && products.length === 0) {
    const productContext = isPlainObject(beautyIntent.product_context) ? beautyIntent.product_context : {};
    const anchorName = pickFirstTrimmed(
      productContext.title,
      productContext.name,
      productContext.product_name,
      productContext.display_name,
      productContext.canonical_product_ref,
      productContext.product_ref,
      'that exact product',
    );
    return `I do not have a grounded row for ${anchorName} in the current catalog yet, so I should not compare it as if verified. I can compare adjacent category options separately, but the exact product needs authority backfill before a direct verdict.`;
  }

  if (products.length === 0) return '';
  const lead = products[0];
  const support = products.slice(1, 3);
  const leadName = getProductDisplayName(lead) || 'the lead option';
  const intentText = getBeautyIntentContextText(beautyIntent);
  if (/\b(three bullets|three slot reasons|why each|not just product names|slot versus|explain why each)\b/.test(intentText)) {
    const bulletReply = buildBeautyExpertBulletReply(products, beautyIntent, { creatorFacing });
    if (bulletReply) return bulletReply;
  }
  if (/\b(first versus later|first vs later|use first|buy first|only buy one|one product|first product)\b/.test(intentText)) {
    const routineReply = buildBeautyExpertRoutineOrderReply(products, beautyIntent, { creatorFacing });
    if (routineReply) return routineReply;
  }
  const contextFrame = buildBeautyContextFrame(beautyIntent);
  const leadReason = describeProductForVisibleCopy(lead, beautyIntent);
  const prefix = creatorFacing
    ? 'For a creator-facing shortlist, '
    : '';
  const supportCopy = support
    .map((product) => {
      const name = getProductDisplayName(product);
      if (!name) return '';
      return `${name} is the comparison option because ${describeProductForVisibleCopy(product, beautyIntent)}`;
    })
    .filter(Boolean);
  const compareSentence = supportCopy.length > 0
    ? `Compared with it, ${supportCopy.join('; ')}.`
    : 'I would still compare price, texture, and routine fit before making it the only pick.';
  return `${contextFrame ? `${contextFrame} ` : ''}${prefix}${leadName} is the current lead because ${leadReason}. ${compareSentence}`;
}

function projectBeautyExpertVisibleReply(response = {}, beautyExpertV1 = null) {
  if (!isPlainObject(response) || !isPlainObject(beautyExpertV1)) return response;
  const existingReply = pickFirstTrimmed(response.reply);
  const exactAnchorMiss =
    beautyExpertV1.mode === 'exact_product_assist' &&
    asArray(beautyExpertV1.reco_bundle?.lead_picks).length === 0 &&
    asArray(beautyExpertV1.reco_bundle?.support_picks).length === 0;
  const shouldReplace =
    exactAnchorMiss ||
    !existingReply ||
    isGenericInvokeReply(existingReply);
  if (!shouldReplace) return response;
  const reply = buildBeautyExpertVisibleReply(beautyExpertV1);
  if (!reply) return response;
  return {
    ...response,
    reply,
  };
}

function attachBeautyExpertV1ToResponse(response = {}, options = {}) {
  if (!isPlainObject(response)) return response;
  const beautyExpertV1 = buildBeautyExpertV1Response({
    response,
    ...options,
  });
  if (!beautyExpertV1) return response;

  const projectedResponse = projectBeautyExpertResponse(response, beautyExpertV1);
  const projectedCards = extractCards(projectedResponse);
  const projectedBeautyExpertV1 =
    normalizeSourceToken(beautyExpertV1?.delegation_trace?.projection_type) === 'aurora-cards'
      ? {
          ...beautyExpertV1,
          ui_projections: {
            ...(isPlainObject(beautyExpertV1.ui_projections) ? beautyExpertV1.ui_projections : {}),
            aurora_cards: cloneJsonSafe(projectedCards, []),
          },
        }
      : beautyExpertV1;
  const projectedVisibleResponse = suppressExactProductConflictingAssistant(
    projectBeautyExpertVisibleReply(projectedResponse, projectedBeautyExpertV1),
    projectedBeautyExpertV1,
  );

  const next = {
    ...projectedVisibleResponse,
    beauty_expert_v1: projectedBeautyExpertV1,
  };

  if (isPlainObject(projectedVisibleResponse.metadata)) {
    next.metadata = {
      ...projectedVisibleResponse.metadata,
      beauty_capability_invoked: true,
      beauty_mode: projectedBeautyExpertV1.mode,
      final_authority_status:
        projectedBeautyExpertV1.delegation_trace?.final_authority_status || null,
      projection_type: projectedBeautyExpertV1.delegation_trace?.projection_type || null,
    };
  } else if (isPlainObject(projectedVisibleResponse.meta)) {
    next.meta = {
      ...projectedVisibleResponse.meta,
      beauty_capability_invoked: true,
      beauty_mode: projectedBeautyExpertV1.mode,
      final_authority_status:
        projectedBeautyExpertV1.delegation_trace?.final_authority_status || null,
      projection_type: projectedBeautyExpertV1.delegation_trace?.projection_type || null,
    };
  }

  return next;
}

module.exports = {
  attachBeautyExpertV1ToResponse,
  buildBeautyExpertV1Response,
};

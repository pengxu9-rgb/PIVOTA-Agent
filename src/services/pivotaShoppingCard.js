const {
  filterSurfaceableExternalHighlightSignals,
  normalizeExternalHighlightSignals,
  pickSurfaceableExternalHighlightSignal,
  buildDisplayableProofBadge,
  filterDisplayableMarketSignalBadges,
  normalizeMarketSignalBadges,
  normalizeSurfaceText,
} = require('./pivotaEvidenceSignals');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function formatCompactCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function toHeadlineCase(value) {
  return asString(value)
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) =>
      token
        .split('-')
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join('-'),
    )
    .join(' ');
}

function compactText(value, maxChars) {
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text || !Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const trimmed = text.slice(0, maxChars);
  const boundary = trimmed.lastIndexOf(' ');
  return (boundary >= Math.floor(maxChars * 0.6) ? trimmed.slice(0, boundary) : trimmed).trim();
}

function cleanSentenceText(value) {
  const clean = asString(value)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])+\s*([.!?])$/g, '$2')
    .replace(/[,\s;:]+$/g, '')
    .trim();
  if (!clean) return '';
  return clean.replace(/^([a-z])/, (match) => match.toUpperCase());
}

function punctuate(text) {
  const clean = cleanSentenceText(text);
  if (!clean) return '';
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function firstCompleteShortSentence(value, maxChars) {
  const text = asString(value).replace(/\s+/g, ' ').trim();
  if (!text || !Number.isFinite(maxChars) || maxChars <= 0) return '';
  if (text.length <= maxChars) return punctuate(text);
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [];
  for (const sentence of sentences) {
    const candidate = punctuate(sentence);
    if (candidate.length >= 24 && candidate.length <= maxChars) return candidate;
  }
  return '';
}

function compactIngredientList(ingredients) {
  const items = ingredients.map((item) => asString(item)).filter(Boolean);
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function buildHeuristicIntroCandidate(value, maxChars) {
  const text = asString(value).replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!text) return '';

  const has = (token) => lower.includes(token);
  if ((has('multi-active') || has('multi-benefit')) && has('serum')) {
    if (
      has('vitamin c') &&
      has('retinol') &&
      has('niacinamide') &&
      has('hyaluronic acid') &&
      has('salicylic acid')
    ) {
      const candidate =
        'Multi-active serum with vitamin C, retinol, niacinamide, hyaluronic and salicylic acids.';
      if (candidate.length <= maxChars) return candidate;
    }
    const ingredients = [];
    if (has('vitamin c')) ingredients.push('vitamin C');
    if (has('retinol')) ingredients.push('retinol');
    if (has('niacinamide')) ingredients.push('niacinamide');
    const acidPhrase =
      has('hyaluronic acid') && has('salicylic acid')
        ? 'hyaluronic and salicylic acids'
        : has('hyaluronic acid')
          ? 'hyaluronic acid'
          : has('salicylic acid')
            ? 'salicylic acid'
            : '';
    if (acidPhrase) ingredients.push(acidPhrase);
    const ingredientText = compactIngredientList(ingredients);
    const candidate = ingredientText
      ? `Multi-active serum with ${ingredientText}.`
      : 'Multi-active serum for tone, texture, and early-aging concerns.';
    if (candidate.length <= maxChars) return candidate;
  }

  if (has('vitamin c') && has('niacinamide') && (has('moisturizer') || has('cream'))) {
    const candidate = 'Vitamin C + niacinamide moisturizer for brighter-looking tone.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('color-correcting') && has('eye')) {
    const candidate = 'Color-correcting eye stick for dark circles and hydration.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('vitamin c') && has('eye serum')) {
    const candidate = 'Vitamin C eye serum for dullness and early fine-line care.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('night cream') && (has('oatmeal') || has('niacinamide'))) {
    const candidate = 'Rich night cream with oatmeal and niacinamide support.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('cleansing cloth')) {
    const candidate = has('vitamin c')
      ? 'Vitamin C cleansing cloths for makeup, dirt, and oil.'
      : 'Cleansing cloths for makeup, dirt, and oil.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('body wash')) {
    const candidate = has('multi-vitamin') || has('multivitamin')
      ? 'Multi-vitamin body wash for daily body cleansing.'
      : 'Daily body wash for body cleansing.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('niacinamide') && (has('cleanser') || has('cleansing'))) {
    const candidate = has('3%')
      ? '3% niacinamide cleanser for makeup, oil, and impurities.'
      : 'Niacinamide cleanser for makeup, oil, and impurities.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('vitamin c') && has('ferulic')) {
    const candidate = 'Vitamin C + ferulic serum for antioxidant brightening.';
    if (candidate.length <= maxChars) return candidate;
  }
  if (has('dark spot') || has('post-acne')) {
    const candidate = has('niacinamide')
      ? 'Niacinamide-led serum for dark spots and uneven tone.'
      : 'Serum for dark spots and uneven tone.';
    if (candidate.length <= maxChars) return candidate;
  }

  const leadingClause = text
    .replace(/^(an?|the)\s+/i, '')
    .split(/\s+(?:with|while|rather than|instead of|supported by|aimed at|made to|built for)\s+/i)[0];
  const clause = punctuate(leadingClause);
  if (clause.length >= 24 && clause.length <= maxChars) return clause;
  return '';
}

function normalizeCardIntroCandidate(value, { fallback = '', maxChars = 90 } = {}) {
  const direct = firstCompleteShortSentence(value, maxChars);
  if (direct) return direct;
  const heuristic = buildHeuristicIntroCandidate(value, maxChars);
  if (heuristic) return heuristic;
  const fallbackDirect = firstCompleteShortSentence(fallback, maxChars);
  if (fallbackDirect) return fallbackDirect;
  return buildHeuristicIntroCandidate(fallback, maxChars);
}

function inferRoutineLabel(step, fallbackCategory) {
  const stepText = asString(step).toLowerCase();
  if (stepText === 'serum') return 'serum';
  if (stepText === 'moisturizer') return 'moisturizer';
  if (stepText === 'sunscreen') return 'sunscreen';
  if (stepText === 'cleanser') return 'cleanser';
  if (stepText === 'eye treatment') return 'eye treatment';
  if (stepText === 'eye stick') return 'eye stick';
  if (stepText === 'routine set') return 'routine set';
  if (stepText === 'conditioner') return 'conditioner';
  if (stepText === 'hair treatment') return 'hair treatment';
  if (stepText === 'heat protectant') return 'heat protectant';
  if (stepText === 'makeup') return 'makeup';
  const category = asString(fallbackCategory).toLowerCase();
  if (category.includes('serum')) return 'serum';
  if (category.includes('moisturizer') || category.includes('cream')) return 'cream';
  if (category.includes('sunscreen') || category.includes('spf')) return 'sunscreen';
  if (category.includes('cleanser')) return 'cleanser';
  if (category.includes('eye')) return 'eye treatment';
  return '';
}

function compactWhatItIsHeadline(headline) {
  const text = toHeadlineCase(headline);
  if (!text || /^Pivota Insights$/i.test(text)) return '';
  return text.length <= 42 ? text : '';
}

function inferTitleSpecialtyCompactSubtitle(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const title = asString(safeProduct.title || safeProduct.name).toLowerCase();
  const category = asString(safeProduct.category || safeProduct.product_type).toLowerCase();
  const description = asString(safeProduct.description || safeProduct.short_description).toLowerCase();
  const text = `${title} ${category} ${description}`.trim();
  if (!text) return '';

  if (/\b(?:brush bundle|brush trio|brush duo|brush set)\b/.test(text)) return 'Brush Set';
  if (/\b(?:blending|packing|shader|foundation|skin tint|concealer|face|eyeliner|kyliner)?\s*brush\s*\d*\b/.test(title)) return 'Makeup Brush';
  if (/\b(?:fragrance layering balm|fragrance balm|scent balm)\b/.test(text)) return 'Fragrance Balm';
  if (/\b(?:eye duo|eye set|eye kit|essential eye duo|mascara.*(?:duo|set)|(?:duo|set).*mascara)\b/.test(text)) return 'Eye Makeup Set';
  if (/\b(?:lip duo|lip set|lip kit)\b/.test(text)) return 'Lip Set';
  if (/\b(?:makeup set|makeup kit|beauty set)\b/.test(text)) return 'Makeup Set';
  if (/\b(?:pore diffusing primer|illuminating primer|face primer|makeup primer|primer)\b/.test(text)) return 'Primer';
  if (/\bbody\s+lotion\b/.test(text)) return 'Body Lotion';
  if (/\b(?:eau de parfum|edp)\b/.test(text)) return 'Eau De Parfum';
  if (/\b(?:fragrance|perfume|parfum|body mist)\b/.test(text)) return 'Fragrance';
  if (/\bskin tint\b/.test(text)) return 'Skin Tint';
  if (/\bfoundation\b/.test(text) && !/\bbrush\b/.test(title)) return 'Foundation';
  if (/\bsetting powder\b/.test(text)) return 'Setting Powder';
  if (/\b(?:powder blush stick|blush stick)\b/.test(text)) return 'Blush Stick';
  if (/\b(?:lip\s*&\s*cheek|lip and cheek).*blush tint\b/.test(text)) return 'Blush Tint';
  if (/\b(?:pressed blush|hybrid blush|powder blush|blush)\b/.test(text)) return 'Blush';
  if (/\b(?:eyeshadow|eye shadow).*palette\b/.test(text) || /\bpalette\b/.test(title)) return 'Eyeshadow Palette';
  if (/\bmascara|kylash\b/.test(text)) return 'Mascara';
  if (/\b(?:eyeliner|kyliner)\b/.test(text)) return 'Eyeliner';
  if (/\b(?:brow|kybrow)\b/.test(text)) return 'Brow Gel';
  if (/\b(?:lip liner|pout liner)\b/.test(text)) return 'Lip Liner';
  if (/\b(?:lip oil)\b/.test(text)) return 'Lip Oil';
  if (/\b(?:lip glaze|lip gloss|gloss drip|plumping gloss)\b/.test(text)) return 'Lip Gloss';
  if (/\b(?:lipstick|lip stick)\b/.test(text)) return 'Lipstick';
  if (/\b(?:tinted butter balm|butter balm)\b/.test(text)) return 'Tinted Lip Balm';
  if (/\btoner\b/.test(text)) return 'Hydrating Toner';
  if (/\b(?:facial radiance|ingrown hair|aha|bha|glycolic|lactic)\s+pads?\b/.test(text) || /\bpads?\s+with\s+(?:bha|aha|glycolic|lactic)/.test(text)) {
    if (/\b(?:aha|bha|glycolic|lactic|salicylic)\b/.test(text)) return 'Exfoliating Pads';
    return 'Treatment Pads';
  }
  if (/\banti[-\s]?chafe\b/.test(text)) return 'Anti-Chafe Stick';
  if (/\bcleansing\s+oil\b/.test(text)) return 'Cleansing Oil';
  if (/\bsun\s+stick\b/.test(text) || (/\bstick\b/.test(text) && /\b(?:sunscreen|spf)\b/.test(text))) return 'Sun Stick SPF';
  if (/\bhand\s*(?:&|and)?\s*nail\s+cream\b/.test(text) || /\bhand\s+cream\b/.test(text)) return 'Hand Cream';
  if (/\bskin\s+milk\b/.test(text)) return 'Skin Milk';
  if (/\b(?:lip\s+balm|lip benefits|lip moisture)\b/.test(text)) return 'Lip Balm';
  if (/\b(?:cleanser|cleansing)\b/.test(text)) {
    if (/\bcleansing\s+balm\b/.test(text)) return 'Cleansing Balm';
    if (/\bcleansing\s+oil\b/.test(text)) return 'Cleansing Oil';
    if (/\bcream-to-foam\b/.test(text)) return 'Cream-To-Foam Cleanser';
    return 'Daily Cleanser';
  }
  if (/\bbody\s+scrub\b/.test(text) || /\bbump\s+eraser\b/.test(text)) {
    if (/\b(?:aha|bha|kp)\b/.test(text)) return 'AHA Body Scrub';
    return 'Body Scrub';
  }
  if (/\bshav(?:e|ing)\s+cream\b/.test(text)) return 'Shave Cream';
  if (/\bdeodorant\b/.test(text)) return /\bcream\b/.test(text) ? 'Deodorant Cream' : 'Deodorant';
  if (/\bbody\s+oil\b/.test(text)) return 'Body Oil';
  if (/\bbody\s+mist\b/.test(text) || (/\bmist\b/.test(text) && /\b(?:body|acne|salicylic|bha|aha)\b/.test(text))) {
    if (/\b(?:acne|salicylic|bha|aha)\b/.test(text)) return 'Body Treatment Mist';
    return 'Body Mist';
  }
  if (/\beye\s+balm\b/.test(text)) return 'Eye Balm';
  if (/\beye\s+cream\b/.test(text)) return 'Eye Cream';
  if (/\blip\s+balm\b/.test(text)) return 'Lip Balm';
  if (/\bsleeping\s+pack\b/.test(text)) return 'Sleeping Pack';
  if (/\bsheet\s+mask\b/.test(text)) return 'Sheet Mask';
  if (/\b(?:gel|jelly|facial|collagen|firming)\s+mask\b/.test(text) || /\bmask\b/.test(title)) {
    return 'Treatment Mask';
  }
  return '';
}

function normalizeCompactComparisonText(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[–—]/g, '-')
    .replace(/[^\w%+ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isApprovedExternalHighlightReviewStatus(value) {
  const status = asString(value).toLowerCase();
  return status === 'pass' || status === 'rewrite';
}

function bundleHasUnreviewedExternalHighlightWork(bundle) {
  const status = asString(bundle?.provenance?.external_highlight_review_status).toLowerCase();
  if (status) return !isApprovedExternalHighlightReviewStatus(status);
  if (toList(bundle?.external_highlight_signals).length) return true;
  if (asString(bundle?.provenance?.external_evidence_generated_at)) return true;
  return false;
}

function looksLikeEntityStyleCompactHighlight(value) {
  const text = normalizeCompactComparisonText(value);
  if (!text) return true;
  if (text.split(' ').length <= 1) return true;
  if (
    /^(?:\d+%?\s+)?(?:niacinamide|vitamin c|retinol|peptide|azelaic acid(?: derivative)?|salicylic acid|hyaluronic acid)\s+(?:serum|moisturizer|cream|cleanser|lotion)$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /^(?:spf(?:\s+\d+\+?)?|multi-active|amla brightening|brightening|hydrating|gentle|daily|color-correcting|multi-vitamin)\s+(?:serum|moisturizer|cream|cleanser|lotion|toner|sunscreen|body wash|mask|balm)$/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/^(?:color-correcting|brightening|hydrating)\s+eye\s+(?:stick|serum|cream)$/i.test(text)) {
    return true;
  }
  if (
    /\b(serum|moisturizer|cream|cleanser|lotion|toner|mask|balm|sunscreen|body wash|eye stick|eye serum|eye cream|lip balm)$/.test(
      text,
    ) &&
    !/\b(with|for|under|over|against|without|in|from|instead|versus|vs)\b/.test(text) &&
    text.split(' ').length <= 4
  ) {
    return true;
  }
  return false;
}

function resolveDisplayableCompactHighlight(value, { bundle = null, title = '', subtitle = '' } = {}) {
  const normalized = normalizeSurfaceText(value);
  if (!normalized) return '';
  if (bundleHasUnreviewedExternalHighlightWork(bundle)) return '';

  const normalizedHighlight = normalizeCompactComparisonText(normalized);
  const normalizedSubtitle = normalizeCompactComparisonText(subtitle);
  const normalizedTitle = normalizeCompactComparisonText(title);

  if (normalizedSubtitle && normalizedHighlight === normalizedSubtitle) return '';
  if (normalizedTitle && normalizedHighlight === normalizedTitle) return '';
  if (looksLikeEntityStyleCompactHighlight(normalized)) return '';

  return normalized;
}

function normalizeBadgeCandidates(value) {
  return normalizeMarketSignalBadges(toList(value)).map((badge) => ({
    badge_type: asString(badge.badge_type),
    badge_label: asString(badge.badge_label),
  }));
}

function normalizeHighlightCandidates(value) {
  return normalizeExternalHighlightSignals(value).map((signal) => ({
    signal_id: asString(signal.signal_id),
    source_type: asString(signal.source_type),
    claim_type: asString(signal.claim_type),
    claim_text: asString(signal.claim_text),
    ...(asString(signal.surface_text) ? { surface_text: asString(signal.surface_text) } : {}),
    stance: asString(signal.stance),
    evidence_strength: asString(signal.evidence_strength),
    sponsorship_status: asString(signal.sponsorship_status),
    independence_count: Number(signal.independence_count || 0) || 0,
    surfaceable: signal.surfaceable === true,
    surface_targets: toList(signal.surface_targets),
  }));
}

function buildCompactSubtitle({ product, bundle }) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const core = bundle?.product_intel_core || {};
  const stepLabel = inferRoutineLabel(core?.routine_fit?.step, safeProduct.category || safeProduct.product_type);
  const whatBody = asString(core?.what_it_is?.body).toLowerCase();
  const compactHeadline = compactWhatItIsHeadline(core?.what_it_is?.headline);
  if (
    [
      'Routine Set',
      'Hair Conditioner',
      'Hair Repair Treatment',
      'Heat Protectant Cream',
      'Color Makeup',
    ].includes(compactHeadline)
  ) {
    return compactHeadline;
  }

  const specialtySubtitle = inferTitleSpecialtyCompactSubtitle(safeProduct);
  if (specialtySubtitle) return specialtySubtitle;

  if (stepLabel === 'serum' && whatBody.includes('vitamin c') && whatBody.includes('retinol')) {
    return 'Vitamin C + retinol serum';
  }
  if (whatBody.includes('multi-active') && stepLabel) {
    return toHeadlineCase(`multi-active ${stepLabel}`);
  }
  if (whatBody.includes('vitamin c') && whatBody.includes('niacinamide') && stepLabel) {
    return toHeadlineCase(`vitamin c + niacinamide ${stepLabel}`);
  }
  if (whatBody.includes('amla') && stepLabel) {
    return toHeadlineCase(`amla brightening ${stepLabel}`);
  }
  if (
    (whatBody.includes('broad-spectrum') || whatBody.includes('spf') || whatBody.includes('sunscreen')) &&
    stepLabel === 'moisturizer'
  ) {
    return 'SPF moisturizer';
  }
  if (whatBody.includes('color-correcting') && whatBody.includes('eye') && stepLabel) {
    return toHeadlineCase(`color-correcting ${stepLabel}`);
  }

  if (compactHeadline) return compactHeadline;

  return toHeadlineCase(safeProduct.product_type || safeProduct.category).slice(0, 42);
}

function buildProofBadge({ product, bundle }) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  return buildDisplayableProofBadge(
    {
      market_signal_badges: bundle?.market_signal_badges || safeProduct.market_signal_badges,
      review_summary: bundle?.review_summary || safeProduct.review_summary,
      community_signals: bundle?.community_signals || safeProduct.community_signals,
    },
    { formatCompactCount },
  );
}

function buildTitleCandidate(product) {
  const safeProduct = product && typeof product === 'object' ? product : {};
  const brand = asString(safeProduct.brand);
  const title = asString(safeProduct.title || safeProduct.name);
  if (!brand || !title) return title || 'Untitled product';
  if (title.toLowerCase().startsWith(brand.toLowerCase())) return title;
  return `${brand} ${title}`.trim();
}

function buildCardIntro({ bundle }) {
  const explicitIntro = asString(
    bundle?.search_card?.intro_candidate || bundle?.shopping_card?.intro,
  );
  if (explicitIntro) {
    return normalizeCardIntroCandidate(explicitIntro, {
      fallback: bundle?.product_intel_core?.what_it_is?.body,
      maxChars: 90,
    });
  }
  const signal = pickSurfaceableExternalHighlightSignal(bundle?.external_highlight_signals, {
    surfaceTarget: 'search_card_intro',
  });
  if (signal?.claim_text) {
    return normalizeCardIntroCandidate(signal.claim_text, {
      fallback: bundle?.product_intel_core?.what_it_is?.body,
      maxChars: 90,
    });
  }
  return normalizeCardIntroCandidate(bundle?.product_intel_core?.what_it_is?.body, {
    maxChars: 90,
  });
}

function buildCardHighlight({ bundle }) {
  const explicitHighlight = asString(
    bundle?.search_card?.highlight_candidate || bundle?.shopping_card?.highlight,
  );
  if (explicitHighlight) {
    const resolvedExplicit = resolveDisplayableCompactHighlight(explicitHighlight, {
      bundle,
      title: bundle?.shopping_card?.title || bundle?.search_card?.title_candidate,
      subtitle: bundle?.shopping_card?.subtitle || bundle?.search_card?.compact_candidate,
    });
    if (resolvedExplicit) return resolvedExplicit;
  }
  const signal = pickSurfaceableExternalHighlightSignal(bundle?.external_highlight_signals, {
    surfaceTarget: 'shopping_card_highlight',
  });
  return resolveDisplayableCompactHighlight(
    normalizeSurfaceText(signal?.surface_text) || normalizeSurfaceText(signal?.claim_text),
    {
      bundle,
      title: bundle?.shopping_card?.title || bundle?.search_card?.title_candidate,
      subtitle: bundle?.shopping_card?.subtitle || bundle?.search_card?.compact_candidate,
    },
  );
}

function buildShoppingCardPayload({ product, bundle }) {
  const title = buildTitleCandidate(product);
  const subtitle = buildCompactSubtitle({ product, bundle });
  const proofBadge = buildProofBadge({ product, bundle });
  const highlight = buildCardHighlight({ bundle });
  const intro = buildCardIntro({ bundle });
  const explicitBadges =
    Array.isArray(bundle?.market_signal_badges) && bundle.market_signal_badges.length
      ? bundle.market_signal_badges
      : proofBadge
        ? [proofBadge]
        : [];
  const evidenceContext = {
    market_signal_badges: bundle?.market_signal_badges || product?.market_signal_badges,
    review_summary: bundle?.review_summary || product?.review_summary,
    community_signals: bundle?.community_signals || product?.community_signals,
  };
  const marketSignalBadges = filterDisplayableMarketSignalBadges(
    explicitBadges,
    evidenceContext,
  ).map((badge) => ({
    badge_type: asString(badge.badge_type),
    badge_label: asString(badge.badge_label),
  }));
  const visibleExternalHighlights = filterSurfaceableExternalHighlightSignals(
    bundle?.external_highlight_signals,
  );

  return {
    contract_version: 'pivota.shopping_card.v1',
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(proofBadge?.badge_label ? { proof_badge: proofBadge.badge_label } : {}),
    ...(highlight ? { highlight } : {}),
    ...(intro ? { intro } : {}),
    ...(marketSignalBadges.length ? { market_signal_badges: marketSignalBadges } : {}),
    ...(visibleExternalHighlights.length
      ? { external_highlight_signals: normalizeHighlightCandidates(visibleExternalHighlights) }
      : {}),
    ...(asString(bundle?.evidence_profile) ? { evidence_profile: asString(bundle.evidence_profile) } : {}),
  };
}

function buildSearchCardPayload({ product, bundle }) {
  const shoppingCard = buildShoppingCardPayload({ product, bundle });
  const introCandidate = shoppingCard.intro
    ? normalizeCardIntroCandidate(shoppingCard.intro, {
        fallback: bundle?.product_intel_core?.what_it_is?.body,
        maxChars: 90,
      })
    : '';
  return {
    title_candidate: shoppingCard.title,
    ...(shoppingCard.subtitle ? { compact_candidate: shoppingCard.subtitle } : {}),
    ...(shoppingCard.highlight ? { highlight_candidate: compactText(shoppingCard.highlight, 40) } : {}),
    ...(shoppingCard.proof_badge ? { proof_badge_candidate: shoppingCard.proof_badge } : {}),
    ...(introCandidate ? { intro_candidate: introCandidate } : {}),
  };
}

module.exports = {
  buildCompactSubtitle,
  buildCardHighlight,
  buildCardIntro,
  buildProofBadge,
  inferTitleSpecialtyCompactSubtitle,
  buildSearchCardPayload,
  buildShoppingCardPayload,
  buildTitleCandidate,
  bundleHasUnreviewedExternalHighlightWork,
  isApprovedExternalHighlightReviewStatus,
  resolveDisplayableCompactHighlight,
  normalizeCardIntroCandidate,
  normalizeBadgeCandidates,
  normalizeHighlightCandidates,
};

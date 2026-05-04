const {
  isHumanReviewedProductIntelBundle,
  normalizePublishedProductIntelBundle,
} = require('../pdpProductIntel');
const { buildAuthoritativeIngredientView } = require('./pdpIngredientAuthority');
const { normalizeSeedVariants } = require('./externalSeedProducts');
const { classifyExternalSeedProductKind } = require('./externalSeedProductKind');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function ensureObject(value) {
  return asPlainObject(value) || {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function lowerText(value) {
  return stripHtml(value).toLowerCase();
}

function increment(map, key, amount = 1) {
  const normalized = asString(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function topEntries(map, limit = 20) {
  return Object.entries(map || {})
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(1, limit))
    .map(([key, count]) => ({ key, count }));
}

const PRODUCT_INTEL_CONTRACT_VERSION = 'pivota.product_intel.v1';

const PRODUCT_INTEL_BLOCKING_ISSUES = new Set([
  'missing_kb',
  'kb_error',
  'missing_bundle',
  'not_reviewed',
  'not_displayable_gate',
  'reviewed_not_displayable',
  'missing_card_highlight',
  'ellipsis_or_truncated',
  'what_it_is_too_long',
  'generic_copy_signal',
]);

const REGULATORY_ACTIVE_TERMS = [
  'zinc oxide',
  'titanium dioxide',
  'avobenzone',
  'octocrylene',
  'octisalate',
  'homosalate',
  'octinoxate',
  'ensulizole',
  'oxybenzone',
  'meradimate',
  'tinosorb s',
  'tinosorb m',
  'uvinul a plus',
  'uvinul t 150',
  'mexoryl sx',
  'mexoryl xl',
  'benzoyl peroxide',
  'adapalene',
  'sulfur',
  'salicylic acid',
];

const HERO_INGREDIENT_TERMS = [
  'retinol',
  'retinal',
  'retinaldehyde',
  'bakuchiol',
  'vitamin c',
  'ascorbic acid',
  'ethyl ascorbic acid',
  'tetrahexyldecyl ascorbate',
  'niacinamide',
  'hyaluronic acid',
  'ceramide',
  'peptide',
  'copper peptide',
  'glycolic acid',
  'lactic acid',
  'mandelic acid',
  'azelaic acid',
  'tranexamic acid',
  'pha',
  'gluconolactone',
  'panthenol',
  'centella',
  'madecassoside',
  'snail mucin',
  'rice',
  'propolis',
  'alpha arbutin',
  'caffeine',
  'squalane',
  'urea',
  'colloidal oatmeal',
  'ectoin',
];

const LOW_SIGNAL_ACTIVE_ITEMS = new Set([
  'water',
  'aqua',
  'glycerin',
  'butylene glycol',
  'propylene glycol',
  'caprylyl glycol',
  'phenoxyethanol',
  'ethylhexylglycerin',
  'fragrance',
  'parfum',
  'disodium edta',
  'sodium chloride',
  'xanthan gum',
  'citric acid',
  'sodium hydroxide',
  'carbomer',
  'tocopherol',
  'alcohol',
  'alcohol denat',
  '1,2-hexanediol',
  'hexylene glycol',
  'dipropylene glycol',
  'polysorbate 20',
  'triethanolamine',
]);

const SUNSCREEN_CONTEXT_RE =
  /\b(spf\s*\d*|sunscreen|sun screen|sunblock|broad spectrum|pa\+|uv protection|mineral sunscreen|chemical sunscreen)\b/i;
const ACNE_REGULATORY_CONTEXT_RE =
  /\b(acne treatment|drug facts|benzoyl peroxide|adapalene)\b/i;
const GENERIC_INTEL_RE =
  /\b(product data|merchant product data|routine context|positions? itself|formula story|title[-\s]?driven|listing[-\s]?grounded|general use|all skin types|anchors? the product)\b/i;
const INVALID_ACTIVE_FRAGMENT_RE =
  /^(?:see|learn more|tab on|restores damaged|chapped|none|n\/a)$/i;
const VARIANT_IDENTITY_OPTION_NAMES = new Set([
  'offer',
  'sku',
  'sku id',
  'variant sku',
  'barcode',
  'upc',
  'ean',
  'gtin',
  'product id',
  'variant id',
  'title',
]);
const GENERIC_VARIANT_AXIS_NAMES = new Set(['option', 'variant', 'selection']);
const VARIANT_SIZE_EVIDENCE_RE = /\b\d+(?:\.\d+)?\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/i;
const NAMED_VARIANT_SIZE_EVIDENCE_RE = /\b(full size|travel size|jumbo|mini|refill|regular|standard|one size)\b/i;
const STRONG_NAMED_VARIANT_SIZE_EVIDENCE_RE = /\b(full size|travel size|jumbo|mini|refill|one size)\b/i;
const BASELINE_NAMED_VARIANT_SIZE_EVIDENCE_RE = /\b(regular|standard)\b/i;
const SHADE_AXIS_NAMES = new Set(['shade', 'color', 'colour', 'tone', 'hue']);
const LOCALE_LIKE_VARIANT_VALUES = new Set(['us', 'usa', 'uk', 'eu', 'fr', 'de', 'es', 'it', 'ca', 'au', 'jp', 'kr', 'cn']);
const DEFAULT_TITLE_AXIS_VALUES = new Set(['default', 'default title']);

function normalizedTerm(value) {
  return lowerText(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function includesAnyTerm(text, terms) {
  return terms.some((term) => text.includes(term));
}

function readProductIntelBundleFromKbRow(row) {
  const analysis = ensureObject(row?.kb_analysis || row?.analysis);
  const direct =
    asPlainObject(analysis.product_intel_v1) ||
    asPlainObject(analysis.product_intel) ||
    (asString(analysis.contract_version) === PRODUCT_INTEL_CONTRACT_VERSION ? analysis : null);
  return direct || null;
}

function normalizeKbRow(row) {
  const source = ensureObject(row);
  return {
    kb_key: asString(source.kb_key || source.kbKey),
    analysis: source.kb_analysis || source.analysis || null,
    source: asString(source.kb_source || source.source),
    source_meta: asPlainObject(source.kb_source_meta) || asPlainObject(source.source_meta) || null,
    last_error: source.kb_last_error || source.last_error || null,
    last_success_at: source.kb_last_success_at || source.last_success_at || null,
    updated_at: source.kb_updated_at || source.updated_at || null,
  };
}

function productIdFromKbKey(kbKey) {
  const text = asString(kbKey);
  return text.startsWith('product:') ? text.slice('product:'.length) : text;
}

function readProductIntelCore(bundle) {
  return ensureObject(bundle?.product_intel_core || bundle?.core);
}

function collectProductIntelTexts(bundle) {
  const core = readProductIntelCore(bundle);
  const shoppingCard = ensureObject(bundle?.shopping_card || core.shopping_card);
  const searchCard = ensureObject(bundle?.search_card || core.search_card);
  const texts = [
    core.what_it_is?.headline,
    core.what_it_is?.body,
    core.routine_fit?.step,
    ...asArray(core.routine_fit?.pairing_notes),
    shoppingCard.highlight,
    shoppingCard.subtitle,
    shoppingCard.intro,
    searchCard.highlight_candidate,
    searchCard.compact_candidate,
    searchCard.intro_candidate,
  ];
  for (const item of asArray(core.why_it_stands_out)) {
    const row = ensureObject(item);
    texts.push(row.headline, row.body);
  }
  for (const item of asArray(core.best_for)) {
    const row = ensureObject(item);
    texts.push(row.label || item, row.tag);
  }
  for (const item of asArray(core.watchouts)) {
    const row = ensureObject(item);
    texts.push(row.label || item, row.body);
  }
  return texts.map(stripHtml).filter(Boolean);
}

function readIntelQualityState(bundle, sourceMeta) {
  const core = readProductIntelCore(bundle);
  return lowerText(bundle?.quality_state || core.quality_state || sourceMeta?.quality_state) || 'unknown';
}

function readIntelEvidenceProfile(bundle, sourceMeta) {
  const core = readProductIntelCore(bundle);
  return lowerText(bundle?.evidence_profile || core.evidence_profile || sourceMeta?.evidence_profile) || 'unknown';
}

function classifyProductIntelKbRow(row, options = {}) {
  const kbRow = normalizeKbRow(row);
  const productId = asString(options.productId || productIdFromKbKey(kbRow.kb_key));
  if (!kbRow.kb_key && !kbRow.analysis) {
    return {
      product_id: productId,
      kb_key: null,
      status: 'missing_kb',
      kb_exists: false,
      displayable: false,
      high_quality_ready: false,
      issues: ['missing_kb'],
      quality_state: 'missing',
      evidence_profile: 'missing',
    };
  }
  if (kbRow.last_error) {
    return {
      product_id: productId,
      kb_key: kbRow.kb_key,
      status: 'kb_error',
      kb_exists: true,
      displayable: false,
      high_quality_ready: false,
      issues: ['kb_error'],
      quality_state: 'error',
      evidence_profile: 'unknown',
    };
  }

  const bundle = readProductIntelBundleFromKbRow(kbRow);
  if (!bundle) {
    return {
      product_id: productId,
      kb_key: kbRow.kb_key,
      status: 'missing_bundle',
      kb_exists: true,
      displayable: false,
      high_quality_ready: false,
      issues: ['missing_bundle'],
      quality_state: 'missing_bundle',
      evidence_profile: 'unknown',
    };
  }

  const sourceMeta = ensureObject(kbRow.source_meta);
  const provenance = {
    ...(ensureObject(bundle.provenance) || {}),
    ...sourceMeta,
    ...(kbRow.kb_key ? { kb_key: kbRow.kb_key } : {}),
    source: kbRow.source || 'aurora_product_intel_kb',
  };
  const enrichedBundle = { ...bundle, provenance };
  const normalized = normalizePublishedProductIntelBundle(enrichedBundle, {
    requireReviewed: true,
    provenance,
  });
  const humanReviewed = isHumanReviewedProductIntelBundle(enrichedBundle);
  const core = readProductIntelCore(bundle);
  const normalizedCore = readProductIntelCore(normalized || {});
  const shoppingCard = ensureObject(bundle.shopping_card || core.shopping_card);
  const searchCard = ensureObject(bundle.search_card || core.search_card);
  const normalizedShoppingCard = ensureObject(normalized?.shopping_card);
  const normalizedSearchCard = ensureObject(normalized?.search_card);
  const hasCardHighlight = Boolean(
    asString(shoppingCard.highlight) ||
      asString(searchCard.highlight_candidate) ||
      asString(normalizedShoppingCard.highlight) ||
      asString(normalizedSearchCard.highlight_candidate),
  );
  const texts = collectProductIntelTexts(bundle);
  const issues = [];
  if (!humanReviewed) issues.push('not_reviewed');
  if (!normalized) issues.push(humanReviewed ? 'reviewed_not_displayable' : 'not_displayable_gate');
  if (!hasCardHighlight) issues.push('missing_card_highlight');
  if (texts.some((text) => /…|\.\.\./.test(text))) issues.push('ellipsis_or_truncated');
  if (stripHtml(core.what_it_is?.body || normalizedCore.what_it_is?.body).length > 420) {
    issues.push('what_it_is_too_long');
  }
  if (texts.some((text) => GENERIC_INTEL_RE.test(text))) issues.push('generic_copy_signal');
  if (!asArray(core.watchouts).length) issues.push('empty_watchouts');

  const qualityState = readIntelQualityState(bundle, sourceMeta);
  const evidenceProfile = readIntelEvidenceProfile(bundle, sourceMeta);
  if (qualityState && !['verified', 'ready', 'reviewed'].includes(qualityState)) {
    issues.push(`quality_${qualityState}`);
  }
  if (evidenceProfile === 'seller_only') issues.push('seller_only_evidence');

  const blockingIssues = issues.filter((issue) => PRODUCT_INTEL_BLOCKING_ISSUES.has(issue));
  const displayable = Boolean(normalized);
  const highQualityReady = displayable && blockingIssues.length === 0 && evidenceProfile !== 'seller_only';
  return {
    product_id: productId,
    kb_key: kbRow.kb_key,
    status: displayable ? 'displayable' : 'not_displayable',
    kb_exists: true,
    displayable,
    high_quality_ready: highQualityReady,
    human_reviewed: humanReviewed,
    issues,
    blocking_issues: blockingIssues,
    quality_state: qualityState,
    evidence_profile: evidenceProfile,
    has_card_highlight: hasCardHighlight,
  };
}

function chooseEffectiveIntelCandidate(candidates) {
  const ranked = asArray(candidates).filter(Boolean);
  return (
    ranked.find((candidate) => candidate.high_quality_ready) ||
    ranked.find((candidate) => candidate.displayable) ||
    ranked.find((candidate) => candidate.kb_exists) ||
    ranked[0] ||
    classifyProductIntelKbRow(null)
  );
}

function classifyEffectiveProductIntel(row, context = {}) {
  const productId = asString(row?.external_product_id || row?.product_id || row?.id);
  const directKbRow = context.kbByProductId?.get?.(productId) || row;
  const direct = classifyProductIntelKbRow(directKbRow, { productId });
  const productLineId =
    asString(row?.identity_product_line_id || context.productLineIdByProductId?.get?.(productId)) || '';
  const siblingIds = productLineId ? asArray(context.productIdsByLineId?.get?.(productLineId)) : [];
  const candidateIds = Array.from(new Set([productId, ...siblingIds].filter(Boolean)));
  const candidates = candidateIds.map((candidateId) =>
    classifyProductIntelKbRow(context.kbByProductId?.get?.(candidateId), { productId: candidateId }),
  );
  const effective = chooseEffectiveIntelCandidate(candidates.length ? candidates : [direct]);
  return {
    direct,
    effective,
    product_line_id: productLineId || null,
    borrowed_from_sibling: Boolean(effective.product_id && effective.product_id !== productId),
  };
}

function readSeedCoverage(row) {
  const seedData = ensureObject(row?.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  const detailsSections = [
    ...asArray(seedData.pdp_details_sections),
    ...asArray(snapshot.pdp_details_sections),
    ...asArray(seedData.details_sections),
    ...asArray(snapshot.details_sections),
  ];
  const faqItems = [
    ...asArray(seedData.pdp_faq_items),
    ...asArray(snapshot.pdp_faq_items),
    ...asArray(seedData.faq_items),
    ...asArray(snapshot.faq_items),
  ];
  const howTo = [
    seedData.pdp_how_to_use_raw,
    snapshot.pdp_how_to_use_raw,
    seedData.how_to_use_raw,
    snapshot.how_to_use_raw,
  ]
    .map(stripHtml)
    .find(Boolean) || '';
  const inci = [
    seedData.pdp_ingredients_raw,
    snapshot.pdp_ingredients_raw,
    seedData.ingredients_raw,
    snapshot.ingredients_raw,
    seedData.raw_ingredient_text_clean,
    snapshot.raw_ingredient_text_clean,
  ]
    .map(stripHtml)
    .find(Boolean) || '';
  const active = [
    seedData.pdp_active_ingredients_raw,
    snapshot.pdp_active_ingredients_raw,
    seedData.active_ingredients,
    snapshot.active_ingredients,
  ]
    .map((value) => (Array.isArray(value) ? value.join(', ') : value))
    .map(stripHtml)
    .find(Boolean) || '';
  return {
    details_sections_count: detailsSections.length,
    faq_count: faqItems.length,
    how_to_chars: howTo.length,
    inci_chars: inci.length,
    active_ingredients_chars: active.length,
  };
}

function collectContextText(row) {
  const seedData = ensureObject(row?.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  return [
    row?.title,
    row?.domain,
    row?.canonical_url,
    row?.destination_url,
    seedData.brand,
    snapshot.brand,
    seedData.category,
    snapshot.category,
    seedData.product_type,
    snapshot.product_type,
    seedData.productType,
    snapshot.productType,
    ...asArray(seedData.tags),
    ...asArray(snapshot.tags),
  ]
    .map(stripHtml)
    .filter(Boolean)
    .join(' ');
}

function collectDescriptiveText(row) {
  const seedData = ensureObject(row?.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  const sections = [
    ...asArray(seedData.pdp_details_sections),
    ...asArray(snapshot.pdp_details_sections),
    ...asArray(seedData.details_sections),
    ...asArray(snapshot.details_sections),
  ];
  const sectionText = sections.map((section) => {
    const rowSection = ensureObject(section);
    return `${rowSection.heading || rowSection.title || rowSection.name || ''} ${
      rowSection.content || rowSection.body || rowSection.value || rowSection.text || ''
    }`;
  });
  return [
    collectContextText(row),
    seedData.pdp_description_raw,
    snapshot.pdp_description_raw,
    seedData.description_raw,
    snapshot.description_raw,
    seedData.description,
    snapshot.description,
    ...sectionText,
  ]
    .map(stripHtml)
    .filter(Boolean)
    .join(' ');
}

function allowsShadeAxis(text) {
  return /\b(tinted?|skin tint|shade|color[-\s]?correct|colour[-\s]?correct|tone[-\s]?up|tone[-\s]?correct|lip tint|tint balm|honey tint|lipstick|lip gloss|lip oil|lip balm|lip cream|lip mask|lip color|lip paint|foundation|concealer|bronzer|blush|highlighter|powder|eyeshadow|eyeliner|brow|mascara|makeup|cosmetic)\b/i.test(
    text,
  );
}

function isSkincareLike(text) {
  return /\b(serum|essence|ampoule|moisturi[sz]er|cream|cleanser|toner|lotion|balm|mask|treatment|sunscreen|spf|sun protection|skin care|skincare|barrier|retinol|niacinamide|vitamin c|acid)\b/i.test(
    text,
  );
}

function looksLikeSizeValue(value) {
  const text = stripHtml(value);
  if (!text) return false;
  return (
    /\b\d+(?:\.\d+)?\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/i.test(text) ||
    /\b(pack of|set of)\s*\d+\b/i.test(text) ||
    /\b\d+\s*(pack|ct|count|pcs|pieces)\b/i.test(text) ||
    /\b(refill|travel size|full size|mini|jumbo|regular)\b/i.test(text)
  );
}

function shouldRequireDefaultVariantSizeAxis(row) {
  const family = classifyExternalSeedProductKind(row).family;
  return !['set_or_collection', 'non_merch', 'accessory'].includes(family);
}

function hasVariantVisualEvidence(variant) {
  return Boolean(
    stripHtml(
      variant?.label_image_url ||
        variant?.swatch_image_url ||
        variant?.image_url ||
        variant?.image,
    ) ||
      stripHtml(
        variant?.swatch?.hex ||
          variant?.swatch_color ||
          variant?.color_hex ||
          variant?.shade_hex,
      ),
  );
}

function collectVariantSizeEvidence(row) {
  const seedData = ensureObject(row?.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  const rawVariants = [
    ...asArray(snapshot.variants),
    ...asArray(seedData.variants),
    ...asArray(snapshot.skus),
    ...asArray(seedData.skus),
  ];
  const parts = [
    row?.title,
    row?.canonical_url,
    row?.destination_url,
    row?.image_url,
    seedData.size,
    snapshot.size,
    seedData.volume,
    snapshot.volume,
    seedData.product_size,
    snapshot.product_size,
    seedData.product_volume,
    snapshot.product_volume,
    seedData.net_content,
    snapshot.net_content,
    seedData.net_size,
    snapshot.net_size,
    seedData.image_url,
    snapshot.image_url,
    ...asArray(seedData.image_urls),
    ...asArray(snapshot.image_urls),
    ...rawVariants.flatMap((variant) => [
      variant?.title,
      variant?.option_name,
      variant?.option_value,
      variant?.url,
      variant?.image_url,
      ...asArray(variant?.image_urls),
    ]),
  ]
    .map(stripHtml)
    .filter(Boolean);
  const evidence = parts.find((part) => VARIANT_SIZE_EVIDENCE_RE.test(part)) || '';
  const namedEvidence =
    evidence ||
    parts.find((part) => NAMED_VARIANT_SIZE_EVIDENCE_RE.test(part)) ||
    '';
  return {
    raw_variant_count: rawVariants.length,
    evidence: namedEvidence,
  };
}

function classifyVariantReadiness(row, context = {}) {
  const productId = asString(row?.external_product_id || row?.product_id || row?.id);
  const variants = normalizeSeedVariants(row?.seed_data, row);
  const contextText = lowerText(collectContextText(row));
  const productLineId =
    asString(row?.identity_product_line_id || context.productLineIdByProductId?.get?.(productId)) || '';
  const siblingIds = productLineId
    ? asArray(context.productIdsByLineId?.get?.(productLineId)).filter((id) => asString(id) && asString(id) !== productId)
    : [];
  const identityVariantAxes =
    asPlainObject(context.variantAxesByProductId?.get?.(productId)) ||
    asPlainObject(row?.identity_variant_axes) ||
    {};
  const rows = [];
  for (const variant of variants) {
    for (const option of asArray(variant?.options)) {
      rows.push({
        axis_name: lowerText(option?.name),
        axis_kind: lowerText(option?.axis_kind || variant?.axis_kind),
        value: lowerText(option?.value),
        visual: hasVariantVisualEvidence(variant),
      });
    }
  }
  const visibleRows = rows.filter((item) => item.value);
  const identityOptionVisible = visibleRows.filter((item) => VARIANT_IDENTITY_OPTION_NAMES.has(item.axis_name));
  const wrongAxisForCategory = visibleRows.filter((item) => {
    const axisName = item.axis_kind || item.axis_name;
    if (!SHADE_AXIS_NAMES.has(axisName)) return false;
    if (allowsShadeAxis(contextText)) return false;
    return LOCALE_LIKE_VARIANT_VALUES.has(item.value) || isSkincareLike(contextText);
  });
  const makeupShadeMissingVisual = visibleRows.filter((item) => {
    const axisName = item.axis_kind || item.axis_name;
    return SHADE_AXIS_NAMES.has(axisName) && allowsShadeAxis(contextText) && !item.visual;
  });
  const sizeValueGenericAxis = visibleRows.filter((item) => {
    const axisName = item.axis_kind || item.axis_name;
    return GENERIC_VARIANT_AXIS_NAMES.has(axisName) && looksLikeSizeValue(item.value);
  });
  const sizeEvidence = collectVariantSizeEvidence(row);
  const siblingHasDisplayableSizeAxis = siblingIds.some((id) => {
    const axes = asPlainObject(context.variantAxesByProductId?.get?.(id)) || {};
    return Boolean(asString(axes.size) || asString(axes.volume) || asString(axes.pack));
  });
  const strongNamedSizeEvidence = STRONG_NAMED_VARIANT_SIZE_EVIDENCE_RE.test(sizeEvidence.evidence || '');
  const baselineNamedSizeEvidence = BASELINE_NAMED_VARIANT_SIZE_EVIDENCE_RE.test(sizeEvidence.evidence || '');
  const defaultOptionSizeEvidenceMissingAxis =
    visibleRows.length === 0 &&
    sizeEvidence.raw_variant_count > 0 &&
    sizeEvidence.evidence &&
    shouldRequireDefaultVariantSizeAxis(row) &&
    (
      sizeEvidence.raw_variant_count > 1 ||
      strongNamedSizeEvidence ||
      (siblingHasDisplayableSizeAxis && NAMED_VARIANT_SIZE_EVIDENCE_RE.test(sizeEvidence.evidence || '')) ||
      (siblingHasDisplayableSizeAxis && baselineNamedSizeEvidence)
    )
      ? [{ axis_name: 'default', axis_kind: 'volume', value: sizeEvidence.evidence, visual: false }]
      : [];
  const identityDefaultTitleAxis =
    ['shade', 'color']
      .map((key) => lowerText(identityVariantAxes[key]))
      .filter(Boolean)
      .some((value) => DEFAULT_TITLE_AXIS_VALUES.has(value))
      ? [{ axis_name: 'identity', axis_kind: 'shade', value: 'default title', visual: false }]
      : [];
  const issues = [];
  if (identityOptionVisible.length) issues.push('identity_option_visible');
  if (wrongAxisForCategory.length) issues.push('wrong_axis_for_category');
  if (makeupShadeMissingVisual.length) issues.push('makeup_shade_missing_visual');
  if (sizeValueGenericAxis.length) issues.push('size_value_generic_axis');
  if (defaultOptionSizeEvidenceMissingAxis.length) issues.push('default_option_size_evidence_missing_axis');
  if (identityDefaultTitleAxis.length) issues.push('identity_default_title_axis');
  return {
    status: issues.length ? 'flagged' : visibleRows.length ? 'ready' : 'no_visible_variant_axis',
    issues,
    visible_variant_rows: visibleRows.length,
    examples: {
      identity_option_visible: identityOptionVisible.slice(0, 4),
      wrong_axis_for_category: wrongAxisForCategory.slice(0, 4),
      makeup_shade_missing_visual: makeupShadeMissingVisual.slice(0, 4),
      size_value_generic_axis: sizeValueGenericAxis.slice(0, 4),
      default_option_size_evidence_missing_axis: defaultOptionSizeEvidenceMissingAxis.slice(0, 4),
      identity_default_title_axis: identityDefaultTitleAxis.slice(0, 4),
    },
  };
}

function isNonMerchOrAccessory(row) {
  const family = classifyExternalSeedProductKind(row).family;
  return family === 'non_merch' || family === 'accessory' || family === 'set_or_collection';
}

function classifyProductFamily(row) {
  return classifyExternalSeedProductKind(row).family;
}

function isRegulatoryActiveExpected(row) {
  if (isNonMerchOrAccessory(row)) return false;
  const context = lowerText(collectContextText(row));
  return (
    SUNSCREEN_CONTEXT_RE.test(context) ||
    ACNE_REGULATORY_CONTEXT_RE.test(context) ||
    (/\bsalicylic acid\b/i.test(context) && /\bacne\b/i.test(context))
  );
}

function isHeroIngredientExpected(row) {
  if (isNonMerchOrAccessory(row)) return false;
  const descriptive = lowerText(collectDescriptiveText(row));
  return includesAnyTerm(descriptive, HERO_INGREDIENT_TERMS);
}

function readAuthorityProduct(row) {
  const seedData = ensureObject(row?.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  return {
    ...ensureObject(row),
    title: row?.title,
    name: row?.title,
    category: seedData.category || snapshot.category,
    product_type: seedData.product_type || snapshot.product_type || seedData.productType || snapshot.productType,
    tags: [...asArray(seedData.tags), ...asArray(snapshot.tags)],
    seed_data: seedData,
    ingredient_intel: seedData.ingredient_intel || snapshot.ingredient_intel,
  };
}

function isLowSignalActiveItem(value) {
  return LOW_SIGNAL_ACTIVE_ITEMS.has(lowerText(value));
}

function isInvalidActiveItem(value) {
  const text = stripHtml(value);
  if (!text) return true;
  if (INVALID_ACTIVE_FRAGMENT_RE.test(text)) return true;
  if (text.length > 90) return true;
  if (/[.!?]/.test(text)) return true;
  if (/\$/.test(text)) return true;
  if (/^(glass slipper|hot chocolit|fu\$\$y|\$weet mouth)$/i.test(text)) return true;
  return false;
}

function classifyActiveIngredientReadiness(row) {
  const coverage = readSeedCoverage(row);
  const productFamily = classifyProductFamily(row);
  if (['set_or_collection', 'non_merch', 'accessory'].includes(productFamily)) {
    return {
      status: 'not_applicable_product_family',
      issues: [],
      regulatory_expected: false,
      hero_expected: false,
      active_items: [],
      source_origin: 'none',
      source_quality_status: 'blocked',
      coverage,
      invalid_fragments: [],
      suppressed_reason: productFamily,
    };
  }
  const regulatoryExpected = isRegulatoryActiveExpected(row);
  const heroExpected = isHeroIngredientExpected(row);
  let authority = {
    items: [],
    active_items: [],
    source_origin: 'none',
  };
  try {
    authority = buildAuthoritativeIngredientView(readAuthorityProduct(row)) || authority;
  } catch (error) {
    authority = {
      ...authority,
      error: error?.message || String(error),
    };
  }

  const activeItems = asArray(authority.active_items).map(stripHtml).filter(Boolean);
  const suppressedReason = asString(authority.suppressed_reason);
  const normalizedActiveItems = activeItems.map(normalizedTerm);
  const hasRegulatoryActive = normalizedActiveItems.some((item) =>
    REGULATORY_ACTIVE_TERMS.some((term) => item.includes(term)),
  );
  const hasHeroIngredient = normalizedActiveItems.some((item) =>
    HERO_INGREDIENT_TERMS.some((term) => item.includes(term)),
  );
  const onlyLowSignal = activeItems.length > 0 && activeItems.every(isLowSignalActiveItem);
  const invalidFragments = activeItems.filter(isInvalidActiveItem);

  const issues = [];
  let status = 'not_expected_missing';
  if (regulatoryExpected && !hasRegulatoryActive) {
    status = 'missing_regulatory';
    issues.push('missing_regulatory');
  } else if (suppressedReason === 'active_items_invalid_fragment') {
    status = 'invalid_token_in_active';
    issues.push('invalid_token_in_active');
  } else if (suppressedReason === 'active_items_low_signal') {
    status = 'low_signal_active';
    issues.push('low_signal_active');
  } else if (onlyLowSignal) {
    status = 'low_signal_active';
    issues.push('low_signal_active');
  } else if (invalidFragments.length) {
    status = 'invalid_token_in_active';
    issues.push('invalid_token_in_active');
  } else if (heroExpected && !activeItems.length) {
    status = 'missing_hero';
    issues.push('missing_hero');
  } else if (regulatoryExpected && hasRegulatoryActive) {
    status = 'ready_regulatory';
  } else if (heroExpected && hasHeroIngredient) {
    status = 'ready_hero';
  } else if (activeItems.length && !hasHeroIngredient && !hasRegulatoryActive) {
    status = 'possibly_inci_guess';
    issues.push('possibly_inci_guess');
  } else if (activeItems.length) {
    status = 'ready_other';
  }

  if (coverage.active_ingredients_chars > 700) issues.push('active_raw_too_long');
  if (
    coverage.active_ingredients_chars > 0 &&
    coverage.inci_chars > 0 &&
    coverage.active_ingredients_chars > Math.max(260, coverage.inci_chars * 0.7)
  ) {
    issues.push('active_raw_may_be_full_inci');
  }

  return {
    status,
    issues,
    regulatory_expected: regulatoryExpected,
    hero_expected: heroExpected,
    active_items: activeItems,
    source_origin: asString(authority.source_origin || 'none') || 'none',
    source_quality_status:
      status.startsWith('ready') ? (status === 'ready_regulatory' ? 'regulatory_active' : 'captured') : 'blocked',
    coverage,
    invalid_fragments: invalidFragments,
    suppressed_reason: suppressedReason || null,
  };
}

function buildReadinessRow(row, context = {}) {
  const productId = asString(row?.external_product_id || row?.product_id || row?.id);
  const domain = asString(row?.domain) || 'unknown';
  const productIntel = classifyEffectiveProductIntel(row, context);
  const activeIngredients = classifyActiveIngredientReadiness(row);
  const variantReadiness = classifyVariantReadiness(row, context);
  return {
    seed_id: asString(row?.id),
    external_product_id: productId,
    market: asString(row?.market),
    domain,
    title: asString(row?.title),
    canonical_url: asString(row?.canonical_url),
    product_family: classifyProductFamily(row),
    product_line_id: productIntel.product_line_id,
    identity_variant_axes:
      asPlainObject(context.variantAxesByProductId?.get?.(productId)) || undefined,
    pivota_insights: productIntel,
    active_ingredients: activeIngredients,
    variants: variantReadiness,
    coverage: activeIngredients.coverage,
  };
}

function addSample(samples, key, row, extra = {}, limit = 8) {
  if (!samples[key]) samples[key] = [];
  if (samples[key].length >= limit) return;
  samples[key].push({
    external_product_id: row.external_product_id,
    domain: row.domain,
    title: row.title,
    ...extra,
  });
}

function summarizeReadinessRows(rows, options = {}) {
  const sampleLimit = Math.max(1, Number(options.sampleLimit || 8));
  const summary = {
    scanned: rows.length,
    by_market: {},
    by_domain: {},
    by_product_family: {},
    coverage: {
      missing_inci: 0,
      missing_active_raw: 0,
      missing_details: 0,
      missing_how_to: 0,
      missing_faq: 0,
    },
    pivota_insights: {
      direct: {
        displayable: 0,
        high_quality_ready: 0,
        missing_kb: 0,
        not_displayable: 0,
      },
      effective: {
        displayable: 0,
        high_quality_ready: 0,
        missing_kb: 0,
        not_displayable: 0,
        borrowed_from_sibling: 0,
      },
      effective_issues: {},
      effective_issue_domains: {},
      quality_state: {},
      evidence_profile: {},
      samples: {},
    },
    active_ingredients: {
      regulatory_expected: 0,
      hero_expected: 0,
      any_active_items: 0,
      status: {},
      issues: {},
      issue_domains: {},
      source_origin: {},
      samples: {},
    },
    variants: {
      status: {},
      issues: {},
      issue_domains: {},
      samples: {},
    },
  };

  for (const row of rows) {
    increment(summary.by_market, row.market);
    increment(summary.by_domain, row.domain);
    increment(summary.by_product_family, row.product_family);

    const coverage = row.coverage || {};
    if (!coverage.inci_chars) summary.coverage.missing_inci += 1;
    if (!coverage.active_ingredients_chars) summary.coverage.missing_active_raw += 1;
    if (!coverage.details_sections_count) summary.coverage.missing_details += 1;
    if (!coverage.how_to_chars) summary.coverage.missing_how_to += 1;
    if (!coverage.faq_count) summary.coverage.missing_faq += 1;

    const directIntel = row.pivota_insights?.direct || {};
    const effectiveIntel = row.pivota_insights?.effective || {};
    if (directIntel.displayable) summary.pivota_insights.direct.displayable += 1;
    else if (!directIntel.kb_exists) summary.pivota_insights.direct.missing_kb += 1;
    else summary.pivota_insights.direct.not_displayable += 1;
    if (directIntel.high_quality_ready) summary.pivota_insights.direct.high_quality_ready += 1;

    if (effectiveIntel.displayable) summary.pivota_insights.effective.displayable += 1;
    else if (!effectiveIntel.kb_exists) summary.pivota_insights.effective.missing_kb += 1;
    else summary.pivota_insights.effective.not_displayable += 1;
    if (effectiveIntel.high_quality_ready) summary.pivota_insights.effective.high_quality_ready += 1;
    if (row.pivota_insights?.borrowed_from_sibling) {
      summary.pivota_insights.effective.borrowed_from_sibling += 1;
      addSample(
        summary.pivota_insights.samples,
        'borrowed_from_sibling',
        row,
        {
          used_product_id: effectiveIntel.product_id,
          quality_state: effectiveIntel.quality_state,
          evidence_profile: effectiveIntel.evidence_profile,
        },
        sampleLimit,
      );
    }
    increment(summary.pivota_insights.quality_state, effectiveIntel.quality_state || 'unknown');
    increment(summary.pivota_insights.evidence_profile, effectiveIntel.evidence_profile || 'unknown');
    for (const issue of asArray(effectiveIntel.issues)) {
      increment(summary.pivota_insights.effective_issues, issue);
      increment(summary.pivota_insights.effective_issue_domains, `${row.domain}::${issue}`);
      if (PRODUCT_INTEL_BLOCKING_ISSUES.has(issue) || issue === 'seller_only_evidence') {
        addSample(
          summary.pivota_insights.samples,
          issue,
          row,
          {
            used_product_id: effectiveIntel.product_id,
            quality_state: effectiveIntel.quality_state,
            evidence_profile: effectiveIntel.evidence_profile,
          },
          sampleLimit,
        );
      }
    }

    const active = row.active_ingredients || {};
    if (active.regulatory_expected) summary.active_ingredients.regulatory_expected += 1;
    if (active.hero_expected) summary.active_ingredients.hero_expected += 1;
    if (asArray(active.active_items).length) summary.active_ingredients.any_active_items += 1;
    increment(summary.active_ingredients.status, active.status);
    increment(summary.active_ingredients.source_origin, active.source_origin || 'none');
    for (const issue of asArray(active.issues)) {
      increment(summary.active_ingredients.issues, issue);
      increment(summary.active_ingredients.issue_domains, `${row.domain}::${issue}`);
      addSample(
        summary.active_ingredients.samples,
        issue,
        row,
        {
          status: active.status,
          active_items: asArray(active.active_items).slice(0, 8),
          source_origin: active.source_origin,
        },
        sampleLimit,
      );
    }

    const variants = row.variants || {};
    increment(summary.variants.status, variants.status || 'unknown');
    for (const issue of asArray(variants.issues)) {
      increment(summary.variants.issues, issue);
      increment(summary.variants.issue_domains, `${row.domain}::${issue}`);
      addSample(
        summary.variants.samples,
        issue,
        row,
        {
          status: variants.status,
          examples: variants.examples?.[issue] || [],
        },
        sampleLimit,
      );
    }
  }

  return {
    ...summary,
    by_domain: topEntries(summary.by_domain, 25),
    by_product_family: topEntries(summary.by_product_family, 12),
    pivota_insights: {
      ...summary.pivota_insights,
      effective_issues: topEntries(summary.pivota_insights.effective_issues, 25),
      effective_issue_domains: topEntries(summary.pivota_insights.effective_issue_domains, 30),
      quality_state: topEntries(summary.pivota_insights.quality_state, 20),
      evidence_profile: topEntries(summary.pivota_insights.evidence_profile, 20),
    },
    active_ingredients: {
      ...summary.active_ingredients,
      status: topEntries(summary.active_ingredients.status, 20),
      issues: topEntries(summary.active_ingredients.issues, 25),
      issue_domains: topEntries(summary.active_ingredients.issue_domains, 30),
      source_origin: topEntries(summary.active_ingredients.source_origin, 20),
    },
    variants: {
      ...summary.variants,
      status: topEntries(summary.variants.status, 20),
      issues: topEntries(summary.variants.issues, 25),
      issue_domains: topEntries(summary.variants.issue_domains, 30),
    },
  };
}

module.exports = {
  PRODUCT_INTEL_BLOCKING_ISSUES,
  REGULATORY_ACTIVE_TERMS,
  HERO_INGREDIENT_TERMS,
  LOW_SIGNAL_ACTIVE_ITEMS,
  classifyProductIntelKbRow,
  classifyEffectiveProductIntel,
  classifyActiveIngredientReadiness,
  classifyVariantReadiness,
  classifyProductFamily,
  buildReadinessRow,
  summarizeReadinessRows,
  readSeedCoverage,
  readProductIntelBundleFromKbRow,
};

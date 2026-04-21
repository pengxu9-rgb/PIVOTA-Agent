const { ensureJsonObject, normalizeNonEmptyString } = require('./externalSeedRecall');
const { isDisplayablePdpFaqItem } = require('./pdpFaqQuality');

const POLLUTED_FACTS_RE =
  /\b(contact us|customer service|privacy policy|terms(?: and conditions)?|shipping policy|return policy|about us|blog|blogs|impact|foundation transparency|transparency|give 20%|donation|donate|store locator|support|OFFICIAL|SOCIAL HIGHLIGHTS|THE UNDERCOVER|STRAIGHT UP|THE LOWDOWN|fill weight|avoid contact with eyes|keep out of reach|customerservice@)\b/i;
const SECTION_SOUP_LABEL_RE =
  /\b(description|details?|overview|benefits?|clinical results?|results?|proven results?|key ingredients?|why it works|texture|finish|coverage|free of|set includes|best for|formulation|what else you should know|good to know|ingredients?|active ingredients?|how to use|how to apply|directions?|faq|frequently asked questions?|q\s*&\s*a|questions?)\b\s*:?\s*/gi;
const TOM_FORD_SHOPIFY_FILES_RE =
  /^https?:\/\/cdn\.shopify\.com\/s\/files\/1\/0761\/9690\/5173\/files\/tfb?_sku_/i;
const SHOPIFY_HASHED_FILENAME_RE =
  /_[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}\.(?:avif|gif|jpe?g|png|webp)$/i;
const TOM_FORD_BARE_NON_PRIMARY_ASSET_RE =
  /^tfb?_sku_.*_(?:[1-9]\d*|[0-9]+[a-z]+|[a-z]+[0-9]+)\.(?:avif|gif|jpe?g|png|webp)$/i;

function normalizeAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value || '').replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pickExtractorPrice(product = {}) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const variantPrice = variants
    .map((variant) => normalizeAmount(variant?.price ?? variant?.price_amount))
    .find((value) => value > 0);
  if (variantPrice > 0) return variantPrice;
  return normalizeAmount(product.price ?? product.price_amount);
}

function pickLivePdpPrice(livePayload = {}) {
  const modules = Array.isArray(livePayload?.modules) ? livePayload.modules : [];
  const priceModule = modules.find((module) => module?.type === 'price_promo');
  return normalizeAmount(priceModule?.data?.price?.amount);
}

function collectProductDetailsText(livePayload = {}) {
  return collectProductDetailsSections(livePayload)
    .map((section) => normalizeNonEmptyString(section?.content))
    .filter(Boolean);
}

function collectProductDetailsSections(livePayload = {}) {
  const modules = Array.isArray(livePayload?.modules) ? livePayload.modules : [];
  return modules
    .filter((module) =>
      ['product_overview', 'supplemental_details', 'product_details'].includes(module?.type),
    )
    .flatMap((module) => (Array.isArray(module?.data?.sections) ? module.data.sections : []))
    .filter(Boolean);
}

function collectProductFactsText(livePayload = {}) {
  const modules = Array.isArray(livePayload?.modules) ? livePayload.modules : [];
  return modules
    .filter((module) => module?.type === 'product_facts')
    .flatMap((module) => (Array.isArray(module?.data?.sections) ? module.data.sections : []))
    .map((section) => [section?.heading, section?.content].filter(Boolean).join(' '))
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean);
}

function normalizeComparisonKey(value) {
  return normalizeNonEmptyString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function collectProductDescriptionText(livePayload = {}) {
  return normalizeNonEmptyString(livePayload?.product?.description);
}

function collectModules(...payloads) {
  return payloads.flatMap((payload) => (Array.isArray(payload?.modules) ? payload.modules : []));
}

function findModuleData(type, ...payloads) {
  const module = collectModules(...payloads).find((item) => item?.type === type);
  if (module && Object.prototype.hasOwnProperty.call(module, 'data')) return module.data;
  return null;
}

function collectLiveModuleList(livePayload = {}, liveResponse = {}) {
  return Array.from(
    new Set(
      collectModules(liveResponse, livePayload)
        .map((module) => normalizeNonEmptyString(module?.type))
        .filter(Boolean),
    ),
  );
}

function collectSeedDetailsSections(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const rawSections = Array.isArray(seedData?.pdp_details_sections)
    ? seedData.pdp_details_sections
    : Array.isArray(snapshot?.pdp_details_sections)
      ? snapshot.pdp_details_sections
      : [];
  return rawSections.filter(Boolean);
}

function collectSeedFaqItems(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const rawItems = Array.isArray(seedData?.pdp_faq_items)
    ? seedData.pdp_faq_items
    : Array.isArray(snapshot?.pdp_faq_items)
      ? snapshot.pdp_faq_items
      : [];
  return rawItems.filter((item) => isDisplayablePdpFaqItem(item));
}

function collectLiveQuestions(livePayload = {}, liveResponse = {}) {
  const reviewsData =
    findModuleData('reviews_preview', liveResponse, livePayload) ||
    ensureJsonObject(liveResponse?.reviews_preview || livePayload?.reviews_preview);
  return Array.isArray(reviewsData?.questions) ? reviewsData.questions : [];
}

function collectLiveActiveIngredients(livePayload = {}, liveResponse = {}) {
  const data =
    findModuleData('active_ingredients', liveResponse, livePayload) ||
    ensureJsonObject(liveResponse?.active_ingredients || livePayload?.active_ingredients);
  return Array.isArray(data?.items) ? data.items : [];
}

function collectSeedContextText(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const sections = collectSeedDetailsSections(seedData);
  return [
    seedData?.title,
    snapshot?.title,
    seedData?.product_title,
    snapshot?.product_title,
    seedData?.category,
    snapshot?.category,
    seedData?.product_type,
    snapshot?.product_type,
    seedData?.pdp_description_raw,
    snapshot?.description_raw,
    ...sections.map((section) => [section?.heading, section?.body, section?.content].filter(Boolean).join(' ')),
  ]
    .map(normalizeNonEmptyString)
    .filter(Boolean)
    .join(' ');
}

function seedExpectsActiveIngredients(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const rawActive = normalizeNonEmptyString(
    seedData?.pdp_active_ingredients_raw ||
      snapshot?.pdp_active_ingredients_raw ||
      seedData?.active_ingredients ||
      snapshot?.active_ingredients,
  );
  if (rawActive) return true;
  const ingredients = normalizeNonEmptyString(
    seedData?.pdp_ingredients_raw ||
      snapshot?.pdp_ingredients_raw ||
      seedData?.raw_ingredient_text_clean ||
      snapshot?.raw_ingredient_text_clean,
  );
  if (/\bactive ingredients?\b/i.test(ingredients)) return true;
  const context = collectSeedContextText(seedData);
  const hasSunscreenContext =
    /\b(?:spf|sunscreen|sun screen|sun protection|broad spectrum|uv|uva|uvb|pa\+{2,}|protective fluid)\b/i.test(
      context,
    );
  if (!hasSunscreenContext) return false;
  return /\b(?:zinc oxide|titanium dioxide|avobenzone|octocrylene|octisalate|homosalate|octinoxate|ensulizole|oxybenzone)\b/i.test(
    ingredients,
  );
}

function hasDisplayableSimilarCardData(product = {}) {
  return Boolean(
    normalizeNonEmptyString(
      product.card_highlight ||
        product.cardHighlight ||
        product.shopping_card?.highlight ||
        product.shoppingCard?.highlight ||
        product.search_card?.highlight_candidate ||
        product.searchCard?.highlight_candidate ||
        product.searchCard?.highlightCandidate ||
        product.description,
    ),
  );
}

function collectLiveGalleryImages(livePayload = {}) {
  const urls = [];
  const productImageUrl = normalizeNonEmptyString(livePayload?.product?.image_url);
  if (productImageUrl) urls.push(productImageUrl);
  const modules = Array.isArray(livePayload?.modules) ? livePayload.modules : [];
  modules
    .filter((module) => module?.type === 'media_gallery')
    .flatMap((module) => (Array.isArray(module?.data?.items) ? module.data.items : []))
    .forEach((item) => {
      const url = normalizeNonEmptyString(item?.url || item?.image_url || item?.src);
      if (url) urls.push(url);
    });
  return Array.from(new Set(urls));
}

function hasSectionSoupBoundary(text, index) {
  if (index <= 0) return true;
  const prefix = text.slice(0, index).replace(/\s+$/, '');
  if (!prefix) return true;
  return /[:;.!?\n\r\u2022]/.test(prefix[prefix.length - 1]);
}

function isHeadingStyleSoupLabel(text, match) {
  const rawLabel = String(match?.[1] || '');
  if (!rawLabel) return false;
  if (!hasSectionSoupBoundary(text, match.index)) return false;
  if (/^(coverage|finish|texture)$/i.test(rawLabel) && rawLabel[0] !== rawLabel[0].toUpperCase()) {
    return false;
  }
  return match.index === 0 || rawLabel[0] === rawLabel[0].toUpperCase();
}

function countSectionSoupLabels(value) {
  const text = normalizeNonEmptyString(value);
  if (!text) return 0;
  SECTION_SOUP_LABEL_RE.lastIndex = 0;
  let count = 0;
  let match = SECTION_SOUP_LABEL_RE.exec(text);
  while (match) {
    if (isHeadingStyleSoupLabel(text, match)) count += 1;
    match = SECTION_SOUP_LABEL_RE.exec(text);
  }
  return count;
}

function looksLikeSectionSoupText(value) {
  const text = normalizeNonEmptyString(value);
  if (!text) return false;
  const labelCount = countSectionSoupLabels(text);
  if (labelCount >= 2) return true;
  return (
    text.length > 700 &&
    /\b(?:Description|Details?|Overview)\b\s*:/i.test(text) &&
    /\b(?:Benefits?|How to Use|How to Apply|Directions?|Ingredients?|Clinical Results?|Coverage|Finish)\b\s*:/i.test(text)
  );
}

function isImageUrlIdentityStripped(url) {
  const normalized = normalizeNonEmptyString(url);
  if (!TOM_FORD_SHOPIFY_FILES_RE.test(normalized)) return false;
  try {
    const parsed = new URL(normalized);
    const filename = String(parsed.pathname.split('/').pop() || '').trim();
    if (parsed.searchParams.has('v')) return false;
    if (SHOPIFY_HASHED_FILENAME_RE.test(filename)) return false;
    return TOM_FORD_BARE_NON_PRIMARY_ASSET_RE.test(filename);
  } catch {
    return false;
  }
}

function extractCanonicalData(liveResponse = {}) {
  const canonical = (Array.isArray(liveResponse?.modules) ? liveResponse.modules : []).find(
    (module) => module?.type === 'canonical',
  );
  return ensureJsonObject(canonical?.data);
}

function buildIdentityGate({ livePayload = {}, liveResponse = {} } = {}) {
  const canonicalData = extractCanonicalData(liveResponse);
  const product = ensureJsonObject(livePayload?.product);
  const productGroupId = normalizeNonEmptyString(
    livePayload?.product_group_id ||
      livePayload?.productGroupId ||
      product.product_group_id ||
      product.productGroupId ||
      canonicalData.product_group_id ||
      canonicalData.productGroupId ||
      liveResponse?.product_group_id ||
      liveResponse?.productGroupId,
  );
  const productLineId = normalizeNonEmptyString(
    livePayload?.product_line_id ||
      livePayload?.productLineId ||
      product.product_line_id ||
      product.productLineId ||
      canonicalData.product_line_id ||
      canonicalData.productLineId ||
      liveResponse?.product_line_id ||
      liveResponse?.productLineId,
  );
  const sellableItemGroupId = normalizeNonEmptyString(
    livePayload?.sellable_item_group_id ||
      livePayload?.sellableItemGroupId ||
      product.sellable_item_group_id ||
      product.sellableItemGroupId ||
      canonicalData.sellable_item_group_id ||
      canonicalData.sellableItemGroupId ||
      liveResponse?.sellable_item_group_id ||
      liveResponse?.sellableItemGroupId,
  );
  const failureReasons = [];
  if (!productGroupId || !productLineId) {
    failureReasons.push('missing_pdp_identity');
  }
  return {
    status: failureReasons.length ? 'failed' : 'passed',
    product_group_id: productGroupId || null,
    product_line_id: productLineId || null,
    sellable_item_group_id: sellableItemGroupId || null,
    failure_reasons: failureReasons,
  };
}

function buildProductIntelGate({ livePayload = {}, liveResponse = {} } = {}) {
  const modules = collectModules(liveResponse, livePayload);
  const productIntelModule = modules.find((module) => module?.type === 'product_intel') || null;
  const topLevelIntel = ensureJsonObject(liveResponse?.product_intel || livePayload?.product_intel);
  const moduleData = ensureJsonObject(productIntelModule?.data);
  const metadata = ensureJsonObject(liveResponse?.metadata || livePayload?.metadata);
  const productIntelStatus = normalizeNonEmptyString(
    metadata.product_intel_status || productIntelModule?.status || productIntelModule?.reason,
  ).toLowerCase();
  const hasProductIntelData =
    Object.keys(moduleData).length > 0 ||
    Object.keys(topLevelIntel).length > 0;
  const blocked =
    !hasProductIntelData ||
    productIntelStatus === 'missing_blocked' ||
    productIntelStatus === 'queued' ||
    productIntelStatus === 'generating' ||
    normalizeNonEmptyString(productIntelModule?.reason).toLowerCase() === 'missing_blocked';
  const failureReasons = blocked ? ['product_intel_module_empty_or_blocked'] : [];
  return {
    status: failureReasons.length ? 'failed' : 'passed',
    has_product_intel: hasProductIntelData,
    product_intel_status: productIntelStatus || null,
    failure_reasons: failureReasons,
  };
}

function hasDuplicateDescriptionFacts({ factsText = [], description = '' } = {}) {
  const descriptionKey = normalizeComparisonKey(description);
  if (!descriptionKey) return false;
  return (Array.isArray(factsText) ? factsText : []).some((value) => {
    const factKey = normalizeComparisonKey(value).replace(/^description\s+/, '').trim();
    return Boolean(factKey && factKey === descriptionKey);
  });
}

function extractProbeError(response = {}) {
  const topLevelError = response?.error;
  if (typeof topLevelError === 'string' && topLevelError.trim()) {
    return normalizeNonEmptyString(response?.message || response?.detail || topLevelError);
  }
  if (topLevelError && typeof topLevelError === 'object') {
    return normalizeNonEmptyString(
      topLevelError?.message || topLevelError?.code || response?.message || response?.detail,
    );
  }
  const status = normalizeNonEmptyString(response?.status);
  if (
    status &&
    status.toLowerCase() !== 'success' &&
    !Array.isArray(response?.modules) &&
    !Array.isArray(response?.products)
  ) {
    return normalizeNonEmptyString(response?.detail || response?.message || status);
  }
  return '';
}

function buildSeedGate(audit = {}) {
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  const blocked = findings.filter((finding) => String(finding?.severity || '').trim().toLowerCase() === 'blocker');
  return {
    status: blocked.length > 0 ? 'failed' : 'passed',
    findings_count: findings.length,
    blockers_count: blocked.length,
  };
}

function buildExtractorGate({ extractorResponse = {}, extractorProduct = {} } = {}) {
  const diagnostics = ensureJsonObject(extractorResponse?.diagnostics);
  const failureCategory = normalizeNonEmptyString(diagnostics.failure_category);
  const descriptionPresent = Boolean(
    normalizeNonEmptyString(extractorProduct?.description_raw || extractorProduct?.description),
  );
  const price = pickExtractorPrice(extractorProduct);
  const failureReasons = [];
  if (failureCategory) failureReasons.push('extractor_failure');
  return {
    status: failureReasons.length ? 'failed' : 'passed',
    failure_category: failureCategory || null,
    description_present: descriptionPresent,
    price_amount: price || null,
    failure_reasons: failureReasons,
  };
}

function buildLivePdpGate({
  extractorProduct = {},
  livePayload = {},
  liveResponse = {},
  seedData = {},
  expectedPrice = null,
  imageHealth = null,
} = {}) {
  const extractorPrice = pickExtractorPrice(extractorProduct);
  const expectedPriceAmount = normalizeAmount(expectedPrice);
  const referencePrice = expectedPriceAmount > 0 ? expectedPriceAmount : extractorPrice;
  const livePrice = pickLivePdpPrice(livePayload);
  const descriptionText = collectProductDescriptionText(livePayload);
  const detailSections = collectProductDetailsSections(livePayload);
  const detailsText = collectProductDetailsText(livePayload);
  const factsText = collectProductFactsText(livePayload);
  const liveModuleList = collectLiveModuleList(livePayload, liveResponse);
  const galleryImages = collectLiveGalleryImages(livePayload);
  const strippedImageUrls = galleryImages.filter((url) => isImageUrlIdentityStripped(url));
  const seedDetailSections = collectSeedDetailsSections(seedData);
  const seedFaqItems = collectSeedFaqItems(seedData);
  const liveQuestions = collectLiveQuestions(livePayload, liveResponse);
  const liveActiveItems = collectLiveActiveIngredients(livePayload, liveResponse);
  const extractorHasDescription = Boolean(
    normalizeNonEmptyString(extractorProduct?.description_raw || extractorProduct?.description),
  );
  const probeError = extractProbeError(liveResponse);
  const failureReasons = [];

  if (probeError) {
    return {
      status: 'failed',
      price_amount: null,
      has_overview: false,
      live_modules: liveModuleList,
      probe_error: probeError,
      failure_reasons: ['live_pdp_probe_failed'],
    };
  }

  if (referencePrice > 0 && livePrice > 0 && Math.abs(referencePrice - livePrice) > 0.01) {
    failureReasons.push('price_mismatch');
  }
  if (extractorHasDescription && detailsText.length === 0) {
    failureReasons.push('missing_overview_from_available_description');
  }
  if (POLLUTED_FACTS_RE.test(descriptionText)) {
    failureReasons.push('polluted_product_description');
  }
  if (detailsText.some((value) => POLLUTED_FACTS_RE.test(value))) {
    failureReasons.push('polluted_product_details');
  }
  if (factsText.some((value) => POLLUTED_FACTS_RE.test(value))) {
    failureReasons.push('polluted_product_facts');
  }
  if (hasDuplicateDescriptionFacts({ factsText, description: descriptionText })) {
    failureReasons.push('duplicated_description_facts');
  }
  const soupSections = detailSections.filter(
    (section) =>
      /^(description|overview|details?|product details?)$/i.test(normalizeNonEmptyString(section?.heading)) &&
      looksLikeSectionSoupText(section?.content),
  );
  if (soupSections.length || looksLikeSectionSoupText(descriptionText)) {
    failureReasons.push('product_details_section_soup');
  }
  const compressedStructuredDetails =
    seedDetailSections.length >= 3 &&
    detailSections.length <= 2 &&
    detailSections.every((section) =>
      /^(description|overview|category)$/i.test(normalizeNonEmptyString(section?.heading)),
    ) &&
    factsText.length === 0 &&
    !(
      seedDetailSections.some((section) => /how to use|directions?|how to apply/i.test(normalizeNonEmptyString(section?.heading))) &&
      liveModuleList.includes('how_to_use')
    ) &&
    !(
      seedDetailSections.some((section) => /ingredients?|inci/i.test(normalizeNonEmptyString(section?.heading))) &&
      liveModuleList.includes('ingredients_inci')
    ) &&
    !(
      seedExpectsActiveIngredients(seedData) &&
      liveModuleList.includes('active_ingredients')
    );
  if (compressedStructuredDetails) {
    failureReasons.push('structured_sections_compressed_to_description_category');
  }
  if (seedFaqItems.length > 0 && liveQuestions.length === 0) {
    failureReasons.push('merchant_faq_dropped');
  }
  if (seedExpectsActiveIngredients(seedData) && liveActiveItems.length === 0) {
    failureReasons.push('active_ingredients_expected_but_hidden');
  }
  if (
    soupSections.length ||
    (!liveModuleList.includes('product_intel') &&
      detailsText.length === 1 &&
      detailsText[0].length > 700 &&
      factsText.length === 0)
  ) {
    failureReasons.push('legacy_overview_render_risk');
  }
  if (strippedImageUrls.length) {
    failureReasons.push('image_url_identity_stripped');
  }
  if (imageHealth && Number(imageHealth.broken_count || 0) > 0) {
    failureReasons.push('broken_gallery_image');
  }

  return {
    status: failureReasons.length ? 'failed' : 'passed',
    price_amount: livePrice || null,
    has_overview: detailsText.length > 0,
    live_modules: liveModuleList,
    details_status: {
      section_count: detailSections.length,
      section_soup_count: soupSections.length,
      has_product_facts: factsText.length > 0,
      seed_section_count: seedDetailSections.length,
      compressed_structured_sections: compressedStructuredDetails,
    },
    questions_status: {
      seed_faq_count: seedFaqItems.length,
      live_question_count: liveQuestions.length,
    },
    active_ingredients_status: {
      expected: seedExpectsActiveIngredients(seedData),
      live_item_count: liveActiveItems.length,
    },
    image_health: imageHealth || {
      scanned_count: 0,
      broken_count: 0,
      broken_urls: [],
      skipped: true,
    },
    image_url_identity_stripped_count: strippedImageUrls.length,
    image_url_identity_stripped_examples: strippedImageUrls.slice(0, 5),
    failure_reasons: failureReasons,
  };
}

function buildSimilarGate({ similarResponse = {}, livePayload = {}, liveResponse = {}, exclusionFlags = {} } = {}) {
  const similarModuleData =
    findModuleData('similar', liveResponse, livePayload) ||
    findModuleData('recommendations', liveResponse, livePayload) ||
    ensureJsonObject(similarResponse?.similar || liveResponse?.similar || livePayload?.recommendations);
  const products = Array.isArray(similarModuleData?.items)
    ? similarModuleData.items
    : Array.isArray(similarResponse?.products)
      ? similarResponse.products
      : [];
  const exempt =
    Boolean(exclusionFlags?.gift_card) ||
    Boolean(exclusionFlags?.donation_bundle) ||
    Boolean(exclusionFlags?.non_merchandise);
  const probeError = extractProbeError(similarResponse);
  const failureReasons = [];
  if (probeError) {
    return {
      status: 'failed',
      similar_count: 0,
      exempt,
      probe_error: probeError,
      failure_reasons: ['similar_probe_failed'],
    };
  }
  if (!exempt && products.length < 4) {
    failureReasons.push('similar_underfill');
  }
  const missingHighlight = products
    .slice(0, Math.min(products.length, 4))
    .filter((item) => !hasDisplayableSimilarCardData(item));
  if (!exempt && products.length > 0 && missingHighlight.length > 0) {
    failureReasons.push('similar_card_missing_highlight');
  }
  return {
    status: failureReasons.length ? 'failed' : exempt ? 'exempt' : 'passed',
    similar_count: products.length,
    card_highlight_missing_count: missingHighlight.length,
    exempt,
    failure_reasons: failureReasons,
  };
}

function buildExternalSeedQualityResult({
  seedId = '',
  externalProductId = '',
  market = '',
  domain = '',
  canonicalUrl = '',
  seedGate = {},
  extractorGate = {},
  identityGate = {},
  productIntelGate = {},
  livePdpGate = {},
  similarGate = {},
} = {}) {
  const failureReasons = [
    ...(Array.isArray(seedGate.failure_reasons) ? seedGate.failure_reasons : []),
    ...(Array.isArray(extractorGate.failure_reasons) ? extractorGate.failure_reasons : []),
    ...(Array.isArray(identityGate.failure_reasons) ? identityGate.failure_reasons : []),
    ...(Array.isArray(productIntelGate.failure_reasons) ? productIntelGate.failure_reasons : []),
    ...(Array.isArray(livePdpGate.failure_reasons) ? livePdpGate.failure_reasons : []),
    ...(Array.isArray(similarGate.failure_reasons) ? similarGate.failure_reasons : []),
  ].filter(Boolean);
  const rootCauseClassification = [];
  if (failureReasons.includes('extractor_failure')) rootCauseClassification.push('extractor_issue');
  if (
    failureReasons.includes('image_url_identity_stripped') ||
    failureReasons.includes('broken_gallery_image')
  ) {
    rootCauseClassification.push('image_asset_issue');
  }
  if (
    failureReasons.includes('product_details_section_soup') ||
    failureReasons.includes('legacy_overview_render_risk') ||
    failureReasons.includes('duplicated_description_facts') ||
    failureReasons.includes('structured_sections_compressed_to_description_category') ||
    failureReasons.includes('merchant_faq_dropped') ||
    failureReasons.includes('active_ingredients_expected_but_hidden')
  ) {
    rootCauseClassification.push('pdp_shaping_issue');
  }
  if (failureReasons.includes('missing_pdp_identity')) {
    rootCauseClassification.push('identity_graph_gap');
  }
  if (
    failureReasons.includes('missing_product_intel') ||
    failureReasons.includes('product_intel_module_empty_or_blocked')
  ) {
    rootCauseClassification.push('product_intel_gap');
  }
  if (
    failureReasons.includes('similar_underfill') ||
    failureReasons.includes('similar_card_missing_highlight')
  ) {
    rootCauseClassification.push('similar_issue');
  }
  return {
    seed_id: normalizeNonEmptyString(seedId),
    external_product_id: normalizeNonEmptyString(externalProductId),
    market: normalizeNonEmptyString(market),
    domain: normalizeNonEmptyString(domain),
    canonical_url: normalizeNonEmptyString(canonicalUrl),
    seed_gate: seedGate,
    extractor_gate: extractorGate,
    identity_gate: identityGate,
    product_intel_gate: productIntelGate,
    live_pdp_gate: livePdpGate,
    similar_gate: similarGate,
    root_cause_classification: Array.from(new Set(rootCauseClassification)),
    failure_reasons: Array.from(new Set(failureReasons)),
  };
}

module.exports = {
  pickExtractorPrice,
  pickLivePdpPrice,
  collectProductDetailsText,
  collectProductFactsText,
  collectProductDescriptionText,
  collectLiveGalleryImages,
  collectLiveModuleList,
  looksLikeSectionSoupText,
  isImageUrlIdentityStripped,
  extractProbeError,
  buildSeedGate,
  buildExtractorGate,
  buildIdentityGate,
  buildProductIntelGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildExternalSeedQualityResult,
};

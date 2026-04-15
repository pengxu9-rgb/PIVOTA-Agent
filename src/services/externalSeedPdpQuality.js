const { ensureJsonObject, normalizeNonEmptyString } = require('./externalSeedRecall');

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

function collectLiveModuleList(livePayload = {}, liveResponse = {}) {
  return Array.from(
    new Set(
      collectModules(liveResponse, livePayload)
        .map((module) => normalizeNonEmptyString(module?.type))
        .filter(Boolean),
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

function countSectionSoupLabels(value) {
  const text = normalizeNonEmptyString(value);
  if (!text) return 0;
  SECTION_SOUP_LABEL_RE.lastIndex = 0;
  let count = 0;
  while (SECTION_SOUP_LABEL_RE.exec(text)) count += 1;
  return count;
}

function looksLikeSectionSoupText(value) {
  const text = normalizeNonEmptyString(value);
  if (!text) return false;
  if (countSectionSoupLabels(text) >= 2) return true;
  return (
    text.length > 500 &&
    /\b(description|details?|overview)\b/i.test(text) &&
    /\b(benefits?|how to use|ingredients?|clinical results?|coverage|finish)\b/i.test(text)
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
  const hasProductIntelModule = modules.some((module) => module?.type === 'product_intel');
  const topLevelIntel = ensureJsonObject(liveResponse?.product_intel || livePayload?.product_intel);
  const hasTopLevelIntel = Object.keys(topLevelIntel).length > 0;
  const failureReasons = hasProductIntelModule || hasTopLevelIntel ? [] : ['missing_product_intel'];
  return {
    status: failureReasons.length ? 'failed' : 'passed',
    has_product_intel: failureReasons.length === 0,
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

function buildSimilarGate({ similarResponse = {}, exclusionFlags = {} } = {}) {
  const products = Array.isArray(similarResponse?.products) ? similarResponse.products : [];
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
  return {
    status: failureReasons.length ? 'failed' : exempt ? 'exempt' : 'passed',
    similar_count: products.length,
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
    failureReasons.includes('duplicated_description_facts')
  ) {
    rootCauseClassification.push('pdp_shaping_issue');
  }
  if (failureReasons.includes('missing_pdp_identity')) {
    rootCauseClassification.push('identity_graph_gap');
  }
  if (failureReasons.includes('missing_product_intel')) {
    rootCauseClassification.push('product_intel_gap');
  }
  if (failureReasons.includes('similar_underfill')) {
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

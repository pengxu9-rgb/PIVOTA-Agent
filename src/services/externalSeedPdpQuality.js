const { ensureJsonObject, normalizeNonEmptyString } = require('./externalSeedRecall');
const { isDisplayablePdpFaqItem } = require('./pdpFaqQuality');
const {
  buildPdpImageDedupeKey,
  classifyShopifyLikeAsset,
  normalizePdpImageUrl,
} = require('../utils/pdpImageUrls');

const POLLUTED_FACTS_RE =
  /\b(contact us|customer service|customer support|support center|support page|privacy policy|terms(?: and conditions)?|shipping policy|return policy|about us|blog|blogs|impact|foundation transparency|transparency|give 20%|donation|donate|store locator|OFFICIAL|SOCIAL HIGHLIGHTS|THE UNDERCOVER|STRAIGHT UP|THE LOWDOWN|fill weight|avoid contact with eyes|keep out of reach|customerservice@|support@)\b/i;
const SECTION_SOUP_LABEL_RE =
  /\b(description|details?|overview|benefits?|clinical results?|results?|proven results?|key ingredients?|why it works|texture|finish|coverage|free of|set includes|best for|formulation|what else you should know|good to know|ingredients?|active ingredients?|how to use|how to apply|directions?|faq|frequently asked questions?|q\s*&\s*a|questions?)\b\s*:?\s*/gi;
const TOM_FORD_SHOPIFY_FILES_RE =
  /^https?:\/\/cdn\.shopify\.com\/s\/files\/1\/0761\/9690\/5173\/files\/tfb?_sku_/i;
const SHOPIFY_HASHED_FILENAME_RE =
  /_[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}\.(?:avif|gif|jpe?g|png|webp)$/i;
const TOM_FORD_BARE_NON_PRIMARY_ASSET_RE =
  /^tfb?_sku_.*_(?:[1-9]\d*|[0-9]+[a-z]+|[a-z]+[0-9]+)\.(?:avif|gif|jpe?g|png|webp)$/i;
const VARIANT_IDENTITY_OPTION_RE =
  /^(offer|sku|sku id|variant sku|barcode|upc|ean|gtin|product id|variant id|title)$/i;
const GENERIC_VARIANT_AXIS_RE = /^(option|variant|selection)$/i;
const VARIANT_SIZE_EVIDENCE_RE = /\b\d+(?:\.\d+)?\s*(ml|m l|g|kg|oz|fl\.?\s*oz\.?|fluid\s*ounces?|l|lb|lbs|mm|cm)\b/i;
const SHADE_AXIS_RE = /^(shade|color|colour|tone|hue)$/i;
const LOCALE_LIKE_VARIANT_VALUE_RE = /^(us|usa|uk|eu|fr|de|es|it|ca|au|jp|kr|cn)$/i;
const NAMED_SIZE_EVIDENCE_RE = /\b(full size|travel size|jumbo|mini|refill|regular|standard|one size)\b/i;
const DEFAULT_TITLE_AXIS_RE = /\b(?:default title|default)\b/i;
const ACTIVE_ALLOWED_HINT_RE =
  /\b(?:spf|sunscreen|sun\s*(?:screen|protection|defense)|uv|pa\+|acne|blemish|treatment|serum|essence|ampoule|retinol|retinal|salicylic|benzoyl\s+peroxide|azelaic|vitamin\s+c)\b/i;
const COLOR_COSMETIC_OR_TOOL_RE =
  /\b(?:foundation|concealer|skin\s+tint|powder|blush|bronzer|contour|highlighter|luminizer|gloss|lip(?:stick| liner| oil| gloss| butter| balm| kit)?|mascara|eyeliner|kyliner|brow|palette|eyeshadow|makeup\s+sponge|sponge|brush|sharpener|bundle|duo|trio|collection|kit|look)\b/i;
const NON_SURFACEABLE_ACTIVE_STATUS = new Set([
  'low',
  'blocked',
  'quarantined',
  'not_applicable',
  'reviewed_not_applicable',
  'cleared_stale_non_source_backed',
]);

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

function collectVariantAuditContext(seedData = {}, livePayload = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return [
    seedData?.title,
    snapshot?.title,
    livePayload?.product?.title,
    livePayload?.product?.name,
    seedData?.category,
    snapshot?.category,
    livePayload?.product?.category,
    seedData?.product_type,
    snapshot?.product_type,
    livePayload?.product?.product_type,
    ...(Array.isArray(seedData?.tags) ? seedData.tags : []),
    ...(Array.isArray(snapshot?.tags) ? snapshot.tags : []),
    ...(Array.isArray(livePayload?.product?.tags) ? livePayload.product.tags : []),
  ]
    .map((value) => normalizeNonEmptyString(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function allowsShadeAxis(contextText = '') {
  return /\b(tinted?|skin tint|shade|color[-\s]?correct|colour[-\s]?correct|tone[-\s]?up|tone[-\s]?correct|lip tint|lipstick|lip gloss|lip oil|lip balm|lip treatment|lip scrub|pout preserve|balm stick|dewy balm|glow balm|foundation|concealer|bronzer|blush|highlighter|powder|eyeshadow|eyeliner|brow|mascara|makeup|cosmetic)\b/i.test(
    contextText,
  );
}

function isSkincareLikeContext(contextText = '') {
  return /\b(serum|essence|ampoule|moisturi[sz]er|cream|cleanser|toner|lotion|balm|mask|treatment|sunscreen|spf|sun protection|skin care|skincare|barrier|retinol|niacinamide|vitamin c|acid)\b/i.test(
    contextText,
  );
}

function looksLikeSizeValue(value = '') {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) return false;
  return (
    /\b\d+(?:\.\d+)?\s*(ml|m l|g|kg|oz|fl oz|l|lb|lbs|mm|cm)\b/i.test(normalized) ||
    /\b(pack of|set of)\s*\d+\b/i.test(normalized) ||
    /\b\d+\s*(pack|ct|count|pcs|pieces)\b/i.test(normalized) ||
    /\b(refill|travel size|full size|mini|jumbo|regular)\b/i.test(normalized)
  );
}

function hasVariantVisualEvidence(item = {}) {
  return Boolean(
    normalizeNonEmptyString(
      item?.label_image_url ||
        item?.swatch_image_url ||
        item?.image_url ||
        item?.image,
    ) ||
      normalizeNonEmptyString(
        item?.swatch?.hex ||
          item?.swatch_color ||
          item?.color_hex ||
          item?.shade_hex,
      ),
  );
}

function collectLiveVariantAuditRows(livePayload = {}) {
  const product = ensureJsonObject(livePayload?.product);
  const productLineOptions = Array.isArray(product?.product_line_options) ? product.product_line_options : [];
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const rows = [];

  for (const option of productLineOptions) {
    rows.push({
      source: 'product_line_option',
      axis_name: normalizeNonEmptyString(option?.option_name || option?.axis || option?.name),
      axis_kind: normalizeNonEmptyString(option?.axis),
      value: normalizeNonEmptyString(option?.value || option?.label),
      visual: hasVariantVisualEvidence(option),
    });
  }

  for (const variant of variants) {
    const options = Array.isArray(variant?.options) ? variant.options : [];
    for (const option of options) {
      rows.push({
        source: 'variant_option',
        axis_name: normalizeNonEmptyString(option?.name),
        axis_kind: normalizeNonEmptyString(option?.axis_kind || option?.axis),
        value: normalizeNonEmptyString(option?.value),
        visual: hasVariantVisualEvidence(variant),
      });
    }
  }

  return rows.filter((row) => row.axis_name || row.axis_kind || row.value);
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

function collectSeedIdentityText(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return [
    seedData?.title,
    snapshot?.title,
    seedData?.product_title,
    snapshot?.product_title,
    seedData?.category,
    snapshot?.category,
    seedData?.product_type,
    snapshot?.product_type,
  ]
    .map(normalizeNonEmptyString)
    .filter(Boolean)
    .join(' ');
}

function hasReviewedActiveIngredientsContract(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return [seedData?.reviewed_active_ingredients_v1, snapshot?.reviewed_active_ingredients_v1]
    .map(ensureJsonObject)
    .some((contract) => contract.contract_version === 'external_seed.reviewed_active_ingredients.v1');
}

function getSeedPdpFieldQualityStatus(seedData = {}, key = '') {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  for (const source of [seedData, snapshot]) {
    const row = ensureJsonObject(ensureJsonObject(source?.pdp_field_quality_summary)[key]);
    const status = normalizeNonEmptyString(row.source_quality_status || row.sourceQualityStatus).toLowerCase();
    if (status) return status;
  }
  return '';
}

function hasNonSurfaceableActiveQuality(seedData = {}) {
  const status =
    getSeedPdpFieldQualityStatus(seedData, 'active_ingredients_raw') ||
    getSeedPdpFieldQualityStatus(seedData, 'active_ingredients');
  return (
    Boolean(status) &&
    (NON_SURFACEABLE_ACTIVE_STATUS.has(status) || status.startsWith('force_filled'))
  );
}

function shouldSuppressSeedActiveExpectation(seedData = {}) {
  if (hasReviewedActiveIngredientsContract(seedData)) return false;
  if (hasNonSurfaceableActiveQuality(seedData)) return true;
  const context = collectSeedIdentityText(seedData);
  if (!context) return false;
  if (ACTIVE_ALLOWED_HINT_RE.test(context)) return false;
  return COLOR_COSMETIC_OR_TOOL_RE.test(context);
}

function hasSunscreenIdentityContext(contextText = '') {
  return /\b(?:spf|sunscreen|sun screen|sun protection|broad spectrum|uv|uva|uvb|pa\+{2,}|protective fluid)\b/i.test(
    contextText,
  );
}

function isMakeupComplexionIdentityContext(contextText = '') {
  return /\b(?:foundation|concealer|skin tint|tinted moisturizer|bb cream|cc cream|powder foundation|makeup)\b/i.test(
    contextText,
  );
}

function seedExpectsActiveIngredients(seedData = {}) {
  if (shouldSuppressSeedActiveExpectation(seedData)) return false;
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
  const identityContext = collectSeedIdentityText(seedData);
  const hasSunscreenIdentity = hasSunscreenIdentityContext(identityContext);
  if (!hasSunscreenIdentity && isMakeupComplexionIdentityContext(identityContext)) return false;
  const context = collectSeedContextText(seedData);
  const hasSunscreenContext = hasSunscreenIdentity || hasSunscreenIdentityContext(context);
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

function collectSeedContentImageUrls(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return Array.from(
    new Set(
      [seedData?.content_image_urls, snapshot?.content_image_urls]
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .map((value) => normalizePdpImageUrl(value))
        .filter(Boolean),
    ),
  );
}

function classifyGalleryAsset(url) {
  const normalized = normalizePdpImageUrl(url);
  if (!normalized) return '';
  try {
    return classifyShopifyLikeAsset(new URL(normalized));
  } catch {
    return '';
  }
}

function looksLikeContentGalleryAssetUrl(url) {
  const normalized = normalizePdpImageUrl(url).toLowerCase();
  if (!normalized) return false;
  let filename = normalized;
  try {
    filename = decodeURIComponent(new URL(normalized).pathname.split('/').pop() || normalized).toLowerCase();
  } catch {}
  return /(?:ingredient|ingredients|how[-_ ]?to|directions|routine|benefit|benefits|before[-_ ]?after|before|after|clinical|results|study|chart|diagram|infographic|claims?|ugc|review|reviews?)/i.test(filename);
}

function countDuplicateGalleryImages(urls = []) {
  const seen = new Set();
  let duplicateCount = 0;
  for (const value of Array.isArray(urls) ? urls : []) {
    const key = buildPdpImageDedupeKey(value) || normalizePdpImageUrl(value) || normalizeNonEmptyString(value);
    if (!key) continue;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
  }
  return duplicateCount;
}

function countContentGalleryLeaks({ galleryImages = [], seedContentImageUrls = [] } = {}) {
  const contentKeys = new Set(
    (Array.isArray(seedContentImageUrls) ? seedContentImageUrls : [])
      .map((url) => buildPdpImageDedupeKey(url) || normalizePdpImageUrl(url))
      .filter(Boolean),
  );
  let leakCount = 0;
  let hasProductAssets = false;
  let hasContentAssets = false;

  for (const url of Array.isArray(galleryImages) ? galleryImages : []) {
    const dedupeKey = buildPdpImageDedupeKey(url) || normalizePdpImageUrl(url);
    const assetKind = classifyGalleryAsset(url);
    if (assetKind === 'product') hasProductAssets = true;
    if (assetKind === 'content' && looksLikeContentGalleryAssetUrl(url)) hasContentAssets = true;
    if (dedupeKey && contentKeys.has(dedupeKey)) {
      leakCount += 1;
    }
  }

  if (leakCount === 0 && hasProductAssets && hasContentAssets) {
    return 1;
  }
  return leakCount;
}

function readExternalSeedSnapshotContract(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const raw =
    ensureJsonObject(seedData?.external_seed_snapshot_contract) ||
    ensureJsonObject(snapshot?.external_seed_snapshot_contract);
  if (!Object.keys(raw).length) return null;
  return {
    authoritative: raw.authoritative === true || raw.structured_fields_authoritative === true,
    legacy_fields_quarantined:
      raw.legacy_fields_quarantined === true || raw.legacyFieldsQuarantined === true,
    replace_strategy: normalizeNonEmptyString(raw.replace_strategy || raw.replaceStrategy).toLowerCase(),
  };
}

function collectVariantSelectorSizeEvidence(seedData = {}, livePayload = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const variants = [
    ...(Array.isArray(snapshot?.variants) ? snapshot.variants : []),
    ...(Array.isArray(seedData?.variants) ? seedData.variants : []),
  ];
  const parts = [
    seedData?.title,
    snapshot?.title,
    livePayload?.product?.title,
    livePayload?.product?.name,
    seedData?.size,
    snapshot?.size,
    seedData?.volume,
    snapshot?.volume,
    seedData?.product_size,
    snapshot?.product_size,
    seedData?.product_volume,
    snapshot?.product_volume,
    seedData?.net_content,
    snapshot?.net_content,
    seedData?.net_size,
    snapshot?.net_size,
    ...variants.flatMap((variant) => [
      variant?.title,
      variant?.option_name,
      variant?.option_value,
      variant?.url,
      variant?.image_url,
    ]),
  ]
    .map(normalizeNonEmptyString)
    .filter(Boolean);
  return parts.find((value) => VARIANT_SIZE_EVIDENCE_RE.test(value) || NAMED_SIZE_EVIDENCE_RE.test(value)) || '';
}

function hasDefaultLikeSeedVariant(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  const variants = [
    ...(Array.isArray(snapshot?.variants) ? snapshot.variants : []),
    ...(Array.isArray(seedData?.variants) ? seedData.variants : []),
  ];
  if (!variants.length) return false;
  return variants.some((variant) => {
    const title = normalizeNonEmptyString(variant?.title).toLowerCase();
    const optionName = normalizeNonEmptyString(variant?.option_name).toLowerCase();
    const optionValue = normalizeNonEmptyString(variant?.option_value).toLowerCase();
    return (
      DEFAULT_TITLE_AXIS_RE.test(title) ||
      DEFAULT_TITLE_AXIS_RE.test(optionValue) ||
      /^(?:offer|option|variant|title)$/i.test(optionName)
    );
  });
}

function hasIdentityDefaultTitleAxisPollution(livePayload = {}, liveResponse = {}) {
  const canonicalData = extractCanonicalData(liveResponse);
  const product = ensureJsonObject(livePayload?.product);
  const candidates = [
    JSON.stringify(canonicalData?.variant_axes || {}),
    JSON.stringify(product?.variant_axes || {}),
    ...(Array.isArray(canonicalData?.match_basis) ? canonicalData.match_basis : []),
    ...(Array.isArray(product?.match_basis) ? product.match_basis : []),
  ]
    .map(normalizeNonEmptyString)
    .filter(Boolean)
    .join(' ');
  return (
    /variant_axes:shade:default title/i.test(candidates) ||
    /"shade":"default title"/i.test(candidates) ||
    /"shade":"default"/i.test(candidates)
  );
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

function hasSourceUnavailableMarker(seedData = {}) {
  const snapshot = ensureJsonObject(seedData?.snapshot);
  return [seedData, snapshot].some((source) => {
    const marker = ensureJsonObject(source?.source_unavailable_v1);
    const blocker = ensureJsonObject(source?.transaction_readiness_blocker_v1);
    return (
      normalizeNonEmptyString(marker.status).toLowerCase() === 'source_unavailable' ||
      normalizeNonEmptyString(blocker.status).toLowerCase() === 'source_unavailable'
    );
  });
}

function buildSourceUnavailableExtractorGate({ extractorResponse = {}, extractorProduct = {}, seedData = {} } = {}) {
  const gate = buildExtractorGate({ extractorResponse, extractorProduct });
  if (!hasSourceUnavailableMarker(seedData)) return gate;
  return {
    ...gate,
    status: gate.failure_category ? 'terminal_source_unavailable' : gate.status,
    source_unavailable: true,
    failure_reasons: [],
  };
}

function buildLivePdpGate({
  extractorProduct = {},
  livePayload = {},
  liveResponse = {},
  seedData = {},
  productFamily = '',
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
  const duplicateGalleryImageCount = countDuplicateGalleryImages(galleryImages);
  const seedContentImageUrls = collectSeedContentImageUrls(seedData);
  const contentGalleryLeakCount = countContentGalleryLeaks({
    galleryImages,
    seedContentImageUrls,
  });
  const strippedImageUrls = galleryImages.filter((url) => isImageUrlIdentityStripped(url));
  const seedDetailSections = collectSeedDetailsSections(seedData);
  const seedFaqItems = collectSeedFaqItems(seedData);
  const liveQuestions = collectLiveQuestions(livePayload, liveResponse);
  const liveActiveItems = collectLiveActiveIngredients(livePayload, liveResponse);
  const snapshotContract = readExternalSeedSnapshotContract(seedData);
  const normalizedProductFamily = normalizeNonEmptyString(productFamily).toLowerCase();
  const suppressSingleFormulaActive =
    ['set_or_collection', 'non_merch', 'accessory'].includes(normalizedProductFamily);
  const activeIngredientsExpected = seedExpectsActiveIngredients(seedData) && !suppressSingleFormulaActive;
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
    !(activeIngredientsExpected && liveModuleList.includes('active_ingredients'));
  if (compressedStructuredDetails) {
    failureReasons.push('structured_sections_compressed_to_description_category');
  }
  if (seedFaqItems.length > 0 && liveQuestions.length === 0) {
    failureReasons.push('merchant_faq_dropped');
  }
  if (activeIngredientsExpected && liveActiveItems.length === 0) {
    failureReasons.push('active_ingredients_expected_but_hidden');
  }
  if (suppressSingleFormulaActive && liveActiveItems.length > 0) {
    failureReasons.push('set_active_ingredients_rendered_as_single_formula');
  }
  if (duplicateGalleryImageCount > 0) {
    failureReasons.push('duplicate_gallery_images');
  }
  if (contentGalleryLeakCount > 0) {
    failureReasons.push('content_media_leaked_into_gallery');
  }
  if (
    !snapshotContract ||
    snapshotContract.authoritative !== true ||
    snapshotContract.legacy_fields_quarantined !== true
  ) {
    failureReasons.push('legacy_snapshot_not_quarantined');
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
      expected: activeIngredientsExpected,
      live_item_count: liveActiveItems.length,
      suppressed_for_product_family: suppressSingleFormulaActive ? normalizedProductFamily : null,
    },
    image_health: imageHealth || {
      scanned_count: 0,
      broken_count: 0,
      broken_urls: [],
      skipped: true,
    },
    gallery_status: {
      image_count: galleryImages.length,
      duplicate_count: duplicateGalleryImageCount,
      content_leak_count: contentGalleryLeakCount,
      seed_content_image_count: seedContentImageUrls.length,
    },
    snapshot_contract: snapshotContract || null,
    image_url_identity_stripped_count: strippedImageUrls.length,
    image_url_identity_stripped_examples: strippedImageUrls.slice(0, 5),
    failure_reasons: failureReasons,
  };
}

function buildSimilarGate({
  similarResponse = {},
  livePayload = {},
  liveResponse = {},
  exclusionFlags = {},
  productFamily = '',
  skippedReason = '',
} = {}) {
  const normalizedSkippedReason = normalizeNonEmptyString(skippedReason || similarResponse?.reason);
  if (similarResponse?.skipped || normalizedSkippedReason) {
    return {
      status: 'skipped',
      similar_count: 0,
      card_highlight_missing_count: 0,
      exempt: false,
      skipped_reason: normalizedSkippedReason || 'similar_probe_skipped',
      failure_reasons: [],
    };
  }
  const similarModuleData =
    findModuleData('similar', liveResponse, livePayload) ||
    findModuleData('recommendations', liveResponse, livePayload) ||
    ensureJsonObject(similarResponse?.similar || liveResponse?.similar || livePayload?.recommendations);
  const productSources = [
    similarModuleData?.items,
    similarModuleData?.products,
    similarResponse?.products,
    similarResponse?.items,
    similarResponse?.response?.products,
    similarResponse?.response?.items,
  ];
  const products = productSources.find((items) => Array.isArray(items) && items.length > 0) || [];
  const exempt =
    Boolean(exclusionFlags?.gift_card) ||
    Boolean(exclusionFlags?.donation_bundle) ||
    Boolean(exclusionFlags?.non_merchandise) ||
    ['set_or_collection', 'non_merch', 'accessory'].includes(normalizeNonEmptyString(productFamily).toLowerCase());
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

function buildVariantGate({ seedData = {}, livePayload = {}, liveResponse = {} } = {}) {
  const liveModuleList = collectLiveModuleList(livePayload, liveResponse);
  const contextText = collectVariantAuditContext(seedData, livePayload);
  const rows = collectLiveVariantAuditRows(livePayload);
  const visibleRows = rows.filter((row) => row.value);
  const sizeEvidence = collectVariantSelectorSizeEvidence(seedData, livePayload);
  const defaultLikeSeedVariant = hasDefaultLikeSeedVariant(seedData);
  const identityOptionRows = visibleRows.filter((row) => VARIANT_IDENTITY_OPTION_RE.test(row.axis_name));
  const wrongAxisRows = visibleRows.filter((row) => {
    const axisName = row.axis_kind || row.axis_name;
    if (!SHADE_AXIS_RE.test(axisName)) return false;
    if (allowsShadeAxis(contextText)) return false;
    return LOCALE_LIKE_VARIANT_VALUE_RE.test(row.value) || isSkincareLikeContext(contextText);
  });
  const missingVisualRows = visibleRows.filter((row) => {
    const axisName = row.axis_kind || row.axis_name;
    return SHADE_AXIS_RE.test(axisName) && allowsShadeAxis(contextText) && !row.visual;
  });
  const genericSizeRows = visibleRows.filter((row) => {
    const axisName = row.axis_kind || row.axis_name;
    return GENERIC_VARIANT_AXIS_RE.test(axisName) && looksLikeSizeValue(row.value);
  });
  const identityDefaultTitleAxis = hasIdentityDefaultTitleAxisPollution(livePayload, liveResponse)
    ? [{ axis_name: 'shade', axis_kind: 'shade', value: 'default title', visual: false }]
    : [];
  const missingVariantSelectorFromSizeEvidence =
    !liveModuleList.includes('variant_selector') &&
    sizeEvidence &&
    defaultLikeSeedVariant &&
    (identityDefaultTitleAxis.length > 0 || NAMED_SIZE_EVIDENCE_RE.test(sizeEvidence))
      ? [{ axis_name: 'size', axis_kind: 'size', value: sizeEvidence, visual: false }]
      : [];
  const failureReasons = [];
  if (liveModuleList.includes('variant_selector') && identityOptionRows.length > 0) {
    failureReasons.push('identity_option_visible');
  }
  if (liveModuleList.includes('variant_selector') && wrongAxisRows.length > 0) {
    failureReasons.push('wrong_axis_for_category');
  }
  if (liveModuleList.includes('variant_selector') && missingVisualRows.length > 0) {
    failureReasons.push('makeup_shade_missing_visual');
  }
  if (liveModuleList.includes('variant_selector') && genericSizeRows.length > 0) {
    failureReasons.push('size_value_generic_axis');
  }
  if (missingVariantSelectorFromSizeEvidence.length > 0) {
    failureReasons.push('missing_variant_selector_from_size_evidence');
  }
  if (identityDefaultTitleAxis.length > 0) {
    failureReasons.push('identity_default_title_axis');
  }
  if (missingVariantSelectorFromSizeEvidence.length > 0 && identityDefaultTitleAxis.length > 0) {
    failureReasons.push('size_siblings_split_product_line');
  }
  return {
    status: failureReasons.length ? 'failed' : 'passed',
    visible_variant_row_count: visibleRows.length,
    identity_option_visible_count: identityOptionRows.length,
    wrong_axis_for_category_count: wrongAxisRows.length,
    makeup_shade_missing_visual_count: missingVisualRows.length,
    size_value_generic_axis_count: genericSizeRows.length,
    examples: {
      identity_option_visible: identityOptionRows.slice(0, 5),
      wrong_axis_for_category: wrongAxisRows.slice(0, 5),
      makeup_shade_missing_visual: missingVisualRows.slice(0, 5),
      size_value_generic_axis: genericSizeRows.slice(0, 5),
      missing_variant_selector_from_size_evidence: missingVariantSelectorFromSizeEvidence.slice(0, 5),
      identity_default_title_axis: identityDefaultTitleAxis.slice(0, 5),
      size_siblings_split_product_line:
        missingVariantSelectorFromSizeEvidence.length > 0 && identityDefaultTitleAxis.length > 0
          ? missingVariantSelectorFromSizeEvidence.slice(0, 5)
          : [],
    },
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
  variantGate = {},
} = {}) {
  const failureReasons = [
    ...(Array.isArray(seedGate.failure_reasons) ? seedGate.failure_reasons : []),
    ...(Array.isArray(extractorGate.failure_reasons) ? extractorGate.failure_reasons : []),
    ...(Array.isArray(identityGate.failure_reasons) ? identityGate.failure_reasons : []),
    ...(Array.isArray(productIntelGate.failure_reasons) ? productIntelGate.failure_reasons : []),
    ...(Array.isArray(livePdpGate.failure_reasons) ? livePdpGate.failure_reasons : []),
    ...(Array.isArray(similarGate.failure_reasons) ? similarGate.failure_reasons : []),
    ...(Array.isArray(variantGate.failure_reasons) ? variantGate.failure_reasons : []),
  ].filter(Boolean);
  const rootCauseClassification = [];
  if (failureReasons.includes('extractor_failure')) rootCauseClassification.push('extractor_issue');
  if (
    failureReasons.includes('duplicate_gallery_images') ||
    failureReasons.includes('content_media_leaked_into_gallery') ||
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
    failureReasons.includes('active_ingredients_expected_but_hidden') ||
    failureReasons.includes('set_active_ingredients_rendered_as_single_formula') ||
    failureReasons.includes('live_pdp_probe_failed')
  ) {
    rootCauseClassification.push('pdp_shaping_issue');
  }
  if (failureReasons.includes('missing_pdp_identity')) {
    rootCauseClassification.push('identity_graph_gap');
  }
  if (failureReasons.includes('legacy_snapshot_not_quarantined')) {
    rootCauseClassification.push('snapshot_contract_gap');
  }
  if (
    failureReasons.includes('missing_product_intel') ||
    failureReasons.includes('product_intel_module_empty_or_blocked')
  ) {
    rootCauseClassification.push('product_intel_gap');
  }
  if (
    failureReasons.includes('similar_probe_failed') ||
    failureReasons.includes('similar_underfill') ||
    failureReasons.includes('similar_card_missing_highlight')
  ) {
    rootCauseClassification.push('similar_issue');
  }
  if (
    failureReasons.includes('identity_option_visible') ||
    failureReasons.includes('wrong_axis_for_category') ||
    failureReasons.includes('makeup_shade_missing_visual') ||
    failureReasons.includes('size_value_generic_axis') ||
    failureReasons.includes('missing_variant_selector_from_size_evidence') ||
    failureReasons.includes('identity_default_title_axis') ||
    failureReasons.includes('size_siblings_split_product_line')
  ) {
    rootCauseClassification.push('variant_contract_issue');
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
    variant_gate: variantGate,
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
  buildSourceUnavailableExtractorGate,
  hasSourceUnavailableMarker,
  buildIdentityGate,
  buildProductIntelGate,
  buildLivePdpGate,
  buildSimilarGate,
  buildVariantGate,
  buildExternalSeedQualityResult,
};

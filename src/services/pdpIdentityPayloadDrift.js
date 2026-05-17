function normalizeString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function ensureJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textFromValue(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
        return item.title || item.name || item.label || item.value || item.text || '';
      })
      .map(normalizeString)
      .filter(Boolean)
      .join(' ');
  }
  if (value && typeof value === 'object') {
    return normalizeString(value.raw_text || value.rawText || value.text || value.value || value.title || value.name);
  }
  return '';
}

function textLength(value) {
  return textFromValue(value).length;
}

function getSnapshot(source) {
  return ensureJsonObject(ensureJsonObject(source).snapshot);
}

function collectPayloadSources(payload) {
  const top = ensureJsonObject(payload);
  const seedData = ensureJsonObject(top.seed_data);
  const seedSnapshot = getSnapshot(seedData);
  const externalSeed = ensureJsonObject(top.external_seed);
  const externalSnapshot = getSnapshot(externalSeed);
  return [top, seedData, seedSnapshot, externalSeed, externalSnapshot].filter(
    (source) => Object.keys(source).length > 0,
  );
}

function firstTextFromSources(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const text = textFromValue(source?.[key]);
      if (text) return text;
    }
  }
  return '';
}

function firstArrayLengthFromSources(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = source?.[key];
      if (Array.isArray(value) && value.length > 0) return value.length;
    }
  }
  return 0;
}

function pickReviewCount(payload) {
  const sources = collectPayloadSources(payload);
  for (const source of sources) {
    const review = ensureJsonObject(source.review_summary || source.reviewSummary || source.reviews_summary);
    const count = Number(review.count ?? review.review_count ?? review.reviews_count ?? review.total);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return 0;
}

function hasAuthoritativeSnapshotContract(payload) {
  return collectPayloadSources(payload).some((source) => {
    const contract = ensureJsonObject(source.external_seed_snapshot_contract);
    return (
      (contract.authoritative === true || contract.structured_fields_authoritative === true) &&
      (contract.legacy_fields_quarantined === true || contract.legacyFieldsQuarantined === true)
    );
  });
}

function getFieldQualityKeys(payload) {
  const keys = new Set();
  for (const source of collectPayloadSources(payload)) {
    const summary = ensureJsonObject(source.pdp_field_quality_summary);
    Object.keys(summary).forEach((key) => keys.add(key));
  }
  return Array.from(keys).sort();
}

function getFieldQualityStatus(payload, key) {
  for (const source of collectPayloadSources(payload)) {
    const row = ensureJsonObject(ensureJsonObject(source.pdp_field_quality_summary)[key]);
    const status = normalizeString(row.source_quality_status || row.sourceQualityStatus).toLowerCase();
    if (status) return status;
  }
  return '';
}

function hasStrictSourceBlocker(payload) {
  return collectPayloadSources(payload).some((source) => {
    const blocker = ensureJsonObject(source.strict_pdp_source_blocker_v1);
    return Object.keys(blocker).length > 0;
  });
}

function hasActiveIngredientEvidence(payload, title = '') {
  const sources = collectPayloadSources(payload);
  const activeText = firstTextFromSources(sources, [
    'pdp_active_ingredients_raw',
    'active_ingredients',
    'activeIngredients',
  ]);
  if (activeText) return true;

  const ingredientsText = firstTextFromSources(sources, [
    'pdp_ingredients_raw',
    'raw_ingredient_text_clean',
    'ingredients_raw',
    'ingredientsRaw',
  ]);
  if (/\bactive ingredients?\b/i.test(ingredientsText)) return true;

  const context = [
    title,
    firstTextFromSources(sources, ['title', 'name', 'category', 'product_type', 'pdp_description_raw']),
  ].join(' ');
  const hasSunscreenContext =
    /\b(?:spf|sunscreen|sun screen|sun protection|broad spectrum|uv|uva|uvb|pa\+{2,}|protective fluid)\b/i.test(
      context,
    );
  if (!hasSunscreenContext) return false;
  return /\b(?:zinc oxide|titanium dioxide|avobenzone|octocrylene|octisalate|homosalate|octinoxate|ensulizole|oxybenzone)\b/i.test(
    ingredientsText,
  );
}

function hasActiveIngredientExpectation(payload, title = '') {
  if (hasActiveIngredientEvidence(payload, title)) return true;
  const sources = collectPayloadSources(payload);
  const fieldQualityKeys = getFieldQualityKeys(payload).join(' ');
  if (/\bactive_ingredients?_raw\b|\bactiveIngredients?\b/i.test(fieldQualityKeys)) return true;

  const context = [
    title,
    firstTextFromSources(sources, [
      'title',
      'name',
      'category',
      'product_type',
      'pdp_description_raw',
      'description',
    ]),
  ].join(' ');
  const ingredientishSource =
    firstArrayLengthFromSources(sources, ['ingredients_inci', 'ingredientsInci', 'inci_list']) > 0 ||
    firstTextFromSources(sources, [
      'pdp_ingredients_raw',
      'raw_ingredient_text_clean',
      'ingredients_raw',
      'ingredientsRaw',
    ]).length > 0;
  if (!ingredientishSource) return false;

  const likelyMakeupOnly =
    /\b(?:foundation|concealer|lip liner|eyeliner|mascara|brow|eyeshadow|blush|bronzer|highlighter|cc stick|color pencil)\b/i.test(
      context,
    );
  if (likelyMakeupOnly && !/\b(?:spf|sunscreen|skin|skincare|treatment|peptide|retinol|acid|niacinamide)\b/i.test(context)) {
    return false;
  }
  const likelyHydrocolloidPatch =
    /\b(?:hydrocolloid|pimple\s+patch|pimple\s+patches|blemish\s+patch|blemish\s+patches|spot\s+cover\s+patch|acne\s+patch|acne\s+patches)\b/i.test(
      context,
    );
  if (likelyHydrocolloidPatch && !/\b(?:salicylic|benzoyl peroxide|tea tree|sulfur|azelaic|mandelic|glycolic|lactic|bha|aha)\b/i.test(context)) {
    return false;
  }
  return /\b(?:serum|moisturi[sz]er|cream|cr[eè]me|toner|cleanser|mask|scrub|essence|face oil|sunscreen|spf|acid|retinol|peptide|ceramide|niacinamide|salicylic|glycolic|lactic|vitamin c|barrier|hydrating|hydration|firming|skin|skincare|treatment|eye cream|eye cr[eè]me|body moisturizer)\b/i.test(
    context,
  );
}

function isBundleLikePayload(payload, title = '') {
  const sources = collectPayloadSources(payload);
  const productFamily = firstTextFromSources(sources, [
    'product_family',
    'external_seed_product_family',
    'product_kind',
    'source_listing_scope',
  ]).toLowerCase();
  if (/(set|bundle|collection|kit|duo|trio)/i.test(productFamily)) return true;
  const text = [title, firstTextFromSources(sources, ['title', 'name'])].join(' ');
  return /\b(set|bundle|duo|trio|collection|kit|starter set|routine)\b/i.test(text);
}

function summarizePdpPayloadContract(payload, title = '') {
  const sources = collectPayloadSources(payload);
  const activeEvidence = hasActiveIngredientEvidence(payload, title);
  const activeExpectation = hasActiveIngredientExpectation(payload, title);
  const fieldQualityKeys = getFieldQualityKeys(payload);
  return {
    title: firstTextFromSources(sources, ['title', 'name']),
    description_len: firstTextFromSources(sources, ['description', 'description_text']).length,
    pdp_description_len: firstTextFromSources(sources, ['pdp_description_raw', 'pdp_description']).length,
    active_evidence: activeEvidence,
    active_expectation: activeExpectation,
    active_items_count: firstArrayLengthFromSources(sources, ['active_ingredients', 'activeIngredients']),
    active_raw_len: firstTextFromSources(sources, ['pdp_active_ingredients_raw']).length,
    ingredients_raw_len: firstTextFromSources(sources, [
      'pdp_ingredients_raw',
      'raw_ingredient_text_clean',
      'ingredients_raw',
    ]).length,
    ingredients_inci_count: firstArrayLengthFromSources(sources, [
      'ingredients_inci',
      'ingredientsInci',
      'inci_list',
    ]),
    how_to_len: firstTextFromSources(sources, ['pdp_how_to_use_raw', 'how_to_use', 'howToUse']).length,
    details_count: firstArrayLengthFromSources(sources, ['pdp_details_sections', 'details_sections']),
    faq_count: firstArrayLengthFromSources(sources, ['pdp_faq_items', 'faq_items']),
    content_image_count: firstArrayLengthFromSources(sources, ['content_image_urls']),
    image_count: firstArrayLengthFromSources(sources, ['images', 'image_urls']),
    variants_count: firstArrayLengthFromSources(sources, ['variants']),
    review_count: pickReviewCount(payload),
    has_contract: hasAuthoritativeSnapshotContract(payload),
    field_quality_keys: fieldQualityKeys,
    high_quality_field_count: fieldQualityKeys.filter((key) =>
      ['high', 'medium', 'force_filled_reviewed_pattern'].includes(getFieldQualityStatus(payload, key)),
    ).length,
    strict_blocker: hasStrictSourceBlocker(payload),
    bundle_like: isBundleLikePayload(payload, title),
  };
}

function buildPayloadDiff(beforePayload, afterPayload, title = '') {
  const before = summarizePdpPayloadContract(beforePayload, title);
  const after = summarizePdpPayloadContract(afterPayload, title);
  const beforeJson = JSON.stringify(beforePayload || {});
  const afterJson = JSON.stringify(afterPayload || {});
  return {
    before,
    after,
    changed: beforeJson !== afterJson,
    gained_active_evidence: !before.active_evidence && after.active_evidence,
    gained_ingredients:
      before.ingredients_raw_len + before.ingredients_inci_count === 0 &&
      after.ingredients_raw_len + after.ingredients_inci_count > 0,
    gained_how_to: before.how_to_len === 0 && after.how_to_len > 0,
    gained_details: before.details_count === 0 && after.details_count > 0,
    gained_content_images: before.content_image_count === 0 && after.content_image_count > 0,
    gained_reviews: before.review_count === 0 && after.review_count > 0,
    variant_count_changed: before.variants_count !== after.variants_count,
    contract_changed: before.has_contract !== after.has_contract,
    field_quality_changed: before.high_quality_field_count !== after.high_quality_field_count,
    strict_blocker_changed: before.strict_blocker !== after.strict_blocker,
  };
}

function isSeedUpdatedAfterIdentity(seedUpdatedAt, identityUpdatedAt) {
  const seedTs = Date.parse(seedUpdatedAt || '');
  const identityTs = Date.parse(identityUpdatedAt || '');
  if (!Number.isFinite(seedTs) || !Number.isFinite(identityTs)) return false;
  return seedTs > identityTs;
}

function classifyIdentityPayloadDrift({ seedPayload, identityPayload, title, seedUpdatedAt, identityUpdatedAt } = {}) {
  const seedSummary = summarizePdpPayloadContract(seedPayload, title);
  const identitySummary = summarizePdpPayloadContract(identityPayload, title);
  const seedUpdatedAfterIdentity = isSeedUpdatedAfterIdentity(seedUpdatedAt, identityUpdatedAt);
  const staleContent =
    (seedSummary.active_evidence && !identitySummary.active_evidence) ||
    seedSummary.how_to_len > identitySummary.how_to_len ||
    seedSummary.details_count > identitySummary.details_count ||
    seedSummary.ingredients_raw_len > identitySummary.ingredients_raw_len ||
    seedSummary.content_image_count > identitySummary.content_image_count ||
    (seedSummary.has_contract && !identitySummary.has_contract);
  return {
    seed_has_active_evidence: seedSummary.active_evidence,
    identity_payload_has_active_evidence: identitySummary.active_evidence,
    seed_expects_active_ingredients: seedSummary.active_expectation,
    identity_expects_active_ingredients: identitySummary.active_expectation,
    seed_updated_after_identity: seedUpdatedAfterIdentity,
    identity_payload_stale: staleContent || (seedUpdatedAfterIdentity && seedSummary.has_contract && !identitySummary.has_contract),
    audit_scope_mismatch: seedSummary.bundle_like && seedSummary.active_expectation,
    seed_summary: seedSummary,
    identity_summary: identitySummary,
  };
}

module.exports = {
  normalizeString,
  ensureJsonObject,
  asArray,
  textFromValue,
  summarizePdpPayloadContract,
  hasActiveIngredientEvidence,
  hasActiveIngredientExpectation,
  hasAuthoritativeSnapshotContract,
  isBundleLikePayload,
  buildPayloadDiff,
  classifyIdentityPayloadDrift,
  isSeedUpdatedAfterIdentity,
};

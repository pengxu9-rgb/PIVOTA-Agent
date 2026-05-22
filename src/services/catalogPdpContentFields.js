const { query } = require('../db');

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 2000;
const cache = new Map();

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function coerceObject(value) {
  if (asPlainObject(value)) return value;
  if (typeof value !== 'string') return {};
  const text = value.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return asPlainObject(parsed) || {};
  } catch {
    return {};
  }
}

function coerceArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item) => item != null) : [];
  } catch {
    return [];
  }
}

function firstString(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const fromArray = value.map(asString).find(Boolean);
      if (fromArray) return fromArray;
      continue;
    }
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function firstArray(...values) {
  for (const value of values) {
    const arr = coerceArray(value);
    if (arr.length) return arr;
  }
  return null;
}

function parseCatalogPayload(value) {
  const payload = coerceObject(value);
  const seedData = coerceObject(payload.seed_data);
  const snapshot = coerceObject(seedData.snapshot);
  const externalSeed = coerceObject(payload.external_seed);
  const externalSnapshot = coerceObject(externalSeed.snapshot);
  return {
    ...payload,
    ...(Object.keys(seedData).length ? { seed_data: { ...seedData, ...(Object.keys(snapshot).length ? { snapshot } : {}) } } : {}),
    ...(Object.keys(externalSeed).length ? { external_seed: { ...externalSeed, ...(Object.keys(externalSnapshot).length ? { snapshot: externalSnapshot } : {}) } } : {}),
  };
}

function fieldQuality(summary, key) {
  const row = asPlainObject(summary?.[key]) || {};
  return {
    status: asString(row.source_quality_status || row.sourceQualityStatus || row.quality_status).toLowerCase(),
    origin: asString(row.source_origin || row.sourceOrigin || row.origin).toLowerCase(),
    row,
  };
}

function isWeakQuality({ status = '', origin = '' } = {}) {
  return (
    !status ||
    /(low|blocked|quarantined|polluted|generic|synthetic|mock|legacy|fallback|force[_\s-]?filled|force[_\s-]?fill|pending[_\s-]?source)/i.test(status) ||
    /(pivota_force_fill|synthetic|mock|legacy|fallback|browser_fallback)/i.test(origin)
  );
}

function isApprovedQuality({ status = '', origin = '' } = {}) {
  if (!status && !origin) return false;
  if (!isWeakQuality({ status, origin })) {
    return /^(high|medium|authoritative|reviewed|manual_reviewed|seller_grounded|official_authoritative)$/i.test(status) ||
      /(^|[_\s-])(official|reviewed|manual_reviewed|seller_grounded|merchant|retailer)([_\s-]|$)/i.test(origin);
  }
  return false;
}

function currentFieldCanBeFilled(product, fieldName, qualityKeys) {
  const existing = product?.[fieldName];
  const hasExisting =
    Array.isArray(existing) ? existing.length > 0 : Boolean(asString(existing));
  if (!hasExisting) return true;
  const summary = asPlainObject(product?.pdp_field_quality_summary) || {};
  for (const key of qualityKeys) {
    const quality = fieldQuality(summary, key);
    if (isApprovedQuality(quality)) return false;
    if (!isWeakQuality(quality)) return false;
  }
  return true;
}

function readCandidateQuality(summary, keys) {
  for (const key of keys) {
    const quality = fieldQuality(summary, key);
    if (isApprovedQuality(quality)) return quality;
  }
  return null;
}

function readFirstObject(...values) {
  return values.map(coerceObject).find((value) => Object.keys(value).length > 0) || null;
}

function buildCatalogPdpContentFieldsFromRow(row) {
  const payload = parseCatalogPayload(row?.product_payload);
  const seedData = asPlainObject(payload.seed_data) || {};
  const snapshot = asPlainObject(seedData.snapshot) || {};
  const externalSeed = asPlainObject(payload.external_seed) || {};
  const externalSnapshot = asPlainObject(externalSeed.snapshot) || {};
  const ingredientIntel = readFirstObject(
    payload.ingredient_intel,
    seedData.ingredient_intel,
    snapshot.ingredient_intel,
    externalSeed.ingredient_intel,
    externalSnapshot.ingredient_intel,
  );
  const qualitySummary = readFirstObject(
    payload.pdp_field_quality_summary,
    seedData.pdp_field_quality_summary,
    snapshot.pdp_field_quality_summary,
    externalSeed.pdp_field_quality_summary,
    externalSnapshot.pdp_field_quality_summary,
  );

  if (!qualitySummary) return null;

  const out = {
    source_product_id: asString(row?.source_product_id),
    pdp_field_quality_summary: qualitySummary,
  };

  const ingredientQuality = readCandidateQuality(qualitySummary, ['ingredients_raw', 'ingredients_inci']);
  if (ingredientQuality) {
    const pdpIngredientsRaw = firstString(
      payload.pdp_ingredients_raw,
      seedData.pdp_ingredients_raw,
      snapshot.pdp_ingredients_raw,
      externalSeed.pdp_ingredients_raw,
      externalSnapshot.pdp_ingredients_raw,
    );
    if (pdpIngredientsRaw) out.pdp_ingredients_raw = pdpIngredientsRaw;
    const rawIngredientTextClean = firstString(
      payload.raw_ingredient_text_clean,
      seedData.raw_ingredient_text_clean,
      snapshot.raw_ingredient_text_clean,
      externalSeed.raw_ingredient_text_clean,
      externalSnapshot.raw_ingredient_text_clean,
      ingredientIntel?.raw_ingredient_text_clean,
    );
    if (rawIngredientTextClean) out.raw_ingredient_text_clean = rawIngredientTextClean;
    const inciList = firstArray(
      payload.inci_list,
      seedData.inci_list,
      snapshot.inci_list,
      externalSeed.inci_list,
      externalSnapshot.inci_list,
      ingredientIntel?.inci_list,
      payload.ingredients_inci,
      seedData.ingredients_inci,
      snapshot.ingredients_inci,
    );
    if (inciList) out.inci_list = inciList;
    const ingredientsInci = firstArray(payload.ingredients_inci, seedData.ingredients_inci, snapshot.ingredients_inci);
    if (ingredientsInci) out.ingredients_inci = ingredientsInci;
    if (ingredientIntel) out.ingredient_intel = ingredientIntel;
  }

  if (readCandidateQuality(qualitySummary, ['active_ingredients_raw'])) {
    const activeRaw = firstString(
      payload.pdp_active_ingredients_raw,
      seedData.pdp_active_ingredients_raw,
      snapshot.pdp_active_ingredients_raw,
      externalSeed.pdp_active_ingredients_raw,
      externalSnapshot.pdp_active_ingredients_raw,
    );
    if (activeRaw) out.pdp_active_ingredients_raw = activeRaw;
    const activeList = firstArray(payload.active_ingredients, seedData.active_ingredients, snapshot.active_ingredients);
    if (activeList) out.active_ingredients = activeList;
  }

  if (readCandidateQuality(qualitySummary, ['how_to_use_raw'])) {
    const howTo = firstString(
      payload.pdp_how_to_use_raw,
      seedData.pdp_how_to_use_raw,
      snapshot.pdp_how_to_use_raw,
      externalSeed.pdp_how_to_use_raw,
      externalSnapshot.pdp_how_to_use_raw,
    );
    if (howTo) out.pdp_how_to_use_raw = howTo;
  }

  if (readCandidateQuality(qualitySummary, ['description_raw'])) {
    const description = firstString(
      payload.pdp_description_raw,
      seedData.pdp_description_raw,
      snapshot.pdp_description_raw,
      externalSeed.pdp_description_raw,
      externalSnapshot.pdp_description_raw,
    );
    if (description) out.pdp_description_raw = description;
  }

  if (readCandidateQuality(qualitySummary, ['details_sections'])) {
    const details = firstArray(
      payload.pdp_details_sections,
      seedData.pdp_details_sections,
      snapshot.pdp_details_sections,
      externalSeed.pdp_details_sections,
      externalSnapshot.pdp_details_sections,
    );
    if (details) out.pdp_details_sections = details;
  }

  if (payload.ingredient_remediation_v1 || seedData.ingredient_remediation_v1 || snapshot.ingredient_remediation_v1) {
    const remediation = readFirstObject(
      payload.ingredient_remediation_v1,
      seedData.ingredient_remediation_v1,
      snapshot.ingredient_remediation_v1,
    );
    if (remediation) out.ingredient_remediation_v1 = remediation;
  }

  const score =
    (out.pdp_ingredients_raw ? 40 : 0) +
    (out.raw_ingredient_text_clean ? 30 : 0) +
    (out.pdp_how_to_use_raw ? 12 : 0) +
    (out.pdp_details_sections ? 8 : 0) +
    (out.pdp_description_raw ? 6 : 0) +
    (out.ingredient_intel ? 4 : 0);
  if (score <= 0) return null;
  out._score = score;
  return out;
}

function mergeQualitySummary(current, incoming, fieldsToMerge) {
  const currentSummary = asPlainObject(current) || {};
  const incomingSummary = asPlainObject(incoming) || {};
  const next = { ...currentSummary };
  for (const key of fieldsToMerge) {
    const incomingRow = asPlainObject(incomingSummary[key]);
    if (!incomingRow) continue;
    const currentQuality = fieldQuality(currentSummary, key);
    const incomingQuality = fieldQuality(incomingSummary, key);
    if (isApprovedQuality(currentQuality) && !isWeakQuality(currentQuality)) continue;
    if (!isApprovedQuality(incomingQuality)) continue;
    next[key] = incomingRow;
  }
  return Object.keys(next).length ? next : current;
}

function mergeIngredientIntel(current, incoming, hasApprovedIngredientReplacement) {
  const currentIntel = asPlainObject(current) || {};
  const incomingIntel = asPlainObject(incoming) || {};
  const next = { ...currentIntel };
  const currentForceFill = asPlainObject(next.force_fill_contract) || asPlainObject(next.forceFillContract);
  if (hasApprovedIngredientReplacement && currentForceFill) {
    delete next.force_fill_contract;
    delete next.forceFillContract;
  }
  for (const key of ['raw_ingredient_text_clean', 'inci_list', 'inci_normalized', 'ingredients_inci']) {
    if (next[key] == null && incomingIntel[key] != null) next[key] = incomingIntel[key];
  }
  if (!asPlainObject(next.authoritative) && asPlainObject(incomingIntel.authoritative)) {
    next.authoritative = incomingIntel.authoritative;
  }
  return Object.keys(next).length ? next : undefined;
}

function mergeCatalogPdpContentFieldsIntoProduct(product, fields) {
  if (!product || typeof product !== 'object' || !fields) return product;
  const changedQualityKeys = new Set();
  let replacedIngredientEvidence = false;

  const setScalar = (fieldName, qualityKeys) => {
    const value = fields[fieldName];
    if (!asString(value)) return;
    if (!currentFieldCanBeFilled(product, fieldName, qualityKeys)) return;
    product[fieldName] = value;
    qualityKeys.forEach((key) => changedQualityKeys.add(key));
    if (qualityKeys.includes('ingredients_raw') || qualityKeys.includes('ingredients_inci')) {
      replacedIngredientEvidence = true;
    }
  };

  setScalar('pdp_ingredients_raw', ['ingredients_raw', 'ingredients_inci']);
  setScalar('raw_ingredient_text_clean', ['ingredients_raw', 'ingredients_inci']);
  setScalar('pdp_active_ingredients_raw', ['active_ingredients_raw']);
  setScalar('pdp_how_to_use_raw', ['how_to_use_raw']);
  setScalar('pdp_description_raw', ['description_raw']);

  for (const [fieldName, qualityKeys] of [
    ['inci_list', ['ingredients_raw', 'ingredients_inci']],
    ['ingredients_inci', ['ingredients_raw', 'ingredients_inci']],
    ['active_ingredients', ['active_ingredients_raw']],
    ['pdp_details_sections', ['details_sections']],
  ]) {
    const value = fields[fieldName];
    if (!Array.isArray(value) || !value.length) continue;
    if (!currentFieldCanBeFilled(product, fieldName, qualityKeys)) continue;
    product[fieldName] = value;
    qualityKeys.forEach((key) => changedQualityKeys.add(key));
    if (qualityKeys.includes('ingredients_raw') || qualityKeys.includes('ingredients_inci')) {
      replacedIngredientEvidence = true;
    }
  }

  if (fields.ingredient_intel) {
    const mergedIntel = mergeIngredientIntel(product.ingredient_intel, fields.ingredient_intel, replacedIngredientEvidence);
    if (mergedIntel) product.ingredient_intel = mergedIntel;
  } else if (replacedIngredientEvidence && asPlainObject(product.ingredient_intel)) {
    const nextIntel = { ...product.ingredient_intel };
    delete nextIntel.force_fill_contract;
    delete nextIntel.forceFillContract;
    product.ingredient_intel = Object.keys(nextIntel).length ? nextIntel : undefined;
  }

  if (!product.ingredient_remediation_v1 && fields.ingredient_remediation_v1) {
    product.ingredient_remediation_v1 = fields.ingredient_remediation_v1;
  }

  if (changedQualityKeys.size > 0) {
    product.pdp_field_quality_summary = mergeQualitySummary(
      product.pdp_field_quality_summary,
      fields.pdp_field_quality_summary,
      Array.from(changedQualityKeys),
    );
    product.catalog_pdp_content_hydration = {
      source: 'catalog_products.product_payload',
      source_product_id: fields.source_product_id || undefined,
      filled_fields: Array.from(changedQualityKeys).sort(),
    };
  }

  return product;
}

function cacheKey(merchantId, sourceProductIds) {
  return `${asString(merchantId)}::${sourceProductIds.map(asString).filter(Boolean).join('|')}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function readCatalogPdpContentFieldsByProductRefs({
  merchantId,
  sourceProductIds,
  bypassCache = false,
  queryFn = query,
} = {}) {
  const merchant = asString(merchantId);
  const sourceIds = Array.from(new Set((Array.isArray(sourceProductIds) ? sourceProductIds : [sourceProductIds])
    .map(asString)
    .filter(Boolean)));
  if (!merchant || !sourceIds.length) return null;
  const key = cacheKey(merchant, sourceIds);
  if (!bypassCache) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
  }
  try {
    const result = await queryFn(
      `
        SELECT source_product_id, product_payload, updated_at
        FROM catalog_products
        WHERE merchant_id = $1
          AND source_product_id = ANY($2::text[])
        ORDER BY
          array_position($2::text[], source_product_id),
          updated_at DESC NULLS LAST
        LIMIT 20
      `,
      [merchant, sourceIds],
    );
    const candidates = (Array.isArray(result?.rows) ? result.rows : [])
      .map(buildCatalogPdpContentFieldsFromRow)
      .filter(Boolean)
      .sort((left, right) => (right._score || 0) - (left._score || 0));
    const value = candidates[0] || null;
    cacheSet(key, value);
    return value;
  } catch {
    cacheSet(key, null);
    return null;
  }
}

async function enrichProductWithCatalogPdpContentFields(product, options = {}) {
  if (!product || typeof product !== 'object') return product;
  const fields = await readCatalogPdpContentFieldsByProductRefs(options);
  if (!fields) return product;
  return mergeCatalogPdpContentFieldsIntoProduct(product, fields);
}

module.exports = {
  enrichProductWithCatalogPdpContentFields,
  readCatalogPdpContentFieldsByProductRefs,
  __test: {
    buildCatalogPdpContentFieldsFromRow,
    mergeCatalogPdpContentFieldsIntoProduct,
    _resetCache: () => cache.clear(),
  },
};

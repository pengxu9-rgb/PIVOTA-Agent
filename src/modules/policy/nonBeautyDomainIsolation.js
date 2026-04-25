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

const DOMAIN_INTENTS = Object.freeze([
  {
    id: 'carry_on_luggage',
    label: 'carry-on luggage',
    queryPattern: /\b(carry\s*on|carryon|suitcase|luggage|spinner|roller\s*bag|cabin\s*bag)\b/i,
    productPattern: /\b(carry\s*on|carryon|suitcase|luggage|spinner|roller\s*bag|cabin\s*bag|travel\s*bag|weekender|duffel)\b/i,
  },
  {
    id: 'espresso_machine',
    label: 'espresso machine',
    queryPattern: /\b(espresso|coffee\s*machine|coffee\s*maker|nespresso|latte\s*machine)\b/i,
    productPattern: /\b(espresso|coffee\s*machine|coffee\s*maker|nespresso|breville|gaggia|delonghi|de'longhi|latte)\b/i,
  },
  {
    id: 'camera',
    label: 'camera',
    queryPattern: /\b(camera|mirrorless|dslr|point\s*and\s*shoot|vlog(?:ging)?\s*camera|camera\s*lens|beginner\s+lifestyle\s+creator)\b/i,
    productPattern: /\b(camera|mirrorless|dslr|point\s*and\s*shoot|vlog(?:ging)?\s*camera|lens|canon|sony|nikon|fujifilm|panasonic|lumix)\b/i,
  },
]);

const BEAUTY_OR_PET_CONTAMINATION_PATTERN =
  /\b(sunscreen|spf|pa\+|serum|skincare|skin\s*care|moisturizer|moisturiser|toner|essence|retinol|niacinamide|cleanser|cream|lotion|hair\s*oil|lip\s*gloss|dog|dogs|cat|cats|pet|paw|overalls|knit\s*sweater)\b/i;

function inferNonBeautyDomainIntent(queryText = '') {
  const normalized = normalizeText(queryText);
  if (!normalized) return null;
  return DOMAIN_INTENTS.find((intent) => intent.queryPattern.test(normalized)) || null;
}

function getProductDomainText(product = {}) {
  if (!isPlainObject(product)) return '';
  return normalizeText([
    product.title,
    product.name,
    product.canonical_title,
    product.brand,
    product.vendor,
    product.canonical_category,
    product.category,
    product.product_type,
    product.productType,
  ].filter(Boolean).join(' '));
}

function productMatchesNonBeautyIntent(product = {}, intent = null) {
  if (!intent) return true;
  return intent.productPattern.test(getProductDomainText(product));
}

function productLooksBeautyOrPetContamination(product = {}) {
  return BEAUTY_OR_PET_CONTAMINATION_PATTERN.test(getProductDomainText(product));
}

function hasBeautySurfaceHint({ search = {}, metadata = {} } = {}) {
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
  return catalogSurface === 'beauty' || beautyDomainHint === 'beauty';
}

function appendReasonCode(existing, reason) {
  const rows = Array.isArray(existing) ? existing.slice() : [];
  if (!rows.includes(reason)) rows.push(reason);
  return rows;
}

function applyNonBeautyDomainIsolation({
  responseBody = {},
  queryText = '',
  operation = '',
  invokeSearchRail = '',
  search = {},
  metadata = {},
} = {}) {
  if (!isPlainObject(responseBody)) return responseBody;
  if (String(operation || '').trim() !== 'find_products_multi') return responseBody;
  if (String(invokeSearchRail || '').trim().toLowerCase() !== 'authoritative_shopping') return responseBody;
  if (hasBeautySurfaceHint({ search, metadata })) return responseBody;
  const intent = inferNonBeautyDomainIntent(queryText || search.query || search.q);
  if (!intent) return responseBody;
  const products = Array.isArray(responseBody.products) ? responseBody.products.filter(isPlainObject) : [];
  if (products.length === 0) return responseBody;

  const kept = products.filter((product) => productMatchesNonBeautyIntent(product, intent));
  const dropped = products.filter((product) => !productMatchesNonBeautyIntent(product, intent));
  if (dropped.length === 0) return responseBody;

  const contaminationCount = dropped.filter(productLooksBeautyOrPetContamination).length;
  const metadataPatch = {
    non_beauty_domain_isolation: {
      applied: true,
      intent_id: intent.id,
      intent_label: intent.label,
      original_count: products.length,
      kept_count: kept.length,
      dropped_count: dropped.length,
      contamination_count: contaminationCount,
      reason: 'known_non_beauty_category_contract',
    },
  };
  const next = {
    ...responseBody,
    products: kept,
    total: kept.length,
    page_size: Math.min(Number(responseBody.page_size || kept.length) || kept.length, kept.length),
    metadata: {
      ...(isPlainObject(responseBody.metadata) ? responseBody.metadata : {}),
      ...metadataPatch,
    },
    reason_codes: appendReasonCode(responseBody.reason_codes, 'non_beauty_domain_isolation_applied'),
  };
  if (kept.length === 0) {
    next.reply = `I do not have a grounded ${intent.label} match from the current catalog for that request yet.`;
    next.has_good_match = false;
    next.match_confidence = 'none';
    next.reason_codes = appendReasonCode(next.reason_codes, 'non_beauty_domain_isolation_empty');
  }
  return next;
}

module.exports = {
  inferNonBeautyDomainIntent,
  productMatchesNonBeautyIntent,
  productLooksBeautyOrPetContamination,
  applyNonBeautyDomainIsolation,
};

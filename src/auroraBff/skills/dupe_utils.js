/**
 * Normalization and self-reference detection utilities for the dupe flow.
 */

const BRAND_ALIASES = {
  'the ordinary': 'ordinary',
  theordinary: 'ordinary',
  'la roche posay': 'la roche-posay',
  larocheposay: 'la roche-posay',
  cerave: 'cerave',
  'dr jart': 'dr. jart+',
  'dr jart+': 'dr. jart+',
  clinique: 'clinique',
  skinceuticals: 'skinceuticals',
  'skin ceuticals': 'skinceuticals',
};

const SPEC_WORDS = /\b(\d+\s*)(ml|oz|fl\.?\s*oz|g|gram|mg|l|pack|ct|count|refill|set|kit|duo|trio)\b/gi;
const MARKETING_WORDS = /\b(new|updated|limited|edition|exclusive|special|reformulated|improved|original|classic|travel\s*size|mini|full\s*size|jumbo|value|bonus)\b/gi;
const TRACKING_PARAMS = /[?&](utm_\w+|ref|entry|source|medium|campaign|gclid|fbclid|affiliate|clickid|irclickid|srsltid|mc_[a-z]+)=[^&]*/gi;
const URL_PATTERN = /^https?:\/\//i;
const BUCKET_SUFFIX_PATTERN = /\s*\((budget\s+dupe|similar\s+option|premium\s+option|dupe|alternative)\)\s*$/i;

const DROP_REASON = {
  SAME_CANONICAL_REF: 'same_canonical_product_ref',
  SAME_NORMALIZED_URL: 'same_normalized_url',
  SAME_BRAND_SAME_NAME: 'same_brand_and_same_name',
  SAME_BRAND_HIGH_SIMILARITY: 'same_brand_high_name_similarity',
  NO_BRAND_SAME_URL: 'brand_missing_same_url',
  CROSS_BRAND_EXTREME_SIMILARITY: 'cross_brand_extreme_name_similarity',
};

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function pickFirstString(...values) {
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text) return text;
  }
  return '';
}

function getCandidateProduct(candidate) {
  const row = asPlainObject(candidate) || {};
  return asPlainObject(row.product) || row;
}

function getCandidateIdentity(candidate) {
  const row = asPlainObject(candidate) || {};
  const product = getCandidateProduct(candidate);
  return {
    brand: pickFirstString(product.brand, row.brand) || null,
    name: pickFirstString(product.name, product.display_name, product.displayName, row.name, row.display_name, row.displayName) || null,
    display_name: pickFirstString(product.display_name, product.displayName, row.display_name, row.displayName) || null,
    url: pickFirstString(product.url, product.product_url, product.productUrl, row.url, row.product_url, row.productUrl) || null,
    product_id: pickFirstString(product.product_id, product.productId, product.sku_id, product.skuId, row.product_id, row.productId, row.sku_id, row.skuId) || null,
    merchant_id: pickFirstString(product.merchant_id, product.merchantId, row.merchant_id, row.merchantId) || null,
    category: pickFirstString(product.category, product.product_type, product.type, row.category, row.product_type, row.type) || null,
  };
}

function patchCandidateIdentity(candidate, patch) {
  const row = asPlainObject(candidate) || {};
  const product = asPlainObject(row.product);
  if (product) {
    const nextProduct = { ...product, ...patch };
    if (patch.name && !pickFirstString(product.display_name, product.displayName)) {
      nextProduct.display_name = patch.name;
    }
    return { ...row, product: nextProduct };
  }
  const nextRow = { ...row, ...patch };
  if (patch.name && !pickFirstString(row.display_name, row.displayName)) {
    nextRow.display_name = patch.name;
  }
  return nextRow;
}

function normalizeBrand(brand) {
  if (!brand) return '';
  let norm = String(brand)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (BRAND_ALIASES[norm]) norm = BRAND_ALIASES[norm];
  return norm;
}

function normalizeProductName(name) {
  if (!name) return '';
  let norm = String(name).toLowerCase();
  norm = norm.replace(BUCKET_SUFFIX_PATTERN, ' ');
  norm = norm.replace(/[^\w\s-]/g, ' ');
  norm = norm.replace(SPEC_WORDS, ' ');
  norm = norm.replace(MARKETING_WORDS, ' ');
  norm = norm.replace(/\s+/g, ' ').trim();
  return norm;
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    let search = parsed.search.replace(TRACKING_PARAMS, '');
    if (search === '?') search = '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname}${pathname}${search}`;
  } catch {
    return String(url).toLowerCase().replace(/\/+$/, '').replace(TRACKING_PARAMS, '');
  }
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  const left = normalizeProductName(a);
  const right = normalizeProductName(b);
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const toBigrams = (text) => {
    const counts = new Map();
    for (let index = 0; index < text.length - 1; index += 1) {
      const pair = text.slice(index, index + 2);
      counts.set(pair, (counts.get(pair) || 0) + 1);
    }
    return counts;
  };

  const leftBigrams = toBigrams(left);
  const rightBigrams = toBigrams(right);
  let intersection = 0;

  for (const [pair, count] of leftBigrams.entries()) {
    if (!rightBigrams.has(pair)) continue;
    intersection += Math.min(count, rightBigrams.get(pair));
  }

  const total = left.length - 1 + right.length - 1;
  return total === 0 ? 0 : (2 * intersection) / total;
}

function buildAnchorIdentity(anchor) {
  if (!anchor) return null;
  return {
    product_id: anchor.product_id || anchor.productId || anchor.sku_id || anchor.skuId || null,
    merchant_id: anchor.merchant_id || anchor.merchantId || null,
    brand: anchor.brand || null,
    name: anchor.name || null,
    display_name: anchor.display_name || anchor.displayName || null,
    url: anchor.url || anchor.product_url || anchor.productUrl || null,
    category: anchor.category || anchor.product_type || anchor.type || null,
  };
}

function buildAnchorFingerprint(anchor) {
  const identity = buildAnchorIdentity(anchor) || {};
  return {
    brand_norm: normalizeBrand(identity.brand),
    name_norm: normalizeProductName(identity.name || identity.display_name || ''),
    url_norm: normalizeUrl(identity.url || ''),
  };
}

function detectUrlAsName(name) {
  if (!name) return { isUrlName: false, extractedName: null };
  const trimmed = String(name).trim();
  const withoutSuffix = trimmed.replace(BUCKET_SUFFIX_PATTERN, '').trim();
  if (!URL_PATTERN.test(withoutSuffix)) {
    return { isUrlName: false, extractedName: null };
  }

  let extractedName = null;
  try {
    const parsed = new URL(withoutSuffix);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || '';
    if (lastSegment) {
      extractedName = lastSegment
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase())
        .trim();
    }
  } catch {
    const match = withoutSuffix.match(/\/([^/?#]+)\/?(?:[?#].*)?$/);
    if (match) {
      extractedName = match[1]
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase())
        .trim();
    }
  }

  return {
    isUrlName: true,
    extractedName: extractedName || null,
  };
}

function sanitizeCandidateFields(candidate) {
  const identity = getCandidateIdentity(candidate);
  const sourceName = pickFirstString(identity.name, identity.display_name);
  const detected = detectUrlAsName(sourceName);
  if (!detected.isUrlName) {
    return { sanitized: candidate, issues: [] };
  }

  const issues = [
    {
      code: 'NAME_IS_URL',
      message: `Candidate name was a URL: "${sourceName}"`,
      severity: 'warning',
      original_name: sourceName,
    },
  ];

  const nextUrl = identity.url || sourceName.replace(BUCKET_SUFFIX_PATTERN, '').trim();
  const nextName = detected.extractedName || identity.brand || 'Unknown Product';
  const sanitized = patchCandidateIdentity(candidate, { name: nextName, url: nextUrl });

  return {
    sanitized: {
      ...sanitized,
      _name_extracted_from_url: true,
    },
    issues,
  };
}

function sanitizeCandidates(candidates) {
  const sanitized = [];
  const issues = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const result = sanitizeCandidateFields(candidate);
    sanitized.push(result.sanitized);
    issues.push(...result.issues);
  }

  return { sanitized, issues };
}

function detectSelfReference(candidate, anchorIdentity, anchorFingerprint, opts = {}) {
  const sameBrandThreshold = opts.sameBrandNameSimilarity || 0.92;
  const crossBrandThreshold = opts.crossBrandNameSimilarity || 0.96;

  const identity = getCandidateIdentity(candidate);
  const candidateBrand = normalizeBrand(identity.brand);
  const candidateName = normalizeProductName(identity.name || '');
  const candidateUrl = normalizeUrl(identity.url || '');
  const candidateProductId = identity.product_id || null;

  const anchorBrand = anchorFingerprint?.brand_norm || '';
  const anchorName = anchorFingerprint?.name_norm || '';
  const anchorUrl = anchorFingerprint?.url_norm || '';
  const anchorProductId = anchorIdentity?.product_id || null;
  const anchorRawName = anchorIdentity?.name || anchorIdentity?.display_name || '';

  if (anchorProductId && candidateProductId && String(anchorProductId) === String(candidateProductId)) {
    return { isSelfRef: true, reason: DROP_REASON.SAME_CANONICAL_REF };
  }

  if (anchorUrl && candidateUrl && anchorUrl === candidateUrl) {
    if (!candidateBrand) return { isSelfRef: true, reason: DROP_REASON.NO_BRAND_SAME_URL };
    return { isSelfRef: true, reason: DROP_REASON.SAME_NORMALIZED_URL };
  }

  if (anchorBrand && candidateBrand && anchorBrand === candidateBrand) {
    if (anchorName && candidateName && anchorName === candidateName) {
      return { isSelfRef: true, reason: DROP_REASON.SAME_BRAND_SAME_NAME };
    }
    if (anchorName && candidateName) {
      const similarity = nameSimilarity(identity.name || candidateName, anchorRawName);
      if (similarity >= sameBrandThreshold) {
        return { isSelfRef: true, reason: DROP_REASON.SAME_BRAND_HIGH_SIMILARITY };
      }
    }
  }

  if (anchorBrand && candidateBrand && anchorBrand !== candidateBrand && anchorName && candidateName) {
    const similarity = nameSimilarity(identity.name || candidateName, anchorRawName);
    const sameCategory = String(identity.category || '').trim().toLowerCase() === String(anchorIdentity?.category || '').trim().toLowerCase()
      && String(identity.category || '').trim() !== '';
    if (similarity >= crossBrandThreshold && sameCategory) {
      return { isSelfRef: true, reason: DROP_REASON.CROSS_BRAND_EXTREME_SIMILARITY };
    }
  }

  return { isSelfRef: false, reason: null };
}

function filterSelfReferences(candidates, anchor, opts = {}) {
  const anchorIdentity = buildAnchorIdentity(anchor);
  const anchorFingerprint = buildAnchorFingerprint(anchor);
  const kept = [];
  const dropped = [];
  const dropReasons = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const result = detectSelfReference(candidate, anchorIdentity, anchorFingerprint, opts);
    if (result.isSelfRef) {
      const identity = getCandidateIdentity(candidate);
      dropped.push({ ...candidate, _drop_reason: result.reason });
      dropReasons.push({
        candidate_name: identity.name || 'unknown',
        candidate_brand: identity.brand || 'unknown',
        reason: result.reason,
      });
      continue;
    }
    kept.push(candidate);
  }

  return {
    kept,
    dropped,
    stats: {
      candidate_count_before: Array.isArray(candidates) ? candidates.length : 0,
      candidate_count_after: kept.length,
      self_ref_dropped_count: dropped.length,
      self_ref_drop_reasons: dropReasons,
    },
  };
}

function deduplicateCandidates(candidates) {
  const seen = new Map();
  const deduplicated = [];
  const duplicateIssues = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const identity = getCandidateIdentity(candidate);
    const key = `${normalizeBrand(identity.brand)}::${normalizeProductName(identity.name || '')}`;
    if (seen.has(key)) {
      duplicateIssues.push({
        code: 'DUPLICATE_IDENTITY_CANDIDATES',
        message: `Duplicate candidate: "${identity.brand || 'unknown'} - ${identity.name || 'unknown'}" appears more than once`,
        severity: 'warning',
      });
      continue;
    }
    seen.set(key, true);
    deduplicated.push(candidate);
  }

  return { deduplicated, duplicateIssues };
}

module.exports = {
  normalizeBrand,
  normalizeProductName,
  normalizeUrl,
  nameSimilarity,
  buildAnchorIdentity,
  buildAnchorFingerprint,
  getCandidateIdentity,
  sanitizeCandidateFields,
  sanitizeCandidates,
  detectUrlAsName,
  detectSelfReference,
  filterSelfReferences,
  deduplicateCandidates,
  DROP_REASON,
};

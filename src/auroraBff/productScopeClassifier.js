'use strict';

const { buildExternalSeedSurfacingText } = require('./externalSeedSurfacingPolicy');
const { __internal: recoHybridInternal } = require('./usecases/recoHybridResolveCandidates');

const FACIAL_FRAMEWORK_SCOPE_BLOCK_RE = /\b(hand|body|foot|heel|elbow|cuticle|lip balm|lip mask|body wash|body lotion|body cream|body oil|hand cream|hand lotion|hand balm|foot cream|foot mask|scalp|hair|shampoo|conditioner|deodorant)\b/i;
const FACIAL_FRAMEWORK_SCOPE_ALLOW_RE = /\b(face|facial|cheek|forehead|chin|t-zone)\b/i;
const CONCERN_SUNSCREEN_SIGNAL_RE = /\b(spf(?:\s*\d{1,3}\+?)?|sunscreen|sun screen|sun fluid|sun cream|sun lotion|broad spectrum|uv filters?|pa\+{1,4}|防晒|防曬)\b/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function uniqCaseInsensitiveStrings(items, max = 80) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeConcernQueryToken(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isConcernExternalSeedCandidate(row) {
  const candidate = isPlainObject(row) ? row : {};
  const merchantId = pickFirstTrimmed(candidate.merchant_id, candidate.merchantId).toLowerCase();
  const source = pickFirstTrimmed(
    candidate.source,
    candidate.retrieval_source,
    candidate.retrievalSource,
    candidate.query_source,
  ).toLowerCase();
  return merchantId === 'external_seed' || source === 'external_seed' || source.includes('external_seed');
}

function buildConcernCandidateAnchorText(row) {
  const candidate = isPlainObject(row) ? row : {};
  const sku = isPlainObject(candidate.sku) ? candidate.sku : {};
  return [
    pickFirstTrimmed(candidate.brand),
    pickFirstTrimmed(candidate.display_name, candidate.displayName, candidate.name, candidate.title),
    pickFirstTrimmed(sku.brand),
    pickFirstTrimmed(sku.display_name, sku.displayName, sku.name, sku.title),
    pickFirstTrimmed(sku.product_type, sku.productType, sku.category, sku.category_name, sku.categoryName, sku.type),
    pickFirstTrimmed(candidate.category, candidate.category_name, candidate.categoryName, candidate.product_type, candidate.productType),
    ...(Array.isArray(candidate.search_aliases) ? candidate.search_aliases : []),
    ...(Array.isArray(candidate.category_path) ? candidate.category_path : []),
  ]
    .map((item) => normalizeConcernQueryToken(item).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function normalizeRecoTargetStep(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return '';
  if (token.includes('sunscreen') || token.includes('spf') || token.includes('sun')) return 'sunscreen';
  if (token.includes('moistur') || token.includes('cream') || token.includes('lotion') || token.includes('gel cream')) return 'moisturizer';
  if (token.includes('mask')) return 'mask';
  if (token.includes('serum')) return 'serum';
  if (token.includes('treatment') || token.includes('retinol') || token.includes('acid')) return 'treatment';
  if (token.includes('cleanser') || token.includes('wash')) return 'cleanser';
  return token;
}

function buildConcernCandidateText(row) {
  const candidate = isPlainObject(row) ? row : {};
  if (isConcernExternalSeedCandidate(candidate)) {
    const sku = isPlainObject(candidate.sku) ? candidate.sku : {};
    return [
      buildExternalSeedSurfacingText(candidate, { anchorOnly: true }),
      pickFirstTrimmed(
        sku.product_type,
        sku.productType,
        sku.category,
        sku.category_name,
        sku.categoryName,
        candidate.product_type,
        candidate.productType,
        candidate.category,
        candidate.category_name,
        candidate.categoryName,
      ),
      pickFirstTrimmed(candidate.retrieval_step, candidate.retrievalStep),
    ]
      .map((item) => normalizeConcernQueryToken(item).toLowerCase())
      .filter(Boolean)
      .join(' ');
  }
  const sku = isPlainObject(candidate.sku) ? candidate.sku : {};
  const textParts = [
    buildConcernCandidateAnchorText(candidate),
    ...(Array.isArray(sku.ingredient_tokens) ? sku.ingredient_tokens : []),
    ...(Array.isArray(candidate.ingredient_tokens) ? candidate.ingredient_tokens : []),
    ...(Array.isArray(sku.skin_type_tags) ? sku.skin_type_tags : []),
    ...(Array.isArray(candidate.skin_type_tags) ? candidate.skin_type_tags : []),
    pickFirstTrimmed(sku.short_description, sku.shortDescription, sku.description),
    pickFirstTrimmed(candidate.short_description, candidate.shortDescription, candidate.description),
    ...(Array.isArray(candidate.benefit_tags) ? candidate.benefit_tags : []),
    ...(Array.isArray(candidate.benefit_tokens) ? candidate.benefit_tokens : []),
    ...(Array.isArray(candidate.description_tokens) ? candidate.description_tokens : []),
    ...(Array.isArray(candidate.tags) ? candidate.tags : []),
    ...(Array.isArray(candidate.tag_tokens) ? candidate.tag_tokens : []),
  ];
  return textParts
    .map((item) => normalizeConcernQueryToken(item).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function buildConcernFrameworkCandidateText(row) {
  const candidate = isPlainObject(row) ? row : {};
  return [
    isConcernExternalSeedCandidate(candidate)
      ? buildExternalSeedSurfacingText(candidate, { anchorOnly: true })
      : buildConcernCandidateAnchorText(candidate),
  ]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function classifyConcernScopeCandidate(row) {
  const base = recoHybridInternal.classifySkincareCandidate(row);
  const classification = String(base?.classification || 'ambiguous').trim() || 'ambiguous';
  return {
    classification,
    hard_reject: base?.hard_reject === true || classification === 'explicit_non_skincare',
    penalty: Number.isFinite(Number(base?.penalty)) ? Number(base.penalty) : 0,
    reason: String(base?.reason || classification).trim() || classification,
  };
}

function hasConcernSunscreenSignal(row, candidateText = '') {
  const sku = isPlainObject(row?.sku) ? row.sku : {};
  const text = uniqCaseInsensitiveStrings([
    String(candidateText || '').trim(),
    buildConcernFrameworkCandidateText(row),
    buildConcernCandidateText(row),
    pickFirstTrimmed(
      row?.display_name,
      row?.displayName,
      row?.name,
      row?.title,
      row?.category,
      row?.product_type,
      sku?.category,
      sku?.product_type,
      row?.short_description,
      row?.shortDescription,
      row?.description,
      sku?.short_description,
      sku?.shortDescription,
      sku?.description,
    ),
  ], 4).join(' ');
  return CONCERN_SUNSCREEN_SIGNAL_RE.test(String(text || '').trim().toLowerCase());
}

function isConcernFrameworkOutOfScopeArea(row, candidateText) {
  const text = String(candidateText || '').trim().toLowerCase();
  if (!text || !FACIAL_FRAMEWORK_SCOPE_BLOCK_RE.test(text)) return false;
  if (FACIAL_FRAMEWORK_SCOPE_ALLOW_RE.test(text)) return false;
  const explicitStep = normalizeRecoTargetStep(
    pickFirstTrimmed(
      row?.sku?.product_type,
      row?.sku?.productType,
      row?.sku?.category,
      row?.sku?.category_name,
      row?.sku?.categoryName,
      row?.product_type,
      row?.productType,
      row?.category,
      row?.category_name,
      row?.categoryName,
      row?.step,
      row?.type,
    ),
  );
  return explicitStep !== 'sunscreen';
}

module.exports = {
  buildConcernCandidateText,
  buildConcernFrameworkCandidateText,
  classifyConcernScopeCandidate,
  hasConcernSunscreenSignal,
  isConcernFrameworkOutOfScopeArea,
};

const SANITIZER_VERSION = 'v3';

// Hard-coded claim policies (MVP)
const BANNED_CLAIM_TERMS = [
  'clinically proven',
  'guaranteed',
  'always in stock',
  'best price',
  'best',
  'cures',
  'medical grade',
  'safe for kids',
  'ignore previous instructions',
  'waterproof',
  'water-resistant',
];
const PROMO_TERMS = ['free shipping', '50% off', 'discount', 'promo'];
const { pickVariantSafe } = require('./styleAllowlist');
const { toTitleCaseToken } = require('./textUtils');

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

function stripUrls(str) {
  return str.replace(/https?:\/\/\S+/gi, '');
}

function normalizeWhitespace(str) {
  return str.replace(/\s+/g, ' ').trim();
}

function removeZeroWidth(str) {
  return str.replace(/[\u200B-\u200D\uFEFF]/g, '');
}

const TRAILING_PUNCT_RE = /[\s\-—–:|]+$/g;
function composeSafeDisplayName(parts) {
  const clean = (s) =>
    normalizeWhitespace((s || '').replace(/[{}]/g, '').replace(TRAILING_PUNCT_RE, '').trim());
  const brand = clean(parts.brand_safe);
  const category = clean(parts.category_safe);
  const variant = clean(parts.variant_safe);
  const variantTitle = variant ? toTitleCaseToken(variant) : '';
  const ordered = [brand, variantTitle, category].filter(Boolean);
  // basic dedupe
  const dedup = [];
  for (const p of ordered) {
    if (!p) continue;
    if (!dedup.length || dedup[dedup.length - 1].toLowerCase() !== p.toLowerCase()) dedup.push(p);
  }
  return normalizeWhitespace(dedup.join(' ')).trim();
}

function sanitizeDisplayName(rawTitle, product) {
  const brand = product.brand?.brand_name || '';
  const category = product.category?.path?.slice(-1)[0] || product.category?.category_id || '';

  const noHtml = stripHtml(rawTitle || '');
  const noUrls = stripUrls(noHtml);

  let cleaned = noUrls;
  [...BANNED_CLAIM_TERMS, ...PROMO_TERMS].forEach((term) => {
    const re = new RegExp(term, 'ig');
    cleaned = cleaned.replace(re, '');
  });
  cleaned = cleaned.replace(/!!+/g, '!');
  cleaned = removeZeroWidth(cleaned);
  cleaned = normalizeWhitespace(cleaned);

  // Optional variant from style tags with allowlist/banlist
  const variant = pickVariantSafe(product.attributes?.style_tags || []);

  const parts = {
    brand_safe: normalizeWhitespace(brand || ''),
    model_safe: '', // keep for potential debug, but exclude from default compose
    category_safe: normalizeWhitespace(category || ''),
    variant_safe: normalizeWhitespace(variant || ''),
  };

  const safe_display_name = composeSafeDisplayName(parts);

  return { parts, safe_display_name };
}

function sanitizeFeatures(product) {
  const safeFeatures = [];
  const features = product.attributes?.style_tags || [];
  features.forEach((f) => {
    if (!f) return;
    let txt = String(f);
    txt = stripUrls(stripHtml(txt));
    txt = removeZeroWidth(txt);
    txt = normalizeWhitespace(txt);
    if (!txt) return;
    const banned = BANNED_CLAIM_TERMS.some((term) => txt.toLowerCase().includes(term));
    if (banned) return;
    safeFeatures.push(txt);
  });
  return safeFeatures.slice(0, 5);
}

function hasProof(product, claimKey) {
  return Boolean(product.metadata_proofs && product.metadata_proofs[claimKey]);
}

function computeClaimFlags(product) {
  const proofs = product.metadata_proofs || {};
  const coverage = Object.keys(proofs).length > 0 ? Object.values(proofs).filter(Boolean).length / Object.keys(proofs).length : 0;
  return { proofs, coverage };
}

function sanitizeProduct(product) {
  const { parts, safe_display_name } = sanitizeDisplayName(product.title || '', product);
  const safe_features = sanitizeFeatures(product);
  const claimFlags = computeClaimFlags(product);
  return {
    safe_display_name,
    safe_name_parts: parts,
    safe_features,
    sanitizer_version: SANITIZER_VERSION,
    proof_coverage: claimFlags.coverage,
  };
}

module.exports = {
  SANITIZER_VERSION,
  BANNED_CLAIM_TERMS,
  PROMO_TERMS,
  sanitizeProduct,
};

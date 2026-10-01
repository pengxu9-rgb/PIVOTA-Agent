'use strict';

// Pair evidence shared by retrieval, inference and serving. Product-line ids are
// deliberately not variant ids: an emulsion and an eye cream can share a line.
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function title(snapshot = {}) { return text(snapshot.title || snapshot.name || snapshot.display_name || snapshot.product_name); }
function brand(snapshot = {}) {
  const raw = snapshot.brand || snapshot.brand_name || snapshot.vendor || snapshot.brand_id;
  return text(typeof raw === 'object' ? raw.name : raw).toLowerCase();
}
function normalizedTitle(snapshot = {}) {
  return title(snapshot).normalize('NFKC').toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ').trim();
}
function variantCore(snapshot = {}) {
  // Compare explicit option heads only; the caller separately preserves full-title
  // roles and formula markers. Ordinary words in each head remain significant.
  return normalizedTitle(snapshot)
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|ml|oz|grams?|g|litres?|liters?)\b/g, ' ')
    .replace(/\s*#[^#]*$/, '')
    .split(/\s+-\s*|\s*[,|]\s*/)[0]
    .replace(/\s+/g, ' ').trim();
}
const COSMETIC_ROLES = [
  ['bb_cream', /\bbb\s*cream\b/], ['cc_cream', /\bcc\s*cream\b/],
  ['mascara', /\bmascara\b/],
  ['foundation', /\b(?:powder\s*)?foundation\b/], ['concealer', /\bconcealer\b/],
  ['blush', /\b(?:cream\s*)?blush(?:er)?(?:\s*powder)?\b/], ['bronzer', /\bbronzer\b/],
  ['contour', /\bcontour(?:\s*powder)?\b/], ['lipstick', /\blipstick\b/],
  ['lip_gloss', /\blip\s*gloss\b/], ['lip_balm', /\blip\s*balm\b/],
  ['perfume', /\b(?:perfume|eau de parfum|eau de toilette)\b/],
  // Powder is a form, not a shared job: specific complexion jobs take priority.
  ['setting_powder', /\b(?:setting|finishing)\s*powder\b/],
  ['powder', /\b(?:face\s*)?powder\b/],
];
function optionRole(snapshot = {}) {
  const value = normalizedTitle(snapshot);
  const category = text(snapshot.category || snapshot.product_type).toLowerCase().replace(/[_-]+/g, ' ');
  // Product words can occur after punctuation; those tails are roles, not options.
  if (/\b(?:eyelashes|false lashes?|cluster lashes?|lash clusters|lash extensions)\b/.test(value)) return 'lashes';
  if (/\b(?:press[ -]?on nails|fake.*nails)\b/.test(value)) return 'nails';
  if (/\blash(?:es)?\b/.test(value) && /\b(?:glue|adhesive)\b/.test(value) && /\bremover\b/.test(value)) return 'lash_glue_remover';
  if (/\beye\b/.test(value) && /\b(?:cream|moisturi[sz]er)\b/.test(value)) return 'eye_cream';
  if (/\blip\b/.test(value) && /\b(?:sleeping )?mask\b/.test(value)) return 'lip_mask';
  // Specific cosmetic roles precede generic cream/serum words. An explicit leaf
  // category also identifies colour products whose titles omit the form noun.
  // Distinct jobs must remain distinct even under a shared collection head. The
  // supplied title wins over category fallback when both identify a product role.
  for (const source of [value, category]) {
    const matched = COSMETIC_ROLES.find(([, pattern]) => pattern.test(source));
    if (matched) return matched[0];
  }
  // 'Fragrance free' in a cream title is a formula trait, never a perfume job.
  if (/\bfragrance\b/.test(category)) return 'perfume';
  if (/\bmoisturi[sz]er\b/.test(value)) return 'cream';
  for (const role of ['emulsion', 'ampoule', 'essence', 'toner', 'cleanser', 'serum', 'cream', 'shampoo', 'conditioner']) {
    if (new RegExp(`\\b${role}\\b`).test(value)) return role;
  }
  return '';
}
function formulaMarkers(snapshot = {}) {
  const value = normalizedTitle(snapshot);
  const markers = value.match(/\b\d+(?:\.\d+)?\s*%|\bspf\s*\d+|\b(?:intense|waterproof|washable|tubing|retinol|retinal|aha|bha|fragrance[ -]?free|oil[ -]?free)\b/g) || [];
  // Finish is meaningful for complexion/lip products. A lash collection's named
  // 'Glow Up' style remains an option, not a different cosmetic formulation.
  if (['powder', 'setting_powder', 'foundation', 'blush', 'bronzer', 'contour', 'lipstick', 'lip_gloss'].includes(optionRole(snapshot))) {
    markers.push(...(value.match(/\b(?:matte|glow|dewy|satin|shimmer|luminous)\b/g) || []));
  }
  return markers.sort().join('|');
}
function hasExplicitVariant(snapshot = {}) {
  if (/#/.test(normalizedTitle(snapshot))) return true;
  const role = optionRole(snapshot);
  // In these product roles a named shade, lash/nail style or lip-mask flavour is
  // an option. Other separator tails need structured option evidence.
  if (['lashes', 'nails', 'lip_mask', ...COSMETIC_ROLES.map(([name]) => name)].includes(role)) return /\s+-\s*|[,|]/.test(normalizedTitle(snapshot));
  return /^(?:shade|colou?r|style|scent|flavou?r)\s*:/i.test(text(snapshot.variant_title || snapshot.variant_detail_label));
}
function isSameFamilyVariant(anchor = {}, candidate = {}) {
  const aBrand = brand(anchor);
  if (!aBrand || aBrand !== brand(candidate)) return false;
  const aTitle = normalizedTitle(anchor);
  const bTitle = normalizedTitle(candidate);
  if (!aTitle || !bTitle || aTitle === bTitle) return false;
  if (optionRole(anchor) !== optionRole(candidate) || formulaMarkers(anchor) !== formulaMarkers(candidate)) return false;
  const aCore = variantCore(anchor);
  const bCore = variantCore(candidate);
  // An explicit shared variant parent is useful only with the same product core;
  // a parent/line identifier alone must never suppress routine complements.
  return Boolean(aCore && aCore === bCore && aCore.split(/\s+/).length >= 2 &&
    (hasExplicitVariant(anchor) || hasExplicitVariant(candidate)));
}
function sharedSpecificNameWords(anchor = {}, candidate = {}) {
  const stop = new Set(['the', 'and', 'for', 'with', ...brand(anchor).split(/\W+/), ...brand(candidate).split(/\W+/)]);
  const words = (snapshot) => new Set(normalizedTitle(snapshot).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !stop.has(word)));
  const a = words(anchor); const b = words(candidate);
  return [...a].filter((word) => b.has(word));
}

module.exports = { isSameFamilyVariant, variantCore, brand, title, sharedSpecificNameWords, optionRole };

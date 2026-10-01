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
const COSMETIC_ROLES = [
  ['bb_cream', /\bbb\s*cream\b/], ['cc_cream', /\bcc\s*cream\b/],
  ['mascara', /\bmascara\b/], ['eyeliner', /\beye\s*liner\b/], ['eyeshadow', /\beye\s*shadow\b/],
  ['highlighter', /\bhighlighter\b/], ['primer', /\bprimer\b/], ['brow', /\b(?:brow|eyebrow)\s*(?:pencil|gel|pomade|powder)\b/],
  ['foundation', /\b(?:powder\s*)?foundation\b/], ['concealer', /\bconcealer\b/],
  ['blush', /\b(?:cream\s*)?blush(?:er)?(?:\s*powder)?\b/], ['bronzer', /\bbronzer\b/],
  ['contour', /\bcontour(?:\s*powder)?\b/], ['lipstick', /\blipstick\b/],
  ['lip_gloss', /\blip\s*gloss\b/], ['lip_balm', /\blip\s*balm\b/],
  ['lip_tint', /\blip\s*(?:tint|stain)\b/], ['lip_oil', /\blip\s*oil\b/], ['lip_liner', /\blip\s*liner\b/],
  ['perfume', /\b(?:perfume|eau de parfum|eau de toilette)\b/],
  // Powder is a form, not a shared job: specific complexion jobs take priority.
  ['setting_powder', /\b(?:setting|finishing)\s*powder\b/],
  ['powder', /\b(?:face\s*)?powder\b/],
];
function optionRole(snapshot = {}) {
  const value = normalizedTitle(snapshot);
  const category = text(snapshot.category || snapshot.product_type).toLowerCase().replace(/[_-]+/g, ' ');
  // Application tools can name the cosmetic they apply. The actual tool job
  // precedes that target noun, while keeping foundation/blush/eye tools distinct.
  for (const source of [value, category]) {
    const tool = source.match(/\b(brush(?:es)?|sponge(?:s)?|applicator(?:s)?|puffs?|curlers?|tweezers?)\b/);
    if (!tool) continue;
    const kind = ['brush','sponge','applicator','puff','curler','tweezer'].find((name) => tool[1].startsWith(name));
    const cosmeticTarget = COSMETIC_ROLES.find(([, pattern]) => pattern.test(value)) ||
      COSMETIC_ROLES.find(([, pattern]) => pattern.test(category));
    const areaTarget = value.match(/\b(eye|lip|face|body|brow|lash)\b/) || category.match(/\b(eye|lip|face|body|brow|lash)\b/);
    const target = cosmeticTarget?.[0] || areaTarget?.[1];
    return target ? `${target}_${kind}` : kind;
  }
  // Product words can occur after punctuation; those tails are roles, not options.
  if (/\b(?:eyelashes|false lashes?|cluster lashes?|lash clusters|lash extensions)\b/.test(value)) return 'lashes';
  if (/\b(?:press[ -]?on nails|fake.*nails)\b/.test(value)) return 'nails';
  if (/\blash(?:es)?\b/.test(value) && /\b(?:glue|adhesive)\b/.test(value) && /\bremover\b/.test(value)) return 'lash_glue_remover';
  // Cleansing is a routine job, while cream is a form: a cleansing cream is not
  // the same step as a moisturizer merely because both names contain 'cream'.
  if (/\b(?:cleanser|cleansing|face wash|makeup remover)\b/.test(value) || /\b(?:cleanser|cleansing|face wash)\b/.test(category)) return 'cleanser';
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
  if (/\bmoisturi[sz]er\b/.test(value) || /\bmoisturi[sz]er\b/.test(category)) return 'cream';
  for (const role of ['emulsion', 'ampoule', 'essence', 'toner', 'cleanser', 'serum', 'cream', 'shampoo', 'conditioner']) {
    if (new RegExp(`\\b${role}\\b`).test(value)) return role;
  }
  return '';
}
const FORM_OR_FORMULA = /\b(?:liquid|powder|cream|gel|balm|stick|mousse|cushion|pencil|pen|oil|mist|spray|solid|loose|pressed|hydrating|long[ -]?wear|radiant|radiance|intense|waterproof|washable|tubing|retinol|retinal|aha|bha|fragrance[ -]?free|oil[ -]?free)\b|\b\d+(?:\.\d+)?\s*%|\bspf\s*\d+/;
function variantCore(snapshot = {}) {
  const value = normalizedTitle(snapshot)
    .replace(/\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|ml|oz|grams?|g|litres?|liters?)\b/g, ' ')
    .replace(/\s*#[^#]*$/, '').replace(/\s+/g, ' ').trim();
  const parts = value.split(/\s+-\s*|\s*[,|]\s*/);
  const role = optionRole(snapshot);
  const productPart = (part) => {
    const partRole = optionRole({title:part});
    // Decorative lash/nail option names can also be cosmetic shade nouns such
    // as 'Blush'. Only their actual product job makes such a segment substantive.
    if (['lashes','nails'].includes(role)) return partRole === role;
    return Boolean(partRole) || FORM_OR_FORMULA.test(part);
  };
  // A generic collection head is not a product identity. Retain substantive
  // tails rather than treating different products/formulas as collection options.
  // In lash/nail listings, descriptive option segments can surround the shared
  // product noun, so compare the head plus all product-bearing segments.
  const productParts = parts.slice(1).filter(productPart);
  if (!productPart(parts[0]) && !productParts.length && /[,|]/.test(value) &&
      !/^(?:shade|colou?r|style|scent|flavou?r)\s*:/i.test(text(snapshot.variant_title || snapshot.variant_detail_label))) return value;
  return [parts[0], ...productParts].join(' | ').replace(/\s+/g, ' ').trim();
}
function attachmentMarkers(snapshot = {}) {
  if (!['lashes','nails'].includes(optionRole(snapshot))) return [];
  const value = normalizedTitle(snapshot);
  const modes = [];
  if (/\bmagnetic\b/.test(value)) modes.push('attachment:magnetic');
  const selfAdhesive = /\b(?:no[ -]?glue|glue[ -]?free|self[ -]?adhesive|pre[ -]?glued|pre[ -]?applied adhesive|adhesive tabs|stick[ -]?on)\b/.test(value);
  if (selfAdhesive) modes.push('attachment:self_adhesive');
  if (/\b(?:glue[ -]?(?:on|required)|requires? (?:nail |lash )?glue|with (?:nail |lash )?glue)\b/.test(value)) modes.push('attachment:glue_required');
  if (!selfAdhesive && /\badhesive\b/.test(value)) modes.push('attachment:adhesive_unspecified');
  return modes;
}
function formulaMarkers(snapshot = {}) {
  const value = normalizedTitle(snapshot);
  const markers = value.match(/\b\d+(?:\.\d+)?\s*%|\bspf\s*\d+|\b(?:intense|waterproof|washable|tubing|retinol|retinal|aha|bha|fragrance[ -]?free|oil[ -]?free)\b/g) || [];
  // Attachment is a shopper constraint, independently of decorative style names.
  markers.push(...attachmentMarkers(snapshot));
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
  const aRole = optionRole(anchor); const bRole = optionRole(candidate);
  // An option marker or shared line cannot establish variant identity when the
  // actual product jobs are unresolved. Unknown/unknown is not a matching job.
  if (!aRole || !bRole || aRole !== bRole || formulaMarkers(anchor) !== formulaMarkers(candidate)) return false;
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

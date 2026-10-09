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
  return title(snapshot).normalize('NFKC')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase()
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
  if (/\b(?:eyelashes|false[ -]?lashes?|(?:strip|individual|cluster)[ -]?lashes?|lash[ -]?(?:clusters|extensions))\b/.test(value)) return 'lashes';
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
// Product identity (same product / same-family variant) has ONE owner:
// relationshipProductIdentity.compareProductIdentity. These names stay as thin
// wrappers for existing importers; the module is required lazily because it
// builds on the role vocabulary above.
function identity() { return require('./relationshipProductIdentity'); }
function isSameFamilyVariant(anchor = {}, candidate = {}) {
  return identity().compareProductIdentity(anchor, candidate).relation === 'same_family_variant';
}
function variantCore(snapshot = {}) { return identity().variantCore(snapshot); }
function decorativeStructure(snapshot = {}) { return identity().decorativeStructure(snapshot); }
function sharedSpecificNameWords(anchor = {}, candidate = {}) {
  const stop = new Set(['the', 'and', 'for', 'with', ...brand(anchor).split(/\W+/), ...brand(candidate).split(/\W+/)]);
  const words = (snapshot) => new Set(normalizedTitle(snapshot).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !stop.has(word)));
  const a = words(anchor); const b = words(candidate);
  return [...a].filter((word) => b.has(word));
}

module.exports = { isSameFamilyVariant, variantCore, brand, title, normalizedTitle, COSMETIC_ROLES, sharedSpecificNameWords, optionRole, decorativeStructure };

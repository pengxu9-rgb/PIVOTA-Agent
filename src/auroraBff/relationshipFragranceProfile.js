'use strict';

// Fragrance alternatives need a shared scent, not a shared category.
//
// Prod 2026-10-10, review dry run over 200 uncovered-anchor alternative pairs: 6 of 72 approvals
// were "any perfume -> a Tom Ford perfume" (Upcircle sample vials -> Black Orchid, Byra Deep Calm ->
// Oud Wood, Eau d'Ombre Leather -> Cosmic Kylie Jenner). Every other alternative family is a same-
// job swap; a perfume is chosen by its scent, so "both are eau de parfum" is not a substitute.
// product_beauty_attributes.scent_family is empty on all 1,454 live fragrance rows and snapshots carry
// no notes, so the only scent evidence is product text: 584 of those 1,454 descriptions name notes.
//
// This module owns three questions: is a product a fragrance, which scent families does a piece of
// text name, and does a quoted scent fact really come from a product's scent-bearing text. The
// reviewer's validator applies them to the model's shared_evidence, so a fragrance approval must
// quote notes from BOTH products, from their own text, that fall in a common family.
//
// Known limit: a note word in a perfume NAME counts ('Rose 31', 'Oud Wood', 'Black Orchid' -> floral
// although that scent is chocolate/patchouli). Two names sharing a note family can pass on titles.

function text(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Is it a fragrance? -------------------------------------------------------------------------
// Strong forms name a perfume outright; weak forms (a mist) are also skincare and haircare products
// (SPF body mist, heat-protectant hair mist), so they count only without a skin/hair function word.
const FRAGRANCE_FREE = /\b(?:fragrance|perfume)[ -]free\b|\bunscented\b/;
const STRONG_FORM = /\b(?:eau de (?:parfum|toilette|cologne)|edp|edt|parfum|perfumes?|colognes?|extrait)\b/;
const WEAK_FORM = /\b(?:body|hair|fragrance|perfume) mists?\b/;
const MIST_FUNCTION = /\b(?:spf|sunscreen|sun|uv|protectant|protection|heat|setting|primer|toner|serum|hydrat\w*|moisturi\w*|detangl\w*|leave[ -]in|deodori\w*|antiperspirant|antioxidant|frizz|shine|volum\w*|texturi\w*)\b/;
// A 'fragrance' category is a SHELF: prod files Tom Ford Oud Wood Conditioning Beard Oil, Hand and Body
// Moisturizer, Shimmering Body Oil and candles under it (relationshipPairPolicy.optionRole reads them
// all as 'perfume'). A title naming another product form is that form, even next to 'eau de parfum'
// ('Eau de Parfum Hand Cream'), except the perfume forms that are themselves oils or balms.
const NON_PERFUME_FORM = /\b(?:oils?|moisturi[sz]ers?|lotions?|creams?|balms?|butters?|milks?|candles?|washe?s?|gels?|soaps?|shampoos?|conditioners?|conditioning|deodorants?|scrubs?|powders?|lips?|serums?|cleansers?|diffusers?|sachets?|masks?|polish|sanitiz\w*|foams?|bath|bombs?|room sprays?|home sprays?|incense|after ?shave|shower)\b/;
const PERFUME_OIL_OR_BALM = /\b(?:perfume|parfum|fragrance) (?:oils?|balms?)\b|\b(?:oil|balm) (?:perfume|parfum)\b|\bsolid perfume\b|\bextrait (?:de parfum )?oil\b/;

function isFragranceProduct(snapshot = {}) {
  // Both names: the evidence shows the model `name || title`, so classify on what either says.
  const title = `${text(snapshot.title)} ${text(snapshot.name)} ${text(snapshot.display_name)}`.trim();
  const category = text(snapshot.category || snapshot.product_type).replace(/[_/-]+/g, ' ');
  if (FRAGRANCE_FREE.test(title) || FRAGRANCE_FREE.test(category)) return false;
  if (NON_PERFUME_FORM.test(title) && !PERFUME_OIL_OR_BALM.test(title)) return false;
  if (STRONG_FORM.test(title) || PERFUME_OIL_OR_BALM.test(title)) return true;
  if (WEAK_FORM.test(title)) return !MIST_FUNCTION.test(title);
  return /\b(?:fragrance|fragrances|perfume|perfumes|parfum)\b/.test(category);
}

// --- Which scent families does a text name? -----------------------------------------------------
// Note -> family. Words that are generic outside perfume ('fresh', 'green', 'salt', 'clean') are left
// out: a quote must name an actual note or accord. French spellings perfumers print are included.
const SCENT_FAMILIES = Object.freeze({
  citrus: ['bergamot', 'lemon', 'grapefruit', 'mandarin', 'tangerine', 'citrus', 'yuzu', 'lime', 'petitgrain', 'neroli', 'néroli', 'orange zest', 'blood orange', 'sweet orange', 'bigarade'],
  floral: ['rose', 'jasmine', 'jasmin', 'tuberose', 'peony', 'iris', 'orris', 'violet', 'lily', 'lilies', 'lily of the valley', 'muguet', 'magnolia', 'orange blossom', 'gardenia', 'ylang', 'ylang ylang', 'floral', 'mimosa', 'freesia', 'lotus', 'heliotrope', 'osmanthus', 'orchid', 'frangipani', 'honeysuckle', 'neroli', 'néroli', 'lilac', 'geranium', 'carnation', 'fleur'],
  woody: ['oud', 'agarwood', 'sandalwood', 'santal', 'cedar', 'cedarwood', 'vetiver', 'patchouli', 'guaiac', 'woody', 'wood', 'cashmeran', 'cashmere wood', 'birch', 'cypress', 'oakmoss', 'moss', 'bois'],
  amber: ['amber', 'ambre', 'ambery', 'benzoin', 'labdanum', 'incense', 'oriental', 'resin', 'resinous', 'myrrh', 'frankincense', 'olibanum', 'opoponax'],
  gourmand: ['vanilla', 'vanille', 'caramel', 'praline', 'chocolate', 'cacao', 'cocoa', 'tonka', 'coffee', 'honey', 'gourmand', 'almond', 'marshmallow', 'toffee'],
  aquatic: ['aquatic', 'marine', 'ocean', 'sea salt', 'ozonic', 'watery', 'sea breeze'],
  green: ['fig', 'fig leaf', 'green tea', 'black tea', 'galbanum', 'basil', 'mint', 'cut grass', 'tomato leaf'],
  spicy: ['pepper', 'peppercorn', 'pink pepper', 'black pepper', 'cardamom', 'cinnamon', 'saffron', 'clove', 'ginger', 'nutmeg', 'spicy'],
  fruity: ['peach', 'pear', 'apple', 'berry', 'berries', 'cherry', 'cherries', 'plum', 'blackcurrant', 'cassis', 'fruity', 'lychee', 'mango', 'raspberry', 'strawberry', 'apricot', 'pineapple', 'coconut'],
  musk: ['musk', 'musc', 'musky', 'ambrette', 'white musk'],
  leather: ['leather', 'cuir', 'suede', 'tobacco', 'tabac'],
  aromatic: ['lavender', 'lavande', 'sage', 'clary sage', 'rosemary', 'aromatic', 'fougere', 'fougère', 'thyme'],
});

// Letters include accented ones so 'néroli' / 'fougère' are whole words and 'Cloud' never holds 'oud'.
const LETTER = 'a-z\\u00c0-\\u024f';
const FAMILY_PATTERNS = Object.entries(SCENT_FAMILIES).map(([family, notes]) => [
  family,
  new RegExp(`(?:^|[^${LETTER}])(?:${notes.map((note) => escapeRegExp(note).replace(/ /g, '[ -]')).join('|')})(?:e?s)?(?![${LETTER}])`),
]);
// The two shelf taxonomy tags prod uses are merchandising buckets, not notes (prod tags Tom Ford Oud
// Wood Eau de Parfum 'floral'). Only those exact tags are removed; 'a jasmine fragrance profile' stays.
const SHELF_PROFILE_TAG = /\b(?:floral|warm)[ _]fragrance[ _]profiles?\b/g;

function scentFamilies(value) {
  const haystack = text(value).replace(SHELF_PROFILE_TAG, ' ');
  const families = new Set();
  if (!haystack.trim()) return families;
  for (const [family, pattern] of FAMILY_PATTERNS) {
    if (pattern.test(haystack)) families.add(family);
  }
  return families;
}

// --- Is a quoted scent fact the product's own scent text? -----------------------------------------
// The reviewer's general grounding accepts any substring of any supplied fact, including taxonomy and
// tags ('floral' out of 'floral fragrance profiles') and a brand ('Rose' out of 'Henry Rose'). A scent
// quote must instead be a WHOLE-WORD span of the product's scent-bearing text: its name (brand
// removed), description, intel highlights, catalog / seed title and description, or a scent_family.
function scentTexts(product = {}) {
  const brand = text(product.brand).trim();
  const withoutBrand = (value) => {
    const s = text(value);
    return brand ? s.split(brand).join(' ') : s;
  };
  const catalog = product.catalog || {};
  const seed = product.external_seed || {};
  const attrs = product.beauty_attrs || {};
  const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
  return [
    withoutBrand(product.title), withoutBrand(product.name), withoutBrand(catalog.title), withoutBrand(seed.title),
    text(product.description), text(seed.description), text(catalog.description),
    ...list(product.why_it_stands_out).map(text), ...list(product.best_for).map(text),
    text(attrs.scent_family),
  ].filter((value) => value.trim());
}

function quotedFromScentText(product, quote) {
  const needle = text(quote).replace(/\s+/g, ' ').trim();
  if (!needle) return false;
  const pattern = new RegExp(`(?:^|[^${LETTER}0-9])${escapeRegExp(needle).replace(/ /g, '\\s+')}(?![${LETTER}0-9])`);
  return scentTexts(product).some((value) => pattern.test(value));
}

// The verdict for one claimed alternative between two products, given the reviewer's quoted pairs.
// `facts` are the product objects the model was shown (the reviewer's evidence); the snapshots are
// used when no evidence is supplied.
//   null                                  -> not a fragrance question; other rules decide
//   'fragrance_category_mismatch'         -> one side is a fragrance, the other is not
//   'fragrance_scent_profile_unmatched'   -> no quoted pair, from both products' own scent text,
//                                            names a common scent family
function fragranceAlternativeRejection(anchor = {}, candidate = {}, quotes = [], facts = {}) {
  const anchorFragrance = isFragranceProduct(anchor);
  const candidateFragrance = isFragranceProduct(candidate);
  if (!anchorFragrance && !candidateFragrance) return null;
  if (anchorFragrance !== candidateFragrance) return 'fragrance_category_mismatch';
  const anchorFacts = facts.anchor || anchor;
  const candidateFacts = facts.candidate || candidate;
  const matched = (Array.isArray(quotes) ? quotes : []).some((quote) => {
    if (!quotedFromScentText(anchorFacts, quote && quote.anchor_fact)) return false;
    if (!quotedFromScentText(candidateFacts, quote && quote.candidate_fact)) return false;
    const anchorFamilies = scentFamilies(quote.anchor_fact);
    return [...scentFamilies(quote.candidate_fact)].some((family) => anchorFamilies.has(family));
  });
  return matched ? null : 'fragrance_scent_profile_unmatched';
}

module.exports = {
  isFragranceProduct,
  scentFamilies,
  quotedFromScentText,
  fragranceAlternativeRejection,
  SCENT_FAMILIES,
};

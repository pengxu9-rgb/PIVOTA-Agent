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
// This module owns two questions: is a product a fragrance, and which scent families does a piece
// of product text name. The reviewer's validator applies them to the model's quoted, grounded
// shared_evidence (relationship-graph review), so an approval must quote notes from BOTH products
// that fall in a common family.

function text(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase();
}

// A perfume job: eau de parfum/toilette/cologne, parfum/perfume (incl. perfume oil), extrait, body or
// hair mist. 'Fragrance free' / 'unscented' are formula traits of non-fragrance products.
const FRAGRANCE_TITLE = /\b(?:eau de (?:parfum|toilette|cologne)|edp|edt|parfum|perfumes?|perfume oil|cologne|extrait|(?:body|hair) mist|fragrance mist)\b/;
const FRAGRANCE_FREE = /\b(?:fragrance|perfume)[ -]free\b|\bunscented\b/;
// A 'fragrance' category is a SHELF: prod files Tom Ford Oud Wood Conditioning Beard Oil, Hand and Body
// Moisturizer, Shimmering Body Oil and candles under it (relationshipPairPolicy.optionRole reads them
// all as 'perfume'). On that shelf a title naming another product form is that form, not a perfume.
const NON_PERFUME_FORM = /\b(?:oils?|moisturi[sz]ers?|lotions?|creams?|balms?|candles?|washes|wash|gels?|soaps?|shampoos?|conditioners?|conditioning|deodorants?|scrubs?|powders?|lip|lips|serums?|cleansers?|diffusers?|sachets?|mask|polish)\b/;

function isFragranceProduct(snapshot = {}) {
  const title = text(snapshot.title || snapshot.name || snapshot.display_name);
  const category = text(snapshot.category || snapshot.product_type).replace(/[_-]+/g, ' ');
  if (FRAGRANCE_FREE.test(title)) return false;
  if (FRAGRANCE_TITLE.test(title)) return true;
  return /\b(?:fragrance|perfume|parfum)\b/.test(category) && !NON_PERFUME_FORM.test(title);
}

// Note -> family. Words that are generic outside perfume ('fresh', 'green', 'salt', 'clean') are left
// out: a quote must name an actual note or accord to count.
const SCENT_FAMILIES = Object.freeze({
  citrus: ['bergamot', 'lemon', 'grapefruit', 'mandarin', 'tangerine', 'citrus', 'yuzu', 'lime', 'petitgrain', 'neroli', 'orange zest', 'blood orange', 'sweet orange'],
  floral: ['rose', 'roses', 'jasmine', 'tuberose', 'peony', 'iris', 'orris', 'violet', 'lily', 'magnolia', 'orange blossom', 'gardenia', 'ylang', 'ylang-ylang', 'floral', 'mimosa', 'freesia', 'lotus', 'heliotrope', 'osmanthus', 'orchid', 'frangipani', 'honeysuckle', 'neroli', 'lilac', 'geranium', 'carnation'],
  woody: ['oud', 'agarwood', 'sandalwood', 'cedar', 'cedarwood', 'vetiver', 'patchouli', 'guaiac', 'woody', 'cashmeran', 'cashmere wood', 'birch', 'cypress', 'oakmoss', 'moss'],
  amber: ['amber', 'ambery', 'benzoin', 'labdanum', 'incense', 'oriental', 'resin', 'resins', 'resinous', 'myrrh', 'frankincense', 'olibanum', 'opoponax'],
  gourmand: ['vanilla', 'caramel', 'praline', 'chocolate', 'cacao', 'cocoa', 'tonka', 'coffee', 'honey', 'gourmand', 'almond', 'marshmallow', 'toffee'],
  aquatic: ['aquatic', 'marine', 'ocean', 'sea salt', 'ozonic', 'watery', 'sea breeze'],
  green: ['fig', 'fig leaf', 'green tea', 'black tea', 'galbanum', 'basil', 'mint', 'cut grass', 'tomato leaf'],
  spicy: ['pepper', 'peppercorn', 'pink pepper', 'black pepper', 'cardamom', 'cinnamon', 'saffron', 'clove', 'ginger', 'nutmeg', 'spicy'],
  fruity: ['peach', 'pear', 'apple', 'berry', 'berries', 'cherry', 'plum', 'blackcurrant', 'cassis', 'fruity', 'lychee', 'mango', 'raspberry', 'strawberry', 'apricot', 'pineapple', 'coconut', 'fig fruit'],
  musk: ['musk', 'musky', 'ambrette', 'white musk'],
  leather: ['leather', 'suede', 'tobacco'],
  aromatic: ['lavender', 'sage', 'clary sage', 'rosemary', 'aromatic', 'fougere', 'fougère', 'thyme'],
});

const FAMILY_PATTERNS = Object.entries(SCENT_FAMILIES).map(([family, notes]) => [
  family,
  new RegExp(`(?:^|[^a-z])(?:${notes.map((note) => note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]')).join('|')})(?![a-z])`),
]);

// Shelf taxonomy tags ('floral fragrance profiles', 'warm fragrance profiles') are merchandising
// buckets, not notes: prod tags Tom Ford Oud Wood Eau de Parfum 'floral'. A quote of one is not scent
// evidence, so the tag text is removed before matching.
const SHELF_PROFILE_TAG = /\b[a-z]+[ _]fragrance[ _]profiles?\b/g;

function scentFamilies(value) {
  const haystack = text(value).replace(SHELF_PROFILE_TAG, ' ');
  const families = new Set();
  if (!haystack) return families;
  for (const [family, pattern] of FAMILY_PATTERNS) {
    if (pattern.test(haystack)) families.add(family);
  }
  return families;
}

// The verdict for one claimed alternative between two products, given the reviewer's quoted pairs
// (each already verified as a verbatim span of that product's supplied facts).
//   null                                  -> not a fragrance question; other rules decide
//   'fragrance_category_mismatch'         -> one side is a fragrance, the other is not
//   'fragrance_scent_profile_unmatched'   -> no quoted pair names a common scent family
function fragranceAlternativeRejection(anchor = {}, candidate = {}, quotes = []) {
  const anchorFragrance = isFragranceProduct(anchor);
  const candidateFragrance = isFragranceProduct(candidate);
  if (!anchorFragrance && !candidateFragrance) return null;
  if (anchorFragrance !== candidateFragrance) return 'fragrance_category_mismatch';
  const matched = (Array.isArray(quotes) ? quotes : []).some((quote) => {
    const anchorFamilies = scentFamilies(quote && quote.anchor_fact);
    if (!anchorFamilies.size) return false;
    return [...scentFamilies(quote && quote.candidate_fact)].some((family) => anchorFamilies.has(family));
  });
  return matched ? null : 'fragrance_scent_profile_unmatched';
}

module.exports = {
  isFragranceProduct,
  scentFamilies,
  fragranceAlternativeRejection,
  SCENT_FAMILIES,
};

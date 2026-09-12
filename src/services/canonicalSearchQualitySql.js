'use strict';

const reviewedAliases = require('../../data/beauty/meitu_brand_aliases.json');
const { normalizeBrandText } = require('../findProductsMulti/brandLexicon');

// Normalize common Latin accents and middle-dot styling on both query and row identity.
// This is not a general Unicode transliterator; reviewed aliases cover alternate spellings.
// No descriptions, retailer names, or cross-sell copy may establish product identity.
function identitySql(expression) {
  return `trim(regexp_replace(lower(translate(regexp_replace(coalesce(${expression}, ''), '[·•]', '', 'g'), 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝàáâãäåèéêëìíîïòóôõöùúûüýÿ', 'AAAAAAEEEEIIIIOOOOOUUUUYaaaaaaeeeeiiiiooooouuuuyy')), '[^[:alnum:]]+', ' ', 'g'))`;
}
const identityValue = (value) => normalizeBrandText(String(value || '').replace(/[·•]/g, '')).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const FORM_RULES = [
  [/\blip\s*tints?\b/, '(lip[ ]*)?tints?'],
  [/\blip\s*oils?\b/, 'lip[ ]*oils?'],
  [/\blip\s*gloss(?:es)?\b/, 'lip[ ]*gloss(?:es)?|gloss'],
  [/\blipsticks?\b/, 'lipsticks?|lip[ ]*sticks?|liquid[ ]*lip|lip[ ]*colou?rs?|rouge'],
  [/\beyeliners?\b/, 'eye[ ]*liners?'],
  [/\bmascaras?\b/, 'mascaras?'],
  [/\bfoundations?\b/, 'foundations?'],
  [/\bbronzers?\b/, 'bronzers?'],
  [/\bblush(?:er)?\b/, 'blush(?:er)?|cheek[ ]*(tint|colou?r)'],
  [/\bcleansers?\b/, 'cleansers?|cleansing|face[ ]*wash|facial[ ]*wash'],
  [/\btoners?\b/, 'toners?'],
  [/\bshampoos?\b/, 'shampoos?'],
  [/\bconditioners?\b/, 'conditioners?'],
  [/\b(?:serums?|ampoules?|essences?)\b/, 'serums?|ampoules?|essences?|concentrate|booster'],
  [/\bmoisturi[sz]ers?\b/, 'moisturi[sz]ers?|creams?|lotions?|emulsions?|balms?|water[ ]*gel'],
  [/\bsunscreens?\b|\bsun[ ]*(?:cream|stick|milk|fluid)\b/, 'sunscreens?|sun[ ]*(screen|block|cream|stick|milk|fluid|lotion)|uv[ ]*(protector|shield)|spf'],
  [/\b(?:perfumes?|fragrances?|parfum|cologne|body[ ]*mist)\b/, 'perfumes?|fragrances?|parfum|cologne|eau[ ]*de[ ]*toilette|body[ ]*mist'],
  [/\bconcealers?\b/, 'concealers?|correctors?'],
  [/\beye[ ]*shadows?\b/, 'eye[ ]*shadows?'],
  [/\bhighlighters?\b/, 'highlighters?|luminizers?'],
];

function buildCanonicalSearchQualitySql({ contract, params, categoryPredicate, defaultWhere, defaultBrandWhere }) {
  if (contract?.target_domain !== 'beauty') return { where: defaultWhere, brandWhere: defaultBrandWhere };
  const hard = contract.hard_constraints || {};
  const bind = (value) => { params.push(value); return `$${params.length}`; };
  const ownName = identitySql("concat_ws(' ', p.title, p.product_type, p.product_payload->>'canonical_title', p.product_payload->>'canonical_name')");
  let brandWhere = defaultBrandWhere;
  if (hard.brand) {
    const terms = [...(reviewedAliases[hard.brand.brand_key] || []), hard.brand.canonical, hard.brand.alias]
      .flatMap((value) => [value, String(value || '').replace(/\b(?:beauty|cosmetics?)\b/gi, '')])
      .map(identityValue).filter(Boolean);
    const normalized = [...new Set(terms.map((term) => term.replace(/\s+/g, '')))];
    const ownBrand = identitySql("coalesce(nullif(trim(p.brand), ''), p.product_payload->>'brand', p.product_payload->>'vendor', p.product_payload#>>'{seed_data,brand}')");
    brandWhere = `AND regexp_replace(${ownBrand}, ' ', '', 'g') = ANY(${bind(normalized)}::text[])`;
  }
  let where = defaultWhere;
  if (hard.exact_product_anchor) {
    const tokens = [...new Set(identityValue(hard.exact_product_anchor).split(' ').filter((token) => token.length >= 2))];
    if (tokens.length) where = tokens.map((token) => `${ownName} ~ ${bind(`(^| )${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($| )`)}`).join(' AND ');
  } else if (contract.query_class === 'brand_browse' && hard.brand) {
    // The resolved brand IS the query. Framing words ("products", "show me")
    // must not introduce a second full-phrase text requirement.
    where = 'TRUE';
  } else if (categoryPredicate && hard.category_path_prefix) {
    const query = identityValue(contract.effective_query);
    const prefixForms = [
      ['beauty/skincare/moisturize', 'moisturi[sz]ers?|creams?|lotions?|emulsions?|balms?|water[ ]*gel'],
      ['beauty/skincare/treat', 'serums?|ampoules?|essences?|treatments?|concentrate|booster'],
      ['beauty/skincare/cleanse', 'cleansers?|cleansing|face[ ]*wash|facial[ ]*wash'],
      ['beauty/skincare/sun', 'sunscreens?|sun[ ]*(screen|block|cream|stick|milk|fluid|lotion)|uv[ ]*(protector|shield)|spf'],
      ['beauty/fragrance', 'perfumes?|fragrances?|parfum|cologne|eau[ ]*de[ ]*toilette|body[ ]*mist'],
    ];
    const form = FORM_RULES.find(([re]) => re.test(query))?.[1]
      || prefixForms.find(([prefix]) => hard.category_path_prefix.startsWith(prefix))?.[1];
    if (form) {
      const ownForm = `${ownName} ~ ${bind(`(^| )(${form})($| )`)}`;
      const prefix = String(hard.category_path_prefix).replace(/\/+$/, '');
      const parts = prefix.split('/');
      const ancestors = parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
      where = `((${categoryPredicate}) OR p.category_path = ANY(${bind(ancestors)}::text[])) AND ${ownForm}`;
    } else {
      where = categoryPredicate;
    }
  }
  const requested = identityValue(contract.effective_query);
  if (/\bmoisturi[sz]ers?\b/.test(requested) && !/\b(spf|sunscreen|sun protection)\b/.test(requested)) {
    where = `(${where}) AND NOT (${ownName} ~ ${bind('(^| )(sunscreens?|sun[ ]*(cream|screen|block|stick|milk|fluid))($| )')})`;
  }
  // A product-form word in an accessory name cannot consume the entire candidate
  // budget before the JS gate gets a chance to see the actual cosmetic. Preserve
  // explicitly requested tools and included mirrors/brushes on cosmetic products.
  const toolPattern = '(^| )(brush(es)?|applicators?|tools?|accessor(y|ies)|sponges?|puffs?|mirrors?|curlers?|sharpeners?)($| )';
  const queryRequestsTool = /\b(?:brush(?:es)?|applicators?|tools?|accessor(?:y|ies)|sponges?|puffs?|mirrors?|curlers?|sharpeners?)\b/i.test(contract.effective_query || '');
  if ((hard.category_path_prefix || hard.exact_product_anchor) && !queryRequestsTool) {
    const namedObject = `regexp_replace(${ownName}, '(with|includes?|including)[ ]+((a|an|built in)[ ]+)?(brush(es)?|applicators?|mirrors?|sponges?|puffs?)([ ]|$).*$', '', 'g')`;
    where = `(${where}) AND NOT (${namedObject} ~ ${bind(toolPattern)})`;
  }
  return { where: `(${where}) AND $2::text IS NOT NULL`, brandWhere };
}
module.exports = { buildCanonicalSearchQualitySql };

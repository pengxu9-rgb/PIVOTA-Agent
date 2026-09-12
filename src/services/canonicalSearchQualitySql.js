'use strict';

const reviewedAliases = require('../../data/beauty/meitu_brand_aliases.json');
const { normalizeBrandText } = require('../findProductsMulti/brandLexicon');

// SQL and query values use the same punctuation/diacritic identity normalization.
// No descriptions, retailer names, or cross-sell copy may establish product identity.
function identitySql(expression) {
  return `trim(regexp_replace(lower(translate(regexp_replace(coalesce(${expression}, ''), '[·•]', '', 'g'), 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝàáâãäåèéêëìíîïòóôõöùúûüýÿ', 'AAAAAAEEEEIIIIOOOOOUUUUYaaaaaaeeeeiiiiooooouuuuyy')), '[^[:alnum:]]+', ' ', 'g'))`;
}
const identityValue = (value) => normalizeBrandText(String(value || '').replace(/[·•]/g, '')).replace(/\s+/g, ' ').trim();
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
    const form = FORM_RULES.find(([re]) => re.test(query))?.[1];
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
  return { where: `(${where}) AND $2::text IS NOT NULL`, brandWhere };
}
module.exports = { buildCanonicalSearchQualitySql };

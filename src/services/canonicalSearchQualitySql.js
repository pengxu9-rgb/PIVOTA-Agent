'use strict';

const { createHash } = require('crypto');
const reviewedAliases = require('../../data/beauty/meitu_brand_aliases.json');
const { normalizeBrandText } = require('../findProductsMulti/brandLexicon');
const { identityValue, nameEvidenceAdmissionEnabled, queryDistinctiveTokens } = require('./searchNameEvidence');

// Normalize common Latin accents and middle-dot styling on both query and row identity.
// This is not a general Unicode transliterator; reviewed aliases cover alternate spellings.
// No descriptions, retailer names, or cross-sell copy may establish product identity.
function identitySql(expression) {
  return `trim(regexp_replace(lower(translate(regexp_replace(coalesce(${expression}, ''), '[·•]', '', 'g'), 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝàáâãäåèéêëìíîïòóôõöùúûüýÿ', 'AAAAAAEEEEIIIIOOOOOUUUUYaaaaaaeeeeiiiiooooouuuuyy')), '[^[:alnum:]]+', ' ', 'g'))`;
}
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

const CANONICAL_OWN_BRAND_SQL = "coalesce(nullif(trim(p.brand), ''), p.product_payload->>'brand', p.product_payload->>'vendor', p.product_payload#>>'{seed_data,brand}')";
function normalizedBrandIdentitySql(expression) {
  return `regexp_replace(${identitySql(expression)}, ' ', '', 'g')`;
}

const IDENTITY_ACCENTED = 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝàáâãäåèéêëìíîïòóôõöùúûüýÿ';
const IDENTITY_FOLDED = 'AAAAAAEEEEIIIIOOOOOUUUUYaaaaaaeeeeiiiiooooouuuuyy';
// JS twin of normalizedBrandIdentitySql, for callers that bind an alias against
// the indexed row identity. identityValue() above deliberately does NOT fold
// accents (buildBrandIdentityPredicate leans on reviewed aliases for those
// spellings), but the SQL translate() does — so a key bound for equality or a
// prefix must fold too, or "Lancôme" could never equal the indexed "lancome".
function brandIdentityKey(value) {
  // NFC first: a decomposed "n" + U+0303 would lose its combining mark to the
  // non-alphanumeric strip below and key as "senora", while PostgreSQL keeps the
  // mark and stores "señora" — the two sides must agree character for character.
  const folded = Array.from(String(value || '').normalize('NFC').replace(/[·•]/g, ''))
    .map((character) => {
      const at = IDENTITY_ACCENTED.indexOf(character);
      return at === -1 ? character : IDENTITY_FOLDED[at];
    })
    .join('');
  // PostgreSQL's [:alnum:] keeps letters and DECIMAL digits and drops everything else,
  // including combining marks and compatibility numerals: 'a²b' indexes as 'ab', not 'a²b'.
  // \p{N} would keep ², ½ and Ⅻ and bind a key no row can carry.
  return folded.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, '');
}

function buildBrandIdentityPredicate(brand, expression, params) {
  const terms = [...(reviewedAliases[brand.brand_key] || []), brand.canonical, brand.brand, brand.alias]
    .flatMap(value => [value, String(value || '').replace(/\b(?:beauty|cosmetics?)\b/gi, '')])
    .map(identityValue).filter(Boolean);
  const normalized = [...new Set(terms.map(term => term.replace(/\s+/g, '')))];
  params.push(normalized);
  const fullBind = `$${params.length}`;
  params.push(normalized.map(value => createHash('md5').update(value, 'utf8').digest('hex')));
  // The fixed-width hash only accelerates the index lookup. Full normalized
  // equality remains mandatory, so collisions cannot alter brand identity.
  const ownBrand = normalizedBrandIdentitySql(expression);
  return `(md5(${ownBrand}) = ANY($${params.length}::text[]) AND ${ownBrand} = ANY(${fullBind}::text[]))`;
}

function buildCanonicalSearchQualitySql({ contract, params, categoryPredicate, defaultWhere, defaultBrandWhere }) {
  if (contract?.target_domain !== 'beauty') return { where: defaultWhere, brandWhere: defaultBrandWhere };
  const hard = contract.hard_constraints || {};
  const bind = (value) => { params.push(value); return `$${params.length}`; };
  const ownName = identitySql("concat_ws(' ', p.title, p.product_type, p.product_payload->>'canonical_title', p.product_payload->>'canonical_name')");
  let brandWhere = defaultBrandWhere;
  if (hard.brand) {
    brandWhere = `AND ${buildBrandIdentityPredicate(hard.brand, CANONICAL_OWN_BRAND_SQL, params)}`;
  }
  let where = defaultWhere;
  let nameEvidenceRankSql = '';
  if (hard.exact_product_anchor) {
    const tokens = [...new Set(identityValue(hard.exact_product_anchor).split(' ').filter((token) => token.length >= 2))];
    if (tokens.length) where = tokens.map((token) => `${ownName} ~ ${bind(`(^| )${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($| )`)}`).join(' AND ');
  } else if (contract.query_class === 'brand_browse' && hard.brand) {
    // The resolved brand IS the query. Framing words ("products", "show me")
    // must not introduce a second full-phrase text requirement.
    const ownBeautyForm = FORM_RULES.map(([, pattern]) => pattern).join('|');
    const normalizedPath = "lower(trim(coalesce(p.category_path, '')))";
    // Mixed brands also sell apparel. Apply the requested beauty domain before
    // the candidate cut; the later serving gate cannot recover displaced rows.
    // Thin/root-only categories require the item's own class, never cross-sell
    // copy. An explicit non-beauty category cannot be overridden by copy.
    where = `(${normalizedPath} LIKE 'beauty/%' OR (${normalizedPath} IN ('', 'beauty') AND ${ownName} ~ ${bind(`(^| )(${ownBeautyForm})($| )`)}))`;
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
      // A precise catalog category is sufficient when the seller omits the
      // product-form word. Only shallow ancestors need positive own-name evidence.
      // A recognized conflicting own type still vetoes polluted categorization.
      const ownType = identitySql("p.product_type");
      // Use explicit category nouns, not generic textures (cream/lotion/balm).
      // A named hybrid such as Serum Foundation is positive product evidence.
      const explicitClasses = FORM_RULES.map(([rule]) => rule.source.replace(/\\b/g, '').replace(/\\s/g, '[ ]')).join('|');
      const conflictingType = `(${ownType} ~ ${bind(`(^| )(${explicitClasses})($| )`)} AND NOT (${ownForm}))`;
      where = `((${categoryPredicate}) OR (p.category_path = ANY(${bind(ancestors)}::text[]) AND ${ownForm})) AND NOT ${conflictingType}`;
    } else {
      where = categoryPredicate;
    }
    // NAME-EVIDENCE ADMISSION (src/services/searchNameEvidence.js). The category WHERE
    // above deletes before ranking, so a row whose own name carries every distinctive
    // query token must be admitted HERE too, or the serving gate's matching waiver never
    // sees it. OR-ed outside the whole category clause, conflicting-type veto included:
    // the row's name is stronger evidence than its type label. Same tokens, same
    // normalisation as the gate.
    const nameTokens = nameEvidenceAdmissionEnabled() ? queryDistinctiveTokens(contract.effective_query, hard) : null;
    if (nameTokens) {
      // COST, measured on prod pivota-pg (15,552 products, 8,382 serving-eligible), which
      // evaluates this per row. The first version added ~1s (1.7s -> 2.7s). The cost was
      // detoasting product_payload for canonical_title/canonical_name on every row outside
      // the category; this arm reads title + product_type only (searchNameEvidence.js
      // ownNameTokens has the measurement). Also:
      //  * ONE regex with a lookahead per token, so the name is normalised once;
      //  * a cheap SUPERSET prefilter guarding it in a CASE (evaluation order guaranteed):
      //    lower + the same accent fold and middle-dot removal identitySql applies, then
      //    LIKE '%token%'. Normalisation only folds characters and turns punctuation into
      //    spaces, so a whole normalised word is always a raw substring; a row failing the
      //    prefilter cannot pass the regex.
      const reEscape = (token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const likeEscape = (token) => token.replace(/[\\%_]/g, '\\$&');
      const nameColumns = "concat_ws(' ', p.title, p.product_type)";
      const nameIdentity = identitySql(nameColumns);
      const rawName = `translate(lower(replace(replace(${nameColumns}, '·', ''), '•', '')), 'àáâãäåèéêëìíîïòóôõöùúûüýÿ', 'aaaaaaeeeeiiiiooooouuuuyy')`;
      const prefilter = nameTokens.map((token) => `${rawName} LIKE ${bind(`%${likeEscape(token)}%`)}`).join(' AND ');
      const allTokens = nameTokens.map((token) => `(?=.*(^| )${reEscape(token)}($| ))`).join('');
      const carriesAll = `(CASE WHEN ${prefilter} THEN ${nameIdentity} ~ ${bind(`^${allTokens}`)} ELSE FALSE END)`;
      const categoryWhere = where;
      where = `((${categoryWhere}) OR (${carriesAll}))`;
      // RECALLED IS NOT ENOUGH: the candidate LIMIT runs on rank_score, and the category
      // arm gives every in-bucket row a flat +90 while the named row -- outside the
      // bucket -- gets 0. Measured on real PostgreSQL with 250 in-bucket rows: the named
      // product was admitted by the WHERE and cut by the LIMIT. +95 puts a row whose own
      // name carries the whole query above rows that only share its category, and below
      // an exact title (100) or source id (105). ONLY rows the category clause rejected
      // get it: the order of rows the category already admits is unchanged.
      nameEvidenceRankSql = `CASE WHEN (${carriesAll}) AND NOT (${categoryWhere}) THEN 95 ELSE 0 END +`;
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
  return { where: `(${where}) AND $2::text IS NOT NULL`, brandWhere, nameEvidenceRankSql };
}
module.exports = { buildCanonicalSearchQualitySql, buildBrandIdentityPredicate, normalizedBrandIdentitySql, brandIdentityKey, CANONICAL_OWN_BRAND_SQL };

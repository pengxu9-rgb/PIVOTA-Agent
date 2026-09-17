'use strict';

// NAME-EVIDENCE ADMISSION: a row whose OWN NAME carries every distinctive token of the
// query is not rejected for `category_mismatch`.
//
// Why this exists instead of more query rules. The category of a free-text query is
// GUESSED from keywords (queryUnderstanding.js), and the guess becomes a HARD constraint
// in two places: the canonical SQL WHERE (which deletes before ranking) and the serving
// gate. For a query that is a product NAME, the guess is often wrong -- "LIP-PRESSION
// Metal Serum Gloss" reads as a serum -- and the constraint then deletes the one row whose
// title matches the query exactly. Widening and guarding the keyword rules never
// converged (PIVOTA-Agent #2214, six versions): the input is open-ended.
//
// This rule does not guess better. It says: when the catalog row's own name already
// carries the query, the guessed category must not veto it. It is MONOTONE -- it can
// only admit rows the category constraint rejected; it never rejects anything.
//
// ONE DEFINITION, THREE CALLERS. The tokens and the own-name test here are what the
// serving gate applies in JS and what the canonical SQL binds (identityValue here is
// the same normalisation `identitySql` applies in Postgres). A rule applied at the gate
// but not in the SQL is inert live: the row is deleted before the gate ever sees it.
//
// Flag: SEARCH_NAME_EVIDENCE_ADMISSION=on (default off). Read per call.

const { normalizeBrandText } = require('../findProductsMulti/brandLexicon');
const { resolveBeautyCategoryPathPrefixFromText } = require('../findProductsMulti/queryUnderstanding');

const FLAG = 'SEARCH_NAME_EVIDENCE_ADMISSION';

// The JS twin of `identitySql` in canonicalSearchQualitySql.js, which imports it from
// here so there is exactly one copy.
const identityValue = (value) => normalizeBrandText(String(value || '').replace(/[·•]/g, ''))
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Words that carry no product identity. A query made only of these plus category
// words is a browse, not a name.
const NON_DISTINCTIVE = new Set([
  'the', 'for', 'and', 'with', 'best', 'buy', 'shop', 'find', 'show', 'recommend', 'recommendation',
  'recommendations', 'products', 'product', 'beauty', 'cosmetics', 'online', 'cheap', 'affordable',
  'korean', 'japanese', 'new', 'top', 'under', 'from', 'that', 'this', 'your', 'skin', 'face', 'set', 'kit',
]);

const MIN_TOKEN_LENGTH = 3;
const MIN_TOKENS = 2;

function nameEvidenceAdmissionEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env[FLAG] || '').trim());
}

function brandTokens(hard) {
  const brand = hard && hard.brand;
  const out = new Set();
  if (!brand) return out;
  for (const value of [brand.alias, brand.canonical, brand.brand]) {
    for (const token of identityValue(value).split(' ')) if (token) out.add(token);
  }
  return out;
}

// The distinctive tokens of a query, or null when the query does not look like a name.
//
// A NAME has at least two distinctive tokens, and at least one of them is not category
// vocabulary on its own. "lip gloss" is two category words: a browse, no evidence.
// "Metal Serum Gloss" has "metal": a name. Brand tokens are excluded -- the brand is
// its own hard constraint, and a brand word is not evidence of WHICH product.
function queryDistinctiveTokens(queryText, hardConstraints = null) {
  const exclude = brandTokens(hardConstraints);
  const tokens = [...new Set(identityValue(queryText).split(' '))]
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !NON_DISTINCTIVE.has(token) && !exclude.has(token));
  if (tokens.length < MIN_TOKENS) return null;
  if (!tokens.some((token) => !resolveBeautyCategoryPathPrefixFromText(token))) return null;
  return tokens;
}

// OWN NAME = title + product_type, exactly the two columns the SQL arm reads. Never
// description, brand copy, retailer text -- or product_payload: reading the JSONB payload
// for canonical_title/canonical_name on every row outside the category was the entire
// measured cost of the SQL arm on prod (1.7s -> 2.7s), and across serving-eligible rows
// canonical_title never differs from title (measured 2026-09-17: 0 rows).
function ownNameTokens(product = {}) {
  const title = [product.title, product.name].find((v) => typeof v === 'string' && v.trim()) || '';
  const text = [title, product.product_type].filter((v) => typeof v === 'string' && v.trim()).join(' ');
  return new Set(identityValue(text).split(' ').filter(Boolean));
}

function ownNameCarriesTokens(product, tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return false;
  const words = ownNameTokens(product);
  return tokens.every((token) => words.has(token));
}

module.exports = {
  FLAG,
  MIN_TOKENS,
  MIN_TOKEN_LENGTH,
  identityValue,
  nameEvidenceAdmissionEnabled,
  ownNameCarriesTokens,
  queryDistinctiveTokens,
};

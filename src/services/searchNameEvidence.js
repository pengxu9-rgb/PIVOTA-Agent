'use strict';

// NAME-EVIDENCE ADMISSION: when the words of a query identify only a handful of catalog
// products by their own names, the category GUESSED from those words must not veto them.
//
// Why this exists instead of more query rules. The category of a free-text query is guessed
// from keywords (queryUnderstanding.js), and the guess becomes a HARD constraint in two
// places: the canonical SQL WHERE (which deletes before ranking) and the serving gate. For a
// product-NAME query the guess is often wrong -- "LIP-PRESSION Metal Serum Gloss" reads as a
// serum -- and the constraint deleted the one row whose title matches. Widening and guarding
// keyword rules never converged (PIVOTA-Agent #2214, six versions).
//
// WHAT MAKES A QUERY A NAME: THE CATALOG, NOT A WORD LIST. The first version called a query a
// name when one of its words was not category vocabulary; review showed that makes "nail
// polish", "eye cream" and "matte lipstick" names, and put a nail polish REMOVER at #1.
// Measured on prod (9,122 serving rows, 2026-09-17), the number of rows whose own name carries
// every query token separates the two:
//   names:   Metal Serum Gloss 2 · Egg Vita Peeling Gel 1 · Soft Pinch Liquid Blush 2 ·
//            Essential Mool Cream 5 · Stay All Day Liquid Lipstick 6
//   browses: nail polish 44 · eye cream 79 · lip gloss 103 · matte lipstick 33 ·
//            setting powder 35 · lip balm 133 · sheet mask 134
// So a query is name-shaped when at most MAX_CARRIERS rows carry it. A few browses are that
// rare too (red lipstick 2, barrier lotion 1); what they admit is still a red lipstick or a
// barrier lotion, filed under a shallow category.
//
// ONE AUTHORITY: THE SQL. The canonical SQL counts the carriers, admits them, and marks each
// admitted row `name_evidence_admitted`. The serving gate and the ranker read that mark; they
// never re-derive it, so JS and Postgres normalisation cannot disagree about who is admitted.
// This module owns only what both sides need from the QUERY: its tokens, normalised the way
// `identitySql` normalises a row.
//
// Flag: SEARCH_NAME_EVIDENCE_ADMISSION=on (default off). Read per call.

const FLAG = 'SEARCH_NAME_EVIDENCE_ADMISSION';

// At most this many catalog rows may carry every query token. Absolute, from the census above;
// revisit as the catalog grows (it is ~0.1% of serving rows today).
const MAX_CARRIERS = 10;

const MIN_TOKEN_LENGTH = 3;
const MIN_TOKENS = 2;

// Words that carry no product identity at all.
const NON_DISTINCTIVE = new Set([
  'the', 'for', 'and', 'with', 'best', 'buy', 'shop', 'find', 'show', 'recommend', 'recommendation',
  'recommendations', 'products', 'product', 'beauty', 'cosmetics', 'online', 'cheap', 'affordable',
  'korean', 'japanese', 'new', 'top', 'under', 'from', 'that', 'this', 'your', 'skin', 'face', 'set', 'kit',
]);

// The exact fold `identitySql` (canonicalSearchQualitySql.js) applies to a row, in JS: NFC,
// drop middle dots, translate the same accented letters in both cases, lowercase, and turn
// everything but letters and DECIMAL digits into a space (PostgreSQL's [:alnum:] drops
// combining marks and compatibility numerals such as "²"). NOT normalizeBrandText -- its NFKD
// turns "™" into "TM" and "²" into "2", which Postgres never does, so a token would never meet
// its row. This is brandIdentityKey (canonicalSearchQualitySql.js) with the word breaks kept;
// a test pins that the two agree.
const IDENTITY_ACCENTED = 'ÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝàáâãäåèéêëìíîïòóôõöùúûüýÿ';
const IDENTITY_FOLDED = 'AAAAAAEEEEIIIIOOOOOUUUUYaaaaaaeeeeiiiiooooouuuuyy';
const FOLD = new Map([...IDENTITY_ACCENTED].map((ch, i) => [ch, IDENTITY_FOLDED[i]]));

function sqlIdentityValue(value) {
  const translated = [...String(value || '').normalize('NFC').replace(/[·•]/g, '')]
    .map((ch) => FOLD.get(ch) || ch)
    .join('');
  return translated.toLowerCase().replace(/[^\p{L}\p{Nd}]+/gu, ' ').trim();
}

function nameEvidenceAdmissionEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env[FLAG] || '').trim());
}

// Brand words are not evidence of WHICH product -- the brand is its own hard constraint. Both
// the spaced and the joined spelling are excluded ("jung saem mool" and "jungsaemmool").
function brandTokens(hard) {
  const brand = hard && hard.brand;
  const out = new Set();
  if (!brand) return out;
  for (const value of [brand.alias, brand.canonical, brand.brand]) {
    const words = sqlIdentityValue(value).split(' ').filter(Boolean);
    for (const token of words) out.add(token);
    if (words.length > 1) out.add(words.join(''));
  }
  return out;
}

// The distinctive tokens of a query, or null when it has too few to be a name. Whether the
// tokens actually identify few products is decided by the SQL, over the catalog.
function queryDistinctiveTokens(queryText, hardConstraints = null) {
  const exclude = brandTokens(hardConstraints);
  const tokens = [...new Set(sqlIdentityValue(queryText).split(' '))]
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !NON_DISTINCTIVE.has(token) && !exclude.has(token));
  return tokens.length >= MIN_TOKENS ? tokens : null;
}

module.exports = {
  FLAG,
  IDENTITY_ACCENTED,
  IDENTITY_FOLDED,
  MAX_CARRIERS,
  MIN_TOKENS,
  MIN_TOKEN_LENGTH,
  nameEvidenceAdmissionEnabled,
  queryDistinctiveTokens,
  sqlIdentityValue,
};

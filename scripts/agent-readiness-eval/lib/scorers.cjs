'use strict';

// Deterministic scorers. Every rule compares what the QUERY asked for (the fixture's `expect`) against what
// the RESPONSE shows a partner (name / brand / category / actives / ingredients / description / price /
// link). Nothing here knows which products exist; a query passes on properties, never on exact products.
//
// Each check returns 'pass' | 'fail' | 'unknown'. 'unknown' means the response does not carry enough for a
// partner to verify the property either way (e.g. an ingredient constraint against a row with no ingredient
// data and no mention in the title). It is reported as its own rate — "unverifiable" is a finding about
// what we hand partners, not a pass.

const { currencyForMarket, linkProblem } = require('./responses.cjs');

// ---- text normalization ------------------------------------------------------------------------------------

function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    // Sentence boundaries survive as " . " so a negation never reaches across a sentence or a list item.
    .replace(/[;!?。！？]+/g, ' . ')
    .replace(/\.(?=\s|$)/g, ' . ')
    .replace(/[‐-―−_/\\|,:()[\]{}"“”'’`]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * All start offsets where `term` occurs in normalized `text`. CJK terms match as substrings. Latin terms need a
 * word boundary on BOTH sides, allowing only a plural "s"/"es" before the right boundary: "lipsticks" matches
 * "lipstick", but "scentless" does not match "scent", and "tulip" does not match "lip".
 */
function occurrences(text, term) {
  const t = norm(term);
  if (!t) return [];
  const out = [];
  if (CJK_RE.test(t)) {
    let i = text.indexOf(t);
    while (i !== -1) {
      out.push(i);
      i = text.indexOf(t, i + 1);
    }
    return out;
  }
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}(?=(?:e?s)?(?![\\p{L}]))`, 'gu');
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m.index + m[1].length);
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return out;
}

function containsAny(text, terms) {
  return (terms || []).some((term) => occurrences(text, term).length > 0);
}

// ---- negation ---------------------------------------------------------------------------------------------
// A mention inside a negation is a statement of ABSENCE and never counts as the product containing it:
//   cue BEFORE, scoped forward over a list: "free of parabens, sulfates, and fragrance" (each one),
//     "no added fragrance", "made without parabens or fragrance", "does not contain alcohol", "sans parfum",
//     "sin alcohol"; the scope is the same sentence, at most NEG_SCOPE_WORDS words, and ends at a word that
//     reintroduces content ("with", "but", "contains", ...): "free of parabens with a rose fragrance" still
//     contains fragrance.
//   cue AFTER: "fragrance-free", "paraben and sulfate free", "アルコールフリー", "알코올 프리".
//   CJK cues directly before: "无香精", "無香料", "不含酒精", "무향".
//   "un" + term: "unscented".

const NEG_SCOPE_WORDS = 8;
const NEG_BEFORE_LATIN = ['free of', 'free from', 'no', 'non', 'not', 'without', 'zero', '0%', 'sans', 'sin', 'libre de', 'exempt de', 'never'];
const NEG_BEFORE_CJK = ['无', '無', '不含', '零', '무', '노'];
const NEG_AFTER = ['free', 'frei', 'libre', 'フリー', '無添加', '프리'];
const SCOPE_TERMINATORS = new Set(['with', 'but', 'except', 'contains', 'containing', 'plus', 'including', 'yet', 'however', 'has', 'have', 'and added']);

// Mentions that are not a claim of containing the term: "retinol alternative bakuchiol", "gentler than
// retinol", "a dupe of …", "instead of retinol". They never count as the ingredient being present.
const NON_CLAIM_AFTER = ['alternative', 'alt', 'substitute', 'replacement', 'dupe', 'like', 'inspired', 'free'];
const NON_CLAIM_BEFORE = ['alternative to', 'instead of', 'substitute for', 'replaces', 'replacing', 'like', 'vs', 'versus', 'than', 'dupe of'];

function wordsBefore(text, index) {
  const sentenceStart = text.lastIndexOf(' . ', index - 1);
  const from = sentenceStart === -1 ? 0 : sentenceStart + 3;
  return text.slice(from, index).trim().split(' ').filter(Boolean);
}

function endsWithPhrase(words, endIdx, phrase) {
  const p = phrase.split(' ');
  if (endIdx + 1 < p.length) return false;
  for (let k = 0; k < p.length; k += 1) if (words[endIdx - p.length + 1 + k] !== p[k]) return false;
  return true;
}

function isNegatedAt(text, index, term) {
  const t = norm(term);
  const before = text.slice(Math.max(0, index - 4), index);
  for (const cue of NEG_BEFORE_CJK) if (before.endsWith(cue) || before.endsWith(`${cue} `)) return true;
  const words = wordsBefore(text, index);
  // Walk back from the term over at most NEG_SCOPE_WORDS words, stopping at a scope terminator.
  for (let j = words.length - 1, steps = 0; j >= 0 && steps <= NEG_SCOPE_WORDS; j -= 1, steps += 1) {
    if (NEG_BEFORE_LATIN.some((cue) => endsWithPhrase(words, j, cue))) return true;
    if (SCOPE_TERMINATORS.has(words[j])) break;
  }
  const after = text.slice(index + t.length).replace(/^(?:e?s)(?![\p{L}])/u, '');
  for (const cue of NEG_AFTER) {
    const c = norm(cue);
    if (CJK_RE.test(c)) {
      if (after.replace(/^\s+/, '').startsWith(c)) return true;
    } else if (new RegExp(`^\\s*(?:(?:and|or|&)\\s+[\\p{L}]+\\s+)?${escapeRe(c)}(?![\\p{L}])`, 'u').test(after)) {
      return true;
    }
  }
  return false;
}

function isNonClaimAt(text, index, term) {
  const t = norm(term);
  const after = text.slice(index + t.length).replace(/^(?:e?s)(?![\p{L}])/u, '');
  if (NON_CLAIM_AFTER.some((w) => new RegExp(`^\\s*${escapeRe(w)}(?![\\p{L}])`, 'u').test(after))) return true;
  const words = wordsBefore(text, index);
  return NON_CLAIM_BEFORE.some((p) => endsWithPhrase(words, words.length - 1, p));
}

// Occurrences that name a DIFFERENT, benign ingredient: "cetyl alcohol" is a fatty alcohol that alcohol-free
// products routinely contain; it is not the drying alcohol an "alcohol-free" shopper means.
const BENIGN_PRECEDERS = Object.freeze({
  alcohol: ['cetyl', 'cetearyl', 'stearyl', 'behenyl', 'myristyl', 'arachidyl', 'lanolin', 'isostearyl', 'oleyl', 'lauryl'],
});

function isBenignAt(text, index, term) {
  const preceders = BENIGN_PRECEDERS[norm(term)];
  if (!preceders) return false;
  const words = wordsBefore(text, index);
  return preceders.includes(words[words.length - 1]);
}

/** true when `text` CLAIMS any term: not negated, not an "alternative to" mention, not a benign compound name. */
function containsAffirmed(text, terms) {
  for (const term of terms || []) {
    for (const i of occurrences(text, term)) {
      if (!isNegatedAt(text, i, term) && !isNonClaimAt(text, i, term) && !isBenignAt(text, i, term)) return true;
    }
  }
  return false;
}

/** true when `text` states the absence of any term ("X-free", "no X", "free of A, B and X", "unX", "Xless"). */
function statesAbsence(text, terms) {
  for (const term of terms || []) {
    for (const i of occurrences(text, term)) {
      if (isNegatedAt(text, i, term)) return true;
    }
    const t = norm(term);
    if (!CJK_RE.test(t) && (occurrences(text, `un${t}`).length > 0 || occurrences(text, `${t}less`).length > 0)) return true;
  }
  return false;
}

// ---- per-product constraint checks ------------------------------------------------------------------------

function fieldsOf(product) {
  const title = norm(product.title);
  const category = norm(product.category);
  const brand = norm(product.brand);
  const description = norm(product.description);
  // List items are joined as separate "sentences" so a negation or a qualifier never spans two items.
  const actives = norm((product.actives || []).join(' . '));
  const ingredients = norm((product.ingredients || []).join(' . '));
  return { title, category, brand, description, actives, ingredients };
}

function checkCategory(product, terms) {
  const f = fieldsOf(product);
  if (containsAny(`${f.title} ${f.category}`, terms)) return 'pass';
  if (!f.category && !f.title) return 'unknown';
  // Category may only be stated in prose; a description match is accepted but only when nothing else is known.
  if (!f.category && containsAny(f.description, terms)) return 'pass';
  return 'fail';
}

function checkIngredientGroup(product, terms) {
  const f = fieldsOf(product);
  if (containsAffirmed(`${f.title} ${f.actives} ${f.ingredients} ${f.description}`, terms)) return 'pass';
  const hasIngredientData = Boolean(f.actives || f.ingredients);
  return hasIngredientData ? 'fail' : 'unknown';
}

function checkExcludeGroup(product, terms) {
  const f = fieldsOf(product);
  if (containsAffirmed(`${f.title} ${f.actives} ${f.ingredients}`, terms)) return 'fail';
  if (f.ingredients) return 'pass';
  if (statesAbsence(`${f.title} ${f.description}`, terms)) return 'pass';
  // A description that names the ingredient without negating it is a contradiction of the constraint.
  if (containsAffirmed(f.description, terms)) return 'fail';
  return 'unknown';
}

function checkBrand(product, terms) {
  const f = fieldsOf(product);
  if (!f.brand && !f.title) return 'unknown';
  if (containsAny(f.brand, terms)) return 'pass';
  if (terms.some((t) => f.title.startsWith(norm(t)))) return 'pass';
  return 'fail';
}

// A cap is a statement in ONE currency: with either currency unknown, an amount proves nothing ('unknown').
function checkPriceMax(product, priceMax, currency) {
  const p = product.price;
  if (!p || !(p.amount > 0)) return 'unknown';
  if (!currency || !p.currency || !p.currencyValid) return 'unknown';
  if (p.currency !== currency) return 'fail';
  return p.amount <= priceMax * 1.005 ? 'pass' : 'fail';
}

/** Every applicable check for one product against one query's expectations. */
function scoreProduct(product, expect = {}) {
  const checks = {};
  if (Array.isArray(expect.category) && expect.category.length) checks.category = checkCategory(product, expect.category);
  (expect.ingredients || []).forEach((group, i) => {
    checks[`ingredient_${i}`] = checkIngredientGroup(product, group);
  });
  (expect.exclude || []).forEach((group, i) => {
    checks[`exclude_${i}`] = checkExcludeGroup(product, group);
  });
  if (Array.isArray(expect.brand) && expect.brand.length) checks.brand = checkBrand(product, expect.brand);
  if (typeof expect.price_max === 'number') checks.price_max = checkPriceMax(product, expect.price_max, expect.currency || null);
  const values = Object.values(checks);
  const verdict = values.includes('fail') ? 'fail' : values.includes('unknown') ? 'unknown' : 'pass';
  return { verdict, checks };
}

/**
 * Relevance for one query's result page. A product counts toward precision only on 'pass'; 'unknown' is
 * reported separately. Returns null for an empty page (empty pages are scored by zero-result rate instead).
 */
function scoreRelevance(products, expect, { topK = 5, passThreshold = 0.6 } = {}) {
  const top = (products || []).slice(0, topK);
  if (top.length === 0) return null;
  const perProduct = top.map((p) => scoreProduct(p, expect));
  const pass = perProduct.filter((r) => r.verdict === 'pass').length;
  const unknown = perProduct.filter((r) => r.verdict === 'unknown').length;
  const fail = perProduct.filter((r) => r.verdict === 'fail').length;
  const precision = pass / top.length;
  const failedChecks = {};
  for (const r of perProduct) {
    for (const [k, v] of Object.entries(r.checks)) if (v === 'fail') failedChecks[k] = (failedChecks[k] || 0) + 1;
  }
  return {
    scored: top.length,
    pass,
    unknown,
    fail,
    precision,
    unverifiable_rate: unknown / top.length,
    query_pass: precision >= passThreshold,
    failed_checks: failedChecks,
  };
}

// ---- negative controls ------------------------------------------------------------------------------------

/**
 * non_beauty / nonsense: the right answer is an empty page (any stated reason). unsafe: empty, or nothing on
 * the page affirms an unsafe term. A tool error is not a pass by itself — but it does not serve harm either,
 * so it scores as 'pass' here and is charged to the tool-error SLO instead.
 */
function scoreNegative(kind, products, expect = {}, { toolError = false } = {}) {
  if (toolError) return { pass: true, reason: 'tool_error' };
  const n = (products || []).length;
  if (n === 0) return { pass: true, reason: 'empty' };
  if (kind === 'unsafe') {
    const terms = expect.unsafe_terms || [];
    const offending = products.filter((p) => {
      const f = fieldsOf(p);
      return containsAffirmed(`${f.title} ${f.actives} ${f.ingredients} ${f.description}`, terms);
    }).length;
    return { pass: offending === 0, reason: offending ? `unsafe_term_in_${offending}_results` : 'no_unsafe_terms', returned: n };
  }
  return { pass: false, reason: `returned_${n}_results`, returned: n };
}

// ---- row integrity ----------------------------------------------------------------------------------------

/** Currency vs market, price present/positive, link well-formed, for one page of products. */
function scoreRows(products, { market } = {}) {
  const expectedCurrency = currencyForMarket(market);
  const out = {
    rows: 0,
    missing_price: 0,
    non_positive_price: 0,
    invalid_currency: 0,
    currency_market_mismatch: 0,
    currency_checked: 0,
    missing_link: 0,
    link_problems: {},
    // No market stated: there is nothing to compare against, but the rows are still checked, and the
    // currencies they arrive in are recorded — a page answered in USD for a query that named no market is a
    // SILENT US default, which the scorecard surfaces as a finding.
    no_market_rows: 0,
    no_market_currency: {},
    mixed_currency_pages: 0,
  };
  const pageCurrencies = new Set();
  for (const p of products || []) {
    out.rows += 1;
    if (!p.price) out.missing_price += 1;
    else {
      if (!(p.price.amount > 0)) out.non_positive_price += 1;
      if (!p.price.currencyValid) out.invalid_currency += 1;
      if (p.price.currencyValid) pageCurrencies.add(p.price.currency);
      if (expectedCurrency && p.price.currencyValid) {
        out.currency_checked += 1;
        if (p.price.currency !== expectedCurrency) out.currency_market_mismatch += 1;
      }
      if (!market && p.price.currencyValid) {
        out.no_market_rows += 1;
        out.no_market_currency[p.price.currency] = (out.no_market_currency[p.price.currency] || 0) + 1;
      }
    }
    const problem = linkProblem(p.link);
    if (problem) {
      out.missing_link += 1;
      out.link_problems[problem] = (out.link_problems[problem] || 0) + 1;
    }
  }
  if (pageCurrencies.size > 1) out.mixed_currency_pages = 1;
  return out;
}

/** Duplicate products on one page: same id, or same brand+title. */
function findDuplicates(products) {
  const ids = new Map();
  const names = new Map();
  const dups = [];
  (products || []).forEach((p, i) => {
    if (p.id) {
      if (ids.has(p.id)) dups.push({ kind: 'id', a: ids.get(p.id), b: i });
      else ids.set(p.id, i);
    }
    const key = `${norm(p.brand)}|${norm(p.title)}`;
    if (key !== '|') {
      if (names.has(key)) dups.push({ kind: 'name', a: names.get(key), b: i });
      else names.set(key, i);
    }
  });
  return dups;
}

/** Shade/variant presence for a shade query: does the row (or its PDP) expose shades a partner can show? */
function shadePresence(product) {
  if (!product) return 'unknown';
  if ((product.variants || []).length > 0) return 'present';
  return product.has_variant_field ? 'empty' : 'absent';
}

// ---- consistency ------------------------------------------------------------------------------------------

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Same query, repeated: compares the top-k id lists of each repeat with the first. */
function scoreConsistency(idLists, { topK = 5, stableJaccard = 0.8 } = {}) {
  const lists = idLists.map((l) => (l || []).slice(0, topK));
  if (lists.length < 2) return null;
  const first = lists[0];
  const js = lists.slice(1).map((l) => jaccard(first, l));
  const sameOrder = lists.slice(1).every((l) => l.length === first.length && l.every((x, i) => x === first[i]));
  const minJ = Math.min(...js);
  return { min_jaccard: minJ, same_order: sameOrder, stable: minJ >= stableJaccard };
}

/** Search price vs offer price for the same product, same currency only. */
function priceAgreement(searchPrice, offerPrice, tolerance = 0.05) {
  if (!searchPrice || !offerPrice) return { comparable: false, reason: 'missing_price' };
  if (!searchPrice.currencyValid || !offerPrice.currencyValid) return { comparable: false, reason: 'invalid_currency' };
  if (searchPrice.currency !== offerPrice.currency) return { comparable: false, reason: 'currency_differs' };
  const a = searchPrice.amount;
  const b = offerPrice.amount;
  if (!(a > 0) || !(b > 0)) return { comparable: false, reason: 'non_positive' };
  const rel = Math.abs(a - b) / Math.max(a, b);
  return { comparable: true, agree: rel <= tolerance, rel_diff: Math.round(rel * 10000) / 10000 };
}

module.exports = {
  norm,
  occurrences,
  containsAny,
  containsAffirmed,
  statesAbsence,
  isNegatedAt,
  checkCategory,
  checkIngredientGroup,
  checkExcludeGroup,
  checkBrand,
  checkPriceMax,
  scoreProduct,
  scoreRelevance,
  scoreNegative,
  scoreRows,
  findDuplicates,
  shadePresence,
  jaccard,
  scoreConsistency,
  priceAgreement,
};

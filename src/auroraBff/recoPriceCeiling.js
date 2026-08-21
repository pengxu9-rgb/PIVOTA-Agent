'use strict';

// A structured price ceiling, carried through RECALL rather than only enforced after it.
//
// Live 2026-08-21: "a gentle exfoliant for sensitive skin under $40" with constraints
// {price_max: 40} returned 3 grounded items priced 45/45/60 USD -- honestly flagged as violations, but
// still the whole answer, while the catalog held 40+ conforming products at or under 40 USD (e.g.
// "AXIS-Y PHA Resurfacing Glow Peel" at 6 USD). The ceiling was parsed in the agent bridge and reached
// the lane only as PROSE inside buildAsk. The recall plan, the loopback search and the pool selection
// never saw it, so the ~5-candidate pool was pure relevance -- premium-brand-heavy -- and the
// deterministic gate downstream could only flag what recall had already decided.
//
// The rule here is BIAS, NEVER CENSORSHIP. Nothing in this module removes a candidate: an over-ceiling
// item is re-ordered behind conforming ones, never dropped. An empty conforming set must degrade to
// today's answer (flagged near-misses), never to a zero-result answer.

// Same allowlist as the agent bridge's KNOWN_CURRENCIES (src/agentSignals/recommendProducts.js:103).
// A test pins the two together, so a currency added on one side cannot silently disable enforcement on
// the other.
const RECO_PRICE_CEILING_KNOWN_CURRENCIES = Object.freeze([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'KRW', 'HKD', 'SGD', 'TWD', 'CHF', 'SEK', 'NZD',
]);
const KNOWN_CURRENCY_SET = new Set(RECO_PRICE_CEILING_KNOWN_CURRENCIES);

// The serving path normalizes catalog prices to USD, so an undeclared ceiling is read as USD -- the
// same assumption the bridge makes and reports.
const RECO_PRICE_CEILING_DEFAULT_CURRENCY = 'USD';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCurrencyToken(value) {
  const token = String(value == null ? '' : value).trim().toUpperCase();
  return KNOWN_CURRENCY_SET.has(token) ? token : '';
}

function positiveFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

/**
 * Normalize whatever a caller hands us into `{ limit, currency }` or null.
 *
 * An ALLOWLIST, not a coercer: a non-positive, non-finite or missing limit yields null (no ceiling, so
 * recall behaves exactly as it does today), and an UNRECOGNIZED currency yields null rather than being
 * silently read as USD -- comparing an amount against a ceiling in an assumed unit is the fabrication
 * this repo already refuses on the enforcement side.
 */
function normalizeRecoPriceCeiling(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || typeof raw === 'string') {
    const limit = positiveFiniteNumber(raw);
    return limit === null ? null : { limit, currency: RECO_PRICE_CEILING_DEFAULT_CURRENCY };
  }
  if (!isPlainObject(raw)) return null;
  const limit = positiveFiniteNumber(
    raw.limit ?? raw.amount ?? raw.price_max ?? raw.priceMax ?? raw.max_price ?? raw.maxPrice,
  );
  if (limit === null) return null;
  const rawCurrency = raw.currency ?? raw.price_currency ?? raw.priceCurrency ?? raw.currency_code;
  if (rawCurrency !== null && rawCurrency !== undefined && String(rawCurrency).trim() !== '') {
    const currency = normalizeCurrencyToken(rawCurrency);
    // A DECLARED but unrecognized currency disables the ceiling outright. Falling back to USD here
    // would apply a 40-unit cap to prices whose unit we could not read.
    if (!currency) return null;
    return { limit, currency };
  }
  return { limit, currency: RECO_PRICE_CEILING_DEFAULT_CURRENCY };
}

/**
 * The ceiling's contribution to the recall pool cache key: `"40usd"`, or `""` when there is none.
 *
 * The pool a ceiling produces is NOT the pool the same queries produce without one (conforming-first
 * selection changes what lands in the 24-row payload), so without this dimension a constrained call
 * would poison the unconstrained pool and vice versa -- for up to 24 hours, across the fleet.
 *
 * Rounded to 4 decimals so 40 and 40.00000001 do not create two rows.
 */
function formatRecoPriceCeilingCacheToken(ceiling) {
  const normalized = normalizeRecoPriceCeiling(ceiling);
  if (!normalized) return '';
  const amount = Number(normalized.limit.toFixed(4));
  return `${amount}${normalized.currency.toLowerCase()}`;
}

// Scalar price seeds. These are exactly the shapes routes.js `extractCatalogCandidatePrice` reads back
// and the ones the pool-cache sanitizer writes (`price_amount` + `currency`, since PR #2056). A test
// asserts this agrees with extractCatalogCandidatePrice across a matrix of candidate shapes, so the two
// readers cannot drift into disagreeing about what a row costs.
//
// `normalizeCurrency` is an injection point for READERS THAT ARE NOT COMPARING, and it defaults to
// exactly today's behavior so no caller changes. The ceiling asks "can I compare against this?", so
// its allowlist must reject an unrecognized unit and refuse a verdict. ADR-024's served-price census
// asks the different question "was this priced in a unit that is not the buyer's?", where a
// well-formed but unmodelled code (INR) is the loudest possible YES. Passing a looser normalizer
// cannot loosen the ceiling: classifyRecoCandidateAgainstPriceCeiling re-runs normalizeCurrencyToken
// on whatever comes back, so an unallowlisted currency is still `unknown` there. A test pins that.
function readRecoCandidatePriceForCeiling(candidate, { normalizeCurrency = normalizeCurrencyToken } = {}) {
  if (!isPlainObject(candidate)) return null;
  const currencyOf = (...values) => {
    for (const value of values) {
      const token = normalizeCurrency(value);
      if (token) return token;
    }
    return '';
  };

  const price = candidate.price;
  if (isPlainObject(price)) {
    const amount = positiveFiniteNumber(price.amount ?? price.value ?? price.price);
    if (amount !== null) {
      return {
        amount,
        currency: currencyOf(price.currency, price.currency_code, candidate.currency, candidate.price_currency),
      };
    }
  }
  const scalar = positiveFiniteNumber(
    typeof price === 'object' ? null : price,
  ) ?? positiveFiniteNumber(candidate.price_amount ?? candidate.priceAmount);
  if (scalar !== null) {
    return {
      amount: scalar,
      currency: currencyOf(candidate.currency, candidate.price_currency, candidate.priceCurrency),
    };
  }
  return null;
}

/**
 * 'conforming' | 'over' | 'unknown'.
 *
 * A price in a DIFFERENT currency than the ceiling is `unknown`, never `over`: this lane holds no FX
 * rates, so comparing 4500 JPY against a ceiling of 40 would fabricate a verdict in both directions. A
 * price with no currency is `unknown` for the same reason.
 */
function classifyRecoCandidateAgainstPriceCeiling(candidate, ceiling, { readPrice = readRecoCandidatePriceForCeiling } = {}) {
  const normalized = normalizeRecoPriceCeiling(ceiling);
  if (!normalized) return 'unknown';
  const price = typeof readPrice === 'function' ? readPrice(candidate) : null;
  if (!price || !Number.isFinite(Number(price.amount)) || Number(price.amount) <= 0) return 'unknown';
  const currency = normalizeCurrencyToken(price.currency);
  if (!currency || currency !== normalized.currency) return 'unknown';
  return Number(price.amount) <= normalized.limit ? 'conforming' : 'over';
}

/**
 * Stable conforming-first partition: conforming > unknown > over.
 *
 * THREE buckets. #2057 shipped TWO on the reasoning that "at recall time an unpriced row is not
 * 'possibly conforming', it is unevaluable" -- a price-less row was strictly worse than a priced
 * near-miss, because nothing downstream could ever resolve it.
 *
 * THAT PREMISE HAS SINCE CHANGED. The agent bridge's live re-verification (verifyPrice, added
 * alongside the enforcement gate) now RESOLVES unknowns before the shortlist is cut -- measured live
 * 2026-08-21: "price updated by live check: unknown -> 19 USD" turned a Naturium exfoliant with no
 * catalog price into a conforming $19 item. So an unknown is now "possibly conforming, and
 * CHECKABLE", while an `over` is a certain violation that no later step can rescue. Ranking a
 * certain violation above a checkable unknown was correct when nothing could check; it is not now.
 *
 * Still a stable partition: relevance order is preserved WITHIN each bucket, and nothing is ever
 * removed. With no ceiling the returned array is the input array's own order, element for element.
 */
function applyRecoPriceCeilingPreference(rows, ceiling, { readPrice = readRecoCandidatePriceForCeiling, getCandidate = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const normalized = normalizeRecoPriceCeiling(ceiling);
  if (!normalized || list.length < 2) return list.slice();
  const pick = typeof getCandidate === 'function' ? getCandidate : (row) => row;
  const conforming = [];
  const unknown = [];
  const over = [];
  for (const row of list) {
    const verdict = classifyRecoCandidateAgainstPriceCeiling(pick(row), normalized, { readPrice });
    if (verdict === 'conforming') conforming.push(row);
    else if (verdict === 'over') over.push(row);
    else unknown.push(row);
  }
  return [...conforming, ...unknown, ...over];
}

// Identity for shortlist dedupe. The canonical ref is the strongest signal; merchant+product is the
// shipped pair everywhere else in this lane; the display name is the last resort so an ungrounded
// LLM row (no ids at all) still blocks a duplicate of itself.
function recoRowIdentityKey(row) {
  if (!isPlainObject(row)) return '';
  const str = (...values) => {
    for (const value of values) {
      const token = String(value == null ? '' : value).trim();
      if (token) return token;
    }
    return '';
  };
  // ONE namespace for the (merchant, product) pair, whatever shape it arrives in. A catalog-built row
  // carries a canonical_product_ref AND flat ids; an LLM row carries only the flat ids. Keying those
  // into separate namespaces made the same product look like two, which is how the top-up appended a
  // product the answer already named.
  const canonical = row.canonical_product_ref || row.canonicalProductRef;
  const canonicalObj = isPlainObject(canonical) ? canonical : {};
  const productId = str(
    row.product_id,
    row.productId,
    canonicalObj.product_id,
    canonicalObj.productId,
    row.sku && row.sku.product_id,
  );
  if (productId) {
    const merchant = str(
      row.merchant_id,
      row.merchantId,
      canonicalObj.merchant_id,
      canonicalObj.merchantId,
      row.sku && row.sku.merchant_id,
    );
    return `pid:${merchant.toLowerCase()}::${productId.toLowerCase()}`;
  }
  // An opaque string ref is the only remaining id-shaped signal.
  if (typeof canonical === 'string' && canonical.trim()) return `ref:${canonical.trim().toLowerCase()}`;
  const name = str(row.display_name, row.displayName, row.name, row.title);
  return name ? `name:${name.replace(/\s+/g, ' ').trim().toLowerCase()}` : '';
}

/**
 * STRICT FILL: which catalog rows should be appended so the shortlist reaches `target` CONFORMING
 * recommendations.
 *
 * Returns ONLY rows that are (a) verified conforming against the ceiling, and (b) not already in the
 * answer. Never pads with non-conforming filler: when conforming supply runs out the shortfall stays
 * a shortfall, and the existing flagged near-misses keep the leftover slots.
 */
function selectRecoPriceCeilingTopUpRows({
  recommendations = [],
  catalogRows = [],
  ceiling = null,
  target = 0,
  readPrice = readRecoCandidatePriceForCeiling,
} = {}) {
  const normalized = normalizeRecoPriceCeiling(ceiling);
  const boundedTarget = Number.isFinite(Number(target)) ? Math.max(0, Math.trunc(Number(target))) : 0;
  if (!normalized || boundedTarget <= 0) return [];
  const answer = Array.isArray(recommendations) ? recommendations : [];
  const conformingInAnswer = countRecoPriceCeilingConforming(answer, normalized, { readPrice });
  const shortfall = boundedTarget - conformingInAnswer;
  if (shortfall <= 0) return [];

  const seen = new Set();
  for (const row of answer) {
    const key = recoRowIdentityKey(row);
    if (key) seen.add(key);
  }
  const out = [];
  for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
    if (out.length >= shortfall) break;
    if (!isPlainObject(row)) continue;
    if (classifyRecoCandidateAgainstPriceCeiling(row, normalized, { readPrice }) !== 'conforming') continue;
    const key = recoRowIdentityKey(row);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(row);
  }
  return out;
}

function countRecoPriceCeilingConforming(rows, ceiling, { readPrice = readRecoCandidatePriceForCeiling, getCandidate = null } = {}) {
  const normalized = normalizeRecoPriceCeiling(ceiling);
  if (!normalized) return 0;
  const pick = typeof getCandidate === 'function' ? getCandidate : (row) => row;
  let count = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (classifyRecoCandidateAgainstPriceCeiling(pick(row), normalized, { readPrice }) === 'conforming') count += 1;
  }
  return count;
}

/**
 * Which recall query arm carries the ceiling upstream.
 *
 * ONLY the primary arm. The gateway cannot know whether the upstream treats `price_max` as a filter or
 * a hint; if it filters, a ceiling on every arm would turn "nothing conforms" into zero results, which
 * is precisely the failure this work exists to prevent. Constraining one arm and leaving the rest
 * unfiltered keeps the shortlist populated with flagged near-misses no matter which way the upstream
 * reads it.
 */
function shouldSendPriceCeilingOnQueryArm({ queryIndex = null } = {}) {
  // An ABSENT index means the caller could not tell us which arm this is, so we must not constrain it:
  // `Number(null)` is 0, which would silently make every unlabelled arm the "primary" one.
  if (queryIndex === null || queryIndex === undefined || queryIndex === '' || typeof queryIndex === 'boolean') {
    return false;
  }
  const index = Number(queryIndex);
  return Number.isFinite(index) && Math.trunc(index) === 0;
}

module.exports = {
  RECO_PRICE_CEILING_KNOWN_CURRENCIES,
  RECO_PRICE_CEILING_DEFAULT_CURRENCY,
  normalizeRecoPriceCeiling,
  formatRecoPriceCeilingCacheToken,
  readRecoCandidatePriceForCeiling,
  classifyRecoCandidateAgainstPriceCeiling,
  applyRecoPriceCeilingPreference,
  countRecoPriceCeilingConforming,
  recoRowIdentityKey,
  selectRecoPriceCeilingTopUpRows,
  shouldSendPriceCeilingOnQueryArm,
};

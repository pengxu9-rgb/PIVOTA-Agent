'use strict';

// A DECLARED currency must survive the catalog price extractor.
//
// extractCatalogCandidatePrice reads ~26 seeds, and most of them are SCALARS (price_amount,
// offer_price, sale_price, min_price, ...). A scalar carries no currency of its own, and every seed
// was handed to normalizePriceObject with a flat `fallbackCurrency: 'USD'` -- which never sees the
// ROW. So a row that explicitly declared its currency in a sibling field had that currency discarded
// and the price stamped USD: 88 GBP served as 88 USD. That is a relabel, not a loss.
//
// The shape is not hypothetical. sanitizeRecoRecallPoolCandidate (src/auroraBff/recoRecallPoolCache.js)
// deliberately FLATTENS an object price into exactly `price_amount` + `currency` so the cached row
// round-trips through the same extractor. Its comment claims "a cached candidate round-trips to the
// identical price"; that held only for USD, because the flattening is lossless and the read-back was
// not. Every non-USD product served from a cached recall pool was relabelled.
//
// Downstream, classifyRecoCandidateAgainstPriceCeiling compares by unit and is documented to return
// 'unknown' for a foreign currency precisely because this lane holds no FX rates. A USD relabel
// defeated that rule and produced a fabricated conforming/over verdict in both directions.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __internal } = require('../src/auroraBff/routes');
const { sanitizeRecoRecallPoolCandidates } = require('../src/auroraBff/recoRecallPoolCache');
const { classifyRecoCandidateAgainstPriceCeiling } = require('../src/auroraBff/recoPriceCeiling');

const priceDiag = __internal.buildRecoAssistantPromptPriceDiagnostics;
const at = (amount, currency) => ({ price: { amount, currency } });

const extract = (row) => __internal.extractCatalogCandidatePrice(row);
const IDENT = { product_id: 'p1', merchant_id: 'm1', name: 'London Serum' };
const USD40 = Object.freeze({ limit: 40, currency: 'USD' });

// Every SCALAR seed the extractor reads, paired with each sibling key that can declare the currency.
test('a declared currency survives EVERY scalar seed and every sibling currency key', () => {
  const SCALAR_SEEDS = [
    'price', 'price_amount', 'priceAmount', 'price_value', 'priceValue',
    'offer_price', 'offerPrice', 'sale_price', 'salePrice',
    'list_price', 'listPrice', 'min_price', 'minPrice', 'max_price', 'maxPrice',
  ];
  const CURRENCY_KEYS = ['currency', 'currency_code', 'currencyCode', 'price_currency', 'priceCurrency'];
  const relabelled = [];
  for (const seed of SCALAR_SEEDS) {
    for (const key of CURRENCY_KEYS) {
      const got = extract({ ...IDENT, [seed]: 88, [key]: 'GBP' });
      if (!got || got.currency !== 'GBP') relabelled.push(`${seed}+${key}=${got && got.currency}`);
    }
  }
  // Guard the guard: an empty loop would pass vacuously.
  assert.equal(SCALAR_SEEDS.length * CURRENCY_KEYS.length, 75, 'every scalar seed x currency key pair is covered');
  // Mutant killed: reverting to a flat `fallbackCurrency: 'USD'` -- every pair relabels to USD.
  assert.deepEqual(relabelled, [], `these shapes relabelled a declared GBP price: ${relabelled.join(', ')}`);
});

// GUARD, not a regression test: this passes against the pre-fix code too (which also did not
// override). It exists to kill the override mutants, and is labelled so nobody reads it as evidence
// that the bug is fixed.
test('the currency is a FALLBACK, never an override', () => {
  // A currency carried by the seed itself outranks the row's.
  assert.equal(extract({ ...IDENT, price: { amount: 88, currency: 'EUR' }, currency: 'GBP' }).currency, 'EUR');
  // A price string's own symbol still wins -- inferCurrencyFromPriceText runs before the fallback.
  assert.equal(extract({ ...IDENT, price: '£88', currency: 'JPY' }).currency, 'GBP');
  // Mutant killed: using the row currency as an override would return GBP / JPY above.
});

// The ARRAY seeds (`offers`, and any seed holding a list) go through a SEPARATE normalizePriceObject
// call site, so they need their own coverage: the scalar-leg tests above cannot reach this branch.
test('an ARRAY seed also honours the row currency', () => {
  // Mutant killed: reverting only the array leg to a flat `fallbackCurrency: 'USD'` -- invisible to
  // every other test in this file, because nothing else drives a list-shaped seed.
  assert.equal(extract({ ...IDENT, offers: [{ price: 88 }], currency: 'GBP' }).currency, 'GBP');
  assert.equal(extract({ ...IDENT, offers: [{ amount: 88 }], price_currency: 'JPY' }).currency, 'JPY');
  // The seed's own currency still outranks the row's inside an array too.
  assert.equal(extract({ ...IDENT, offers: [{ price: 88, currency: 'EUR' }], currency: 'GBP' }).currency, 'EUR');
  // An array with no usable amount falls through rather than inventing one. `offers` is seeds[19], so
  // the companion seed must come AFTER it to observe the fall-through -- pairing it with price_amount
  // (seeds[1]) would short-circuit before `offers` is ever read and prove nothing.
  assert.equal(extract({ ...IDENT, offers: [{ note: 'none' }], currency: 'GBP' }), null, 'no amount, no price');
  assert.equal(extract({ ...IDENT, offers: [{ note: 'none' }], price_usd: 12 }).currency, 'USD', 'falls through to a later seed');
});

test('an absent or unrecognized row currency keeps the historical USD default', () => {
  assert.equal(extract({ ...IDENT, price_amount: 88 }).currency, 'USD', 'no currency anywhere');
  // NOTE: dropping the normalizeCurrencyCode wrapper here is an EQUIVALENT mutant -- normalizePriceObject
  // re-validates the fallback on every leg -- so these lines pin the OUTCOME, not that wrapper.
  // Mutant killed: `fallbackCurrency: 'CNY'` (or any non-USD default) in place of the historical one.
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: 'ZZZZ' }).currency, 'USD');
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: '' }).currency, 'USD');
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: '$' }).currency, 'USD');
  // A lowercase declaration is real and must be honoured, upcased.
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: 'gbp' }).currency, 'GBP');
});

// The price_usd / price_cny tail asserts its OWN unit and must NOT inherit the row's -- that would be
// the same relabel this PR fixes, pointed the other way.
// GUARD, not a regression test: this behavior was already correct and must STAY correct now that a
// row currency exists to leak into it.
test('the explicit USD/CNY seeds keep their own unit, never the row currency', () => {
  // Mutant killed: returning rowCurrency from the conversion tail. {price_usd: 50, currency: 'GBP'}
  // would become 50 GBP -- a fabricated relabel of a field whose name states its unit.
  assert.equal(extract({ ...IDENT, price_usd: 50, currency: 'GBP' }).currency, 'USD');
  assert.equal(extract({ ...IDENT, priceUsd: 50, currency: 'JPY' }).currency, 'USD');
  assert.equal(extract({ ...IDENT, price_cny: 50, currency: 'GBP' }).currency, 'CNY');
  assert.equal(extract({ ...IDENT, priceCny: 50, currency: 'GBP' }).currency, 'CNY');
});

// A BLANK or malformed alias is a non-declaration and must not swallow a real one behind it.
test('a blank or invalid currency alias falls through to the next', () => {
  // Mutant killed: `??` in the alias chain -- it only skips null/undefined, so an empty-string
  // `currency` short-circuits and a valid `price_currency` behind it is never reached.
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: '', price_currency: 'GBP' }).currency, 'GBP');
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: 'ZZZZ', price_currency: 'GBP' }).currency, 'GBP');
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: '   ', currencyCode: 'JPY' }).currency, 'JPY');
  // A VALID earlier alias still wins -- this is a fall-through, not a search for the last one.
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: 'EUR', price_currency: 'GBP' }).currency, 'EUR');
  // All blank keeps the historical default.
  assert.equal(extract({ ...IDENT, price_amount: 88, currency: '', price_currency: '' }).currency, 'USD');
});

// The NESTED carriers read the OUTER row's currency; a nested sibling currency is not consulted.
test('nested seeds inherit the row currency, and only the row currency', () => {
  for (const carrier of ['subject', 'product', 'sku']) {
    assert.equal(extract({ ...IDENT, [carrier]: { price: 88 }, currency: 'GBP' }).currency, 'GBP', carrier);
    assert.equal(
      extract({ ...IDENT, [carrier]: { offers: [{ price: 88 }] }, currency: 'JPY' }).currency, 'JPY', `${carrier}.offers`,
    );
  }
  // A carrier that DECLARES its own currency keeps it, and it outranks the row's -- the nearest
  // declaration wins, the same rule the flat seeds follow.
  // Mutant killed: reusing rowCurrency for the nested seeds. Before this, {subject: {price: 88,
  // currency: 'GBP'}} returned USD -- the identical defect one level down.
  assert.equal(extract({ ...IDENT, subject: { price: 88, currency: 'GBP' } }).currency, 'GBP');
  assert.equal(extract({ ...IDENT, subject: { price: 88, currency: 'GBP' }, currency: 'JPY' }).currency, 'GBP');
  assert.equal(extract({ ...IDENT, sku: { price: 88, price_currency: 'EUR' } }).currency, 'EUR');
  assert.equal(extract({ ...IDENT, product: { offers: [{ price: 88 }], currency: 'JPY' } }).currency, 'JPY');
  // A carrier with no declaration of its own still inherits the row's.
  assert.equal(extract({ ...IDENT, subject: { price: 88 }, currency: 'GBP' }).currency, 'GBP');
});

// The regression that motivated the fix, driven through the REAL cache sanitizer.
test('a non-USD price round-trips through the recall pool cache unchanged', () => {
  for (const [currency, amount] of [['GBP', 88], ['JPY', 4500], ['EUR', 30], ['USD', 88], ['gbp', 12]]) {
    const row = { ...IDENT, price: { amount, currency, unknown: false } };
    const before = __internal.normalizeRecoCatalogProduct(row).price;
    const cached = sanitizeRecoRecallPoolCandidates([row])[0];
    const after = __internal.normalizeRecoCatalogProduct(cached).price;
    // The cache flattening was always lossless; pin it so a change there is not misread as this bug.
    assert.equal(cached.price_amount, amount, `${currency}: the cache stores the amount`);
    assert.equal(cached.currency, currency.toUpperCase(), `${currency}: and the currency`);
    // Mutant killed: the read-back is what dropped it. 88 GBP came back as 88 USD.
    assert.deepEqual(after, before, `${currency}: a cached row must read back identically`);
  }
});

// The rule this bug defeated, stated as the ceiling module states it.
//
// SUBJECT MATTERS HERE. Handing the RAW sanitized cache row to the classifier proves nothing: the
// ceiling reader (readRecoCandidatePriceForCeiling) reads `currency` off the row itself and always
// got this right, so that assertion passes on both sides of the fix. The path this bug actually
// travelled is normalizeRecoCatalogProduct -> finalizeRecommendationCandidatePools ->
// applyRecoPriceCeilingPreference, where it is the EXTRACTOR's output that reaches the ceiling.
// Measured at the merge-base: the raw row classified 'unknown', the NORMALIZED row classified 'over'.
// So the row must be normalized here or the test is vacuous.
const normalizedFromCache = (currency, amount) =>
  __internal.normalizeRecoCatalogProduct(
    sanitizeRecoRecallPoolCandidates([{ ...IDENT, price: { amount, currency, unknown: false } }])[0],
  );

test('a foreign-currency row is UNKNOWN against a USD ceiling, never a fabricated verdict', () => {
  // Mutant killed: the relabel made 4500 JPY read as 4500 USD and classify 'over' -- a confident
  // verdict on a comparison this lane has no FX rate to make.
  assert.equal(classifyRecoCandidateAgainstPriceCeiling(normalizedFromCache('JPY', 4500), USD40), 'unknown');
  // And in the other direction: 12 GBP read as 12 USD classified 'conforming'.
  assert.equal(classifyRecoCandidateAgainstPriceCeiling(normalizedFromCache('GBP', 12), USD40), 'unknown');
  // A genuine USD row still classifies normally on both sides of the ceiling.
  assert.equal(classifyRecoCandidateAgainstPriceCeiling(normalizedFromCache('USD', 12), USD40), 'conforming');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling(normalizedFromCache('USD', 88), USD40), 'over');
});

// A grounded row's price follows its identity (#2061); pin that it now carries the right UNIT too.
test('a grounded row carries the candidate currency, not a USD relabel', () => {
  const cached = sanitizeRecoRecallPoolCandidates([
    { ...IDENT, price: { amount: 88, currency: 'GBP', unknown: false } },
  ])[0];
  const merged = __internal.mergeRecoPlanWithGroundedCandidate(
    { name: 'some treatment', step: 'Treatment' },
    cached,
  );
  assert.equal(merged.product_id, 'p1');
  assert.equal(merged.price.amount, 88);
  assert.equal(merged.price.currency, 'GBP');
  assert.equal(merged.currency, 'GBP');
});

// A price POSITION is a comparison, and this lane holds no FX rates.
//
// buildRecoAssistantPromptPriceDiagnostics sorts on the CURRENCY CODE first, then the amount, then
// labels lowest/middle/highest by position in that list. Mixed currencies therefore ranked
// alphabetically: [EUR 200, GBP 5, USD 50] made EUR 200 the "lowest" and GBP 5 the "middle". That
// reaches the buyer as price_order_summary, price_position, and a "Lower-priced same-slot option"
// tradeoff_hint (which keys off price_position_by_index, so it is closed by the same guard).
//
// This was reachable BEFORE this change through an object price that declared its currency -- so it
// is pre-existing, not introduced here -- but this change makes it reachable on the common path,
// because a scalar price beside a sibling currency now keeps its unit too. Fixed here rather than
// left to widen.
test('a mixed-currency shortlist gets NO price positions, not alphabetical ones', () => {
  const mixed = priceDiag([at(200, 'EUR'), at(5, 'GBP'), at(50, 'USD')]);
  // Mutant killed: dropping the distinctCurrencies guard. Without it EUR 200 is labelled 'lowest'
  // and GBP 5 'middle' -- a confident ordering of amounts in units that cannot be compared.
  assert.equal(mixed.price_position_by_index.size, 0, 'no positions at all');
  assert.deepEqual(mixed.price_order_summary, [], 'and nothing to summarise');
  assert.equal(mixed.price_comparison_skipped_reason, 'mixed_currency');
  assert.equal(mixed.known_price_count, 3, 'the prices are still counted, just not ranked');

  // The two-item shape uses lower/higher and is closed by the same guard.
  const two = priceDiag([at(4500, 'JPY'), at(50, 'USD')]);
  assert.equal(two.price_position_by_index.size, 0);
  assert.equal(two.price_comparison_skipped_reason, 'mixed_currency');
});

// GUARD, not a regression test: single-currency ranking must be completely unaffected.
test('a single-currency shortlist still ranks exactly as before', () => {
  const usd = priceDiag([at(5, 'USD'), at(50, 'USD'), at(200, 'USD')]);
  assert.deepEqual([...usd.price_position_by_index.values()], ['lowest', 'middle', 'highest']);
  assert.equal(usd.price_order_summary.length, 3);
  assert.equal(usd.price_comparison_skipped_reason, undefined);
  // Mutant killed: skipping the comparison whenever ANY currency is present rather than more than one.
  const gbp = priceDiag([at(5, 'GBP'), at(50, 'GBP')]);
  assert.deepEqual([...gbp.price_position_by_index.values()], ['lower', 'higher']);
  // Identical prices in one currency are 'similar', not ranked.
  const same = priceDiag([at(50, 'GBP'), at(50, 'GBP')]);
  assert.deepEqual([...same.price_position_by_index.values()], ['similar', 'similar']);
});

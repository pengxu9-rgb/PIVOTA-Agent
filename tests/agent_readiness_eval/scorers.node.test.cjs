'use strict';

// FIRST: no test in this directory may reach a non-loopback host (see _net_guard.cjs).
require('./_net_guard.cjs');

// Deterministic scorers for the readiness eval: relevance rules, negation ("X-free"), currency vs market,
// price/link integrity, duplicates, shade presence, consistency, offer/search price agreement, negatives.
// Products here are invented.

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../../scripts/agent-readiness-eval/lib/scorers.cjs');
const { normalizeProduct } = require('../../scripts/agent-readiness-eval/lib/responses.cjs');

const P = (o) => normalizeProduct({ product_id: o.id || 'sig_x', ...o });
const LIP = ['lipstick', 'lip', 'rouge', '口红', 'リップ', '립스틱'];
const NIA = ['niacinamide', 'nicotinamide', '烟酰胺'];
const FRAG = ['fragrance', 'parfum', 'perfume', 'scent', 'scented', '香精'];
const ALC = ['alcohol', 'ethanol'];

test('normalization folds case, accents, hyphens and full-width forms', () => {
  assert.equal(S.norm('Rouge à Lèvres'), 'rouge a levres');
  assert.equal(S.norm('Fragrance-Free'), 'fragrance free');
  assert.equal(S.norm('ＳＰＦ５０'), 'spf50');
  assert.equal(S.norm('레드 립스틱'), '레드 립스틱', 'Hangul survives the decompose/recompose');
  assert.equal(S.norm('マットな赤リップ'), 'マットな赤リップ', 'kana with voicing marks survive');
});

test('term matching: latin needs a leading word boundary, CJK is substring', () => {
  assert.equal(S.containsAny(S.norm('Velvet Lipstick'), ['lip']), true);
  assert.equal(S.containsAny(S.norm('Tulip Hand Cream'), ['lip']), false, '"lip" inside "tulip" is not a lip product');
  assert.equal(S.containsAny(S.norm('马特口红'), ['口红']), true);
});

test('category check: title/category pass, description only when nothing else is known', () => {
  assert.equal(S.checkCategory(P({ title: 'Satin Lipstick', category: 'Makeup' }), LIP), 'pass');
  assert.equal(S.checkCategory(P({ title: 'Hydra Gel', category: 'Moisturizer' }), LIP), 'fail');
  assert.equal(S.checkCategory(P({ title: 'No. 5', description: 'A creamy lipstick.' }), LIP), 'pass');
  assert.equal(S.checkCategory(P({ title: 'No. 5', category: 'Fragrance', description: 'Pairs with any lipstick.' }), LIP), 'fail');
});

test('ingredient check: pass on title/actives/INCI, fail when data exists without it, unknown when no data', () => {
  assert.equal(S.checkIngredientGroup(P({ title: '10% Niacinamide Serum' }), NIA), 'pass');
  assert.equal(S.checkIngredientGroup(P({ title: 'Serum', key_actives: ['Nicotinamide'] }), NIA), 'pass');
  assert.equal(S.checkIngredientGroup(P({ title: 'Serum', key_actives: ['Retinol'] }), NIA), 'fail');
  assert.equal(S.checkIngredientGroup(P({ title: 'Serum' }), NIA), 'unknown');
  assert.equal(S.checkIngredientGroup(P({ title: 'Niacinamide-free serum', key_actives: ['Retinol'] }), NIA), 'fail', 'a negated mention is not the ingredient');
});

test('negation: "X-free", "free of X", "without X", "sans X", "无X" state absence; INCI mention is presence', () => {
  assert.equal(S.checkExcludeGroup(P({ title: 'Fragrance-Free Daily Moisturizer' }), FRAG), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: 'Moisturizer', description: 'Free of fragrance and dyes.' }), FRAG), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: 'Moisturizer', description: 'Made without perfume.' }), FRAG), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: 'Crème sans parfum' }), FRAG), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: '无香精保湿霜' }), FRAG), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: 'Moisturizer', ingredients: ['Aqua', 'Glycerin', 'Parfum'] }), FRAG), 'fail');
  assert.equal(S.checkExcludeGroup(P({ title: 'Rose Scented Body Lotion' }), FRAG), 'fail');
  assert.equal(S.checkExcludeGroup(P({ title: 'Moisturizer', ingredients: ['Aqua', 'Glycerin'] }), FRAG), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: 'Moisturizer' }), FRAG), 'unknown');
  assert.equal(S.checkExcludeGroup(P({ title: 'Moisturizer', description: 'A light fragrance of rose.' }), FRAG), 'fail');
});

test('negation: fatty alcohols do not violate "alcohol-free"; drying alcohol does', () => {
  assert.equal(S.checkExcludeGroup(P({ title: 'Alcohol-Free Toner', ingredients: ['Water', 'Cetyl Alcohol', 'Glycerin'] }), ALC), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: 'Toner', ingredients: ['Water', 'Alcohol Denat.', 'Glycerin'] }), ALC), 'fail');
});

test('brand check: brand field, else a title that starts with the brand', () => {
  assert.equal(S.checkBrand(P({ title: 'Serum', brand: 'Fixture Lab' }), ['fixture lab']), 'pass');
  assert.equal(S.checkBrand(P({ title: 'Fixture Lab Serum', brand: '' }), ['fixture lab']), 'pass');
  assert.equal(S.checkBrand(P({ title: 'Serum', brand: 'Other Co' }), ['fixture lab']), 'fail');
});

test('price cap: amount and currency both checked; missing price is unknown', () => {
  assert.equal(S.checkPriceMax(P({ price: 19.99, currency: 'USD' }), 20, 'USD'), 'pass');
  assert.equal(S.checkPriceMax(P({ price: 24, currency: 'USD' }), 20, 'USD'), 'fail');
  assert.equal(S.checkPriceMax(P({ price: 15, currency: 'SGD' }), 20, 'USD'), 'fail', 'a cap in USD is not met by an SGD price');
  assert.equal(S.checkPriceMax(P({}), 20, 'USD'), 'unknown');
});

test('scoreRelevance: precision@k over pass verdicts, unknown reported separately, query_pass by threshold', () => {
  const expect = { category: LIP, price_max: 20, currency: 'USD' };
  const products = [
    P({ id: 'a', title: 'Matte Lipstick', price: 12, currency: 'USD' }),
    P({ id: 'b', title: 'Satin Lipstick', price: 25, currency: 'USD' }),
    P({ id: 'c', title: 'Lip Liner' }),
    P({ id: 'd', title: 'Lipstick Duo', price: 18, currency: 'USD' }),
    P({ id: 'e', title: 'Hand Cream', price: 8, currency: 'USD' }),
  ];
  const r = S.scoreRelevance(products, expect, { topK: 5, passThreshold: 0.6 });
  assert.equal(r.pass, 2);
  assert.equal(r.unknown, 1);
  assert.equal(r.fail, 2);
  assert.equal(r.precision, 0.4);
  assert.equal(r.query_pass, false);
  assert.deepEqual(r.failed_checks, { price_max: 1, category: 1 });
  assert.equal(S.scoreRelevance([], expect), null, 'empty pages are scored by zero-result rate, not relevance');
});

test('scoreNegative: non-beauty/nonsense pass only when empty; unsafe passes unless a row affirms the hazard', () => {
  assert.equal(S.scoreNegative('non_beauty', []).pass, true);
  assert.equal(S.scoreNegative('non_beauty', [P({ title: 'Lipstick' })]).pass, false);
  assert.equal(S.scoreNegative('nonsense', [], {}, { toolError: true }).reason, 'tool_error');
  const terms = { unsafe_terms: ['mercury'] };
  assert.equal(S.scoreNegative('unsafe', [P({ title: 'Brightening Cream' })], terms).pass, true);
  assert.equal(S.scoreNegative('unsafe', [P({ title: 'Mercury-Free Brightening Cream' })], terms).pass, true);
  assert.equal(S.scoreNegative('unsafe', [P({ title: 'Whitening Cream', ingredients: ['Mercury'] })], terms).pass, false);
});

test('scoreRows: currency vs market, missing/non-positive/invalid price, malformed link', () => {
  const rows = S.scoreRows(
    [
      P({ title: 'a', price: 10, currency: 'SGD', pivota_url: 'https://agent.fixture.example/products/a' }),
      P({ title: 'b', price: 10, currency: 'USD', pivota_url: 'https://agent.fixture.example/products/b' }),
      P({ title: 'c', pivota_url: 'https://agent.fixture.example/products/undefined' }),
      P({ title: 'd', price: 0, currency: 'SGD' }),
      P({ title: 'e', price: 5, currency: '$', pivota_url: 'https://agent.fixture.example/products/e' }),
    ],
    { market: 'SG' },
  );
  assert.equal(rows.rows, 5);
  assert.equal(rows.currency_checked, 3);
  assert.equal(rows.currency_market_mismatch, 1);
  assert.equal(rows.missing_price, 1);
  assert.equal(rows.non_positive_price, 1);
  assert.equal(rows.invalid_currency, 1);
  assert.equal(rows.missing_link, 2);
  assert.deepEqual(rows.link_problems, { placeholder_segment: 1, missing: 1 });
  assert.equal(S.scoreRows([P({ price: 10, currency: 'USD' })], { market: null }).currency_checked, 0, 'no market, nothing to check');
});

test('duplicates by id and by brand+title; shade presence', () => {
  const d = S.findDuplicates([P({ id: '1', title: 'A', brand: 'X' }), P({ id: '1', title: 'B', brand: 'X' }), P({ id: '3', title: 'a', brand: 'x' })]);
  assert.deepEqual(d.map((x) => x.kind).sort(), ['id', 'name']);
  assert.equal(S.shadePresence(P({ variants: [{ title: 'Ruby' }] })), 'present');
  assert.equal(S.shadePresence(P({ variants: [] })), 'empty');
  assert.equal(S.shadePresence(P({})), 'absent');
});

test('consistency: Jaccard over top-k, same-order flag', () => {
  assert.deepEqual(S.scoreConsistency([['a', 'b', 'c'], ['a', 'b', 'c']]), { min_jaccard: 1, same_order: true, stable: true });
  const r = S.scoreConsistency([['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', 'f']]);
  assert.equal(r.stable, false);
  assert.equal(Math.round(r.min_jaccard * 100) / 100, 0.67);
  assert.equal(S.scoreConsistency([['a', 'b'], ['b', 'a']]).same_order, false);
  assert.equal(S.scoreConsistency([['a']]), null);
});

test('price agreement compares same-currency prices within tolerance only', () => {
  const p = (amount, currency) => ({ amount, currency, currencyValid: /^[A-Z]{3}$/.test(currency) });
  assert.equal(S.priceAgreement(p(20, 'USD'), p(20.5, 'USD'), 0.05).agree, true);
  assert.equal(S.priceAgreement(p(20, 'USD'), p(25, 'USD'), 0.05).agree, false);
  assert.equal(S.priceAgreement(p(20, 'USD'), p(20, 'SGD')).comparable, false);
  assert.equal(S.priceAgreement(null, p(20, 'USD')).comparable, false);
});

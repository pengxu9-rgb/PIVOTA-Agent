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

test('term matching: latin needs word boundaries on both sides (plural s/es allowed), CJK is substring', () => {
  assert.equal(S.containsAny(S.norm('Velvet Lipstick'), ['lip']), false, 'the category groups list "lipstick" itself');
  assert.equal(S.containsAny(S.norm('Velvet Lipsticks'), ['lipstick']), true);
  assert.equal(S.containsAny(S.norm('Lip Balm'), ['lip']), true);
  assert.equal(S.containsAny(S.norm('Brushes'), ['brush']), true);
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

test('S7: a negation cue scopes over a list: "free of A, B, and C" is free of each', () => {
  for (const t of ['Free of parabens, sulfates, and fragrance.', 'Made without parabens, sulfates or fragrance', 'No added fragrance', 'Does not contain fragrance', 'Paraben- and fragrance-free']) {
    assert.equal(S.checkExcludeGroup(P({ title: 'Cream', description: t }), FRAG), 'pass', t);
    assert.equal(S.containsAffirmed(S.norm(t), ['paraben', 'parabens']), false, `${t} (parabens)`);
  }
  // The scope ends at a word that reintroduces content, and at a sentence end.
  assert.equal(S.checkExcludeGroup(P({ title: 'Cream', description: 'Free of parabens with a light rose fragrance.' }), FRAG), 'fail');
  assert.equal(S.checkExcludeGroup(P({ title: 'Cream', description: 'No parabens. Contains fragrance.' }), FRAG), 'fail');
});

test('S2/S7: the bare "no" cue negates (kills the NEG_BEFORE "no" mutant)', () => {
  assert.equal(S.statesAbsence(S.norm('no fragrance'), FRAG), true);
  assert.equal(S.containsAffirmed(S.norm('Moisturizer with no fragrance'), FRAG), false);
  assert.equal(S.checkExcludeGroup(P({ title: 'Moisturizer with no fragrance' }), FRAG), 'pass');
});

test('S7: "scent" does not match "scentless"; "scentless" and "unscented" state absence', () => {
  assert.equal(S.occurrences(S.norm('Scentless lotion'), 'scent').length, 0);
  assert.equal(S.occurrences(S.norm('light scents'), 'scent').length, 1, 'plural still matches');
  assert.equal(S.checkExcludeGroup(P({ title: 'Scentless Lotion' }), FRAG), 'pass');
  assert.equal(S.checkExcludeGroup(P({ title: 'Unscented Body Lotion' }), FRAG), 'pass');
});

test('S7: "Retinol Alternative Bakuchiol" is NOT retinol; neither is "gentler than retinol"', () => {
  const RET = ['retinol', 'retinal', 'retinoid', 'retinyl'];
  assert.notEqual(S.checkIngredientGroup(P({ title: 'Retinol Alternative Bakuchiol Serum' }), RET), 'pass');
  assert.equal(S.checkIngredientGroup(P({ title: 'Retinol Alternative Bakuchiol Serum', key_actives: ['Bakuchiol'] }), RET), 'fail');
  assert.notEqual(S.checkIngredientGroup(P({ title: 'Serum', description: 'Gentler than retinol.' }), RET), 'pass');
  assert.equal(S.checkIngredientGroup(P({ title: '0.3% Retinol Serum' }), RET), 'pass');
});

test('S8: a price cap with an unknown currency is unknown, never pass', () => {
  assert.equal(S.checkPriceMax(P({ price: 10 }), 20, 'USD'), 'unknown', 'row has no currency');
  assert.equal(S.checkPriceMax(P({ price: 10, currency: '$' }), 20, 'USD'), 'unknown', 'row currency invalid');
  assert.equal(S.checkPriceMax(P({ price: 10, currency: 'USD' }), 20, null), 'unknown', 'cap has no currency');
  assert.equal(S.checkPriceMax(P({ price: 10, currency: 'USD' }), 20, 'USD'), 'pass');
});

test('S6: no-market rows are still checked, and their currencies are recorded (a silent US default is visible)', () => {
  const rows = S.scoreRows(
    [P({ price: 10, currency: 'USD', pivota_url: 'https://a.example/p/1' }), P({ price: 12, currency: 'USD' }), P({ price: 0, currency: 'SGD', pivota_url: 'https://a.example/p/3' })],
    { market: null },
  );
  assert.equal(rows.currency_checked, 0);
  assert.equal(rows.no_market_rows, 3);
  assert.deepEqual(rows.no_market_currency, { USD: 2, SGD: 1 });
  assert.equal(rows.missing_link, 1, 'link still checked without a market');
  assert.equal(rows.non_positive_price, 1, 'price still checked without a market');
  assert.equal(rows.mixed_currency_pages, 1);
  const { computeMetrics } = require('../../scripts/agent-readiness-eval/lib/report.cjs');
  const usdOnly = S.scoreRows([P({ price: 10, currency: 'USD' }), P({ price: 11, currency: 'USD' })], { market: null });
  const m = computeMetrics(
    { calls: [], discovery: [{ query_id: 'q', class: 'c', lang: 'en', market: null, result_count: 2, rows: usdOnly, relevance: null, duplicates: 0 }], follow: [], recommend: [], consistency: [], skipped_tools: [] },
    { tier: 'public', targetKind: 'local', endpoint: 'http://127.0.0.1:1/public/mcp' },
  );
  const f = m.findings.find((x) => x.key === 'no_market_currency');
  assert.equal(f.severity, 'warn');
  assert.match(f.text, /default to the US market silently/);
});

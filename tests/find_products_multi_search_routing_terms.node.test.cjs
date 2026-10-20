'use strict';

// Routing-layer vocabulary for find_products_multi (default-off flags):
//   FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING  src/findProductsMulti/strictIngredientQuery.js
//   FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING     src/findProductsMulti/multilingualBeautyTerms.js
// composed by src/findProductsMulti/queryRoutingNormalizer.js. The route-level behaviour (which lane,
// which rows) is pinned in tests/integration/invoke.find_products_multi_search_routing.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const strict = require('../src/findProductsMulti/strictIngredientQuery');
const multilingual = require('../src/findProductsMulti/multilingualBeautyTerms');
const normalizer = require('../src/findProductsMulti/queryRoutingNormalizer');

const BOTH_ON = {
  FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on',
  FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on',
};

test('flags: off unless set to on/true/1/yes', () => {
  for (const value of [undefined, '', 'off', 'false', '0', 'observe', 'enabled']) {
    const env = value === undefined ? {} : { FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: value };
    assert.equal(strict.isBareIngredientRoutingEnabled(env), false, String(value));
    const env2 = value === undefined ? {} : { FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: value };
    assert.equal(multilingual.isMultilingualRoutingEnabled(env2), false, String(value));
  }
  for (const value of ['on', 'ON', 'true', '1', 'yes']) {
    assert.equal(strict.isBareIngredientRoutingEnabled({ FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: value }), true);
    assert.equal(multilingual.isMultilingualRoutingEnabled({ FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: value }), true);
  }
});

test('both flags off: the query is returned untouched, whatever it is', () => {
  for (const query of ['선크림', 'crème hydratante', 'moisturizer without retinol', 'retinol', '  洗面奶 ']) {
    const out = normalizer.normalizeFindProductsMultiRoutingQuery(query, {});
    assert.equal(out.query, query);
    assert.equal(out.changed, false);
    assert.deepEqual(normalizer.buildRoutingQueryLogFields(out), {});
  }
});

test('bare strict-ingredient queries: only table ingredients plus filler, never negated', () => {
  for (const query of ['retinol', 'Retinol', 'HYALURONIC ACID', 'niacinamide', 'vitamin c', 'ascorbic acid',
    'salicylic acid', 'ceramide', 'ceramides', 'ceramide np', 'azelaic acid', 'benzoyl peroxide', 'panthenol',
    'glycerin', 'zinc pca', 'best niacinamide products', 'products with retinol', 'niacinamide zinc pca']) {
    assert.equal(strict.isBareStrictIngredientQuery(query), true, query);
  }
  for (const query of ['retinol serum', 'retinol cream', 'retinol-free', 'retinol free', 'without retinol',
    'no retinol', 'retinol alternative', 'vitamin c supplement', 'hyaluronic', 'peptides', 'bha', 'serum', '',
    'retinol for pregnancy']) {
    assert.equal(strict.isBareStrictIngredientQuery(query), false, query);
  }
});

test('negated ingredient mentions are not ingredient intents', () => {
  const cases = {
    retinol: ['retinol'],
    'retinol serum': ['retinol'],
    'retinol-free moisturizer': [],
    'retinol free': [],
    'without retinol': [],
    'moisturizer without any retinol': [],
    'no retinol serum': [],
    'avoid retinol': [],
    'free of retinol': [],
    'free from retinol': [],
    'retinol alternative serum': [],
    'alternative to retinol': [],
    'niacinamide serum without retinol': ['niacinamide'],
    'salicylic acid free cleanser': [],
    'niacinamide-free serum': [],
  };
  for (const [query, expected] of Object.entries(cases)) {
    assert.deepEqual(strict.extractPositiveStrictIngredientIds(query), expected, query);
  }
});

test('English negation phrasing becomes "<ingredient>-free" (the form the contract reads)', () => {
  const cases = {
    'moisturizer without retinol': 'moisturizer retinol-free',
    'without any retinol': 'retinol-free',
    'no retinol serum': 'retinol-free serum',
    'avoid retinol': 'retinol-free',
    'cleanser free of salicylic acid': 'cleanser salicylic acid-free',
    'retinol free cream': 'retinol-free cream',
    'retinol-free cream': 'retinol-free cream',
    'retinol serum': 'retinol serum',
    'No7 serum': 'No7 serum',
  };
  for (const [query, expected] of Object.entries(cases)) {
    assert.equal(strict.canonicalizeEnglishIngredientNegations(query).query, expected, query);
  }
});

test('product naming: word boundaries, structured fields only, negations and "alternative" rejected', () => {
  const product = (title, extra = {}) => ({ title, ...extra });
  const cases = [
    // Negations and stand-ins do not name the ingredient.
    [product('Retinol-Free Gentle Night Serum'), 'retinol', 'negated_only'],
    [product('Bakuchiol Retinol Alternative Serum', { active_ingredients: ['bakuchiol'] }), 'retinol', 'negated_only'],
    [product('Alternative to Retinol Night Cream'), 'retinol', 'negated_only'],
    [product('No Retinol Night Cream'), 'retinol', 'negated_only'],
    [product('Night Cream Free of Retinol'), 'retinol', 'negated_only'],
    // A bare "vitamin" never names vitamin C.
    [product('Vitamin E Serum'), 'ascorbic_acid', 'absent'],
    [product('Vitamin B5 Hydrating Serum'), 'ascorbic_acid', 'absent'],
    [product('Vitamin C+E Serum'), 'ascorbic_acid', 'named'],
    [product('15% L-Ascorbic Acid Serum'), 'ascorbic_acid', 'named'],
    // Description and derived (description-sourced) ingredient tokens are not evidence.
    [product('Night Serum', { description: 'Free of retinol.', ingredient_tokens: ['retinol'],
      external_seed_recall: { ingredient_tokens: ['retinol'] } }), 'retinol', 'absent'],
    // Structured fields are, each on its own: a negator ending one field cannot reach the next.
    [product('Night Serum', { ingredients_inci: ['Aqua', 'Retinol', 'Glycerin'] }), 'retinol', 'named'],
    [product('Shade No', { active_ingredients: ['retinol'] }), 'retinol', 'named'],
    [product('Night Serum', { product_payload: { seed_data: { active_ingredients: ['Hyaluronic Acid'] } } }), 'hyaluronic_acid', 'named'],
    [product('Night Serum', { ingredient_intel: { active_ingredients: ['niacinamide'] } }), 'niacinamide', 'named'],
    [product('Cream', { ingredient_ids: ['retinol'] }), 'retinol', 'named'],
    // A positive mention anywhere wins over a negated one elsewhere.
    [product('Retinol 1% Serum', { key_ingredients: ['retinol-free base'] }), 'retinol', 'named'],
    [product('Retinoloid Serum'), 'retinol', 'absent'],
  ];
  for (const [item, id, expected] of cases) {
    assert.equal(strict.productIngredientMention(item, id), expected, `${item.title} / ${id}`);
  }
});

test('lane admission keeps only rows that name every queried ingredient', () => {
  const rows = [
    { title: 'Retinol 0.3% Night Serum' },
    { title: 'Retinol-Free Gentle Night Serum' },
    { title: 'Bakuchiol Retinol Alternative Serum' },
    { title: 'Hyaluronic Acid Serum' },
    { title: 'Night Serum', ingredient_tokens: ['retinol'], description: 'free of retinol' },
    { title: 'Retinol + Niacinamide Serum' },
  ];
  const one = strict.admitIngredientLaneProducts(rows, { ingredientIds: ['retinol'] });
  assert.deepEqual(one.products.map((row) => row.title), ['Retinol 0.3% Night Serum', 'Retinol + Niacinamide Serum']);
  assert.equal(one.dropped_count, 4);
  const two = strict.admitIngredientLaneProducts(rows, { ingredientIds: ['retinol', 'niacinamide'] });
  assert.deepEqual(two.products.map((row) => row.title), ['Retinol + Niacinamide Serum']);
  const none = strict.admitIngredientLaneProducts(rows, { ingredientIds: [] });
  assert.equal(none.products, rows);
});

test('multilingual table: every alias maps to exactly one English term', () => {
  // buildEntries throws at load on a conflict; this pins that the loaded table is conflict-free and
  // that ambiguous words are absent.
  const keys = new Set(multilingual._entries.map((entry) => entry.key));
  assert.equal(keys.size, multilingual._entries.length);
  for (const ambiguous of ['creme', '크림', '마스크', 'mascarilla', 'base', 'sonnenschutz', '唇膏', 'チーク',
    'mascara', 'limpiador', 'nettoyant', 'tonique', 'acondicionador', 'peeling', '気垫', '气垫', '틴트', 'crema']) {
    assert.equal(keys.has(ambiguous), false, ambiguous);
  }
});

test('multilingual terms map to the English routing vocabulary', () => {
  const cases = {
    // product types
    洗面奶: 'cleanser',
    洁面: 'cleanser',
    洗面乳: 'cleanser',
    保濕霜: 'moisturizer',
    防曬霜: 'sunscreen',
    化粧水: 'toner',
    日焼け止め: 'sunscreen',
    美容液: 'serum',
    선크림: 'sunscreen',
    '자외선 차단제': 'sunscreen',
    '선크림을 추천': 'sunscreen 추천',
    폼클렌징: 'cleansing foam',
    'crème hydratante': 'moisturizer',
    'creme hydratante': 'moisturizer',
    hydratant: 'moisturizer',
    'sérum hydratant': 'serum hydrating',
    'rouge à lèvres': 'lipstick',
    'après-shampooing': 'conditioner',
    'eau de parfum': 'eau de parfum',
    'crema hidratante': 'moisturizer',
    hidratante: 'moisturizer',
    'protector solar': 'sunscreen',
    'bálsamo labial': 'lip balm',
    Feuchtigkeitscreme: 'moisturizer',
    Sonnencreme: 'sunscreen',
    Haarspülung: 'conditioner',
    Haarspuelung: 'conditioner',
    // ingredients
    视黄醇: 'retinol',
    玻尿酸: 'hyaluronic acid',
    煙醯胺: 'niacinamide',
    维C精华: 'vitamin c serum',
    レチノール: 'retinol',
    'ビタミンＣ': 'vitamin c',
    레티놀: 'retinol',
    '비타민 C': 'vitamin c',
    rétinol: 'retinol',
    'acide hyaluronique': 'hyaluronic acid',
    'ácido hialurónico': 'hyaluronic acid',
    niacinamida: 'niacinamide',
    Hyaluronsäure: 'hyaluronic acid',
    Hyaluronsaeure: 'hyaluronic acid',
    '레티놀 세럼': 'retinol serum',
    视黄醇精华: 'retinol serum',
    // negations keep their meaning
    '不含视黄醇 面霜': 'retinol-free face cream',
    'sans rétinol': 'retinol-free',
    'sin retinol': 'retinol-free',
    'ohne Retinol': 'retinol-free',
    retinolfrei: 'retinol-free',
    '레티놀 없는 크림': 'retinol-free 크림',
    レチノールフリー: 'retinol-free',
    'sans parfum': 'fragrance-free',
    無香料: 'fragrance-free',
  };
  for (const [query, expected] of Object.entries(cases)) {
    assert.equal(multilingual.normalizeMultilingualBeautyTerms(query).query, expected, query);
  }
});

test('multilingual: unknown, ambiguous, non-beauty and English queries are left as typed', () => {
  for (const query of ['máscara', 'crème', '크림', '마스크', 'Sonnenschutz', 'limpiador de cocina',
    'acondicionador de aire', '프린터 토너', '토너 카트리지', 'creme brulee', 'laptop', 'running shoes', 'Laufschuhe',
    '운동화', '笔记本电脑', 'retinol', 'Retinol', 'niacinamide serum', 'moisturizer', 'peeling skin cream', 'No7',
    // A Latin term only matches a whole word: "deo" is not inside "rodeo", "labial" not inside "bilabial".
    'rodeo boots', 'bilabial', 'superserum']) {
    const out = multilingual.normalizeMultilingualBeautyTerms(query);
    assert.equal(out.query, query, query);
    assert.equal(out.applied, false, query);
  }
});

test('composition: multilingual then English negation; log fields carry counts, never text', () => {
  const out = normalizer.normalizeFindProductsMultiRoutingQuery('레티놀 세럼', BOTH_ON);
  assert.equal(out.query, 'retinol serum');
  const fields = normalizer.buildRoutingQueryLogFields(out);
  assert.deepEqual(fields, {
    fpm_routing_query_normalized: true,
    fpm_routing_query_terms_mapped: 2,
    fpm_routing_query_term_kinds: ['ingredient', 'term'],
  });
  assert.equal(JSON.stringify(fields).includes('retinol'), false);

  const negation = normalizer.normalizeFindProductsMultiRoutingQuery('moisturizer without retinol', {
    FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on',
  });
  assert.equal(negation.query, 'moisturizer retinol-free');
  assert.equal(normalizer.buildRoutingQueryLogFields(negation).fpm_routing_query_negation, true);

  // Each flag only does its own job.
  assert.equal(
    normalizer.normalizeFindProductsMultiRoutingQuery('선크림', { FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on' }).query,
    '선크림',
  );
  assert.equal(
    normalizer.normalizeFindProductsMultiRoutingQuery('moisturizer without retinol', {
      FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on',
    }).query,
    'moisturizer without retinol',
  );
});

test('applyRoutingQueryToPayload writes search.query (or a top-level query) only when changed', () => {
  const payload = { search: { query: '선크림', page: 1 } };
  const changed = normalizer.normalizeFindProductsMultiRoutingQuery('선크림', BOTH_ON);
  assert.equal(normalizer.applyRoutingQueryToPayload(payload, changed), true);
  assert.deepEqual(payload, { search: { query: 'sunscreen', page: 1 } });
  const topLevel = { query: '선크림' };
  assert.equal(normalizer.applyRoutingQueryToPayload(topLevel, changed), true);
  assert.equal(topLevel.query, 'sunscreen');
  const unchanged = normalizer.normalizeFindProductsMultiRoutingQuery('sunscreen', BOTH_ON);
  const untouched = { search: { query: 'sunscreen' } };
  assert.equal(normalizer.applyRoutingQueryToPayload(untouched, unchanged), false);
});

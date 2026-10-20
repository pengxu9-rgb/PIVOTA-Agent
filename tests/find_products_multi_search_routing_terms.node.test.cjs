'use strict';

// Loopback-only: nothing in this file (or a mutant of the code it tests) can reach a real host.
const netGuard = require('./search_routing_net_guard.cjs');

// Routing-layer vocabulary for find_products_multi (flags off | observe | on, default off):
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
const BOTH_OBSERVE = {
  FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'observe',
  FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'observe',
};

test.after(() => {
  assert.deepEqual(netGuard.state.blocked, [], 'no test may attempt a non-loopback connection');
});

test('flags: off | observe | on; anything else is off', () => {
  const cases = { undefined: 'off', '': 'off', off: 'off', false: 'off', 0: 'off', enabled: 'off',
    observe: 'observe', shadow: 'observe', OBSERVE: 'observe', on: 'on', ON: 'on', true: 'on', 1: 'on', yes: 'on' };
  for (const [value, expected] of Object.entries(cases)) {
    const env = value === 'undefined' ? {} : {
      FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: value,
      FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: value,
    };
    assert.equal(strict.bareIngredientRoutingMode(env), expected, value);
    assert.equal(multilingual.multilingualRoutingMode(env), expected, value);
    assert.equal(strict.isBareIngredientRoutingEnabled(env), expected === 'on', value);
    assert.equal(multilingual.isMultilingualRoutingEnabled(env), expected === 'on', value);
  }
});

test('both flags off: the query is returned untouched and nothing is logged', () => {
  for (const query of ['선크림', 'crème hydratante', 'moisturizer without retinol', 'retinol', '  洗面奶 ']) {
    const out = normalizer.normalizeFindProductsMultiRoutingQuery(query, {});
    assert.equal(out.query, query);
    assert.equal(out.changed, false);
    assert.equal(out.shadow.changed, false);
    assert.deepEqual(normalizer.buildRoutingQueryLogFields(out), {});
  }
});

test('observe: nothing is applied; what `on` would do is described', () => {
  const out = normalizer.normalizeFindProductsMultiRoutingQuery('선크림', BOTH_OBSERVE);
  assert.equal(out.query, '선크림');
  assert.equal(out.changed, false);
  assert.equal(out.shadow.query, 'sunscreen');
  const fields = normalizer.buildRoutingQueryLogFields(out);
  assert.equal(fields.fpm_routing_query_normalized, false);
  assert.equal(fields.fpm_routing_query_would_normalize, true);
  assert.equal(fields.fpm_routing_multilingual_mode, 'observe');
  assert.equal(JSON.stringify(fields).includes('sunscreen'), false, 'no query text in log fields');
});

test('bare strict-ingredient queries: only table ingredients plus filler, asked for positively', () => {
  for (const query of ['retinol', 'Retinol', 'HYALURONIC ACID', 'niacinamide', 'vitamin c', 'ascorbic acid',
    'salicylic acid', 'ceramide', 'ceramides', 'ceramide np', 'azelaic acid', 'benzoyl peroxide', 'panthenol',
    'glycerin', 'zinc pca', 'best niacinamide products', 'products with retinol', 'niacinamide zinc pca']) {
    assert.equal(strict.isBareStrictIngredientQuery(query), true, query);
  }
  for (const query of ['retinol serum', 'retinol cream', 'retinol-free', 'retinol free', 'without retinol',
    'no retinol', '0% retinol', 'retinol alternative', 'vitamin c supplement', 'hyaluronic', 'peptides', 'bha',
    'serum', '', 'retinol for pregnancy',
    // Normalisation is script-preserving: another script's word is a word, not nothing.
    'retinol 크림', 'retinol крем', 'retinol クリーム', 'retinol 面霜']) {
    assert.equal(strict.isBareStrictIngredientQuery(query), false, query);
  }
});

test('negated and stand-in mentions are not ingredient intents, and are exclusions', () => {
  const cases = {
    retinol: [['retinol'], []],
    'retinol serum': [['retinol'], []],
    'retinol-free moisturizer': [[], ['retinol']],
    'retinol free': [[], ['retinol']],
    'without retinol': [[], ['retinol']],
    'moisturizer without any retinol': [[], ['retinol']],
    'no retinol serum': [[], ['retinol']],
    'no-retinol serum': [[], ['retinol']],
    'zero-retinol': [[], ['retinol']],
    '0% retinol': [[], ['retinol']],
    'no added retinol': [[], ['retinol']],
    'avoid retinol': [[], ['retinol']],
    'free of retinol': [[], ['retinol']],
    'retinol alternative serum': [[], ['retinol']],
    'alternative to retinol': [[], ['retinol']],
    'better than retinol': [[], ['retinol']],
    'phyto-retinol': [[], ['retinol']],
    'retinol substitutes': [[], ['retinol']],
    'niacinamide serum without retinol': [['niacinamide'], ['retinol']],
    'salicylic acid free cleanser': [[], ['salicylic_acid']],
    'niacinamide-free serum': [[], ['niacinamide']],
    'vitamin c free serum': [[], ['ascorbic_acid']],
    // "free shipping" is not "free of retinol".
    'retinol free shipping': [['retinol'], []],
    'retinol serum free delivery': [['retinol'], []],
    // A positive mention wins.
    'retinol serum, not retinol-free': [['retinol'], []],
    bioretinol: [[], []],
  };
  for (const [query, [wanted, excluded]] of Object.entries(cases)) {
    assert.deepEqual(strict.extractPositiveStrictIngredientIds(query), wanted, `wanted: ${query}`);
    assert.deepEqual(strict.extractExcludedStrictIngredientIds(query), excluded, `excluded: ${query}`);
  }
});

test('English negation phrasing becomes "<ingredient>-free"; stand-ins and "free shipping" do not', () => {
  const cases = {
    'moisturizer without retinol': 'moisturizer retinol-free',
    'without any retinol': 'retinol-free',
    'no retinol serum': 'retinol-free serum',
    'no-retinol serum': 'retinol-free serum',
    'zero-retinol cream': 'retinol-free cream',
    '0% retinol cream': 'retinol-free cream',
    'no added retinol cream': 'retinol-free cream',
    'avoid retinol': 'retinol-free',
    'cleanser free of salicylic acid': 'cleanser salicylic acid-free',
    'retinol free cream': 'retinol-free cream',
    'retinol-free cream': 'retinol-free cream',
    'retinol free shipping': 'retinol free shipping',
    'retinol alternative serum': 'retinol alternative serum',
    'retinol serum': 'retinol serum',
    'No7 serum': 'No7 serum',
    '10% retinol': '10% retinol',
  };
  for (const [query, expected] of Object.entries(cases)) {
    assert.equal(strict.canonicalizeEnglishIngredientNegations(query).query, expected, query);
  }
});

test('product naming: fooled titles never name the ingredient', () => {
  const product = (title, extra = {}) => ({ title, ...extra });
  const notRetinol = [
    product('Retinol-Free Gentle Night Serum'),
    product('Phyto-Retinol Bakuchiol Serum', { active_ingredients: ['bakuchiol'] }),
    product('Retinol-Like Bakuchiol Night Serum'),
    product('0% Retinol Gentle Night Cream'),
    product('No Added Retinol Barrier Cream'),
    product('Retinol Replacement Serum'),
    product('Better Than Retinol Serum'),
    product('Gentler Than Retinol Night Oil'),
    product('Not Retinol, Bakuchiol'),
    product('Bakuchiol Retinol Alternative Serum', { active_ingredients: ['bakuchiol'] }),
    product('Bakuchiol Retinol-Alternative Serum'),
    product('Alternative to Retinol Night Cream'),
    product('Retinol Substitutes Serum'),
    product('Retinol Substitute Serum'),
    product('Instead of Retinol: Bakuchiol'),
    product('No Retinol Night Cream'),
    product('Night Cream Free of Retinol'),
    product('Plant-Based Retinol Serum'),
    product('Bioretinol Serum'),
    // The title's own negation vetoes an ingredient id (a contradictory row is not an answer).
    product('Retinol-Free Night Cream', { ingredient_ids: ['retinol'] }),
    // The description and DERIVED tokens are never evidence.
    product('Gentle Night Serum', { description: 'Free of retinol. Pairs well with retinol.',
      ingredient_tokens: ['retinol'], external_seed_recall: { ingredient_tokens: ['retinol'] } }),
    product('Retinoloid Serum'),
  ];
  for (const item of notRetinol) {
    assert.notEqual(strict.productIngredientMention(item, 'retinol'), 'named', item.title);
  }
  for (const title of ['Vitamin E Serum', 'Vitamin B5 Hydrating Serum']) {
    assert.notEqual(strict.productIngredientMention(product(title), 'ascorbic_acid'), 'named', title);
  }
});

test('product naming: structured fields and plain titles do name it', () => {
  const product = (title, extra = {}) => ({ title, ...extra });
  const cases = [
    [product('Retinol 0.3% Night Serum'), 'retinol'],
    [product('0.5% Retinol Serum'), 'retinol'],
    [product('Retinol Free Shipping Serum'), 'retinol'],
    [product('Vitamin C+E Serum'), 'ascorbic_acid'],
    [product('15% L-Ascorbic Acid Serum'), 'ascorbic_acid'],
    [product('Night Serum', { ingredients_inci: ['Aqua', 'Retinol', 'Glycerin'] }), 'retinol'],
    [product('Night Serum', { ingredients_inci: 'Aqua, Glycerin, Retinol, Tocopherol' }), 'retinol'],
    // Each INCI/actives entry stands alone: "Vegan" ending one entry does not qualify the next one.
    [product('Night Serum', { active_ingredients: 'Vegan, Retinol, Niacinamide' }), 'retinol'],
    [product('Night Serum', { inci_list: ['water', 'retinol'] }), 'retinol'],
    [product('Night Serum', { product_payload: { seed_data: { inci_list: ['water', 'retinol'] } } }), 'retinol'],
    [product('Night Serum', { product_payload: { seed_data: { active_ingredients: ['Hyaluronic Acid'] } } }), 'hyaluronic_acid'],
    [product('Night Serum', { ingredient_intel: { active_ingredients: ['niacinamide'] } }), 'niacinamide'],
    [product('Shade No', { active_ingredients: ['retinol'] }), 'retinol'],
    [product('Cream', { ingredient_ids: ['retinol'] }), 'retinol'],
    [product('Retinol 1% Serum', { key_ingredients: ['retinol-free base'] }), 'retinol'],
    // INCI synonyms, from structured fields only.
    [product('Hyalu B5 Serum', { ingredients_inci: 'Aqua, Sodium Hyaluronate, Panthenol' }), 'hyaluronic_acid'],
    [product('Vitamin E & C', { ingredients_inci: ['Ascorbyl Glucoside'] }), 'ascorbic_acid'],
    [product('Barrier Cream', { ingredients_inci: ['Ceramide AP', 'Water'] }), 'ceramide_np'],
  ];
  for (const [item, id] of cases) {
    assert.equal(strict.productIngredientMention(item, id), 'named', `${item.title} / ${id}`);
  }
  // A synonym in a TITLE is not evidence.
  assert.equal(strict.productIngredientMention(product('Sodium Hyaluronate Serum'), 'hyaluronic_acid'), 'absent');
});

test('lane admission keeps only rows that name every queried ingredient', () => {
  const rows = [
    { title: 'Retinol 0.3% Night Serum' },
    { title: 'Retinol-Free Gentle Night Serum' },
    { title: 'Phyto-Retinol Bakuchiol Serum' },
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

test('exclusion drops every row that names an excluded ingredient, and keeps its stand-ins', () => {
  const rows = [
    { title: 'Niacinamide 10% Serum' },
    { title: 'Daily Hydrating Serum' },
    { title: 'Brightening Serum', active_ingredients: ['niacinamide'] },
    { title: 'Niacinamide-Free Calm Serum' },
  ];
  const out = strict.excludeProductsNamingIngredients(rows, { ingredientIds: ['niacinamide'] });
  assert.deepEqual(out.products.map((row) => row.title), ['Daily Hydrating Serum', 'Niacinamide-Free Calm Serum']);
  assert.equal(out.dropped_count, 2);
});

test('bare ingredient negations name nothing to serve', () => {
  for (const query of ['retinol-free', 'retinol free', 'without retinol', '0% retinol', 'salicylic acid free',
    'retinol alternative', 'no niacinamide']) {
    assert.equal(normalizer.isBareIngredientNegationQuery(query), true, query);
  }
  for (const query of ['retinol-free moisturizer', 'salicylic acid-free cleanser', 'retinol free shipping',
    'retinol alternative serum', 'niacinamide serum without retinol', 'retinol', 'moisturizer', '']) {
    assert.equal(normalizer.isBareIngredientNegationQuery(query), false, query);
  }
});

test('a bare negation is never rewritten (it must not widen into a browse)', () => {
  for (const query of ['without retinol', 'no retinol', 'avoid retinol', 'zero retinol', '0% retinol',
    'sin retinol', 'ohne Retinol', 'sans rétinol', '레티놀 없는', '不含视黄醇']) {
    const out = normalizer.normalizeFindProductsMultiRoutingQuery(query, BOTH_ON);
    assert.equal(out.query, query, query);
    assert.equal(out.changed, false, query);
    assert.equal(out.guard, 'bare_negation_kept', query);
  }
  const withNoun = normalizer.normalizeFindProductsMultiRoutingQuery('crème hydratante sans rétinol', BOTH_ON);
  assert.equal(withNoun.query, 'moisturizer retinol-free');
});

test('multilingual table: every alias maps to exactly one English term; ambiguous words are absent', () => {
  const keys = new Set(multilingual._entries.map((entry) => entry.key));
  assert.equal(keys.size, multilingual._entries.length);
  for (const ambiguous of ['마스크', 'mascarilla', 'base', 'sonnenschutz', '唇膏', 'チーク', 'mascara', 'limpiador',
    'nettoyant', 'tonique', 'acondicionador', 'peeling', '气垫', '틴트', 'deo', 'labial', 'hyaluron', '眼霜',
    'eau de parfum']) {
    assert.equal(keys.has(ambiguous), false, ambiguous);
  }
  // Context-only entries: never mapped alone.
  for (const contextual of ['크림', 'クリーム', 'creme', 'crema']) {
    assert.equal(multilingual._entries.find((entry) => entry.key === contextual)?.contextual, true, contextual);
  }
});

test('multilingual terms map to the English routing vocabulary', () => {
  const cases = {
    洗面奶: 'cleanser',
    洁面: 'cleanser',
    洗面乳: 'cleanser',
    保濕霜: 'moisturizer',
    防曬霜: 'sunscreen',
    化粧水: 'toner',
    日焼け止め: 'sunscreen',
    日焼け止めクリーム: 'sunscreen cream',
    美容液: 'serum',
    선크림: 'sunscreen',
    '자외선 차단제': 'sunscreen',
    '선크림을 추천': 'sunscreen 추천',
    폼클렌징: 'cleansing foam',
    'crème hydratante': 'moisturizer',
    'creme hydratante': 'moisturizer',
    hydratant: 'moisturizer',
    'sérum hydratant': 'serum hydrating',
    sérum: 'serum',
    'rouge à lèvres': 'lipstick',
    'après-shampooing': 'conditioner',
    'crema hidratante': 'moisturizer',
    hidratante: 'moisturizer',
    'protector solar': 'sunscreen',
    'bálsamo labial': 'lip balm',
    'lápiz labial': 'lipstick',
    Feuchtigkeitscreme: 'moisturizer',
    Sonnencreme: 'sunscreen',
    Haarspülung: 'conditioner',
    Haarspuelung: 'conditioner',
    Parfüm: 'perfume',
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
    // the form noun is mapped next to an ingredient, so these read like English "retinol cream"
    '레티놀 크림': 'retinol cream',
    'retinol 크림': 'retinol cream',
    'レチノール クリーム': 'retinol cream',
    'crème rétinol': 'cream retinol',
    'crema con retinol': 'cream con retinol',
    // negations keep their meaning
    '不含视黄醇 面霜': 'retinol-free face cream',
    'crème sans rétinol': 'cream retinol-free',
    'sin retinol': 'retinol-free',
    'ohne Retinol': 'retinol-free',
    retinolfrei: 'retinol-free',
    '레티놀 없는 수분크림': 'retinol-free moisturizer',
    レチノールフリー: 'retinol-free',
    'sans parfum': 'fragrance-free',
    無香料: 'fragrance-free',
  };
  for (const [query, expected] of Object.entries(cases)) {
    assert.equal(multilingual.normalizeMultilingualBeautyTerms(query).query, expected, query);
  }
});

test('multilingual: English, loanword-identical, ambiguous, non-beauty and partial compounds stay as typed', () => {
  for (const query of [
    // English (and the loanwords English shares): never changed
    'retinol', 'Retinol', 'niacinamide serum', 'moisturizer', 'serum', 'ceramides moisturizer', 'ceramide cream',
    'deo spray', 'Dior Sauvage parfum', 'glycerine soap', 'panthenol', 'vitamin c serum', 'deodorant',
    'retinol free', 'retinol-free cream', 'peeling skin cream', 'No7', 'creme brulee',
    // a Latin term matches whole words only
    'rodeo boots', 'bilabial', 'superserum', 'deshidratante', 'gel deshidratante',
    // ambiguous without context
    'máscara', 'crème', '크림', '마스크', 'crema', 'Sonnenschutz',
    // non-beauty
    'limpiador de cocina', 'acondicionador de aire', '프린터 토너', '토너 카트리지', 'laptop', 'running shoes',
    'Laufschuhe', '운동화', '笔记本电脑',
    // a CJK term inside a longer compound this table does not know
    '精华水', '眼霜', '아이크림', '선크림추천', '레티놀배합', 'retinol крем',
  ]) {
    const out = multilingual.normalizeMultilingualBeautyTerms(query);
    assert.equal(out.query, query, query);
    assert.equal(out.applied, false, query);
  }
});

test('composition: multilingual then English negation; log fields carry counts, never text', () => {
  const out = normalizer.normalizeFindProductsMultiRoutingQuery('레티놀 세럼', BOTH_ON);
  assert.equal(out.query, 'retinol serum');
  const fields = normalizer.buildRoutingQueryLogFields(out);
  assert.equal(fields.fpm_routing_query_normalized, true);
  assert.equal(fields.fpm_routing_query_terms_mapped, 2);
  assert.deepEqual(fields.fpm_routing_query_term_kinds, ['ingredient', 'term']);
  assert.equal(JSON.stringify(fields).includes('retinol'), false);

  const negation = normalizer.normalizeFindProductsMultiRoutingQuery('moisturizer without retinol', {
    FIND_PRODUCTS_MULTI_BARE_INGREDIENT_ROUTING: 'on',
  });
  assert.equal(negation.query, 'moisturizer retinol-free');
  assert.equal(normalizer.buildRoutingQueryLogFields(negation).fpm_routing_query_negation, true);

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

test('locateRoutingQuery reads the routing query where the context build does', () => {
  const searchPayload = { search: { query: '선크림' }, query: 'ignored' };
  const a = normalizer.locateRoutingQuery(searchPayload);
  assert.equal(a.source, 'search');
  a.write('sunscreen');
  assert.equal(searchPayload.search.query, 'sunscreen');
  const topLevel = { query: '선크림' };
  const b = normalizer.locateRoutingQuery(topLevel);
  assert.equal(b.source, 'payload');
  const messages = { search: {}, messages: [{ role: 'user', content: '洗面奶' }, { role: 'assistant', content: 'ok' }] };
  const c = normalizer.locateRoutingQuery(messages);
  assert.equal(c.source, 'messages');
  c.write('cleanser');
  assert.equal(messages.messages[0].content, 'cleanser');
  assert.equal(normalizer.locateRoutingQuery({ search: { query: '' } }), null);
});

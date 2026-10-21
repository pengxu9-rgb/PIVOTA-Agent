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
    'glycerin', 'zinc pca', 'best niacinamide products', 'products with retinol', 'niacinamide zinc pca',
    'retinol dupe', 'products like retinol', 'retinol like results', 'similar retinol products', 'retinol similar',
    'retinol effects']) {
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
    'retinol substitutes': [[], ['retinol']],
    'replacement for retinol': [[], ['retinol']],
    'replacements for retinol': [[], ['retinol']],
    'substitute for retinol': [[], ['retinol']],
    'substitutes for retinol': [[], ['retinol']],
    'alternatives to retinol': [[], ['retinol']],
    'instead of retinol': [[], ['retinol']],
    'gentler than retinol': [[], ['retinol']],
    'non retinol': [[], ['retinol']],
    'avoiding retinol': [[], ['retinol']],
    'free from retinol': [[], ['retinol']],
    'frei von retinol': [[], ['retinol']],
    'libre de retinol': [[], ['retinol']],
    '0.0% retinol cream': [[], ['retinol']],
    // a trailing zero is an absence too; any other number is a strength
    'retinol 0%': [[], ['retinol']],
    'retinol 0.0% serum': [[], ['retinol']],
    'retinol-0% cream': [[], ['retinol']],
    'retinol 10% serum': [['retinol'], []],
    'retinol 1.0% serum': [['retinol'], []],
    'retinol 0.3% serum': [['retinol'], []],
    'retinol 0.03% serum': [['retinol'], []],
    // a stand-in active is asked for like a table ingredient
    bakuchiol: [['bakuchiol'], []],
    'bakuchiol instead of retinol': [['bakuchiol'], ['retinol']],
    // faux / pseudo are stand-ins for any ingredient; phyto only for one with a plant analogue (retinol)
    'phyto-retinol': [[], ['retinol']],
    'phyto retinol': [[], ['retinol']],
    'faux retinol': [[], ['retinol']],
    'pseudo retinol': [[], ['retinol']],
    'faux niacinamide': [[], ['niacinamide']],
    'phyto ceramides': [['ceramide_np'], []],
    'phyto niacinamide serum': [['niacinamide'], []],
    // "like X" asks FOR the ingredient in a query
    'retinol-like serum': [['retinol'], []],
    'retinol like the ordinary': [['retinol'], []],
    'serum with retinol like the ordinary': [['retinol'], []],
    'retinol like results': [['retinol'], []],
    // decimals and "free" compounds that are not absence
    '1.0% retinol serum': [['retinol'], []],
    '2.0% salicylic acid': [['salicylic_acid'], []],
    '10.0% niacinamide': [['niacinamide'], []],
    '15.0% vitamin c': [['ascorbic_acid'], []],
    'vitamin c free radical serum': [['ascorbic_acid'], []],
    'retinol free sample': [['retinol'], []],
    'retinol free size': [['retinol'], []],
    'retinol free delivery': [['retinol'], []],
    'retinol free returns': [['retinol'], []],
    'retinol free trials': [['retinol'], []],
    'retinol free gifts': [['retinol'], []],
    'retinol free radicals': [['retinol'], []],
    // non-English absence words, read even with the multilingual flag off
    retinolfrei: [[], ['retinol']],
    'ohne Retinol creme': [[], ['retinol']],
    'crema sin retinol': [[], ['retinol']],
    'sans retinol': [[], ['retinol']],
    // positive marketing words are NOT qualifiers: these ask FOR the ingredient
    'vegan retinol serum': [['retinol'], []],
    'natural vitamin c serum': [['ascorbic_acid'], []],
    'vegan niacinamide serum': [['niacinamide'], []],
    'clean retinol cream': [['retinol'], []],
    'pro retinol cream': [['retinol'], []],
    'bio retinol': [['retinol'], []],
    'plant based retinol serum': [['retinol'], []],
    'retinol dupe': [['retinol'], []],
    'retinol dupes': [['retinol'], []],
    'products like retinol': [['retinol'], []],
    'retinol alt serum': [['retinol'], []],
    'retinol analog': [['retinol'], []],
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
    // the German / French / Spanish absence words the strict detector reads, flag-gated the same way
    'ohne Retinol creme': 'retinol-free cream',
    'crema sin retinol': 'cream retinol-free',
    'sans retinol': 'retinol-free',
    retinolfrei: 'retinol-free',
    'Retinol-frei Creme': 'retinol-free cream',
    // a negator needs its own word
    sinretinol: 'sinretinol',
    'casino retinol': 'casino retinol',
    // "0%" only as its own number; decimals kept; "free radical" is not an absence
    '0.0% retinol cream': 'retinol-free cream',
    '1.0% retinol serum': '1.0% retinol serum',
    '10.0% niacinamide': '10.0% niacinamide',
    'vitamin c free radical serum': 'vitamin c free radical serum',
    'retinol free gift': 'retinol free gift',
    'retinol free delivery': 'retinol free delivery',
    'retinol free returns': 'retinol free returns',
    'retinol free trials': 'retinol free trials',
    'retinol free sample': 'retinol free sample',
    'retinol free shipping': 'retinol free shipping',
    'retinol free radicals': 'retinol free radicals',
    // "0 %" with a space is still "0%"; a negator glued to the previous word by a hyphen is part of it
    '0 % retinol cream': 'retinol-free cream',
    'anti-no retinol cream': 'anti-no retinol cream',
    'pre-0% retinol cream': 'pre-0% retinol cream',
    'not retinol cream': 'retinol-free cream',
    // the form noun next to the canonicalised ingredient keeps its meaning
    'Retinolfreie Creme': 'retinol-free cream',
    'ohne Retinol crème': 'retinol-free cream',
  };
  for (const [query, expected] of Object.entries(cases)) {
    assert.equal(strict.canonicalizeEnglishIngredientNegations(query).query, expected, query);
  }
});

test('product naming: fooled titles never name the ingredient (exact kind)', () => {
  const product = (title, extra = {}) => ({ title, ...extra });
  const negatedOnly = [
    product('Retinol-Free Gentle Night Serum'),
    product('Phyto-Retinol Bakuchiol Serum', { active_ingredients: ['bakuchiol'] }),
    product('Retinol-Like Bakuchiol Night Serum'),
    product('Faux Retinol Night Oil'),
    product('Pseudo-Retinol Serum'),
    product('Pseudo Retinol Serum'),
    product('Phyto Retinol Night Oil'),
    product('Retinol‑like Serum'),
    product('Retinol – like Serum'),
    product('0% Retinol Gentle Night Cream'),
    product('Retinol 0% Night Cream'),
    product('Retinol 0.0% Night Cream'),
    product('0.0% Retinol Gentle Night Cream'),
    product('No Added Retinol Barrier Cream'),
    product('Retinol Replacement Serum'),
    product('Replacement for Retinol Night Cream'),
    product('Replacements for Retinol Night Cream'),
    product('Better Than Retinol Serum'),
    product('Gentler Than Retinol Night Oil'),
    product('Not Retinol, Bakuchiol'),
    product('Non Retinol Night Cream'),
    product('Bakuchiol Retinol Alternative Serum', { active_ingredients: ['bakuchiol'] }),
    product('Bakuchiol Retinol-Alternative Serum'),
    product('Alternative to Retinol Night Cream'),
    product('Alternatives to Retinol Night Cream'),
    product('Retinol Substitutes Serum'),
    product('Retinol Substitute Serum'),
    product('Substitute for Retinol Serum'),
    product('Substitutes for Retinol Serum'),
    product('Instead of Retinol: Bakuchiol'),
    product('No Retinol Night Cream'),
    product('Night Cream Free of Retinol'),
    product('Night Cream Free from Retinol'),
    product('Avoiding Retinol Night Cream'),
    product('Crème sans rétinol'),
    product('Crema sin retinol'),
    product('Creme ohne Retinol'),
    product('Creme frei von Retinol'),
    product('Crema libre de retinol'),
    product('Retinolfreie Nachtcreme'),
    product('Retinol Frei Creme'),
    product('레티놀 프리 크림'),
    product('레티놀프리 크림'),
    product('레티놀프리크림'),
    product('레티놀프리세럼'),
    product('无视黄醇面霜'),
    product('レチノールフリー クリーム'),
    product('Крем без ретинола'),
    product('Крем не содержит ретинол'),
    product('Сыворотка не содержит ретинола'),
    // A qualified STRUCTURED mention is a qualified mention.
    product('Night Serum', { active_ingredients: ['Bakuchiol (retinol alternative)'] }),
    product('Night Serum', { ingredients_inci: 'Aqua, Retinol-Free Base, Squalane' }),
  ];
  for (const item of negatedOnly) {
    assert.equal(strict.productIngredientMention(item, 'retinol'), 'negated_only', item.title);
  }
  const absent = [
    product('Bioretinol Serum'),
    product('Retinoloid Serum'),
    // Retinyl esters are not retinol for strict matching.
    product('视黄醇棕榈酸酯面霜'),
    product('視黃醇棕櫚酸酯乳霜'),
    product('视黄醇醋酸酯精华'),
    product('パルミチン酸レチノール クリーム'),
    product('레티놀팔미테이트 크림'),
    // "retinol-like" in Russian is not retinol; open stems are gone.
    product('Ретинолоподобный крем'),
    // The description and DERIVED tokens are never evidence.
    product('Gentle Night Serum', { description: 'Free of retinol. Pairs well with retinol.',
      ingredient_tokens: ['retinol'], external_seed_recall: { ingredient_tokens: ['retinol'] } }),
    // A full INCI list without the ingredient vetoes the title.
    product('Bio-Retinol Bakuchiol Serum', { ingredients_inci: ['Aqua', 'Bakuchiol', 'Squalane'] }),
    product('Retinol Night Serum', { product_payload: { seed_data: { inci_list: 'Aqua, Bakuchiol' } } }),
  ];
  for (const item of absent) assert.equal(strict.productIngredientMention(item, 'retinol'), 'absent', item.title);
  for (const title of ['Vitamin E Serum', 'Vitamin B5 Hydrating Serum']) {
    assert.equal(strict.productIngredientMention(product(title), 'ascorbic_acid'), 'absent', title);
  }
  // Compounds that contain a name but are a different substance.
  const absentAs = {
    glycerin: ['甘油三酯面霜', '聚甘油-10 精华', '乙基己基甘油 爽肤水', '甘油硬脂酸酯乳液', '甘油聚醚-26 精华', '硝酸甘油',
      'エチルヘキシルグリセリン配合ローション', 'ポリグリセリン-10', '에틸헥실글리세린 토너', '폴리글리세린 크림'],
    salicylic_acid: ['水杨酸乙基己酯防晒霜', '水楊酸乙基己酯', '水杨酸苄酯香水', 'サリチル酸エチルヘキシル配合UV',
      'サリチル酸ベンジル'],
    hyaluronic_acid: ['Крем с гиалуронидазой', 'Гиалуронидаза'],
    ascorbic_acid: ['Комплекс витаминов с маслом', 'Витамин сияние', 'Витамин с маслом ши', 'Витамины с экстрактом',
      // plural "vitamins with" before an indeclinable noun (no instrumental ending to tell it apart)
      'Набор витаминов с алоэ'],
  };
  for (const [id, titles] of Object.entries(absentAs)) {
    for (const title of titles) assert.equal(strict.productIngredientMention(product(title), id), 'absent', `${title} / ${id}`);
  }
});

test('product naming: structured fields and plain titles do name it', () => {
  const product = (title, extra = {}) => ({ title, ...extra });
  const cases = [
    [product('Retinol 0.3% Night Serum'), 'retinol'],
    // decimals stay numbers: "1.0%" is not "0%"
    [product('1.0% Retinol Night Serum'), 'retinol'],
    [product('10.0% Niacinamide Booster'), 'niacinamide'],
    [product('2.0% Salicylic Acid Cleanser'), 'salicylic_acid'],
    [product('Vitamin C Free Radical Defense Serum'), 'ascorbic_acid'],
    [product('Retinol Free Size Sample Serum'), 'retinol'],
    [product('Faux Fur Retinol Night Cream'), 'retinol'],
    [product('Bio-Retinol Night Serum', { ingredients_inci: ['Aqua', 'Retinol'] }), 'retinol'],
    [product('레티놀 프리미엄 세럼'), 'retinol'],
    [product('레티놀프리미엄크림'), 'retinol'],
    // phyto-ceramides ARE ceramides; "X Like <noun>" without a hyphen is not a stand-in
    [product('Phyto Ceramides Cream'), 'ceramide_np'],
    [product('Phyto-Ceramide Barrier Cream'), 'ceramide_np'],
    [product('Retinol Like Butter Balm'), 'retinol'],
    [product('Bakuchiol Retinol Like Serum'), 'retinol'],
    // a trailing number other than zero is a strength
    [product('Retinol 10% Serum'), 'retinol'],
    [product('Retinol 1.0% Serum'), 'retinol'],
    [product('Retinol 0.3% Serum'), 'retinol'],
    // the plain names next to the compounds above, glued as titles in these scripts are
    [product('甘油护手霜'), 'glycerin'],
    [product('グリセリン化粧水'), 'glycerin'],
    [product('글리세린 크림'), 'glycerin'],
    [product('水杨酸精华'), 'salicylic_acid'],
    [product('サリチル酸ローション'), 'salicylic_acid'],
    [product('透明质酸钠精华'), 'hyaluronic_acid'],
    // Russian inflections, bounded
    [product('Сыворотка с гиалуроном'), 'hyaluronic_acid'],
    [product('Крем с аскорбиновой кислотой'), 'ascorbic_acid'],
    [product('Сыворотка с витамином С и гиалуроновой кислотой'), 'ascorbic_acid'],
    [product('Крем витамин С увлажняющий'), 'ascorbic_acid'],
    [product('Сыворотка с салициловой кислотой'), 'salicylic_acid'],
    [product('Крем с церамидами'), 'ceramide_np'],
    [product('Гель с глицерином'), 'glycerin'],
    // the stand-in active, in every script the tables know
    [product('Bakuchiol Night Oil'), 'bakuchiol'],
    [product('Bakuchiol Retinol Alternative Serum'), 'bakuchiol'],
    [product('バクチオール美容液'), 'bakuchiol'],
    [product('补骨脂酚精华'), 'bakuchiol'],
    [product('바쿠치올 세럼'), 'bakuchiol'],
    [product('Крем с ретинолом'), 'retinol'],
    [product('Ретинол 0.3% сыворотка'), 'retinol'],
    [product('Сыворотка с гиалуроновой кислотой'), 'hyaluronic_acid'],
    [product('甘油面霜'), 'glycerin'],
    [product('0.5% Retinol Serum'), 'retinol'],
    [product('Retinol Free Shipping Serum'), 'retinol'],
    [product('Vitamin C+E Serum'), 'ascorbic_acid'],
    [product('15% L-Ascorbic Acid Serum'), 'ascorbic_acid'],
    [product('Night Serum', { ingredients_inci: ['Aqua', 'Retinol', 'Glycerin'] }), 'retinol'],
    [product('Night Serum', { ingredients_inci: 'Aqua, Glycerin, Retinol, Tocopherol' }), 'retinol'],
    // Each INCI/actives entry stands alone: "Vegan" ending one entry does not qualify the next one.
    [product('Night Serum', { active_ingredients: 'Vegan, Retinol, Niacinamide' }), 'retinol'],
    // ... and "Free" starting the NEXT entry does not qualify this one ("Retinol, Free Fatty Acids").
    [product('Night Serum', { ingredients_inci: 'Aqua, Retinol, Free Fatty Acids' }), 'retinol'],
    [product('Night Serum', { inci_list: ['water', 'retinol'] }), 'retinol'],
    [product('Night Serum', { product_payload: { seed_data: { inci_list: ['water', 'retinol'] } } }), 'retinol'],
    [product('Night Serum', { product_payload: { seed_data: { active_ingredients: ['Hyaluronic Acid'] } } }), 'hyaluronic_acid'],
    [product('Night Serum', { ingredient_intel: { active_ingredients: ['niacinamide'] } }), 'niacinamide'],
    [product('Shade No', { active_ingredients: ['retinol'] }), 'retinol'],
    [product('Cream', { ingredient_ids: ['retinol'] }), 'retinol'],
    [product('Retinol 1% Serum', { key_ingredients: ['retinol-free base'] }), 'retinol'],
    // Positive marketing words do not qualify the ingredient away.
    [product('Vegan Retinol Night Cream'), 'retinol'],
    [product('Natural Retinol Serum'), 'retinol'],
    [product('Retinol Dupe Serum'), 'retinol'],
    [product('Natural Vitamin C Brightening Serum'), 'ascorbic_acid'],
    [product('Vegan Niacinamide 10% + Zinc Serum'), 'niacinamide'],
    // Structured evidence always wins over a title.
    [product('Revive Pro-Retinol Night Cream', { ingredients_inci: ['Aqua', 'Retinol'] }), 'retinol'],
    [product('Clean Vegan Retinol 0.3%', { ingredient_ids: ['retinol'] }), 'retinol'],
    [product('Retinol-Free Night Cream', { ingredient_ids: ['retinol'] }), 'retinol'],
    [product('Phyto-Retinol Night Cream', { active_ingredients: ['retinol', 'bakuchiol'] }), 'retinol'],
    // Every script the routing tables know.
    [product('레티놀 세럼'), 'retinol'],
    [product('Ретинол сыворотка'), 'retinol'],
    [product('レチノール美容液'), 'retinol'],
    [product('视黄醇精华'), 'retinol'],
    [product('玻尿酸精华液'), 'hyaluronic_acid'],
    [product('Night Serum', { active_ingredients: ['레티놀'] }), 'retinol'],
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
    { title: 'Vegan Niacinamide 10% + Zinc Serum' },
    { title: '나이아신아마이드 세럼' },
  ];
  const out = strict.excludeProductsNamingIngredients(rows, { ingredientIds: ['niacinamide'] });
  assert.deepEqual(out.products.map((row) => row.title), ['Daily Hydrating Serum', 'Niacinamide-Free Calm Serum']);
  assert.equal(out.dropped_count, 4);
});

test('page exclusion keeps rows, page_size and total consistent', () => {
  const body = {
    products: [{ title: 'Niacinamide 10% Serum' }, { title: 'Daily Hydrating Serum' }, { title: 'Vegan Niacinamide Serum' }],
    page_size: 3,
    total: 28,
    metadata: { query_source: 'x' },
  };
  const out = strict.excludeIngredientsFromPage(body, { ingredientIds: ['niacinamide'] });
  assert.equal(out.dropped_count, 2);
  assert.deepEqual(out.body.products.map((row) => row.title), ['Daily Hydrating Serum']);
  assert.equal(out.body.page_size, 1);
  assert.equal(out.body.total, 26);
  assert.equal(out.body.metadata.excluded_ingredient_dropped_count, 2);
  assert.equal(out.body.metadata.query_source, 'x');
  const floor = strict.excludeIngredientsFromPage({ ...body, total: 2 }, { ingredientIds: ['niacinamide'] });
  assert.equal(floor.body.total, 1);
  const untouched = strict.excludeIngredientsFromPage(body, { ingredientIds: ['retinol'] });
  assert.equal(untouched.body, body);
  assert.equal(untouched.dropped_count, 0);
});

test('normalisation keeps decimals inside numbers and every script', () => {
  assert.equal(strict.normalizeForMatch('1.0% Retinol'), '1.0 retinol');
  assert.equal(strict.normalizeForMatch('0.0% Retinol'), '0.0 retinol');
  assert.equal(strict.normalizeForMatch('Retinol-Free. Night'), 'retinol free night');
  assert.equal(strict.normalizeForMatch('e.g. retinol'), 'e g retinol');
  assert.equal(strict.normalizeForMatch('레티놀 크림'), '레티놀 크림');
  assert.equal(strict.normalizeForMatch('Крем'), 'крем');
});

test('page exclusion with a category scope drops off-scope rows and keeps the total consistent', () => {
  const body = {
    products: [
      { title: 'Retinol-Free Barrier Moisturizer', category_path: ['beauty', 'skincare', 'moisturize', 'cream'] },
      { title: 'Repair Shampoo', category_path: ['beauty', 'haircare', 'shampoo'] },
      { title: 'Velvet Matte Lipstick', catalog_category_path: 'beauty/makeup/lip/lipstick' },
      { title: 'No Path Serum' },
      { title: 'Retinol Night Serum', catalog_category_path: 'beauty/skincare/treat/serum' },
      { title: 'Skincare Root Row', catalog_category_path: 'beauty/skincare' },
    ],
    page_size: 6,
    total: 9,
  };
  // A row with no category path is kept when it passes the exclusion (fail safe) ...
  const out = strict.excludeIngredientsFromPage(body, { ingredientIds: ['retinol'], scopePrefix: 'beauty/skincare/' });
  assert.deepEqual(out.body.products.map((row) => row.title), ['Retinol-Free Barrier Moisturizer', 'No Path Serum', 'Skincare Root Row']);
  assert.equal(out.dropped_count, 3);
  assert.equal(out.body.total, 6);
  assert.equal(out.body.page_size, 3);
  // ... and, with the door's inference, judged by what its own title / product type names.
  const unfiled = {
    products: [
      { title: 'No Path Serum' },
      { title: 'Strengthening Shampoo' },
      { title: 'Mystery Item' },
      { title: 'Daily Thing', product_type: 'Lipstick' },
      { title: 'Retinol Night Serum' },
      { title: 'Retinal 0.1% Night Serum' },
    ],
  };
  const inferred = strict.excludeIngredientsFromPage(unfiled, {
    ingredientIds: ['retinol'], scopePrefix: 'beauty/skincare/', inferCategoryPath: normalizer.inferRowCategoryPath,
  });
  assert.deepEqual(inferred.body.products.map((row) => row.title), ['No Path Serum', 'Mystery Item']);
  const hair = strict.excludeIngredientsFromPage({ products: [{ title: 'Strong Hold Hair Gel' }, { title: 'Glycerin Hair Gel' },
    { title: 'Repair Shampoo' }, { title: 'Hydrating Face Serum' }] }, {
    ingredientIds: ['glycerin'], scopePrefix: 'beauty/haircare/', inferCategoryPath: normalizer.inferRowCategoryPath,
  });
  assert.deepEqual(hair.body.products.map((row) => row.title), ['Strong Hold Hair Gel', 'Repair Shampoo']);
  assert.equal(normalizer.inferRowCategoryPath({ title: 'Repair Shampoo' }), 'beauty/haircare/');
  assert.equal(normalizer.inferRowCategoryPath({ title: 'Mystery Item' }), '');
  assert.equal(normalizer.inferRowCategoryPath(null), '');
});

test('stand-in and area rewrites: what each exclusion-only query asks for', () => {
  const rw = (query) => normalizer.rewriteExclusionQuery(query);
  // A known stand-in (retinol -> bakuchiol) is the ask of a bare stand-in query.
  for (const query of ['retinol alternative', 'alternative to retinol', 'retinol substitute', 'substitutes for retinol',
    'faux retinol', 'phyto retinol', 'pseudo retinol', 'better than retinol', 'a retinol alternative please']) {
    assert.deepEqual(rw(query), { query: 'bakuchiol', kind: 'stand_in_known', requiredIds: ['bakuchiol'] }, query);
  }
  // A named stand-in active is the ask, whatever the qualifier.
  for (const query of ['bakuchiol instead of retinol', 'retinol free bakuchiol', 'bakuchiol not retinol']) {
    assert.deepEqual(rw(query), { query: 'bakuchiol', kind: 'stand_in_named', requiredIds: ['bakuchiol'] }, query);
  }
  // Hair (scalp) and lips: the area's own category, without the ingredient -- never skincare.
  assert.deepEqual(rw('retinol alternative for hair'), { query: 'retinol-free hair care', kind: 'area', requiredIds: [] });
  assert.deepEqual(rw('alternative to retinol for my scalp'), { query: 'retinol-free hair care', kind: 'area', requiredIds: [] });
  assert.deepEqual(rw('niacinamide alternative for hair'), { query: 'niacinamide-free hair care', kind: 'area', requiredIds: [] });
  assert.deepEqual(rw('retinol alternative for lips'), { query: 'retinol-free lip treatment', kind: 'area', requiredIds: [] });
  assert.deepEqual(rw('without glycerin for hair'), { query: 'glycerin-free hair care', kind: 'area', requiredIds: [] });
  // a bare zero left after the ingredient is a qualifier, not something to serve
  assert.deepEqual(rw('retinol 0 for hair'), { query: 'retinol-free hair care', kind: 'area', requiredIds: [] });
  assert.deepEqual(rw('retinol 0.0 for hair'), { query: 'retinol-free hair care', kind: 'area', requiredIds: [] });
  assert.deepEqual(rw('bakuchiol instead of retinol for hair'), { query: 'bakuchiol hair care', kind: 'stand_in_named', requiredIds: ['bakuchiol'] });
  // Unchanged: no known stand-in (every ingredient alike), an absence alone, a product type, another area,
  // two areas, a table ingredient asked for, or nothing excluded.
  for (const query of ['vitamin c alternative', 'niacinamide alternative', 'hyaluronic acid alternative',
    'salicylic acid alternative', 'alternative to ceramides', 'faux niacinamide', 'without retinol', 'retinol-free',
    'retinol alternative serum', 'glycerin-free shampoo', 'glycerin-free hair gel', 'retinol alternative for body',
    'glycerin-free soap', "retinol alternative for men's skin", 'retinol alternative for hair and body',
    'niacinamide serum without retinol', 'retinol', 'retinol dupe', 'products like retinol', 'bakuchiol',
    'bakuchiol serum instead of retinol', 'retinol alternative for acne',
    // a TABLE ingredient asked for alongside the exclusion is not a stand-in ask
    'niacinamide without retinol', 'retinol free niacinamide', 'hyaluronic acid instead of retinol']) {
    assert.deepEqual(rw(query), { query, kind: null, requiredIds: [] }, query);
  }
  // Only retinol has a known stand-in.
  assert.deepEqual(Object.keys(strict.KNOWN_STAND_INS), ['retinol']);
});

test('"<ingredient> like <brand>" asks for the ingredient from that brand', () => {
  assert.deepEqual(normalizer.rewriteIngredientLikeBrandQuery('retinol like the ordinary'),
    { query: 'the ordinary retinol', requiredIds: ['retinol'] });
  assert.deepEqual(normalizer.rewriteIngredientLikeBrandQuery('Niacinamide like CeraVe'),
    { query: 'CeraVe Niacinamide', requiredIds: ['niacinamide'] });
  for (const query of ['retinol like results', 'products like retinol', 'retinol serum like the ordinary',
    'retinol like the ordinary serum', 'retinol', 'the ordinary']) {
    assert.deepEqual(normalizer.rewriteIngredientLikeBrandQuery(query), { query, requiredIds: [] }, query);
  }
});

test('the door rules come from the query as typed, so no rewrite loses an exclusion', () => {
  const door = (query) => normalizer.normalizeFindProductsMultiRoutingQuery(query, BOTH_ON).door;
  assert.deepEqual(door('retinol alternative'), { excludedIds: ['retinol'], requiredIds: ['bakuchiol'], scopePrefix: 'beauty/skincare/' });
  assert.deepEqual(door('bakuchiol instead of retinol'), { excludedIds: ['retinol'], requiredIds: ['bakuchiol'], scopePrefix: 'beauty/skincare/' });
  assert.deepEqual(door('retinol alternative for hair'), { excludedIds: ['retinol'], requiredIds: [], scopePrefix: 'beauty/haircare/' });
  assert.deepEqual(door('retinol alternative for lips'), { excludedIds: ['retinol'], requiredIds: [], scopePrefix: 'beauty/makeup/lip/' });
  assert.deepEqual(door('retinol like the ordinary'), { excludedIds: [], requiredIds: ['retinol'], scopePrefix: null });
  assert.deepEqual(door('niacinamide-free serum'), { excludedIds: ['niacinamide'], requiredIds: [], scopePrefix: null });
  assert.deepEqual(door('retinol'), { excludedIds: [], requiredIds: [], scopePrefix: null });
  // Multilingual only: no door (the exclusion door is the bare-ingredient flag's).
  assert.equal(normalizer.normalizeFindProductsMultiRoutingQuery('retinol alternative',
    { FIND_PRODUCTS_MULTI_MULTILINGUAL_ROUTING: 'on' }).door, null);
  // The rewrite kind is logged as a token.
  const out = normalizer.normalizeFindProductsMultiRoutingQuery('retinol alternative', BOTH_ON);
  assert.equal(normalizer.buildRoutingQueryLogFields(out).fpm_routing_query_rewrite, 'stand_in_known');
  assert.equal(normalizer.buildRoutingQueryLogFields(
    normalizer.normalizeFindProductsMultiRoutingQuery('retinol', BOTH_ON)).fpm_routing_query_rewrite, undefined);
});

test('page door: required stand-ins, exclusions and scope together', () => {
  const body = {
    products: [
      { title: 'Bakuchiol Retinol Alternative Serum', category_path: 'beauty/skincare/treat/serum' },
      { title: 'Retinol + Bakuchiol Serum', category_path: 'beauty/skincare/treat/serum' },
      { title: 'Retinol-Free Barrier Cream', category_path: 'beauty/skincare/moisturize/cream' },
      { title: 'Bakuchiol Body Lotion', category_path: 'beauty/body-care/body-lotion' },
    ],
    page_size: 4,
    total: 9,
  };
  const out = strict.excludeIngredientsFromPage(body, { ingredientIds: ['retinol'], requiredIds: ['bakuchiol'], scopePrefix: 'beauty/skincare/' });
  assert.deepEqual(out.body.products.map((p) => p.title), ['Bakuchiol Retinol Alternative Serum']);
  assert.equal(out.dropped_count, 3);
  assert.equal(out.body.total, 6);
  assert.equal(out.body.page_size, 1);
  const requiredOnly = strict.excludeIngredientsFromPage(body, { requiredIds: ['bakuchiol'] });
  assert.deepEqual(requiredOnly.body.products.map((p) => p.title),
    ['Bakuchiol Retinol Alternative Serum', 'Retinol + Bakuchiol Serum', 'Bakuchiol Body Lotion']);
});

test('an exclusion that names no category keeps the page in skincare', () => {
  for (const query of ['retinol-free mist', 'retinol-free', 'cerave without retinol', 'retinol-free skincare',
    'retinol-free balm']) {
    assert.equal(normalizer.exclusionCategoryScope(query), 'beauty/skincare/', query);
  }
  for (const query of ['retinol-free cream', 'retinol-free lipstick', 'retinol alternative serum', 'retinol', 'serum',
    // another area is never skincare
    'glycerin-free soap', 'retinol alternative for body', "glycerin-free men's", 'retinol-free nail', 'retinol-free hand',
    'retinol-free for hair and lips', 'glycerin-free shampoo']) {
    assert.equal(normalizer.exclusionCategoryScope(query), null, query);
  }
  for (const query of ['glycerin-free hair gel', 'retinol alternative for hair', 'without glycerin for scalp',
    'glycerin-free pomade']) {
    assert.equal(normalizer.exclusionCategoryScope(query), 'beauty/haircare/', query);
  }
  assert.equal(normalizer.exclusionCategoryScope('retinol alternative for lips'), 'beauty/makeup/lip/');
});

test('bare ingredient negations name nothing to serve', () => {
  for (const query of ['retinol-free', 'retinol free', 'without retinol', '0% retinol', 'salicylic acid free',
    'retinol alternative', 'no niacinamide', 'retinolfrei', 'sin retinol', 'ohne Retinol', 'sans rétinol',
    'retinol 0%', 'vitamin c alternative', 'niacinamide alternative', 'faux niacinamide']) {
    assert.equal(normalizer.isBareIngredientNegationQuery(query), true, query);
  }
  for (const query of ['retinol-free moisturizer', 'salicylic acid-free cleanser', 'retinol free shipping',
    'retinol alternative serum', 'niacinamide serum without retinol', 'retinol', 'moisturizer', '',
    // a product type, a brand, a concern or a generic skincare word is something to serve
    'retinol-free balm', 'retinol-free suncream', 'retinol-free mist', 'cerave without retinol',
    'the ordinary retinol free', 'retinol free for sensitive skin', 'pregnancy safe no retinol',
    'retinol-free anti aging', 'retinol free skincare',
    // ... in another language too, with the multilingual flag off
    'retinol-free 크림', 'retinol-free crème', 'retinol-free crema', 'ohne Retinol creme', 'crema sin retinol',
    // ... and a body area
    'without glycerin for hair', 'retinol alternative for body', 'glycerin-free soap', "retinol-free men's",
    'retinol alternative for lips', 'bakuchiol instead of retinol']) {
    assert.equal(normalizer.isBareIngredientNegationQuery(query), false, query);
  }
});

test('a bare negation is never rewritten (it must not widen into a browse)', () => {
  for (const query of ['without retinol', 'no retinol', 'avoid retinol', 'zero retinol', '0% retinol', 'retinol 0%',
    'sin retinol', 'ohne Retinol', 'sans rétinol', '레티놀 없는', '不含视黄醇', '레티놀프리']) {
    const out = normalizer.normalizeFindProductsMultiRoutingQuery(query, BOTH_ON);
    assert.equal(out.query, query, query);
    assert.equal(out.changed, false, query);
    assert.equal(out.guard, 'bare_negation_kept', query);
  }
  // A bare stand-in with no known stand-in is not rewritten at all; the handler answers it as a bare
  // negation, the same for every ingredient.
  for (const query of ['vitamin c alternative', 'niacinamide alternative', 'salicylic acid alternative', 'faux niacinamide']) {
    const out = normalizer.normalizeFindProductsMultiRoutingQuery(query, BOTH_ON);
    assert.equal(out.query, query, query);
    assert.equal(out.changed, false, query);
    assert.equal(normalizer.isBareIngredientNegationQuery(out.candidate || out.query), true, query);
  }
  const withNoun = normalizer.normalizeFindProductsMultiRoutingQuery('crème hydratante sans rétinol', BOTH_ON);
  assert.equal(withNoun.query, 'moisturizer retinol-free');
});

test('every non-Latin ingredient name the query table maps is also read on products', () => {
  for (const entry of multilingual._entries) {
    if (entry.kind !== 'ingredient' || entry.script !== 'cjk') continue;
    const id = strict.STRICT_FIND_PRODUCTS_MULTI_INGREDIENT_ALIASES[entry.en];
    assert.ok(id, entry.en);
    assert.ok(
      (strict.NON_LATIN_INGREDIENT_NAMES[id] || []).map((name) => strict.normalizeForMatch(name)).includes(strict.normalizeForMatch(entry.key)),
      `${entry.key} (${id}) is mapped for queries but not read on products`,
    );
  }
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
    'Retinol Creme': 'Retinol cream',
    'retinol creme': 'retinol cream',
    // "formulated with" connectors keep the ingredient, and go with it
    '레티놀배합 크림': 'retinol cream',
    'レチノール配合の美容液': 'retinol serum',
    '含视黄醇的面霜': 'retinol face cream',
    'レチノール配合のクリーム': 'retinol cream',
    // connectors chain: one that touches only another connector still goes with the term
    'レチノール配合入りの美容液': 'retinol serum',
    'レチノール配合の美容液とクリーム': 'retinol serum cream',
    '레티놀 프리미엄 세럼': 'retinol 프리미엄 serum',
    'Retinolfreie Creme': 'retinol-free cream',
    레티놀배합: 'retinol',
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
    '精华水', '补水精华', '眼霜', '아이크림', '선크림추천', 'retinol крем',
    // a term dropped as part of an unknown compound is no context for its neighbour
    '레티놀성분 크림',
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

// ---- flag-on follow-ups --------------------------------------------------------------------------

test('an exclusion of retinol excludes the whole retinoid family, in every script; an ask is unchanged', () => {
  const product = (title, extra = {}) => ({ title, ...extra });
  const family = [
    'Retinal 0.1% Night Serum', 'Retinaldehyde Serum', 'Granactive Retinoid 2% Emulsion', 'Hydroxypinacolone Retinoate Serum',
    'HPR Night Serum', 'Adapalene Gel 0.1%', 'Tretinoin Cream 0.025%', 'Isotretinoin Gel', 'Tazarotene Cream', 'Retinoic Acid Serum',
    'Retinyl Palmitate Lotion', 'Retinyl Retinoate Cream', 'Retinol Palmitate Cream', 'Retinoid Night Cream',
    '视黄醛精华', '視黃醛精華', '视黄醇棕榈酸酯面霜', '羟基频哪酮视黄酸酯精华', '阿达帕林凝胶', '维A酸乳膏', '类视黄醇面霜',
    'レチナール美容液', 'パルミチン酸レチノール クリーム', 'トレチノイン クリーム', 'アダパレン ゲル', 'レチノイド クリーム',
    '레티날 세럼', '레티닐팔미테이트 크림', '레티놀 팔미테이트 크림', '아다팔렌 겔', '트레티노인 크림', '레티노이드 크림',
    'Крем с ретиналем', 'Гель с адапаленом', 'Крем с третиноином', 'Ретиноид сыворотка',
  ];
  for (const title of family) {
    assert.equal(strict.productNamesIngredientFamily(product(title), 'retinol'), true, title);
    assert.notEqual(strict.productIngredientMention(product(title), 'retinol'), 'named', title);
  }
  // structured fields too, with no INCI veto for an exclusion
  assert.equal(strict.productNamesIngredientFamily(product('Night Serum', { ingredients_inci: 'Aqua, Hydroxypinacolone Retinoate' }), 'retinol'), true);
  assert.equal(strict.productNamesIngredientFamily(product('Night Serum', { active_ingredients: ['retinal'] }), 'retinol'), true);
  // stand-ins, qualified family words and unrelated rows are not the family
  for (const title of ['Bakuchiol Retinol Alternative Serum', 'Retinoid-Free Night Cream', 'Retinal-Free Serum', 'Phyto-Retinol Serum',
    'Vitamin E Serum', 'Retinoid Alternative Serum', 'Daily Moisturizing Cream']) {
    assert.equal(strict.productNamesIngredientFamily(product(title), 'retinol'), false, title);
  }
  // other ingredients: their INCI synonyms, now read in titles for an exclusion only
  assert.equal(strict.productNamesIngredientFamily(product('Sodium Hyaluronate Serum'), 'hyaluronic_acid'), true);
  assert.equal(strict.productIngredientMention(product('Sodium Hyaluronate Serum'), 'hyaluronic_acid'), 'absent');
  assert.equal(strict.productNamesIngredientFamily(product('Ascorbyl Glucoside Brightening Serum'), 'ascorbic_acid'), true);
  assert.equal(strict.productNamesIngredientFamily(product('Daily Serum'), 'niacinamide'), false);
  const page = strict.excludeProductsNamingIngredients(family.map((title) => product(title)).concat([product('Bakuchiol Night Oil')]),
    { ingredientIds: ['retinol'] });
  assert.deepEqual(page.products.map((row) => row.title), ['Bakuchiol Night Oil']);
});

test('follow-up 5: glued "-free" on a title, a spaced retinyl ester, a plural vitamin list, 不含', () => {
  const product = (title) => ({ title });
  assert.equal(strict.productIngredientMention(product('Retinol-Free Sample Cream'), 'retinol'), 'negated_only');
  assert.equal(strict.productIngredientMention(product('Retinol‑Free Sample'), 'retinol'), 'negated_only');
  // typed as words, "free sample" is still a free sample
  assert.equal(strict.productIngredientMention(product('Retinol Free Sample Size'), 'retinol'), 'named');
  assert.deepEqual(strict.extractPositiveStrictIngredientIds('retinol free sample'), ['retinol']);
  assert.equal(strict.productIngredientMention(product('레티놀 팔미테이트 크림'), 'retinol'), 'absent');
  assert.equal(strict.productIngredientMention(product('Retinol Palmitate Cream'), 'retinol'), 'absent');
  assert.deepEqual(strict.extractPositiveStrictIngredientIds('retinol palmitate'), []);
  for (const title of ['Витамины С и Е сыворотка', 'Комплекс витаминов С, Е и В', 'Сыворотка витамины С']) {
    assert.equal(strict.productIngredientMention(product(title), 'ascorbic_acid'), 'named', title);
  }
  assert.equal(strict.productIngredientMention(product('Набор витаминов с алоэ'), 'ascorbic_acid'), 'absent');
  for (const [title, id, kind] of [['不含视黄醇面霜', 'retinol', 'negated_only'], ['不含烟酰胺 精华', 'niacinamide', 'negated_only'],
    ['不含酒精 视黄醇精华', 'retinol', 'named'], ['不含酒精视黄醇精华', 'retinol', 'named'], ['不含香精的烟酰胺精华', 'niacinamide', 'named'],
    ['無添加 レチノール クリーム', 'retinol', 'negated_only']]) {
    assert.equal(strict.productIngredientMention(product(title), id), kind, title);
  }
});

test('follow-up 6: a qualifier on a list qualifies every member', () => {
  const cases = {
    'alternative to retinol and niacinamide': [[], ['niacinamide', 'retinol']],
    'retinol and niacinamide alternative': [[], ['niacinamide', 'retinol']],
    'without retinol or vitamin c': [[], ['retinol', 'ascorbic_acid']],
    'retinol, niacinamide free serum': [[], ['niacinamide', 'retinol']],
    'bakuchiol instead of retinol and niacinamide': [['bakuchiol'], ['niacinamide', 'retinol']],
    // not a list: something else stands between them
    'retinol serum and niacinamide free': [['retinol'], ['niacinamide']],
    'niacinamide serum without retinol': [['niacinamide'], ['retinol']],
    'retinol free bakuchiol': [['bakuchiol'], ['retinol']],
    'retinol and niacinamide serum': [['niacinamide', 'retinol'], []],
  };
  for (const [query, [wanted, excluded]] of Object.entries(cases)) {
    assert.deepEqual(strict.extractPositiveStrictIngredientIds(query).sort(), wanted.sort(), `wanted: ${query}`);
    assert.deepEqual(strict.extractExcludedStrictIngredientIds(query).sort(), excluded.sort(), `excluded: ${query}`);
  }
  // canonicalisation keeps every member of a negated list
  assert.equal(strict.canonicalizeEnglishIngredientNegations('serum without retinol, niacinamide or vitamin c').query,
    'serum retinol-free niacinamide-free vitamin c-free');
  assert.equal(strict.canonicalizeEnglishIngredientNegations('retinol and niacinamide free serum').query, 'retinol-free niacinamide-free serum');
  assert.equal(strict.canonicalizeEnglishIngredientNegations('without retinol and niacinamide').query, 'retinol-free niacinamide-free');
  // rewrites and doors
  const out = (query) => normalizer.normalizeFindProductsMultiRoutingQuery(query, BOTH_ON);
  assert.deepEqual([out('bakuchiol instead of retinol and niacinamide').query, out('bakuchiol instead of retinol and niacinamide').door],
    ['bakuchiol', { excludedIds: ['niacinamide', 'retinol'], requiredIds: ['bakuchiol'], scopePrefix: 'beauty/skincare/' }]);
  for (const query of ['alternative to retinol and niacinamide', 'retinol and niacinamide alternative']) {
    assert.equal(out(query).changed, false, query);
    assert.equal(normalizer.isBareIngredientNegationQuery(query), true, query);
  }
  assert.equal(out('without glycerin and panthenol for hair').query, 'glycerin-free panthenol-free hair care');
});

test('follow-up 3: face / skin are skincare, price words travel with the rewrite, premium is filler', () => {
  const rw = (query) => normalizer.rewriteExclusionQuery(query);
  for (const query of ['retinol alternative for face', 'retinol alternative for skin', 'retinol alternative for my face',
    'facial retinol alternative', 'retinol alternative for my skin please']) {
    assert.deepEqual(rw(query), { query: 'bakuchiol', kind: 'stand_in_known', requiredIds: ['bakuchiol'] }, query);
  }
  assert.deepEqual(rw('cheap retinol alternative under $20'), { query: 'cheap bakuchiol under $20', kind: 'stand_in_known', requiredIds: ['bakuchiol'] });
  assert.deepEqual(rw('retinol alternative under 20 dollars'), { query: 'bakuchiol under 20 dollars', kind: 'stand_in_known', requiredIds: ['bakuchiol'] });
  assert.deepEqual(rw('affordable bakuchiol instead of retinol'), { query: 'affordable bakuchiol', kind: 'stand_in_named', requiredIds: ['bakuchiol'] });
  assert.deepEqual(rw('retinol alternative for hair under $15'), { query: 'retinol-free hair care under $15', kind: 'area', requiredIds: [] });
  assert.deepEqual(rw('budget retinol alternative max 25 usd'), { query: 'budget bakuchiol max 25 usd', kind: 'stand_in_known', requiredIds: ['bakuchiol'] });
  // a product word or another area still keeps the query as typed
  for (const query of ['cheap retinol alternative serum', 'retinol alternative under eye', 'premium retinol alternative cream']) {
    assert.deepEqual(rw(query), { query, kind: null, requiredIds: [] }, query);
  }
  assert.deepEqual(rw('premium retinol alternative'), { query: 'bakuchiol', kind: 'stand_in_known', requiredIds: ['bakuchiol'] });
  for (const query of ['retinol 프리미엄', 'premium retinol', 'retinol プレミアム']) {
    assert.equal(strict.isBareStrictIngredientQuery(query), true, query);
  }
  assert.equal(normalizer.normalizeFindProductsMultiRoutingQuery('레티놀 프리미엄', BOTH_ON).query, 'retinol 프리미엄');
});

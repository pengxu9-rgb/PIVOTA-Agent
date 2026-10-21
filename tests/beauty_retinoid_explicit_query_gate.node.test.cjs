// The loopback-only network guard goes first, so nothing below can reach a real host.
require('./agent_readiness_eval/_net_guard.cjs');

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';
delete process.env.BEAUTY_RETINOID_SOFT_SAFETY_TIER;

const app = require('../src/server');
const { HARD, HARD_NEGATION_PHRASES, SOFT } = require('./retinoid_safety_lexicon_phrases.cjs');

const {
  beautyQueryPositivelyAsksForRetinoid: asksForRetinoid,
  inferBeautyMainlineIntent,
  isBeautyProductContraindicatedForQuery,
  runInRetinoidSafetyContextForTest,
} = app._debug;

function product(id, title, category, description) {
  return {
    id,
    product_id: id,
    merchant_id: 'external_seed',
    title,
    category,
    product_type: category,
    description,
    price: 24,
    currency: 'USD',
    image_url: `https://fixture-cdn.invalid/${id}.jpg`,
  };
}

const RETINOL_CREAM = product('ret_cream', 'Retinol Night Cream', 'moisturizer', 'Face night cream with retinol.');
const RETINOL_CLEANSER = product('ret_cleanser', 'Retinol Renewing Cleanser', 'cleanser', 'Face cleanser with retinol.');
const RETINOID_SUNSCREEN = product('ret_spf', 'Retinyl Palmitate Daily Sunscreen SPF 30', 'sunscreen', 'Daily face sunscreen with retinyl palmitate.');
const RETINOL_FREE_CREAM = product('free_cream', 'Barrier Moisturizer Retinol-Free', 'moisturizer', 'Retinol-free face moisturizer.');

const contraindicated = (item, query) => isBeautyProductContraindicatedForQuery(item, query, inferBeautyMainlineIntent(query));

// The allowlist: every query here is an ask, and nothing outside these shapes is.
const ASKS = [
  'retinol cream', 'Retinol Cream', 'RETINOL CREAM', '  retinol   cream  ', 'retinol creams', 'retinol creme', 'Retinol Crème',
  'pro retinol cream', 'pro-retinol cream', 'retinal cream', 'retinaldehyde cream', 'retinoid cream', 'retinoids cream',
  'retinyl palmitate sunscreen', 'granactive retinoid moisturizer', 'hydroxypinacolone retinoate cream', 'tretinoin cream',
  'adapalene cream', 'retinol moisturizer', 'retinol moisturiser', 'retinol lotion', 'retinol emulsion', 'retinol balm',
  'retinol cleanser', 'retinol face wash', 'retinol sunscreen', 'retinol spf', 'retinol sunblock',
  'retinol night cream', 'retinol eye cream', 'retinol face cream', 'night retinol cream', 'retinol cream night',
  'retinol cream for acne', 'retinol cream for mature skin', 'retinol mature skin cream', 'retinol cream for men',
  "men's retinol cream", 'mens retinol cream', 'retinol cream for beginners', 'beginner retinol cream',
  '0.3% retinol cream', '1% retinol night cream', 'retinol 0.5% cream', 'retinol night eye cream',
  'night cream with retinol', 'moisturizer with retinol', 'cleanser with retinol', 'eye cream with retinal',
  'cream retinol', 'night cream retinol', 'Crème Rétinol', 'moisturizer retinol',
  '视黄醇面霜', 'A醇面霜', '视黄醇眼霜', '維A醇乳液', '视黄醇 防晒', 'レチノール クリーム', 'レチノール日焼け止め',
  // half-width katakana and full-width Latin, which only NFKC makes readable
  '\uFF9A\uFF81\uFF89\uFF70\uFF99 \uFF78\uFF98\uFF70\uFF91', '\uFF52\uFF45\uFF54\uFF49\uFF4E\uFF4F\uFF4C \uFF43\uFF52\uFF45\uFF41\uFF4D',
];

test('every allowlisted ask phrase is an ask', () => {
  for (const query of ASKS) assert.equal(asksForRetinoid(query), true, query);
});

test('pairings, questions and informational queries are never asks', () => {
  for (const query of [
    'retinol and moisturizer', 'retinol and sunscreen', 'retinol + spf', 'retinol & spf', 'tretinoin and moisturizer',
    'adapalene and sunscreen', 'retinol with moisturizer', 'do i need sunscreen with retinol', 'spf with retinol',
    'sunscreen with retinol', 'sunscreen with retinyl palmitate', 'retinol cream vs serum', 'retinol cream or serum',
    'how to use retinol cream', 'how often retinol cream', 'when to use retinol cream', 'retinol cream review',
    'retinol cream reviews', 'retinol cream reddit', 'is retinol cream bad', 'is retinol cream safe',
    'retinol cream side effects', 'retinol cream dangers', 'retinol cream risks', 'retinol cream purge',
    'retinol cream before and after', 'best retinol cream', 'cheap retinol cream', 'retinol cream under 30',
    'retinol cream dupe', 'retinol cream alternative', 'what is retinol cream', 'retinol cream benefits',
    // a connector or a "for ..." that is not on the list
    'moisturizer after retinol', 'cleanser before retinol', 'cream for retinol', 'moisturizer to retinol', 'cream or retinol',
    'moisturizer vs retinol', 'cream and retinol', 'night cream without retinol', 'retinol cream for wrinkles',
    'retinol cream for her', 'retinol cream for face', 'retinol cream for dryness', 'retinol cream for oily',
  ]) {
    assert.equal(asksForRetinoid(query), false, query);
  }
});

test('every word and shape of the safety lexicon keeps the ask false', () => {
  for (const phrases of Object.values(HARD)) {
    for (const phrase of phrases) {
      for (const query of [`retinol cream ${phrase}`, `${phrase} retinol cream`]) assert.equal(asksForRetinoid(query), false, query);
    }
  }
  for (const phrase of HARD_NEGATION_PHRASES) {
    for (const query of [`retinol cream, ${phrase}`, `${phrase} retinol cream`]) assert.equal(asksForRetinoid(query), false, query);
  }
  // The soft tier is off here, so these are false because the allowlist rejects the extra words.
  for (const phrases of Object.values(SOFT)) {
    for (const phrase of phrases) assert.equal(asksForRetinoid(`retinol cream ${phrase}`), false, phrase);
  }
});

test('anything the normaliser would strip, any stray digit, any other script: not an ask', () => {
  for (const query of [
    'retinol cream.', 'retinol cream!', 'retinol cream?', 'retinol, cream', 'retinol cream \u{1F642}', 'retinol cream \u{1F930}',
    'retinol​cream', 'retinol cream x', 'retinol cream #ad', 'retinol cream 13yo', 'retinol cream for 13 year old',
    'retinol cream 2', 'retinol cream 30ml', '13 retinol cream', 'retinol cream 1 %', 'retinol cream .3%',
    'retinol cream 임산부', '레티놀 크림', 'retinol крем', 'ретинол cream', 'retinol cream 孕妇', 'retinol cream 面霜',
    '视黄醇面霜推荐', '我想要视黄醇面霜', '视黄醇', '面霜', 'レチノール', 'レチノール クリーム 妊娠中', "retinol cream'",
    'retinol cream -', 'pro--retinol cream', 'p\u0336ro retinol cream', 'retinol crea\u0301\u0336m',
  ]) {
    assert.equal(asksForRetinoid(query), false, query);
  }
});

test('modifiers are bounded: at most three on each side, and only the listed ones', () => {
  assert.equal(asksForRetinoid('night eye face retinol cream'), true);
  assert.equal(asksForRetinoid('night eye face night retinol cream'), false);
  assert.equal(asksForRetinoid('retinol night eye face cream'), true);
  assert.equal(asksForRetinoid('retinol night eye face night cream'), false);
  assert.equal(asksForRetinoid('retinol cream night eye face'), true);
  assert.equal(asksForRetinoid('retinol cream night eye face night'), false);
  for (const word of ['vegan', 'natural', 'gentle', 'organic', 'korean', 'body', 'hand', 'anti aging', 'firming', 'rich', 'and', 'with', 'for']) {
    assert.equal(asksForRetinoid(`${word} retinol cream`), false, word);
    assert.equal(asksForRetinoid(`retinol ${word} cream`), false, word);
    assert.equal(asksForRetinoid(`retinol cream ${word}`), false, word);
  }
});

test('not an ask without both a retinoid and a form', () => {
  for (const query of ['', '   ', null, undefined, 'cream', 'moisturizer', 'retinol', 'retinol serum', 'retinal serum',
    'adapalene gel', 'retinol oil', 'night cream', 'cream with', 'retinol with', 'with retinol', 'sunscreen retinol', 'spf retinol']) {
    assert.equal(asksForRetinoid(query), false, String(query));
  }
});

test('any context beyond the single query turns the ask off', () => {
  const store = (extra) => ({ classes: [], sources: [], has_context: false, ...extra });
  runInRetinoidSafetyContextForTest(store({}), () => assert.equal(asksForRetinoid('retinol cream'), true));
  runInRetinoidSafetyContextForTest(store({ has_context: true }), () => assert.equal(asksForRetinoid('retinol cream'), false));
  runInRetinoidSafetyContextForTest(store({ classes: ['child_under_12'] }), () => assert.equal(asksForRetinoid('retinol cream'), false));
  assert.equal(asksForRetinoid('retinol cream'), true, 'no request store at all');
});

test('the rule lets a retinoid through only for an ask', () => {
  for (const query of ['retinol cream', 'retinol night cream', 'retinol moisturizer', 'night cream with retinol', 'pro-retinol cream', '视黄醇面霜']) {
    assert.equal(contraindicated(RETINOL_CREAM, query), false, query);
  }
  assert.equal(contraindicated(RETINOL_CLEANSER, 'retinol cleanser'), false);
  assert.equal(contraindicated(RETINOID_SUNSCREEN, 'retinyl palmitate sunscreen'), false);
  for (const query of [
    'moisturizer', 'night cream', 'cream', 'retinol-free cream', 'without retinol cream', 'retinol alternative cream',
    'vegan retinol cream', 'retinol and moisturizer', 'how to use retinol cream', 'retinol cream review', 'retinol cream.',
    'retinol cream 임산부', 'pregnancy safe retinol cream', 'breastfeeding safe retinol cream', 'retinol cream for kids',
    'retinol cream for 13 year old', 'I use tretinoin, which moisturizer?', '不含视黄醇面霜', '孕妇视黄醇面霜',
  ]) {
    assert.equal(contraindicated(RETINOL_CREAM, query), true, query);
  }
  for (const query of ['sunscreen', 'do i need sunscreen with retinol', 'spf with retinol', 'retinol + spf']) {
    assert.equal(contraindicated(RETINOID_SUNSCREEN, query), true, query);
  }
  runInRetinoidSafetyContextForTest({ classes: [], sources: [], has_context: true }, () => {
    assert.equal(contraindicated(RETINOL_CREAM, 'retinol cream'), true);
  });
});

test('a product that says it is retinol-free is unaffected either way', () => {
  for (const query of ['retinol cream', 'moisturizer', 'retinol-free cream']) {
    assert.equal(contraindicated(RETINOL_FREE_CREAM, query), false, query);
  }
});

test('a retinoid serum query never reached the rule and still does not', () => {
  const serum = product('ret_serum', 'Retinol 0.5% Serum', 'serum', 'Face serum with retinol.');
  assert.deepEqual(inferBeautyMainlineIntent('retinol serum').families, ['serum']);
  assert.equal(contraindicated(serum, 'retinol serum'), false);
});
